/**
 * The revalidation record (phase 5 contract §2.7; ADR-0006 decision 9) —
 * the door that closes the blocked loop (E-04). A `blocked(cause)` attempt
 * re-arms for resume only over a recorded resolution: a revalidation naming
 * the plan fingerprint re-proven under the stored plan (the validate re-run
 * proves the attempt's carried plan; a changed plan is a new attempt, not a
 * resolution — E-05), or a human resolution recorded verbatim for E-06's
 * `unattributed-state` path, attribution included. The ledger never
 * auto-resolves (§3): the resolution exists as an appended, attributed,
 * frozen record — the only thing `resume` accepts as re-arming a blocked
 * attempt — or the attempt stays blocked.
 */
import { InvalidExecutionTransitionError } from "./attempt.js";
import {
  type Attribution,
  type BlockedResolution,
  type ExecutionLedger,
  type LedgerRecord,
  type ReleaseAttempt,
  type StepKey,
} from "./types.js";

/** Mirrors attempt.ts's blank-value guard verbatim — same error, same
 * message shape — because a resolution record with a blank actor would be
 * an unattributed event on the durable tail (E-09: human actions are
 * attributed events). */
const nonEmpty = (value: string, what: string): string => {
  if (value.length === 0) {
    throw new InvalidExecutionTransitionError(`${what} must be a non-empty recorded value`);
  }
  return value;
};

/** Appends the resolution record that re-arms a `blocked(cause)` attempt
 * (§2.7, E-04) and returns the stored, frozen record. A revalidation must
 * re-prove the attempt's STORED plan fingerprint — a different fingerprint
 * means the plan changed, which is a new attempt through the planner's door
 * (E-05, PL-08), never a resolution. The step key names the step the
 * attempt blocked on; the attribution (a human actor for the
 * `unattributed-state` path) is carried verbatim — the record is the
 * attributed event, and nothing here infers or rewrites it. */
export const resolveBlocked = (
  attempt: ReleaseAttempt,
  stepKey: StepKey,
  resolution: BlockedResolution,
  ledger: ExecutionLedger,
  attribution: Attribution,
): LedgerRecord => {
  nonEmpty(attribution.actor, "attribution actor");
  if (attempt.state !== "blocked") {
    throw new InvalidExecutionTransitionError(
      `resolveBlocked demands a blocked attempt, got ${attempt.state}`,
    );
  }
  if (
    resolution.kind === "revalidation" &&
    resolution.planFingerprint !== attempt.planFingerprint
  ) {
    throw new InvalidExecutionTransitionError(
      `revalidation re-proves the stored plan ${attempt.planFingerprint}, not ${resolution.planFingerprint} — a changed plan is a new attempt (E-05)`,
    );
  }
  return ledger.append({
    kind: "resolution",
    attemptId: attempt.attemptId,
    stepKey,
    resolution,
    attribution,
  });
};
