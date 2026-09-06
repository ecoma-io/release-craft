/**
 * Step identity and the canonical stage sequence (contract §2.5; ADR-0005
 * decision 6) plus the guard table (§2.9; ADR-0005 decision 9). A step is
 * identified by `(attemptId, stepKey)`; in Phase 4 a `stepKey` is one of
 * the canonical eight stages — closed here, extended only by later phases'
 * own ADRs, which must name their insertion rules. `tag` is the no-return
 * boundary (E-01): once it completes, supersession records but no longer
 * voids (attempt.ts's supersedePlan reads the completion from the step
 * view).
 *
 * The guard table is invariant 11's executable home: every mutating stage
 * demands a held, verified claim (§2.9), `claim` demands the acquisition it
 * records, `validate` consumes the caller's precondition re-proofs (E-04,
 * E-06), and `verify` — the stage that re-proves external state — demands
 * the `tag` boundary behind it. Guard failures classify in outcome.ts;
 * this module is the table they read.
 */
import { CANONICAL_STAGES, type StepKey } from "./types.js";

export { CANONICAL_STAGES, type StepKey, type StepState } from "./types.js";

/** The mutating stages (§2.9): `prepare`, `commit`, `tag`, `publish` —
 * each requires a held, verified claim in its guard list; running one
 * without is `refused(mutation-without-claim)`, a record, never an
 * execution. */
export const MUTATING_STAGES: readonly StepKey[] = ["prepare", "commit", "tag", "publish"];

/** The sequence as a plain readonly view — the tuple in types.ts stays
 * literal so `StepKey` derives from it; `indexOf`/`includes` need the
 * widened form. */
const STAGE_SEQUENCE: readonly StepKey[] = CANONICAL_STAGES;

/** The guard table's row test (§2.9): does the stage demand a held, verified
 * claim? True for the mutating stages and for `claim` itself — the stage
 * that records the acquisition it must already have (§2.4: acquire, then
 * record). */
export const requiresHeldClaim = (stepKey: StepKey): boolean =>
  stepKey === "claim" || MUTATING_STAGES.includes(stepKey);

/** The stage's position in the canonical sequence; the closed order every
 * engine drives and every replay checks (§2.5). */
export const stageIndex = (stepKey: StepKey): number => STAGE_SEQUENCE.indexOf(stepKey);
