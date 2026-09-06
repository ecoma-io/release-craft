import { describe, expect, it } from "vitest";

import {
  InvalidExecutionTransitionError,
  MemoryAttemptRegister,
  MemoryClaimStore,
  MemoryTransitionLog,
  openAttempt,
  requestStep,
  start,
  type ReleaseAttempt,
  type RequestStepOutcome,
  type StageKey,
  type StepRequest,
} from "../../src/index.js";

const open = (): ReleaseAttempt =>
  start(
    openAttempt(new MemoryAttemptRegister(), {
      planId: "plan-alpha",
      planFingerprint: "plan_sha256:alpha",
    }),
  );

const SCOPE = { kind: "stable-version", lineId: "line-main", version: "1.2.0" } as const;

/** Runs one stage against the live store and log, appending the carried
 * record on advance — the same engine loop the fixture suites use. */
const run = (
  attempt: ReleaseAttempt,
  stepKey: StageKey,
  store: MemoryClaimStore,
  log: MemoryTransitionLog,
  fingerprint?: string,
): RequestStepOutcome => {
  const request: StepRequest = {
    stepKey,
    attribution: { attemptId: attempt.attemptId, actor: "automation" },
    contentFingerprint: fingerprint ?? `content:${stepKey}:${attempt.attemptId}`,
  };
  const outcome = requestStep(attempt, request, store.viewFor(attempt.attemptId), log.stepView());
  if (outcome.kind === "advance") {
    log.append(outcome.record);
  }
  return outcome;
};

/** An executing attempt with plan completed and ownership held — the
 * prefix the replay classifications build on. */
const withCompletedPlan = (store: MemoryClaimStore, log: MemoryTransitionLog) => {
  const attempt = open();
  store.acquire(SCOPE, attempt.attemptId);
  expect(run(attempt, "plan", store, log).kind).toBe("advance");
  expect(run(attempt, "claim", store, log).kind).toBe("advance");
  return attempt;
};

describe("the outcome classification (E-03, §2.7 fingerprint laws)", () => {
  it("replays a completed step to noop when content is proven equal", () => {
    const store = new MemoryClaimStore();
    const log = new MemoryTransitionLog();
    const attempt = withCompletedPlan(store, log);

    const outcome = requestStep(
      attempt,
      {
        stepKey: "plan",
        attribution: { attemptId: attempt.attemptId, actor: "automation" },
        contentFingerprint: `content:plan:${attempt.attemptId}`,
      },
      store.viewFor(attempt.attemptId),
      log.stepView(),
    );
    expect(outcome).toEqual({ kind: "noop", stepKey: "plan" });
  });

  it("refuses a silent re-run when content is not proven (invariant 12)", () => {
    const store = new MemoryClaimStore();
    const log = new MemoryTransitionLog();
    const attempt = withCompletedPlan(store, log);

    const differing = requestStep(
      attempt,
      {
        stepKey: "plan",
        attribution: { attemptId: attempt.attemptId, actor: "automation" },
        contentFingerprint: "content:plan:rewritten",
      },
      store.viewFor(attempt.attemptId),
      log.stepView(),
    );
    expect(differing).toEqual({
      kind: "conflict",
      stepKey: "plan",
      detail:
        "completed step's content not proven equal — refusing the silent re-run (invariant 12)",
    });

    // A completed record without a request fingerprint is unjudgeable —
    // conflict, fail-closed (contentProven demands both sides present).
    const missing = requestStep(
      attempt,
      {
        stepKey: "plan",
        attribution: { attemptId: attempt.attemptId, actor: "automation" },
      },
      store.viewFor(attempt.attemptId),
      log.stepView(),
    );
    expect(missing.kind).toBe("conflict");
  });

  it("accepts an externally satisfied step when the evidence agrees (E-03)", () => {
    const store = new MemoryClaimStore();
    const log = new MemoryTransitionLog();
    const attempt = withCompletedPlan(store, log);
    log.noteExternal({
      attemptId: attempt.attemptId,
      stepKey: "prepare",
      attribution: { attemptId: attempt.attemptId, actor: "human:maintainer" },
      evidence: "evidence:git:abc123",
      contentFingerprint: "content:prepare:external",
    });

    const outcome = run(attempt, "prepare", store, log, "content:prepare:external");
    expect(outcome).toEqual({ kind: "satisfied-externally", stepKey: "prepare" });
  });

  it("accepts an external satisfaction with no fingerprint on either side", () => {
    const store = new MemoryClaimStore();
    const log = new MemoryTransitionLog();
    const attempt = withCompletedPlan(store, log);
    log.noteExternal({
      attemptId: attempt.attemptId,
      stepKey: "prepare",
      attribution: { attemptId: attempt.attemptId, actor: "human:maintainer" },
      evidence: "evidence:git:abc123",
    });
    const outcome = requestStep(
      attempt,
      {
        stepKey: "prepare",
        attribution: { attemptId: attempt.attemptId, actor: "automation" },
      },
      store.viewFor(attempt.attemptId),
      log.stepView(),
    );
    expect(outcome).toEqual({ kind: "satisfied-externally", stepKey: "prepare" });
  });

  it("conflicts on external evidence that disagrees or is partial (E-03)", () => {
    const store = new MemoryClaimStore();
    const log = new MemoryTransitionLog();
    const attempt = withCompletedPlan(store, log);
    log.noteExternal({
      attemptId: attempt.attemptId,
      stepKey: "prepare",
      attribution: { attemptId: attempt.attemptId, actor: "human:maintainer" },
      evidence: "evidence:git:abc123",
      contentFingerprint: "content:prepare:external",
    });

    const disagreeing = run(attempt, "prepare", store, log, "content:prepare:rewritten");
    expect(disagreeing).toEqual({
      kind: "conflict",
      stepKey: "prepare",
      detail:
        "external evidence inconsistent with the request (E-03: a different commit, or partial evidence)",
    });
  });

  it("throws on a blank actor — attribution is §2.6's non-empty identity", () => {
    const store = new MemoryClaimStore();
    const log = new MemoryTransitionLog();
    const attempt = withCompletedPlan(store, log);
    expect(() =>
      requestStep(
        attempt,
        {
          stepKey: "prepare",
          attribution: { attemptId: attempt.attemptId, actor: "" },
        },
        store.viewFor(attempt.attemptId),
        log.stepView(),
      ),
    ).toThrow(InvalidExecutionTransitionError);
  });
});
