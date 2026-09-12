/**
 * The binding's tag mint door (contract §2.3's mint half; ADR-0009 decision
 * 4). The tag name comes only from the declared naming policy — never HEAD,
 * never a caller-supplied literal standing in for one: the door mints at the
 * name the held claim's scope derives. The namespace door runs first — a
 * tag outside every declared root is the `namespace` refusal before any
 * claim is read. The door admits the write only under a claim the calling
 * attempt holds, matches the claim's token against the input's,
 * canonicalizes the supplied target to the recorded commit's oid, and
 * creates the tag ref if and only if it is absent — the same-target
 * re-mint is idempotent success, a different target a conflict, the
 * existing ref always the winner. The takeover fence closes the door's
 * own window (phase 4 §2.4 item 6; ADR-0011 decision 9): a record whose
 * lease a recorded supersession has passed no longer admits the mint,
 * whatever the attempt's earlier verify returned — the refusal names the
 * taker. Refusals and conflicts are returned
 * values, never exceptions; nothing a door refused left state behind.
 */

import { canonicalJson } from "@ecoma-io/release-craft/planner";

import type { GitTagNaming, TagMintInput, TagMintResult } from "./binding-types.js";
import { allRegisterRecords, type ClaimRecord } from "./claim-store-git.js";
import { readRef } from "./git-refs.js";
import { GitFaultError, type GitRun } from "./git-run.js";

/** The function an opened door hands the assembly: input in, returned
 * outcome out. */
export type TagMint = (input: TagMintInput) => TagMintResult;

/**
 * Opens the mint door on the binding's runner and the configuration's
 * declared naming. The door reads only the claim refs the claim store owns
 * and the tag ref it is about to create — no working tree, no ambient
 * state, no registry (ADR-0009 decisions 5 and 7). The target is a supplied
 * value, the attempt's recorded base; the door never resolves one itself.
 */
export function GitTagDoor(git: GitRun, naming: GitTagNaming): TagMint {
  return (input: TagMintInput): TagMintResult => {
    // The namespace door runs before any claim is read and before any ref
    // moves (§2.4): a tag outside every declared namespace root is the
    // `namespace` refusal class, whatever the claim state is. A root is a
    // prefix; the empty root declares every tag in the namespace.
    const inNamespace = naming.namespaces.some((root) => root === "" || input.tag.startsWith(root));
    if (!inNamespace) {
      return {
        kind: "refused",
        reason: "namespace",
        tag: input.tag,
        detail: `tag ${input.tag} lies outside every declared namespace (${naming.namespaces.join(", ")}) of the binding's declared tag naming`,
      };
    }
    // Fail closed: a mint is admitted only under a claim the calling
    // attempt holds, walked from the claim registers — the door's
    // held-claim lookup is one of ADR-0011 decision 3's named exceptions
    // to the read narrowing (same filter, register source). The fence
    // consults the same walk's supersession records (decision 9): a record
    // whose lease a takeover has passed no longer admits the mint — the
    // post-verify, pre-mint freeze window closes here, whatever the
    // attempt's earlier verify returned.
    const walk = allRegisterRecords(git);
    const passedBy = new Map(
      walk.supersessions.map((entry) => [
        canonicalJson(entry.superseded.scope),
        entry.supersededBy.holder,
      ]),
    );
    const isHeldBy = (record: ClaimRecord): boolean => record.holder === input.attemptId;
    const held = walk.claims.filter(
      (record) => isHeldBy(record) && !passedBy.has(canonicalJson(record.scope)),
    );
    const taken = walk.claims.filter(
      (record) => isHeldBy(record) && passedBy.has(canonicalJson(record.scope)),
    );
    const takeoverDetail = (taker: string): string =>
      `attempt ${input.attemptId}'s claim deriving tag ${input.tag} was superseded by attempt ${taker} — the recorded takeover refuses the mint`;
    if (held.length === 0) {
      // The refusal names the recorded takeover that blocks THIS mint: the
      // taker(s) of the taken scope(s) whose derived tag is the requested
      // one — every taker when several, the first taken scope's taker only
      // when no taken scope derives the tag (#304). The refusal itself was
      // never in question; the evidence's attribution was.
      const deriving = taken.filter((record) => naming.tagFor(record.scope) === input.tag);
      const takers = (deriving.length > 0 ? deriving : taken.slice(0, 1)).map(
        (record) => passedBy.get(canonicalJson(record.scope)) ?? "unknown",
      );
      const [taker] = takers;
      if (taker === undefined) {
        return {
          kind: "refused",
          reason: "unclaimed",
          tag: input.tag,
          detail: `attempt ${input.attemptId} holds no claim deriving tag ${input.tag} under the binding's declared tag naming`,
        };
      }
      return {
        kind: "refused",
        reason: "unclaimed",
        tag: input.tag,
        detail:
          takers.length === 1
            ? takeoverDetail(taker)
            : `attempt ${input.attemptId}'s claims deriving tag ${input.tag} were superseded by attempts ${takers.join(", ")} — the recorded takeover refuses the mint`,
      };
    }
    // The naming policy derives each held claim's tag name; an in-namespace
    // tag no held claim derives is the `unclaimed` class. The created ref
    // takes the derived name, never the input's.
    let match: { record: ClaimRecord; name: string } | undefined;
    for (const record of held) {
      const name = naming.tagFor(record.scope);
      if (name === null) {
        continue;
      }
      if (name === input.tag) {
        match = { record, name };
        break;
      }
    }
    if (match === undefined) {
      const takeover = taken.find((record) => naming.tagFor(record.scope) === input.tag);
      if (takeover !== undefined) {
        return {
          kind: "refused",
          reason: "unclaimed",
          tag: input.tag,
          detail: takeoverDetail(passedBy.get(canonicalJson(takeover.scope)) ?? "unknown"),
        };
      }
      return {
        kind: "refused",
        reason: "unclaimed",
        tag: input.tag,
        detail: `no claim held by attempt ${input.attemptId} derives tag ${input.tag} under the binding's declared tag naming`,
      };
    }
    // A held claim under another attempt's token is a foreign mint: a
    // refusal with the failure class named (contract §2.6 — `conflict`
    // names a present tag ref, a foreign token a refusal), the held claim
    // winning without a ref moving.
    if (match.record.token !== input.token) {
      return {
        kind: "refused",
        reason: "foreign-token",
        tag: input.tag,
        detail: `the claim deriving tag ${input.tag} is held under a different token`,
      };
    }
    // The target is canonicalized once, before the create and the
    // comparison: `rev-parse --verify <target>^{commit}` resolves any
    // spelling the object store accepts to the recorded commit's oid, so a
    // short prefix or a ref spelling mints the same ref and reports
    // `minted` at the full oid — never a conflict against a tag the door
    // itself just created (nothing refused leaves state behind, §2.6).
    //
    // The quiet verification's fault shape IS the unresolvable target:
    // exit 1 with empty stderr, the same one shape `readRef` keys absence
    // on (D39). That shape is the door's declared-lie classification
    // (#184; D49) — the supplied target named a commit the declared world
    // does not hold, so the door raises its own GitFaultError naming the
    // target rather than letting git's raw rev-parse wording escape
    // unclassified (the raw fault was the defect: thrown before the
    // classification could run, it made the branch unreachable). The
    // fault stays a fault — phase 12 §2.4's declared-lie posture, exit 70
    // at the surface, phase 13 §2.8's mismatch site — never one of the
    // returned refusal classes, which name policy races; any other fault
    // (an unreadable store, a spawn failure) propagates as what it is.
    let resolved: string | null;
    try {
      resolved = git(["rev-parse", "--verify", "--quiet", `${input.target}^{commit}`]).trim();
    } catch (error) {
      if (error instanceof GitFaultError && error.status === 1 && error.stderr === "") {
        resolved = null;
      } else {
        throw error;
      }
    }
    if (resolved === null || resolved === "") {
      throw new GitFaultError(
        ["rev-parse", "--verify", `${input.target}^{commit}`],
        null,
        `the mint target ${input.target} does not resolve to a commit`,
      );
    }
    const tagRef = `refs/tags/${match.name}`;
    let fault: GitFaultError | undefined;
    if (readRef(git, tagRef) === null) {
      // The tag spelling through the runner, no signing, the canonical
      // target: a lightweight ref at the resolved commit.
      try {
        git(["tag", "--no-sign", match.name, resolved]);
      } catch (error) {
        // The create lost the ref lock to a concurrent mint — the
        // existence check below decides. A genuine fault still stands.
        if (!(error instanceof GitFaultError)) {
          throw error;
        }
        fault = error;
      }
    }
    const after = readRef(git, tagRef);
    if (after === null) {
      throw (
        fault ??
        new GitFaultError(
          ["tag", "--no-sign", match.name, resolved],
          null,
          `tag ref ${tagRef} absent after its create`,
        )
      );
    }
    // The CAS existence check: same target is the idempotent re-mint, a
    // different target is the existing ref winning.
    return after === resolved
      ? { kind: "minted", tag: match.name, target: resolved }
      : {
          kind: "conflict",
          tag: match.name,
          detail: `tag ${match.name} already exists at ${after}, not ${resolved}`,
        };
  };
}
