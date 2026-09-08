import { describe, expect, it } from "vitest";

import {
  MemoryAttemptRegister,
  MemoryLedger,
  openAttempt,
  start,
  contentFingerprint,
  type Attribution,
  type LedgerRecord,
  type ReleaseAttempt,
} from "../../src/index.js";

const attempt = (): ReleaseAttempt =>
  start(
    openAttempt(new MemoryAttemptRegister(), {
      planId: "plan-alpha",
      planFingerprint: "plan_sha256:alpha",
    }),
  );

const actor = (who: Attribution["actor"]): Attribution => ({
  attemptId: "attempt_sha256:a",
  actor: who,
});

describe("the memory ledger (phase 5 §2.1–§2.2)", () => {
  it("writes the plan record once, then the step start — write-ahead", () => {
    const ledger = new MemoryLedger();
    const attempt1 = attempt();
    const started = ledger.appendStart(attempt1, "plan", actor("automation"), "content_sha256:x");

    expect(started.to).toBe("started");
    expect(ledger.planFingerprint(attempt1.attemptId)).toBe("plan_sha256:alpha");
    expect(ledger.step(attempt1.attemptId, "plan")).toBe("started");
    expect(ledger.tail(attempt1.attemptId).length).toBe(2);
    expect(ledger.tail(attempt1.attemptId)[0]?.kind).toBe("plan");

    // The plan record is the attempt's FIRST record and is written once.
    ledger.appendStart(attempt1, "claim", actor("automation"));
    const tail = ledger.tail(attempt1.attemptId);
    expect(tail.filter((record) => record.kind === "plan").length).toBe(1);
  });

  it("reports `none` before anything is recorded", () => {
    const ledger = new MemoryLedger();
    const attempt1 = attempt();
    expect(ledger.step(attempt1.attemptId, "prepare")).toBe("none");
    expect(ledger.planFingerprint(attempt1.attemptId)).toBeNull();
  });

  it("deep-freezes appended records — nothing edits one", () => {
    const ledger = new MemoryLedger();
    const attempt1 = attempt();
    ledger.appendStart(attempt1, "plan", actor("automation"));

    const absorption: LedgerRecord = {
      kind: "absorption",
      attemptId: attempt1.attemptId,
      stepKey: "prepare",
      adoptedFrom: "attempt_sha256:ghost",
      evidence: "evidence:registry:metadata",
      attribution: actor("automation"),
    };
    const stored = ledger.append(absorption);
    if (stored.kind !== "absorption") {
      throw new Error("expected an absorption record, not a step record");
    }
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.attribution)).toBe(true);

    const stepRecord = ledger.tail(attempt1.attemptId).find((record) => record.kind === "step");
    if (stepRecord?.kind !== "step") {
      throw new Error("expected a step record in the tail");
    }
    expect(Object.isFrozen(stepRecord.record)).toBe(true);
    expect(Object.isFrozen(stepRecord.record.guards)).toBe(true);
    expect(Object.isFrozen(stepRecord.record.attribution)).toBe(true);
  });

  it("replays through the kernel's step view", () => {
    const ledger = new MemoryLedger();
    const attempt1 = attempt();
    ledger.appendStart(attempt1, "plan", actor("automation"), "content_sha256:x");
    const view = ledger.stepView();

    expect(view.state(attempt1.attemptId, "plan")).toBe("started");
    expect(view.completed(attempt1.attemptId, "plan")).toBeNull();
    expect(view.external(attempt1.attemptId, "plan")).toBeNull();

    ledger.noteExternal({
      attemptId: attempt1.attemptId,
      stepKey: "prepare",
      satisfaction: {
        attribution: actor("human:maintainer"),
        evidence: "evidence:git:abc123",
        contentFingerprint: "content_sha256:prepare",
      },
    });
    expect(view.external(attempt1.attemptId, "prepare")?.evidence).toBe("evidence:git:abc123");
  });

  it("derives deterministic content fingerprints over canonical inputs", () => {
    const first = contentFingerprint({ commit: "abc123", version: "1.5.0" });
    const second = contentFingerprint({ version: "1.5.0", commit: "abc123" });
    expect(first).toBe(second);
    expect(first.startsWith("content_sha256:")).toBe(true);
    expect(contentFingerprint({ commit: "abc123", version: "1.5.1" })).not.toBe(first);
  });
});
