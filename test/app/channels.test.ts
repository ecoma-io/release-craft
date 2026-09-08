/**
 * The application boundary's channel-transition wiring, pinned (the
 * application boundary contract §2.4; obligation 4). The engine executes
 * the recorded plan's moves through the wired store at exactly one place —
 * between the ledger's write-ahead start and the advancing completion —
 * and a store-less assembly refuses a move-carrying plan before the walk
 * starts. Ambiguity is pinned twice: the returned outcome that stops the
 * walk, and the resume that re-judges from the durable started record.
 */
import { describe, expect, it } from "vitest";

import {
  assembleMemoryStores,
  channelStateFingerprint,
  MemoryChannelStore,
  type ChannelTransitionRecord,
  type LedgerRecord,
} from "../../src/index.js";
import {
  assertStoreChannelsStanding,
  freshStores,
  liveWorld,
  standingChannelStates,
} from "../vertical/matrix.js";
import { beta, freshAssembly, promote, rc, runRequest, runToWorld } from "./harness.js";

/** A promote assembly whose channel store carries the one-shot ambiguous
 * fault — the store that cannot determine whether its effect landed. */
function ambiguousAssembly(): ReturnType<typeof freshAssembly> & { channels: MemoryChannelStore } {
  const stores = freshStores();
  const channels = new MemoryChannelStore({
    channels: standingChannelStates(),
    ambiguousNext: "the CAS confirmation was lost after the write",
  });
  const engine = assembleMemoryStores(
    {
      register: stores.register,
      ledger: stores.ledger,
      claims: stores.claims,
      channels,
    },
    { maxRetries: 2 },
  );
  return { engine, stores, channels };
}

const stepRecordsOf = (tail: readonly LedgerRecord[]): readonly LedgerRecord[] =>
  tail.filter((record) => record.kind === "step");

const channelRecordsOf = (tail: readonly LedgerRecord[]): readonly ChannelTransitionRecord[] =>
  tail.flatMap((record) => (record.kind === "channel-transition" ? [record.record] : []));

/** The §3.2 ladder through the boundary — beta, beta, rc, the world
 * observing each minted tag — so the promote run's plan carries moves. */
function stageLadder(
  engine: ReturnType<typeof freshAssembly>["engine"],
  world: ReturnType<typeof liveWorld>,
): void {
  for (const intent of [beta, beta, rc]) {
    const outcome = runToWorld(engine, world, runRequest(world, "main", [intent]));
    if (outcome.kind !== "published") {
      throw new Error(`fixture broken: the ladder run got ${outcome.kind}`);
    }
  }
}

describe("obligation 4 — the channel-transition stage executes through the wired store", () => {
  it("the write-ahead start is durable before any move lands and the completion after every one", () => {
    const { engine, stores } = freshAssembly();
    const world = liveWorld();
    stageLadder(engine, world);
    const outcome = engine.run(runRequest(world, "main", [promote]));
    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published" || outcome.handle === null) {
      throw new Error("expected a published outcome");
    }
    const tail = stores.ledger.tail(outcome.handle.attemptId);
    const startedIndex = tail.findIndex(
      (record) =>
        record.kind === "step" &&
        record.record.stepKey === "channel-transition" &&
        record.record.to === "started",
    );
    const completedIndex = tail.findIndex(
      (record) =>
        record.kind === "step" &&
        record.record.stepKey === "channel-transition" &&
        record.record.to === "completed",
    );
    const moves = channelRecordsOf(tail);
    expect(startedIndex).toBeGreaterThanOrEqual(0);
    expect(completedIndex).toBeGreaterThan(startedIndex);
    expect(moves.length).toBe(2);
    expect(tail.findIndex((record) => record.kind === "channel-transition")).toBeGreaterThan(
      startedIndex,
    );
    expect(tail.findIndex((record) => record.kind === "channel-transition") + 1).toBeLessThan(
      completedIndex,
    );
  });

  it("a plan with no moves records nothing at the channel stage and leaves the §3.1 seeds standing", () => {
    const { engine, stores } = freshAssembly();
    const outcome = engine.run(runRequest(liveWorld(), "main", [beta]));
    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published" || outcome.handle === null) {
      throw new Error("expected a published outcome");
    }
    expect(channelRecordsOf(stores.ledger.tail(outcome.handle.attemptId))).toStrictEqual([]);
    assertStoreChannelsStanding(stores.channels);
  });

  it("a move-carrying plan over a store-less assembly refuses before the walk starts", () => {
    const { engine } = freshAssembly({ withChannels: false });
    const world = liveWorld();
    stageLadder(engine, world);
    const outcome = engine.run(runRequest(world, "main", [promote]));
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") {
      throw new Error("expected a refused outcome");
    }
    expect(outcome.detail).toContain("channel-transition");
    expect(outcome.detail).toContain("no channel store");
    expect(outcome.planId).not.toBeNull();
    expect(outcome.handle).toBeNull();
    expect(outcome.drives).toStrictEqual([]);
    // Refused before the walk: no attempt exists to carry — the refusal
    // named the stage and the missing port, and nothing was opened.
    const probe = engine.observe({
      kind: "attempt",
      handle: {
        planId: outcome.planId ?? "",
        attemptId: "attempt_sha256:probe",
        actor: "automation",
      },
    });
    expect(probe.kind).toBe("refused");
    if (probe.kind !== "refused") {
      throw new Error("expected a refused observation");
    }
    expect(probe.detail).toContain("unknown attempt");
  });

  it("the stage re-applying a landed move classifies noop and records what the store observed", () => {
    const { engine, stores } = freshAssembly();
    const world = liveWorld();
    stageLadder(engine, world);
    // The concurrent writer's landing: stable already reads the promoted
    // target before the run — the store's own state, not the plan's trust.
    const landed = stores.channels.applyTransition({
      channelId: "stable",
      from: { line: "main", version: "4.9.2" },
      to: { line: "main", version: "5.0.0" },
    });
    expect(landed.kind).toBe("applied");
    const outcome = engine.run(runRequest(world, "main", [promote]));
    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published" || outcome.handle === null) {
      throw new Error("expected a published outcome");
    }
    const moves = channelRecordsOf(stores.ledger.tail(outcome.handle.attemptId));
    expect(moves.map((record) => record.channelId)).toStrictEqual(["stable", "next"]);
    // The noop: from equals to — the store observed the move already standing
    // — and the record keys exactly that observed state.
    expect(moves[0]?.from).toStrictEqual({ line: "main", version: "5.0.0" });
    expect(moves[0]?.to).toStrictEqual({ line: "main", version: "5.0.0" });
    expect(moves[0]?.contentFingerprint).toBe(
      channelStateFingerprint({ id: "stable", target: { line: "main", version: "5.0.0" } }),
    );
    // The second move applied on top of the standing first.
    expect(moves[1]?.from).toStrictEqual({ line: "main", version: "4.9.2" });
    expect(moves[1]?.to).toStrictEqual({ line: "main", version: "5.0.0" });
    expect(stores.channels.read("next")).toStrictEqual({
      id: "next",
      target: { line: "main", version: "5.0.0" },
    });
  });
});

describe("obligation 4 — ambiguity never reads as success (invariant 2.6), pinned twice", () => {
  it("first pin — the run returns the ambiguous outcome, the move records nothing, the start stands", () => {
    const assembly = ambiguousAssembly();
    const world = liveWorld();
    stageLadder(assembly.engine, world);
    const outcome = assembly.engine.run(runRequest(world, "main", [promote]));
    expect(outcome.kind).toBe("ambiguous");
    if (outcome.kind !== "ambiguous" || outcome.handle === null) {
      throw new Error("expected an ambiguous outcome");
    }
    expect(outcome.detail).toContain("stable");
    expect(outcome.detail).toContain("does not race forward");
    // Nothing terminalized, nothing moved: the attempt stays open, the
    // pointer stands at its §3.1 seed.
    const observation = assembly.engine.observe({ kind: "attempt", handle: outcome.handle });
    if (observation.kind !== "attempt") {
      throw new Error(`expected an attempt observation, got ${observation.kind}`);
    }
    expect(observation.state).toBe("executing");
    expect(observation.channels?.find((channel) => channel.id === "stable")?.target).toStrictEqual({
      line: "main",
      version: "4.9.2",
    });
    // The durable evidence: the write-ahead start stands, the ambiguous move
    // recorded nothing, the stage's completion never appended.
    const tail = assembly.stores.ledger.tail(outcome.handle.attemptId);
    const stepKeys = stepRecordsOf(tail).map((record) =>
      record.kind === "step" ? record.record.stepKey : "",
    );
    expect(stepKeys).toContain("channel-transition");
    expect(channelRecordsOf(tail)).toStrictEqual([]);
    const recorded = stepRecordsOf(tail).at(-1);
    expect(recorded?.kind === "step" ? recorded.record.to : undefined).toBe("started");
  });

  it("second pin — the resume re-judges from the durable started record and lands the moves", () => {
    const assembly = ambiguousAssembly();
    const world = liveWorld();
    stageLadder(assembly.engine, world);
    const stopped = assembly.engine.run(runRequest(world, "main", [promote]));
    expect(stopped.kind).toBe("ambiguous");
    if (stopped.kind !== "ambiguous" || stopped.handle === null) {
      throw new Error("expected an ambiguous outcome");
    }
    // The fault was one-shot; the resume re-enters at the channel stage —
    // the classification's own entry point — and the moves land. The resume
    // request carries the handle and the (unused) input — a resume never
    // re-plans.
    const outcome = assembly.engine.resume(stopped.handle, runRequest(world, "main", [promote]));
    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published" || outcome.handle === null) {
      throw new Error("expected a published outcome");
    }
    expect(outcome.tag).toBe("5.0.0");
    expect(assembly.channels.read("stable")).toStrictEqual({
      id: "stable",
      target: { line: "main", version: "5.0.0" },
    });
    expect(assembly.channels.read("next")).toStrictEqual({
      id: "next",
      target: { line: "main", version: "5.0.0" },
    });
    // Both moves recorded on the resumed walk, in declaration order, and the
    // stage completed after them.
    const tail = assembly.stores.ledger.tail(outcome.handle.attemptId);
    expect(channelRecordsOf(tail).map((record) => record.channelId)).toStrictEqual([
      "stable",
      "next",
    ]);
    const completions = stepRecordsOf(tail).filter(
      (record) => record.kind === "step" && record.record.to === "completed",
    );
    expect(
      completions.some(
        (record) => record.kind === "step" && record.record.stepKey === "channel-transition",
      ),
    ).toBe(true);
  });
});
