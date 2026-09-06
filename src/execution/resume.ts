/**
 * The ledger's pure classifications (phase 5 contract §2.3, §2.4, §2.8;
 * ADR-0006 decisions 3–5, 10): `classifyResume` reads the recorded tail and
 * returns one of exactly four outcomes; `classifyCrash` applies E-01's
 * doctrine to a `failed(unknown)` attempt; `ledgerRequestStep` is the
 * record-path replay door. All three are the ledger-side classifications —
 * distinct from attempt.ts's state-machine doors (`resume`/`crashClassify`
 * there move the attempt along an edge and throw on every impossible
 * request; the functions here classify over records and return values a
 * human can read, never moving anything). Classification is pure over
 * recorded values: identical tails classify identically (§2.3), provable by
 * double-run. Nothing here re-plans, retries, or executes — §1's
 * no-silent-failure law; no clock, randomness, or environment reads.
 */
import { InvalidExecutionTransitionError } from "./attempt.js";
import { effectiveSteps, isHookStepKey } from "./hooks.js";
import { requestStep } from "./outcome.js";
import {
  CANONICAL_STAGES,
  isTerminalAttempt,
  type ClaimView,
  type CrashVerdict,
  type ExecutionLedger,
  type ExternalSatisfaction,
  type ReleaseAttempt,
  type LedgerRecord,
  type RequestStepOutcome,
  type ResumeOutcome,
  type StepKey,
  type StepRequest,
} from "./types.js";

/** The first step of the attempt's effective step list the ledger does not
 * record as completed (phase 6 contract §2.2) — §2.3's `from` and §2.4's
 * remaining-work pointer. Null when every step completed. A step's own
 * `started` state counts as uncompleted: a crash window between the
 * write-ahead record and the effect means the step must run again (E-01,
 * E-02). Hooks ride the list at their anchors (ADR-0007 decision 6) — a
 * resume may continue at a hook step. */
const firstUncompleted = (attempt: ReleaseAttempt, ledger: ExecutionLedger): StepKey | null => {
  for (const step of effectiveSteps(attempt)) {
    if (ledger.step(attempt.attemptId, step) !== "completed") {
      return step;
    }
  }
  return null;
};

/** Classifies a resume (§2.3, E-01, E-02, E-05) — the pure ledger-side
 * classification, distinct from attempt.ts's `resume` state-machine door.
 * The order is the contract's: a terminal attempt is a thrown protocol
 * violation (types.ts §2.2: terminal is terminal); the recorded plan
 * fingerprint is §2.2's equality-proof half and resume refuses without it;
 * a mismatch with the attempt's carried fingerprint is `stale` (E-05 —
 * refuse, record, re-plan through the planner's door, never continue); a
 * completed step with no preceding `started` for the same stepKey is
 * structurally corrupt; a failed stage is classifyCrash's territory
 * (§2.4); a `blocked` attempt re-arms only over a recorded resolution
 * (§2.7's resolveBlocked door, E-04). Otherwise the verdict continues at
 * the first stage not completed, or completes: every stage completed means
 * the attempt is done, and its terminal outcome follows the recorded steps
 * — `satisfied-externally` when the ledger's external view recorded an
 * observed satisfaction for any of the attempt's stages (E-03's
 * ledger-first done-ness), `published` otherwise. */
export const classifyResume = (attempt: ReleaseAttempt, ledger: ExecutionLedger): ResumeOutcome => {
  if (isTerminalAttempt(attempt.state)) {
    throw new InvalidExecutionTransitionError(
      `classifyResume on a terminal attempt (${attempt.state}) — terminal is terminal; classification is for open attempts`,
    );
  }
  const recorded = ledger.planFingerprint(attempt.attemptId);
  if (recorded === null) {
    return {
      kind: "escalate",
      detail:
        "no recorded plan fingerprint — the plan record is §2.2's recorded half of the equality proof; resume refuses without it",
    };
  }
  if (recorded !== attempt.planFingerprint) {
    return {
      kind: "stale",
      detail: `the attempt carries ${attempt.planFingerprint} but the ledger recorded ${recorded} — the equality proof (E-05) failed; refuse, record, re-plan through the planner's door (PL-08)`,
    };
  }
  // One structural pass over the tail, in append order: a completed record
  // demands a preceding `started` for the same stepKey, and a failed stage
  // hands the tail to crash classification (§2.4).
  const started = new Set<StepKey>();
  for (const record of ledger.tail(attempt.attemptId)) {
    if (record.kind !== "step") {
      continue;
    }
    const step = record.record;
    if (step.to === "completed" && !started.has(step.stepKey)) {
      return {
        kind: "escalate",
        detail: `a completed ${step.stepKey} record with no preceding started record — the tail is structurally corrupt, recorded state a human must judge (§2.3)`,
      };
    }
    if (step.to === "failed") {
      // A failed hook record is classified, not crashed (phase 6 contract
      // §2.5; ADR-0007 decision 8): the scheduler appended it together
      // with the blocked(validation) attempt, and §2.7's resolution loop
      // answers it. The same record under a non-blocked attempt is a tail
      // contradiction — recorded state a human must judge.
      if (isHookStepKey(step.stepKey)) {
        if (attempt.state !== "blocked") {
          return {
            kind: "escalate",
            detail: `hook ${step.stepKey} recorded failed without a blocked attempt — the §2.5 escalation lives in the attempt's state, and this tail contradicts it (§2.3)`,
          };
        }
        continue;
      }
      return {
        kind: "escalate",
        detail: `step ${step.stepKey} recorded failed — failed stages demand crash classification (§2.4, E-01); resume never guesses past them`,
      };
    }
    if (step.to === "started") {
      started.add(step.stepKey);
    }
  }
  if (attempt.state === "blocked") {
    // §2.7: a revalidation re-proves the stored plan — never a new one —
    // and a human resolution answers only an unattributed-state block.
    // The re-arm proof is the record's content, not its bare presence:
    // append is a public write, so a mis-typed resolution must fail
    // closed here, exactly as resolveBlocked refuses it at the door.
    const resolution = ledger
      .tail(attempt.attemptId)
      .filter(
        (record): record is LedgerRecord & { readonly kind: "resolution" } =>
          record.kind === "resolution",
      )
      .at(-1);
    if (resolution === undefined) {
      return {
        kind: "escalate",
        detail:
          "blocked without a recorded resolution — resolveBlocked is the only door that re-arms a blocked attempt (§2.7, E-04)",
      };
    }
    if (
      resolution.resolution.kind === "revalidation" &&
      resolution.resolution.planFingerprint !== attempt.planFingerprint
    ) {
      return {
        kind: "escalate",
        detail:
          "the recorded revalidation names a different plan than the stored one — recorded state a human must judge (§2.7, E-05)",
      };
    }
    if (resolution.resolution.kind === "human" && attempt.blockedCause !== "unattributed-state") {
      return {
        kind: "escalate",
        detail: "a human resolution re-arms only an unattributed-state block (§2.7, E-06)",
      };
    }
  }
  const from = firstUncompleted(attempt, ledger);
  if (from === null) {
    const external = ledger.stepView().external;
    const satisfiedExternally = CANONICAL_STAGES.some(
      (stage) => external(attempt.attemptId, stage) !== null,
    );
    return {
      kind: "complete",
      outcome: satisfiedExternally ? "satisfied-externally" : "published",
    };
  }
  return { kind: "resume", from };
};

/** Classifies a crash (§2.4, E-01; ADR-0006 decision 5) — the pure
 * ledger-side doctrine, distinct from attempt.ts's `crashClassify` (which
 * produces the `failed(unknown)` state this classifier consumes). The
 * input is the unclassified crash alone: `failed(unknown)`. The tag
 * boundary is present when the ledger recorded `tag` completed or the
 * caller observed it externally (`observedTag` — the same posture as
 * phase 4's `noteExternal`). The doctrine: tag + plan valid →
 * `complete-in-place`, resume semantics with the tag already satisfied,
 * the remaining stages finish; tag + plan invalid → `escalate`, because
 * delete-tag vs repair is a human decision that enters as a recorded
 * resolution, never an inference; no tag + plan valid → `resume` at the
 * first uncompleted stage; no tag + plan invalid → `void-and-skip`, the
 * recorded fallback when completion is unsafe and nothing durable was laid
 * down (the attempt ends `abandoned`, any observation lands in the
 * disposition registry, the line's next version computes normally —
 * nothing is deleted by classification). */
export const classifyCrash = (
  attempt: ReleaseAttempt,
  ledger: ExecutionLedger,
  options: { planValid: boolean; observedTag?: ExternalSatisfaction },
): CrashVerdict => {
  if (attempt.state !== "failed" || attempt.terminalReason !== "unknown") {
    throw new InvalidExecutionTransitionError(
      `classifyCrash classifies a failed(unknown) attempt (§2.4, E-01), got ${attempt.state}${
        attempt.terminalReason === undefined ? "" : ` (${attempt.terminalReason})`
      } — other ends already carry their recorded classification`,
    );
  }
  const tagPresent =
    ledger.step(attempt.attemptId, "tag") === "completed" || options.observedTag !== undefined;
  const from = firstUncompleted(attempt, ledger);
  if (from === null) {
    return {
      kind: "escalate",
      detail:
        "every stage recorded completed under a failed(unknown) attempt — the tail contradicts the state, recorded state a human must judge (§2.3)",
    };
  }
  if (tagPresent) {
    if (options.planValid) {
      return { kind: "complete-in-place", from };
    }
    return {
      kind: "escalate",
      detail:
        "tag recorded under a plan that no longer validates — human decision required; record it as a resolution (§2.4: delete-tag vs repair is never inferred)",
    };
  }
  if (options.planValid) {
    return { kind: "resume", from };
  }
  return { kind: "void-and-skip" };
};

/** The record-path replay door (§2.8, ADR-0006 decision 10): a step
 * request against a terminal attempt, arriving through the ledger's
 * classification surface, yields a recorded `refused` — phase 4 §2.7's
 * record-path promise. The kernel's own `requestStep` still throws on a
 * terminal attempt (§2.2's programming-error door); this is its durable
 * twin Phase 6+ consumes. A non-terminal attempt delegates to the kernel's
 * classification over the ledger's step view, unmodified. */
export const ledgerRequestStep = (
  attempt: ReleaseAttempt,
  request: StepRequest,
  claims: ClaimView,
  ledger: ExecutionLedger,
): RequestStepOutcome => {
  if (isTerminalAttempt(attempt.state)) {
    return {
      kind: "refused",
      stepKey: request.stepKey,
      detail:
        "terminal attempt — recorded refusal (the record-path replay door, phase 5 contract §2.8)",
    };
  }
  return requestStep(attempt, request, claims, ledger.stepView());
};
