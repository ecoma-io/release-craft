/**
 * The GitHub adapter's public surface (the Phase 9 contract §2.6): the
 * tests' and the assembly's only entry — the opened adapter factory and
 * the surface types, and nothing else (ADR-0001 decision 9's shape,
 * extended to the adapter layer). The units behind the factory are the
 * implementation the assembly composes; their public crossing left with
 * the 9.5 assembly.
 *
 * The `remote-identity.ts` export is the open-time identity's single
 * parser shared with the CLI's publish dispatch: the publish leg derives
 * the API credentials' owner/repo from the binding repository's own
 * origin, and duplicating the parser at the composition root would be
 * the second definition of one identity. The transport unit itself stays
 * behind the factory — `openGitHubAdapter` owns every wire it touches.
 */
export * from "./adapter-types.js";
export * from "./adapter.js";
export { CREDENTIALS_HOST, parseRemoteIdentity, type RemoteIdentity } from "./remote-identity.js";
