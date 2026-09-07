/**
 * The binding's tag mint door (contract §2.3's mint half; ADR-0009 decision
 * 4). The tag name comes only from the declared naming policy — never HEAD,
 * never a caller-supplied literal standing in for one: the door mints at the
 * name the held claim's scope derives. It admits the write only under a
 * claim the calling attempt holds, matches the claim's token against the
 * input's, and creates the tag ref if and only if it is absent — the
 * same-target re-mint is idempotent success, a different target a conflict,
 * the existing ref always the winner. Refusals and conflicts are returned
 * values, never exceptions; nothing a door refused left state behind.
 */

import type { GitTagNaming, TagMintInput, TagMintResult } from "./binding-types.js";
import { listClaimRecords, type ClaimRecord } from "./claim-store-git.js";
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
    // Fail closed: a mint is admitted only under a claim the calling
    // attempt holds, read back from the claim refs.
    const held = listClaimRecords(git).filter((record) => record.holder === input.attemptId);
    if (held.length === 0) {
      return {
        kind: "refused",
        reason: "unclaimed",
        tag: input.tag,
        detail: `attempt ${input.attemptId} holds no claim`,
      };
    }
    // The naming policy derives each held claim's tag name; a scope it maps
    // to no name lies outside every declared namespace — a policy refusal
    // with no winner, the store-side door's ClaimDenied widening in mint
    // terms. The created ref takes the derived name, never the input's.
    let match: { record: ClaimRecord; name: string } | undefined;
    let namespaceBlocked = false;
    for (const record of held) {
      const name = naming.tagFor(record.scope);
      if (name === null) {
        namespaceBlocked = true;
        continue;
      }
      if (name === input.tag) {
        match = { record, name };
        break;
      }
    }
    if (match === undefined) {
      return namespaceBlocked
        ? {
            kind: "refused",
            reason: "namespace",
            tag: input.tag,
            detail: `tag ${input.tag} lies outside every declared namespace (${naming.namespaces.join(", ")}) of the binding's declared tag naming`,
          }
        : {
            kind: "refused",
            reason: "unclaimed",
            tag: input.tag,
            detail: `no claim held by attempt ${input.attemptId} derives tag ${input.tag}`,
          };
    }
    // A held claim under another attempt's token is a foreign mint: never
    // an admission, the held claim wins.
    if (match.record.token !== input.token) {
      return {
        kind: "conflict",
        tag: input.tag,
        detail: `the claim deriving tag ${input.tag} is held under a different token`,
      };
    }
    const tagRef = `refs/tags/${match.name}`;
    let fault: GitFaultError | undefined;
    if (readRef(git, tagRef) === null) {
      // The tag spelling through the runner, no signing, the supplied
      // target peeled: a lightweight ref at the recorded commit.
      try {
        git(["tag", "--no-sign", match.name, input.target]);
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
          ["tag", "--no-sign", match.name, input.target],
          null,
          `tag ref ${tagRef} absent after its create`,
        )
      );
    }
    // The CAS existence check: same target is the idempotent re-mint, a
    // different target is the existing ref winning.
    return after === input.target
      ? { kind: "minted", tag: match.name, target: input.target }
      : {
          kind: "conflict",
          tag: match.name,
          detail: `tag ${match.name} already exists at ${after}, not ${input.target}`,
        };
  };
}
