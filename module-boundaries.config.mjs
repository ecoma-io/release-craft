// Architecture law for release-craft, judged by @ecoma-io/archkeep (`pnpm arch`).
//
// This repository is a Moonrepo workspace, so archkeep reads the project graph
// through its Moon provider — the project map lives in `.moon/workspace.yml`
// and each project's vocabulary lives in its `moon.yml` `tags`. A root
// `archkeep.json` cannot coexist with `.moon/` (archkeep refuses the pair),
// which is why this file is the boundary policy the provider loads by
// convention. The reasoning is recorded in docs/bootstrap/ecosystem-analysis.md.
//
// Moon tags cannot contain colons, so the constraint vocabulary's `type:` is
// spelled `type-` in moon.yml and here alike.
//
// Exit codes archkeep can produce: 0 clean · 1 findings · 2 usage · 3
// no-verdict. A run that ends in anything other than 0 must fail the build —
// a verdict that could not be reached is never a clean tree.

/**
 * The dependency constraints, in the `@nx/enforce-module-boundaries` option
 * shape archkeep consumes. Two rows, one per project tag — kept exhaustive on
 * purpose: an unlisted tag would be unconstrained, so a new tag must arrive
 * together with the row that judges it.
 *
 * @type {Array<{ sourceTag: string, onlyDependOnLibsWithTags: string[] }>}
 */
export const depConstraints = [
  // The package may only depend on itself. `src/` is a canary today; when the
  // release engine arrives and internal layering becomes real, it is expressed
  // as more tags here — never by loosening this row.
  { sourceTag: "type-package", onlyDependOnLibsWithTags: ["type-package"] },

  // The repository gates (scripts/) are standalone: they may never import the
  // package they judge. A gate that imports what it judges stops being a gate
  // — its verdict becomes an argument with its own subject.
  { sourceTag: "type-gates", onlyDependOnLibsWithTags: ["type-gates"] },
];

/**
 * The plugin options archkeep judges boundaries with, all written at their
 * defaults so a reader sees the whole policy surface in one place and a future
 * change is a visible diff rather than an inherited assumption.
 *
 * @type {{
 *   allow: string[];
 *   buildTargets: string[];
 *   enforceBuildableLibDependency: boolean;
 *   allowCircularSelfDependency: boolean;
 *   checkDynamicDependenciesExceptions: string[];
 *   ignoredCircularDependencies: string[][];
 *   banTransitiveDependencies: boolean;
 *   checkNestedExternalImports: boolean;
 * }}
 */
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};

/**
 * Suppressions are where a boundary rule goes to die quietly, so the list
 * starts empty and every entry that ever lands here must carry a reason —
 * archkeep's loader rejects an entry without one.
 *
 * @type {Array<{ path: string, messageId: string, reason: string }>}
 */
export const boundarySuppressions = [];
