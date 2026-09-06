import { describe, expect, it } from "vitest";

import {
  abandonAsFollower,
  CANONICAL_STAGES,
  type Claim,
  type ClaimDenied,
  MemoryAttemptRegister,
  MemoryClaimStore,
  MemoryTransitionLog,
  openAttempt,
  requestStep,
  start,
  transition,
  type ReleaseAttempt,
  type RequestStepOutcome,
  type StepKey,
  type StepRequest,
} from "../../src/index.js";

const open = (planId: string): ReleaseAttempt =>
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
const asDenied = (outcome: Claim | ClaimDenied): ClaimDenied => {
  if (outcome.kind !== "denied") {
    throw new Error("expected a denial");
  }
  return outcome;
};

/** Runs one stage against the live store and log, appending the carried
 * record on advance — the engine loop of fixture 1, minus the ledger. */
const run = (
  attempt: ReleaseAttempt,
  stepKey: StepKey,
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

const STABLE = { kind: "stable-version", lineId: "line-main", version: "1.2.0" } as const;

describe("fixture 1 — one scope, two attempts (E-07)", () => {
  it("the winner records, the loser exits attributed, nothing corrupts", () => {
    const winner = open("plan-alpha");
    const loser = open("plan-beta");
    const store = new MemoryClaimStore();
    const log = new MemoryTransitionLog();

    const token = asClaim(store.acquire(STABLE, winner.attemptId)).token;

    const denied = asDenied(store.acquire(STABLE, loser.attemptId));
    expect(denied.kind).toBe("denied");
    expect(denied.holder).toBe(winner.attemptId);

    const loserDone = abandonAsFollower(loser, winner.attemptId);
    expect(loserDone.state).toBe("abandoned");
    expect(loserDone.terminalReason).toBe(`follower-of:${winner.attemptId}`);

    let current = winner;
    for (const stage of CANONICAL_STAGES) {
      const outcome = run(current, stage, store, log);
      expect(outcome.kind).toBe("advance");
    }
    current = transition(current, "published");
    expect(current.state).toBe("published");

    const mutating = log
      .records()
      .filter((record) => ["prepare", "commit", "tag", "publish"].includes(record.stepKey));
    expect(mutating).toHaveLength(4);
    for (const record of mutating) {
      expect(record.claim).toBe(token);
      expect(record.guards.some((guard) => guard.guard === "claim-held" && guard.passed)).toBe(
        true,
      );
    }
    expect(store.verify(token).kind).toBe("held");
  });

  it("drives the same inputs to the same records, twice (fixture 7)", () => {
    const drive = () => {
      const attempt = open("plan-alpha");
      const store = new MemoryClaimStore();
      const log = new MemoryTransitionLog();
      store.acquire(STABLE, attempt.attemptId);
      for (const stage of CANONICAL_STAGES) {
        run(attempt, stage, store, log);
      }
      return log.records();
    };
    expect(drive()).toEqual(drive());
  });
});
