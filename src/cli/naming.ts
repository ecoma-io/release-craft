/**
 * The one declared tag-naming derivation (phase 12 contract §2.3), shaped
 * like the contract fixture's `naming` in `test/vertical/matrix-git.ts`:
 * a `GitTagNaming` with declared namespace roots and a `tagFor`
 * projection.
 *
 * Semantics, decided and pinned here:
 * - The `--tag-namespace` occurrences are FILTER declarations — the roots
 *   whose tags this CLI may claim, in the order declared.
 * - `tagFor` returns the scope's own bare tag (unprefixed — the tag door
 *   compares the projection against the plan's bare planned tag) when the
 *   first-claiming declared root claims it, and `null` otherwise. A
 *   `null` projection is the binding's declared "this namespace is not
 *   ours": the scope denies itself (`refusal: "namespace"`), it is never
 *   renamed.
 * - The empty string is the declared every-tag root (the binding door's
 *   `root === "" ||` clause; the contract fixture uses exactly
 *   `namespaces: [""]`).
 * - The `release-line` scope has no tag of its own to claim: its
 *   projection is `null` regardless of the declared roots (it names an
 *   already-existing tag family, so there is nothing to mint).
 */

import type { ClaimScope } from "../index.js";
import type { GitTagNaming } from "../adapters/git/index.js";

const scopeOwnTag = (scope: ClaimScope): string | null => {
  switch (scope.kind) {
    case "prerelease-sequence":
      return `${scope.target}-${scope.streamId}.${String(scope.sequence)}`;
    case "stable-version":
      return scope.version;
    case "release-line":
      return null;
  }
};

const claimsTag = (tag: string, roots: readonly string[]): boolean =>
  roots.some((root) => root === "" || tag.startsWith(root));

/** Build the declared naming from the `--tag-namespace` occurrences. */
export const declaredTagNaming = (roots: readonly string[]): GitTagNaming => ({
  namespaces: [...roots],
  tagFor: (scope: ClaimScope): string | null => {
    const own = scopeOwnTag(scope);
    if (own === null) {
      return null;
    }
    return claimsTag(own, roots) ? own : null;
  },
});
