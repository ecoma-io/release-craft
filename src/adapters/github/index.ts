/**
 * The GitHub adapter's public surface (the Phase 9 contract §2.6): the
 * tests' and the assembly's only entry — the opened adapter factory and
 * the surface types, and nothing else (ADR-0001 decision 9's shape,
 * extended to the adapter layer). The units behind the factory are the
 * implementation the assembly composes; their public crossing left with
 * the 9.5 assembly.
 */
export * from "./adapter-types.js";
export * from "./adapter.js";
