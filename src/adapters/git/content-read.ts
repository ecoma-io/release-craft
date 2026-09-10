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

import type { ExecutionLedger } from "@ecoma-io/release-craft/execution";
import type { ContentRead, GitTagNaming } from "./binding-types.js";
import { readRegister } from "./claim-store-git.js";
import { GitFaultError, type GitRun } from "./git-run.js";

/** The digest prefix the artifact producer records (§2.5): the recorded
 *  content's tree object. `file` reads out of that tree and nothing
 *  else. */
const TREE_DIGEST_PREFIX = "git-tree:";

/**
 * The byte-exact stderr spellings git (2.55.0, probed; exit 128 in both)
 * gives a path the named tree does not hold — the one outcome the D27
 * projection reads as a value. The second spelling is the same absence:
 * git adds its "exists on disk" aside when a file of that name sits in
 * the working tree, which the binding never reads (ADR-0009 decision 4).
 * The messages are untranslated in the shipped catalogs (probed de/fr),
 * and a path holding a control character is rendered `?` in them — both
 * spellings fall outside the match, so every shape git cannot spell
 * stays a fault and never a false null.
 */
const PATH_ABSENT_SHAPES = (oid: string, path: string): readonly string[] => [
  `fatal: path '${path}' does not exist in '${oid}'\n`,
  `fatal: path '${path}' exists on disk, but not in '${oid}'\n`,
];

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
      // file (a changelog refusal) from a broken git (a throw). As
      // readRef's (#95, D39), the discrimination is exact (#108): only
      // the shape git's own `cat-file blob <oid>:<path>` contract spells
      // for an absent path — exit 128 with one of the byte-exact
      // PATH_ABSENT_SHAPES messages — returns null. Every other fault
      // the read can produce propagates: a corrupt or pruned object
      // behind a live tree entry, an unreadable object store, a path
      // that names a directory, an unexpected exit status, a spawn
      // failure — a broken object store is never read as a missing file.
      try {
        return git(["cat-file", "blob", `${oid}:${path}`]);
      } catch (error) {
        if (
          error instanceof GitFaultError &&
          error.status === 128 &&
          PATH_ABSENT_SHAPES(oid, path).includes(error.stderr)
        ) {
          return null;
        }
        throw error;
      }
    },
  };
}
