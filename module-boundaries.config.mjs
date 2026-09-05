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
 * shape archkeep consumes. Three rows, one per project tag — kept exhaustive on
 * purpose: an unlisted tag would be unconstrained, so a new tag must arrive
 * together with the row that judges it.
 *
 * The direction law this table states (ADR-0001 is its source of truth):
 *
 *   core-domain  →  core-domain      ✅  the kernel imports only itself — and
 *                                    nothing external at all (bannedExternalImports)
 *   release-craft →  core-domain     ✅  the package shell may re-export the domain
 *   core-domain  →  release-craft    ❌  the kernel never consumes its consumers
 *   gate-scripts →  anything else    ❌  a gate that imports what it judges stops
 *                                    being a gate
 *
 * @type {Array<{ sourceTag: string, onlyDependOnLibsWithTags: string[], bannedExternalImports?: string[] }>}
 */
export const depConstraints = [
  // The package may depend on itself and on the domain kernel — and on
  // nothing else. When the release engine arrives and internal layering
  // becomes real, it is expressed as more tags here — never by loosening
  // this row.
  { sourceTag: "type-package", onlyDependOnLibsWithTags: ["type-package", "type-domain"] },

  // The domain kernel is the bottom of the graph, in both directions at once:
  // `onlyDependOnLibsWithTags` keeps every other project out of its imports,
  // and `bannedExternalImports: ["*"]` keeps every Node built-in and every
  // npm package out as well — no `fs`, no `path`, no `semver`, no `octokit`.
  // A domain value that opens a file, reads the clock or speaks to a network
  // is not a domain value; here that sentence is a constraint the `arch`
  // gate evaluates, not a comment. (archkeep checks banned imports on direct
  // external imports; the transitive form would need
  // `checkNestedExternalImports`, left at its default while the kernel has
  // zero external edges to nest.)
  {
    sourceTag: "type-domain",
    onlyDependOnLibsWithTags: ["type-domain"],
    bannedExternalImports: ["*"],
  },

  // The repository gates (scripts/) are standalone: they may never import the
  // package they judge — nor the domain it re-exports, since the package row
  // above is what makes that import legal for the package only. A gate that
  // imports what it judges stops being a gate — its verdict becomes an
  // argument with its own subject.
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
