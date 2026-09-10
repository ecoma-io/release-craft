/**
 * Hooks as steps (phase 6 contract §2; ADR-0007): the declared hook values
 * ride the attempt; this module names the insertion rules — the effective
 * step list — and drives the scheduler that walks it in order. Canonical
 * stages behave exactly as the kernel and ledger already classify them;
 * at a hook step the scheduler runs the kernel's one aggregate guard
 * check, appends the write-ahead start, invokes the caller-injected effect
 * at the seam, and records the outcome — completion with its proof, or
 * the §2.5 fail-closed escalation. The engine never stores or invents user
 * code: effects arrive per declaration from the caller (`effects`), and
 * the returned attempt is a successor value — nothing here mutates.
 *
 * Pure values only: no clock, randomness, environment, filesystem, or
 * network reads (§2.10; ADR-0007 decision 10). Determinism holds —
 * identical declarations, ledgers, claims, and effects classify
 * identically, provable by double-run.
 */
import { block, InvalidExecutionTransitionError } from "./attempt.js";
import { CANONICAL_STAGES } from "./types.js";
import {
  type ArtifactStep,
  type Attribution,
  type ClaimView,
  type ExecutionLedger,
  type HookEffect,
  type HookOutcome,
  type HookStep,
  type HooksRun,
  type LedgerRecord,
  type ReleaseAttempt,
  type StageKey,
  type StepKey,
  type TransitionRecord,
} from "./types.js";
import { artifactStepKey, hookStepKey, isHookStepKey } from "./step-keys.js";

/** The attempt's effective step list (§2.1; ADR-0007 decision 3 and
 * ADR-0008 decision 3): the canonical stages with each declared extension
 * step — hook or artifact — inserted at its anchor, before or after the
 * anchored stage. Ties inside one declaration list break in declaration
 * order; because hooks and artifact steps are two declaration lists, the
 * cross-kind tie is the named rule (amended into §2.1 and the ADR): at
 * the same anchor and position, hooks precede artifact steps — the older
 * extension landed first. The plan value and fingerprint are untouched:
 * this list is execution-side, derived from the attempt's declared
 * extensions. */
export const effectiveSteps = (attempt: ReleaseAttempt): readonly StepKey[] => {
  const hooks = attempt.hooks ?? [];
  const artifacts = attempt.artifacts ?? [];
  const anchoredHooks = (stage: StageKey, position: "before" | "after"): readonly HookStep[] =>
    hooks.filter((hook) => hook.anchor.stage === stage && hook.anchor.position === position);
  const anchoredArtifacts = (
    stage: StageKey,
    position: "before" | "after",
  ): readonly ArtifactStep[] =>
    artifacts.filter(
      (artifact) => artifact.anchor.stage === stage && artifact.anchor.position === position,
    );
  const steps: StepKey[] = [];
  for (const stage of CANONICAL_STAGES) {
    for (const hook of anchoredHooks(stage, "before")) {
      steps.push(hookStepKey(hook.id));
    }
    for (const artifact of anchoredArtifacts(stage, "before")) {
      steps.push(artifactStepKey(artifact.id));
    }
    steps.push(stage);
    for (const hook of anchoredHooks(stage, "after")) {
      steps.push(hookStepKey(hook.id));
    }
    for (const artifact of anchoredArtifacts(stage, "after")) {
      steps.push(artifactStepKey(artifact.id));
    }
  }
  return steps;
};

/** The appended record's narrowing — `append` returns the frozen
 * `LedgerRecord`; a step write that came back anything but a step record
 * would be the ledger contradicting itself. The `channel-transition` record
 * kind also carries a `record` payload, so the narrow must discriminate
 * on the full `LedgerRecord` union — never a structural `kind` + `record`
 * intersection that would conflate the two. */
const stepRecord = (appended: LedgerRecord): TransitionRecord => {
  if (appended.kind !== "step") {
    throw new Error("the ledger appended a hook record it cannot read back as a step record");
  }
  return appended.record;
};

/** Drives the attempt's declared hooks in effective-list order (§2.2;
 * ADR-0007 decisions 4–9). Returns the successor attempt — blocked after
 * a §2.5 escalation, otherwise the input — and the outcomes recorded so
 * far; the walk stops at the first refusal or escalation (ordered
 * execution). A completed hook is never re-executed: the ledger
 * projection answers, and the outcome carries the stored proof (decision
 * 6). The engine executes nothing but the caller-injected effects at the
 * seam (decision 2). */
export const scheduleHooks = (
  attempt: ReleaseAttempt,
  attribution: Attribution,
  ledger: ExecutionLedger,
  claims: ClaimView,
  effects: ReadonlyMap<string, HookEffect>,
): HooksRun => {
  if (attempt.state !== "executing") {
    throw new InvalidExecutionTransitionError(
      `scheduleHooks drives an executing attempt, got ${attempt.state} — hooks run inside the kernel's doors, not beside them`,
    );
  }
  const outcomes: HookOutcome[] = [];
  for (const step of effectiveSteps(attempt)) {
    if (!isHookStepKey(step)) {
      continue;
    }
    const hook = (attempt.hooks ?? []).find((declared) => hookStepKey(declared.id) === step);
    if (hook === undefined) {
      throw new InvalidExecutionTransitionError(
        `no declared hook answers the recorded key ${step} (contract §2.1)`,
      );
    }
    // Replay (§2.2) first: the ledger projection answers, the effect
    // never re-runs to obtain a proof to compare — a completed hook
    // replays even when the effects map carries no entry.
    if (ledger.step(attempt.attemptId, step) === "completed") {
      // Content reconciliation on replay (§2.2): completion records whose
      // recorded fingerprints disagree are a conflict — E-02's
      // done-vs-conflict, refused, never a silent pass (the artifacts
      // path's digest reconciliation, parity for hooks).
      const recordedFingerprints = new Set(
        ledger
          .tail(attempt.attemptId)
          .flatMap((appended) => (appended.kind === "step" ? [appended.record] : []))
          .filter((record) => record.stepKey === step && record.to === "completed")
          .flatMap((record) =>
            record.contentFingerprint === undefined ? [] : [record.contentFingerprint],
          ),
      );
      if (recordedFingerprints.size > 1) {
        outcomes.push({
          kind: "refused",
          stepKey: step,
          hookId: hook.id,
          detail: `content-fingerprint-conflict: the completion records disagree on "${hook.id}"'s content (contract §2.2)`,
        });
        break;
      }
      const completed = ledger.stepView().completed(attempt.attemptId, step);
      if (completed === null) {
        throw new Error("the ledger reported the hook completed but lost its record");
      }
      outcomes.push({
        kind: "completed",
        stepKey: step,
        hookId: hook.id,
        record: completed,
        ...(completed.recordedAt === undefined ? {} : { recordedAt: completed.recordedAt }),
      });
      continue;
    }
    const effect = effects.get(hook.id);
    if (effect === undefined) {
      throw new InvalidExecutionTransitionError(
        `no effect injected for the declared hook "${hook.id}" — the engine never invents user code (ADR-0007 decision 2)`,
      );
    }
    // The one aggregate guard check (ADR-0007 decision 4): the attempt
    // holds its claim and the store verifies the token — scope-agnostic,
    // because the ClaimView port exposes exactly one held claim.
    const held = claims.held;
    const verified =
      held !== null && held.holder === attempt.attemptId && claims.verify(held.token);
    if (!verified) {
      // The kernel's recorded refusal — the same shape a mutating stage
      // without its claim takes (§2.5). No record; the caller retries.
      outcomes.push({
        kind: "refused",
        stepKey: step,
        hookId: hook.id,
        detail: "mutation-without-claim",
      });
      break;
    }
    // Write-ahead start (ADR-0006 decision 2): the declared guard name,
    // verbatim, durable before the effect may run.
    ledger.appendStart(attempt, step, attribution, undefined, hook.guard);
    // The seam (ADR-0007 decision 2): the effect runs; the engine records
    // what it returns. Nothing else is executed or stored.
    const observation = effect({
      attemptId: attempt.attemptId,
      hookId: hook.id,
      stage: hook.anchor.stage,
    });
    const guards = [{ guard: hook.guard, passed: true }];
    const completionRecord: Omit<TransitionRecord, "to"> = {
      attemptId: attempt.attemptId,
      stepKey: step,
      from: "started",
      guards,
      attribution: observation.attribution,
      ...(observation.evidence === undefined ? {} : { evidence: observation.evidence }),
      ...(observation.contentFingerprint === undefined
        ? {}
        : { contentFingerprint: observation.contentFingerprint }),
      ...(observation.recordedAt === undefined ? {} : { recordedAt: observation.recordedAt }),
    };
    // Postconditions as recorded proofs (ADR-0007 decision 5): the check
    // runs before the completion record exists, and the proof lands on it.
    const unmet = hook.postconditions.filter(
      (kind) =>
        (kind === "content-fingerprint-present" && observation.contentFingerprint === undefined) ||
        (kind === "evidence-present" &&
          (observation.evidence === undefined || observation.evidence.length === 0)),
    );
    const firstUnmet = unmet[0];
    if (firstUnmet !== undefined) {
      const appended = ledger.append({
        kind: "step",
        record: { ...completionRecord, to: "failed" },
      });
      const blocked = block(attempt, `validation:hook:${hook.id}:${firstUnmet}`);
      outcomes.push({
        kind: "failed",
        stepKey: step,
        hookId: hook.id,
        detail: `postcondition "${firstUnmet}" unmet (contract §2.5)`,
        record: stepRecord(appended),
      });
      return { attempt: blocked, outcomes };
    }
    const appended = ledger.append({
      kind: "step",
      record: { ...completionRecord, to: "completed" },
    });
    outcomes.push({
      kind: "completed",
      stepKey: step,
      hookId: hook.id,
      record: stepRecord(appended),
      ...(observation.recordedAt === undefined ? {} : { recordedAt: observation.recordedAt }),
    });
  }
  return { attempt, outcomes };
};
