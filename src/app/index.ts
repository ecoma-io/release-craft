/**
 * The application boundary's barrel (phase 11 contract §2.1): the top of
 * the DAG, imported by hosts and by `src/index.ts`, importing the layers
 * beneath it only through their own barrels.
 *
 * The surface is explicit, not `export *` (§2.9: the surface never exposes
 * a mutation primitive, a store internal, or a door around the claim): the
 * two factories are the door (§2.2), the `Engine` value is what they
 * return, and the only other value exports are the boundary's own pure
 * derivations. The walk (`createEngine`) and the channel stage's executor
 * stay internal — a host that composes them by hand would own a second
 * door around exactly the moves the engine exists to gate.
 */
export * from "./types.js";
export { claimScopeForLine, type ClaimAcquisition } from "./claims.js";
export { plannedChannelMoves } from "./channels.js";
export { assembleMemoryStores, assembleGitBinding } from "./assemble.js";
