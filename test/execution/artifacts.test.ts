import { describe, expect, it } from "vitest";

import {
  MemoryAttemptRegister,
  MemoryLedger,
  classifyResume,
  effectiveSteps,
  artifactStepKey,
  generationComplete,
  openAttempt,
  recordedArtifact,
  requestStep,
  resolveBlocked,
  scheduleArtifacts,
  start,
  type ArtifactOutcome,
  type ArtifactObservation,
  type ArtifactProducer,
  type ArtifactProducerInput,
  type ArtifactStep,
  type Attribution,
  type Claim,
  type ClaimView,
  type HookStep,
  type PostconditionKind,
  type ReleaseAttempt,
  type StageKey,
  type StepKey,
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

const noClaims: ClaimView = { held: null, verify: () => false };

const hookDecl = (id: string, stage: StageKey, position: "before" | "after"): HookStep => ({
  id,
  anchor: { stage, position },
  guard: "release-line",
  postconditions: [],
});

const artifactDecl = (
  id: string,
  stage: StageKey,
  position: "before" | "after",
  options: Partial<ArtifactStep> = {},
): ArtifactStep => ({
  id,
  anchor: { stage, position },
  guard: options.guard ?? "release-line",
  kind: options.kind ?? "npm-tarball",
  coordinates: options.coordinates ?? `registry.example/acme/${id}`,
  dependsOn: options.dependsOn ?? [],
  postconditions: options.postconditions ?? [],
});

/** A producer that records its seam inputs and returns a fixed
 * observation — the caller's code lives outside the engine; the engine
 * only invokes. */
const recordingProducer = (
  over: Partial<ArtifactObservation> = {},
): ArtifactProducer & { calls: ArtifactProducerInput[] } => {
  const calls: ArtifactProducerInput[] = [];
  const run = (input: ArtifactProducerInput): ArtifactObservation => {
    calls.push(input);
    return {
      attribution: { attemptId: input.attemptId, actor: "automation" },
      digest: `digest_sha256:${input.artifactId}`,
      ...over,
    };
  };
  const producer = run as ArtifactProducer & { calls: ArtifactProducerInput[] };
  producer.calls = calls;
  return producer;
};

/** The recorded artifact completion a full scheduler pass leaves behind —
 * rebuilt by hand for the kill-anywhere and conflict fixtures, exactly as
 * the ledger truncation leaves it: write-ahead start, then the completed
 * generation record with the triple verbatim. */
const recordArtifact = (
  ledger: MemoryLedger,
  attempt: ReleaseAttempt,
  id: string,
  digest = `digest_sha256:${id}`,
): void => {
  const stepKey = artifactStepKey(id);
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
      artifact: { kind: "npm-tarball", coordinates: `registry.example/acme/${id}`, digest },
      contentFingerprint: digest,
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
  outcomes: readonly ArtifactOutcome[],
): Extract<ArtifactOutcome, { readonly kind: "completed" }> => {
  const completed = outcomes.find((outcome) => outcome.kind === "completed");
  if (completed === undefined) {
    throw new Error("expected a completed artifact outcome");
  }
  return completed;
};

const refusedOutcome = (
  outcomes: readonly ArtifactOutcome[],
): Extract<ArtifactOutcome, { readonly kind: "refused" }> => {
  const refused = outcomes.find((outcome) => outcome.kind === "refused");
  if (refused === undefined) {
    throw new Error("expected a refused artifact outcome");
  }
  return refused;
};

const failedOutcome = (
  outcomes: readonly ArtifactOutcome[],
): Extract<ArtifactOutcome, { readonly kind: "failed" }> => {
  const failed = outcomes.find((outcome) => outcome.kind === "failed");
  if (failed === undefined) {
    throw new Error("expected a failed artifact outcome");
  }
  return failed;
};

describe("attachment and ordering (§2.1, fixture 1): the closed three and the named tie", () => {
  it("interleaves artifact steps at their anchors, hooks preceding them at a shared anchor", () => {
    const attempt = executing(
      [hookDecl("scan", "publish", "before"), hookDecl("receipt", "tag", "after")],
      [
        artifactDecl("bundle", "publish", "before"),
        artifactDecl("sbom", "validate", "after"),
        artifactDecl("notes", "publish", "after"),
      ],
    );
    expect(effectiveSteps(attempt)).toStrictEqual([
      "plan",
      "claim",
      "prepare",
      "validate",
      "artifact:sbom",
      "commit",
      "tag",
      "hook:receipt",
      "hook:scan",
      "artifact:bundle",
      "publish",
      "artifact:notes",
      "verify",
    ]);
  });

  it("attaches artifacts without moving the plan fingerprint or the attempt identity", () => {
    const bare = planned();
    const decorated = planned(undefined, [artifactDecl("bundle", "publish", "after")]);
    expect(decorated.planFingerprint).toBe(bare.planFingerprint);
    expect(decorated.attemptId).toBe(bare.attemptId);
    expect(decorated.planId).toBe(bare.planId);
  });

  it("refuses at the door: duplicate ids, unknown anchors, unknown postconditions, padded labels", () => {
    expect(() =>
      planned(undefined, [
        artifactDecl("bundle", "publish", "before"),
        artifactDecl("bundle", "tag", "before"),
      ]),
    ).toThrow(/duplicate artifact id/);
    expect(() =>
      openAttempt(new MemoryAttemptRegister(), PLAN, undefined, [
        {
          id: "x",
          anchor: { stage: "release" as StageKey, position: "before" },
          guard: "g",
          kind: "k",
          coordinates: "c",
          dependsOn: [],
          postconditions: [],
        },
      ]),
    ).toThrow(/not one of the canonical eight/);
    expect(() =>
      openAttempt(new MemoryAttemptRegister(), PLAN, undefined, [
        {
          id: "x",
          anchor: { stage: "tag", position: "before" },
          guard: "g",
          kind: "k",
          coordinates: "c",
          dependsOn: [],
          postconditions: ["world-peace" as PostconditionKind],
        },
      ]),
    ).toThrow(/unknown postcondition/);
    expect(() =>
      planned(undefined, [artifactDecl("bundle", "publish", "before", { kind: " padded" })]),
    ).toThrow(/empty or padded/);
    expect(() =>
      planned(undefined, [artifactDecl("bundle", "publish", "before", { coordinates: "c " })]),
    ).toThrow(/empty or padded/);
    expect(() =>
      planned(undefined, [artifactDecl("bundle", "publish", "before", { guard: "" })]),
    ).toThrow(/blank guard/);
  });
});

describe("generation immutability (§2.3, fixture 2): the triple, recorded forever", () => {
  it("records the declared triple verbatim and answers replay from the projection", () => {
    const attempt = executing(undefined, [
      artifactDecl("bundle", "publish", "after", { postconditions: ["evidence-present"] }),
    ]);
    const ledger = new MemoryLedger();
    const run = scheduleArtifacts(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      new Map([["bundle", recordingProducer({ evidence: "bundle-report:1" })]]),
    );
    const completed = completedOutcome(run.outcomes);
    expect(completed.stepKey).toBe("artifact:bundle");
    expect(completed.record.artifact).toStrictEqual({
      kind: "npm-tarball",
      coordinates: "registry.example/acme/bundle",
      digest: "digest_sha256:bundle",
    });
    // The digest is the content identity: it is the record's fingerprint
    // too (§2.3 — there is no second fingerprint field).
    expect(completed.record.contentFingerprint).toBe("digest_sha256:bundle");
    expect(completed.record.evidence).toBe("bundle-report:1");
    expect(recordedArtifact(ledger, attempt.attemptId, "artifact:bundle")).toStrictEqual(
      completed.record.artifact,
    );
    expect(generationComplete(attempt, ledger)).toBe(true);
  });

  it("keeps a finished generation beside a rebuild's new one, neither record changed", () => {
    const register = new MemoryAttemptRegister();
    const first = start(
      openAttempt(register, PLAN, undefined, [artifactDecl("bundle", "publish", "after")]),
    );
    const ledger = new MemoryLedger();
    scheduleArtifacts(
      first,
      actor(first),
      ledger,
      heldClaim(first),
      new Map([["bundle", recordingProducer()]]),
    );
    const oldRecords = ledger.tail(first.attemptId);
    expect(oldRecords.length).toBeGreaterThan(0);
    // The rebuild: same plan identity, new attempt — a new generation.
    const second = start(
      openAttempt(register, PLAN, undefined, [artifactDecl("bundle", "publish", "after")]),
    );
    expect(second.attemptId).not.toBe(first.attemptId);
    scheduleArtifacts(
      second,
      actor(second),
      ledger,
      heldClaim(second),
      new Map([["bundle", recordingProducer()]]),
    );
    // The old generation's tail is untouched; the new one lands beside
    // it — the pair carries both digests.
    expect(ledger.tail(first.attemptId)).toStrictEqual(oldRecords);
    const tail = ledger.tail(second.attemptId);
    const digests = [...oldRecords, ...tail].flatMap((appended) =>
      appended.kind === "step" && appended.record.artifact !== undefined
        ? [`${appended.record.attemptId}:${appended.record.artifact.digest}`]
        : [],
    );
    expect(digests).toStrictEqual([
      `${first.attemptId}:digest_sha256:bundle`,
      `${second.attemptId}:digest_sha256:bundle`,
    ]);
  });
});

describe("the declared DAG (§2.4, fixture 3): refusal without a proof, digests with one", () => {
  it("refuses a step whose dependency lacks its proof — no record, walk stopped", () => {
    const attempt = executing(undefined, [
      artifactDecl("bundle", "publish", "after", { dependsOn: ["sbom"] }),
      artifactDecl("sbom", "publish", "after"),
    ]);
    const ledger = new MemoryLedger();
    const run = scheduleArtifacts(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      new Map([
        ["bundle", recordingProducer()],
        ["sbom", recordingProducer()],
      ]),
    );
    const refused = refusedOutcome(run.outcomes);
    expect(refused.stepKey).toBe("artifact:bundle");
    expect(refused.detail).toContain("dependency-unrecorded");
    expect(refused.detail).toContain("sbom");
    expect(run.outcomes).toHaveLength(1);
    expect(ledger.step(attempt.attemptId, "artifact:bundle")).toBe("none");
    expect(ledger.tail(attempt.attemptId)).toHaveLength(0);
  });

  it("carries the satisfied dependency's digests verbatim on the completion record", () => {
    const attempt = executing(undefined, [
      artifactDecl("sbom", "publish", "after"),
      artifactDecl("bundle", "publish", "after", { dependsOn: ["sbom"] }),
    ]);
    const ledger = new MemoryLedger();
    const run = scheduleArtifacts(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      new Map([
        ["sbom", recordingProducer()],
        ["bundle", recordingProducer()],
      ]),
    );
    expect(run.outcomes).toHaveLength(2);
    const bundle = run.outcomes.find(
      (outcome) => outcome.kind === "completed" && outcome.artifactId === "bundle",
    );
    if (bundle === undefined || bundle.kind !== "completed") {
      throw new Error("expected the bundle completion");
    }
    expect(bundle.record.dependsOn).toStrictEqual([
      { artifactId: "sbom", digest: "digest_sha256:sbom" },
    ]);
  });

  it("refuses at the door: undeclared siblings, cycles, and duplicated edges", () => {
    expect(() =>
      planned(undefined, [artifactDecl("bundle", "publish", "after", { dependsOn: ["ghost"] })]),
    ).toThrow(/not a declared sibling/);
    expect(() =>
      planned(undefined, [
        artifactDecl("a", "publish", "after", { dependsOn: ["b"] }),
        artifactDecl("b", "publish", "after", { dependsOn: ["a"] }),
      ]),
    ).toThrow(/cycle: a → b → a/);
    expect(() =>
      planned(undefined, [
        artifactDecl("bundle", "publish", "after", { dependsOn: ["sbom", "sbom"] }),
        artifactDecl("sbom", "publish", "after"),
      ]),
    ).toThrow(/duplicated dependsOn edge/);
  });
});

describe("digest reconciliation and kill-anywhere (§2.4, fixture 4)", () => {
  it("replays a completed artifact step — never re-executed, no producer needed", () => {
    const attempt = executing(undefined, [artifactDecl("bundle", "publish", "after")]);
    const ledger = new MemoryLedger();
    const first = scheduleArtifacts(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      new Map([["bundle", recordingProducer()]]),
    );
    expect(first.outcomes).toHaveLength(1);
    const before = ledger.tail(attempt.attemptId).length;
    // No producer is injected at all: replay answers from the projection.
    const replay = scheduleArtifacts(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      new Map(),
    );
    const completed = completedOutcome(replay.outcomes);
    const stored = ledger.stepView().completed(attempt.attemptId, "artifact:bundle");
    expect(stored === null ? null : completed.record).toStrictEqual(stored);
    expect(ledger.tail(attempt.attemptId)).toHaveLength(before);
  });

  it("refuses a differing digest on the same key — a conflict, never a silent pass", () => {
    const attempt = executing(undefined, [artifactDecl("bundle", "publish", "after")]);
    const ledger = new MemoryLedger();
    recordArtifact(ledger, attempt, "bundle", "digest_sha256:first");
    ledger.append({
      kind: "step",
      record: {
        attemptId: attempt.attemptId,
        stepKey: "artifact:bundle",
        from: "started",
        to: "completed",
        guards: [{ guard: "release-line", passed: true }],
        attribution: actor(attempt),
        artifact: {
          kind: "npm-tarball",
          coordinates: "registry.example/acme/bundle",
          digest: "digest_sha256:second",
        },
        contentFingerprint: "digest_sha256:second",
      },
    });
    const run = scheduleArtifacts(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      new Map([["bundle", recordingProducer()]]),
    );
    const refused = refusedOutcome(run.outcomes);
    expect(refused.artifactId).toBe("bundle");
    expect(refused.detail).toContain("digest-conflict");
  });

  it("classifies every truncation identically under double-run, artifact boundaries included", () => {
    const HOOKS = [hookDecl("scan", "publish", "before")];
    const ARTIFACTS = [artifactDecl("bundle", "publish", "after")];
    const sequence = effectiveSteps(executing(HOOKS, ARTIFACTS));
    for (const [boundary] of sequence.entries()) {
      const attempt = executing(HOOKS, ARTIFACTS);
      const ledger = new MemoryLedger();
      for (const [index, key] of sequence.entries()) {
        if (index >= boundary) break;
        if (key.startsWith("hook:")) {
          ledger.appendStart(attempt, key, actor(attempt), undefined, "release-line");
          ledger.append({
            kind: "step",
            record: {
              attemptId: attempt.attemptId,
              stepKey: key,
              from: "started",
              to: "completed",
              guards: [{ guard: "release-line", passed: true }],
              attribution: actor(attempt),
            },
          });
        } else if (key.startsWith("artifact:")) {
          recordArtifact(ledger, attempt, key.slice("artifact:".length));
        } else {
          completeStage(ledger, attempt, key as StageKey);
        }
      }
      if (boundary === 0) {
        ledger.appendStart(attempt, "plan", actor(attempt));
      }
      const first = classifyResume(attempt, ledger);
      const second = classifyResume(attempt, ledger);
      const tail: StepKey | undefined = sequence[boundary];
      const expectedVerdict =
        tail === undefined
          ? { kind: "complete", outcome: "published" as const }
          : { kind: "resume", from: tail };
      expect(first).toStrictEqual(expectedVerdict);
      expect(second).toStrictEqual(expectedVerdict);
    }
  });
});

describe("the publish gate and fail-closed (§2.5, fixture 5)", () => {
  it("refuses publish over an incomplete generation at the request door itself", () => {
    const attempt = executing(undefined, [artifactDecl("bundle", "publish", "after")]);
    const ledger = new MemoryLedger();
    for (const stage of ["plan", "claim", "prepare", "validate", "commit", "tag"] as const) {
      completeStage(ledger, attempt, stage);
    }
    const outcome = requestStep(
      attempt,
      { stepKey: "publish", attribution: actor(attempt) },
      heldClaim(attempt),
      ledger.stepView(),
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("expected a refusal");
    expect(outcome.detail).toContain("publish-gate-incomplete-generation");
    expect(outcome.detail).toContain("bundle");
  });

  it("advances publish once the generation stands, the guard row on the record", () => {
    const attempt = executing(undefined, [artifactDecl("bundle", "publish", "after")]);
    const ledger = new MemoryLedger();
    for (const stage of ["plan", "claim", "prepare", "validate", "commit", "tag"] as const) {
      completeStage(ledger, attempt, stage);
    }
    scheduleArtifacts(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      new Map([["bundle", recordingProducer()]]),
    );
    const outcome = requestStep(
      attempt,
      { stepKey: "publish", attribution: actor(attempt) },
      heldClaim(attempt),
      ledger.stepView(),
    );
    expect(outcome.kind).toBe("advance");
    if (outcome.kind !== "advance") throw new Error("expected an advance");
    expect(outcome.record.guards).toContainEqual({
      guard: "generation-complete",
      passed: true,
      detail: "publish over the declared generation demands every artifact step's proof (§2.5)",
    });
    // Byte-compatibility: an attempt declaring no artifact steps carries
    // no generation row at all.
    const bare = executing();
    const bareLedger = new MemoryLedger();
    completeStage(bareLedger, bare, "plan");
    const bareOutcome = requestStep(
      bare,
      { stepKey: "claim", attribution: actor(bare) },
      heldClaim(bare),
      bareLedger.stepView(),
    );
    if (bareOutcome.kind !== "advance") throw new Error("expected an advance");
    expect(bareOutcome.record.guards.some((guard) => guard.guard === "generation-complete")).toBe(
      false,
    );
  });

  it("records the failed escalation and re-arms through the resolution loop", () => {
    const attempt = executing(undefined, [
      artifactDecl("bundle", "publish", "after", { postconditions: ["evidence-present"] }),
    ]);
    const ledger = new MemoryLedger();
    // The ordered engine reaches the artifact past `publish` — the
    // canonical prefix through publish is the ledger's completed history,
    // so the first uncompleted step is the failed artifact itself.
    for (const stage of [
      "plan",
      "claim",
      "prepare",
      "validate",
      "commit",
      "tag",
      "publish",
    ] as const) {
      completeStage(ledger, attempt, stage);
    }
    const run = scheduleArtifacts(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      new Map([["bundle", recordingProducer()]]),
    );
    expect(run.attempt.state).toBe("blocked");
    expect(run.attempt.blockedCause).toBe("validation:artifact:bundle:evidence-present");
    const failed = failedOutcome(run.outcomes);
    expect(failed.record.to).toBe("failed");
    // The resolution loop re-arms: the classified tail resumes at the
    // artifact step, exactly as a hook's does.
    resolveBlocked(
      run.attempt,
      "artifact:bundle",
      { kind: "revalidation", planFingerprint: PLAN.planFingerprint },
      ledger,
      actor(run.attempt, "human"),
    );
    const verdict = classifyResume(run.attempt, ledger);
    expect(verdict).toStrictEqual({ kind: "resume", from: "artifact:bundle" });
  });

  it("fails closed on a malformed digest — the domain door's rule, quoted", () => {
    const attempt = executing(undefined, [artifactDecl("bundle", "publish", "after")]);
    const ledger = new MemoryLedger();
    const run = scheduleArtifacts(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      new Map([["bundle", recordingProducer({ digest: " padded digest " })]]),
    );
    expect(run.attempt.state).toBe("blocked");
    expect(run.attempt.blockedCause).toBe("validation:artifact:bundle:digest-invalid");
    expect(failedOutcome(run.outcomes).record.to).toBe("failed");
  });

  it("refuses without a held claim and throws on a missing producer (§2.2 protocol)", () => {
    const attempt = executing(undefined, [artifactDecl("bundle", "publish", "after")]);
    const ledger = new MemoryLedger();
    const producer = recordingProducer();
    const refused = scheduleArtifacts(
      attempt,
      actor(attempt),
      ledger,
      noClaims,
      new Map([["bundle", producer]]),
    );
    expect(refusedOutcome(refused.outcomes).detail).toBe("mutation-without-claim");
    expect(producer.calls).toHaveLength(0);
    expect(() =>
      scheduleArtifacts(attempt, actor(attempt), ledger, heldClaim(attempt), new Map()),
    ).toThrow(/never invents user code/);
    expect(() =>
      scheduleArtifacts(
        planned(undefined, [artifactDecl("bundle", "publish", "after")]),
        actor(attempt),
        new MemoryLedger(),
        heldClaim(attempt),
        new Map([["bundle", producer]]),
      ),
    ).toThrow(/executing attempt/);
  });

  it("hands the producer exactly five identity fields and never the plan", () => {
    const attempt = executing(undefined, [artifactDecl("bundle", "publish", "after")]);
    const ledger = new MemoryLedger();
    const producer = recordingProducer();
    scheduleArtifacts(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      new Map([["bundle", producer]]),
    );
    expect(producer.calls).toHaveLength(1);
    const input = producer.calls[0];
    if (input === undefined) throw new Error("expected the seam input");
    expect(Object.keys(input).sort()).toStrictEqual([
      "artifactId",
      "attemptId",
      "coordinates",
      "kind",
      "stage",
    ]);
    expect(input.stage).toBe("publish");
    const planRecord = ledger.tail(attempt.attemptId).find((record) => record.kind === "plan");
    if (planRecord === undefined) {
      throw new Error("expected the plan record");
    }
    expect(planRecord.planFingerprint).toBe(PLAN.planFingerprint);
  });
});

describe("determinism (§4.5): identical inputs, identical outcomes", () => {
  it("double-runs the scheduler byte-for-byte over fresh ledgers", () => {
    const declarations = [
      artifactDecl("sbom", "publish", "after"),
      artifactDecl("bundle", "publish", "after", {
        dependsOn: ["sbom"],
        postconditions: ["evidence-present"],
      }),
    ];
    const run = (ledger: MemoryLedger): ReturnType<typeof scheduleArtifacts> => {
      const attempt = executing(undefined, declarations);
      return scheduleArtifacts(
        attempt,
        actor(attempt),
        ledger,
        heldClaim(attempt),
        new Map([
          ["sbom", recordingProducer()],
          ["bundle", recordingProducer({ evidence: "bundle-report:1" })],
        ]),
      );
    };
    const first = run(new MemoryLedger());
    const second = run(new MemoryLedger());
    expect(second.outcomes).toStrictEqual(first.outcomes);
    expect(second.attempt).toStrictEqual(first.attempt);
  });
});
