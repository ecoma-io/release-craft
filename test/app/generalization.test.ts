/**
 * The application boundary's generalization proof (the application boundary
 * contract §5, obligation 1): the boundary's engine over the reference
 * stores must reproduce the phase 10 vertical's outcomes *by outcome* —
 * same drives, same records, same channel moves, same terminal — never a
 * parallel walk that happens to agree. The comparison baseline is the
 * fixtures' own driver (`runRelease`), the slice-10.2 expression the
 * contract pins; the boundary run plans the same closed input and executes
 * through the public factories only.
 */
import { describe, expect, it } from "vitest";

import {
  assembleMemoryStores,
  MemoryAttemptRegister,
  plan,
  type ChannelTransitionRecord,
} from "../../src/index.js";
import {
  GOLDEN,
  freshStores,
  liveWorld,
  plannedOf,
  runRelease,
  runInput,
  type RunResult,
  type Stores,
} from "../vertical/matrix.js";
import {
  beta,
  freshAssembly,
  fullDeclaration,
  promote,
  rc,
  runRequest,
  runToWorld,
} from "./harness.js";

describe("obligation 1 — the boundary generalizes the vertical, outcome by outcome", () => {
  it("a beta run through the engine drives exactly the fixture driver's stage outcomes, record for record", () => {
    const declaration = fullDeclaration();
    const boundary = freshAssembly();
    const boundaryOutcome = boundary.engine.run(
      runRequest(liveWorld(), "main", [beta], declaration),
    );
    const fixture: RunResult = runRelease(
      { world: liveWorld(), lineId: "main", intents: [beta], ...declaration },
      false,
    );

    expect(boundaryOutcome.kind).toBe("published");
    if (boundaryOutcome.kind !== "published" || boundaryOutcome.handle === null) {
      throw new Error("expected a published outcome");
    }
    expect(boundaryOutcome.tag).toBe(GOLDEN.ladder[0]);
    expect(boundaryOutcome.handle.attemptId).toBe(fixture.attempt.attemptId);
    expect(boundaryOutcome.planId).toBe(fixture.assembled.planId);
    // The stage drives, outcome for outcome — the kernel's own values,
    // never translated (§2.8).
    expect(boundaryOutcome.drives.map((drive) => drive.stepKey)).toStrictEqual(
      fixture.drives.map((drive) => drive.stepKey),
    );
    expect(boundaryOutcome.drives).toStrictEqual(fixture.drives);
    // And the recorded evidence is the same ledger, byte for byte: plan
    // record, write-ahead starts, completions, channel stage records.
    expect(boundary.stores.ledger.tail(boundaryOutcome.handle.attemptId)).toStrictEqual(
      fixture.stores.ledger.tail(fixture.attempt.attemptId),
    );
  });

  it("the §3.2 ladder and the promote run land the same channels and records as the fixture driver", () => {
    const world = liveWorld();
    const { engine, stores } = freshAssembly();

    for (const expected of [GOLDEN.ladder[0], GOLDEN.ladder[1]]) {
      const outcome = runToWorld(engine, world, runRequest(world, "main", [beta]));
      expect(outcome.kind).toBe("published");
      if (outcome.kind !== "published") {
        throw new Error("expected a published outcome");
      }
      expect(outcome.tag).toBe(expected);
    }
    runToWorld(engine, world, runRequest(world, "main", [rc]));

    const promoteOutcome = runToWorld(engine, world, runRequest(world, "main", [promote]));
    expect(promoteOutcome.kind).toBe("published");
    if (promoteOutcome.kind !== "published" || promoteOutcome.handle === null) {
      throw new Error("expected a published outcome");
    }
    expect(promoteOutcome.tag).toBe(GOLDEN.ladder[3]);

    // The twin fixture run, ladder through promote on its own world.
    const fixtureWorld = liveWorld();
    const runLadder = (): void => {
      for (const intent of [beta, beta]) {
        runRelease({ world: fixtureWorld, lineId: "main", intents: [intent] });
      }
    };
    runLadder();
    runRelease({ world: fixtureWorld, lineId: "main", intents: [rc] });
    const fixturePromote = runRelease({
      world: fixtureWorld,
      lineId: "main",
      intents: [promote],
    });

    // The channel pointers: stable and next read the promoted stable; beta,
    // rc, and lts stand exactly where §3.1 seeded them.
    expect(stores.channels.list()).toStrictEqual(fixturePromote.stores.channels.list());
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
    expect(stores.channels.read("lts")).toStrictEqual({
      id: "lts",
      target: { line: "1.9-lts", version: "1.9.1" },
    });

    // The durable evidence: one channel-transition record per executed move,
    // in declaration order, keyed by the standing prior target's fingerprint,
    // carrying the held claim — the same records the fixture driver's
    // application half appended. The one normalized field is the claim
    // token: the fixture driver rebuilds its stores per run, so its token
    // counter restarts, while the boundary engine holds one claim store
    // across the ladder — the record carries the engine's own held token,
    // which `observe` reads back (§2.9: no door around the claim).
    const observation = engine.observe({
      kind: "attempt",
      handle: promoteOutcome.handle,
    });
    if (observation.kind !== "attempt") {
      throw new Error(`expected an attempt observation, got ${observation.kind}`);
    }
    expect(observation.claim).not.toBeNull();
    if (observation.claim === null) {
      throw new Error("expected a held claim on the promoted attempt");
    }
    const heldToken = observation.claim.token;
    const transitionsOf = (
      tail: readonly ReturnType<Stores["ledger"]["tail"]>[number][],
    ): readonly ChannelTransitionRecord[] =>
      tail.flatMap((record) => (record.kind === "channel-transition" ? [record.record] : []));
    const withSharedToken = (
      records: readonly ChannelTransitionRecord[],
    ): readonly ChannelTransitionRecord[] =>
      records.map((record) => ({ ...record, claim: "<held>" }));
    const boundaryTransitions = transitionsOf(stores.ledger.tail(promoteOutcome.handle.attemptId));
    expect(boundaryTransitions.map((record) => record.channelId)).toStrictEqual(["stable", "next"]);
    for (const record of boundaryTransitions) {
      expect(record.claim).toBe(heldToken);
    }
    expect(withSharedToken(boundaryTransitions)).toStrictEqual(
      withSharedToken(
        transitionsOf(fixturePromote.stores.ledger.tail(fixturePromote.attempt.attemptId)),
      ),
    );
  });

  it("a side line's stable cut publishes its own §3.3 version through the same door", () => {
    const { engine } = freshAssembly();
    const outcome = engine.run(runRequest(liveWorld(), "4.8.x", [{ kind: "release" }]));
    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published") {
      throw new Error("expected a published outcome");
    }
    expect(outcome.tag).toBe(GOLDEN.sides["4.8.x"]);
  });
});

describe("obligation 6 — determinism, no ambient values, assembly inertness", () => {
  it("plan-only double-run over one engine is identical (invariant 2.2 inherited)", () => {
    const { engine } = freshAssembly();
    const world = liveWorld();
    const input = runInput(world, "main", [beta]);
    const first = engine.plan(input);
    const second = engine.plan(input);
    expect(second).toStrictEqual(first);
    expect(plannedOf(first).plan.planId).toBe(plannedOf(second).plan.planId);
  });

  it("two fresh assemblies over the same world land identical outcomes and identical ledgers", () => {
    const declaration = fullDeclaration();
    const first = freshAssembly();
    const second = freshAssembly();
    const firstOutcome = first.engine.run(runRequest(liveWorld(), "main", [beta], declaration));
    const secondOutcome = second.engine.run(runRequest(liveWorld(), "main", [beta], declaration));
    expect(secondOutcome).toStrictEqual(firstOutcome);
    if (
      firstOutcome.kind !== "published" ||
      firstOutcome.handle === null ||
      secondOutcome.kind !== "published" ||
      secondOutcome.handle === null
    ) {
      throw new Error("expected a published outcome");
    }
    expect(second.stores.ledger.tail(secondOutcome.handle.attemptId)).toStrictEqual(
      first.stores.ledger.tail(firstOutcome.handle.attemptId),
    );
  });

  it("assembling an engine touches no store: the first run still allocates ordinal 1 and the channels stand", () => {
    const world = liveWorld();
    const stores = freshStores();
    const planId = plannedOf(plan(runInput(world, "main", [beta]))).plan.planId;
    assembleMemoryStores(
      {
        register: stores.register,
        ledger: stores.ledger,
        claims: stores.claims,
        channels: stores.channels,
      },
      { maxRetries: 2 },
    );
    // The register answers ordinal 1 — an assembly that had opened an
    // attempt would have consumed it.
    expect(stores.register.nextOrdinal(planId)).toBe(1);
    // And the wired channel store still reads its §3.1 seeds, untouched.
    expect(stores.channels.read("stable")).toStrictEqual({
      id: "stable",
      target: { line: "main", version: "4.9.2" },
    });
  });

  it("the assembly config is the closed set §2.2 names — anything else refuses at the door", () => {
    const stores = freshStores();
    const bundle = {
      register: stores.register,
      ledger: stores.ledger,
      claims: stores.claims,
    };
    expect(() => assembleMemoryStores(bundle, { maxRetries: -1 })).toThrow(
      /maxRetries must be a non-negative integer/,
    );
    expect(() => assembleMemoryStores(bundle, { maxRetries: 1.5 })).toThrow(
      /maxRetries must be a non-negative integer/,
    );
    expect(() =>
      assembleMemoryStores(bundle, {
        maxRetries: 2,
        clock: "now",
      } as unknown as { maxRetries: number }),
    ).toThrow(/unknown keys "clock"/);
    // A fresh register answers ordinal 1 after every refused assembly — the
    // refusals touched nothing.
    const planId = plannedOf(plan(runInput(liveWorld(), "main", [beta]))).plan.planId;
    expect(new MemoryAttemptRegister().nextOrdinal(planId)).toBe(1);
  });
});
