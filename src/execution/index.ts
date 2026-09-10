/**
 * The execution kernel's public surface (contract §2.12; ADR-0005): the
 * frozen vocabulary, the state machine, the claim store and its reference
 * implementation, the attempt register and its reference implementation,
 * the channel store and its reference implementation (ADR-0012 decision 6),
 * the guard table, the bounded sequence retry, the transition log's
 * reference shape, and `requestStep` — the pure transition planner.
 * Re-exports only: the layer's modules are the implementation; this file is
 * the contract. Tests import the kernel through this barrel and nothing
 * deeper (§5); the domain kernel is reached, when needed, through its own
 * barrel (`@ecoma-io/release-craft/domain`), and the planner's public
 * surface through `../planner/index.js` — the two imports the isolation
 * gate allows this layer (§2.11, §2.12).
 */
export * from "./adopt.js";
export * from "./artifacts.js";
export * from "./attempt-register-memory.js";
export * from "./attempt.js";
export * from "./channel-store-memory.js";
export * from "./claim-store-memory.js";
export * from "./claim.js";
export * from "./hooks.js";
export * from "./identity.js";
export * from "./ledger.js";
export * from "./outcome.js";
export * from "./resume.js";
export * from "./revalidation.js";
export * from "./step-keys.js";
export * from "./step.js";
export * from "./transition.js";
export * from "./updater.js";
export * from "./types.js";
