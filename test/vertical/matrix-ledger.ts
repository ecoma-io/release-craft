/**
 * The Phase 10 slice 10.3 fixture — the ledger-backed replay vertical
 * (contract docs/design/phase10-vertical-matrix-contract.md §4 "10.3").
 *
 * It consumes the §3 declared data (worlds, goldens, artifacts, hooks) from
 * matrix.ts unchanged — the matrix is shared per slice. What this slice
 * adds is the *replay*: a step request passes through `ledgerRequestStep`,
 * the §2.8 record-path replay door, so a completed step replays `noop`/
 * `conflict` over content fingerprints (E-02) and a resume classifies
 * through `classifyResume` over the recorded tail — never recomputation.
 *
 * The persisted tail is the slice's evidence: `MemoryLedger` deep-freezes
 * on append (ADR-0006 decision 1), so V6 (immutability) asserts that every
 * record reads back byte-identical at every checkpoint and the whole tail
 * is byte-identical across an uninterrupted double run.
 *
 * Every golden here is hand-derived from the phase contracts (§2), never
 * from a run. No clock, no environment, no randomness (§5).
 */
import {
  CANONICAL_STAGES,
  MemoryAttemptRegister,
  MemoryChannelStore,
  MemoryClaimStore,
  MemoryLedger,
  MemoryTransitionLog,
  attemptIdentity,
  classifyResume,
  ledgerRequestStep,
  openAttempt,
  scheduleArtifacts,
  scheduleHooks,
  start,
  transition,
  type ArtifactProducer,
  type ArtifactStep,
  type ClaimScope,
  type HookEffect,
  type HookStep,
  type ReleaseAttempt,
  type StepKey,
} from "@ecoma-io/release-craft/__internal__/execution/index.js";
import { plan } from "@ecoma-io/release-craft/__internal__/planner/assemble.js";
import type {
  OperatorIntent,
  PlanLine,
  PlanningOutcome,
  ReleasePlan,
} from "@ecoma-io/release-craft/__internal__/planner/types.js";
import {
  actor,
  applyPlannedChannelTransitions,
  artifactProducers,
  GOLDEN,
  hookEffects,
  matrixArtifacts,
  matrixChannels,
  matrixHooks,
  planLineFor,
  plannedOf,
  runInput,
  scopeFor,
  standingChannelStates,
} from "./matrix.js";
import type { LiveWorld, World } from "./matrix.js";

export { GOLDEN, matrixChannels, matrixHooks, standingChannelStates };

// ---------------------------------------------------------------------------
// The persisted tail — one ledger per line's run (the only "process memory"
// here is the frozen recorded tail itself)
// ---------------------------------------------------------------------------

export interface Stores {
  readonly ledger: MemoryLedger;
  readonly claims: MemoryClaimStore;
  readonly log: MemoryTransitionLog;
  readonly register: MemoryAttemptRegister;
  /** The channel store (ADR-0012 decision 6's reference implementation),
   * seeded with §3.1's standing channels — carried across runs like the
   * ledger, so the store is the durable pointer registry the replay
   * consumes (the kernel never consumes it, invariant 2.1). */
  readonly channels: MemoryChannelStore;
  /** The plans' attempts — durable store state like the ledger, carried
   * across calls, keyed by planId. A plan's first run allocates its attempt
   * (that plan's ordinal 1, ADR-0011's per-line register); a resume
   * continues the SAME logical attempt (§2.1's content-anchored identity,
   * V2's stable-identity law); a NEW plan (the next ladder run) allocates
   * fresh. Nothing about the walk's drive state lives in process memory
   * between calls — only the recorded tail and this attempt map. Mutable:
   * the driver allocates attempts lazily and re-arms them after a blocked
   * resolution. */
  attempts: ReadonlyMap<string, ReleaseAttempt>;
  /** Re-arm door: the driver stashes a re-armed successor attempt. */
  rearm(attempt: ReleaseAttempt): void;
}

/** Zero-config per layer (§5): the stores construct from nothing. */
export function freshStores(): Stores {
  const attempts = new Map<string, ReleaseAttempt>();
  return {
    ledger: new MemoryLedger(),
    claims: new MemoryClaimStore(),
    log: new MemoryTransitionLog(),
    register: new MemoryAttemptRegister(),
    channels: new MemoryChannelStore({ channels: standingChannelStates() }),
    attempts,
    rearm: (attempt) => {
      attempts.set(attempt.planId, attempt);
    },
  };
}

/** The §3.1 checkpoint — every channel reads exactly its seeded target. */
export { assertChannelsUnchanged } from "./matrix.js";

/** The byte identity of the tail record by record — the V6 assertion. A
 * `MemoryLedger` append deep-freezes; this is a deterministic canonical
 * rendering so "reads back byte-identical" is asserted, not assumed. */
export const tailBytes = (ledger: MemoryLedger, attemptId: string): readonly string[] =>
  ledger.tail(attemptId).map((record) => JSON.stringify(record));

/** The attemptId a recorded tail belongs to — the identity V2 keeps stable
 * across resume. `attemptIdentity(planId, 1)` is the ordinal-1 identity
 * every run of the plan's first attempt carries (§2.1's content-anchored
 * identity). */
export const tailAttemptId = (planId: string): string => attemptIdentity(planId, 1);

// ---------------------------------------------------------------------------
// The run driver — one release through the replay doors
// ---------------------------------------------------------------------------

export interface Declarations {
  hooks?: readonly HookStep[];
  artifacts?: readonly ArtifactStep[];
  hookEffects?: ReadonlyMap<string, HookEffect>;
  producers?: ReadonlyMap<string, ArtifactProducer>;
}

/** The always-succeeding declaration the replay carries: §3.5's succeeding
 * hooks at their verify/publish anchors plus §3.4's six artifacts, each with
 * its proof. Mirrors 10.2's `fullDeclaration`; the extension row is what the
 * fixture's `boundary` schedulers walk. */
export const fullDeclaration = (): Declarations => {
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
};

export interface RunOptions {
  readonly stores: Stores;
  readonly world: LiveWorld;
  readonly lineId: string;
  readonly intents: readonly OperatorIntent[];
  readonly declarations?: Declarations;
  /** When set, the driver stops right after the write-ahead start of this
   * canonical stage (E-01) — the walk never runs the effect. */
  readonly crashAfterStartOf?: StepKey;
  /** When set, the driver stops right after the write-ahead start of this
   * extension step at its anchor boundary, before its scheduler runs. */
  readonly crashAfterStartOfExtension?: {
    readonly stepKey: StepKey;
    readonly stage: StepKey;
    readonly position: "before" | "after";
  };
  /** When false, a completed walk leaves the attempt `executing` instead of
   * transitioning it to `published` — E-02's replay door is issued against a
   * NON-terminal attempt whose step already completed (a completed attempt
   * would be the §2.8 terminal refusal, not a noop/conflict). */
  readonly terminalize?: boolean;
}

export interface RunResult {
  readonly stores: Stores;
  readonly attempt: ReleaseAttempt;
  readonly planLine: PlanLine;
  readonly scope: ClaimScope;
  /** The claim token the run acquired — the channel-transition application
   * carries it on its records. */
  readonly token: string;
  readonly mintedTag: string | null;
  /** The step-by-step outcomes — a mutable build array the walk appends to;
   * read-only to callers of the completed result. */
  readonly drives: {
    readonly stepKey: StepKey;
    readonly outcome: ReturnType<typeof ledgerRequestStep>;
  }[];
  readonly stoppedAt: StepKey | null;
}

/** The walk's mutable cell — the schedulers hand back successor attempts. */
export interface Ctx {
  attempt: ReleaseAttempt;
  planLine: PlanLine;
  stores: Stores;
  /** The claim token the run acquired — set after the acquisition lands;
   * the channel-transition application carries it on its records. */
  token?: string;
  hooks?: readonly HookStep[];
  artifacts?: readonly ArtifactStep[];
  hookEffects?: ReadonlyMap<string, HookEffect>;
  producers?: ReadonlyMap<string, ArtifactProducer>;
}

const isExtension = (key: StepKey): boolean =>
  key.startsWith("hook:") || key.startsWith("artifact:");

const anchorStage = (ctx: Ctx, key: StepKey): StepKey => {
  const declared =
    (ctx.hooks ?? []).find((hook) => `hook:${hook.id}` === key) ??
    (ctx.artifacts ?? []).find((step) => `artifact:${step.id}` === key);
  if (declared === undefined) {
    throw new Error(`fixture broken: the resume verdict names undeclared step ${key}`);
  }
  return declared.anchor.stage;
};

const liveState = (ctx: Ctx): ReleaseAttempt["state"] => ctx.attempt.state;

/** The extension schedulers at a boundary — fire before the canonical stage
 * and after it. When a hook's §2.5 refusal records, `scheduleHooks` hands
 * back a `blocked` attempt and the walk stops in order. */
const boundary = (
  ctx: Ctx,
  stage: StepKey,
  position: "before" | "after",
  crash?: RunOptions["crashAfterStartOfExtension"],
): boolean => {
  if (crash !== undefined && crash.stage === stage && crash.position === position) {
    const declared =
      (ctx.hooks ?? []).find((hook) => `hook:${hook.id}` === crash.stepKey) ??
      (ctx.artifacts ?? []).find((step) => `artifact:${step.id}` === crash.stepKey);
    if (declared === undefined) {
      throw new Error(`fixture broken: the crash window names undeclared step ${crash.stepKey}`);
    }
    // The extension crash window (E-01): the write-ahead start the scheduler
    // would write lands before the effect; the driver dies there, before the
    // scheduler may walk.
    ctx.stores.ledger.appendStart(
      ctx.attempt,
      crash.stepKey,
      actor(ctx.attempt),
      undefined,
      declared.guard,
    );
    return true;
  }
  const hooksHere = (ctx.hooks ?? []).filter(
    (hook) => hook.anchor.stage === stage && hook.anchor.position === position,
  );
  if (hooksHere.length > 0 && ctx.hookEffects !== undefined && liveState(ctx) === "executing") {
    const run = scheduleHooks(
      ctx.attempt,
      actor(ctx.attempt),
      ctx.stores.ledger,
      ctx.stores.claims.viewFor(ctx.attempt.attemptId),
      ctx.hookEffects,
    );
    ctx.attempt = run.attempt;
  }
  const artifactsHere = (ctx.artifacts ?? []).filter(
    (step) => step.anchor.stage === stage && step.anchor.position === position,
  );
  if (artifactsHere.length > 0 && ctx.producers !== undefined && liveState(ctx) === "executing") {
    const run = scheduleArtifacts(
      ctx.attempt,
      actor(ctx.attempt),
      ctx.stores.ledger,
      ctx.stores.claims.viewFor(ctx.attempt.attemptId),
      ctx.producers,
    );
    ctx.attempt = run.attempt;
  }
  return false;
};

/** The replay walk from `from` — the resume verdict's entry stage. The
 * differentiator from 10.2's `walkStages`: every step request dispatches
 * through `ledgerRequestStep` (the §2.8 record-path replay door). E-02's
 * replay semantics: a completed step replays `noop` over a matching content
 * fingerprint (the walk continues past it when `skipStartFor` re-runs a
 * stage whose write-ahead start is already durable) — never a re-execution,
 * and a mismatched fingerprint is a recorded `conflict`. */
export function walkStages(
  ctx: Ctx,
  from: StepKey,
  opts: RunOptions,
  drives: RunResult["drives"],
  skipStartFor?: StepKey,
): StepKey | null {
  const entry = (
    isExtension(from) ? anchorStage(ctx, from) : from
  ) as (typeof CANONICAL_STAGES)[number];
  const startIndex = CANONICAL_STAGES.indexOf(entry);
  if (startIndex < 0) {
    throw new Error(`fixture broken: ${from} is not a canonical stage or a declared extension`);
  }
  for (const stage of CANONICAL_STAGES.slice(startIndex)) {
    if (boundary(ctx, stage, "before", opts.crashAfterStartOfExtension)) {
      return stage;
    }
    if (liveState(ctx) !== "executing") {
      return stage;
    }
    const preconditions =
      stage === "validate"
        ? ctx.planLine.preconditions.map((row) => ({
            precondition: JSON.stringify(row),
            holds: true,
          }))
        : undefined;
    if (stage !== skipStartFor) {
      ctx.stores.ledger.appendStart(
        ctx.attempt,
        stage,
        actor(ctx.attempt),
        `content:${stage}:${ctx.attempt.attemptId}`,
      );
    }
    if (opts.crashAfterStartOf === stage) {
      return stage;
    }
    if (stage === "channel-transition") {
      // ADR-0012 decision 3's order, exactly: the write-ahead start is
      // durable above; the application executes the recorded plan's moves
      // through the channel store here; the kernel's completion appends
      // below. A plan that names no moves records nothing.
      applyPlannedChannelTransitions({
        attempt: ctx.attempt,
        planLine: ctx.planLine,
        ...(ctx.token === undefined ? {} : { claim: ctx.token }),
        channels: ctx.stores.channels,
        ledger: ctx.stores.ledger,
      });
    }
    const outcome = ledgerRequestStep(
      ctx.attempt,
      {
        stepKey: stage,
        attribution: actor(ctx.attempt),
        contentFingerprint: `content:${stage}:${ctx.attempt.attemptId}`,
        ...(preconditions === undefined ? {} : { preconditions }),
      },
      ctx.stores.claims.viewFor(ctx.attempt.attemptId),
      ctx.stores.ledger,
    );
    drives.push({ stepKey: stage, outcome });
    if (outcome.kind === "advance") {
      ctx.stores.ledger.append({ kind: "step", record: outcome.record });
    } else if (outcome.kind !== "noop" || stage !== skipStartFor) {
      return stage;
    }
    if (boundary(ctx, stage, "after", opts.crashAfterStartOfExtension)) {
      return stage;
    }
    if (liveState(ctx) !== "executing") {
      return stage;
    }
  }
  return null;
}

/** The started attempt the run drives — the stores' carried attempt for this
 * plan when it already ran (the resumed run continues the same logical
 * attempt, V2: its identity is content-anchored over (planId, ordinal)), or
 * the plan's ordinal-1 allocation on the plan's first run. A NEW plan (the
 * next ladder run) is a distinct attempt over its own plan. */
export function startedAttempt(
  stores: Stores,
  assembled: ReleasePlan,
  declarations?: Declarations,
): ReleaseAttempt {
  const existing = stores.attempts.get(assembled.planId);
  if (existing !== undefined) {
    return existing;
  }
  const attempt0 = openAttempt(
    stores.register,
    { planId: assembled.planId, planFingerprint: assembled.planId },
    declarations?.hooks,
    declarations?.artifacts,
  );
  const started = start(attempt0);
  stores.rearm(started);
  return started;
}

/** Drives one release through the replay doors over the caller's persisted
 * stores. The stores (ledger, claims, register, and the attempt value) are
 * carried across calls — `runLedgerRelease` is re-entrant, so resume for
 * the same plan continues the SAME attempt over the recorded tail. The
 * caller decides whether the world observes the mint (staging runs complete
 * on a world copy and never touch the shared world). */
export function runLedgerRelease(opts: RunOptions, observeWorld = true): RunResult {
  const outcome: PlanningOutcome = plannedOf(plan(runInput(opts.world, opts.lineId, opts.intents)));
  const assembled = outcome.plan;
  const planLine = planLineFor(assembled, opts.lineId);
  const stores = opts.stores;
  // Did the stores carry THIS plan before this call (a resume over the
  // recorded tail), or is this call the plan's first run (ladder run on a
  // grown world re-plans to a new planId)? Checked BEFORE startedAttempt —
  // the driver arms the fresh attempt's plan into the stores, so a
  // post-call check would always read "carried".
  const alreadyRan = stores.attempts.has(assembled.planId);
  const attempt = startedAttempt(stores, assembled, opts.declarations);
  const ctx: Ctx = {
    attempt,
    planLine,
    stores,
    ...(opts.declarations?.hooks === undefined ? {} : { hooks: opts.declarations.hooks }),
    ...(opts.declarations?.artifacts === undefined
      ? {}
      : { artifacts: opts.declarations.artifacts }),
    ...(opts.declarations?.hookEffects === undefined
      ? {}
      : { hookEffects: opts.declarations.hookEffects }),
    ...(opts.declarations?.producers === undefined
      ? {}
      : { producers: opts.declarations.producers }),
  };
  const scope = scopeFor(assembled, opts.lineId);
  const settled = stores.claims.acquire(scope, ctx.attempt.attemptId);
  if (settled.kind !== "claim") {
    throw new Error(
      `fixture broken: the claim store denied ${ctx.attempt.attemptId} — the replay owns the scope`,
    );
  }
  ctx.token = settled.token;
  // Resume over the recorded tail (§2.3): a run whose stores already carry
  // this plan's attempt continues from the classification's `from` — the
  // first effective step the ledger does not record completed — and re-runs
  // only that step (its write-ahead start is already durable). A fresh plan
  // (a new ladder run on a grown world) starts from `plan` as usual.
  const drives: RunResult["drives"] = [];
  // Is this a resume of the plan the stores already carry, or a fresh plan
  // (a ladder run on a grown world re-plans to a new planId)? The stores'
  // attempted plan — its attempt already recorded a resume-worthy tail —
  // continues from the classification's `from`; a fresh plan starts from
  // `plan`.
  let from: StepKey = "plan";
  let skipStartFor: StepKey | undefined;
  if (alreadyRan) {
    const verdict = classifyResume(ctx.attempt, stores.ledger);
    if (verdict.kind !== "resume") {
      throw new Error(
        `fixture broken: run on a carried plan got verdict ${verdict.kind} — the replay is not resumable`,
      );
    }
    from = verdict.from;
    // `walkStages` skips a CANONICAL stage whose write-ahead start is
    // already durable — the extension's anchor stage, not the extension key.
    skipStartFor = verdict.from;
    if (isExtension(verdict.from)) {
      skipStartFor = anchorStage(ctx, verdict.from);
    }
  }
  const stoppedAt = walkStages(ctx, from, opts, drives, skipStartFor);
  let mintedTag: string | null = null;
  const terminalize = opts.terminalize ?? true;
  if (stoppedAt === null && terminalize) {
    ctx.attempt = transition(ctx.attempt, "published");
    stores.rearm(ctx.attempt);
    const minted = planLine.streams[0]?.tag ?? planLine.stable?.tag ?? null;
    if (minted !== null) {
      mintedTag = minted;
      if (observeWorld) {
        const ref = opts.world.refs.find((candidate) => candidate.name === opts.lineId);
        if (ref === undefined) {
          throw new Error(`fixture broken: no ref for line ${opts.lineId}`);
        }
        opts.world.tags.push({ name: minted, commit: ref.head });
      }
    }
  }
  return {
    stores,
    attempt: ctx.attempt,
    planLine,
    scope,
    token: settled.token,
    mintedTag,
    drives,
    stoppedAt,
  };
}

/** The reference run every window's resume must classification-match: the
 * same declarations, no interruption, on its own stores. The persisted-tail
 * equality half of §6 recovery. */
export function replayReference(
  world: World,
  lineId: string,
  intents: readonly OperatorIntent[],
  declarations?: Declarations,
): RunResult {
  return runLedgerRelease(
    {
      stores: freshStores(),
      world: { commits: world.commits, refs: world.refs, tags: [...world.tags] },
      lineId,
      intents,
      ...(declarations === undefined ? {} : { declarations }),
    },
    false,
  );
}
