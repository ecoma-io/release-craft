import { describe, expect, it } from "vitest";

import {
  MemoryAttemptRegister,
  MemoryLedger,
  classifyResume,
  isHookStepKey,
  resume,
  effectiveSteps,
  hookStepKey,
  openAttempt,
  resolveBlocked,
  scheduleHooks,
  start,
  type Attribution,
  type Claim,
  type ClaimView,
  type HookEffect,
  type HookEffectInput,
  type HookObservation,
  type HookOutcome,
  type HookStep,
  type HooksRun,
  type LedgerRecord,
  type ReleaseAttempt,
  type StageKey,
} from "../../src/index.js";

const PLAN = { planId: "plan-alpha", planFingerprint: "plan_sha256:alpha" };

const planned = (hooks?: readonly HookStep[]): ReleaseAttempt =>
  openAttempt(new MemoryAttemptRegister(), PLAN, hooks);

const executing = (hooks?: readonly HookStep[]): ReleaseAttempt => start(planned(hooks));

const actor = (attempt: ReleaseAttempt, who = "automation"): Attribution => ({
  attemptId: attempt.attemptId,
  actor: who,
});

const heldClaim = (attempt: ReleaseAttempt): ClaimView => {
  const claim: Claim = {
    kind: "claim",
    scope: { kind: "release-line", lineId: "line-1" },
    token: "token-1",
    holder: attempt.attemptId,
  };
  return { held: claim, verify: () => true };
};

const noClaims: ClaimView = { held: null, verify: () => false };

const hookDecl = (
  id: string,
  stage: StageKey,
  position: "before" | "after",
  postconditions: HookStep["postconditions"] = [],
): HookStep => ({ id, anchor: { stage, position }, guard: "release-line", postconditions });

/** An effect that records its seam inputs and returns a fixed observation
 * (the caller's code lives outside the engine; the engine only invokes). */
const recordingEffect = (
  over: Partial<HookObservation> = {},
): HookEffect & { calls: HookEffectInput[] } => {
  const calls: HookEffectInput[] = [];
  const run = (input: HookEffectInput): HookObservation => {
    calls.push(input);
    return { attribution: { attemptId: input.attemptId, actor: "automation" }, ...over };
  };
  const effect = run as HookEffect & { calls: HookEffectInput[] };
  effect.calls = calls;
  return effect;
};

/** The recorded hook completion a full scheduler pass leaves behind —
 * rebuilt by hand for the kill-anywhere fixtures, exactly as the ledger
 * truncation leaves it: write-ahead start, then the completed record with
 * the guard verbatim. */
const recordHook = (ledger: MemoryLedger, attempt: ReleaseAttempt, id: string): void => {
  const stepKey = hookStepKey(id);
  ledger.appendStart(attempt, stepKey, actor(attempt), undefined, "release-line");
  ledger.append({
    kind: "step",
    record: {
      attemptId: attempt.attemptId,
      stepKey,
      from: "started",
      to: "completed",
      guards: [{ guard: "release-line", passed: true }],
      attribution: actor(attempt),
    },
  });
};

/** Record a hook completion with an explicit contentFingerprint —
 * simulates the second completion a crash-restart leaves when the effect
 * re-runs and produces different proof bytes. */
const recordHookWithFingerprint = (
  ledger: MemoryLedger,
  attempt: ReleaseAttempt,
  id: string,
  contentFingerprint: string,
): void => {
  const stepKey = hookStepKey(id);
  ledger.appendStart(attempt, stepKey, actor(attempt), undefined, "release-line");
  ledger.append({
    kind: "step",
    record: {
      attemptId: attempt.attemptId,
      stepKey,
      from: "started",
      to: "completed",
      guards: [{ guard: "release-line", passed: true }],
      attribution: actor(attempt),
      contentFingerprint,
    },
  });
};

const completeStage = (ledger: MemoryLedger, attempt: ReleaseAttempt, stage: StageKey): void => {
  ledger.appendStart(attempt, stage, actor(attempt));
  ledger.append({
    kind: "step",
    record: {
      attemptId: attempt.attemptId,
      stepKey: stage,
      from: "started",
      to: "completed",
      guards: [],
      attribution: actor(attempt),
    },
  });
};

const completedOutcome = (
  outcomes: readonly HookOutcome[],
): Extract<HookOutcome, { readonly kind: "completed" }> => {
  const completed = outcomes.find((outcome) => outcome.kind === "completed");
  if (completed === undefined) {
    throw new Error("expected a completed hook outcome");
  }
  return completed;
};

const refusedOutcome = (
  outcomes: readonly HookOutcome[],
): Extract<HookOutcome, { readonly kind: "refused" }> => {
  const refused = outcomes.find((outcome) => outcome.kind === "refused");
  if (refused === undefined) {
    throw new Error("expected a refused hook outcome");
  }
  return refused;
};

const failedOutcome = (
  outcomes: readonly HookOutcome[],
): Extract<HookOutcome, { readonly kind: "failed" }> => {
  const failed = outcomes.find((outcome) => outcome.kind === "failed");
  if (failed === undefined) {
    throw new Error("expected a failed hook outcome");
  }
  return failed;
};

describe("effectiveSteps (§2.1): the insertion rules the canonical stages named their ADR for", () => {
  it("interleaves hooks at their anchors, declaration order breaking same-anchor ties", () => {
    const attempt = executing([
      hookDecl("double", "validate", "before"),
      hookDecl("receipt", "tag", "after"),
      hookDecl("scan", "publish", "before"),
      hookDecl("notify", "publish", "after"),
    ]);
    expect(effectiveSteps(attempt)).toStrictEqual([
      "plan",
      "claim",
      "prepare",
      "hook:double",
      "validate",
      "commit",
      "tag",
      "hook:receipt",
      "channel-transition",
      "hook:scan",
      "publish",
      "hook:notify",
      "verify",
    ]);
  });

  it("attaches hooks without moving the plan fingerprint or the attempt identity", () => {
    const bare = planned();
    const decorated = planned([hookDecl("scan", "publish", "before")]);
    expect(decorated.planFingerprint).toBe(bare.planFingerprint);
    expect(decorated.attemptId).toBe(bare.attemptId);
    expect(decorated.planId).toBe(bare.planId);
  });

  it("throws on duplicate ids, unknown anchors, and unknown postcondition kinds (§2.1 protocol)", () => {
    expect(() =>
      planned([hookDecl("scan", "publish", "before"), hookDecl("scan", "tag", "before")]),
    ).toThrow(/duplicate hook id/);
    expect(() =>
      openAttempt(new MemoryAttemptRegister(), PLAN, [
        {
          id: "x",
          anchor: { stage: "release" as StageKey, position: "before" },
          guard: "g",
          postconditions: [],
        },
      ]),
    ).toThrow(/not one of the canonical stages/);
    expect(() =>
      openAttempt(new MemoryAttemptRegister(), PLAN, [
        {
          id: "x",
          anchor: { stage: "tag", position: "before" },
          guard: "g",
          postconditions: ["world-peace" as HookStep["postconditions"][number]],
        },
      ]),
    ).toThrow(/unknown postcondition/);
  });
});

describe("scheduleHooks (§2.2): the seam, walk in effective order", () => {
  it("write-ahead starts, invokes the effect, and records the completion with its proof", () => {
    const attempt = executing([
      hookDecl("scan", "publish", "before", ["content-fingerprint-present"]),
    ]);
    const ledger = new MemoryLedger();
    const effect = recordingEffect({
      contentFingerprint: "content_sha256:release",
      evidence: "scan-report:1",
    });
    const run = scheduleHooks(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      new Map([["scan", effect]]),
    );
    expect(run.attempt.state).toBe("executing");
    const completed = completedOutcome(run.outcomes);
    expect(completed.stepKey).toBe("hook:scan");
    expect(completed.record.to).toBe("completed");
    expect(completed.record.contentFingerprint).toBe("content_sha256:release");
    // The start record carries the declared guard verbatim (ADR-0007
    // decision 4); the tail is write-ahead ordered — plan record first
    // (appendStart's lazily appended half), then the hook's start.
    const tail = ledger.tail(attempt.attemptId);
    expect(tail).toHaveLength(3);
    const start0 = tail[1];
    if (start0 === undefined || start0.kind !== "step")
      throw new Error("expected the start record");
    expect(start0.record.to).toBe("started");
    expect(start0.record.guards).toStrictEqual([{ guard: "release-line", passed: true }]);
  });

  it("refuses without a held claim — the kernel's recorded refusal, walk stopped", () => {
    const attempt = executing([
      hookDecl("first", "tag", "after"),
      hookDecl("second", "publish", "after"),
    ]);
    const ledger = new MemoryLedger();
    const effect = recordingEffect();
    const run = scheduleHooks(
      attempt,
      actor(attempt),
      ledger,
      noClaims,
      new Map([
        ["first", effect],
        ["second", effect],
      ]),
    );
    const refused = refusedOutcome(run.outcomes);
    expect(refused.hookId).toBe("first");
    expect(refused.detail).toBe("mutation-without-claim");
    // Ordered execution: the second hook never ran.
    expect(run.outcomes).toHaveLength(1);
    expect(effect.calls).toHaveLength(0);
    expect(ledger.tail(attempt.attemptId)).toHaveLength(0);
  });

  it("replays a completed hook from the ledger — never re-executed, no effect needed", () => {
    const attempt = executing([hookDecl("scan", "publish", "before")]);
    const ledger = new MemoryLedger();
    recordHook(ledger, attempt, "scan");
    const before = ledger.tail(attempt.attemptId).length;
    // No effect is injected at all: replay answers from the projection.
    const run = scheduleHooks(attempt, actor(attempt), ledger, heldClaim(attempt), new Map());
    expect(run.outcomes).toHaveLength(1);
    const completed = completedOutcome(run.outcomes);
    const stored = ledger.stepView().completed(attempt.attemptId, "hook:scan");
    expect(stored === null ? null : completed.record).toStrictEqual(stored);
    expect(ledger.tail(attempt.attemptId)).toHaveLength(before);
  });

  it("throws on a declared hook without an injected effect and on a non-executing attempt (§2.2 protocol)", () => {
    const attempt = executing([hookDecl("scan", "publish", "before")]);
    const ledger = new MemoryLedger();
    expect(() =>
      scheduleHooks(attempt, actor(attempt), ledger, heldClaim(attempt), new Map()),
    ).toThrow(/never invents user code/);
    expect(() =>
      scheduleHooks(
        planned([hookDecl("scan", "publish", "before")]),
        actor(attempt),
        new MemoryLedger(),
        heldClaim(attempt),
        new Map(),
      ),
    ).toThrow(/executing attempt/);
  });
});

describe("refusal by construction (§2.3): the seam sees identity, never the plan", () => {
  it("hands the effect exactly three identity fields and leaves the plan untouched", () => {
    const attempt = executing([hookDecl("scan", "publish", "before")]);
    const ledger = new MemoryLedger();
    const effect = recordingEffect({ evidence: "scan-report:1" });
    scheduleHooks(attempt, actor(attempt), ledger, heldClaim(attempt), new Map([["scan", effect]]));
    expect(effect.calls).toHaveLength(1);
    const input = effect.calls[0];
    if (input === undefined) throw new Error("expected the seam input");
    expect(Object.keys(input).sort()).toStrictEqual(["attemptId", "hookId", "stage"]);
    expect(input.stage).toBe("publish");
    expect(input.attemptId).toBe(attempt.attemptId);
    // The plan value and fingerprint never moved (ADR-0007 decision 7).
    const planRecord = ledger
      .tail(attempt.attemptId)
      .find(
        (record): record is Extract<LedgerRecord, { readonly kind: "plan" }> =>
          record.kind === "plan",
      );
    if (planRecord === undefined) throw new Error("expected the plan record");
    expect(planRecord.planFingerprint).toBe(PLAN.planFingerprint);
    expect(attempt.planFingerprint).toBe(PLAN.planFingerprint);
  });
});

describe("postcondition failure (§2.5): fail-closed, in the existing vocabulary", () => {
  it("records the hook failed and blocks the attempt, cause naming the hook and the proof", () => {
    const attempt = executing([
      hookDecl("scan", "publish", "before", ["content-fingerprint-present"]),
    ]);
    const ledger = new MemoryLedger();
    // The ordered engine reaches the hook past `tag` — the canonical
    // prefix is the ledger's completed history.
    for (const stage of ["plan", "claim", "prepare", "validate", "commit", "tag"] as const) {
      completeStage(ledger, attempt, stage);
    }
    const effect = recordingEffect({ evidence: "scan-report:1" });
    const run = scheduleHooks(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      new Map([["scan", effect]]),
    );
    expect(run.attempt.state).toBe("blocked");
    expect(run.attempt.blockedCause).toBe("validation:hook:scan:content-fingerprint-present");
    const failed = failedOutcome(run.outcomes);
    expect(failed.record.to).toBe("failed");
    expect(failed.record.evidence).toBe("scan-report:1");
    // The resolution loop re-arms: the classified tail resumes at the hook.
    resolveBlocked(
      run.attempt,
      "hook:scan",
      { kind: "revalidation", planFingerprint: PLAN.planFingerprint },
      ledger,
      actor(run.attempt, "human"),
    );
    const verdict = classifyResume(run.attempt, ledger);
    expect(verdict.kind).toBe("resume");
    if (verdict.kind !== "resume") throw new Error("expected a resume verdict");
    expect(verdict.from).toBe("channel-transition");
  });

  it("keeps the append-only tail resumable after the resolution loop re-arms it (§2.5)", () => {
    const attempt = executing([
      hookDecl("scan", "publish", "before", ["content-fingerprint-present"]),
    ]);
    const ledger = new MemoryLedger();
    for (const stage of ["plan", "claim", "prepare", "validate", "commit", "tag"] as const) {
      completeStage(ledger, attempt, stage);
    }
    const failing = scheduleHooks(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      new Map([["scan", recordingEffect()]]),
    );
    resolveBlocked(
      failing.attempt,
      "hook:scan",
      { kind: "revalidation", planFingerprint: PLAN.planFingerprint },
      ledger,
      actor(failing.attempt, "human"),
    );
    const back = resume(failing.attempt, "revalidated: the stored plan still holds");
    // The scheduler re-runs the hook — its completion lands AFTER the
    // failed record the append-only tail can never drop.
    const rerun = scheduleHooks(
      back,
      actor(back),
      ledger,
      heldClaim(back),
      new Map([["scan", recordingEffect({ contentFingerprint: "content_sha256:late" })]]),
    );
    expect(rerun.attempt.state).toBe("executing");
    expect(ledger.stepView().state(back.attemptId, "hook:scan")).toBe("completed");
    // A later classification (the crash stopped past the hook) reads the
    // resolved history as resumable — from the stage after the hook.
    const verdict = classifyResume(back, ledger);
    expect(verdict).toStrictEqual({ kind: "resume", from: "channel-transition" });
  });

  it("escalates when the only resolution record answers a different key (§2.5)", () => {
    const attempt = executing([hookDecl("scan", "publish", "before")]);
    const ledger = new MemoryLedger();
    ledger.appendStart(attempt, "hook:scan", actor(attempt), undefined, "release-line");
    ledger.append({
      kind: "step",
      record: {
        attemptId: attempt.attemptId,
        stepKey: "hook:scan",
        from: "started",
        to: "failed",
        guards: [{ guard: "release-line", passed: true }],
        attribution: actor(attempt),
      },
    });
    ledger.append({
      kind: "resolution",
      attemptId: attempt.attemptId,
      stepKey: "plan",
      resolution: { kind: "revalidation", planFingerprint: PLAN.planFingerprint },
      attribution: actor(attempt, "human"),
    });
    const verdict = classifyResume(attempt, ledger);
    expect(verdict.kind).toBe("escalate");
    if (verdict.kind !== "escalate") throw new Error("expected an escalate verdict");
    expect(verdict.detail).toContain("hook:scan");
  });

  it("escalates a failed hook record that no blocked attempt explains (§2.5)", () => {
    const attempt = executing([hookDecl("scan", "publish", "before")]);
    const ledger = new MemoryLedger();
    ledger.appendStart(attempt, "hook:scan", actor(attempt), undefined, "release-line");
    ledger.append({
      kind: "step",
      record: {
        attemptId: attempt.attemptId,
        stepKey: "hook:scan",
        from: "started",
        to: "failed",
        guards: [{ guard: "release-line", passed: true }],
        attribution: actor(attempt),
      },
    });
    const verdict = classifyResume(attempt, ledger);
    expect(verdict.kind).toBe("escalate");
    if (verdict.kind !== "escalate") throw new Error("expected an escalate verdict");
    expect(verdict.detail).toContain("hook:scan");
  });
});

describe("kill-anywhere with hooks (§4.2): truncation at every effective boundary", () => {
  const HOOKS = [hookDecl("scan", "publish", "before"), hookDecl("notify", "publish", "after")];
  const sequence = effectiveSteps(executing(HOOKS));

  it("classifies every truncation identically under double-run, hook boundaries included", () => {
    for (const [boundary] of sequence.entries()) {
      const attempt = executing(HOOKS);
      const ledger = new MemoryLedger();
      // The ledger the crash left: every step before `boundary` recorded,
      // write-ahead start then completion; boundary 0 keeps the plan
      // record alone (§2.2's recorded fingerprint half).
      for (const [index, key] of sequence.entries()) {
        if (index >= boundary) break;
        if (isHookStepKey(key)) {
          recordHook(ledger, attempt, key.slice("hook:".length));
        } else {
          completeStage(ledger, attempt, key as StageKey);
        }
      }
      if (boundary === 0) {
        ledger.appendStart(attempt, "plan", actor(attempt));
      }
      const first = classifyResume(attempt, ledger);
      const second = classifyResume(attempt, ledger);
      const tail = sequence[boundary];
      const expectedVerdict =
        tail === undefined
          ? { kind: "complete", outcome: "published" as const }
          : { kind: "resume", from: tail };
      expect(first).toStrictEqual(expectedVerdict);
      expect(second).toStrictEqual(expectedVerdict);
    }
  });
});

describe("content-fingerprint conflict on replay (§2.2): two completions, differing content", () => {
  it("refuses with a conflict when two completions disagree on the recorded content (#193)", () => {
    const attempt = executing([hookDecl("scan", "publish", "before")]);
    const ledger = new MemoryLedger();
    // The crash-restart window: the effect ran twice, each run appending
    // its completion — the two records disagree on the content proof.
    recordHookWithFingerprint(ledger, attempt, "scan", "content_sha256:v1");
    recordHookWithFingerprint(ledger, attempt, "scan", "content_sha256:v2");
    const effect = recordingEffect();
    const run = scheduleHooks(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      new Map([["scan", effect]]),
    );
    // Replay answers from the ledger — the effect never re-runs.
    expect(effect.calls).toHaveLength(0);
    // Pre-fix this was a silent `completed`; the parity contract (§2.2,
    // E-02) refuses — done-vs-conflict, never a silent pass.
    const refused = refusedOutcome(run.outcomes);
    expect(refused.stepKey).toBe("hook:scan");
    expect(refused.detail).toMatch(/content-fingerprint-conflict/);
    expect(refused.detail).toContain("scan");
  });

  it("completes when two completions agree on the recorded content", () => {
    const attempt = executing([hookDecl("scan", "publish", "before")]);
    const ledger = new MemoryLedger();
    recordHookWithFingerprint(ledger, attempt, "scan", "content_sha256:stable");
    recordHookWithFingerprint(ledger, attempt, "scan", "content_sha256:stable");
    const run = scheduleHooks(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      new Map([["scan", recordingEffect()]]),
    );
    const completed = completedOutcome(run.outcomes);
    expect(completed.stepKey).toBe("hook:scan");
    expect(completed.record.contentFingerprint).toBe("content_sha256:stable");
  });
});

describe("determinism (§4.5): identical inputs, identical outcomes", () => {
  it("double-runs the scheduler byte-for-byte over fresh ledgers", () => {
    const declarations = [hookDecl("scan", "publish", "before", ["evidence-present"])];
    const run = (ledger: MemoryLedger): HooksRun => {
      const attempt = executing(declarations);
      const effect = recordingEffect({
        evidence: "scan-report:1",
        contentFingerprint: "content_sha256:r1",
      });
      return scheduleHooks(
        attempt,
        actor(attempt),
        ledger,
        heldClaim(attempt),
        new Map([["scan", effect]]),
      );
    };
    const first = run(new MemoryLedger());
    const second = run(new MemoryLedger());
    expect(second.outcomes).toStrictEqual(first.outcomes);
    expect(second.attempt).toStrictEqual(first.attempt);
  });
});
