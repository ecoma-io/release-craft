/**
 * The harness fixture's own contract (issue #118): `freshAssembly` returns
 * the stores the assembly WIRED — a port override in `AssemblyOptions`
 * lands in `Assembly.stores`, and the ports left alone stay the bundle's
 * own fresh fixtures. Without this pin an evidence read through `.stores`
 * silently observes an empty default store while the engine records into
 * the override — the trap the #117 restart pins had to route around by
 * holding the shared store explicitly.
 */
import { describe, expect, it } from "vitest";

import { freshStores, liveWorld } from "../vertical/matrix.js";
import { beta, freshAssembly, fullDeclaration, runRequest, runToWorld } from "./harness.js";

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

    // The ports with no override are still the assembly's own fresh
    // fixtures — built by the bundle, wired by the assembly, never the
    // caller's stores.
    expect(assembly.stores.channels).not.toBe(shared.channels);
    expect(assembly.stores.log).not.toBe(shared.log);
  });
});
