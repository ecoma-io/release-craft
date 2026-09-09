/**
 * The harness fixture's own contract (issue #118): `freshAssembly` returns
 * the stores the assembly WIRED — a port override in `AssemblyOptions`
 * lands in `Assembly.stores`, and the ports left alone stay the bundle's
 * own fresh fixtures. Without this pin an evidence read through `.stores`
 * silently observes an empty default store while the engine records into
 * the override — the trap the #117 restart pins had to route around by
 * holding the shared store explicitly. The two fixtures that are NOT
 * engine ports — `log` always, `channels` in the §2.4 store-less shape —
 * are pinned as the carve-outs the doc declares, so the contract cannot
 * overclaim silently.
 */
import { describe, expect, it } from "vitest";

import { assertStoreChannelsStanding, freshStores, liveWorld } from "../vertical/matrix.js";
import {
  beta,
  freshAssembly,
  fullDeclaration,
  promote,
  rc,
  runRequest,
  runToWorld,
} from "./harness.js";

describe("the harness fixture — the assembly's stores are the ports it wires (issue #118)", () => {
  it("an overridden ledger is the bundle's ledger — a run's recorded evidence reads back through it", () => {
    const shared = freshStores();
    const assembly = freshAssembly({ ledger: shared.ledger });
    const world = liveWorld();
    const outcome = runToWorld(
      assembly.engine,
      world,
      runRequest(world, "main", [beta], fullDeclaration()),
    );
    if (outcome.kind !== "published" || outcome.handle === null) {
      throw new Error("expected a published outcome");
    }

    // The bundle IS the wired port — identity, never a lookalike default.
    expect(assembly.stores.ledger).toBe(shared.ledger);

    // And the evidence reads back through the bundle: the recorded tail
    // the shared ledger holds — plan record included, the walk's own word —
    // not the empty silence of a private default.
    const tail = assembly.stores.ledger.tail(outcome.handle.attemptId);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.some((record) => record.kind === "plan")).toBe(true);
    expect(tail).toStrictEqual(shared.ledger.tail(outcome.handle.attemptId));
  });

  it("every overridden port is the bundle's port; the ports left alone stay the bundle's own fixtures", () => {
    const shared = freshStores();
    const assembly = freshAssembly({
      register: shared.register,
      ledger: shared.ledger,
      claims: shared.claims,
    });

    expect(assembly.stores.register).toBe(shared.register);
    expect(assembly.stores.ledger).toBe(shared.ledger);
    expect(assembly.stores.claims).toBe(shared.claims);

    // The fixtures with no override stay the assembly's own — built by
    // the bundle, never the caller's stores. Neither is a wired port:
    // `log` is the fixture driver's own, and `channels` reaches the
    // engine only when the assembly is not store-less.
    expect(assembly.stores.channels).not.toBe(shared.channels);
    expect(assembly.stores.log).not.toBe(shared.log);
  });

  it("the non-port fixtures stay honest — the engine never writes log; a store-less assembly's channels stay seeded", () => {
    // `log` is not an engine port: only the fixture driver appends
    // outcome records, so a full published boundary run leaves the
    // bundle's log untouched — the pin that keeps the doc's carve-out
    // true rather than decorative.
    const assembly = freshAssembly();
    const world = liveWorld();
    const published = runToWorld(
      assembly.engine,
      world,
      runRequest(world, "main", [beta], fullDeclaration()),
    );
    if (published.kind !== "published" || published.handle === null) {
      throw new Error("expected a published outcome");
    }
    expect(assembly.stores.log.records()).toStrictEqual([]);

    // The §2.4 store-less shape: the engine carries no channel store, so
    // a move-carrying promote run refuses before the walk starts — while
    // the bundle's channels fixture is exactly the seeded standing
    // states, unmoved by any engine.
    const storeless = freshAssembly({ withChannels: false });
    const ladderWorld = liveWorld();
    for (const intent of [beta, beta, rc]) {
      const rung = runToWorld(
        storeless.engine,
        ladderWorld,
        runRequest(ladderWorld, "main", [intent]),
      );
      if (rung.kind !== "published") {
        throw new Error(`fixture broken: the ladder run got ${rung.kind}`);
      }
    }
    const refused = storeless.engine.run(runRequest(ladderWorld, "main", [promote]));
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") {
      throw new Error("expected a refused outcome");
    }
    expect(refused.detail).toContain("no channel store");
    assertStoreChannelsStanding(storeless.stores.channels);
  });
});
