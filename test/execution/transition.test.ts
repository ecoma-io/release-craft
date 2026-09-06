import { describe, expect, it } from "vitest";

import {
  MemoryTransitionLog,
  requestStep,
  start,
  openAttempt,
  MemoryAttemptRegister,
  type StepRequest,
  type TransitionRecord,
} from "../../src/index.js";

const attempt = () =>
  start(
    openAttempt(new MemoryAttemptRegister(), {
      planId: "plan-alpha",
      planFingerprint: "plan_sha256:alpha",
    }),
  );

const request = (
  stepKey: StepRequest["stepKey"],
  extra: Partial<StepRequest> = {},
): StepRequest => ({
  stepKey,
  attribution: { attemptId: "attempt_sha256:a", actor: "automation" },
  ...extra,
});

const baseRecord: TransitionRecord = {
  attemptId: "attempt_sha256:a",
  stepKey: "plan",
  from: "pending",
  to: "completed",
  guards: [{ guard: "plan-bound", passed: true }],
  attribution: { attemptId: "attempt_sha256:a", actor: "automation" },
};

describe("the transition log", () => {
  it("freezes records on append and exposes no mutation path", () => {
    const log = new MemoryTransitionLog();
    const stored = log.append(baseRecord);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.guards)).toBe(true);
    expect(Object.isFrozen(stored.guards[0])).toBe(true);
    expect(Object.isFrozen(stored.attribution)).toBe(true);
    expect(stored.to).toBe("completed");
    expect(log.records()).toEqual([stored]);
  });

  it("keeps append order and filters per attempt", () => {
    const log = new MemoryTransitionLog();
    log.append(baseRecord);
    log.append({ ...baseRecord, stepKey: "claim" as const });
    log.append({ ...baseRecord, attemptId: "attempt_sha256:b" });
    expect(log.records().map((record) => record.stepKey)).toEqual(["plan", "claim", "plan"]);
    expect(
      log
        .stepView()
        .records("attempt_sha256:a")
        .map((r) => r.stepKey),
    ).toEqual(["plan", "claim"]);
  });

  it("projects the step view: completion, current state, defaults to pending", () => {
    const log = new MemoryTransitionLog();
    const view = log.stepView();
    const a = attempt();
    expect(view.state(a.attemptId, "plan")).toBe("pending");
    expect(view.completed(a.attemptId, "plan")).toBeNull();
    log.append({ ...baseRecord, attemptId: a.attemptId });
    log.append({
      ...baseRecord,
      attemptId: a.attemptId,
      stepKey: "prepare" as const,
      from: "started",
    });
    const viewAfter = log.stepView();
    expect(viewAfter.state(a.attemptId, "prepare")).toBe("completed");
    expect(viewAfter.completed(a.attemptId, "prepare")?.stepKey).toBe("prepare");
    expect(viewAfter.completed(a.attemptId, "validate")).toBeNull();
  });

  it("records and returns external satisfactions (E-03)", () => {
    const log = new MemoryTransitionLog();
    const a = attempt();
    log.noteExternal({
      attemptId: a.attemptId,
      stepKey: "tag",
      attribution: { attemptId: a.attemptId, actor: "automation" },
      evidence: "evidence:tag:refs/tags/v1.2.0",
      contentFingerprint: "content:tag:v1.2.0",
    });
    const external = log.stepView().external(a.attemptId, "tag");
    expect(external?.evidence).toBe("evidence:tag:refs/tags/v1.2.0");
    expect(external?.contentFingerprint).toBe("content:tag:v1.2.0");
    expect(log.stepView().external(a.attemptId, "publish")).toBeNull();
  });

  it("accepts seeded external state — the same-tick contention answer", () => {
    const a = attempt();
    const log = new MemoryTransitionLog({
      external: [
        {
          attemptId: a.attemptId,
          stepKey: "publish",
          attribution: { attemptId: a.attemptId, actor: "automation" },
          evidence: "evidence:release:1",
        },
      ],
    });
    expect(log.stepView().external(a.attemptId, "publish")?.evidence).toBe("evidence:release:1");
  });
});

describe("requestStep's classification is deterministic (fixture 7)", () => {
  it("returns the same outcome for the same inputs, twice", () => {
    const run = () => {
      const log = new MemoryTransitionLog();
      const a = attempt();
      const outcome = requestStep(
        a,
        request("plan"),
        { held: null, verify: () => false },
        log.stepView(),
      );
      return outcome.kind === "advance" ? outcome.record : outcome;
    };
    expect(run()).toEqual(run());
  });
});
