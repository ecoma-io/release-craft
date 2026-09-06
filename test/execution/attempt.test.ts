import { describe, expect, it } from "vitest";

import {
  abort,
  abandonAsFollower,
  attemptIdentity,
  block,
  crashClassify,
  InvalidExecutionTransitionError,
  isTerminalAttempt,
  MemoryAttemptRegister,
  openAttempt,
  resume,
  start,
  supersedePlan,
  TERMINAL_ATTEMPT_STATES,
  transition,
  type ReleaseAttempt,
} from "../../src/index.js";

const open = (planId = "plan-alpha"): ReleaseAttempt =>
  openAttempt(new MemoryAttemptRegister(), {
    planId,
    planFingerprint: `plan_sha256:${planId}`,
  });

describe("attempt identity and the register", () => {
  it("opens a planned attempt with a content-anchored id", () => {
    const attempt = open();
    expect(attempt.state).toBe("planned");
    expect(attempt.planId).toBe("plan-alpha");
    expect(attempt.planFingerprint).toBe("plan_sha256:plan-alpha");
    expect(attempt.attemptId).toMatch(/^attempt_sha256:[0-9a-f]{64}$/);
  });

  it("allocates increasing ordinals per plan — one plan, two attempts (E-05)", () => {
    const register = new MemoryAttemptRegister();
    const first = openAttempt(register, {
      planId: "plan-alpha",
      planFingerprint: "plan_sha256:alpha",
    });
    const second = openAttempt(register, {
      planId: "plan-alpha",
      planFingerprint: "plan_sha256:alpha",
    });
    const otherPlan = openAttempt(register, {
      planId: "plan-beta",
      planFingerprint: "plan_sha256:beta",
    });
    expect(first.attemptId).not.toBe(second.attemptId);
    expect(otherPlan.attemptId).not.toBe(first.attemptId);
  });

  it("derives the same id from the same plan and ordinal — pure, deterministic", () => {
    expect(attemptIdentity("plan-alpha", 1)).toBe(attemptIdentity("plan-alpha", 1));
    expect(attemptIdentity("plan-alpha", 1)).not.toBe(attemptIdentity("plan-alpha", 2));
    expect(attemptIdentity("plan-alpha", 1)).not.toBe(attemptIdentity("plan-beta", 1));
  });

  it("seeds explicit initial ordinals", () => {
    const register = new MemoryAttemptRegister({ ordinals: { "plan-alpha": 4 } });
    expect(register.nextOrdinal("plan-alpha")).toBe(5);
    expect(register.nextOrdinal("plan-beta")).toBe(1);
  });
});

describe("the attempt state machine", () => {
  it("walks the happy spine: planned → executing → published", () => {
    const attempt = start(open());
    expect(attempt.state).toBe("executing");
    const done = transition(attempt, "published");
    expect(done.state).toBe("published");
  });

  it("suspends as blocked(cause) and resumes only on a recorded resolution", () => {
    const attempt = block(start(open()), "precondition-delta");
    expect(attempt.state).toBe("blocked");
    expect(attempt.blockedCause).toBe("precondition-delta");
    const back = resume(attempt, "resolution: stale tag deleted by maintainer");
    expect(back.state).toBe("executing");
    expect(back.blockedCause).toBeUndefined();
  });

  it("refuses resume without a resolution, on a non-blocked attempt, and blank causes", () => {
    const executing = start(open());
    expect(() => resume(executing, "resolution: anything")).toThrow(
      InvalidExecutionTransitionError,
    );
    const blocked = block(executing, "unattributed-state");
    expect(() => resume(blocked, "")).toThrow(InvalidExecutionTransitionError);
    expect(() => block(executing, "")).toThrow(InvalidExecutionTransitionError);
  });

  it("records terminal reasons: failed(unknown) for the crash, follower-of for the loser", () => {
    const crashed = crashClassify(start(open()));
    expect(crashed.state).toBe("failed");
    expect(crashed.terminalReason).toBe("unknown");

    const loser = abandonAsFollower(start(open()), "attempt_sha256:winner");
    expect(loser.state).toBe("abandoned");
    expect(loser.terminalReason).toBe("follower-of:attempt_sha256:winner");
  });

  it("throws on every edge the table does not draw — terminal is terminal", () => {
    expect(() => transition(open(), "published")).toThrow(InvalidExecutionTransitionError);
    const done = transition(start(open()), "published");
    expect(isTerminalAttempt(done.state)).toBe(true);
    expect(() => transition(done, "executing")).toThrow(InvalidExecutionTransitionError);
    expect(() => resume(done, "resolution: revival")).toThrow(InvalidExecutionTransitionError);
    expect(() => start(done)).toThrow(InvalidExecutionTransitionError);
    for (const state of TERMINAL_ATTEMPT_STATES) {
      expect(isTerminalAttempt(state)).toBe(true);
    }
    expect(isTerminalAttempt("executing")).toBe(false);
    expect(isTerminalAttempt("blocked")).toBe(false);
    expect(isTerminalAttempt("planned")).toBe(false);
  });

  it("returns frozen values — an attempt never mutates", () => {
    const attempt = open();
    expect(Object.isFrozen(attempt)).toBe(true);
    expect(Reflect.set(attempt, "state", "failed")).toBe(false);
    expect(attempt.state).toBe("planned");
  });
});

describe("abort and supersede", () => {
  it("aborts a non-terminal attempt with the actor recorded (E-09)", () => {
    const outcome = abort(start(open()), "human:maintainer", "wrong base branch");
    expect(outcome.attempt.state).toBe("abandoned");
    expect(outcome.attempt.terminalReason).toBe("wrong base branch");
    expect(outcome.attribution).toEqual({
      attemptId: outcome.attempt.attemptId,
      actor: "human:maintainer",
    });
  });

  it("refuses abort without an actor and on a terminal attempt", () => {
    expect(() => abort(open(), "", "reason")).toThrow(InvalidExecutionTransitionError);
    const done = transition(start(open()), "published");
    expect(() => abort(done, "human:maintainer", "too late")).toThrow(
      InvalidExecutionTransitionError,
    );
  });

  it("supersedes non-terminal attempts before tag; past-tag attempts stand (E-01)", () => {
    const steps = { completed: () => null };
    const planned = open();
    const executing = start(open());
    const outcome = supersedePlan({
      oldPlanId: "plan-alpha",
      newPlanId: "plan_sha256:new",
      attempts: [planned, executing],
      steps,
    });
    expect(outcome.superseded).toHaveLength(2);
    for (const moved of outcome.superseded) {
      expect(moved.state).toBe("superseded");
      expect(moved.terminalReason).toBe("superseded-by:plan_sha256:new");
    }
    expect(outcome.pastTag).toHaveLength(0);
  });

  it("leaves terminal attempts and other plans' attempts untouched", () => {
    const done = transition(start(open()), "published");
    const otherPlan = open("plan-beta");
    const outcome = supersedePlan({
      oldPlanId: "plan-alpha",
      newPlanId: "plan_sha256:new",
      attempts: [done, otherPlan],
      steps: { completed: () => null },
    });
    expect(outcome.superseded).toHaveLength(0);
    expect(outcome.pastTag).toHaveLength(0);
    expect(done.state).toBe("published");
    expect(otherPlan.state).toBe("planned");
  });
});
