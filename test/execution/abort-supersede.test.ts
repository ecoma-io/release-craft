import { describe, expect, it } from "vitest";

import {
  abort,
  block,
  type Claim,
  type ClaimDenied,
  InvalidExecutionTransitionError,
  MemoryAttemptRegister,
  MemoryClaimStore,
  MemoryTransitionLog,
  openAttempt,
  requestStep,
  resume,
  start,
  supersedePlan,
  transition,
  type ReleaseAttempt,
  type RequestStepOutcome,
  type StageKey,
  type StepRequest,
} from "../../src/index.js";

const open = (planId = "plan-alpha"): ReleaseAttempt =>
  start(
    openAttempt(new MemoryAttemptRegister(), {
      planId,
      planFingerprint: `plan_sha256:${planId}`,
    }),
  );

const asClaim = (outcome: Claim | ClaimDenied): Claim => {
  if (outcome.kind !== "claim") {
    throw new Error(`expected a claim, got a denial by ${outcome.holder}`);
  }
  return outcome;
};

const run = (
  attempt: ReleaseAttempt,
  stepKey: StageKey,
  store: MemoryClaimStore,
  log: MemoryTransitionLog,
  extra: Partial<StepRequest> = {},
): RequestStepOutcome => {
  const outcome = requestStep(
    attempt,
    {
      stepKey,
      attribution: { attemptId: attempt.attemptId, actor: "automation" },
      contentFingerprint: `content:${stepKey}:${attempt.attemptId}`,
      ...extra,
    },
    store.viewFor(attempt.attemptId),
    log.stepView(),
  );
  if (outcome.kind === "advance") {
    log.append(outcome.record);
  }
  return outcome;
};

/** Drives plan and claim, returning the executing attempt with ownership
 * held — the prefix every scenario under test builds on. */
const withClaim = (store: MemoryClaimStore, log: MemoryTransitionLog) => {
  const attempt = open();
  expect(run(attempt, "plan", store, log).kind).toBe("advance");
  const granted = store.acquire(
    { kind: "stable-version", lineId: "line-main", version: "1.2.0" },
    attempt.attemptId,
  );
  expect(run(attempt, "claim", store, log).kind).toBe("advance");
  expect(run(attempt, "prepare", store, log).kind).toBe("advance");
  return { attempt, token: asClaim(granted).token };
};

describe("fixture 3 — abort and the blocked boundary (E-09, E-04)", () => {
  it("a stale precondition suspends; a recorded resolution closes it", () => {
    const store = new MemoryClaimStore();
    const log = new MemoryTransitionLog();
    const { attempt } = withClaim(store, log);

    const outcome = run(attempt, "validate", store, log, {
      preconditions: [
        {
          precondition: "tag-absent:refs/tags/v1.2.0",
          holds: false,
          cause: "precondition-delta",
        },
      ],
    });
    expect(outcome).toEqual({
      kind: "blocked",
      stepKey: "validate",
      cause: "precondition-delta",
    });

    const suspended = block(attempt, "precondition-delta");
    expect(suspended.state).toBe("blocked");
    const reopened = resume(suspended, "resolution: stale tag deleted by maintainer");
    expect(reopened.state).toBe("executing");
    expect(
      run(reopened, "validate", store, log, {
        preconditions: [{ precondition: "tag-absent:refs/tags/v1.2.0", holds: true }],
      }).kind,
    ).toBe("advance");
  });

  it("a human abort is authoritative from blocked and executing alike", () => {
    const store = new MemoryClaimStore();
    const log = new MemoryTransitionLog();
    const { attempt } = withClaim(store, log);

    const outcome = run(attempt, "validate", store, log, {
      preconditions: [{ precondition: "tag-absent:refs/tags/v1.2.0", holds: false }],
    });
    expect(outcome.kind).toBe("blocked");
    const aborted = abort(block(attempt, "precondition-delta"), "human:maintainer", "wrong base");
    expect(aborted.attempt.state).toBe("abandoned");
    expect(aborted.attempt.terminalReason).toBe("wrong base");
    expect(aborted.attribution.actor).toBe("human:maintainer");

    expect(() =>
      requestStep(
        aborted.attempt,
        { stepKey: "validate", attribution: aborted.attribution },
        store.viewFor(aborted.attempt.attemptId),
        log.stepView(),
      ),
    ).toThrow(InvalidExecutionTransitionError);
  });
});

describe("fixture 4 — supersession and the tag boundary (E-01)", () => {
  it("voids attempts before tag and leaves their recorded steps standing", () => {
    const store = new MemoryClaimStore();
    const log = new MemoryTransitionLog();
    const { attempt } = withClaim(store, log);
    const before = log.records().length;

    const outcome = supersedePlan({
      oldPlanId: "plan-alpha",
      newPlanId: "plan_sha256:replacement",
      attempts: [attempt],
      steps: log.stepView(),
    });
    expect(outcome.superseded).toHaveLength(1);
    expect(outcome.superseded[0]?.state).toBe("superseded");
    expect(outcome.superseded[0]?.terminalReason).toBe("superseded-by:plan_sha256:replacement");
    expect(outcome.pastTag).toHaveLength(0);
    expect(log.records().length).toBe(before);
  });

  it("does not void an attempt past tag; it records and the attempt finishes", () => {
    const store = new MemoryClaimStore();
    const log = new MemoryTransitionLog();
    const attempt = withClaim(store, log).attempt;
    for (const stage of ["validate", "commit", "tag"] as const) {
      expect(run(attempt, stage, store, log).kind).toBe("advance");
    }

    const outcome = supersedePlan({
      oldPlanId: "plan-alpha",
      newPlanId: "plan_sha256:replacement",
      attempts: [attempt],
      steps: log.stepView(),
    });
    expect(outcome.pastTag).toHaveLength(1);
    expect(outcome.pastTag[0]?.state).toBe("executing");
    expect(outcome.superseded).toHaveLength(0);

    expect(run(attempt, "publish", store, log).kind).toBe("advance");
    expect(run(attempt, "verify", store, log).kind).toBe("advance");
    expect(transition(attempt, "published").state).toBe("published");
  });
});
