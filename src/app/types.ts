/**
 * The application boundary's vocabulary (phase 11 contract §2, docs/design/
 * phase11-application-boundary-contract.md). The boundary is composition,
 * not mechanism: every record shape, port, and outcome below is consumed
 * from the layers' barrels and re-composed — nothing here re-declares a
 * kernel or planner value, invents a store, or names what backs a port
 * (§1's non-goals). What the file owns is exactly the surface a host consumes:
 * the assembly config's closed set, the run request, the attempt handle,
 * the run outcome the §2.8 table fixes, the observation reads, and the
 * engine value that carries the four doors plus plan-only.
 *
 * Outcomes, not exceptions (§2.8; the kernel's split carried up one layer):
 * everything the engine classifies is a returned value; the only throws at
 * the boundary are the kernel's own named contract violations and this
 * file's `InvalidAssemblyConfigError` — the structural check §4 question 4
 * gives the assembly over its own closed config.
 */

import type {
  ArtifactProducer,
  ArtifactStep,
  AttemptRegister,
  AttemptState,
  BlockedResolution,
  ChannelState,
  Claim,
  ClaimStore,
  ChannelStore,
  ExecutionLedger,
  HookEffect,
  HookStep,
  LedgerRecord,
  LedgerStepState,
  OperatorIntent,
  PlanLine,
  PlanningInput,
  PlanningOutcome,
  ReleaseAttempt,
  RequestStepOutcome,
  StepKey,
} from "../index.js";
import type { GitBinding, TagMint } from "../adapters/git/index.js";

// ---------------------------------------------------------------------------
// §2.2 — the assembly config, closed
// ---------------------------------------------------------------------------

/** The assembly's declared configuration (§2.2) — and nothing else: no
 * clock, no environment, no HEAD, no token, no path. `maxRetries` is E-08's
 * bounded sequence retry bound, declared never implied (ADR-0005 decision
 * 4); the assembly checks the set structurally
 * ([`InvalidAssemblyConfigError`](#class-invalidassemblyconfigerror)) and
 * never reads a value the planner's own door does not normalize first
 * (§4 question 4). */
export interface AssemblyConfig {
  /** E-08's bounded `prerelease-sequence` retry bound: a denied sequence
   * scope re-acquires at the winner's `sequence + 1` at most this many
   * times, then conflicts explicitly. A non-negative integer, checked at
   * assembly. */
  readonly maxRetries: number;
}

/** The boundary's own thrown contract violation (§4 question 4): the
 * assembly config is the closed set §2.2 names — a `maxRetries` that is
 * not a non-negative integer, or any other key, refuses the assembly at
 * the door. A programming error carrying the contract in the message, like
 * the kernel's `InvalidExecutionTransitionError` — never a returned
 * outcome, because an assembly that cannot be trusted to declare its retry
 * bound cannot be trusted to run. */
export class InvalidAssemblyConfigError extends Error {
  constructor(detail: string) {
    super(
      `invalid assembly config: ${detail} — the closed set is { maxRetries } and ` +
        `maxRetries must be a non-negative integer (phase 11 contract §2.2, §4 question 4)`,
    );
    this.name = "InvalidAssemblyConfigError";
  }
}

// ---------------------------------------------------------------------------
// §2.3 — the port bundles the factories consume
// ---------------------------------------------------------------------------

/** The memory port bundle (§2.2): the engine's own reference
 * implementations (ADR-0005 decisions 4–5; ADR-0006 decision 1) — a
 * zero-persistence assembly for embedders and the boundary's contract
 * tests. `channels` is ADR-0012 decision 6's port; an assembly that leaves
 * it unwired refuses any run whose plan declares channel moves before the
 * walk starts (§2.4). Not a test seam: the bundle is structurally the
 * fixtures' `Stores` minus the mirror log the fixtures keep beside the
 * ledger. */
export interface MemoryStores {
  /** The attempt register the kernel constructor allocates ordinals from. */
  readonly register: AttemptRegister;
  /** The durable evidence the walk writes ahead into and replays over. */
  readonly ledger: ExecutionLedger;
  /** The ownership truth the claim derivation acquires against. */
  readonly claims: ClaimStore;
  /** The channel store the `channel-transition` stage executes through
   * (ADR-0012 decision 6) — absent means the stage refuses a plan that
   * names moves (§2.4's fail-closed rule). */
  readonly channels?: ChannelStore;
}

/** The assembled ports the engine value runs through (§2.3's table, filled):
 * one bundle per factory, never re-owned, never re-opened, never shared
 * between engines. Internal — the surface exposes the `Engine` value, never
 * a port (§2.9). */
export interface EnginePorts {
  readonly register: AttemptRegister;
  readonly ledger: ExecutionLedger;
  readonly claims: ClaimStore;
  /** The wired channel store, or null when the assembly wired none (§2.4). */
  readonly channels: ChannelStore | null;
  /** The tag door, wired from a git binding only — called once per run, at
   * the walk's mint step, target from the run request (§2.5). */
  readonly mint: TagMint | null;
  /** The artifact producer, wired from a git binding only — the per-id
   * fallback under the run declarations' producers map (ADR-0008 decision
   * 2; §2.3's wiring row). */
  readonly producer: ArtifactProducer | null;
}

/** The opened git binding a git assembly consumes (§2.2): `openGitBinding`
 * stays the binding's own factory (phase 8 §2.6); the assembly consumes an
 * already-opened binding exactly as the binding's adapter door does
 * (ADR-0010 decision 2). Re-exported so the factory's signature names the
 * binding's own barrel — the boundary imports the port bundle, never an
 * internal adapter module (§2.1). */
export type { GitBinding };

// ---------------------------------------------------------------------------
// §2.6 — the run request and the attempt handle
// ---------------------------------------------------------------------------

/** The caller-injected extension declarations of one run (ADR-0007 decision
 * 2; ADR-0008 decision 2): the declared hook and artifact steps frozen with
 * the attempt, and the effects and producers injected per run — the engine
 * never stores or invents user code. Declared per run, never stored by the
 * boundary (§2.6). */
export interface RunDeclarations {
  /** The declared hook steps, frozen with the attempt at `openAttempt`. */
  readonly hooks?: readonly HookStep[];
  /** The declared artifact steps, frozen with the attempt at `openAttempt`. */
  readonly artifacts?: readonly ArtifactStep[];
  /** The hook effects, keyed by hook id — demanded by every uncompleted
   * declared hook the walk reaches. */
  readonly hookEffects?: ReadonlyMap<string, HookEffect>;
  /** The artifact producers, keyed by artifact id — demanded by every
   * uncompleted declared artifact step the walk reaches; a git assembly
   * falls back per id to the binding's own producer. */
  readonly producers?: ReadonlyMap<string, ArtifactProducer>;
}

/** One executed run's request (§2.6). Everything ambient enters here as
 * declared configuration — no clock, no environment, no HEAD (§3's law):
 * `targets` is the recorded base per line the tag door mints onto, resolved
 * by the caller from the world it already holds (phase 8 §2.3: the target
 * is a supplied value, never chosen by the binding), because the plan
 * records no head commit of its own. */
export interface RunRequest {
  /** The closed planning input the run plans over (invariant 2.2). */
  readonly input: PlanningInput;
  /** Which of the plan's lines the run executes — exactly one line id
   * today (M-02's posture; §4 question 7 defers the whole-plan pass). */
  readonly lineIds: readonly string[];
  /** The operator's demands, authoritative for the run's plan: the boundary
   * plans over `{ ...input, intents }` (the request's intents win over any
   * intents inside `input`). */
  readonly intents: readonly OperatorIntent[];
  /** The attribution string every record this run appends carries — human
   * precedence (E-09). */
  readonly actor: string;
  /** The run's declared hooks, artifacts, effects, and producers. */
  readonly declarations?: RunDeclarations;
  /** The recorded base per line id the tag door mints onto — demanded by
   * any run whose plan mints over an assembly that wired the tag door, and
   * refused by name when a minting line lacks one (§2.5). */
  readonly targets?: Readonly<Record<string, string>>;
}

/** The handle a run outcome carries (§2.7): engine-minted, plan-keyed. A
 * `.resume`/`.resolve`/`.abort` naming a plan the engine does not carry is
 * a returned refusal that quotes this handle back; an attempt id that
 * disagrees with the carried one is refused fail-closed. The `actor` is the
 * run's own attribution — the handle is bookkeeping (§2.7), never
 * authority: the recorded tail and the claim store are the truth. */
export interface AttemptHandle {
  readonly planId: string;
  readonly attemptId: string;
  readonly actor: string;
}

// ---------------------------------------------------------------------------
// §2.8 — how outcomes cross the boundary
// ---------------------------------------------------------------------------

/** One walked step's recorded outcome (§2.8): the fixtures' `drives` list,
 * promoted to surface — a caller reads which step stopped the run and what
 * it returned without ever holding a kernel primitive. The outcome is the
 * kernel's own `RequestStepOutcome` verbatim, never translated. */
export interface StepDrive {
  readonly stepKey: StepKey;
  readonly outcome: RequestStepOutcome;
}

/** The context every run outcome carries on top of its §2.8 row: the plan
 * the run planned (null for a planning refusal — nothing was planned), the
 * handle of the attempt the run opened or continued (null for every stop
 * before an attempt existed — a planning refusal, a store-less channel
 * refusal), and the per-step outcomes this call's walk recorded. */
export interface RunOutcomeContext {
  readonly planId: string | null;
  readonly handle: AttemptHandle | null;
  readonly drives: readonly StepDrive[];
}

/** The run outcome (§2.8's table, verbatim row names, plus two kinds the
 * table does not name — see below). Every outcome is a returned value; no
 * exception crosses the boundary for anything the engine classifies.
 *
 * `resolved` and `abandoned` are the recorded verdicts of `.resolve` and
 * `.abort` — doors the contract types `: RunOutcome` but whose recorded
 * results the ten-row table has no row for; reusing `failed` or `blocked`
 * would translate a recorded re-arm or a recorded human abort into a row
 * that means something else, which §2.8's own law refuses (outcomes ride
 * verbatim, never translated). A caller discriminates on `kind` as on any
 * other row. */
export type RunOutcome =
  | ({ readonly kind: "published"; readonly tag: string | null } & RunOutcomeContext)
  /* `tag` is the release's tag identity — the plan's own. With a wired tag
   * door it is the mint's returned name (the ref the world gained); a memory
   * assembly reports the plan's tag without a minted ref, the caller owning
   * the world. Null only when the plan names no tag. */
  | ({ readonly kind: "satisfied-externally" } & RunOutcomeContext)
  | ({ readonly kind: "refused"; readonly detail: string } & RunOutcomeContext)
  | ({ readonly kind: "denied"; readonly holder: string | null } & RunOutcomeContext)
  | ({ readonly kind: "blocked"; readonly cause: string } & RunOutcomeContext)
  | ({ readonly kind: "failed"; readonly cause: string } & RunOutcomeContext)
  | ({ readonly kind: "conflict"; readonly detail: string } & RunOutcomeContext)
  | ({ readonly kind: "ambiguous"; readonly detail: string } & RunOutcomeContext)
  | ({ readonly kind: "stale"; readonly detail: string } & RunOutcomeContext)
  | ({ readonly kind: "escalate"; readonly detail: string } & RunOutcomeContext)
  | ({ readonly kind: "resolved" } & RunOutcomeContext)
  | ({ readonly kind: "abandoned"; readonly reason: string } & RunOutcomeContext);

// ---------------------------------------------------------------------------
// §2.4 — the channel-transition wiring point's vocabulary
// ---------------------------------------------------------------------------

/** One decided channel move as the stage executor drove it (§2.4): the
 * channel, the prior target the store's own read observed (the record's
 * `from`), the target the move landed, and the store's outcome kind —
 * `applied` for a first landing, `noop` for the replay of a move that
 * already stands (ADR-0012 decisions 3–4). */
export interface AppliedChannelMove {
  readonly channelId: string;
  readonly from: { readonly line: string; readonly version: string } | null;
  readonly to: { readonly line: string; readonly version: string } | null;
  readonly outcome: "applied" | "noop";
}

/** The `channel-transition` stage's executor verdict (§2.4): `applied`
 * carries the moves that landed (each with its appended
 * `channel-transition` ledger record); `conflict` and `ambiguous` name the
 * move that could not be decided — that move records nothing, the walk
 * stops, and the stage's durable `started` record is what a resume
 * re-judges (invariants 2.5/2.6; ADR-0012 decision 7). */
export type ChannelStageResult =
  | { readonly kind: "applied"; readonly moves: readonly AppliedChannelMove[] }
  | { readonly kind: "conflict"; readonly channelId: string; readonly detail: string }
  | { readonly kind: "ambiguous"; readonly channelId: string; readonly detail: string };

// ---------------------------------------------------------------------------
// §2.6 — the observation reads
// ---------------------------------------------------------------------------

/** What an observation reads (§2.6): the attempt's recorded evidence under a
 * handle, or the wired channel store's recorded targets. Reads only — no
 * observation mutates (§2.6). */
export type ObservationQuery =
  { readonly kind: "attempt"; readonly handle: AttemptHandle } | { readonly kind: "channels" };

/** What an observation returns (§2.6): recorded values — the attempt's
 * tail, its per-step recorded states, the held claim, the tags the engine
 * minted, and the channels' recorded targets when a store is wired (null
 * when none is). An observation that cannot read is an outcome: the
 * `refused` row names the handle or the missing port, never a partial
 * answer read as clean (phase 9 §2.2's listing posture). */
export type Observation =
  | {
      readonly kind: "attempt";
      readonly handle: AttemptHandle;
      readonly state: AttemptState;
      readonly blockedCause?: string;
      readonly terminalReason?: string;
      /** The attempt's records, append order — the recorded evidence. */
      readonly tail: readonly LedgerRecord[];
      /** Every effective step's recorded state, effective-list order. */
      readonly steps: readonly {
        readonly stepKey: StepKey;
        readonly state: LedgerStepState;
      }[];
      /** The claim the engine acquired for the attempt, when one stands. */
      readonly claim: Claim | null;
      /** The tags the engine minted for the attempt, in mint order. */
      readonly tags: readonly string[];
      /** The wired channel store's recorded states — null when the
       * assembly wired no store (§2.4). */
      readonly channels: readonly ChannelState[] | null;
    }
  | { readonly kind: "channels"; readonly channels: readonly ChannelState[] }
  | { readonly kind: "refused"; readonly detail: string };

// ---------------------------------------------------------------------------
// §2.6 — the engine value
// ---------------------------------------------------------------------------

/** The engine value (§2.6) — the application surface a host consumes. One
 * assembly per binding, one engine per assembly (§2.2); the doors below are
 * the only writers behind it (§2.9: no raw kernel mutation primitive, no
 * store internals, no door around the claim). */
export interface Engine {
  /** Plan-only: the planner's pure door re-exposed — no store is touched,
   * and a plan-only run over an unchanged world is identical on double-run
   * (invariant 2.2, inherited). */
  plan(input: PlanningInput): PlanningOutcome;
  /** Plan + execute: the §2.5 walk, to its terminal or its stop. */
  run(request: RunRequest): RunOutcome;
  /** Continue from the recorded tail — `classifyResume` first, never
   * re-plan (invariant 2.3). The request re-declares the run's effects and
   * producers; its `input` and `intents` are not consulted, because a
   * resume never plans. */
  resume(handle: AttemptHandle, request: RunRequest): RunOutcome;
  /** The blocked loop's recorded resolution (phase 5 §2.7), through the
   * boundary — the only door that re-arms a blocked attempt. */
  resolve(handle: AttemptHandle, stepKey: StepKey, resolution: BlockedResolution): RunOutcome;
  /** Human abort — terminal is terminal (E-09). */
  abort(handle: AttemptHandle, actor: string, reason: string): RunOutcome;
  /** Recorded evidence read back, through read doors only (§2.6). */
  observe(query: ObservationQuery): Observation;
}

/** The attempt-store entry the assembly carries (§2.7): process-local
 * bookkeeping keyed by plan id — the carried attempt, the plan line it
 * executes, the claim the engine acquired for it, and the tags it minted.
 * Never authority: the recorded tail and the claim store are the truth, and
 * a stale carried attempt reconciles through classification. */
export interface AttemptEntry {
  /** The carried attempt value — replaced on every state move. */
  attempt: ReleaseAttempt;
  /** The plan line the attempt executes (identical for one plan id — the
   * plan id is the plan's content fingerprint). */
  readonly planLine: PlanLine;
  /** The claim the engine acquired, or null before the first acquisition. */
  claim: Claim | null;
  /** The tags the engine minted for the attempt, in mint order. */
  readonly tags: string[];
}
