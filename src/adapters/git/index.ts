/**
 * The git binding's public surface (contract §2.6; ADR-0009 decision 8):
 * the tests' and later slices' only entry — the runner, the CAS ref
 * primitives, the freeze discipline and the binding's vocabulary,
 * re-exported wholesale (one declaration, no drift). The port-implementing
 * slices (the ledger, the register, the claim store, the tag door, the
 * producer) join this barrel as they land; nothing is stubbed ahead of them.
 */
export * from "./binding-types.js";
export * from "./freeze.js";
export * from "./git-refs.js";
export * from "./git-run.js";
