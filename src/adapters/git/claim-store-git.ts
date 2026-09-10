/**
 * The git-backed claim store — the per-line register (ADR-0011; contract
 * §2.3 as amended, the physical half of E-07). One ref per release line
 * under the binding's claim namespace — `refs/release-craft/claims/<sha256 of the
 * lineId's UTF-8 bytes>` — whose tip commit holds the line's claim set in
 * canonical form: `{"claims":[<claim record>…]}`, the records sorted by
 * their scope's canonical JSON. Every mutation is a compare-and-set of the
 * whole set against the tip of the same read the set came from — content
 * and base in one read — so the exclusion predicate and the accept are one
 * atomic transition per line: the same CAS that creates the claim checked
 * the line's other claims, and the scan-then-CAS window of the per-scope
 * mapping (#47) does not exist. A lost CAS re-reads and re-evaluates — it
 * never adjudicates against stale state. A
 * claim-namespace blob that is not a register refuses loudly: corrupted
 * recorded state or a foreign layout is a thrown fault, never a silent
 * empty set (repositories written by the per-scope layout fail on the
 * first claim read — pre-adoption, no migration owed).
 */

import { createHash, randomBytes } from "node:crypto";

import type {
  Claim,
  ClaimDenied,
  ClaimScope,
  ClaimStore,
  ClaimToken,
  ClaimVerification,
} from "../../index.js";
import { canonicalJson } from "../../planner/index.js";

import { deepFreeze, frozenParse } from "./freeze.js";
import { casAppendCommit, commitRecord, readRef } from "./git-refs.js";
import { openGitRun, type GitRun } from "./git-run.js";

/** The binding's claim-ref namespace: one register ref per release line. */
export const CLAIM_REF_NAMESPACE = "refs/release-craft/claims/";

/**
 * The claim record a register holds: the held claim's own values — the
 * canonical serialized form, no envelope of the binding's own. The stored
 * element carries the claim's `kind: "claim"` discriminant (see
 * `recordElement`); every record in a register is a claim.
 */
export interface ClaimRecord {
  readonly scope: ClaimScope;
  readonly token: ClaimToken;
  /** The holding attempt's id — the name a denial carries to the loser. */
  readonly holder: string;
}

/** The register's record element as stored: the claim value's own JSON —
 *  `kind` inclusive, no added field (contract §2.3). */
const recordElement = (record: ClaimRecord): string =>
  canonicalJson({ kind: "claim", scope: record.scope, token: record.token, holder: record.holder });

/** The record order the canonical form promises: lexicographic over the
 *  scopes' canonical JSON — a total order, and scopes are unique within a
 *  register (same scope is the same key). */
const compareByScopeJson = (left: ClaimRecord, right: ClaimRecord): number =>
  canonicalJson(left.scope) < canonicalJson(right.scope)
    ? -1
    : canonicalJson(left.scope) > canonicalJson(right.scope)
      ? 1
      : 0;

/** The register envelope's canonical form: the line's claim set, the
 *  records in `compareByScopeJson` order. */
const canonicalRegister = (claims: readonly ClaimRecord[]): string =>
  `{"claims":[${[...claims].sort(compareByScopeJson).map(recordElement).join(",")}]}`;

/** The line's register ref: the sha256 over the lineId's UTF-8 bytes. */
export function claimRegisterRefFor(lineId: string): string {
  const digest = createHash("sha256").update(lineId, "utf8").digest("hex");
  return `${CLAIM_REF_NAMESPACE}${digest}`;
}

/** One record's shape check — the fields the store computes over must be
 *  what the canonical form promises, exactly: `kind: "claim"`, the record's
 *  four fields, no others; anything else is corrupted recorded state and
 *  refuses loudly (ADR-0011 decision 5). */
const asRecord = (value: unknown): ClaimRecord => {
  if (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "claim" &&
    "scope" in value &&
    value.scope !== null &&
    typeof value.scope === "object" &&
    "lineId" in value.scope &&
    typeof value.scope.lineId === "string" &&
    "kind" in value.scope &&
    typeof value.scope.kind === "string" &&
    "token" in value &&
    typeof value.token === "string" &&
    "holder" in value &&
    typeof value.holder === "string" &&
    recordKeys(value)
  ) {
    return value as ClaimRecord;
  }
  throw new TypeError(
    "a register holds claim records in their canonical form — kind claim, a scope with a string lineId and kind, a string token, a string holder, and no other fields",
  );
};

/** The element carries exactly the record's four fields — an extra field is
 *  as foreign as a missing one (the canonical form is the whole shape). */
const recordKeys = (value: object): boolean => {
  const keys = Object.keys(value).sort();
  return (
    keys.length === 4 &&
    keys[0] === "holder" &&
    keys[1] === "kind" &&
    keys[2] === "scope" &&
    keys[3] === "token"
  );
};

/** The set-level canonical check: the records must already sit in
 *  `compareByScopeJson` order with no scope repeated. The writer sorts
 *  before every land; a read that accepted less would compute over a
 *  register no writer could have produced (ADR-0011 decision 5). */
const asRegister = (records: readonly ClaimRecord[], ref: string): readonly ClaimRecord[] => {
  let previous: ClaimRecord | undefined;
  for (const record of records) {
    if (previous !== undefined && compareByScopeJson(previous, record) >= 0) {
      throw new TypeError(
        `a register's records are sorted by their scope's canonical JSON and scopes are unique; ${ref} is not`,
      );
    }
    previous = record;
  }
  return records;
};

/**
 * The register's content and the base of its next compare-and-set, from
 * one read: `tip` is the ref value `claims` was read through. The pair is
 * a mutation's whole opening state — a base read separately from the
 * content would let a concurrent writer land strictly between the two
 * reads, and the CAS's old-value check would then pass over a set the
 * mutation never saw (the lost update the deterministic concurrency suite
 * pins). Null when the register ref is absent (an unclaimed line, the twin
 * of an empty one). A blob that is not a register — corrupted recorded
 * state, or the per-scope layout's records — throws: reading it as an
 * empty set would read a foreign layout as an unclaimed line.
 */
export interface RegisterRead {
  readonly tip: string;
  readonly claims: readonly ClaimRecord[];
}

export function readRegisterAt(git: GitRun, ref: string): RegisterRead | null {
  const tip = readRef(git, ref);
  if (tip === null) {
    return null;
  }
  const envelope: unknown = frozenParse(commitRecord(git, tip));
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    !("claims" in envelope) ||
    !Array.isArray(envelope.claims)
  ) {
    throw new TypeError(
      `the claim namespace pins register envelopes ({"claims":[…]}); ${ref} does not`,
    );
  }
  return { tip, claims: asRegister(envelope.claims.map(asRecord), ref) };
}

/** The set, read from the register ref — or null when the ref is absent.
 *  Verification and the all-register walk read the set alone; only a
 *  mutation needs the tip beside it. */
export function readRegister(git: GitRun, ref: string): readonly ClaimRecord[] | null {
  return readRegisterAt(git, ref)?.claims ?? null;
}

/** Every claim record the repository holds — the all-register walk the
 *  token-keyed reads resolve through (verify, release, the tag door's
 *  held-claim lookup; ADR-0011 decision 3's named exceptions). */
export function allClaimRecords(git: GitRun): readonly ClaimRecord[] {
  return git(["for-each-ref", "--format=%(refname)", CLAIM_REF_NAMESPACE])
    .split("\n")
    .filter((line) => line.length > 0)
    .flatMap((ref) => readRegister(git, ref) ?? []);
}

/**
 * Opens the git-backed claim store on `repo`. The port's physical half: the
 * accept and the exclusion check are one whole-set CAS on the line's
 * register, verification and token resolution walk every register, and a
 * lease's release removes its record by token — never by scope, so a
 * release racing the same scope's re-acquisition by a new holder deletes
 * the old holder's record only. A stable-version claim is a record, not a
 * lease — releasing its token is a no-op and a later verify still reads
 * held, the release record stands (ADR-0009 decision 4; D33); the other
 * scopes are leases. An empty register persists: the ref is never deleted,
 * so the write path stays one primitive (ADR-0011 decision 4).
 */
export class GitClaimStore implements ClaimStore {
  readonly #git: GitRun;

  constructor(repo: string) {
    this.#git = openGitRun(repo);
  }

  acquire(scope: ClaimScope, attemptId: string): Claim | ClaimDenied {
    const ref = claimRegisterRefFor(scope.lineId);
    // The claim–verify–write cycle: read the line's register, evaluate the
    // exclusion law over it, land the whole next set through the CAS — and
    // a lost CAS re-reads and re-evaluates from the new tip, never
    // adjudicating against stale state (ADR-0011 decision 2).
    for (;;) {
      // One read: the set and the base of this iteration's CAS together.
      const read = readRegisterAt(this.#git, ref);
      const claims = read?.claims ?? [];
      // Same scope, same holder: idempotent re-acquisition — no CAS, the
      // register already holds the record.
      const existing = claims.find(
        (record) => canonicalJson(record.scope) === canonicalJson(scope),
      );
      if (existing !== undefined) {
        return GitClaimStore.#adjudicate(existing, scope, attemptId);
      }
      // The exclusion law (§2.3): a held release-line excludes every other
      // claim on its line, and a release-line request yields to any held
      // claim on it. Narrower scopes on disjoint keys coexist. The check
      // and the accept are the same CAS: the scan-then-create window of
      // the per-scope mapping (#47) does not exist here.
      const held = claims.find((record) => GitClaimStore.#excludedBy(scope, record.scope));
      if (held !== undefined) {
        return GitClaimStore.#denial(scope, held.holder);
      }
      const record: ClaimRecord = {
        scope,
        token: randomBytes(32).toString("hex"),
        holder: attemptId,
      };
      const commit = casAppendCommit(
        this.#git,
        ref,
        canonicalRegister([...claims, record]),
        read?.tip ?? null,
      );
      if (commit !== null) {
        return deepFreeze({
          kind: "claim",
          scope: record.scope,
          token: record.token,
          holder: record.holder,
        }) as Claim;
      }
      // The register moved under the evaluation — a concurrent winner on
      // the same line. Loop: re-read, re-evaluate, land or deny.
    }
  }

  verify(token: ClaimToken): ClaimVerification {
    const record = allClaimRecords(this.#git).find((entry) => entry.token === token);
    if (record === undefined) {
      return { kind: "lost" };
    }
    return {
      kind: "held",
      claim: deepFreeze({
        kind: "claim",
        scope: record.scope,
        token: record.token,
        holder: record.holder,
      }) as Claim,
    };
  }

  release(token: ClaimToken): void {
    // The token resolves through the all-register walk (the port's only
    // release signature names no line): one walk, then the register CAS.
    const record = allClaimRecords(this.#git).find((entry) => entry.token === token);
    if (record === undefined) {
      return;
    }
    // A stable-version claim is a record, not a lease: the release of its
    // token is a no-op and a later verify still reads held (ADR-0009
    // decision 4; D33).
    if (record.scope.kind === "stable-version") {
      return;
    }
    const ref = claimRegisterRefFor(record.scope.lineId);
    // The whole-set CAS loop: read, remove this token's record — never the
    // scope's (a release racing the same scope's re-acquisition by a new
    // holder deletes the old holder's record only) — and land. A lost CAS
    // re-reads; a re-read without the token means a concurrent release
    // already removed it. The empty set persists: the ref is never
    // deleted (ADR-0011 decision 4), so the write path stays one
    // primitive.
    for (;;) {
      // One read: the set and the base of this iteration's CAS together.
      const read = readRegisterAt(this.#git, ref);
      if (read === null || !read.claims.some((entry) => entry.token === token)) {
        return;
      }
      if (
        casAppendCommit(
          this.#git,
          ref,
          canonicalRegister(read.claims.filter((entry) => entry.token !== token)),
          read.tip,
        ) !== null
      ) {
        return;
      }
    }
  }

  /** Same holder: idempotent re-acquisition; a different one: the winner
   * stands and the denial names it — with the winner's sequence for a
   * denied prerelease-sequence scope, the retry base (E-08). */
  static #adjudicate(
    winner: ClaimRecord,
    scope: ClaimScope,
    attemptId: string,
  ): Claim | ClaimDenied {
    if (winner.holder === attemptId) {
      return deepFreeze({
        kind: "claim",
        scope: winner.scope,
        token: winner.token,
        holder: winner.holder,
      }) as Claim;
    }
    const denial: ClaimDenied = { kind: "denied", holder: winner.holder, scope };
    return winner.scope.kind === "prerelease-sequence"
      ? { ...denial, holderSequence: winner.scope.sequence }
      : denial;
  }

  /** The exclusion-path denial names the holder and nothing else: the held
   * scope there is a line-level exclusion, and the requester's own
   * sequence is not a retry base — the reference store's shape, issue
   * #69's parity pin (ADR-0011 decision 7). */
  static #denial(scope: ClaimScope, holder: string): ClaimDenied {
    return { kind: "denied", holder, scope };
  }

  /** The exclusion law (§2.3): a release-line claim excludes every other
   * claim on its line — including another release-line on it; a narrower
   * scope is excluded by a held release-line on the same line. */
  static #excludedBy(requested: ClaimScope, held: ClaimScope): boolean {
    if (held.kind === "release-line" || requested.kind === "release-line") {
      return requested.lineId === held.lineId;
    }
    return false;
  }
}
