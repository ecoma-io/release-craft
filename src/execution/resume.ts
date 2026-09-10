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
import { effectiveSteps } from "./hooks.js";
import { isArtifactStepKey, isHookStepKey, isUpdaterStepKey } from "./step-keys.js";
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
 * E-02). Hooks ride the list at their anchors (ADR-0007 decision 6), and
 * artifact steps at theirs (ADR-0008 decision 10) — a resume may continue
 * at an extension step. */
const firstUncompleted = (attempt: ReleaseAttempt, ledger: ExecutionLedger): StepKey | null => {
  for (const step of effectiveSteps(attempt)) {
    if (ledger.step(attempt.attemptId, step) !== "completed") {
      return step;
    }
  }
  return null;
};

/** The ONE terminality classifier (#122): reads the tail once and answers
 * "is this attempt over?" from the recorded evidence alone — ADR-0013
 * decision 3's law, now applied at every classification door. A tail
 * carrying an abandonment is terminal from the ledger alone; the
 * process-local attempt value is §2.7 bookkeeping, never authority, so the
 * tail outranks it in BOTH directions — a terminal claim the tail cannot
 * confirm classifies as an open attempt, and a recorded abandonment the
 * value denies classifies as terminal. The read is a live read per call:
 * no snapshot is taken and nothing is cached across doors — the
 * identical-tails law (§2.3) classifies from the tail's own append-order
 * contents, and an abort appending between two calls yields two verdicts
 * over their own tails, never one verdict over a cached tail. The returned
 * tail is the SAME array the verdict was computed over, so the caller
 * threads one read through its whole classification (walk-tail-once-per-
 * tip, PR #140's discipline). */
export const readTailTerminality = (
  attempt: ReleaseAttempt,
  ledger: ExecutionLedger,
): {
  readonly tail: readonly LedgerRecord[];
  readonly abandonment?: LedgerRecord & { readonly kind: "abandonment" };
} => {
  const tail = ledger.tail(attempt.attemptId);
  const abandonment = tail.find(
    (record): record is LedgerRecord & { readonly kind: "abandonment" } =>
      record.kind === "abandonment",
  );
  return abandonment === undefined ? { tail } : { tail, abandonment };
};

/** Classifies a resume (§2.3, E-01, E-02, E-05) — the pure ledger-side
 * classification, distinct from attempt.ts's `resume` state-machine door.
 * The order is the contract's: a recorded abandonment is terminal from the
 * ledger alone (ADR-0013 decision 3 — the human abort's durable record
 * outranks whatever a process-local attempt value claims, E-09), and the
 * read is the ONE classifier's (`readTailTerminality` — the same call
 * `ledgerRequestStep` makes, same question, same answer, #122's one law).
 * The tail read once threads through the whole classification: the
 * structural pass and the blocked-attempt resolution walk the same array —
 * one live read per call, no snapshot taken across calls (an abort
 * appending between two calls yields two verdicts over their own tails).
 * The process-local attempt value is bookkeeping, never authority: no
 * terminal-state gate stands here — a terminal claim the tail cannot
 * confirm classifies by the tail's own evidence (ADR-0013 decision 3's
 * both-directions law; the state machine's own terminal guard lives at
 * attempt.ts's throwing doors and the kernel's `requestStep`). The
 * recorded plan fingerprint is §2.2's equality-proof half and resume
 * refuses without it; a mismatch with the attempt's carried fingerprint is
 * `stale` (E-05 — refuse, record, re-plan through the planner's door, never
 * continue); a completed step with no preceding `started` for the same
 * stepKey is structurally corrupt; a failed stage is classifyCrash's
 * territory (§2.4); a `blocked` attempt re-arms only over a recorded
 * resolution (§2.7's resolveBlocked door, E-04). Otherwise the verdict
 * continues at the first stage not completed, or completes: every stage
 * completed means the attempt is done, and its terminal outcome follows
 * the recorded steps — `satisfied-externally` when the ledger's external
 * view recorded an observed satisfaction for any of the attempt's stages
 * (E-03's ledger-first done-ness), `published` otherwise. */
export const classifyResume = (attempt: ReleaseAttempt, ledger: ExecutionLedger): ResumeOutcome => {
  const { tail, abandonment } = readTailTerminality(attempt, ledger);
  if (abandonment !== undefined) {
    throw new InvalidExecutionTransitionError(
      `the recorded tail carries an abandonment attributed to ${abandonment.attribution.actor} ` +
        `("${abandonment.reason}") — the human abort is terminal from the ledger alone; no ` +
        `later classification revives it (E-09; ADR-0013 decision 3)`,
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
  for (const [at, record] of tail.entries()) {
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
      // A failed hook or artifact record is classified, not crashed
      // (phase 6 contract §2.5; ADR-0007 decision 8; phase 7 contract
      // §2.5: an artifact failure "classifies exactly as a hook's does",
      // ADR-0008 decision 8). The scheduler appended it together with the
      // blocked(validation) attempt, and §2.7's resolution loop answers
      // it. The same record under a non-blocked attempt is a tail
      // contradiction — recorded state a human must judge.
      if (
        isHookStepKey(step.stepKey) ||
        isArtifactStepKey(step.stepKey) ||
        isUpdaterStepKey(step.stepKey)
      ) {
        // A failed extension-step record is classified, not crashed.
        // Blocked now: the §2.7 loop answers below. Re-armed already: the
        // append-only failed record never leaves the tail, so its
        // recovery is the later resolution record for the same key —
        // anything else is a tail contradiction a human must judge.
        if (attempt.state !== "blocked") {
          const resolved = tail
            .slice(at + 1)
            .some((later) => later.kind === "resolution" && later.stepKey === step.stepKey);
          if (!resolved) {
            return {
              kind: "escalate",
              detail: `extension step ${step.stepKey} recorded failed without a blocked attempt or a closing resolution — the §2.5 escalation lives in the attempt's state, and this tail contradicts it (§2.3)`,
            };
          }
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
    const resolution = tail
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
 * twin Phase 6+ consumes.
 *
 * The terminality check is the ONE classifier's (`readTailTerminality` —
 * the same call `classifyResume` makes, same question, same answer, #122's
 * one law): the recorded tail outranks the process-local attempt value in
 * BOTH directions — an abandonment the tail records refuses even when a
 * stale value claims open, and the refusal quotes the recorded actor and
 * reason (ADR-0013 decision 3). The process-local `isTerminalAttempt`
 * gate remains as the door's own refusal for a state the tail has not
 * answered for — a programming-error guard that keeps the kernel's
 * throwing path unreachable from here (no exception crosses the record
 * path). A non-terminal attempt delegates to the kernel's classification
 * over the ledger's step view, unmodified. */
export const ledgerRequestStep = (
  attempt: ReleaseAttempt,
  request: StepRequest,
  claims: ClaimView,
  ledger: ExecutionLedger,
): RequestStepOutcome => {
  const { abandonment } = readTailTerminality(attempt, ledger);
  if (abandonment !== undefined) {
    return {
      kind: "refused",
      stepKey: request.stepKey,
      detail:
        `the recorded tail carries an abandonment attributed to ${abandonment.attribution.actor} ` +
        `("${abandonment.reason}") — terminal from the ledger alone (the record-path replay ` +
        `door, phase 5 contract §2.8; ADR-0013 decision 3)`,
    };
  }
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
