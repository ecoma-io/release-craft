/**
 * The public surface of @ecoma-io/release-craft.
 *
 * This module is NOT the release engine. It is the package's front door: the
 * toolchain canary from the bootstrap (the typed surface the typecheck
 * compiles, Vitest executes, ESLint judges and the build emits) plus the
 * domain the `core-domain` project actually ships — re-exported, never
 * reimplemented here. Every release-planning, lifecycle, adapter and
 * publishing concern belongs to a future change, never to this file.
 */

export {
  // The domain kernel's public contract. This single re-export is the
  // `type-package → type-domain` edge archkeep's `type-package` row allows —
  // the kernel itself imports nothing (see core/domain/version.ts and
  // module-boundaries.config.mjs). The specifier is the package alias, not a
  // relative path: archkeep refuses cross-project relative imports before its
  // constraint table is even read, and this spelling is what makes the edge
  // visible to that table — resolved from source by tsconfig `paths`, from
  // dist by the package's own `exports` self-reference, and by Vitest's
  // `resolve.alias`. ADR-0001 records the seam.
  InvalidVersionError,
  Version,
} from "@ecoma-io/release-craft/domain";

/** The package identity, exactly as package.json declares it. */
export const PACKAGE_NAME = "@ecoma-io/release-craft" as const;

/**
 * Where the repository is in its life: the substrate plus the first domain
 * primitive, with no release process implemented yet.
 */
export type ProjectStage = "foundation";

/** The identity a consumer (today, only the toolchain itself) can read. */
export interface ReleaseCraftIdentity {
  readonly name: typeof PACKAGE_NAME;
  readonly stage: ProjectStage;
}

/** Returns the repository's identity — the canary's entire public behaviour. */
export function identity(): ReleaseCraftIdentity {
  return { name: PACKAGE_NAME, stage: "foundation" };
}
