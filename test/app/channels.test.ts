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
  type Claim,
  type ClaimDenied,
  type ClaimScope,
  type ClaimStore,
  type ClaimToken,
  type ClaimVerification,
  type ExecutionLedger,
  type HookStep,
  type LedgerRecord,
  type RunDeclarations,
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

/** A claim store whose token stops verifying once the holder's tag stage
 * has completed and the sever is armed — the E-07 loser path produced
 * through the port itself, aimed at the window between tag and the
 * channel stage. Acquisition and release always delegate; the ladder's
 * runs are never armed, so they walk honestly. (The delegation methods
 * are the DI seam this test fault stands on.) */
class SeverAfterTagClaimStore implements ClaimStore {
  readonly #inner: ClaimStore;
  readonly #ledger: ExecutionLedger;
  /** When true, a held token whose holder has completed tag verifies lost. */
  severAfterTag = false;
  constructor(inner: ClaimStore, ledger: ExecutionLedger) {
    this.#inner = inner;
    this.#ledger = ledger;
  }
  acquire(scope: ClaimScope, attemptId: string): Claim | ClaimDenied {
    return this.#inner.acquire(scope, attemptId);
  }
  verify(token: ClaimToken): ClaimVerification {
    const verification = this.#inner.verify(token);
    if (verification.kind !== "held") {
      return verification;
    }
    if (this.severAfterTag && this.#ledger.step(verification.claim.holder, "tag") === "completed") {
      return { kind: "lost" };
    }
    return verification;
  }
  release(token: ClaimToken): void {
    this.#inner.release(token);
  }
}

describe("§2.4 — channel transitions respect the claim guard (issue #192)", () => {
  it("a claim lost before the channel stage must not let moves land", () => {
    const stores = freshStores();
    const claims = new SeverAfterTagClaimStore(stores.claims, stores.ledger);
    const engine = assembleMemoryStores(
      {
        register: stores.register,
        ledger: stores.ledger,
        claims,
        channels: stores.channels,
      },
      { maxRetries: 2 },
    );
    const world = liveWorld();
    stageLadder(engine, world);
    // The promote run walks with the claim severed after tag — the guard at
    // the channel stage must then refuse the stage before any store CAS
    // runs (§2.4: a move lands only under a held claim, E-07's loser path).
    claims.severAfterTag = true;
    const outcome = engine.run(runRequest(world, "main", [promote]));
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed" || outcome.handle === null) {
      throw new Error("expected a failed outcome");
    }
    expect(outcome.cause).toContain("no longer verifies");
    // The walk stopped at the channel stage with the claim-lost outcome.
    const last = outcome.drives.at(-1);
    expect(last?.stepKey).toBe("channel-transition");
    expect(last?.outcome.kind).toBe("claim-lost");
    // No pointer moved: the store still reads its §3.1 seed — the moves
    // never landed ahead of the guard.
    expect(stores.channels.read("stable")).toStrictEqual({
      id: "stable",
      target: { line: "main", version: "4.9.2" },
    });
    // The durable evidence agrees: the stage recorded no move at all.
    const tail = stores.ledger.tail(outcome.handle.attemptId);
    expect(channelRecordsOf(tail)).toStrictEqual([]);
  });

  it("the landed move's record carries the claim verdict a check actually performed", () => {
    const { engine, stores } = freshAssembly();
    const world = liveWorld();
    stageLadder(engine, world);
    const outcome = engine.run(runRequest(world, "main", [promote]));
    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published" || outcome.handle === null) {
      throw new Error("expected a published outcome");
    }
    const moves = channelRecordsOf(stores.ledger.tail(outcome.handle.attemptId));
    expect(moves.length).toBe(2);
    for (const move of moves) {
      // The claim was held and verified under this walk: the record
      // carries the guard's real verdict and the token that verified.
      expect(move.guards).toStrictEqual([{ guard: "claim-held", passed: true }]);
      expect(move.claim).toBeDefined();
    }
  });
});

/** One hook's declaration anchored at the channel-transition stage's after
 * boundary — the extension whose refusal suspends the attempt only once the
 * stage's completion and both moves are durable. The effect returns the
 * given proof, or no proof at all when `proof` is undefined (the §2.5
 * escalation window). */
function channelHookDeclaration(proof: { readonly evidence: string } | undefined): RunDeclarations {
  const hook: HookStep = {
    id: "release-note",
    anchor: { stage: "channel-transition", position: "after" },
    guard: "release-line",
    postconditions: ["evidence-present"],
  };
  return {
    hooks: [hook],
    hookEffects: new Map([
      [
        hook.id,
        (input) => ({
          attribution: { attemptId: input.attemptId, actor: "automation" },
          ...(proof === undefined ? {} : proof),
        }),
      ],
    ]),
  };
}

/** One step's recorded transitions, append order — the durable evidence the
 * resume re-judged from. */
const recordedTos = (tail: readonly LedgerRecord[], stepKey: string): readonly string[] =>
  tail.flatMap((record) =>
    record.kind === "step" && record.record.stepKey === stepKey ? [record.record.to] : [],
  );

describe("§2.4 — a completed channel stage is never re-executed (issue #192's review)", () => {
  it("a channel-anchored hook left uncompleted after the stage completed: the resume replays the stage noop and re-applies nothing", () => {
    const assembly = freshAssembly();
    const world = liveWorld();
    stageLadder(assembly.engine, world);
    const stopped = assembly.engine.run(
      runRequest(world, "main", [promote], channelHookDeclaration(undefined)),
    );
    expect(stopped.kind).toBe("blocked");
    if (stopped.kind !== "blocked" || stopped.handle === null || stopped.planId === null) {
      throw new Error("expected a blocked outcome");
    }
    expect(stopped.cause).toBe("validation:hook:release-note:evidence-present");
    const attemptId = stopped.handle.attemptId;
    const tailBefore = assembly.stores.ledger.tail(attemptId);
    // The stage completed with its moves before the hook refused: both moves
    // landed and were recorded, the completion stands after them.
    const movesBefore = channelRecordsOf(tailBefore);
    expect(movesBefore.map((record) => record.channelId)).toStrictEqual(["stable", "next"]);
    expect(recordedTos(tailBefore, "channel-transition")).toStrictEqual(["started", "completed"]);

    const resolved = assembly.engine.resolve(stopped.handle, "hook:release-note", {
      kind: "revalidation",
      planFingerprint: stopped.planId,
    });
    expect(resolved.kind).toBe("resolved");

    // The resume re-enters at the hook's anchor stage. The completed stage
    // replays noop — and its moves never re-apply: every move was decided in
    // the run that completed the stage, so the replay appends no second
    // generation of move records over the same verdict that never verified
    // the claim.
    const outcome = assembly.engine.resume(
      stopped.handle,
      runRequest(
        world,
        "main",
        [promote],
        channelHookDeclaration({ evidence: "evidence:release-note" }),
      ),
    );
    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published" || outcome.handle === null) {
      throw new Error("expected a published outcome");
    }
    expect(outcome.tag).toBe("5.0.0");
    const tail = assembly.stores.ledger.tail(outcome.handle.attemptId);
    expect(channelRecordsOf(tail)).toStrictEqual(movesBefore);
    expect(recordedTos(tail, "channel-transition")).toStrictEqual(["started", "completed"]);
    // The walk PROCEEDED past the stage-noop: the replay drive is the noop,
    // and the later stages advanced to the published terminal.
    expect(outcome.drives).toContainEqual({
      stepKey: "channel-transition",
      outcome: { kind: "noop", stepKey: "channel-transition" },
    });
    expect(recordedTos(tail, "hook:release-note")).toStrictEqual([
      "started",
      "failed",
      "started",
      "completed",
    ]);
    expect(recordedTos(tail, "publish")).toStrictEqual(["started", "completed"]);
    expect(assembly.stores.channels.read("stable").target).toStrictEqual({
      line: "main",
      version: "5.0.0",
    });
    expect(assembly.stores.channels.read("next").target).toStrictEqual({
      line: "main",
      version: "5.0.0",
    });
  });

  it("an out-of-band drift between the runs is not re-pointed by the completed stage's replay", () => {
    const assembly = freshAssembly();
    const world = liveWorld();
    stageLadder(assembly.engine, world);
    const stopped = assembly.engine.run(
      runRequest(world, "main", [promote], channelHookDeclaration(undefined)),
    );
    expect(stopped.kind).toBe("blocked");
    if (stopped.kind !== "blocked" || stopped.handle === null || stopped.planId === null) {
      throw new Error("expected a blocked outcome");
    }
    const attemptId = stopped.handle.attemptId;
    const movesBefore = channelRecordsOf(assembly.stores.ledger.tail(attemptId));
    expect(movesBefore.map((record) => record.channelId)).toStrictEqual(["stable", "next"]);

    // Between the runs, a concurrent writer moves stable past the plan's
    // target — the drift the plan knows nothing of.
    const drifted = assembly.stores.channels.applyTransition({
      channelId: "stable",
      from: { line: "main", version: "5.0.0" },
      to: { line: "main", version: "6.0.0" },
    });
    expect(drifted.kind).toBe("applied");
    const resolved = assembly.engine.resolve(stopped.handle, "hook:release-note", {
      kind: "revalidation",
      planFingerprint: stopped.planId,
    });
    expect(resolved.kind).toBe("resolved");

    const outcome = assembly.engine.resume(
      stopped.handle,
      runRequest(
        world,
        "main",
        [promote],
        channelHookDeclaration({ evidence: "evidence:release-note" }),
      ),
    );
    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published" || outcome.handle === null) {
      throw new Error("expected a published outcome");
    }
    // The store is NOT re-pointed: a completed stage's replay never CASes,
    // so the drifted target stands and no move record lands over it — the
    // silent second move ADR-0012's replay ladder forbids.
    expect(assembly.stores.channels.read("stable")).toStrictEqual({
      id: "stable",
      target: { line: "main", version: "6.0.0" },
    });
    const tail = assembly.stores.ledger.tail(outcome.handle.attemptId);
    expect(channelRecordsOf(tail)).toStrictEqual(movesBefore);
    // The walk still proceeded past the stage-noop to the published terminal.
    expect(outcome.drives).toContainEqual({
      stepKey: "channel-transition",
      outcome: { kind: "noop", stepKey: "channel-transition" },
    });
    expect(recordedTos(tail, "hook:release-note")).toStrictEqual([
      "started",
      "failed",
      "started",
      "completed",
    ]);
  });
});
