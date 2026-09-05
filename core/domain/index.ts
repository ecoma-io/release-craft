/**
 * The kernel barrel — the domain kernel's single entrypoint.
 *
 * Everything the kernel exports is exported here and nowhere else: `Version`
 * and the five release values of ADR-0002's vocabulary lock (`Change`,
 * `ChangeSet`, `ReleaseLine`, `Channel`, `Artifact`), the `Bump` vocabulary
 * `ChangeSet` carries, and every error class. The three alias declarations —
 * tsconfig `paths`, package.json `exports`, vitest `resolve.alias` — all name
 * this file, so adding a primitive extends this barrel and touches none of
 * the three (ADR-0001 decision 8, as amended by ADR-0002 decision-log D6; the
 * seam originally named `version.ts` directly, when the kernel was one file).
 *
 * The barrel is re-export only: no logic lives here, and each value's
 * contract lives in its own file beside this one. The kernel's purity law is
 * unchanged by the extra files — every file under `core/domain/` inherits the
 * three-layer enforcement (archkeep's import ban, `types: []`, the lint
 * surface) by glob, not by enumeration.
 */

export { InvalidVersionError, Version } from "./version.js";
export { Change, InvalidChangeError } from "./change.js";
export type { ChangeLineage } from "./change.js";
export { BUMP_LEVEL, Bump, ChangeSet, InvalidChangeSetError } from "./changeset.js";
export { InvalidLineTransitionError, ReleaseLine } from "./line.js";
export type { LineLifecycle, PrereleaseStreamState } from "./line.js";
export { Channel, InvalidChannelError } from "./channel.js";
export type { ChannelTarget } from "./channel.js";
export { Artifact, InvalidArtifactError } from "./artifact.js";
