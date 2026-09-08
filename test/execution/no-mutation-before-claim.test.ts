import { describe, expect, it } from "vitest";

import {
  type Claim,
  type ClaimDenied,
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
// A lease scope: a stable-version claim is a record (ADR-0009 decision 4),
// so releasing its token is a no-op — the released-claim scenarios release
// this one.
const LEASE_SCOPE = {
  kind: "prerelease-sequence",
  lineId: "line-main",
  target: "1.3.0-rc",
  streamId: "rc",
  sequence: 1,
} as const;

const asClaim = (outcome: Claim | ClaimDenied): Claim => {
  if (outcome.kind !== "claim") {
    if (outcome.holder === undefined) {
      throw new Error("expected a claim, got a denial without a holder");
    }
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

/** An executing attempt whose plan stage is complete and that holds no
 * claim — fixture 6's opening position. */
const executingWithoutClaim = (store: MemoryClaimStore, log: MemoryTransitionLog) => {
  const attempt = open();
  expect(run(attempt, "plan", store, log).kind).toBe("advance");
  return attempt;
};

/** An executing attempt through claim and prepare — the first mutating
 * stage behind it — with its token returned for release scenarios. */
const withReleasedClaim = (store: MemoryClaimStore, log: MemoryTransitionLog) => {
  const attempt = executingWithoutClaim(store, log);
  const token = asClaim(store.acquire(LEASE_SCOPE, attempt.attemptId)).token;
  expect(run(attempt, "claim", store, log).kind).toBe("advance");
  expect(run(attempt, "prepare", store, log).kind).toBe("advance");
  expect(run(attempt, "validate", store, log).kind).toBe("advance");
  store.release(token);
  return attempt;
};

describe("fixture 6 — no mutation before claim", () => {
  it("refuses the claim stage itself while no claim is held, recording nothing", () => {
    const store = new MemoryClaimStore();
    const log = new MemoryTransitionLog();
    const attempt = executingWithoutClaim(store, log);

    const outcome = run(attempt, "claim", store, log);
    expect(outcome).toEqual({
      kind: "refused",
      stepKey: "claim",
      detail: "mutation-without-claim",
    });
    expect(log.records()).toHaveLength(1);
    expect(log.records()[0]?.stepKey).toBe("plan");
  });

  it("refuses a mutating step with no claim held, recording nothing", () => {
    const store = new MemoryClaimStore();
    const log = new MemoryTransitionLog();
    const attempt = withReleasedClaim(store, log);
    const before = log.records();

    const outcome = run(attempt, "commit", store, log);
    expect(outcome).toEqual({
      kind: "refused",
      stepKey: "commit",
      detail: "mutation-without-claim",
    });
    expect(log.records()).toEqual(before);
  });

  it("advances with the claim recorded once ownership is acquired", () => {
    const store = new MemoryClaimStore();
    const log = new MemoryTransitionLog();
    const attempt = executingWithoutClaim(store, log);

    const token = asClaim(store.acquire(SCOPE, attempt.attemptId)).token;
    expect(run(attempt, "claim", store, log).kind).toBe("advance");
    const outcome = run(attempt, "prepare", store, log);
    expect(outcome.kind).toBe("advance");
    if (outcome.kind !== "advance") {
      throw new Error("expected an advance");
    }
    expect(outcome.record.claim).toBe(token);
    const guards = Object.fromEntries(outcome.record.guards.map((g) => [g.guard, g.passed]));
    expect(guards["claim-held"]).toBe(true);
    expect(guards["claim-verified"]).toBe(true);
  });

  it("cuts off a mutating step when the held claim stops verifying (§2.4 loser path)", () => {
    const store = new MemoryClaimStore();
    const log = new MemoryTransitionLog();
    const attempt = executingWithoutClaim(store, log);
    const token = asClaim(store.acquire(LEASE_SCOPE, attempt.attemptId)).token;
    expect(run(attempt, "claim", store, log).kind).toBe("advance");
    expect(run(attempt, "prepare", store, log).kind).toBe("advance");

    // The view is a snapshot from before the release: the request still
    // names a held claim, but the store's current state no longer backs it.
    const staleView = store.viewFor(attempt.attemptId);
    store.release(token);

    // `validate` re-proves preconditions without mutating, so it advances;
    // the next mutating stage is where the stale claim meets the guard.
    const validated = requestStep(
      attempt,
      {
        stepKey: "validate",
        attribution: { attemptId: attempt.attemptId, actor: "automation" },
        contentFingerprint: "content:validate",
      },
      staleView,
      log.stepView(),
    );
    expect(validated.kind).toBe("advance");
    if (validated.kind === "advance") {
      log.append(validated.record);
    }

    const outcome = requestStep(
      attempt,
      {
        stepKey: "commit",
        attribution: { attemptId: attempt.attemptId, actor: "automation" },
        contentFingerprint: "content:commit",
      },
      staleView,
      log.stepView(),
    );
    expect(outcome).toEqual({
      kind: "claim-lost",
      stepKey: "commit",
      detail: "the held claim no longer verifies — the loser path (§2.4)",
    });
    expect(log.records().some((record) => record.stepKey === "commit")).toBe(false);
  });
});
