/**
 * Attempt identity (contract §2.1; ADR-0005 decision 2): one execution of
 * one plan is a release attempt whose id is content-anchored and
 * register-allocated — `attempt_sha256:<hex>`, the SHA-256 of the canonical
 * JSON (recursively key-sorted) of `{ planId, ordinal }`, where `ordinal`
 * is the attempt's 1-based position in the plan's attempt sequence. A retry
 * produces a new attempt with a new ordinal over the same plan id — "one
 * plan, two attempts" is E-05's recorded shape. The canonicalizer is the
 * planner's locked one, imported through the planner's public surface (§
 * 2.11); `node:crypto` is this module's frozen exception (contract §2.12,
 * the isolation gate's only builtin allowance in the layer).
 */
import { createHash } from "node:crypto";

import { canonicalJson } from "../planner/index.js";

/**
 * The attempt id (§2.1): `attempt_sha256:<hex>` over the canonical JSON of
 * `{ planId, ordinal }`. Lowercase hex, 64 characters — the frozen shape.
 */
export const attemptIdentity = (planId: string, ordinal: number): string => {
  return `attempt_sha256:${createHash("sha256").update(canonicalJson({ ordinal, planId })).digest("hex")}`;
};

/**
 * The content fingerprint (phase 5 contract §2.6; ADR-0006 decision 8):
 * `content_sha256:<hex>` over the canonical JSON of the step's declared
 * content inputs — the same canonicalizer as the attempt id, no clock, no
 * environment. This is the durable mechanics ADR-0005 decision 8 deferred:
 * Phase 4 carried the field's presence; the ledger fills it with this.
 */
export const contentFingerprint = (inputs: Record<string, string>): string => {
  return `content_sha256:${createHash("sha256").update(canonicalJson(inputs)).digest("hex")}`;
};
