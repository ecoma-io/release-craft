/**
 * The binding's content read seam (the Phase 9 contract §2.8; D27): the
 * release projection's read half. Every answer resolves from recorded
 * state only — the claim records a register ref holds (the per-line
 * register of ADR-0011; an absent ref is the empty set), the declared
 * naming's own derivation, the ledger's recorded stream, and one file
 * out of the recorded tree a digest names — through the same hermetic
 * runner the binding's other doors run on. No write exists here: the
 * seam exposes the ledger's tail without its `append` (structural, not
 * by convention), and `file` reads recorded objects, never the working
 * tree and never `HEAD` (ADR-0009 decision 4's discipline, read side).
 */

import type { ExecutionLedger } from "../../index.js";
import type { ContentRead, GitTagNaming } from "./binding-types.js";
import { readRegister } from "./claim-store-git.js";
import { GitFaultError, type GitRun } from "./git-run.js";

/** The digest prefix the artifact producer records (§2.5): the recorded
 *  content's tree object. `file` reads out of that tree and nothing
 *  else. */
const TREE_DIGEST_PREFIX = "git-tree:";

/**
 * Opens the content read seam over the binding's shared runner, the
 * declared naming, and the ledger. Synchronous, like every door; the
 * seam resolves nothing beyond the recorded objects it is asked about.
 */
export function GitContentRead(
  git: GitRun,
  naming: GitTagNaming,
  ledger: ExecutionLedger,
): ContentRead {
  return {
    claims: (ref) => readRegister(git, ref) ?? [],
    tagFor: (scope) => naming.tagFor(scope),
    tail: (attemptId) => ledger.tail(attemptId),
    file(digest, path) {
      if (!digest.startsWith(TREE_DIGEST_PREFIX)) {
        throw new TypeError(
          `the digest ${digest} is not a recorded tree digest (${TREE_DIGEST_PREFIX}<oid>)`,
        );
      }
      const oid = digest.slice(TREE_DIGEST_PREFIX.length);
      // The runner throws for an unknown object: a digest whose tree is
      // gone is a corrupted recorded state, a fault like every broken
      // invariant the binding uncovers — never a null.
      const kind = git(["cat-file", "-t", oid]).trim();
      if (kind !== "tree") {
        throw new TypeError(`the digest ${digest} names a ${kind}, not a tree`);
      }
      // A path the recorded tree does not hold is a null, never a fault
      // — the D27 projection distinguishes a recorded tree without the
      // file (a changelog refusal) from a broken git (a throw).
      try {
        return git(["cat-file", "blob", `${oid}:${path}`]);
      } catch (error) {
        if (error instanceof GitFaultError) {
          return null;
        }
        throw error;
      }
    },
  };
}
