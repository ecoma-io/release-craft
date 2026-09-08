/**
 * Slice 10.2 — the in-memory semantic vertical (contract
 * docs/design/phase10-vertical-matrix-contract.md §4): planner and execution
 * kernel over the memory stores, the matrix's first full expression. Every
 * test name carries its §6 invariant row and the §3 step it proves; the
 * goldens come from the fixture module's hand-derived table, never from a
 * run (§2). V6 (immutability's byte-identity) is not this slice's row.
 */
import { describe, expect, it } from "vitest";

import {
  CANONICAL_STAGES,
  classifyResume,
  openAttempt,
  resolveBlocked,
  resume,
  retrySequence,
  start,
  supersedePlan,
  transition,
  type Claim,
  type ClaimDenied,
  type ClaimScope,
  type HookEffect,
} from "../../src/index.js";
import { plan } from "../../src/planner/assemble.js";
import {
  actor,
  artifactProducers,
  assertChannelsUnchanged,
  COMMITTED_AT,
  copyWorld,
  freshStores,
  GOLDEN,
  hookEffects,
  liveWorld,
  matrixArtifacts,
  matrixChannels,
  matrixHooks,
  plannedOf,
  runInput,
  runRelease,
  snapshot,
  walkStages,
  type LiveWorld,
  type RunOptions,
  type RunResult,
  type WalkContext,
} from "./matrix.js";

// ---------------------------------------------------------------------------
// Shared staging helpers — recorded declarations, no fixture computes
// ---------------------------------------------------------------------------

const beta = { kind: "prerelease", stream: "beta", lineId: "main" } as const;

/** The always-succeeding declaration a window run carries: all six §3.4
 * artifacts plus §3.5's succeeding and resumed hooks, each with its proof. */
const fullDeclaration = () => {
  const hooks = matrixHooks();
  return {
    hooks: [hooks.notify, hooks.publishHook],
    artifacts: matrixArtifacts(),
    hookEffects: hookEffects({
      notify: { evidence: "evidence:notify" },
      announce: { evidence: "evidence:announce" },
    }),
    producers: artifactProducers(),
  };
};

/** The reference run every window's resume must classification-match: the
 * same declarations, no interruption, on its own world copy. The caller
 * passes the declarations the staged run carries — a staged run's hooks
 * differ (attest, sign) and only the same-declaration reference is the
 * equality half of recovery. */
const referenceRun = (declaration: Omit<RunOptions, "world" | "lineId" | "intents">): RunResult =>
  runRelease({ world: liveWorld(), lineId: "main", intents: [beta], ...declaration }, false);

/** The walk's context rebuilt from a stopped run — after a crash the
 * process memory is gone; the resume reconstructs from the recorded result
 * and the caller's declarations. The caller passes the live attempt: the
 * crashed value, or the re-armed successor after a `resume` door — the
 * state machine's value, never the ledger, carries the re-arming. */
const resumeCtx = (
  run: RunResult,
  opts: RunOptions,
  attempt?: RunResult["attempt"],
): WalkContext => ({
  stores: run.stores,
  attempt: attempt ?? run.attempt,
  planLine: run.planLine,
  ...(opts.hooks === undefined ? {} : { hooks: opts.hooks }),
  ...(opts.artifacts === undefined ? {} : { artifacts: opts.artifacts }),
  ...(opts.hookEffects === undefined ? {} : { hookEffects: opts.hookEffects }),
  ...(opts.producers === undefined ? {} : { producers: opts.producers }),
});

/** The attempt's completed step keys, append order — the completions half of
 * §6 recovery's equality. */
const completedKeys = (run: RunResult): readonly string[] => {
  const keys: string[] = [];
  for (const record of run.stores.ledger.tail(run.attempt.attemptId)) {
    if (record.kind !== "step" || record.record.to !== "completed") {
      continue;
    }
    if (!keys.includes(record.record.stepKey)) {
      keys.push(record.record.stepKey);
    }
  }
  return keys;
};

/** The §3.2 ladder's first `count` beta runs, each observed into the world. */
const runLadder = (world: LiveWorld, count: 1 | 2): void => {
  const runs = [beta, beta] as const;
  for (const intent of runs.slice(0, count)) {
    runRelease({ world, lineId: "main", intents: [intent] });
  }
};

const asDenied = (settled: Claim | ClaimDenied): ClaimDenied => {
  if (settled.kind !== "denied") {
    throw new Error(`fixture broken: expected a denial, got ${settled.kind}`);
  }
  return settled;
};

// ---------------------------------------------------------------------------
// V1 — plan integrity
// ---------------------------------------------------------------------------

describe("V1 — plan integrity", () => {
  it("V1 · main beta run · same inputs plan identically and the walk executes exactly the planned sequence", () => {
    const world = liveWorld();
    const input = runInput(snapshot(world), "main", [beta]);
    const first = plannedOf(plan(input)).plan;
    const second = plannedOf(plan(input)).plan;
    expect(second.planId).toBe(first.planId);

    const run = runRelease({ world, lineId: "main", intents: [beta] });
    expect(run.assembled.planId).toBe(first.planId);
    // The executed steps are exactly the planned canonical sequence — no
    // declarations, so the effective list is the canonical stages alone.
    expect(completedKeys(run)).toStrictEqual([...CANONICAL_STAGES]);
  });

  it("V1 · main beta run · every completion records and verifies its content fingerprint (E-03)", () => {
    const run = runRelease({ world: liveWorld(), lineId: "main", intents: [beta] });
    for (const stage of CANONICAL_STAGES) {
      const fingerprint = `content:${stage}:${run.attempt.attemptId}`;
      const completion = run.stores.ledger.stepView().completed(run.attempt.attemptId, stage);
      if (completion === null) {
        throw new Error(`fixture broken: ${stage} never recorded a completion`);
      }
      expect(completion.contentFingerprint).toBe(fingerprint);
    }
  });
});

// ---------------------------------------------------------------------------
// V2 — identity
// ---------------------------------------------------------------------------

describe("V2 — identity", () => {
  it("V2 · commit-window · the identity is stable across the crash and its resume", () => {
    const world = liveWorld();
    const declaration = fullDeclaration();
    const base: RunOptions = { world, lineId: "main", intents: [beta], ...declaration };
    const stopped = runRelease({ ...base, crashAfterStartOf: "commit" }, false);
    if (stopped.stoppedAt !== "commit") {
      throw new Error(`fixture broken: the walk stopped at ${String(stopped.stoppedAt)}`);
    }
    const ctx = resumeCtx(stopped, base);
    expect(walkStages(ctx, "commit", base, [], "commit")).toBeNull();
    const final = transition(ctx.attempt, "published");
    // One identity end to end: the resumed tail is the same attempt's.
    expect(final.attemptId).toBe(stopped.attempt.attemptId);
    for (const record of stopped.stores.ledger.tail(final.attemptId)) {
      const holder =
        record.kind === "step" || record.kind === "channel-transition"
          ? record.record.attemptId
          : record.attemptId;
      expect(holder).toBe(stopped.attempt.attemptId);
    }
  });

  it("V2 · five lines · five lines' runs never share an attempt", () => {
    const world = liveWorld();
    const main = runRelease({ world, lineId: "main", intents: [beta] });
    const sides = ["4.8.x", "3.x", "2.x", "1.9-lts"].map((lineId) =>
      runRelease({ world, lineId, intents: [{ kind: "release" }] }),
    );
    const ids = [main, ...sides].map((run) => run.attempt.attemptId);
    expect(new Set(ids).size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// V3 — prerelease sequence
// ---------------------------------------------------------------------------

describe("V3 — prerelease sequence", () => {
  it("V3 · ladder runs 1–2 · beta.1 then beta.2, and only the beta stream moves", () => {
    const world = liveWorld();
    const first = runRelease({ world, lineId: "main", intents: [beta] });
    expect(first.mintedTag).toBe(GOLDEN.ladder[0]);
    // The scope's target is the stream's pointer base — the released
    // version the sequence numbers against (4.9.2 before the beta opens).
    expect(first.scope).toStrictEqual({
      kind: "prerelease-sequence",
      lineId: "main",
      target: "4.9.2",
      streamId: "beta",
      sequence: 1,
    });
    const second = runRelease({ world, lineId: "main", intents: [beta] });
    expect(second.mintedTag).toBe(GOLDEN.ladder[1]);
    // The pointer moved with the first beta: the scope's base follows it.
    expect(second.scope).toStrictEqual({
      kind: "prerelease-sequence",
      lineId: "main",
      target: "5.0.0-beta.1",
      streamId: "beta",
      sequence: 2,
    });
    // Only the demanded stream is in the plan: no other stream's number moved.
    expect(second.planLine.streams.map((stream) => stream.identifier)).toStrictEqual(["beta"]);
  });

  it("V3 · ladder run 3 · the rc stream opens from its own key beside beta", () => {
    const world = liveWorld();
    runLadder(world, 2);
    const rc = runRelease({
      world,
      lineId: "main",
      intents: [{ kind: "prerelease", stream: "rc", lineId: "main" }],
    });
    expect(rc.mintedTag).toBe(GOLDEN.ladder[2]);
    // The rc stream opens from its own key: fresh sequence, the line's
    // current pointer base.
    expect(rc.scope).toStrictEqual({
      kind: "prerelease-sequence",
      lineId: "main",
      target: "5.0.0-beta.2",
      streamId: "rc",
      sequence: 1,
    });
    // The beta and rc scopes coexist: nothing denied across them.
    expect(rc.planLine.streams.map((stream) => stream.identifier)).toStrictEqual(["rc"]);
  });

  it("V3 · same-scope staging · the loser's denial carries the winner's sequence as its retry base (E-08)", () => {
    const world = liveWorld();
    runLadder(world, 1);
    const base: RunOptions = { world, lineId: "main", intents: [beta] };
    // A demands beta.2 through the shared register and dies inside claim —
    // holding the stream's lease.
    const a = runRelease({ ...base, crashAfterStartOf: "claim" }, false);
    expect(a.scope).toStrictEqual({
      kind: "prerelease-sequence",
      lineId: "main",
      target: "5.0.0-beta.1",
      streamId: "beta",
      sequence: 2,
    });
    // B is the same plan's second ordinal through the SAME register.
    const assembledB = plannedOf(plan(runInput(snapshot(world), "main", [beta]))).plan;
    expect(assembledB.planId).toBe(a.assembled.planId);
    const attemptB = start(
      openAttempt(a.stores.register, {
        planId: assembledB.planId,
        planFingerprint: assembledB.planId,
      }),
    );
    expect(attemptB.attemptId).not.toBe(a.attempt.attemptId);
    const denial = asDenied(a.stores.claims.acquire(a.scope, attemptB.attemptId));
    expect(denial.holder).toBe(a.attempt.attemptId);
    expect(denial.holderSequence).toBe(2);
    // The bounded retry recomputes from the winner's recorded sequence.
    expect(retrySequence(denial, 0, { maxRetries: 1 })).toStrictEqual({
      kind: "retry",
      sequence: 3,
    });
    // A resumes from its durable claim start and lands beta.2.
    const ctx = resumeCtx(a, base);
    expect(walkStages(ctx, "claim", base, [], "claim")).toBeNull();
    const ref = world.refs.find((candidate) => candidate.name === "main");
    if (ref === undefined) {
      throw new Error("fixture broken: no main ref");
    }
    world.tags.push({ name: "5.0.0-beta.2", commit: ref.head });
    // B's re-plan on the observed world lands the NEXT number — the retry
    // base proved correct without ever reading a max.
    const bPrime = runRelease({ world, lineId: "main", intents: [beta] });
    expect(bPrime.mintedTag).toBe("5.0.0-beta.3");
  });
});

// ---------------------------------------------------------------------------
// V4 — promotion
// ---------------------------------------------------------------------------

describe("V4 — promotion", () => {
  it("V4 · ladder run 4 · the promote decision lands the stable record and every channel reads unchanged", () => {
    const channels = matrixChannels();
    const world = liveWorld();
    runLadder(world, 2);
    const rc = runRelease({
      world,
      lineId: "main",
      intents: [{ kind: "prerelease", stream: "rc", lineId: "main" }],
    });
    expect(rc.mintedTag).toBe(GOLDEN.ladder[2]);
    assertChannelsUnchanged(channels);

    const promote = runRelease({
      world,
      lineId: "main",
      intents: [{ kind: "promote", lineId: "main" }],
    });
    expect(promote.mintedTag).toBe(GOLDEN.ladder[3]);
    // The promote decision's surface: an empty change set — `bump: null`
    // (P-03) — the stable mint as a record, no streams.
    expect(promote.planLine.changes).toStrictEqual([]);
    expect(promote.planLine.streams).toStrictEqual([]);
    expect(promote.planLine.stable?.tag).toBe("5.0.0");
    expect(promote.scope.kind).toBe("stable-version");
    if (promote.scope.kind !== "stable-version") {
      throw new Error("fixture broken: the promote scope is not a stable-version record");
    }
    expect(promote.scope.version).toBe("5.0.0");
    // The promotion drags no pointer — the transition door is unlanded (#76),
    // and the unchanged reading is the assertion, not an absence of one.
    assertChannelsUnchanged(channels);
  });
});

// ---------------------------------------------------------------------------
// V5 — supersession
// ---------------------------------------------------------------------------

describe("V5 — supersession", () => {
  it("V5 · supersede staging · the abandoned plan's attempt supersedes, past-tag stands, claims release by token", () => {
    const channels = matrixChannels();
    const world = liveWorld();
    runLadder(world, 1);
    // A aims at beta.2 and dies before tag — voidable.
    const base: RunOptions = { world, lineId: "main", intents: [beta] };
    const a = runRelease({ ...base, crashAfterStartOf: "commit" }, false);
    // The world pivots; B plans the beta.2 target under a new plan.
    const ref = world.refs.find((candidate) => candidate.name === "main");
    if (ref === undefined) {
      throw new Error("fixture broken: no main ref");
    }
    world.commits = [
      ...world.commits,
      {
        sha: "m6",
        parents: [ref.head],
        message: "fix: the pivot",
        committedAt: COMMITTED_AT,
        containingRefs: ["main"],
      },
    ];
    world.refs = world.refs.map((candidate) =>
      candidate.name === "main" ? { name: "main", head: "m6" } : candidate,
    );
    const b = runRelease({ world, lineId: "main", intents: [beta] });
    expect(b.mintedTag).toBe("5.0.0-beta.2");

    // A's plan is abandoned by relation: A supersedes now (before tag), the
    // terminal B is untouched.
    const voided = supersedePlan({
      oldPlanId: a.assembled.planId,
      newPlanId: b.assembled.planId,
      attempts: [a.attempt, b.attempt],
      steps: b.stores.ledger.stepView(),
    });
    expect(voided.pastTag).toStrictEqual([]);
    expect(voided.superseded.map((attempt) => attempt.attemptId)).toStrictEqual([
      a.attempt.attemptId,
    ]);
    expect(voided.superseded[0]?.state).toBe("superseded");
    expect(voided.superseded[0]?.terminalReason).toBe(`superseded-by:${b.assembled.planId}`);
    expect(b.attempt.state).toBe("published");
    // No channel points at an abandoned version — nothing moved at all.
    assertChannelsUnchanged(channels);

    // Past-tag leg: an attempt whose tag completed is unvoidable — it stands
    // and only the relation records.
    const past = runRelease({ ...base, crashAfterStartOf: "publish" }, false);
    expect(past.stores.ledger.step(past.attempt.attemptId, "tag")).toBe("completed");
    const outcome = supersedePlan({
      oldPlanId: past.assembled.planId,
      newPlanId: b.assembled.planId,
      attempts: [past.attempt],
      steps: past.stores.ledger.stepView(),
    });
    expect(outcome.superseded).toStrictEqual([]);
    expect(outcome.pastTag.map((attempt) => attempt.attemptId)).toStrictEqual([
      past.attempt.attemptId,
    ]);
    expect(past.attempt.state).toBe("executing");

    // A prerelease claim is a lease: released by token, then verify reads lost.
    past.stores.claims.release(past.token);
    expect(past.stores.claims.verify(past.token).kind).toBe("lost");
  });
});

// ---------------------------------------------------------------------------
// V7 — recovery
// ---------------------------------------------------------------------------

describe("V7 — recovery", () => {
  for (const stage of CANONICAL_STAGES) {
    it(`V7 · ${stage}-window · the crash classifies and the resume completes the run`, () => {
      const world = liveWorld();
      const declaration = fullDeclaration();
      const base: RunOptions = { world, lineId: "main", intents: [beta], ...declaration };
      const stopped = runRelease({ ...base, crashAfterStartOf: stage }, false);
      expect(stopped.stoppedAt).toBe(stage);
      // Classification from the recorded tail, never recomputation: the
      // durable write-ahead start names the stage the resume re-runs.
      expect(classifyResume(stopped.attempt, stopped.stores.ledger)).toStrictEqual({
        kind: "resume",
        from: stage,
      });
      const ctx = resumeCtx(stopped, base);
      expect(walkStages(ctx, stage, base, [], stage)).toBeNull();
      const final = transition(ctx.attempt, "published");
      expect(final.state).toBe("published");
      // The resumed completions equal the uninterrupted run's — no completed
      // step re-executed, no uncompleted step skipped.
      expect(completedKeys(stopped)).toStrictEqual(completedKeys(referenceRun(declaration)));
    });
  }

  it("V7 · artifact-window · the walk stops inside the DAG and the resume completes changelog and the rest", () => {
    const world = liveWorld();
    const declaration = fullDeclaration();
    const base: RunOptions = { world, lineId: "main", intents: [beta], ...declaration };
    const stopped = runRelease(
      {
        ...base,
        crashAfterStartOfExtension: {
          stepKey: "artifact:changelog",
          stage: "tag",
          position: "after",
        },
      },
      false,
    );
    expect(stopped.stoppedAt).toBe("tag");
    expect(stopped.stores.ledger.step(stopped.attempt.attemptId, "artifact:sbom")).toBe(
      "completed",
    );
    expect(stopped.stores.ledger.step(stopped.attempt.attemptId, "artifact:changelog")).toBe(
      "started",
    );
    // Classification names the first uncompleted effective step — the
    // changelog record itself — and the walk resumes its anchor stage.
    expect(classifyResume(stopped.attempt, stopped.stores.ledger)).toStrictEqual({
      kind: "resume",
      from: "artifact:changelog",
    });
    const ctx = resumeCtx(stopped, base);
    expect(walkStages(ctx, "tag", base, [], "tag")).toBeNull();
    transition(ctx.attempt, "published");
    expect(stopped.stores.ledger.step(stopped.attempt.attemptId, "artifact:changelog")).toBe(
      "completed",
    );
    expect(stopped.stores.ledger.step(stopped.attempt.attemptId, "artifact:publish-all")).toBe(
      "completed",
    );
    expect(completedKeys(stopped)).toStrictEqual(completedKeys(referenceRun(declaration)));
  });

  it("V7 · hook:attest failure · the refusal records, the attempt blocks, and only a resolution re-arms", () => {
    const world = liveWorld();
    const hooks = matrixHooks();
    const declaration = {
      ...fullDeclaration(),
      hooks: [hooks.attest, hooks.notify],
      // The effect RUNS and its observation refuses the proof — the engine
      // records what the caller-injected seam returned (§2.5).
      hookEffects: hookEffects({
        attest: {},
        notify: { evidence: "evidence:notify" },
      }),
    };
    const base: RunOptions = { world, lineId: "main", intents: [beta], ...declaration };
    const stopped = runRelease(base, false);
    expect(stopped.stoppedAt).toBe("publish");
    expect(stopped.attempt.state).toBe("blocked");
    expect(stopped.attempt.blockedCause).toBe("validation:hook:attest:evidence-present");
    // The failure is a recorded step, never a throw — `failed` sits in the tail.
    expect(stopped.stores.ledger.step(stopped.attempt.attemptId, "hook:attest")).toBe("failed");
    // Blocked without a recorded resolution: escalation, not revival (E-04).
    expect(classifyResume(stopped.attempt, stopped.stores.ledger).kind).toBe("escalate");
  });

  it("V7 · hook:sign retried · the first refusal blocks, the resolution re-arms, the second observation lands beside it", () => {
    const world = liveWorld();
    const hooks = matrixHooks();
    let signCalls = 0;
    const signEffect: HookEffect = (input) => {
      signCalls += 1;
      return {
        attribution: { attemptId: input.attemptId, actor: "automation" },
        ...(signCalls === 1 ? {} : { contentFingerprint: `content:sign:${String(signCalls)}` }),
      };
    };
    const effects: ReadonlyMap<string, HookEffect> = new Map<string, HookEffect>([
      ...hookEffects({ notify: { evidence: "evidence:notify" } }),
      ["sign", signEffect],
    ]);
    const declaration = {
      ...fullDeclaration(),
      hooks: [hooks.sign, hooks.notify],
      hookEffects: effects,
    };
    const base: RunOptions = { world, lineId: "main", intents: [beta], ...declaration };
    const stopped = runRelease(base, false);
    expect(stopped.stoppedAt).toBe("publish");
    expect(stopped.attempt.state).toBe("blocked");
    expect(stopped.attempt.blockedCause).toBe("validation:hook:sign:content-fingerprint-present");

    // resolveBlocked is the only re-arm door: the resolution appends for
    // the refused key, the attempt re-arms, classification walks back to
    // the same key (§2.7).
    resolveBlocked(
      stopped.attempt,
      "hook:sign",
      { kind: "revalidation", planFingerprint: stopped.attempt.planFingerprint },
      stopped.stores.ledger,
      actor(stopped.attempt),
    );
    const rearmed = resume(stopped.attempt, "revalidation recorded");
    expect(classifyResume(rearmed, stopped.stores.ledger)).toStrictEqual({
      kind: "resume",
      from: "hook:sign",
    });
    const ctx = resumeCtx(stopped, base, rearmed);
    expect(walkStages(ctx, "publish", base, [], "publish")).toBeNull();
    transition(ctx.attempt, "published");
    // The retry appends beside the refusal — write-ahead included: the
    // failed record stays in the tail, never rewritten (§2.5).
    expect(stopped.stores.ledger.step(stopped.attempt.attemptId, "hook:sign")).toBe("completed");
    const signRecords = stopped.stores.ledger
      .tail(stopped.attempt.attemptId)
      .flatMap((record) =>
        record.kind === "step" && record.record.stepKey === "hook:sign" ? [record.record.to] : [],
      );
    expect(signRecords).toStrictEqual(["started", "failed", "started", "completed"]);
    expect(completedKeys(stopped)).toStrictEqual(completedKeys(referenceRun(declaration)));
  });

  it("V7 · hook:announce crash · the mid-effect crash classifies and the resume runs the effect exactly once more", () => {
    const world = liveWorld();
    const declaration = fullDeclaration();
    const base: RunOptions = { world, lineId: "main", intents: [beta], ...declaration };
    const stopped = runRelease(
      {
        ...base,
        crashAfterStartOfExtension: {
          stepKey: "hook:announce",
          stage: "publish",
          position: "after",
        },
      },
      false,
    );
    expect(stopped.stoppedAt).toBe("publish");
    expect(stopped.stores.ledger.step(stopped.attempt.attemptId, "hook:announce")).toBe("started");
    expect(classifyResume(stopped.attempt, stopped.stores.ledger)).toStrictEqual({
      kind: "resume",
      from: "hook:announce",
    });
    const ctx = resumeCtx(stopped, base);
    expect(walkStages(ctx, "publish", base, [], "publish")).toBeNull();
    transition(ctx.attempt, "published");
    // Never duplicated: exactly one completion for the hook step.
    expect(stopped.stores.ledger.step(stopped.attempt.attemptId, "hook:announce")).toBe(
      "completed",
    );
    const completions = stopped.stores.ledger
      .tail(stopped.attempt.attemptId)
      .flatMap((record) =>
        record.kind === "step" &&
        record.record.stepKey === "hook:announce" &&
        record.record.to === "completed"
          ? [record.record]
          : [],
      );
    expect(completions).toHaveLength(1);
    expect(completedKeys(stopped)).toStrictEqual(completedKeys(referenceRun(declaration)));
  });

  it("V7 · staging discipline · a stopped staging run and its world copy never touch the shared world", () => {
    const world = liveWorld();
    const before = world.tags.length;
    const declaration = fullDeclaration();
    const base: RunOptions = { world, lineId: "main", intents: [beta], ...declaration };
    runRelease({ ...base, crashAfterStartOf: "tag" }, false);
    expect(world.tags).toHaveLength(before);
    // A completed staging run on a copy observes its copy alone.
    // A completed run on a copy observes its copy alone AND the shared
    // world: the declaration-less driver carries no artifacts, so the run
    // refuses nothing and records its mint into the copy.
    const staged = runRelease({ world: copyWorld(world), lineId: "main", intents: [beta] }, true);
    expect(staged.mintedTag).toBe("5.0.0-beta.1");
    expect(world.tags).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
// V8 — concurrency (the port's own atomic semantics at this slice)
// ---------------------------------------------------------------------------

describe("V8 — concurrency", () => {
  it("V8 · release-line · the second claim on a line denies naming the holder; cross-line never excludes", () => {
    const store = freshStores().claims;
    const first = store.acquire({ kind: "release-line", lineId: "main" }, "attempt-a");
    if (first.kind !== "claim") {
      throw new Error("fixture broken: the first release-line claim was denied");
    }
    expect(
      asDenied(store.acquire({ kind: "release-line", lineId: "main" }, "attempt-b")).holder,
    ).toBe("attempt-a");
    // A held release-line excludes every narrower claim on its line…
    expect(
      store.acquire(
        {
          kind: "prerelease-sequence",
          lineId: "main",
          target: "5.0.0",
          streamId: "beta",
          sequence: 1,
        },
        "attempt-b",
      ).kind,
    ).toBe("denied");
    // …and a held narrower claim excludes a release-line on the same line.
    const other = freshStores().claims;
    const narrow = other.acquire(
      {
        kind: "prerelease-sequence",
        lineId: "main",
        target: "5.0.0",
        streamId: "beta",
        sequence: 1,
      },
      "attempt-a",
    );
    if (narrow.kind !== "claim") {
      throw new Error("fixture broken: the narrow claim was denied");
    }
    expect(
      asDenied(other.acquire({ kind: "release-line", lineId: "main" }, "attempt-b")).holder,
    ).toBe("attempt-a");
    // Another line is another world: no cross-line exclusion (M-02).
    expect(store.acquire({ kind: "release-line", lineId: "4.8.x" }, "attempt-c").kind).toBe(
      "claim",
    );
  });

  it("V8 · lost-claim · a released token verifies lost and the loser re-acquires — never both-accept", () => {
    const store = freshStores().claims;
    const scope: ClaimScope = {
      kind: "prerelease-sequence",
      lineId: "main",
      target: "5.0.0",
      streamId: "beta",
      sequence: 1,
    };
    const first = store.acquire(scope, "attempt-a");
    if (first.kind !== "claim") {
      throw new Error("fixture broken: the first claim was denied");
    }
    store.release(first.token);
    const second = store.acquire(scope, "attempt-b");
    if (second.kind !== "claim") {
      throw new Error("fixture broken: the re-acquisition was denied");
    }
    // Exactly one holder: the loser's own view refuses its token…
    expect(store.viewFor("attempt-a").verify(first.token)).toBe(false);
    // …while the winner's view verifies the same store's truth.
    expect(store.viewFor("attempt-b").verify(second.token)).toBe(true);
    expect(store.verify(first.token).kind).toBe("lost");
  });

  it("V8 · stable-version · the record claim: release is a no-op and a later verify still reads held", () => {
    const store = freshStores().claims;
    const scope: ClaimScope = {
      kind: "stable-version",
      lineId: "main",
      version: "5.0.0",
    };
    const first = store.acquire(scope, "attempt-a");
    if (first.kind !== "claim") {
      throw new Error("fixture broken: the stable-version claim was denied");
    }
    store.release(first.token);
    expect(store.verify(first.token).kind).toBe("held");
    // The record still excludes: a second attempt's acquire names the holder.
    expect(asDenied(store.acquire(scope, "attempt-b")).holder).toBe("attempt-a");
  });

  it("V8 · bounded-retry · the bound exhausts into an explicit conflict, and a baseless denial never recomputes", () => {
    const scope: ClaimScope = {
      kind: "prerelease-sequence",
      lineId: "main",
      target: "5.0.0",
      streamId: "beta",
      sequence: 1,
    };
    const denial: ClaimDenied = { kind: "denied", holder: "attempt-a", scope, holderSequence: 1 };
    expect(retrySequence(denial, 1, { maxRetries: 1 }).kind).toBe("conflict");
    const baseless: ClaimDenied = { kind: "denied", holder: "attempt-a", scope };
    expect(retrySequence(baseless, 0, { maxRetries: 3 }).kind).toBe("conflict");
  });
});

// ---------------------------------------------------------------------------
// V9 — divergence
// ---------------------------------------------------------------------------

describe("V9 — divergence", () => {
  it("V9 · propagation · the carried fix mints per line, plans stay single-line and disjoint", () => {
    const world = liveWorld();
    const carried = ["4.8.x", "1.9-lts"].map((lineId) =>
      runRelease({ world, lineId, intents: [{ kind: "release" }] }),
    );
    expect(carried.map((run) => run.mintedTag)).toStrictEqual([
      GOLDEN.sides["4.8.x"],
      GOLDEN.sides["1.9-lts"],
    ]);
    // No line's history merges another: each plan is one line (M-02) and no
    // two runs share a plan identity.
    for (const run of carried) {
      expect(run.assembled.lines).toHaveLength(1);
    }
    expect(new Set(carried.map((run) => run.assembled.planId)).size).toBe(2);
    // The independent lines release beside them, never cross-dependent.
    expect(runRelease({ world, lineId: "3.x", intents: [{ kind: "release" }] }).mintedTag).toBe(
      GOLDEN.sides["3.x"],
    );
    expect(runRelease({ world, lineId: "2.x", intents: [{ kind: "release" }] }).mintedTag).toBe(
      GOLDEN.sides["2.x"],
    );
    // No version repeats across lines.
    const minted = world.tags.map((tag) => tag.name);
    expect(new Set(minted).size).toBe(minted.length);
  });

  it("V9 · collision · a two-lines-one-tag plan refuses naming the tag, both lines, both heads (M-11)", () => {
    const outcome = plan({
      policy: {
        digest: "sha256:" + "c".repeat(64),
        bumpMappingId: "default",
        prereleaseLadder: ["rc"],
        prereleaseSeed: "0",
        pre10Dampening: true,
        selfReferenceNamespace: "Release-Craft:",
        tagFormats: {},
      },
      repository: {
        commits: [
          {
            sha: "c1",
            parents: [],
            message: "feat: base",
            committedAt: COMMITTED_AT,
            containingRefs: ["feed/a", "feed/b"],
          },
          {
            sha: "c2",
            parents: ["c1"],
            message: "fix: on a",
            committedAt: COMMITTED_AT,
            containingRefs: ["feed/a"],
          },
          {
            sha: "c3",
            parents: ["c1"],
            message: "fix: on b",
            committedAt: COMMITTED_AT,
            containingRefs: ["feed/b"],
          },
        ],
        refs: [
          { name: "feed/a", head: "c2" },
          { name: "feed/b", head: "c3" },
        ],
      },
      history: { tags: [{ name: "1.0.0", commit: "c1" }] },
      lines: [
        { id: "a", feedRef: "feed/a", lifecycle: "active", declared: true, publishes: "app" },
        { id: "b", feedRef: "feed/b", lifecycle: "active", declared: true, publishes: "web" },
      ],
      components: [
        { name: "app", manifestVersion: "1.0.0", paths: ["package.json"] },
        { name: "web", manifestVersion: "1.0.0", paths: ["package.json"] },
      ],
      intents: [{ kind: "release" }],
    });
    if (outcome.kind !== "refused") {
      throw new Error("fixture broken: the collision world planned instead of refusing");
    }
    expect(outcome.refusal.cause).toBe("version-collision");
    expect(outcome.refusal.commits).toStrictEqual(["c2", "c3"]);
    expect(outcome.refusal.detail).toContain('"1.0.1"');
    expect(outcome.refusal.detail).toContain('"a"');
    expect(outcome.refusal.detail).toContain('"b"');
  });
});

// ---------------------------------------------------------------------------
// V11 — zero-config and determinism
// ---------------------------------------------------------------------------

describe("V11 — zero-config and determinism", () => {
  it("V11 · zero-config · the stores construct from nothing and no record carries a clock", () => {
    const run = runRelease({
      world: liveWorld(),
      lineId: "main",
      intents: [beta],
      ...fullDeclaration(),
    });
    const serialized = JSON.stringify([
      run.stores.ledger.tail(run.attempt.attemptId),
      run.stores.log.records(),
    ]);
    expect(serialized).not.toContain("recordedAt");
    // The world's own time is recorded fixture data — never a read clock.
    for (const commit of liveWorld().commits) {
      expect(commit.committedAt).toBe(COMMITTED_AT);
    }
  });

  it("V11 · determinism · the whole matrix runs twice into identical recorded state", () => {
    const matrixTrace = (): readonly string[] => {
      const world = liveWorld();
      const trace: string[] = [];
      const record = (opts: RunOptions): void => {
        const run = runRelease(opts);
        trace.push(run.assembled.planId);
        trace.push(JSON.stringify(run.stores.ledger.tail(run.attempt.attemptId)));
        trace.push(JSON.stringify(run.stores.log.records()));
      };
      record({ world, lineId: "main", intents: [beta] });
      record({ world, lineId: "main", intents: [beta] });
      record({
        world,
        lineId: "main",
        intents: [{ kind: "prerelease", stream: "rc", lineId: "main" }],
      });
      record({ world, lineId: "main", intents: [{ kind: "promote", lineId: "main" }] });
      for (const lineId of ["4.8.x", "3.x", "2.x", "1.9-lts"]) {
        record({ world, lineId, intents: [{ kind: "release" }] });
      }
      // The world seeds seven tags; the matrix's eight mints append after.
      expect(world.tags.map((tag) => tag.name).slice(-8)).toStrictEqual([
        ...GOLDEN.ladder,
        GOLDEN.sides["4.8.x"],
        GOLDEN.sides["3.x"],
        GOLDEN.sides["2.x"],
        GOLDEN.sides["1.9-lts"],
      ]);
      return trace;
    };
    expect(matrixTrace()).toStrictEqual(matrixTrace());
  });
});
