/**
 * The application boundary's contract-test harness (the application
 * boundary contract §5; its §4 question 5 hands the fixture-data call to
 * this slice). Everything imports through the package's front door
 * (`src/index.ts`) and the phase 10 fixtures — no internal module path,
 * because the boundary's own law (§2.1) is the tests' law too. The
 * wrappers below are port-level: they sit where a host's real store would
 * sit, so every outcome they produce crosses the public surface.
 *
 * No clock, no environment, no randomness — the fixtures' recorded values
 * only (the matrix contract's §5 laws, inherited).
 */
import {
  assembleMemoryStores,
  MemoryAttemptRegister,
  type AttemptRegister,
  type ClaimStore,
  type ClaimVerification,
  type ClaimToken,
  type ClaimScope,
  type Claim,
  type ClaimDenied,
  type Engine,
  type ExecutionLedger,
  type LedgerRecord,
  type LedgerStepState,
  type OperatorIntent,
  type ReleaseAttempt,
  type Attribution,
  type RunRequest,
  type RunDeclarations,
  type StepKey,
  type StepRecordsView,
  type TransitionRecord,
} from "../../src/index.js";
import {
  artifactProducers,
  freshStores,
  hookEffects,
  matrixArtifacts,
  matrixHooks,
  runInput,
  type LiveWorld,
  type Stores,
  type World,
} from "../vertical/matrix.js";

// ---------------------------------------------------------------------------
// The recorded intents and the full declaration — the fixtures' own values
// ---------------------------------------------------------------------------

export const beta = { kind: "prerelease", stream: "beta", lineId: "main" } as const;
export const rc = { kind: "prerelease", stream: "rc", lineId: "main" } as const;
export const promote = { kind: "promote", lineId: "main" } as const;

/** The always-succeeding declaration: all six §3.4 artifacts plus §3.5's
 * succeeding and resumed hooks, each with its proof — the fixtures' own
 * `fullDeclaration`, restated through the boundary's `RunDeclarations`. */
export function fullDeclaration(): RunDeclarations {
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
}

// ---------------------------------------------------------------------------
// The assembly — the public factories over the fixtures' reference stores
// ---------------------------------------------------------------------------

export interface Assembly {
  readonly engine: Engine;
  /** The fixtures' reference stores — the bundle's own values, kept so a
   * test can read the recorded evidence and (for the seeded-fault windows)
   * wrap or seed a store before the run. */
  readonly stores: Stores;
}

export interface AssemblyOptions {
  /** Wire the channel store (default true) — `false` builds the §2.4
   * store-less assembly. */
  readonly withChannels?: boolean;
  /** E-08's declared retry bound (default 2). */
  readonly maxRetries?: number;
  /** Port overrides for the shared-store scenarios: two assemblies over
   * one register or one claim store, exactly as two hosts would. */
  readonly register?: AttemptRegister;
  readonly ledger?: ExecutionLedger;
  readonly claims?: ClaimStore;
}

/** One memory assembly through the public factory. The fixture stores are
 * the bundle: the assembly wires them, it does not rebuild them. */
export function freshAssembly(options: AssemblyOptions = {}): Assembly {
  const stores = freshStores();
  const engine = assembleMemoryStores(
    {
      register: options.register ?? stores.register,
      ledger: options.ledger ?? stores.ledger,
      claims: options.claims ?? stores.claims,
      ...(options.withChannels === false ? {} : { channels: stores.channels }),
    },
    { maxRetries: options.maxRetries ?? 2 },
  );
  return { engine, stores };
}

/** A fresh register that allocates a plan's SECOND ordinal — the shared
 * register scenarios' different attempt identity for the same plan. */
export function registerSeededAfter(planId: string): AttemptRegister {
  return new MemoryAttemptRegister({ ordinals: { [planId]: 1 } });
}

// ---------------------------------------------------------------------------
// The run request and the world — the caller's side of the surface
// ---------------------------------------------------------------------------

/** One run request through the boundary's door. */
export function runRequest(
  world: World | LiveWorld,
  lineId: string,
  intents: readonly OperatorIntent[],
  declarations?: RunDeclarations,
): RunRequest {
  return {
    input: runInput(world, lineId, intents),
    lineIds: [lineId],
    intents,
    actor: "automation",
    ...(declarations === undefined ? {} : { declarations }),
  };
}

/** A boundary run whose minted tag the world records — the caller owns the
 * world (the engine touches no ref), exactly as the fixtures' driver does. */
export function runToWorld(
  engine: Engine,
  world: LiveWorld,
  request: RunRequest,
): ReturnType<Engine["run"]> {
  const outcome = engine.run(request);
  if (outcome.kind === "published" && outcome.tag !== null) {
    const lineId = request.lineIds[0];
    const ref = world.refs.find((candidate) => candidate.name === lineId);
    if (ref === undefined || lineId === undefined) {
      throw new Error(`fixture broken: no ref for line ${String(lineId)}`);
    }
    world.tags.push({ name: outcome.tag, commit: ref.head });
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Port wrappers — the seeded-fault windows, sitting where a store sits
// ---------------------------------------------------------------------------

/** The foreign fingerprint `ShiftingLedger` reports for any attempt with
 * recorded state — the E-05 mismatch's other side. */
export const FOREIGN_PLAN = "sha256:" + "9".repeat(64);

/** A ledger that misreports the recorded plan fingerprint — the E-05 stale
 * window, produced through the port. Every other read delegates. */
export class ShiftingLedger implements ExecutionLedger {
  readonly #inner: ExecutionLedger;
  constructor(inner: ExecutionLedger) {
    this.#inner = inner;
  }
  appendStart(
    attempt: ReleaseAttempt,
    stepKey: StepKey,
    attribution: Attribution,
    contentFingerprint?: string,
    guard?: string,
  ): TransitionRecord {
    return this.#inner.appendStart(attempt, stepKey, attribution, contentFingerprint, guard);
  }
  append(record: LedgerRecord): LedgerRecord {
    return this.#inner.append(record);
  }
  tail(attemptId: string): readonly LedgerRecord[] {
    return this.#inner.tail(attemptId);
  }
  stepView(): StepRecordsView {
    return this.#inner.stepView();
  }
  step(attemptId: string, stepKey: StepKey): LedgerStepState {
    return this.#inner.step(attemptId, stepKey);
  }
  planFingerprint(attemptId: string): string | null {
    return this.#inner.tail(attemptId).length === 0 ? null : FOREIGN_PLAN;
  }
}

/** A ledger that remembers which attempts and plans wrote through it — the
 * crash window's discovery tool: a fault that escapes the door leaves no
 * outcome to carry the handle, so the test reads the attempt identity off
 * the writes themselves. Every read delegates. */
export class CapturingLedger implements ExecutionLedger {
  readonly #inner: ExecutionLedger;
  /** Every attempt id a write carried, first write first. */
  readonly attemptIds: string[] = [];
  /** Every plan fingerprint a write carried, first write first. */
  readonly planIds: string[] = [];
  constructor(inner: ExecutionLedger) {
    this.#inner = inner;
  }
  appendStart(
    attempt: ReleaseAttempt,
    stepKey: StepKey,
    attribution: Attribution,
    contentFingerprint?: string,
    guard?: string,
  ): TransitionRecord {
    if (!this.attemptIds.includes(attempt.attemptId)) {
      this.attemptIds.push(attempt.attemptId);
    }
    if (!this.planIds.includes(attempt.planFingerprint)) {
      this.planIds.push(attempt.planFingerprint);
    }
    return this.#inner.appendStart(attempt, stepKey, attribution, contentFingerprint, guard);
  }
  append(record: LedgerRecord): LedgerRecord {
    if (record.kind === "plan") {
      if (!this.attemptIds.includes(record.attemptId)) {
        this.attemptIds.push(record.attemptId);
      }
      if (!this.planIds.includes(record.planFingerprint)) {
        this.planIds.push(record.planFingerprint);
      }
    }
    return this.#inner.append(record);
  }
  tail(attemptId: string): readonly LedgerRecord[] {
    return this.#inner.tail(attemptId);
  }
  stepView(): StepRecordsView {
    return this.#inner.stepView();
  }
  step(attemptId: string, stepKey: StepKey): LedgerStepState {
    return this.#inner.step(attemptId, stepKey);
  }
  planFingerprint(attemptId: string): string | null {
    return this.#inner.planFingerprint(attemptId);
  }
}

/** A claim store whose token re-verification turns traitor on demand — the
 * E-07 loser path, produced through the port. `honest` is the test's own
 * switch; acquisition always delegates. */
export class SwitchableClaimStore implements ClaimStore {
  readonly #inner: ClaimStore;
  /** When false, `verify` reports every token lost (the claim is gone). */
  honest = true;
  constructor(inner: ClaimStore) {
    this.#inner = inner;
  }
  acquire(scope: ClaimScope, attemptId: string): Claim | ClaimDenied {
    return this.#inner.acquire(scope, attemptId);
  }
  verify(token: ClaimToken): ClaimVerification {
    const verification = this.#inner.verify(token);
    if (!this.honest || verification.kind !== "held") {
      return { kind: "lost" };
    }
    return verification;
  }
  release(token: ClaimToken): void {
    this.#inner.release(token);
  }
}
