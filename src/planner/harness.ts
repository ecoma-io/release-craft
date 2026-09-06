/**
 * The planner's PR-2 composition root: normalize → extract → attribute,
 * exactly the three frozen module signatures in contract order (§2.1–§2.4).
 * The public API surface is wired in the integration phase (contract §7);
 * until then the golden fixtures consume the planner through this harness.
 */

import type { AttributionOutcome, ExtractionResult, LineRange, PlanningInput } from "./types.js";
import { attribute } from "./attribute.js";
import { extract } from "./extract.js";
import { normalize } from "./input.js";

/** What one planning pass produces: the extraction evidence plus the
 * attribution outcome — the raw material the bump/version-planning phases
 * (PR-3/PR-4) consume. A refused attribution is an outcome, not an error:
 * the caller decides what a refused record means for its surface (§2.9). */
export interface PlanChangesResult {
  readonly extraction: ExtractionResult;
  readonly attribution: AttributionOutcome;
}

/**
 * One deterministic planning pass over a closed, validated input. Malformed
 * `PlanningInput` values are caller contract violations — `normalize`
 * throws `InvalidPlanningInputError` for them (§2.1); planning-level
 * negatives come back as records, never as throws.
 */
export function planChanges(input: PlanningInput, ranges: readonly LineRange[]): PlanChangesResult {
  const normalized = normalize(input);
  const extraction = extract(normalized.repository.commits, normalized.policy);
  return { extraction, attribution: attribute(extraction, normalized, ranges) };
}
