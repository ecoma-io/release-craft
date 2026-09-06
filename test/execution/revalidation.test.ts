import { describe, expect, it } from "vitest";

import {
  InvalidExecutionTransitionError,
  MemoryAttemptRegister,
  MemoryLedger,
  block,
  openAttempt,
  resolveBlocked,
  start,
  type Attribution,
  type ReleaseAttempt,
} from "../../src/index.js";

const PLAN_FINGERPRINT = "plan_sha256:alpha";

/** The blocked-loop fixture (contract §4.6): an executing attempt that
 * blocked on a recorded cause — E-04's `precondition-delta` here. */
const blocked = (cause = "precondition-delta"): ReleaseAttempt =>
  block(
    start(
      openAttempt(new MemoryAttemptRegister(), {
        planId: "plan-alpha",
        planFingerprint: PLAN_FINGERPRINT,
      }),
    ),
    cause,
  );

const attributionOf = (attempt: ReleaseAttempt, who: Attribution["actor"]): Attribution => ({
  attemptId: attempt.attemptId,
  actor: who,
});

describe("the revalidation record (phase 5 §2.7, E-04)", () => {
  it("re-arms a blocked attempt over a matching revalidation — the resolution record", () => {
    const ledger = new MemoryLedger();
    const attempt1 = blocked();
    const attribution = attributionOf(attempt1, "automation");
    // The realistic blocked loop: the step's start is durable, then the
    // precondition delta suspends the attempt, then the resolution lands.
    ledger.appendStart(attempt1, "validate", attribution);

    const stored = resolveBlocked(
      attempt1,
      "validate",
      { kind: "revalidation", planFingerprint: PLAN_FINGERPRINT },
      ledger,
      attribution,
    );

    const tail = ledger.tail(attempt1.attemptId);
    expect(tail.length).toBe(3);
    const last = tail.at(-1);
    expect(last).toEqual({
      kind: "resolution",
      attemptId: attempt1.attemptId,
      stepKey: "validate",
      resolution: { kind: "revalidation", planFingerprint: PLAN_FINGERPRINT },
      attribution,
    });
    expect(stored).toBe(last);
    if (stored.kind !== "resolution") {
      throw new Error("expected a resolution record from resolveBlocked");
    }
    // §2.1: appended records are deep-frozen — the record and its nested
    // values are part of the ledger, nothing edits one.
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.resolution)).toBe(true);
    expect(Object.isFrozen(stored.attribution)).toBe(true);
  });

  it("refuses a revalidation over a foreign fingerprint — a changed plan is a new attempt", () => {
    const ledger = new MemoryLedger();
    const attempt1 = blocked();

    expect(() =>
      resolveBlocked(
        attempt1,
        "validate",
        { kind: "revalidation", planFingerprint: "plan_sha256:other" },
        ledger,
        attributionOf(attempt1, "automation"),
      ),
    ).toThrow(InvalidExecutionTransitionError);
    expect(() =>
      resolveBlocked(
        attempt1,
        "validate",
        { kind: "revalidation", planFingerprint: "plan_sha256:other" },
        ledger,
        attributionOf(attempt1, "automation"),
      ),
    ).toThrow("plan_sha256:other");
    // The refusal is not recorded by this door — the tail is unchanged.
    expect(ledger.tail(attempt1.attemptId).length).toBe(0);
  });

  it("refuses a resolution on a non-blocked attempt — blocked is the loop it closes", () => {
    const ledger = new MemoryLedger();
    const attempt1 = start(
      openAttempt(new MemoryAttemptRegister(), {
        planId: "plan-alpha",
        planFingerprint: PLAN_FINGERPRINT,
      }),
    );

    expect(() =>
      resolveBlocked(
        attempt1,
        "validate",
        { kind: "revalidation", planFingerprint: PLAN_FINGERPRINT },
        ledger,
        attributionOf(attempt1, "automation"),
      ),
    ).toThrow(InvalidExecutionTransitionError);
    expect(ledger.tail(attempt1.attemptId).length).toBe(0);
  });

  it("refuses a blank actor — attribution is a non-empty recorded value, checked first", () => {
    const ledger = new MemoryLedger();
    const attempt1 = blocked();
    const blank = (): Attribution => ({ attemptId: attempt1.attemptId, actor: "" });

    expect(() =>
      resolveBlocked(
        attempt1,
        "validate",
        { kind: "revalidation", planFingerprint: PLAN_FINGERPRINT },
        ledger,
        blank(),
      ),
    ).toThrow(InvalidExecutionTransitionError);
    expect(() =>
      resolveBlocked(
        attempt1,
        "validate",
        { kind: "revalidation", planFingerprint: PLAN_FINGERPRINT },
        ledger,
        blank(),
      ),
    ).toThrow("attribution actor must be a non-empty recorded value");
    expect(ledger.tail(attempt1.attemptId).length).toBe(0);

    // Guard order: the actor guard outranks the state guard — a blank actor
    // is named even when the attempt is not blocked either.
    const executing = start(
      openAttempt(new MemoryAttemptRegister(), {
        planId: "plan-alpha",
        planFingerprint: PLAN_FINGERPRINT,
      }),
    );
    expect(() =>
      resolveBlocked(
        executing,
        "validate",
        { kind: "human", note: "adopted attribution: human:maintainer" },
        ledger,
        { attemptId: executing.attemptId, actor: "" },
      ),
    ).toThrow("attribution actor must be a non-empty recorded value");
  });

  it("records a human resolution's note and attribution verbatim", () => {
    const ledger = new MemoryLedger();
    const attempt1 = blocked("unattributed-state");
    const attribution = attributionOf(attempt1, "human:maintainer");

    const stored = resolveBlocked(
      attempt1,
      "validate",
      { kind: "human", note: "adopted attribution: human:maintainer" },
      ledger,
      attribution,
    );

    const last = ledger.tail(attempt1.attemptId).at(-1);
    expect(last).toEqual({
      kind: "resolution",
      attemptId: attempt1.attemptId,
      stepKey: "validate",
      resolution: { kind: "human", note: "adopted attribution: human:maintainer" },
      attribution,
    });
    expect(stored).toBe(last);
    if (stored.kind !== "resolution") {
      throw new Error("expected a resolution record from resolveBlocked");
    }
    expect(Object.isFrozen(stored.resolution)).toBe(true);
    expect(Object.isFrozen(stored.attribution)).toBe(true);
  });
});
