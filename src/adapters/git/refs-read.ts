/**
 * The binding's recorded-ref read door (the Phase 9 contract §2.7; D26):
 * the remote projection's read half. The binding enumerates its own
 * recorded refs — the claim refs under its namespace and the tags within
 * the configuration's declared namespaces — each with the object it
 * names: the canonical record's blob for a claim ref (D24), the commit
 * (peeled where git peels) for a tag. Pure reads over `for-each-ref`: no
 * write, no `HEAD` resolution, no working-tree state (ADR-0009 decision
 * 4's discipline, read side).
 */

import type { RecordedRef, RefRead } from "./binding-types.js";
import { CLAIM_REF_NAMESPACE } from "./claim-store-git.js";
import type { GitRun } from "./git-run.js";

/** One `for-each-ref` entry's fields, NUL-separated so ref names (which
 *  cannot contain NUL) parse unambiguously: the ref, its object, and —
 *  for annotated tags — the peeled commit. */
const FORMAT = "%(refname)%00%(objectname)%00%(*objectname)";

const parseRefs = (out: string, kind: RecordedRef["kind"]): readonly RecordedRef[] =>
  out
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [ref, objectname, peeled] = line.split("\0");
      return {
        ref: ref ?? "",
        target: peeled !== undefined && peeled.length > 0 ? peeled : (objectname ?? ""),
        kind,
      };
    });

/** True when the tag name lies within one of the declared namespace roots
 *  — the mint door's own prefix rule, with the empty root declaring every
 *  tag — so the enumeration sees exactly the tags the binding could ever
 *  have minted. */
const withinNamespaces = (ref: string, namespaces: readonly string[]): boolean => {
  const name = ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : "";
  return namespaces.some((root) => root === "" || name.startsWith(root));
};

/**
 * Opens the read door over the binding's shared runner. Synchronous, like
 * every door; the enumeration resolves nothing outside the ref namespaces
 * above — the working tree, `HEAD`, and the remote are invisible to it.
 */
export function GitRefRead(git: GitRun, namespaces: readonly string[]): RefRead {
  return {
    claims: () =>
      parseRefs(git(["for-each-ref", "--format", FORMAT, CLAIM_REF_NAMESPACE]), "claim"),
    tags: () =>
      parseRefs(git(["for-each-ref", "--format", FORMAT, "refs/tags/"]), "tag").filter((entry) =>
        withinNamespaces(entry.ref, namespaces),
      ),
  };
}
