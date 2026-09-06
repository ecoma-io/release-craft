import { describe, expect, it } from "vitest";

import {
  CANONICAL_STAGES,
  InvalidExecutionTransitionError,
  MemoryAttemptRegister,
  MemoryLedger,
  block,
  classifyCrash,
  classifyResume,
  crashClassify,
  ledgerRequestStep,
  openAttempt,
  start,
  type Attribution,
  type ClaimView,
  type ExternalSatisfaction,
  type LedgerRecord,
  type ReleaseAttempt,
  type StepKey,
  type StepRequest,
} from "../../src/index.js";

const executing = (): ReleaseAttempt =>
  start(
    openAttempt(new MemoryAttemptRegister(), {
      planId: "plan-alpha",
      planFingerprint: "plan_sha256:alpha",
    }),
  );

const actor = (attempt: ReleaseAttempt, who = "automation"): Attribution => ({
  attemptId: attempt.attemptId,
  actor: who,
});

const completion = (attempt: ReleaseAttempt, stepKey: StepKey): LedgerRecord => ({
  kind: "step",
  record: {
    attemptId: attempt.attemptId,
    stepKey,
    from: "started",
    to: "completed",
    guards: [],
    attribution: actor(attempt),
  },
});

/** Write-ahead records then completions for the tail's first `count`
 * stages — the ledger a crash left behind when it struck before stage
 * `count` ran. */
const completeStages = (ledger: MemoryLedger, attempt: ReleaseAttempt, count: number): void => {
  for (const stage of CANONICAL_STAGES.slice(0, count)) {
    ledger.appendStart(attempt, stage, actor(attempt));
    ledger.append(completion(attempt, stage));
  }
};

/** The kill-anywhere window: stages `[0, boundary)` recorded completed.
 * Boundary 0 keeps the plan record with the plan stage started-but-
 * unfinished — §2.2's recorded fingerprint half is the attempt's first
 * record, written write-ahead with its first start. */
const crashedBefore = (boundary: number): { attempt: ReleaseAttempt; ledger: MemoryLedger } => {
  const ledger = new MemoryLedger();
  const attempt1 = executing();
  completeStages(ledger, attempt1, boundary);
  if (boundary === 0) {
    ledger.appendStart(attempt1, "plan", actor(attempt1));
  }
  return { attempt: attempt1, ledger };
};

/** The unclassified crash (attempt.ts's `crashClassify`) over a tail whose
 * first `count` stages recorded completed. */
const crashedAfter = (count: number): { attempt: ReleaseAttempt; ledger: MemoryLedger } => {
  const ledger = new MemoryLedger();
  const attempt1 = crashClassify(executing());
  completeStages(ledger, attempt1, count);
  return { attempt: attempt1, ledger };
};

const request = (attempt: ReleaseAttempt, stepKey: StepKey): StepRequest => ({
  stepKey,
  attribution: actor(attempt),
});

const noClaims: ClaimView = { held: null, verify: () => false };

describe("classifyResume (§2.3): classification over the recorded tail, never recomputation", () => {
  it("classifies every crash window identically — resume from the first uncompleted stage (E-01, E-02)", () => {
    for (const [boundary, stage] of CANONICAL_STAGES.entries()) {
      const { attempt, ledger } = crashedBefore(boundary);
      const first = classifyResume(attempt, ledger);
      // Double-run: identical tails classify identically (§4 fixture 8).
      expect(classifyResume(attempt, ledger)).toStrictEqual(first);
      expect(first).toStrictEqual({ kind: "resume", from: stage });
    }
  });

  it("reruns a started-but-unfinished stage — the crash window between the record and the effect", () => {
    const { attempt, ledger } = crashedBefore(2);
    ledger.appendStart(attempt, "prepare", actor(attempt));
    expect(classifyResume(attempt, ledger)).toStrictEqual({ kind: "resume", from: "prepare" });
  });

  it("completes when every stage is recorded completed — the outcome follows the recorded steps", () => {
    const { attempt, ledger } = crashedBefore(CANONICAL_STAGES.length);
    expect(classifyResume(attempt, ledger)).toStrictEqual({
      kind: "complete",
      outcome: "published",
    });
  });

  it("completes satisfied-externally when the ledger recorded an external satisfaction for the attempt (E-03)", () => {
    const { attempt, ledger } = crashedBefore(CANONICAL_STAGES.length);
    const observed: ExternalSatisfaction = {
      attribution: actor(attempt, "human:maintainer"),
      evidence: "evidence:registry:release-page",
    };
    ledger.noteExternal({
      attemptId: attempt.attemptId,
      stepKey: "publish",
      satisfaction: observed,
    });
    expect(classifyResume(attempt, ledger)).toStrictEqual({
      kind: "complete",
      outcome: "satisfied-externally",
    });
  });

  it("returns stale when the carried fingerprint differs from the recorded one (E-05, PL-08)", () => {
    const ledger = new MemoryLedger();
    const attempt1 = executing();
    ledger.appendStart(attempt1, "plan", actor(attempt1));
    const carried = { ...attempt1, planFingerprint: "plan_sha256:recomputed" };
    const stale = classifyResume(carried, ledger);
    expect(stale.kind).toBe("stale");
    if (stale.kind !== "stale") {
      throw new Error("expected a stale outcome");
    }
    expect(stale.detail).toContain("E-05");
  });

  it("escalates when the tail holds no plan record — §2.2's recorded half is missing", () => {
    const ledger = new MemoryLedger();
    const attempt1 = executing();
    const unplanned = classifyResume(attempt1, ledger);
    expect(unplanned.kind).toBe("escalate");
    if (unplanned.kind !== "escalate") {
      throw new Error("expected a escalate outcome");
    }
    expect(unplanned.detail).toContain("no recorded plan fingerprint");
  });

  it("escalates a completed stage with no preceding started record — structurally corrupt (§2.3)", () => {
    const ledger = new MemoryLedger();
    const attempt1 = executing();
    ledger.appendStart(attempt1, "plan", actor(attempt1));
    ledger.append(completion(attempt1, "prepare"));
    const corrupt = classifyResume(attempt1, ledger);
    expect(corrupt.kind).toBe("escalate");
    if (corrupt.kind !== "escalate") {
      throw new Error("expected a escalate outcome");
    }
    expect(corrupt.detail).toContain("no preceding started record");
  });

  it("escalates a failed stage — crash classification's territory, not resume's (§2.4)", () => {
    const ledger = new MemoryLedger();
    const attempt1 = executing();
    completeStages(ledger, attempt1, 2);
    ledger.appendStart(attempt1, "prepare", actor(attempt1));
    ledger.append({
      kind: "step",
      record: {
        attemptId: attempt1.attemptId,
        stepKey: "prepare",
        from: "started",
        to: "failed",
        guards: [],
        attribution: actor(attempt1),
      },
    });
    const failed = classifyResume(attempt1, ledger);
    expect(failed.kind).toBe("escalate");
    if (failed.kind !== "escalate") {
      throw new Error("expected a escalate outcome");
    }
    expect(failed.detail).toContain("crash classification");
  });

  it("escalates a blocked attempt with no recorded resolution — resolveBlocked is the only re-arm door (E-04)", () => {
    const ledger = new MemoryLedger();
    const attempt1 = block(executing(), "precondition-delta");
    completeStages(ledger, attempt1, 1);
    const armed = classifyResume(attempt1, ledger);
    expect(armed.kind).toBe("escalate");
    if (armed.kind !== "escalate") {
      throw new Error("expected a escalate outcome");
    }
    expect(armed.detail).toContain("blocked without a recorded resolution");
  });

  it("resumes a blocked attempt re-armed by a revalidation under the stored plan (§2.7)", () => {
    const ledger = new MemoryLedger();
    const attempt1 = block(executing(), "precondition-delta");
    completeStages(ledger, attempt1, 1);
    ledger.append({
      kind: "resolution",
      attemptId: attempt1.attemptId,
      stepKey: "claim",
      resolution: { kind: "revalidation", planFingerprint: "plan_sha256:alpha" },
      attribution: actor(attempt1),
    });
    expect(classifyResume(attempt1, ledger)).toStrictEqual({ kind: "resume", from: "claim" });
  });

  it("resumes a blocked(unattributed-state) attempt re-armed by a human resolution (§2.7, E-06)", () => {
    const ledger = new MemoryLedger();
    const attempt1 = block(executing(), "unattributed-state");
    completeStages(ledger, attempt1, 1);
    ledger.append({
      kind: "resolution",
      attemptId: attempt1.attemptId,
      stepKey: "claim",
      resolution: { kind: "human", note: "unattributed state attributed by the maintainer" },
      attribution: actor(attempt1, "human:maintainer"),
    });
    expect(classifyResume(attempt1, ledger)).toStrictEqual({ kind: "resume", from: "claim" });
  });

  it("refuses a revalidation naming a different plan — append is public, classification fails closed (§2.7, E-05)", () => {
    const ledger = new MemoryLedger();
    const attempt1 = block(executing(), "precondition-delta");
    completeStages(ledger, attempt1, 1);
    ledger.append({
      kind: "resolution",
      attemptId: attempt1.attemptId,
      stepKey: "claim",
      resolution: { kind: "revalidation", planFingerprint: "plan_sha256:foreign" },
      attribution: actor(attempt1),
    });
    const outcome = classifyResume(attempt1, ledger);
    if (outcome.kind !== "escalate") throw new Error("expected an escalation");
    expect(outcome.detail).toContain("names a different plan");
  });

  it("refuses a human resolution over a precondition-delta block — humans answer unattributed-state (§2.7, E-06)", () => {
    const ledger = new MemoryLedger();
    const attempt1 = block(executing(), "precondition-delta");
    completeStages(ledger, attempt1, 1);
    ledger.append({
      kind: "resolution",
      attemptId: attempt1.attemptId,
      stepKey: "claim",
      resolution: { kind: "human", note: "not the right kind of answer" },
      attribution: actor(attempt1, "human:maintainer"),
    });
    const outcome = classifyResume(attempt1, ledger);
    if (outcome.kind !== "escalate") throw new Error("expected an escalation");
    expect(outcome.detail).toContain("only an unattributed-state block");
  });

  it("throws on a terminal attempt — terminal is terminal (§2.2)", () => {
    const { attempt, ledger } = crashedBefore(3);
    expect(() => classifyResume({ ...attempt, state: "published" }, ledger)).toThrow(
      InvalidExecutionTransitionError,
    );
  });
});

describe("classifyCrash (§2.4): E-01's doctrine over the tail plus the caller's observations", () => {
  it("tag recorded + plan valid → complete-in-place; the remaining stages finish", () => {
    const { attempt, ledger } = crashedAfter(6); // completed through tag
    expect(classifyCrash(attempt, ledger, { planValid: true })).toStrictEqual({
      kind: "complete-in-place",
      from: "publish",
    });
  });

  it("tag recorded + plan invalid → escalate; delete-tag vs repair is a recorded human decision", () => {
    const { attempt, ledger } = crashedAfter(6);
    const verdict = classifyCrash(attempt, ledger, { planValid: false });
    expect(verdict.kind).toBe("escalate");
    if (verdict.kind !== "escalate") {
      throw new Error("expected a escalate outcome");
    }
    expect(verdict.detail).toContain("no longer validates");
  });

  it("no tag + plan valid → resume from the first uncompleted stage", () => {
    const { attempt, ledger } = crashedAfter(2);
    expect(classifyCrash(attempt, ledger, { planValid: true })).toStrictEqual({
      kind: "resume",
      from: "prepare",
    });
  });

  it("no tag + plan invalid → void-and-skip, the recorded fallback when nothing durable was laid down", () => {
    const { attempt, ledger } = crashedAfter(2);
    expect(classifyCrash(attempt, ledger, { planValid: false })).toStrictEqual({
      kind: "void-and-skip",
    });
  });

  it("an externally observed tag satisfies the tag boundary without a recorded completion", () => {
    const { attempt, ledger } = crashedAfter(2);
    const observedTag: ExternalSatisfaction = {
      attribution: actor(attempt, "human:maintainer"),
      evidence: "evidence:git:tag/v1.2.3",
    };
    expect(classifyCrash(attempt, ledger, { planValid: true, observedTag })).toStrictEqual({
      kind: "complete-in-place",
      from: "prepare",
    });
    // The same tail without the observation resumes instead — the
    // observation, not the tail, moves the verdict across the boundary.
    expect(classifyCrash(attempt, ledger, { planValid: true })).toStrictEqual({
      kind: "resume",
      from: "prepare",
    });
  });

  it("throws on a non-failed attempt — the classifier's input is failed(unknown) alone (§2.4)", () => {
    const ledger = new MemoryLedger();
    const attempt1 = executing();
    expect(() => classifyCrash(attempt1, ledger, { planValid: true })).toThrow(
      InvalidExecutionTransitionError,
    );
  });

  it("refuses a failed attempt whose cause is already classified (§2.4)", () => {
    const { attempt, ledger } = crashedBefore(2);
    const follower: ReleaseAttempt = {
      ...attempt,
      state: "abandoned",
      terminalReason: "follower-of:attempt_sha256:b",
    };
    expect(() => classifyCrash(follower, ledger, { planValid: true })).toThrow(
      InvalidExecutionTransitionError,
    );
  });
});

describe("ledgerRequestStep (§2.8): the record-path replay door", () => {
  it("records the refusal for a step request against a terminal attempt — the throwing kernel's durable twin", () => {
    const { attempt, ledger } = crashedAfter(1);
    expect(ledgerRequestStep(attempt, request(attempt, "claim"), noClaims, ledger)).toStrictEqual({
      kind: "refused",
      stepKey: "claim",
      detail:
        "terminal attempt — recorded refusal (the record-path replay door, phase 5 contract §2.8)",
    });
  });

  it("delegates an open attempt's request to the kernel's classification — advance with the claim recorded", () => {
    const { attempt, ledger } = crashedBefore(1); // plan completed → claim is next
    const heldClaims: ClaimView = {
      held: {
        kind: "claim",
        scope: { kind: "release-line", lineId: "line-alpha" },
        token: "claim-token-1",
        holder: attempt.attemptId,
      },
      verify: () => true,
    };
    const outcome = ledgerRequestStep(attempt, request(attempt, "claim"), heldClaims, ledger);
    if (outcome.kind !== "advance") {
      throw new Error(`expected an advance outcome, got ${outcome.kind}`);
    }
    expect(outcome.record.stepKey).toBe("claim");
    expect(outcome.record.to).toBe("completed");
    expect(outcome.record.claim).toBe("claim-token-1");
  });

  it("delegates the guards too — a mutating stage without a claim is the kernel's recorded refusal", () => {
    const { attempt, ledger } = crashedBefore(1);
    expect(ledgerRequestStep(attempt, request(attempt, "claim"), noClaims, ledger)).toStrictEqual({
      kind: "refused",
      stepKey: "claim",
      detail: "mutation-without-claim",
    });
  });

  it("delegates replay of a completed step — proven same content is a noop, never a re-run (E-02)", () => {
    const ledger = new MemoryLedger();
    const attempt1 = executing();
    ledger.appendStart(attempt1, "plan", actor(attempt1), "content_sha256:plan-v1");
    ledger.append({
      kind: "step",
      record: {
        attemptId: attempt1.attemptId,
        stepKey: "plan",
        from: "started",
        to: "completed",
        guards: [],
        attribution: actor(attempt1),
        contentFingerprint: "content_sha256:plan-v1",
      },
    });
    expect(
      ledgerRequestStep(
        attempt1,
        { ...request(attempt1, "plan"), contentFingerprint: "content_sha256:plan-v1" },
        noClaims,
        ledger,
      ),
    ).toStrictEqual({ kind: "noop", stepKey: "plan" });
  });
});

describe("the amputated publication (§4 fixture 2, E-02): attempt B resumes the truncated attempt", () => {
  it("a register-allocated retry resumes mid-sequence, completes, and replays done-vs-conflict over fingerprints", () => {
    // A crashed mid-sequence; B is the retry the register allocates over
    // the same plan — a distinct attemptId, ordinal 2.
    const register = new MemoryAttemptRegister();
    const a = start(
      openAttempt(register, { planId: "plan-alpha", planFingerprint: "plan_sha256:alpha" }),
    );
    const b = start(
      openAttempt(register, { planId: "plan-alpha", planFingerprint: "plan_sha256:alpha" }),
    );
    expect(b.attemptId).not.toBe(a.attemptId);

    // B's ledger carries the amputated tail: five stages done, then the
    // crash window — classification offers the sixth stage, never a rerun.
    const ledger = new MemoryLedger();
    completeStages(ledger, b, 5);
    expect(classifyResume(b, ledger)).toStrictEqual({ kind: "resume", from: "tag" });

    // B finishes the release: the same double-run completes it.
    for (const stage of ["tag", "publish", "verify"] as const) {
      ledger.appendStart(b, stage, actor(b), `content_sha256:${stage}`);
      ledger.append({
        kind: "step",
        record: {
          attemptId: b.attemptId,
          stepKey: stage,
          from: "started",
          to: "completed",
          guards: [],
          attribution: actor(b),
          contentFingerprint: `content_sha256:${stage}`,
        },
      });
    }
    expect(classifyResume(b, ledger)).toStrictEqual({ kind: "complete", outcome: "published" });

    // Per-step done-vs-conflict over fingerprints: the same content replays
    // as a noop; different content for the same step is a recorded conflict.
    const same = ledgerRequestStep(
      b,
      { ...request(b, "publish"), contentFingerprint: "content_sha256:publish" },
      noClaims,
      ledger,
    );
    expect(same).toStrictEqual({ kind: "noop", stepKey: "publish" });
    const changed = ledgerRequestStep(
      b,
      { ...request(b, "publish"), contentFingerprint: "content_sha256:other" },
      noClaims,
      ledger,
    );
    if (changed.kind !== "conflict") throw new Error("expected a conflict");
    expect(changed.stepKey).toBe("publish");
  });
});
