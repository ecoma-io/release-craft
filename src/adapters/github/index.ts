/**
 * The GitHub adapter's public surface (Phase 9 contract §2.6): the tests'
 * and the assembly's only entry — the opened adapter factory and the
 * surface types. Nothing else crosses this barrel (ADR-0001 decision 9's
 * shape, extended to the adapter layer).
 *
 * Interim (phase 9.2): the sync unit crosses the barrel so the §4
 * barrel-only tests can reach it. 9.5's `openGitHubAdapter` assembly
 * composes the units and replaces these interim exports — the factory
 * and the surface types are the only phase-end surface.
 */
export * from "./adapter-types.js";
export * from "./remote-git.js";
export * from "./sync.js";
export * from "./publication.js";
