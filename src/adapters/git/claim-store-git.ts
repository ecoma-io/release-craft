/**
 * The git-backed claim store (contract §2.3's tag-push CAS, the physical
 * half of E-07; ADR-0009 decision 4). One ref per scope under the binding's
 * claim namespace — `refs/ecoma/claims/<sha256 of the scope's canonical
 * JSON>` — whose tip commit holds the claim record as its blob in canonical
 * form. The accept's atomic boundary is exactly one ref: creating the ref if
 * and only if it is absent is the check-and-set, git's per-ref lockfile makes
 * it atomic, and the loser's denial names the holder read back from the
 * winner's record — a returned value, never a thrown surprise.
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
import { casAppendCommit, casDeleteRef, commitRecord, readRef } from "./git-refs.js";
import { GitFaultError, openGitRun, type GitRun } from "./git-run.js";

/** The binding's claim-ref namespace: one ref per scope beneath it. */
export const CLAIM_REF_NAMESPACE = "refs/ecoma/claims/";

/** The first delete plus this many retries before a release fails closed. */
const RELEASE_RETRIES = 3;

/**
 * The claim record a scope's ref pins: the held claim's values plus the
 * acquiring attempt, persisted exactly as the store reads them back — the
 * canonical serialized form, no envelope of the binding's own.
 */
export interface ClaimRecord {
  readonly scope: ClaimScope;
  readonly token: ClaimToken;
  /** The holding attempt's id — the name a denial carries to the loser. */
  readonly holder: string;
  /** The attempt that acquired the claim. */
  readonly attemptId: string;
}

/** The scope's claim ref: the sha256 of the scope's canonical JSON. */
export function claimRefFor(scope: ClaimScope): string {
  const digest = createHash("sha256").update(canonicalJson(scope)).digest("hex");
  return `${CLAIM_REF_NAMESPACE}${digest}`;
}

/** The record a scope's ref pins, or null when the scope is unclaimed. */
export function readClaimRecord(git: GitRun, ref: string): ClaimRecord | null {
  const tip = readRef(git, ref);
  if (tip === null) {
    return null;
  }
  return frozenParse(commitRecord(git, tip)) as ClaimRecord;
}

/** Every claim record the repository holds, one per existing claim ref. */
export function listClaimRecords(git: GitRun): readonly ClaimRecord[] {
  return git(["for-each-ref", "--format=%(refname)", CLAIM_REF_NAMESPACE])
    .split("\n")
    .filter((line) => line.length > 0)
    .map((ref) => readClaimRecord(git, ref))
    .filter((record): record is ClaimRecord => record !== null);
}

/**
 * Opens the git-backed claim store on `repo`. The port's physical half: the
 * accept is the one-ref CAS, the denial names the winner's recorded holder,
 * verification reads the ref and compares tokens, and a lease's release is a
 * check-and-set delete. A stable-version claim is a record, not a lease —
 * releasing its token is a no-op and a later verify still reads held, the
 * release record stands (P-01); the other scopes are leases.
 */
export class GitClaimStore implements ClaimStore {
  readonly #git: GitRun;

  constructor(repo: string) {
    this.#git = openGitRun(repo);
  }

  acquire(scope: ClaimScope, attemptId: string): Claim | ClaimDenied {
    const ref = claimRefFor(scope);
    const existing = readClaimRecord(this.#git, ref);
    if (existing !== null) {
      return GitClaimStore.#adjudicate(existing, scope, attemptId);
    }
    // The exclusion law (§2.3): a held release-line excludes every other
    // claim on its line, and a release-line request yields to any held
    // claim on it. Narrower scopes on disjoint keys coexist.
    for (const record of listClaimRecords(this.#git)) {
      if (GitClaimStore.#excludedBy(scope, record.scope)) {
        return GitClaimStore.#denial(scope, record.holder);
      }
    }
    const record: ClaimRecord = {
      scope,
      token: randomBytes(32).toString("hex"),
      holder: attemptId,
      attemptId,
    };
    // The one-CAS accept: append the record commit only from an absent ref
    // (base null) — the ref's creation is the accept, and null here is the
    // loser side, never a fault.
    const commit = casAppendCommit(this.#git, ref, canonicalJson(record), null);
    if (commit !== null) {
      return deepFreeze({
        kind: "claim",
        scope: record.scope,
        token: record.token,
        holder: record.holder,
      }) as Claim;
    }
    const winner = readClaimRecord(this.#git, ref);
    if (winner === null) {
      throw new GitFaultError(
        ["update-ref", ref],
        null,
        "the claim ref vanished between a lost accept and the loser's read",
      );
    }
    return GitClaimStore.#adjudicate(winner, scope, attemptId);
  }

  verify(token: ClaimToken): ClaimVerification {
    const record = listClaimRecords(this.#git).find((entry) => entry.token === token);
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
    const record = listClaimRecords(this.#git).find((entry) => entry.token === token);
    if (record === undefined) {
      return;
    }
    // A stable-version claim is a record, not a lease: the release of its
    // token is a no-op and a later verify still reads held (P-01).
    if (record.scope.kind === "stable-version") {
      return;
    }
    const ref = claimRefFor(record.scope);
    // The lease release is a check-and-set delete; a lost race retries, and
    // a scope that stays contested after the bound fails closed.
    for (let attempt = 0; attempt <= RELEASE_RETRIES; attempt += 1) {
      const tip = readRef(this.#git, ref);
      if (tip === null) {
        return;
      }
      try {
        if (casDeleteRef(this.#git, ref, tip)) {
          return;
        }
      } catch (error) {
        if (!(error instanceof GitFaultError)) {
          throw error;
        }
      }
    }
    throw new GitFaultError(
      ["update-ref", "-d", ref],
      null,
      "the claim ref moved under every release attempt",
    );
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
    return GitClaimStore.#denial(scope, winner.holder);
  }

  static #denial(scope: ClaimScope, holder: string): ClaimDenied {
    const denial: ClaimDenied = { kind: "denied", holder, scope };
    return scope.kind === "prerelease-sequence"
      ? { ...denial, holderSequence: scope.sequence }
      : denial;
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
