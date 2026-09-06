import { describe, expect, it } from "vitest";

import {
  CANONICAL_STAGES,
  InvalidExecutionTransitionError,
  MemoryAttemptRegister,
  MemoryClaimStore,
  MemoryTransitionLog,
  openAttempt,
  requestStep,
  resume,
  start,
  transition,
  type ReleaseAttempt,
  type RequestStepOutcome,
  type StepKey,
} from "../../src/index.js";

const open = (): ReleaseAttempt =>
  start(
    openAttempt(new MemoryAttemptRegister(), {
      planId: "plan-alpha",
      planFingerprint: "plan_sha256:alpha",
    }),
  );

const run = (
  attempt: ReleaseAttempt,
  stepKey: StepKey,
  store: MemoryClaimStore,
  log: MemoryTransitionLog,
): RequestStepOutcome => {
  const outcome = requestStep(
    attempt,
    {
      stepKey,
      attribution: { attemptId: attempt.attemptId, actor: "automation" },
      contentFingerprint: `content:${stepKey}`,
    },
    store.viewFor(attempt.attemptId),
    log.stepView(),
  );
  if (outcome.kind === "advance") {
    log.append(outcome.record);
  }
  return outcome;
};

const drivenToPublished = (): ReleaseAttempt => {
  const attempt = open();
  const store = new MemoryClaimStore();
  const log = new MemoryTransitionLog();
  store.acquire(
    { kind: "stable-version", lineId: "line-main", version: "1.2.0" },
    attempt.attemptId,
  );
  for (const stage of CANONICAL_STAGES) {
    expect(run(attempt, stage, store, log).kind).toBe("advance");
  }
  return transition(attempt, "published");
};

describe("fixture 5 — invalid transitions throw the dedicated error", () => {
  it("throws on a step out of sequence (tag before its predecessors)", () => {
    const store = new MemoryClaimStore();
    const log = new MemoryTransitionLog();
    const attempt = open();
    expect(() => run(attempt, "tag", store, log)).toThrow(InvalidExecutionTransitionError);

    store.acquire(
      { kind: "stable-version", lineId: "line-main", version: "1.2.0" },
      attempt.attemptId,
    );
    expect(run(attempt, "plan", store, log).kind).toBe("advance");
    expect(run(attempt, "claim", store, log).kind).toBe("advance");
    expect(() => run(attempt, "publish", store, log)).toThrow(InvalidExecutionTransitionError);
  });

  it("throws on a step on a terminal attempt — via the throwing path", () => {
    const done = drivenToPublished();
    const store = new MemoryClaimStore();
    const log = new MemoryTransitionLog();
    // The throwing path itself: a step on a terminal attempt is a thrown
    // contract violation, not a classified outcome.
    expect(() =>
      requestStep(
        done,
        { stepKey: "verify", attribution: { attemptId: done.attemptId, actor: "automation" } },
        store.viewFor(done.attemptId),
        log.stepView(),
      ),
    ).toThrow(InvalidExecutionTransitionError);
  });

  it("throws on resume of a terminal attempt and on edges the table does not draw", () => {
    const done = drivenToPublished();
    expect(() => resume(done, "resolution: revival")).toThrow(InvalidExecutionTransitionError);
    expect(() => transition(done, "executing")).toThrow(InvalidExecutionTransitionError);
    const unstarted = openAttempt(new MemoryAttemptRegister(), {
      planId: "plan-alpha",
      planFingerprint: "plan_sha256:alpha",
    });
    expect(() => transition(unstarted, "published")).toThrow(InvalidExecutionTransitionError);
  });

  it("throws on a step before the attempt started", () => {
    const store = new MemoryClaimStore();
    const log = new MemoryTransitionLog();
    const unstarted = openAttempt(new MemoryAttemptRegister(), {
      planId: "plan-alpha",
      planFingerprint: "plan_sha256:alpha",
    });
    expect(() => run(unstarted, "plan", store, log)).toThrow(InvalidExecutionTransitionError);
  });
});
