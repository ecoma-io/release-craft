/**
 * The one declared tag-naming derivation (phase 12 contract §2.3), shaped
 * like the contract fixture's `naming` in `test/vertical/matrix-git.ts`:
 * a `GitTagNaming` with declared namespace roots and a `tagFor`
 * projection.
 *
 * The rendering is the load-bearing half, and it is REUSED, not
 * re-derived: the mint door admits a mint only when the naming's
 * projection of a held claim's scope equals the plan's own tag
 * (`tagFor(record.scope) === input.tag`, the tag door's fail-closed
 * walk), and the plan's tag is rendered by the planner's `formatTag` over
 * the same world document's declared `policy.tagFormats` for the scope's
 * line. So `tagFor` renders through the planner's own `formatTag` — the
 * planner barrel exports it for exactly this consumer — over the
 * document's declared formats; a line with no declared format renders
 * bare, which is the planner's own undeclared default. A derivation that
 * guessed at the shape (a bare tag where the world declares `v…`) would
 * strand the operator: the claim stands, the walk reaches the mint, and
 * the mint refuses `unclaimed` — recorded evidence, nothing minted.
 *
 * Semantics, decided and pinned here (§2.3 as amended by this slice):
 * - The `--tag-namespace` occurrences are FILTER declarations over the
 *   RENDERED tag — the roots whose tags this CLI may claim, in the order
 *   declared.
 * - `tagFor` returns the scope's rendered tag — the plan's own spelling —
 *   when a declared root claims it, and `null` otherwise. A `null`
 *   projection is the binding's declared "this namespace is not ours":
 *   the scope denies itself (`refusal: "namespace"`), it is never
 *   renamed, and the root is never prepended to make a refusal go away.
 * - The empty string is the declared every-tag root (the binding door's
 *   `root === "" ||` clause; the contract fixture uses exactly
 *   `namespaces: [""]`).
 * - The `release-line` scope has no tag of its own to claim: its
 *   projection is `null` regardless of the declared roots (it names an
 *   already-existing tag family, so there is nothing to mint).
 */

import { Version } from "@ecoma-io/release-craft/domain";
import type { GitTagNaming } from "../adapters/git/index.js";
import type { ClaimScope } from "../execution/index.js";
import { formatTag } from "../planner/index.js";

/** The tag a claim scope derives, rendered exactly as the planner renders
 * the plan's own tag: through `formatTag` over the scope's line's declared
 * format, `null` when the scope names no minted tag at all. The
 * prerelease scope carries the rendered version's own base and its
 * `-<stream>.<n>` suffix separately (the claim's canonical shape), so the
 * minted version is reassembled — the same value `claimScopeForLine`
 * took apart. */
const scopeTag = (
  scope: ClaimScope,
  tagFormats: Readonly<Record<string, string>>,
): string | null => {
  switch (scope.kind) {
    case "prerelease-sequence":
      return formatTag(
        Version.parse(`${scope.target}-${scope.streamId}.${String(scope.sequence)}`),
        tagFormats[scope.lineId],
      );
    case "stable-version":
      return formatTag(Version.parse(scope.version), tagFormats[scope.lineId]);
    case "release-line":
      return null;
  }
};

const claimsTag = (tag: string, roots: readonly string[]): boolean =>
  roots.some((root) => root === "" || tag.startsWith(root));

/** Build the declared naming from the `--tag-namespace` occurrences and
 * the world document's declared `policy.tagFormats` — the same document
 * the plan reads, so the naming and the plan render one tag from one
 * source. */
export const declaredTagNaming = (
  roots: readonly string[],
  tagFormats: Readonly<Record<string, string>> = {},
): GitTagNaming => ({
  namespaces: [...roots],
  tagFor: (scope: ClaimScope): string | null => {
    const rendered = scopeTag(scope, tagFormats);
    if (rendered === null) {
      return null;
    }
    return claimsTag(rendered, roots) ? rendered : null;
  },
});
