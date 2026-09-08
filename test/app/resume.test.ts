/**
 * The durable resume (the application boundary contract §2.5, obligation 5;
 * V7's crash classes carried through the boundary): `.resume` classifies
 * from the recorded tail and never re-plans (invariant 2.3); the blocked
 * loop closes only over a recorded resolution; and the crash window is real
 * here — a user effect that throws mid-walk leaves the write-ahead start
 * durable, the fault escapes the door (a fault, not a classification), and
 * the resume re-judges from the tail, running the effect exactly once more.
 */
import { describe, expect, it } from "vitest";

import {
  assembleMemoryStores,
  InvalidExecutionTransitionError,
  type AttemptHandle,
  type Engine,
  type LedgerRecord,
  type RunDeclarations,
} from "../../src/index.js";
import { freshStores, GOLDEN, liveWorld, matrixHooks } from "../vertical/matrix.js";
import {
  CapturingLedger,
  FOREIGN_PLAN,
  beta,
  freshAssembly,
  fullDeclaration,
  runRequest,
  SwitchableClaimStore,
} from "./harness.js";

/** One hook's declaration — the effect returns the given proof, or no proof
 * at all when `proof` is undefined (the §2.5 escalation window). */
function hookDeclaration(
  hookId: "attest" | "sign",
  proof: { readonly evidence?: string; readonly contentFingerprint?: string } | undefined,
): RunDeclarations {
  const hooks = matrixHooks();
  const hook = hooks[hookId];
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

/** The attempt observation, or the test's own failure — never a partial
 * answer read as an attempt. */
function observedAttempt(engine: Engine, handle: AttemptHandle) {
  const observation = engine.observe({ kind: "attempt", handle });
  if (observation.kind !== "attempt") {
    throw new Error(`expected an attempt observation, got ${observation.kind}`);
  }
  return observation;
}

describe("obligation 5 — the blocked loop closes over a recorded resolution", () => {
  it("blocked, re-armed, resumed: the walk re-enters at the failed hook and publishes", () => {
    const assembly = freshAssembly();
    const world = liveWorld();
    const stopped = assembly.engine.run(
      runRequest(world, "main", [beta], hookDeclaration("attest", undefined)),
    );
    expect(stopped.kind).toBe("blocked");
    if (stopped.kind !== "blocked" || stopped.handle === null || stopped.planId === null) {
      throw new Error("expected a blocked outcome");
    }
    expect(stopped.cause).toBe("validation:hook:attest:evidence-present");
    const handle = stopped.handle;
    expect(observedAttempt(assembly.engine, handle).state).toBe("blocked");

    // A resolution naming a plan the attempt does not carry is the kernel's
    // named violation (E-05): the boundary rethrows, nothing re-arms.
    expect(() =>
      assembly.engine.resolve(handle, "hook:attest", {
        kind: "revalidation",
        planFingerprint: FOREIGN_PLAN,
      }),
    ).toThrow(InvalidExecutionTransitionError);
    expect(observedAttempt(assembly.engine, handle).state).toBe("blocked");

    // The true resolution: the recorded re-provement of the stored plan.
    const resolved = assembly.engine.resolve(handle, "hook:attest", {
      kind: "revalidation",
      planFingerprint: stopped.planId,
    });
    expect(resolved.kind).toBe("resolved");
    const mid = assembly.stores.ledger.tail(stopped.handle.attemptId);
    expect(mid.filter((record) => record.kind === "resolution")).toHaveLength(1);

    // The resume re-judges from the tail — the hook re-runs with its proof,
    // and the walk completes to the same tag the direct run mints.
    const outcome = assembly.engine.resume(
      stopped.handle,
      runRequest(world, "main", [beta], hookDeclaration("attest", { evidence: "evidence:attest" })),
    );
    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published" || outcome.handle === null) {
      throw new Error("expected a published outcome");
    }
    expect(outcome.tag).toBe(GOLDEN.ladder[0]);
    expect(
      recordedTos(assembly.stores.ledger.tail(outcome.handle.attemptId), "hook:attest"),
    ).toStrictEqual(["started", "failed", "started", "completed"]);
  });

  it("the sign hook's unmet proof blocks, re-arms, and completes on the resume", () => {
    const assembly = freshAssembly();
    const world = liveWorld();
    const stopped = assembly.engine.run(
      runRequest(world, "main", [beta], hookDeclaration("sign", undefined)),
    );
    expect(stopped.kind).toBe("blocked");
    if (stopped.kind !== "blocked" || stopped.handle === null || stopped.planId === null) {
      throw new Error("expected a blocked outcome");
    }
    expect(stopped.cause).toBe("validation:hook:sign:content-fingerprint-present");
    const resolved = assembly.engine.resolve(stopped.handle, "hook:sign", {
      kind: "revalidation",
      planFingerprint: stopped.planId,
    });
    expect(resolved.kind).toBe("resolved");
    const outcome = assembly.engine.resume(
      stopped.handle,
      runRequest(
        world,
        "main",
        [beta],
        hookDeclaration("sign", { contentFingerprint: "content:sign" }),
      ),
    );
    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published" || outcome.handle === null) {
      throw new Error("expected a published outcome");
    }
    // The hook re-entered where it failed — the stage steps before it were
    // never re-executed, and the proof's completion record stands once.
    const tail = assembly.stores.ledger.tail(outcome.handle.attemptId);
    expect(recordedTos(tail, "hook:sign")).toStrictEqual([
      "started",
      "failed",
      "started",
      "completed",
    ]);
  });
});

describe("obligation 5 — the crash window: a mid-effect fault escapes, the tail re-judges", () => {
  it("a throwing hook effect escapes the door with the start durable; the resume runs the effect exactly once more", () => {
    const stores = freshStores();
    const ledger = new CapturingLedger(stores.ledger);
    const engine = assembleMemoryStores(
      {
        register: stores.register,
        ledger,
        claims: stores.claims,
        channels: stores.channels,
      },
      { maxRetries: 2 },
    );
    const world = liveWorld();
    const declaration = fullDeclaration();
    const effects = new Map(declaration.hookEffects ?? []);
    let invocations = 0;
    effects.set("announce", (input) => {
      invocations += 1;
      if (invocations === 1) {
        throw new Error("the announce webhook crashed mid-flight");
      }
      return {
        attribution: { attemptId: input.attemptId, actor: "automation" },
        evidence: "evidence:announce",
      };
    });

    // The fault is not a classification: it escapes the door untouched —
    // but only after the hook's write-ahead start is durable.
    expect(() =>
      engine.run(runRequest(world, "main", [beta], { ...declaration, hookEffects: effects })),
    ).toThrow("the announce webhook crashed mid-flight");
    const attemptId = ledger.attemptIds[0];
    if (attemptId === undefined || ledger.planIds[0] === undefined) {
      throw new Error("fixture broken: the ledger captured no attempt write");
    }
    expect(stores.ledger.step(attemptId, "hook:announce")).toBe("started");

    // The resume classifies from the recorded tail — never a re-plan — and
    // the effect runs exactly once more, to the published terminal.
    const handle: AttemptHandle = {
      planId: ledger.planIds[0],
      attemptId,
      actor: "automation",
    };
    const outcome = engine.resume(
      handle,
      runRequest(world, "main", [beta], { ...declaration, hookEffects: effects }),
    );
    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published" || outcome.handle === null) {
      throw new Error("expected a published outcome");
    }
    expect(invocations).toBe(2);
    const tail = stores.ledger.tail(attemptId);
    expect(recordedTos(tail, "hook:announce")).toStrictEqual(["started", "started", "completed"]);
  });
});

describe("obligation 5 — the loser path recovers from the recorded tail", () => {
  it("a claim-lost stop is a failed outcome, not a failed attempt; the resume lands the stopped stage", () => {
    const stores = freshStores();
    const claims = new SwitchableClaimStore(stores.claims);
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
    const declaration = fullDeclaration();
    const producers = new Map(declaration.producers ?? []);
    producers.set("package", (input) => {
      claims.honest = false;
      return {
        attribution: { attemptId: input.attemptId, actor: "automation" },
        digest: "digest:package",
        evidence: "evidence:package",
      };
    });
    const stopped = engine.run(runRequest(world, "main", [beta], { ...declaration, producers }));
    expect(stopped.kind).toBe("failed");
    if (stopped.kind !== "failed" || stopped.handle === null) {
      throw new Error("expected a failed outcome");
    }
    expect(stopped.cause).toContain("no longer verifies");
    expect(observedAttempt(engine, stopped.handle).state).toBe("executing");

    // The claim is back; the resume re-judges from the durable commit start
    // and lands the stopped stage — the failure was the walk's stop, never
    // the attempt's state.
    claims.honest = true;
    const outcome = engine.resume(stopped.handle, runRequest(world, "main", [beta], declaration));
    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published" || outcome.handle === null) {
      throw new Error("expected a published outcome");
    }
    expect(outcome.tag).toBe(GOLDEN.ladder[0]);
    const tail = stores.ledger.tail(outcome.handle.attemptId);
    expect(recordedTos(tail, "commit")).toStrictEqual(["started", "completed"]);
  });
});
