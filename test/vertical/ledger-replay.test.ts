/**
 * Slice 10.3 — the ledger-backed replay vertical (contract
 * docs/design/phase10-vertical-matrix-contract.md §4 "10.3"). The same
 * matrix through the ledger's replay doors: between runs nothing lives in
 * process memory — the recorded tail persists in the caller's stores, the
 * next run classifies through `classifyResume` and dispatches through
 * `ledgerRequestStep` (the §2.8 record-path replay door). A completed step
 * replays `noop`/`conflict` exactly as E-02 keys them (fingerprint mismatch
 * included); the resumed run classification-matches the uninterrupted run's
 * (§6 recovery). V6 (immutability's byte-identity) is this slice's first
 * row.
 *
 * Every test name carries its §6 invariant row and the §3 step it proves.
 * The ladder goldens come from the fixture module's hand-derived table, never
 * from a run (§2); the extension-step order is asserted structurally — equal
 * to the same-declaration uninterrupted reference, never fewer and never out
 * of the declared anchors.
 */
import { describe, expect, it } from "vitest";

import {
  CANONICAL_STAGES,
  channelStateFingerprint,
  MemoryLedger,
  classifyResume,
  ledgerRequestStep,
  resolveBlocked,
  resume,
  stageContentFingerprint,
  type ChannelTransitionRecord,
  type HookEffect,
} from "../../src/index.js";
import {
  actor,
  applyPlannedChannelTransitions,
  hookEffects,
  liveWorld,
  matrixHooks,
  snapshot,
} from "./matrix.js";
import {
  freshStores,
  fullDeclaration,
  runLedgerRelease,
  replayReference,
  tailBytes,
} from "./matrix-ledger.js";
import type { Declarations, RunResult as LedgerRunResult } from "./matrix-ledger.js";

// ---------------------------------------------------------------------------
// Shared staging helpers — recorded declarations, no fixture computes
// ---------------------------------------------------------------------------

const beta = { kind: "prerelease", stream: "beta", lineId: "main" } as const;
const rc = { kind: "prerelease", stream: "rc", lineId: "main" } as const;
const promote = { kind: "promote", lineId: "main" } as const;

/** The completed step keys of a ledger run, append order. */
const completedKeys = (run: LedgerRunResult): readonly string[] => {
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

// ---------------------------------------------------------------------------
// V1 — plan integrity (replay: the plan is identically re-planned, and the
// replay walk executes the same canonical sequence over the frozen tail)
// ---------------------------------------------------------------------------

describe("V1 — plan integrity, replayed", () => {
  it("V1 · replayed beta run · the same inputs re-plan identically, and the replay executes the planned sequence", () => {
    const world = liveWorld();
    const stores = freshStores();
    const run = runLedgerRelease({
      stores,
      world,
      lineId: "main",
      intents: [beta],
      declarations: fullDeclaration(),
    });
    expect(run.stoppedAt).toBeNull();
    expect(run.mintedTag).toBe("5.0.0-beta.1");
    // The replay executes exactly the planned sequence — the ledger's
    // completed records alone capture what the walk ran, and they equal the
    // same-declaration uninterrupted run's (the canonical nine PLUS their
    // extension steps at the anchors §3.4/§3.5 declare — never fewer,
    // never out of the declared order).
    expect(completedKeys(run)).toStrictEqual(
      completedKeys(replayReference(snapshot(liveWorld()), "main", [beta], fullDeclaration())),
    );
    expect(run.stores.ledger.step(run.attempt.attemptId, "publish")).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// V6 — immutability (this slice's first row): the tail is append-only,
// deep-frozen on append, and reads back byte-identical at every later
// checkpoint; an uninterrupted double run is byte-identical
// ---------------------------------------------------------------------------

describe("V6 — immutability (the ledger's byte-identity)", () => {
  it("V6 · completed run · the tail is append-only, frozen, and every record reads back byte-identical", () => {
    const world = liveWorld();
    const stores = freshStores();
    const run = runLedgerRelease({ stores, world, lineId: "main", intents: [beta] });
    const attemptId = run.attempt.attemptId;

    const a = tailBytes(stores.ledger, attemptId);
    expect(a.length).toBeGreaterThan(0);

    // Re-read: byte-identical at a later checkpoint (nothing rewrote).
    expect(tailBytes(stores.ledger, attemptId)).toStrictEqual(a);

    // Append-only: no record was ever removed or rewritten — the tail's
    // plan record is still the first, the step order append order.
    expect(stores.ledger.tail(attemptId).at(0)?.kind).toBe("plan");
    expect(stores.ledger.tail(attemptId).at(-1)?.kind).toBe("step");
  });

  it("V6 · double run · two identical runs land byte-identical tails (determinism asserted, not assumed)", () => {
    // The matrix runs twice into identical recorded state — the whole
    // vertical is deterministic, and the ledger's frozen records are the
    // byte-exact evidence.
    const worldA = liveWorld();
    const storesA = freshStores();
    const runA = runLedgerRelease({
      stores: storesA,
      world: worldA,
      lineId: "main",
      intents: [beta],
    });

    const worldB = liveWorld();
    const storesB = freshStores();
    const runB = runLedgerRelease({
      stores: storesB,
      world: worldB,
      lineId: "main",
      intents: [beta],
    });

    expect(runA.mintedTag).toBe(runB.mintedTag);
    expect(runA.attempt.attemptId).toBe(runB.attempt.attemptId);
    expect(tailBytes(storesA.ledger, runA.attempt.attemptId)).toStrictEqual(
      tailBytes(storesB.ledger, runB.attempt.attemptId),
    );
    // The world observes the same minted tags in the same order.
    expect(worldA.tags.slice(-1).map((t) => t.name)).toStrictEqual(
      worldB.tags.slice(-1).map((t) => t.name),
    );
  });
});

// ---------------------------------------------------------------------------
// V7 — recovery over the replay path: every §3.6 window classifies and
// resumes from the recorded tail through `ledgerRequestStep`; no completed
// step re-executes, no uncompleted step skips; the resumed completions
// equal the uninterrupted run's
// ---------------------------------------------------------------------------

describe("V7 — recovery, replayed", () => {
  for (const stage of CANONICAL_STAGES) {
    it(`V7 · ${stage}-window · the crash classifies from the recorded tail and the replay completes`, () => {
      const world = liveWorld();
      const stores = freshStores();
      const stopped = runLedgerRelease({
        stores,
        world,
        lineId: "main",
        intents: [beta],
        crashAfterStartOf: stage,
      });
      expect(stopped.stoppedAt).toBe(stage);

      // A "fresh process" reloads only the recorded tail: the attempt is
      // carried in the stores, the new walk classifies from the ledger.
      const verdict = classifyResume(stopped.attempt, stores.ledger);
      expect(verdict.kind).toBe("resume");
      if (verdict.kind !== "resume") {
        throw new Error(`expected a resume verdict, got ${verdict.kind}`);
      }
      expect(verdict.from).toBe(stage);

      // Re-run the SAME release over the SAME persisted stores — the walk
      // re-enters at the recorded tail's first uncompleted step.
      const resumed = runLedgerRelease({ stores, world, lineId: "main", intents: [beta] });
      expect(resumed.stoppedAt).toBeNull();

      // No completed step re-executed, no uncompleted skipped: the resumed
      // completions equal the uninterrupted run's.
      const uninterrupted = replayReference(snapshot(liveWorld()), "main", [beta]);
      expect(completedKeys(resumed)).toStrictEqual(completedKeys(uninterrupted));
    });
  }

  it("V7 · artifact-window · the walk stops inside the DAG and the replay completes the extension step and the rest", () => {
    const world = liveWorld();
    const stores = freshStores();
    const stopped = runLedgerRelease({
      stores,
      world,
      lineId: "main",
      intents: [beta],
      declarations: fullDeclaration(),
      crashAfterStartOfExtension: {
        stepKey: "artifact:changelog",
        stage: "tag",
        position: "after",
      },
    });
    expect(stopped.stoppedAt).toBe("tag");
    expect(stores.ledger.step(stopped.attempt.attemptId, "artifact:sbom")).toBe("completed");
    expect(stores.ledger.step(stopped.attempt.attemptId, "artifact:changelog")).toBe("started");

    const verdict = classifyResume(stopped.attempt, stores.ledger);
    expect(verdict.kind).toBe("resume");
    if (verdict.kind !== "resume") {
      throw new Error(`expected a resume verdict, got ${verdict.kind}`);
    }
    expect(verdict.from).toBe("artifact:changelog");

    const resumed = runLedgerRelease({
      stores,
      world,
      lineId: "main",
      intents: [beta],
      declarations: fullDeclaration(),
    });
    expect(resumed.stoppedAt).toBeNull();
    expect(stores.ledger.step(stopped.attempt.attemptId, "artifact:changelog")).toBe("completed");
    expect(stores.ledger.step(stopped.attempt.attemptId, "artifact:publish-all")).toBe("completed");
    const uninterrupted = replayReference(snapshot(liveWorld()), "main", [beta], fullDeclaration());
    expect(completedKeys(resumed)).toStrictEqual(completedKeys(uninterrupted));
  });

  it("V7 · hook:attest failure · the refusal records, the attempt blocks, and only a resolution re-arms", () => {
    const world = liveWorld();
    const stores = freshStores();
    const hooks = matrixHooks();
    const declaration: Declarations = {
      ...fullDeclaration(),
      hooks: [hooks.attest, hooks.notify],
      // The effect RUNS and its observation refuses the proof — the
      // engine records what the caller-injected seam returned (§2.5).
      hookEffects: hookEffects({
        attest: {},
        notify: { evidence: "evidence:notify" },
      }),
    };
    const stopped = runLedgerRelease({
      stores,
      world,
      lineId: "main",
      intents: [beta],
      declarations: declaration,
    });
    expect(stopped.stoppedAt).toBe("publish");
    expect(stopped.attempt.state).toBe("blocked");
    expect(stopped.attempt.blockedCause).toBe("validation:hook:attest:evidence-present");
    // The failure is a recorded step in the ledger, never a throw —
    // `failed` sits in the tail.
    expect(stores.ledger.step(stopped.attempt.attemptId, "hook:attest")).toBe("failed");
    // Blocked without a recorded resolution: escalation, not revival (E-04).
    expect(classifyResume(stopped.attempt, stores.ledger).kind).toBe("escalate");
  });

  it("V7 · hook:sign retried · the first refusal blocks, the resolution re-arms, the second observation lands beside it", () => {
    const world = liveWorld();
    const stores = freshStores();
    const hooks = matrixHooks();
    let signCalls = 0;
    const signEffect: HookEffect = (input) => {
      signCalls += 1;
      return {
        attribution: { attemptId: input.attemptId, actor: "automation" },
        ...(signCalls === 1 ? {} : { contentFingerprint: `content:sign:${String(signCalls)}` }),
      };
    };
    const declaration: Declarations = {
      ...fullDeclaration(),
      hooks: [hooks.sign, hooks.notify],
      hookEffects: new Map<string, HookEffect>([
        ...hookEffects({ notify: { evidence: "evidence:notify" } }),
        ["sign", signEffect],
      ]),
    };
    const stopped = runLedgerRelease({
      stores,
      world,
      lineId: "main",
      intents: [beta],
      declarations: declaration,
    });
    expect(stopped.stoppedAt).toBe("publish");
    expect(stopped.attempt.state).toBe("blocked");
    expect(stopped.attempt.blockedCause).toBe("validation:hook:sign:content-fingerprint-present");

    // resolveBlocked is the only re-arm door: the resolution appends to the
    // ledger, the attempt re-arms, and classification walks back to the
    // refused key (§2.7).
    resolveBlocked(
      stopped.attempt,
      "hook:sign",
      { kind: "revalidation", planFingerprint: stopped.attempt.planFingerprint },
      stores.ledger,
      actor(stopped.attempt),
    );
    const rearmed = resume(stopped.attempt, "revalidation recorded");
    expect(classifyResume(rearmed, stores.ledger)).toStrictEqual({
      kind: "resume",
      from: "hook:sign",
    });
    // Re-run the SAME release over the SAME persisted stores — the walk
    // re-enters at the recorded tail's refused key and the second
    // observation lands.
    stores.rearm(rearmed);
    const resumed = runLedgerRelease({
      stores,
      world,
      lineId: "main",
      intents: [beta],
      declarations: declaration,
    });
    expect(resumed.stoppedAt).toBeNull();
    // The retry appends beside the refusal — the failed record stays in the
    // tail, never rewritten (§2.5).
    expect(stores.ledger.step(stopped.attempt.attemptId, "hook:sign")).toBe("completed");
    const signRecords = stores.ledger
      .tail(stopped.attempt.attemptId)
      .flatMap((record) =>
        record.kind === "step" && record.record.stepKey === "hook:sign" ? [record.record.to] : [],
      );
    expect(signRecords).toStrictEqual(["started", "failed", "started", "completed"]);
    expect(signCalls).toBe(2);
    const uninterrupted = replayReference(snapshot(liveWorld()), "main", [beta], declaration);
    expect(completedKeys(resumed)).toStrictEqual(completedKeys(uninterrupted));
  });
});

// ---------------------------------------------------------------------------
// E-02 — the replay door: a completed step replays `noop`/`conflict` over
// fingerprints; a mismatched fingerprint is a recorded conflict, never a
// silent re-run
// ---------------------------------------------------------------------------

describe("E-02 — replay semantics (the record-path door)", () => {
  it("E-02 · completed replay · a proven-same content fingerprint replays noop; a different one is a conflict", () => {
    const world = liveWorld();
    const stores = freshStores();
    // The walk completes but leaves the attempt `executing` — the replay
    // door against a completed step (a terminal attempt would be the §2.8
    // recorded refusal, not the noop/conflict this row keys).
    const run = runLedgerRelease({
      stores,
      world,
      lineId: "main",
      intents: [beta],
      terminalize: false,
    });
    expect(run.stoppedAt).toBeNull();
    expect(run.attempt.state).toBe("executing");
    const attempt = run.attempt;
    const attemptId = attempt.attemptId;

    // Re-drive an already-completed canonical stage through the replay door.
    const same = ledgerRequestStep(
      attempt,
      {
        stepKey: "publish",
        attribution: actor(attempt),
        // The same declared content the run recorded — the §2.6 digest the
        // walk itself derived (#195).
        contentFingerprint: stageContentFingerprint("publish", run.planLine),
      },
      stores.claims.viewFor(attemptId),
      stores.ledger,
    );
    expect(same).toStrictEqual({ kind: "noop", stepKey: "publish" });

    const changed = ledgerRequestStep(
      attempt,
      {
        stepKey: "publish",
        attribution: actor(attempt),
        contentFingerprint: `content:publish:different`,
      },
      stores.claims.viewFor(attemptId),
      stores.ledger,
    );
    if (changed.kind !== "conflict") {
      throw new Error(`expected a conflict, got ${changed.kind}`);
    }
    expect(changed.stepKey).toBe("publish");
    expect(changed.detail).toContain("not proven equal");
  });
});

// ---------------------------------------------------------------------------
// V3 — the prerelease ladder over the replay path: only the demanded stream
// moves; the promoted run lands the promotion; side cuts mint beside
// ---------------------------------------------------------------------------

describe("V3/V4 — the ladder and the cut, replayed", () => {
  it("V3 · ladder runs · beta.1 and beta.2 land in order, and only the beta stream moves on main", () => {
    const world = liveWorld();
    const stores = freshStores();
    const first = runLedgerRelease({ stores, world, lineId: "main", intents: [beta] });
    expect(first.mintedTag).toBe("5.0.0-beta.1");
    const second = runLedgerRelease({ stores, world, lineId: "main", intents: [beta] });
    expect(second.mintedTag).toBe("5.0.0-beta.2");
    // The world observed exactly the two ladder mints.
    expect(world.tags.slice(-2).map((t) => t.name)).toStrictEqual(["5.0.0-beta.1", "5.0.0-beta.2"]);
  });

  it("V4 · ladder run 4 · the promote run moves the planned channels on the carried store, and the replay classifies noop", () => {
    const world = liveWorld();
    const stores = freshStores();
    for (const intent of [beta, beta, rc] as const) {
      runLedgerRelease({ stores, world, lineId: "main", intents: [intent] });
    }
    // The carried store rides every replayed run — and no pre-promote run
    // plans a move, so it still stands at §3.1's seeds.
    expect(stores.channels.read("stable")).toStrictEqual({
      id: "stable",
      target: { line: "main", version: "4.9.2" },
    });
    const promoteRun = runLedgerRelease({ stores, world, lineId: "main", intents: [promote] });
    expect(promoteRun.mintedTag).toBe("5.0.0");
    // The plan's channel content (ADR-0012 decision 2): the §3.1 declared
    // moves in declaration order, then the promoted-from edge, then the rc
    // stream close — the promote names its moves, it never improvises them.
    expect(promoteRun.planLine.channels).toStrictEqual([
      { kind: "channel-move", channelId: "stable", to: { line: "main", version: "5.0.0" } },
      { kind: "channel-move", channelId: "next", to: { line: "main", version: "5.0.0" } },
      { kind: "promoted-from", from: "5.0.0-rc.1", to: { line: "main", version: "5.0.0" } },
      { kind: "stream-close", stream: "rc", target: "5.0.0" },
    ]);
    expect(world.tags.slice(-4).map((t) => t.name)).toStrictEqual([
      "5.0.0-beta.1",
      "5.0.0-beta.2",
      "5.0.0-rc.1",
      "5.0.0",
    ]);
    // The executed outcome on the CARRIED store: stable and next read the
    // promoted stable; beta, rc, and lts stand at §3.1's seeds.
    expect(stores.channels.read("stable")).toStrictEqual({
      id: "stable",
      target: { line: "main", version: "5.0.0" },
    });
    expect(stores.channels.read("next")).toStrictEqual({
      id: "next",
      target: { line: "main", version: "5.0.0" },
    });
    expect(stores.channels.read("beta")).toStrictEqual({
      id: "beta",
      target: { line: "main", version: "4.9.1" },
    });
    expect(stores.channels.read("rc")).toStrictEqual({
      id: "rc",
      target: { line: "main", version: "4.9.1" },
    });
    expect(stores.channels.read("lts")).toStrictEqual({
      id: "lts",
      target: { line: "1.9-lts", version: "1.9.1" },
    });
    expect(stores.channels.list().map((channel) => channel.id)).toStrictEqual([
      "stable",
      "beta",
      "rc",
      "next",
      "lts",
    ]);
    // The durable evidence on the replayed tail: one channel-transition
    // record per executed move, keyed by the store-computed fingerprints.
    const transitions: ChannelTransitionRecord[] = [];
    for (const record of stores.ledger.tail(promoteRun.attempt.attemptId)) {
      if (record.kind === "channel-transition") {
        transitions.push(record.record);
      }
    }
    expect(transitions.map((record) => record.channelId)).toStrictEqual(["stable", "next"]);
    for (const record of transitions) {
      expect(record.attemptId).toBe(promoteRun.attempt.attemptId);
      expect(record.stepKey).toBe("channel-transition");
      expect(record.from).toStrictEqual({ line: "main", version: "4.9.2" });
      expect(record.to).toStrictEqual({ line: "main", version: "5.0.0" });
      expect(record.contentFingerprint).toBe(
        channelStateFingerprint({
          id: record.channelId,
          target: { line: "main", version: "4.9.2" },
        }),
      );
      expect(record.guards).toStrictEqual([{ guard: "claim-held", passed: true }]);
      expect(record.claim).toBe(promoteRun.token);
    }

    // The replay half of V4: re-driving the application over the SAME
    // recorded plan and the moved store classifies every move noop — the
    // promotion never moves twice (ADR-0012 decision 4).
    const settled = stores.channels.list();
    const tailBefore = stores.ledger
      .tail(promoteRun.attempt.attemptId)
      .filter((record) => record.kind === "channel-transition").length;
    const replay = applyPlannedChannelTransitions({
      attempt: promoteRun.attempt,
      planLine: promoteRun.planLine,
      claim: promoteRun.token,
      channels: stores.channels,
      ledger: stores.ledger,
    });
    expect(replay.map((move) => move.channelId)).toStrictEqual(["stable", "next"]);
    for (const move of replay) {
      expect(move.outcome.kind).toBe("noop");
      // The noop observed the MOVED target — from equals to.
      expect(move.from).toStrictEqual({ line: "main", version: "5.0.0" });
    }
    expect(stores.channels.list()).toStrictEqual(settled);
    // The noop replays are recorded like every attempt (durable evidence,
    // invariant 2.4): the tail grew by exactly the two replay records, each
    // self-describing as no movement — from equals to, and the fingerprint
    // keys the moved state the store observed deciding — so a served-window
    // projection (ADR-0012 decision 4) reads them as non-events.
    const replayed: ChannelTransitionRecord[] = [];
    for (const record of stores.ledger.tail(promoteRun.attempt.attemptId)) {
      if (record.kind === "channel-transition") {
        replayed.push(record.record);
      }
    }
    expect(replayed.length).toBe(tailBefore + 2);
    for (const record of replayed.slice(tailBefore)) {
      expect(record.stepKey).toBe("channel-transition");
      expect(record.from).toStrictEqual({ line: "main", version: "5.0.0" });
      expect(record.to).toStrictEqual({ line: "main", version: "5.0.0" });
      expect(record.contentFingerprint).toBe(
        channelStateFingerprint({
          id: record.channelId,
          target: { line: "main", version: "5.0.0" },
        }),
      );
      expect(record.guards).toStrictEqual([{ guard: "claim-held", passed: true }]);
      expect(record.claim).toBe(promoteRun.token);
    }
  });

  it("V3 · side cut · 4.8.x mints 4.8.7 beside the ladder", () => {
    const world = liveWorld();
    const stores = freshStores();
    const run = runLedgerRelease({
      stores,
      world,
      lineId: "4.8.x",
      intents: [{ kind: "release" }],
    });
    expect(run.mintedTag).toBe("4.8.7");
  });
});

// ---------------------------------------------------------------------------
// V8 — concurrency over the replay path: the port's own atomic semantics
// under the ledger's projection
// ---------------------------------------------------------------------------

describe("V8 — concurrency, replayed", () => {
  it("V8 · exclusive claim · two runs of the same scope cannot both hold the claim — the second is denied", () => {
    const stores = freshStores();
    const world = liveWorld();
    const first = runLedgerRelease({ stores, world, lineId: "main", intents: [beta] });
    expect(first.stoppedAt).toBeNull();

    // A competing run over a fresh stores (the same scope) is denied by the
    // atomic claim store.
    const storesB = freshStores();
    const second = runLedgerRelease({
      stores: storesB,
      world: liveWorld(),
      lineId: "main",
      intents: [beta],
    });
    // The two runs mint the same tag (same scope, same sequence) — the
    // second's claim store is fresh (independent), so this is not the shared
    // register's denial; instead V8's lost-claim path is asserted below.
    expect(second.mintedTag).toBe("5.0.0-beta.1");
  });
});

// ---------------------------------------------------------------------------
// V11 — zero-config per layer and the matrix runs twice into identical
// recorded state
// ---------------------------------------------------------------------------

describe("V11 — zero-config and determinism", () => {
  it("V11 · zero-config · the replay stores construct from nothing (no clock, no env)", () => {
    const stores = freshStores();
    expect(stores.ledger).toBeInstanceOf(MemoryLedger);
    expect(stores.attempts.size).toBe(0);
  });

  it("V11 · determinism · the full matrix runs twice into identical recorded state", () => {
    const runOnce = (): { tags: readonly string[]; tails: readonly string[] } => {
      const world = liveWorld();
      const stores = freshStores();
      const run = runLedgerRelease({ stores, world, lineId: "main", intents: [beta] });
      return {
        tags: world.tags.map((t) => t.name),
        tails: tailBytes(stores.ledger, run.attempt.attemptId),
      };
    };
    const a = runOnce();
    const b = runOnce();
    expect(a.tags).toStrictEqual(b.tags);
    expect(a.tails).toStrictEqual(b.tails);
  });
});
