import { describe, expect, it } from "vitest";

import {
  MemoryAttemptRegister,
  MemoryLedger,
  openAttempt,
  scheduleArtifacts,
  scheduleHooks,
  start,
  type ArtifactProducer,
  type ArtifactStep,
  type Attribution,
  type Claim,
  type ClaimView,
  type HookEffect,
  type HookStep,
  type LedgerRecord,
  type ReleaseAttempt,
  type StageKey,
} from "../../src/index.js";

const PLAN = { planId: "plan-alpha", planFingerprint: "plan_sha256:alpha" };

const planned = (
  hooks?: readonly HookStep[],
  artifacts?: readonly ArtifactStep[],
): ReleaseAttempt => openAttempt(new MemoryAttemptRegister(), PLAN, hooks, artifacts);

const executing = (
  hooks?: readonly HookStep[],
  artifacts?: readonly ArtifactStep[],
): ReleaseAttempt => start(planned(hooks, artifacts));

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

const hookDecl = (id: string, stage: StageKey, position: "before" | "after"): HookStep => ({
  id,
  anchor: { stage, position },
  guard: "release-line",
  postconditions: [],
});

const artifactDecl = (): ArtifactStep => ({
  id: "sbom",
  anchor: { stage: "commit", position: "after" },
  guard: "release-line",
  kind: "sbom",
  coordinates: "sbom:line-1",
  dependsOn: [],
  postconditions: [],
});

const throwingEffect: HookEffect = () => {
  throw new Error("the crash window: the effect never ran");
};

const throwingProducer: ArtifactProducer = () => {
  throw new Error("the crash window: the producer never ran");
};

describe("write-ahead dedup (§2.2; ADR-0006 decision 2): one start per execution", () => {
  it("a retried write-ahead start after a crash does not duplicate", () => {
    const hooks = [hookDecl("notify", "prepare", "before")];
    const attempt = executing(hooks);
    const ledger = new MemoryLedger();
    const effect: HookEffect = () => ({
      attribution: actor(attempt),
      evidence: "evidence:hook:done",
    });

    // First pass: the write-ahead start lands, then the crash kills the
    // process before the effect ran — the effect throws (the crash
    // window), leaving the started record durable.
    expect(() =>
      scheduleHooks(
        attempt,
        actor(attempt),
        ledger,
        heldClaim(attempt),
        new Map(Object.entries({ notify: throwingEffect })),
      ),
    ).toThrow("the crash window");

    // The crash left exactly one started record.
    const startedAfterCrash = ledger
      .tail(attempt.attemptId)
      .filter(
        (
          record,
        ): record is LedgerRecord & { kind: "step"; record: { stepKey: string; to: string } } =>
          record.kind === "step" && record.record.to === "started",
      );
    expect(startedAfterCrash).toHaveLength(1);

    const run = scheduleHooks(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      new Map(Object.entries({ notify: effect })),
    );
    expect(run.outcomes).toHaveLength(1);
    expect(run.outcomes[0]?.kind).toBe("completed");

    // The tail holds exactly ONE started record for this step — the
    // resume reused the crash's start instead of appending a second one.
    const startedRecords = ledger
      .tail(attempt.attemptId)
      .filter(
        (
          record,
        ): record is LedgerRecord & { kind: "step"; record: { stepKey: string; to: string } } =>
          record.kind === "step" &&
          record.record.to === "started" &&
          record.record.stepKey === "hook:notify",
      );
    expect(startedRecords).toHaveLength(1);

    // The full tail: one start, one completion — never start, start, complete.
    const stepTails = ledger
      .tail(attempt.attemptId)
      .filter(
        (record): record is LedgerRecord & { kind: "step" } =>
          record.kind === "step" && record.record.stepKey === "hook:notify",
      );
    expect(stepTails.map((r) => r.record.to)).toStrictEqual(["started", "completed"]);
  });

  it("an artifact step's retried write-ahead start after a crash does not duplicate", () => {
    const attempt = executing(undefined, [artifactDecl()]);
    const ledger = new MemoryLedger();
    const producer: ArtifactProducer = (input) => ({
      attribution: actor(attempt),
      digest: `digest:${input.artifactId}:done`,
    });

    // First pass: the write-ahead start lands, then the crash kills the
    // process before the producer ran — the producer throws (the crash
    // window), leaving the started record durable.
    expect(() =>
      scheduleArtifacts(
        attempt,
        actor(attempt),
        ledger,
        heldClaim(attempt),
        new Map(Object.entries({ sbom: throwingProducer })),
      ),
    ).toThrow("the crash window");
    expect(ledger.step(attempt.attemptId, "artifact:sbom")).toBe("started");

    // The resume reuses the crash's start: the producer runs exactly
    // once more, and the tail holds one start, one completion — never
    // start, start, complete.
    const run = scheduleArtifacts(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      new Map(Object.entries({ sbom: producer })),
    );
    expect(run.outcomes).toHaveLength(1);
    expect(run.outcomes[0]?.kind).toBe("completed");
    const stepTails = ledger
      .tail(attempt.attemptId)
      .filter(
        (record): record is LedgerRecord & { kind: "step" } =>
          record.kind === "step" && record.record.stepKey === "artifact:sbom",
      );
    expect(stepTails.map((r) => r.record.to)).toStrictEqual(["started", "completed"]);
  });
});
