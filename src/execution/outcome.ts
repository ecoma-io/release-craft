/**
 * `requestStep` — the pure transition planner of the execution kernel
 * (contract §2.7; ADR-0005 decisions 3, 7, 8). Its inputs are exactly the
 * attempt state, the claim view, the step record view, and the requested
 * step; its output is exactly one of the seven outcomes, never an effect —
 * the engine appends the carried record, the ledger persists (§1's split:
 * negative outcomes are records; contract violations throw).
 *
 * Classification order, each rule sourced:
 *  1. Terminal attempt → throw (§2.2: terminal is terminal; ADR-0005
 *     decision 3 makes `requestStep` on a terminal attempt a thrown
 *     violation — the record-path terminal refusal the contract also names
 *     is Phase 5's replay door, which fills the ledger's own history).
 *  2. Non-executing attempt → throw: no stage runs before `start` or while
 *     suspended (`blocked` resumes first — §2.2).
 *  3. External satisfaction (E-03) → `satisfied-externally` when the
 *     recorded evidence is consistent with the request (fingerprints agree,
 *     or neither side recorded one to contradict), `conflict` when they
 *     disagree or one side alone recorded one — partial evidence conflicts
 *     (§2.7), never a silent proceed.
 *  4. Completed step (invariant 12) → `noop` only when identity and content
 *     are both proven — both fingerprints present and equal; `conflict`
 *     otherwise. Replay proceeds on proof, never on an unjudgeable match.
 *  5. Out-of-sequence stage → throw (fixture 5: a step out of sequence is a
 *     programming error, like tag-before-claim).
 *  6. Guards (§2.9's table, step.ts) → `refused(mutation-without-claim)`,
 *     `claim-lost`, or `blocked(cause)`; anything that passes advances with
 *     its guard list recorded.
 *
 * Deterministic: same inputs → same outcome, byte-for-byte (fixture 7).
 * Nothing here reads a clock, an environment variable, or a store —
 * timestamps and evidence arrive on the request (§2.10, §2.11).
 */
import { InvalidExecutionTransitionError } from "./attempt.js";
import { CANONICAL_STAGES, requiresHeldClaim, stageIndex, type StageKey } from "./step.js";
import {
  isTerminalAttempt,
  type ClaimToken,
  type ClaimView,
  type ExternalSatisfaction,
  type GuardResult,
  type PreconditionObservation,
  type ReleaseAttempt,
  type RequestStepOutcome,
  type StepRecordsView,
  type StepRequest,
  type StepState,
  type TransitionRecord,
} from "./types.js";

/** Fingerprint agreement for external evidence: both present and equal, or
 * both absent — nothing contradicts the observation (§2.7: conflict is for
 * disagreement or partial evidence). */
const evidenceAgrees = (recorded: string | undefined, requested: string | undefined): boolean => {
  if (recorded === undefined || requested === undefined) {
    return recorded === undefined && requested === undefined;
  }
  return recorded === requested;
};

/** Content proven equal for replay: both fingerprints present and equal —
 * an unjudgeable match conflicts (invariant 12's same-identity-and-content,
 * proven not assumed). */
const contentProven = (recorded: string | undefined, requested: string | undefined): boolean =>
  recorded !== undefined && requested !== undefined && recorded === requested;

/** The first uncompleted stage's index — the sequence position every
 * request is checked against (§2.5). */
const nextStageIndex = (attemptId: string, steps: StepRecordsView): number => {
  let index = 0;
  for (const stage of CANONICAL_STAGES) {
    if (steps.completed(attemptId, stage) !== null) {
      index += 1;
    }
  }
  return index;
};

/** The verify stage's belt-and-suspenders precondition (§2.9): the tag
 * boundary stands. By sequence `verify` is last, so this is provably true
 * through the door — the guard pins the invariant anyway. */
const tagBoundaryStands = (attemptId: string, steps: StepRecordsView): boolean =>
  steps.completed(attemptId, "tag") !== null || steps.completed(attemptId, "publish") !== null;

/** The guard rows an advancing record carries (§2.6: "what was checked,
 * with results"). Optional details are omitted, never `undefined`-filled. */
const guardList = (
  stepKey: StageKey,
  claimToken: ClaimToken | null,
  preconditions: readonly PreconditionObservation[],
  tagBoundary: boolean,
): readonly GuardResult[] => {
  const guards: GuardResult[] = [];
  if (stepKey === "claim") {
    guards.push({ guard: "claim-held", passed: claimToken !== null });
  }
  if (stepKey !== "claim" && requiresHeldClaim(stepKey)) {
    guards.push({ guard: "claim-held", passed: claimToken !== null });
    guards.push({
      guard: "claim-verified",
      passed: true,
      detail: "token re-verified against the store immediately before this record",
    });
  }
  if (stepKey === "validate") {
    for (const observation of preconditions) {
      guards.push(
        observation.cause === undefined || observation.holds
          ? { guard: `precondition:${observation.precondition}`, passed: observation.holds }
          : {
              guard: `precondition:${observation.precondition}`,
              passed: false,
              detail: observation.cause,
            },
      );
    }
  }
  if (stepKey === "verify") {
    guards.push({
      guard: "tag-boundary",
      passed: tagBoundary,
      detail: "re-proving external state demands the tag boundary behind it (§2.9)",
    });
  }
  return guards;
};

/** Builds the advance record (§2.6): frozen shape, optional fields omitted —
 * never `undefined`-filled. */
const buildAdvanceRecord = (
  attemptId: string,
  request: StepRequest,
  token: ClaimToken | null,
  guards: readonly GuardResult[],
  from: StepState,
): TransitionRecord => {
  let record: TransitionRecord = {
    attemptId,
    stepKey: request.stepKey,
    from,
    to: "completed",
    guards,
    attribution: request.attribution,
  };
  if (token !== null && requiresHeldClaim(request.stepKey)) {
    record = { ...record, claim: token };
  }
  if (request.evidence !== undefined) {
    record = { ...record, evidence: request.evidence };
  }
  if (request.recordedAt !== undefined) {
    record = { ...record, recordedAt: request.recordedAt };
  }
  if (request.contentFingerprint !== undefined) {
    record = { ...record, contentFingerprint: request.contentFingerprint };
  }
  return record;
};

/** `requestStep` (§2.7): classifies the requested step against the attempt,
 * the claim view, and the step records — pure, total, deterministic. */
export const requestStep = (
  attempt: ReleaseAttempt,
  request: StepRequest,
  claims: ClaimView,
  steps: StepRecordsView,
): RequestStepOutcome => {
  // 0. Request shape (§2.6): the actor is an opaque non-empty string —
  //    attribution is an event's identity, and a blank one is a caller
  //    bug, not a classification.
  if (request.attribution.actor.length === 0) {
    throw new InvalidExecutionTransitionError(
      "step request carries an empty actor — attribution is §2.6's non-empty identity",
    );
  }
  // 1. Terminal is terminal — thrown contract violation (§2.2, D3).
  if (isTerminalAttempt(attempt.state)) {
    throw new InvalidExecutionTransitionError(
      `step ${request.stepKey} on a terminal attempt (${attempt.state}) — terminal is terminal`,
    );
  }
  // 2. Only an executing attempt runs stages (§2.2: start before steps,
  //    resume before continuing a suspended one).
  if (attempt.state !== "executing") {
    throw new InvalidExecutionTransitionError(
      `step ${request.stepKey} on a ${attempt.state} attempt — start or resume first`,
    );
  }
  const completed = steps.completed(attempt.attemptId, request.stepKey);

  // 3. External satisfaction (E-03): ledger-first done-ness. Consistency
  //    over fingerprints, fail-closed on disagreement or partial evidence.
  const external: ExternalSatisfaction | null = steps.external(attempt.attemptId, request.stepKey);
  if (external !== null) {
    if (evidenceAgrees(external.contentFingerprint, request.contentFingerprint)) {
      return { kind: "satisfied-externally", stepKey: request.stepKey };
    }
    return {
      kind: "conflict",
      stepKey: request.stepKey,
      detail:
        "external evidence inconsistent with the request (E-03: a different commit, or partial evidence)",
    };
  }

  // 4. Replay of a completed step (invariant 12): proven same content →
  //    noop; anything unjudgeable or different → conflict, never a silent
  //    re-run.
  if (completed !== null) {
    if (contentProven(completed.contentFingerprint, request.contentFingerprint)) {
      return { kind: "noop", stepKey: request.stepKey };
    }
    return {
      kind: "conflict",
      stepKey: request.stepKey,
      detail:
        "completed step's content not proven equal — refusing the silent re-run (invariant 12)",
    };
  }

  // 5. Sequence: the requested stage must be exactly the next uncompleted
  //    one (§2.5; fixture 5 throws on out-of-sequence steps).
  const next = nextStageIndex(attempt.attemptId, steps);
  if (stageIndex(request.stepKey) !== next) {
    throw new InvalidExecutionTransitionError(
      `step ${request.stepKey} is out of sequence — the next stage is ${
        CANONICAL_STAGES[next] ?? "unknown"
      }`,
    );
  }

  // 6. Guards (§2.9's table).
  const token = claims.held?.token ?? null;
  if (requiresHeldClaim(request.stepKey)) {
    // The claim stage records the acquisition it must already have (§2.4:
    // acquire, then record) — no held claim, nothing to record; the
    // mutating stages demand the held claim outright.
    if (token === null) {
      return { kind: "refused", stepKey: request.stepKey, detail: "mutation-without-claim" };
    }
    if (request.stepKey !== "claim" && !claims.verify(token)) {
      // The guard re-verifies the token against the store's current state
      // before every write (E-07) — a lost claim is the loser path, a
      // record the engine abandons on (§2.4).
      return {
        kind: "claim-lost",
        stepKey: request.stepKey,
        detail: "the held claim no longer verifies — the loser path (§2.4)",
      };
    }
  }
  if (request.stepKey === "validate") {
    // `validate` re-proves the plan's preconditions (E-04, E-06): any
    // failed observation suspends the attempt — blocked(cause), the cause
    // recorded verbatim, nothing consumed.
    const failed = (request.preconditions ?? []).find((observation) => !observation.holds);
    if (failed !== undefined) {
      return {
        kind: "blocked",
        stepKey: request.stepKey,
        cause: failed.cause ?? "precondition-delta",
      };
    }
  }
  if (request.stepKey === "verify" && !tagBoundaryStands(attempt.attemptId, steps)) {
    return { kind: "refused", stepKey: request.stepKey, detail: "mutation-without-claim" };
  }

  // 7. Advance: the record to append — from the step's current recorded
  //    state to `completed`, guards listed, attribution carried.
  const record = buildAdvanceRecord(
    attempt.attemptId,
    request,
    token,
    guardList(
      request.stepKey,
      token,
      request.preconditions ?? [],
      tagBoundaryStands(attempt.attemptId, steps),
    ),
    steps.state(attempt.attemptId, request.stepKey),
  );
  return { kind: "advance", record };
};
