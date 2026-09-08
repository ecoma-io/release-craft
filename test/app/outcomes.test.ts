/**
 * The §2.8 outcome table, row by row, through the public doors only (the
 * application boundary contract §5, obligation 3). Every row is a returned
 * value — no exception crosses the boundary for anything the engine
 * classifies — and the kernel's own violations (terminal attempts, blocked
 * doors) are the throws the table's preamble names. `ambiguous` is pinned
 * twice in channels.test.ts (the run's stop and the resume's re-judgment);
 * `published` is pinned by the generalization suite against the matrix
 * goldens.
 */
import { describe, expect, it } from "vitest";

import {
  InvalidExecutionTransitionError,
  assembleMemoryStores,
  plan,
  type RunDeclarations,
  type RunOutcome,
} from "../../src/index.js";
import {
  COMMITTED_AT,
  freshStores,
  liveWorld,
  matrixArtifacts,
  matrixHooks,
  plannedOf,
  planLineFor,
  runInput,
} from "../vertical/matrix.js";
import {
  FOREIGN_PLAN,
  ShiftingLedger,
  SwitchableClaimStore,
  beta,
  freshAssembly,
  fullDeclaration,
  promote,
  runRequest,
} from "./harness.js";
import { claimScopeForLine } from "../../src/index.js";

/** The failing declaration: `attest` anchored publish-before, its effect
 * carrying no proof — the §2.5 escalation window. */
function attestDeclaration(): RunDeclarations {
  const hooks = matrixHooks();
  return {
    hooks: [hooks.attest],
    hookEffects: new Map([
      [
        hooks.attest.id,
        (input) => ({ attribution: { attemptId: input.attemptId, actor: "automation" } }),
      ],
    ]),
  };
}

/** The succeeding `attest` declaration — the recovery half. */
function succeedingAttestDeclaration(): RunDeclarations {
  const hooks = matrixHooks();
  return {
    hooks: [hooks.attest],
    hookEffects: new Map([
      [
        hooks.attest.id,
        (input) => ({
          attribution: { attemptId: input.attemptId, actor: "automation" },
          evidence: "evidence:attest",
        }),
      ],
    ]),
  };
}

function publishedBeta(): {
  outcome: RunOutcome;
  engine: ReturnType<typeof freshAssembly>["engine"];
} {
  const assembly = freshAssembly();
  const outcome = assembly.engine.run(runRequest(liveWorld(), "main", [beta], fullDeclaration()));
  if (outcome.kind !== "published") {
    throw new Error(`fixture broken: the beta run got ${outcome.kind}`);
  }
  return { outcome, engine: assembly.engine };
}

describe("§2.8 — refused: the planner's refusal, a malformed request, a foreign line", () => {
  it("a request the plan answers with no line refuses after the plan, planId set, handle null", () => {
    const { engine } = freshAssembly();
    // The promote intent over a world with no pending prerelease: the
    // request is well-formed, but the closed input plans nothing on main —
    // the boundary's own post-planning refusal, with the plan named and
    // nothing executed.
    const outcome = engine.run(runRequest(liveWorld(), "main", [promote]));
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") {
      throw new Error("expected a refused outcome");
    }
    expect(outcome.detail).toContain("main");
    expect(outcome.detail).toContain("assembles no line");
    expect(outcome.planId).not.toBeNull();
    expect(outcome.handle).toBeNull();
    expect(outcome.drives).toStrictEqual([]);
  });

  it("a planning refusal is the outcome, planId null, nothing executed", () => {
    const world = liveWorld();
    // §2.12's malformed self-reference marker inside a pending span: a main
    // head whose trailer block carries the namespace without a value. The
    // planner fails toward explicit review and refuses the plan; the
    // boundary returns that refusal verbatim — nothing was planned, so
    // planId and handle are null (§2.8's row, verbatim).
    world.commits = [
      ...world.commits,
      {
        sha: "mx",
        parents: ["m5"],
        message: "feat: the marker\n\nRelease-Craft:",
        committedAt: COMMITTED_AT,
        containingRefs: ["main"],
      },
    ];
    world.refs = world.refs.map((ref) => (ref.name === "main" ? { ...ref, head: "mx" } : ref));
    const { engine } = freshAssembly();
    const outcome = engine.run(runRequest(world, "main", [beta]));
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") {
      throw new Error("expected a refused outcome");
    }
    expect(outcome.detail).toContain("malformed");
    expect(outcome.planId).toBeNull();
    expect(outcome.handle).toBeNull();
    expect(outcome.drives).toStrictEqual([]);
  });

  it("a request naming zero or two lines refuses (M-02's one-line posture)", () => {
    const { engine } = freshAssembly();
    for (const lineIds of [[], ["main", "main"]]) {
      const outcome = engine.run({ ...runRequest(liveWorld(), "main", [beta]), lineIds });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") {
        throw new Error("expected a refused outcome");
      }
      expect(outcome.detail).toContain("exactly one line");
    }
  });

  it("a request naming a line the plan does not carry refuses, naming the line", () => {
    const { engine } = freshAssembly();
    // The plan assembles for 4.8.x alone; the request names main — a valid
    // closed input whose plan carries no such line.
    const request = runRequest(liveWorld(), "4.8.x", []);
    const outcome = engine.run({ ...request, lineIds: ["main"] });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") {
      throw new Error("expected a refused outcome");
    }
    expect(outcome.detail).toContain("assembles no line");
    expect(outcome.detail).toContain("main");
    expect(outcome.planId).not.toBeNull();
  });
});

describe("§2.8 — denied: a claim denial names the winner (E-07)", () => {
  it("a stable-version scope held by another attempt denies the loser, holder named", () => {
    const winner = freshAssembly();
    const winnerOutcome = winner.engine.run(
      runRequest(liveWorld(), "4.8.x", [{ kind: "release" }]),
    );
    expect(winnerOutcome.kind).toBe("published");
    if (winnerOutcome.kind !== "published" || winnerOutcome.handle === null) {
      throw new Error("expected a published outcome");
    }
    // A second assembly sharing only the claim store: the same plan (the
    // world is unchanged) claiming the same permanent stable-version scope,
    // under a register seeded one ordinal ahead — a different attempt id.
    const world = liveWorld();
    const planId = plannedOf(plan(runInput(world, "4.8.x", [{ kind: "release" }]))).plan.planId;
    const loserStores = freshStores();
    const loser = assembleMemoryStores(
      {
        register: winner.stores.register,
        ledger: loserStores.ledger,
        claims: winner.stores.claims,
        channels: loserStores.channels,
      },
      { maxRetries: 2 },
    );
    // Advance the shared register first: the loser's attempt identity must
    // differ from the winner's, or the idempotent same-holder re-acquire
    // would read as the same attempt.
    winner.stores.register.nextOrdinal(planId);
    const denied = loser.run(runRequest(liveWorld(), "4.8.x", [{ kind: "release" }]));
    expect(denied.kind).toBe("denied");
    if (denied.kind !== "denied") {
      throw new Error("expected a denied outcome");
    }
    expect(denied.holder).toBe(winnerOutcome.handle.attemptId);
    expect(denied.drives).toStrictEqual([]);
  });
});

describe("§2.8 — conflict: E-08's bound exhausted is the explicit conflict", () => {
  it("a maxRetries-0 assembly over a taken sequence conflicts without walking", () => {
    const stores = freshStores();
    const assembled = plannedOf(plan(runInput(liveWorld(), "main", [beta]))).plan;
    const scope = claimScopeForLine(planLineFor(assembled, "main"));
    if (scope === null || scope.kind !== "prerelease-sequence") {
      throw new Error("fixture broken: the beta scope is not a prerelease sequence");
    }
    // The foreign holder takes the exact sequence the run will demand.
    const foreign = stores.claims.acquire(scope, "foreign-holder");
    if (foreign.kind !== "claim") {
      throw new Error("fixture broken: the foreign acquire was denied");
    }
    const { engine } = freshAssembly({ claims: stores.claims, maxRetries: 0 });
    const outcome = engine.run(runRequest(liveWorld(), "main", [beta]));
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind !== "conflict" || outcome.handle === null) {
      throw new Error("expected a conflict outcome");
    }
    expect(outcome.detail).toContain("bound exhausted");
    expect(outcome.drives).toStrictEqual([]);
    // The loser path left no records: the store's bookkeeping carries the
    // attempt, the ledger says nothing (the escalate pin builds on this).
    expect(stores.ledger.tail(outcome.handle.attemptId)).toStrictEqual([]);
  });
});

describe("§2.8 — blocked: a hook's validation suspends the attempt (§2.5's escalation)", () => {
  it("the failing attest hook blocks with its cause recorded verbatim", () => {
    const { engine } = freshAssembly();
    const outcome = engine.run(runRequest(liveWorld(), "main", [beta], attestDeclaration()));
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked" || outcome.handle === null) {
      throw new Error("expected a blocked outcome");
    }
    expect(outcome.cause).toBe("validation:hook:attest:evidence-present");
    const observation = engine.observe({ kind: "attempt", handle: outcome.handle });
    if (observation.kind !== "attempt") {
      throw new Error(`expected an attempt observation, got ${observation.kind}`);
    }
    expect(observation.state).toBe("blocked");
    expect(observation.blockedCause).toBe("validation:hook:attest:evidence-present");
  });
});

describe("§2.8 — failed: the claim-lost loser path is a record, never a throw (E-07)", () => {
  it("a claim that stops verifying mid-walk fails the run at the next mutating stage", () => {
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
    // The package producer flips the store's honesty mid-walk: the next
    // mutating stage's guard re-verifies the token and finds it lost.
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
    const outcome = engine.run(
      runRequest(liveWorld(), "main", [beta], { ...declaration, producers }),
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed" || outcome.handle === null) {
      throw new Error("expected a failed outcome");
    }
    expect(outcome.cause).toContain("no longer verifies");
    // The attempt is untouched — the loser path records, it does not move.
    const observation = engine.observe({ kind: "attempt", handle: outcome.handle });
    if (observation.kind !== "attempt") {
      throw new Error(`expected an attempt observation, got ${observation.kind}`);
    }
    expect(observation.state).toBe("executing");
    // The walk stopped at commit with the claim-lost outcome recorded.
    const last = outcome.drives.at(-1);
    expect(last?.stepKey).toBe("commit");
    expect(last?.outcome.kind).toBe("claim-lost");
  });
});

describe("§2.8 — satisfied-externally: ledger-first done-ness never terminalizes", () => {
  it("an external satisfaction at the stopped stage stops the walk, provenance recorded", () => {
    const { engine, stores } = freshAssembly();
    const stopped = engine.run(runRequest(liveWorld(), "main", [beta], attestDeclaration()));
    expect(stopped.kind).toBe("blocked");
    if (stopped.kind !== "blocked" || stopped.handle === null) {
      throw new Error("expected a blocked outcome");
    }
    // The recorded resolution re-arms; the world, meanwhile, satisfied the
    // publish stage externally — observed, evidenced, keyed to the attempt
    // and the request's own content fingerprint.
    if (stopped.planId === null) {
      throw new Error("expected a plan id on the blocked outcome");
    }
    const resolved = engine.resolve(stopped.handle, "hook:attest", {
      kind: "revalidation",
      planFingerprint: stopped.planId,
    });
    expect(resolved.kind).toBe("resolved");
    const attemptId = stopped.handle.attemptId;
    stores.ledger.noteExternal({
      attemptId,
      stepKey: "publish",
      satisfaction: {
        attribution: { attemptId, actor: "auditor" },
        evidence: "evidence:external-publish",
        contentFingerprint: `content:publish:${attemptId}`,
      },
    });
    // With the hook succeeding, the resume walks to publish and reads the
    // external view instead of executing.
    const outcome = engine.resume(
      stopped.handle,
      runRequest(liveWorld(), "main", [beta], succeedingAttestDeclaration()),
    );
    expect(outcome.kind).toBe("satisfied-externally");
    if (outcome.kind !== "satisfied-externally") {
      throw new Error("expected a satisfied-externally outcome");
    }
    const observation = engine.observe({ kind: "attempt", handle: stopped.handle });
    if (observation.kind !== "attempt") {
      throw new Error(`expected an attempt observation, got ${observation.kind}`);
    }
    expect(observation.state).toBe("executing");
    // The re-resume re-judges identically: the row is the recorded state's,
    // not a one-shot.
    const again = engine.resume(
      stopped.handle,
      runRequest(liveWorld(), "main", [beta], succeedingAttestDeclaration()),
    );
    expect(again.kind).toBe("satisfied-externally");
  });
});

describe("§2.8 — stale and escalate: the resume verdicts surface verbatim", () => {
  it("a ledger whose recorded plan fingerprint disagrees with the carried attempt is stale (E-05)", () => {
    const stores = freshStores();
    const shifting = new ShiftingLedger(stores.ledger);
    const engine = assembleMemoryStores(
      {
        register: stores.register,
        ledger: shifting,
        claims: stores.claims,
        channels: stores.channels,
      },
      { maxRetries: 2 },
    );
    const stopped = engine.run(runRequest(liveWorld(), "main", [beta], attestDeclaration()));
    expect(stopped.kind).toBe("blocked");
    const again = engine.run(runRequest(liveWorld(), "main", [beta], attestDeclaration()));
    expect(again.kind).toBe("stale");
    if (again.kind !== "stale") {
      throw new Error("expected a stale outcome");
    }
    expect(again.detail).toContain(stopped.planId);
    expect(again.detail).toContain(FOREIGN_PLAN);
  });

  it("a carried attempt with no recorded plan escalates — the store is bookkeeping, not authority", () => {
    const stores = freshStores();
    const assembled = plannedOf(plan(runInput(liveWorld(), "main", [beta]))).plan;
    const scope = claimScopeForLine(planLineFor(assembled, "main"));
    if (scope === null || scope.kind !== "prerelease-sequence") {
      throw new Error("fixture broken: the beta scope is not a prerelease sequence");
    }
    const foreign = stores.claims.acquire(scope, "foreign-holder");
    if (foreign.kind !== "claim") {
      throw new Error("fixture broken: the foreign acquire was denied");
    }
    const { engine } = freshAssembly({ claims: stores.claims, maxRetries: 0 });
    const first = engine.run(runRequest(liveWorld(), "main", [beta]));
    expect(first.kind).toBe("conflict");
    if (first.kind !== "conflict" || first.handle === null) {
      throw new Error("expected a conflict outcome");
    }
    // The scope frees; the carried attempt continues — and the ledger has
    // no plan record for it, because the first run never walked. The
    // classification escalates; it does not re-plan (invariant 2.3).
    stores.claims.release(foreign.token);
    const second = engine.run(runRequest(liveWorld(), "main", [beta]));
    expect(second.kind).toBe("escalate");
    if (second.kind !== "escalate" || second.handle === null) {
      throw new Error("expected an escalate outcome");
    }
    expect(second.detail).toContain("no recorded plan fingerprint");
    expect(second.handle.attemptId).toBe(first.handle.attemptId);
  });
});

describe("§2.8 — terminal is terminal: the kernel's violations throw through the boundary", () => {
  it("abort records the abandonment; anything further through the kernel's doors throws", () => {
    const { engine } = freshAssembly();
    const stopped = engine.run(runRequest(liveWorld(), "main", [beta], attestDeclaration()));
    expect(stopped.kind).toBe("blocked");
    if (stopped.kind !== "blocked" || stopped.handle === null) {
      throw new Error("expected a blocked outcome");
    }
    const handle = stopped.handle;
    const abandoned = engine.abort(handle, "human", "the release was withdrawn");
    expect(abandoned.kind).toBe("abandoned");
    if (abandoned.kind !== "abandoned") {
      throw new Error("expected an abandoned outcome");
    }
    expect(abandoned.reason).toBe("the release was withdrawn");
    const observation = engine.observe({ kind: "attempt", handle });
    if (observation.kind !== "attempt") {
      throw new Error(`expected an attempt observation, got ${observation.kind}`);
    }
    expect(observation.state).toBe("abandoned");
    expect(observation.terminalReason).toBe("the release was withdrawn");
    // The kernel's own violations, rethrown verbatim (E-09): terminal is
    // terminal — a second abort, and a carried run over the terminal
    // attempt, both throw the state machine's named error.
    expect(() => engine.abort(handle, "human", "again")).toThrow(InvalidExecutionTransitionError);
    expect(() => engine.run(runRequest(liveWorld(), "main", [beta]))).toThrow(
      InvalidExecutionTransitionError,
    );
  });

  it("resolving a non-blocked attempt is the kernel's named violation, not an outcome", () => {
    const { engine, outcome } = publishedBeta();
    if (outcome.handle === null) {
      throw new Error("expected a handle");
    }
    const handle = outcome.handle;
    // The walk is over; the attempt is terminal — resolveBlocked demands a
    // blocked attempt and throws the state machine's own error.
    expect(() =>
      engine.resolve(handle, "validate", {
        kind: "revalidation",
        planFingerprint: outcome.planId ?? "",
      }),
    ).toThrow(InvalidExecutionTransitionError);
  });

  it("the doors refuse a handle the engine does not carry, quoting it back", () => {
    const { engine } = freshAssembly();
    const foreign = {
      planId: "content_sha256:unknown",
      attemptId: "attempt_sha256:unknown",
      actor: "automation",
    };
    for (const outcome of [
      engine.resume(foreign, runRequest(liveWorld(), "main", [beta])),
      engine.resolve(foreign, "validate", {
        kind: "revalidation",
        planFingerprint: foreign.planId,
      }),
      engine.abort(foreign, "human", "reason"),
    ]) {
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") {
        throw new Error("expected a refused outcome");
      }
      expect(outcome.detail).toContain("unknown attempt");
      expect(outcome.detail).toContain(foreign.planId);
    }
  });
});

describe("§2.8 — the engine never invents user code: a declared extension without its injection is the named violation", () => {
  it("a declared hook with no hookEffects map throws the kernel's named violation, never a silent skip", () => {
    const assembly = freshAssembly();
    // The hook is declared but the effects map is absent entirely: the
    // scheduler must still be reached, and its per-id demand is the
    // kernel's own named violation — the same answer a map that exists
    // but lacks the id gives (ADR-0007 decision 2). Skipping the
    // scheduler instead would publish without the hook ever running.
    expect(() =>
      assembly.engine.run(
        runRequest(liveWorld(), "main", [beta], { hooks: [matrixHooks().attest] }),
      ),
    ).toThrow(/no effect injected for the declared hook "attest"/);
  });

  it("a declared artifact with neither a producers map nor a wired producer throws the kernel's named violation", () => {
    const assembly = freshAssembly(); // the memory assembly wires no producer
    const artifact = matrixArtifacts()[0];
    if (artifact === undefined) {
      throw new Error("fixture broken: the matrix declares no artifacts");
    }
    expect(() =>
      assembly.engine.run(runRequest(liveWorld(), "main", [beta], { artifacts: [artifact] })),
    ).toThrow(/no producer injected for the declared artifact/);
  });
});
