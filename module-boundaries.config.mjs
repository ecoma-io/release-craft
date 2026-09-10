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
 * shape archkeep consumes. One row per project tag — kept exhaustive on
 * purpose: an unlisted tag would be unconstrained, so a new tag must arrive
 * together with the row that judges it.
 *
 * The direction law this table states (ADR-0001 is its source of truth):
 *
 *   core-domain       →  core-domain       ✅  the kernel imports only itself — and
 *                                             nothing external at all (bannedExternalImports)
 *   planner           →  core-domain       ✅  the planning layer reaches the kernel only
 *   execution         →  planner, domain   ✅  the execution kernel reaches the planner barrel
 *   app               →  execution/planner/adapters-git ✅  the boundary composes the layers
 *   adapters-git      →  execution/planner ✅  the binding reaches the layers it implements
 *   adapters-github   →  adapters-git      ✅  the GitHub adapter reaches only the git binding
 *   cli               →  app/execution/planner/adapters-git ✅  the CLI composes the layers it renders —
 *                                             never the package front door
 *   release-craft     →  every layer       ✅  the package shell re-exports the layers below
 *   gate-scripts      →  gate-scripts only ❌  a gate that imports what it judges stops being a gate
 *   adapters          →  app, cli          ❌  adapters compose inward, never toward the surface
 *
 * @type {Array<{ sourceTag: string, onlyDependOnLibsWithTags: string[], bannedExternalImports?: string[] }>}
 */
export const depConstraints = [
  // The package shell re-exports the layers below it — the barrel
  // src/index.ts is the public surface. The tag rows below are what makes
  // the direction law executable: an upward edge (planner → execution,
  // adapter → app, cli → the package front door) fails the arch gate with
  // the row's verdict, not a human reading of the import graph.
  {
    sourceTag: "type-package",
    onlyDependOnLibsWithTags: [
      "type-package",
      "type-domain",
      "type-planner",
      "type-execution",
      "type-app",
      "type-cli",
      "type-adapters-git",
      "type-adapters-github",
    ],
  },

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

  // The planner reaches the domain kernel and nothing above it — no
  // execution, no app, no adapter, no cli. Its only frozen built-in
  // (`node:crypto` in identity.ts) is the scanner suite's allowance, not
  // this table's — built-ins are not project edges.
  { sourceTag: "type-planner", onlyDependOnLibsWithTags: ["type-domain"] },

  // The execution kernel reaches the planner barrel (canonicalJson, the
  // planner's own public surface) and the domain kernel. No app, adapter,
  // or cli import is legal here.
  { sourceTag: "type-execution", onlyDependOnLibsWithTags: ["type-domain", "type-planner"] },

  // The application boundary composes execution, planner, domain and the
  // git binding's barrel — never the cli, never the package front door.
  {
    sourceTag: "type-app",
    onlyDependOnLibsWithTags: [
      "type-domain",
      "type-planner",
      "type-execution",
      "type-adapters-git",
    ],
  },

  // The CLI composes the app barrel (the run outcomes and engine value it
  // renders), the execution kernel, the planner barrel, the domain kernel
  // and the git adapter's barrel — but never the package front door.
  // `type-package` is deliberately absent from this row: the #155 defect
  // (cli/naming.ts importing the package barrel, transitively evaluating
  // the whole graph) is now a boundary violation the gate names by file.
  {
    sourceTag: "type-cli",
    onlyDependOnLibsWithTags: [
      "type-domain",
      "type-planner",
      "type-execution",
      "type-app",
      "type-adapters-git",
    ],
  },

  // The git adapter reaches the layers it implements (planner, execution,
  // domain) — never app, never cli, never the github adapter (the reverse
  // direction is real; this one is not).
  {
    sourceTag: "type-adapters-git",
    onlyDependOnLibsWithTags: ["type-domain", "type-planner", "type-execution"],
  },

  // The GitHub adapter reaches only the git binding's barrel — no planner,
  // no execution, no app, no cli, never the package front door.
  {
    sourceTag: "type-adapters-github",
    onlyDependOnLibsWithTags: ["type-domain", "type-adapters-git"],
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
