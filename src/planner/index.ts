/**
 * The planner barrel — the Phase 2 planner's single entrypoint and public
 * surface (contract §4 A3).
 *
 * Everything the planner exports is exported here and nowhere else, in the
 * kernel barrel's style (core/domain/index.ts): the single entry `plan` —
 * the pure normalize → extract → history → ranges → attribute → decide →
 * state → targets → propagation → fingerprint door of §2.6 — plus the
 * staged functions it composes, the `InvalidPlanningInputError` its
 * caller-contract checks throw, and the frozen type vocabulary of
 * types.ts wholesale. That wholesale type re-export is deliberate: the
 * file is the contract's frozen section, so `export type *` cannot drift
 * from it by construction.
 *
 * The barrel is re-export only: no logic lives here, and each function's
 * contract lives in its own file beside this one. Isolation is enforced,
 * not promised — test/planner/isolation.test.ts (contract §6 A3, modeled
 * on Phase 1's provider-isolation suite) proves the layer imports nothing
 * outside src/planner and the kernel barrel, except identity.ts's
 * "node:crypto" (§2.11 hashing is pure computation, the frozen exception),
 * and names no clock, no randomness, no process — pinned behaviorally by
 * §2.14's double-run equality.
 *
 * harness.ts is deliberately absent from this surface: it composes the
 * landed doors for the planner's own tests, and §2.9 leaves it to each
 * caller's surface to decide what a refused record means.
 */

export { InvalidPlanningInputError, normalize } from "./input.js";
export type { InputViolation } from "./input.js";
export { extract } from "./extract.js";
export { attribute } from "./attribute.js";
export { loadTagHistory, deriveRanges } from "./history.js";
export { resolveBump, decideLine } from "./decide.js";
export { rebuildLineState } from "./state.js";
export { planTargets, planStreams, formatTag } from "./plan.js";
export { plannedChannelTransitions } from "./channels.js";
export { planPropagation } from "./propagate.js";
export { renderChangelog, InvalidChangelogInputError } from "./changelog.js";
export type {
  ChangelogEntry,
  ChangelogInput,
  ChangelogSection,
  ChangelogVersion,
} from "./changelog.js";
export { canonicalJson, planFingerprint, inputsFingerprint } from "./identity.js";
export { plan } from "./assemble.js";

export { InvalidManifestError, parseManifest } from "./config.js";
// The frozen contract vocabulary — every planner type, wholesale (§4 A3).
export type * from "./types.js";
