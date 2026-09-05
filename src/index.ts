/**
 * The toolchain canary for the release-craft bootstrap.
 *
 * This module is NOT the release engine. It exists so the init commit's
 * gates have a real subject: something with a typed public surface that the
 * typecheck compiles, Vitest executes, ESLint judges, the build emits, and
 * the architecture boundary owns (`type-package`). Every release-planning,
 * versioning and lifecycle concern belongs to a future change, never to this
 * file — the bootstrap's whole point is that the substrate lands before the
 * domain does.
 */

/** The package identity, exactly as package.json declares it. */
export const PACKAGE_NAME = "@ecoma-io/release-craft" as const;

/** Where the repository is in its life: substrate only, no domain yet. */
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
