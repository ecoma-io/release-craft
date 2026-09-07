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
 * existing ref always the winner. Refusals and conflicts are returned
 * values, never exceptions; nothing a door refused left state behind.
 */

import type { GitTagNaming, TagMintInput, TagMintResult } from "./binding-types.js";
import { allClaimRecords, type ClaimRecord } from "./claim-store-git.js";
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
    // to the read narrowing (same filter, register source).
    const held = allClaimRecords(git).filter((record) => record.holder === input.attemptId);
    if (held.length === 0) {
      return {
        kind: "refused",
        reason: "unclaimed",
        tag: input.tag,
        detail: `attempt ${input.attemptId} holds no claim deriving tag ${input.tag} under the binding's declared tag naming`,
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
    const resolved = git(["rev-parse", "--verify", "--quiet", `${input.target}^{commit}`]).trim();
    if (resolved === "") {
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
