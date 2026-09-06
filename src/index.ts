/**
 * The public surface of @ecoma-io/release-craft.
 *
 * This module is NOT the release engine. It is the package's front door: the
 * toolchain canary (the typed surface the typecheck compiles, Vitest
 * executes, ESLint judges and the build emits) plus the layers that
 * actually ship — the domain the `core-domain` project exports, the
 * Phase 2 planner (src/planner/: the planning layer that turns observed
 * repository history into release decisions, version targets, propagation
 * plans and content fingerprints) and the Phase 4 execution kernel
 * (src/execution/: the attempt state machine, the claim store and its
 * scopes, the guard table, `requestStep`'s seven outcomes — the execution
 * vocabulary ADR-0005 and the Phase 4 contract lock) — re-exported, never
 * reimplemented here. The release ledger, lifecycle hooks, artifact and
 * provider adapters belong to their own later phases, never to this file.
 *
 * The surface carries no claim about the repository's stage of life. A stage
 * literal exported from here was a claim in code that no gate could read,
 * and it drifted from the documented state within the single PR that
 * introduced it (issue #9): the honest alternatives were a vocabulary
 * nothing consumes or no vocabulary. What describes the repository's state
 * lives in README.md and AGENTS.md, under `check:docs`; what it ships lives
 * below, under the executable gates.
 */

// The domain kernel's public contract. This single re-export is the
// `type-package → type-domain` edge archkeep's `type-package` row allows —
// the kernel itself imports nothing external (see core/domain/ and
// module-boundaries.config.mjs). The specifier is the package alias, not a
// relative path: archkeep refuses cross-project relative imports before its
// constraint table is even read, and this spelling is what makes the edge
// visible to that table — resolved from source by tsconfig `paths`, from
// dist by the package's own `exports` self-reference, and by Vitest's
// `resolve.alias`. The alias names the kernel barrel (core/domain/index.ts —
// ADR-0001 decision 8 as amended by ADR-0002 decision-log D6), so the public
// surface here is the barrel's surface, wholesale: one declaration, no drift
// between what ships and what the contract suite imports.
export * from "@ecoma-io/release-craft/domain";

// The Phase 2 planner's public contract. This re-export is an ordinary
// within-project edge — the planner lives in this package's own tree, so
// the relative specifier is the honest spelling; the package-alias
// treatment stays reserved for the cross-project `type-package →
// type-domain` edge commented above. The surface is the planner barrel's,
// wholesale (one declaration, no drift), and its isolation is enforced by
// test/planner/isolation.test.ts.
export * from "./planner/index.js";

// The Phase 4 execution kernel's public contract (ADR-0005). Within this
// package's own tree, so the relative specifier is the honest spelling;
// the surface is the execution barrel's, wholesale (one declaration, no
// drift), and its isolation is enforced by test/execution/isolation.test.ts.
export * from "./execution/index.js";

/** The package identity, exactly as package.json declares it. */
export const PACKAGE_NAME = "@ecoma-io/release-craft" as const;
