import { describe, expect, it } from "vitest";

import {
  InvalidExecutionTransitionError,
  MemoryAttemptRegister,
  MemoryDispositionStore,
  MemoryLedger,
  adopt,
  contentFingerprint,
  openAttempt,
  start,
  verifyEvidence,
  type Attribution,
  type ReleaseAttempt,
  type StageKey,
} from "../../src/index.js";

const attempt = (register: MemoryAttemptRegister): ReleaseAttempt =>
  start(openAttempt(register, { planId: "plan-alpha", planFingerprint: "plan_sha256:alpha" }));

const actor = (attemptId: string, who: Attribution["actor"]): Attribution => ({
  attemptId,
  actor: who,
});

/** Completes `who`'s step in the ledger over a real content fingerprint
 * (§2.6's canonicalization); returns the fingerprint both sides of the
 * evidence pair quote. */
const completeStep = (
  ledger: MemoryLedger,
  who: ReleaseAttempt,
  stepKey: StageKey,
  inputs: Record<string, string>,
): string => {
  const fingerprint = contentFingerprint(inputs);
  const attribution = actor(who.attemptId, "automation");
  ledger.appendStart(who, stepKey, attribution, fingerprint);
  ledger.append({
    kind: "step",
    record: {
      attemptId: who.attemptId,
      stepKey,
      from: "started",
      to: "completed",
      guards: [],
      attribution,
      contentFingerprint: fingerprint,
    },
  });
  return fingerprint;
};

describe("verifyEvidence (phase 5 §2.6)", () => {
  it("verifies when both fingerprints are present and equal", () => {
    expect(verifyEvidence("content_sha256:aa", "content_sha256:aa")).toEqual({ kind: "verified" });
  });

  it("conflicts when both are present and different — naming both sides", () => {
    const verdict = verifyEvidence("content_sha256:aa", "content_sha256:bb");
    expect(verdict.kind).toBe("conflict");
    if (verdict.kind !== "conflict") {
      throw new Error("expected a conflict verdict");
    }
    expect(verdict.detail).toContain("content_sha256:aa");
    expect(verdict.detail).toContain("content_sha256:bb");
  });

  it("conflicts on a one-sided pair — a missing side is a disagreement", () => {
    expect(verifyEvidence("content_sha256:aa", undefined).kind).toBe("conflict");
    expect(verifyEvidence(undefined, "content_sha256:bb").kind).toBe("conflict");
  });

  it("is unverified when both sides are absent", () => {
    expect(verifyEvidence(undefined, undefined)).toEqual({ kind: "unverified" });
  });
});

describe("adoption (phase 5 §2.5, E-06, AR-05, AR-06)", () => {
  it("adopts foreign evidenced, fingerprint-matching work — exactly one absorption record (E-06, AR-05)", () => {
    const register = new MemoryAttemptRegister();
    const ledger = new MemoryLedger();
    const source = attempt(register);
    const adopting = attempt(register);
    const fingerprint = completeStep(ledger, source, "publish", { version: "1.5.0" });
    const sourceTailBefore = ledger.tail(source.attemptId);
    const dispositions = new MemoryDispositionStore();

    const outcome = adopt(
      adopting,
      "publish",
      source.attemptId,
      ledger,
      {
        attribution: actor(source.attemptId, "human:maintainer"),
        evidence: "evidence:git:abc123",
        contentFingerprint: fingerprint,
      },
      dispositions,
    );

    expect(outcome).toEqual({
      kind: "adopted",
      record: {
        kind: "absorption",
        attemptId: adopting.attemptId,
        stepKey: "publish",
        adoptedFrom: source.attemptId,
        evidence: "evidence:git:abc123",
        attribution: { attemptId: source.attemptId, actor: "human:maintainer" },
      },
    });
    // The adopting ledger gains exactly four records — decision 6's
    // completed work (the plan record, the write-ahead start, and the
    // completion) plus the absorption naming the source.
    const adoptingTail = ledger.tail(adopting.attemptId);
    expect(adoptingTail.length).toBe(4);
    expect(adoptingTail.map((record) => record.kind)).toStrictEqual([
      "plan",
      "step",
      "step",
      "absorption",
    ]);
    const completion = adoptingTail[2];
    if (completion?.kind !== "step") throw new Error("expected the completion record");
    expect(completion.record.to).toBe("completed");
    expect(completion.record.attribution).toStrictEqual({
      attemptId: source.attemptId,
      actor: "human:maintainer",
    });
    expect(completion.record.contentFingerprint).toBe(fingerprint);
    // Verified adoption leaves no disposition behind and never touches the
    // source attempt's tail.
    expect(dispositions.entries()).toEqual([]);
    expect(ledger.tail(source.attemptId)).toEqual(sourceTailBefore);
  });

  it("stale draft overwrite: conflicting fingerprint escalates, observation preserved verbatim (AR-06)", () => {
    const register = new MemoryAttemptRegister();
    const ledger = new MemoryLedger();
    const source = attempt(register);
    const adopting = attempt(register);
    completeStep(ledger, source, "publish", { version: "1.5.0" });
    const dispositions = new MemoryDispositionStore();

    const outcome = adopt(
      adopting,
      "publish",
      source.attemptId,
      ledger,
      {
        attribution: actor(source.attemptId, "human:maintainer"),
        evidence: "evidence:git:stale-draft",
        contentFingerprint: contentFingerprint({ version: "1.5.1" }),
      },
      dispositions,
      "2026-03-02T12:00:00Z",
    );

    expect(outcome.kind).toBe("escalated");
    if (outcome.kind !== "escalated") {
      throw new Error("expected an escalated outcome");
    }
    expect(outcome.detail).toContain("content fingerprints disagree");
    const [entry] = dispositions.entries();
    expect(entry).toEqual({
      kind: "unattributed-state",
      where: `attempt:${source.attemptId}/step:publish`,
      evidence: "evidence:git:stale-draft",
      attribution: { attemptId: source.attemptId, actor: "human:maintainer" },
      recordedAt: "2026-03-02T12:00:00Z",
    });
    expect(Object.isFrozen(entry)).toBe(true);
    // No absorption anywhere: the pre-overwrite state stands, recorded only.
    expect(ledger.tail(adopting.attemptId)).toEqual([]);
  });

  it("unverified: no fingerprints on either side escalates without adoption", () => {
    const register = new MemoryAttemptRegister();
    const ledger = new MemoryLedger();
    const source = attempt(register);
    const adopting = attempt(register);
    // A completed record without the §2.6 fingerprint: presence-only done-ness.
    const attribution = actor(source.attemptId, "automation");
    ledger.appendStart(source, "publish", attribution);
    ledger.append({
      kind: "step",
      record: {
        attemptId: source.attemptId,
        stepKey: "publish",
        from: "started",
        to: "completed",
        guards: [],
        attribution,
      },
    });
    const dispositions = new MemoryDispositionStore();

    const outcome = adopt(
      adopting,
      "publish",
      source.attemptId,
      ledger,
      {
        attribution: actor(source.attemptId, "human:maintainer"),
        evidence: "evidence:git:unverified",
      },
      dispositions,
    );

    expect(outcome.kind).toBe("escalated");
    if (outcome.kind !== "escalated") {
      throw new Error("expected an escalated outcome");
    }
    expect(outcome.detail).toContain("unverified");
    expect(dispositions.entries()).toEqual([
      {
        kind: "unattributed-state",
        where: `attempt:${source.attemptId}/step:publish`,
        evidence: "evidence:git:unverified",
        attribution: { attemptId: source.attemptId, actor: "human:maintainer" },
      },
    ]);
    expect(ledger.tail(adopting.attemptId)).toEqual([]);
  });

  it("source-missing: no completed source record escalates as orphan-state — bare existence never adopts", () => {
    const register = new MemoryAttemptRegister();
    const ledger = new MemoryLedger();
    const source = attempt(register);
    const adopting = attempt(register);
    // Started, never completed: the step's bare existence is not evidence.
    ledger.appendStart(source, "publish", actor(source.attemptId, "automation"));
    const dispositions = new MemoryDispositionStore();

    const startedOnly = adopt(
      adopting,
      "publish",
      source.attemptId,
      ledger,
      {
        attribution: actor(source.attemptId, "human:maintainer"),
        evidence: "evidence:git:orphan",
      },
      dispositions,
    );
    expect(startedOnly.kind).toBe("escalated");
    if (startedOnly.kind !== "escalated") {
      throw new Error("expected an escalated outcome");
    }
    expect(startedOnly.detail).toContain("bare existence never adopts");

    const unknownSource = adopt(
      adopting,
      "publish",
      "attempt_sha256:ghost",
      ledger,
      {
        attribution: actor(adopting.attemptId, "human:maintainer"),
        evidence: "evidence:git:ghost",
      },
      dispositions,
    );
    expect(unknownSource.kind).toBe("escalated");

    expect(dispositions.entries().map((entry) => entry.kind)).toEqual([
      "orphan-state",
      "orphan-state",
    ]);
    expect(dispositions.entries()[0]?.evidence).toBe("evidence:git:orphan");
    expect(ledger.tail(adopting.attemptId)).toEqual([]);
  });

  it("throws on an empty actor — attribution is §2.6's non-empty identity", () => {
    const register = new MemoryAttemptRegister();
    const ledger = new MemoryLedger();
    const source = attempt(register);
    const adopting = attempt(register);
    const dispositions = new MemoryDispositionStore();

    expect(() =>
      adopt(
        adopting,
        "publish",
        source.attemptId,
        ledger,
        { attribution: actor(source.attemptId, ""), evidence: "evidence:git:abc123" },
        dispositions,
      ),
    ).toThrow(InvalidExecutionTransitionError);
    // The refusal precedes any recording: nothing landed anywhere.
    expect(dispositions.entries()).toEqual([]);
    expect(ledger.tail(adopting.attemptId)).toEqual([]);
  });
});

describe("the disposition dispositions (phase 5 §2.5, E-09)", () => {
  it("appends frozen entries in order behind a copy — the only way in is record", () => {
    const dispositions = new MemoryDispositionStore();
    dispositions.record({
      kind: "orphan-tag",
      where: "dispositions/ref/tags/v1.5.0",
      evidence: "evidence:git:abc123",
      attribution: actor("attempt_sha256:a", "automation"),
    });
    dispositions.record({
      kind: "stale-draft",
      where: "dispositions/ref/drafts/v1.5.1",
      evidence: "evidence:git:def456",
      attribution: actor("attempt_sha256:a", "human:maintainer"),
    });

    const entries = dispositions.entries();
    expect(entries.map((entry) => entry.kind)).toEqual(["orphan-tag", "stale-draft"]);
    expect(Object.isFrozen(entries[0])).toBe(true);
    expect(Object.isFrozen(entries[0]?.attribution)).toBe(true);
    // A fresh array per call: callers cannot mutate the recorded order.
    expect(dispositions.entries()).not.toBe(entries);
  });
});
