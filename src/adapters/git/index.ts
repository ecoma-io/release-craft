/**
 * The git binding's public surface (contract §2.6; ADR-0009 decision 8):
 * the tests' and the assembly's only entry — the opened binding factory
 * and, re-exported wholesale (one declaration, no drift), the runner, the
 * CAS ref primitives, the freeze discipline and the binding's vocabulary.
 */
export * from "./binding-types.js";
export * from "./binding.js";
export * from "./channel-store-git.js";
export * from "./claim-store-git.js";
export * from "./content-read.js";
export * from "./freeze.js";
export * from "./git-refs.js";
export * from "./git-run.js";
export * from "./ledger-git.js";
export * from "./producer-git.js";
export * from "./register-git.js";
export * from "./tag-door.js";
