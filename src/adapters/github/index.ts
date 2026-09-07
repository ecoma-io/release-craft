/**
 * The GitHub adapter's public surface (Phase 9 contract §2.6): the tests'
 * and the assembly's only entry — the opened adapter factory and the
 * surface types. Nothing else crosses this barrel (ADR-0001 decision 9's
 * shape, extended to the adapter layer).
 */
export * from "./adapter-types.js";
