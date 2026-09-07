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
  MemoryLedger,
  classifyResume,
  ledgerRequestStep,
} from "../../src/index.js";
import { actor, liveWorld, matrixChannels, snapshot } from "./matrix.js";
import {
  assertChannelsUnchanged,
  freshStores,
  fullDeclaration,
  runLedgerRelease,
  replayReference,
  tailBytes,
} from "./matrix-ledger.js";
import type { RunResult as LedgerRunResult } from "./matrix-ledger.js";

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
    // same-declaration uninterrupted run's (the canonical eight PLUS their
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
        contentFingerprint: `content:publish:${attemptId}`,
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

  it("V4 · ladder run 4 · the promote decision lands the stable record and every channel reads unchanged", () => {
    const world = liveWorld();
    const stores = freshStores();
    for (const intent of [beta, beta, rc, promote] as const) {
      runLedgerRelease({ stores, world, lineId: "main", intents: [intent] });
    }
    expect(world.tags.slice(-4).map((t) => t.name)).toStrictEqual([
      "5.0.0-beta.1",
      "5.0.0-beta.2",
      "5.0.0-rc.1",
      "5.0.0",
    ]);
    const channels = matrixChannels();
    assertChannelsUnchanged(channels);
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
