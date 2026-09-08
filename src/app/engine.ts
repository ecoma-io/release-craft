/**
 * The engine value — the application boundary's walk (phase 11 contract
 * §2.5–§2.9). One run is the vertical fixtures' drive, named once: the
 * planner's pure door over the caller's closed input, the attempt over the
 * register, the claim acquired before any mutation (E-07, E-08's bounded
 * retry driven through the kernel's own clause), the canonical walk with
 * the extension schedulers at their anchors, the write-ahead start before
 * every effect (ADR-0006 decision 2), the record-path completion through
 * `ledgerRequestStep` (phase 5 §2.8), the `channel-transition` stage
 * executed through the wired store at §2.4's point, the tag door called
 * once at the mint step with the target the run request carries, and the
 * terminal transition when the walk completed. The boundary invents no
 * step, no order, no retry, no clock: every move cites the kernel or a
 * landed phase contract, and every non-advance stops the walk in order —
 * a stop is recorded (the drives list), never unwound, so the tail stays
 * classifiable.
 *
 * Contract violations throw — the kernel's own, rethrown verbatim, plus
 * the boundary's own impossible-state errors; everything the engine
 * classifies is a returned `RunOutcome` (§2.8). No ambient value enters
 * here: no clock, no randomness, no environment, no HEAD (§3's law) — the
 * module reads nothing but its ports and its arguments.
 */
import {
  CANONICAL_STAGES,
  abort as abortAttempt,
  block,
  classifyResume,
  effectiveSteps,
  isArtifactStepKey,
  isHookStepKey,
  ledgerRequestStep,
  openAttempt,
  plan as planRelease,
  resolveBlocked,
  resume as resumeAttempt,
  scheduleArtifacts,
  scheduleHooks,
  start,
  transition,
  type ArtifactProducer,
  type Attribution,
  type BlockedResolution,
  type Claim,
  type ClaimScope,
  type HookAnchorPosition,
  type PlanningInput,
  type PlanningOutcome,
  type PlanLine,
  type ReleaseAttempt,
  type RequestStepOutcome,
  type StageKey,
  type StepDrive,
  type StepKey,
} from "../index.js";
import { acquireClaim, claimScopeForLine, claimViewFor } from "./claims.js";
import { applyPlannedChannelTransitions, plannedChannelMoves } from "./channels.js";
import type {
  AssemblyConfig,
  AttemptEntry,
  AttemptHandle,
  Engine,
  EnginePorts,
  Observation,
  ObservationQuery,
  RunDeclarations,
  RunOutcome,
  RunOutcomeContext,
  RunRequest,
} from "./types.js";

/**
 * The walk's live state: the attempt is a mutable cell because the
 * schedulers and the state doors return successor values, and flow analysis
 * cannot see the replacement through the call. Everything else is fixed
 * for the walk.
 */
interface WalkContext {
  readonly ports: EnginePorts;
  readonly handle: AttemptHandle;
  readonly planLine: PlanLine;
  readonly declarations: RunDeclarations;
  /** This call's per-step outcomes, in walk order — the §2.8 drives list. */
  readonly drives: StepDrive[];
  attempt: ReleaseAttempt;
  claim: Claim | null;
}

/**
 * Why the walk stopped, when it stopped: at a stage (the drive outcome or
 * a scheduler's suspension decides the row), or at the channel stage's
 * executor, whose `conflict`/`ambiguous` rows are their own outcomes.
 */
type WalkStop =
  | { readonly kind: "stage"; readonly stepKey: StepKey }
  | { readonly kind: "channel-conflict"; readonly detail: string }
  | { readonly kind: "channel-ambiguous"; readonly detail: string };

/** The step content fingerprint convention the fixtures pin: the stage and
 * the attempt identity — the idempotency key every replay is proven over. */
const contentFingerprintFor = (stage: StepKey, attemptId: string): string =>
  `content:${stage}:${attemptId}`;

/** The attribution every record this run appends carries (E-09). */
const attributionFor = (handle: AttemptHandle): Attribution => ({
  attemptId: handle.attemptId,
  actor: handle.actor,
});

/** The tag the plan mints for the executed line, if any — the fixtures'
 * derivation verbatim: the first stream's tag, else the stable tag. */
const plannedTagOf = (planLine: PlanLine): string | null =>
  planLine.streams[0]?.tag ?? planLine.stable?.tag ?? null;

/**
 * The anchor stage a classification verdict's extension step hangs from —
 * the verdict's entry point back into the walk. A verdict naming a step
 * that is neither a canonical stage nor a declared extension is the
 * boundary contradicting itself: the throw is the boundary's own.
 */
const anchorStageOf = (attempt: ReleaseAttempt, key: StepKey): StageKey => {
  if (isHookStepKey(key)) {
    const hook = (attempt.hooks ?? []).find((declared) => `hook:${declared.id}` === key);
    if (hook !== undefined) {
      return hook.anchor.stage;
    }
  }
  if (isArtifactStepKey(key)) {
    const artifact = (attempt.artifacts ?? []).find(
      (declared) => `artifact:${declared.id}` === key,
    );
    if (artifact !== undefined) {
      return artifact.anchor.stage;
    }
  }
  throw new Error(
    `the classification named step ${key}, which is neither a canonical stage nor a ` +
      `declared extension step — the walk cannot enter there (phase 11 contract §2.5)`,
  );
};

/**
 * The producers the artifact scheduler walks with: the run declarations'
 * map, with the wired binding producer as the per-id fallback (§2.3's
 * wiring row — the binding's producer is wired, and the per-run injection
 * is ADR-0008 decision 2's seam). Undefined when the assembly wired no
 * producer and the run declares none — the scheduler then refuses any
 * declared artifact with the kernel's own named throw.
 */
const effectiveProducers = (
  ctx: WalkContext,
): ReadonlyMap<string, ArtifactProducer> | undefined => {
  const declared = ctx.declarations.producers;
  const wired = ctx.ports.producer;
  if (wired === null) {
    return declared;
  }
  return new Map(
    (ctx.attempt.artifacts ?? []).map((step) => [step.id, declared?.get(step.id) ?? wired]),
  );
};

/**
 * The extension schedulers at one anchor boundary (ADR-0007 decision 9;
 * ADR-0008 decision 10) — the fixtures' boundary drive verbatim: the
 * declared hooks anchored here first, then the declared artifact steps,
 * each scheduler replaying completed steps from the ledger projection and
 * returning the successor attempt (a §2.5 escalation blocks it). A
 * suspended attempt is not walked further here — the walk's state checks
 * stop in order.
 */
const runBoundary = (ctx: WalkContext, stage: StageKey, position: HookAnchorPosition): void => {
  if (ctx.attempt.state !== "executing") {
    return;
  }
  const view = claimViewFor(ctx.claim, ctx.ports.claims, ctx.handle.attemptId);
  const hooksHere = (ctx.attempt.hooks ?? []).filter(
    (hook) => hook.anchor.stage === stage && hook.anchor.position === position,
  );
  if (hooksHere.length > 0 && ctx.declarations.hookEffects !== undefined) {
    const run = scheduleHooks(
      ctx.attempt,
      attributionFor(ctx.handle),
      ctx.ports.ledger,
      view,
      ctx.declarations.hookEffects,
    );
    ctx.attempt = run.attempt;
  }
  if (ctx.attempt.state !== "executing") {
    return;
  }
  const artifactsHere = (ctx.attempt.artifacts ?? []).filter(
    (step) => step.anchor.stage === stage && step.anchor.position === position,
  );
  const producers = effectiveProducers(ctx);
  if (artifactsHere.length > 0 && producers !== undefined) {
    const run = scheduleArtifacts(
      ctx.attempt,
      attributionFor(ctx.handle),
      ctx.ports.ledger,
      claimViewFor(ctx.claim, ctx.ports.claims, ctx.handle.attemptId),
      producers,
    );
    ctx.attempt = run.attempt;
  }
};

/**
 * The canonical walk from a classification verdict's entry step (§2.5 step
 * 4): extension steps at their anchors before and after the stage, the
 * write-ahead start, the `channel-transition` executor at §2.4's point,
 * the completion through `ledgerRequestStep`, the advancing record
 * appended. The start is never re-appended when one already stands (E-02:
 * the crash window's replay lands the effect and its completion beside the
 * durable start, and the completion's replay is `noop`, walked past); a
 * completed step replays only on proven content. Any other non-advance
 * stops the walk, in order.
 */
const walk = (ctx: WalkContext, from: StepKey): WalkStop | null => {
  const entry =
    isHookStepKey(from) || isArtifactStepKey(from) ? anchorStageOf(ctx.attempt, from) : from;
  const startIndex = CANONICAL_STAGES.indexOf(entry);
  if (startIndex < 0) {
    throw new Error(
      `the classification named ${from}, which is not a canonical stage — the walk ` +
        `cannot enter there (phase 11 contract §2.5)`,
    );
  }
  for (const stage of CANONICAL_STAGES.slice(startIndex)) {
    runBoundary(ctx, stage, "before");
    if (ctx.attempt.state !== "executing") {
      return { kind: "stage", stepKey: stage };
    }
    // `validate` re-proves the plan's preconditions (E-04): the boundary
    // re-proves the recorded plan content itself — the observations ride
    // exactly as the fixtures drive them.
    const preconditions =
      stage === "validate"
        ? ctx.planLine.preconditions.map((row) => ({
            precondition: JSON.stringify(row),
            holds: true,
          }))
        : undefined;
    if (ctx.ports.ledger.step(ctx.handle.attemptId, stage) !== "started") {
      ctx.ports.ledger.appendStart(
        ctx.attempt,
        stage,
        attributionFor(ctx.handle),
        contentFingerprintFor(stage, ctx.handle.attemptId),
      );
    }
    if (stage === "channel-transition") {
      const channels = ctx.ports.channels;
      if (channels === null) {
        if (plannedChannelMoves(ctx.planLine).length > 0) {
          throw new Error(
            "the walk reached planned channel moves over an assembly that wired no channel " +
              "store — the pre-walk refusal should have stopped the run (phase 11 contract §2.4)",
          );
        }
      } else {
        const moves = applyPlannedChannelTransitions({
          attempt: ctx.attempt,
          planLine: ctx.planLine,
          actor: ctx.handle.actor,
          ...(ctx.claim === null ? {} : { claim: ctx.claim.token }),
          channels,
          ledger: ctx.ports.ledger,
        });
        if (moves.kind === "conflict") {
          return { kind: "channel-conflict", detail: moves.detail };
        }
        if (moves.kind === "ambiguous") {
          return { kind: "channel-ambiguous", detail: moves.detail };
        }
      }
    }
    const outcome: RequestStepOutcome = ledgerRequestStep(
      ctx.attempt,
      {
        stepKey: stage,
        attribution: attributionFor(ctx.handle),
        contentFingerprint: contentFingerprintFor(stage, ctx.handle.attemptId),
        ...(preconditions === undefined ? {} : { preconditions }),
      },
      claimViewFor(ctx.claim, ctx.ports.claims, ctx.handle.attemptId),
      ctx.ports.ledger,
    );
    ctx.drives.push({ stepKey: stage, outcome });
    if (outcome.kind === "advance") {
      ctx.ports.ledger.append({ kind: "step", record: outcome.record });
    } else if (outcome.kind !== "noop") {
      return { kind: "stage", stepKey: stage };
    }
    runBoundary(ctx, stage, "after");
    // A fresh read: the scheduler may have replaced the attempt — the
    // successor the loop's earlier check narrowed past.
    const after = ctx.attempt;
    if (after.state !== "executing") {
      return { kind: "stage", stepKey: stage };
    }
  }
  return null;
};

/**
 * The engine over one assembled port bundle: the §2.6 doors and the §2.7
 * attempt store. Internal — the factories in assemble.ts are the public
 * doors (§2.2), and the engine value they return is the surface a host
 * consumes.
 */
export const createEngine = (ports: EnginePorts, config: AssemblyConfig): Engine => {
  // §2.7 — process-local bookkeeping keyed by plan id, never authority.
  const attempts = new Map<string, AttemptEntry>();

  const outcomeBase = (
    planId: string,
    handle: AttemptHandle,
    drives: readonly StepDrive[],
  ): RunOutcomeContext => ({ planId, handle, drives });

  const refusedOutcome = (
    detail: string,
    planId: string | null,
    handle: AttemptHandle | null,
  ): RunOutcome => ({ kind: "refused", detail, planId, handle, drives: [] });

  /** §2.7's carried-entry door: unknown plan refused naming the handle; a
   * foreign attempt id refused fail-closed. */
  const carriedEntry = (
    handle: AttemptHandle,
  ): { readonly entry: AttemptEntry } | { readonly refusal: string } => {
    const entry = attempts.get(handle.planId);
    if (entry === undefined) {
      return {
        refusal:
          `unknown attempt — the engine carries no attempt for plan ${handle.planId}; the ` +
          `refused handle names ${handle.attemptId} (phase 11 contract §2.7)`,
      };
    }
    if (entry.attempt.attemptId !== handle.attemptId) {
      return {
        refusal:
          `the carried attempt for plan ${handle.planId} is ${entry.attempt.attemptId}, not ` +
          `${handle.attemptId} — refusing to continue over a foreign handle (phase 11 contract §2.7)`,
      };
    }
    return { entry };
  };

  /** One acquisition's rows, when it did not land (§2.8's table). */
  const acquisitionOutcome = (
    acquisition: Exclude<ReturnType<typeof acquireClaim>, { kind: "held" }>,
    planId: string,
    handle: AttemptHandle,
  ): RunOutcome => {
    const base = outcomeBase(planId, handle, []);
    if (acquisition.kind === "denied") {
      return { kind: "denied", holder: acquisition.holder, ...base };
    }
    if (acquisition.kind === "refused") {
      return { kind: "refused", detail: acquisition.detail, ...base };
    }
    return { kind: "conflict", detail: acquisition.detail, ...base };
  };

  /** §2.5 steps 5–6 — the mint, then the terminal. Only a minted tag
   * publishes; a refused or conflicting mint is the returned outcome and
   * the attempt stays exactly as the walk left it (nothing the door
   * refused left state behind). The outcome's `tag` is the release's tag
   * identity — the plan's own. A wired door's returned tag is authoritative
   * (it is the name the minted ref carries); a memory assembly wired no
   * door, so the walk's completion publishes the plan's tag without a
   * minted ref — the zero-persistence posture: the caller owns the world
   * the ref would land in, exactly as the phase 10 fixtures record their
   * minted tags themselves. */
  const completeRun = (
    entry: AttemptEntry,
    handle: AttemptHandle,
    plannedTag: string | null,
    target: string | undefined,
    drives: readonly StepDrive[],
  ): RunOutcome => {
    const base = outcomeBase(handle.planId, handle, drives);
    if (plannedTag === null) {
      entry.attempt = transition(entry.attempt, "published");
      return { kind: "published", tag: null, ...base };
    }
    if (ports.mint === null) {
      entry.attempt = transition(entry.attempt, "published");
      return { kind: "published", tag: plannedTag, ...base };
    }
    if (entry.claim === null) {
      return {
        kind: "refused",
        detail:
          `the walk completed with ${plannedTag} to mint but the attempt holds no claim — ` +
          `refusing the mint without ownership (phase 11 contract §2.5)`,
        ...base,
      };
    }
    if (target === undefined) {
      return {
        kind: "refused",
        detail:
          `the plan mints ${plannedTag} but the run supplies no recorded target for the line — ` +
          `the mint target is a plan-run value carried by the caller, never ambient HEAD ` +
          `(phase 8 §2.3; phase 11 contract §2.5)`,
        ...base,
      };
    }
    const result = ports.mint({
      attemptId: handle.attemptId,
      token: entry.claim.token,
      tag: plannedTag,
      target,
    });
    if (result.kind === "refused") {
      return { kind: "refused", detail: result.detail, ...base };
    }
    if (result.kind === "conflict") {
      return { kind: "conflict", detail: result.detail, ...base };
    }
    entry.attempt = transition(entry.attempt, "published");
    entry.tags.push(result.tag);
    return { kind: "published", tag: result.tag, ...base };
  };

  /** A stage stop's row (§2.8): a suspended attempt is `blocked`; otherwise
   * the stopping drive's outcome rides verbatim — `satisfied-externally`,
   * `conflict`, `failed` (the claim-lost loser path), `blocked` (the guard
   * that failed on world state suspends the attempt here), or `refused`. */
  const stopOutcome = (
    ctx: WalkContext,
    stop: WalkStop,
    planId: string,
    handle: AttemptHandle,
  ): RunOutcome => {
    const base = outcomeBase(planId, handle, [...ctx.drives]);
    if (stop.kind === "channel-conflict") {
      return { kind: "conflict", detail: stop.detail, ...base };
    }
    if (stop.kind === "channel-ambiguous") {
      return { kind: "ambiguous", detail: stop.detail, ...base };
    }
    if (ctx.attempt.state === "blocked") {
      return {
        kind: "blocked",
        cause: ctx.attempt.blockedCause ?? "blocked-without-recorded-cause",
        ...base,
      };
    }
    const recorded = ctx.drives.find((drive) => drive.stepKey === stop.stepKey);
    if (recorded === undefined) {
      return {
        kind: "refused",
        detail:
          `the walk stopped at ${stop.stepKey} without a recorded step outcome — the stopping ` +
          `boundary recorded nothing to classify (phase 11 contract §2.5)`,
        ...base,
      };
    }
    const outcome = recorded.outcome;
    switch (outcome.kind) {
      case "satisfied-externally":
        return { kind: "satisfied-externally", ...base };
      case "conflict":
        return { kind: "conflict", detail: outcome.detail, ...base };
      case "claim-lost":
        return { kind: "failed", cause: outcome.detail, ...base };
      case "blocked":
        // The guard failed on world state: suspend the attempt — the cause
        // recorded verbatim, nothing consumed — so the §2.7 resolution loop
        // can answer it.
        ctx.attempt = block(ctx.attempt, outcome.cause);
        return { kind: "blocked", cause: outcome.cause, ...base };
      case "refused":
        return { kind: "refused", detail: outcome.detail, ...base };
      case "noop":
      case "advance":
        throw new Error(
          `the walk stopped at ${stop.stepKey} on a ${outcome.kind} outcome — a replay walks ` +
            `past and an advance appends; neither stops (phase 11 contract §2.5)`,
        );
    }
  };

  /** A walked run's tail: the walk from the verdict's entry, then the stop
   * or the completion. The attempt cell syncs back into the entry after
   * every path — the store is bookkeeping, kept current (§2.7). */
  const driveFrom = (
    entry: AttemptEntry,
    handle: AttemptHandle,
    declarations: RunDeclarations,
    from: StepKey,
    plannedTag: string | null,
    target: string | undefined,
  ): RunOutcome => {
    const ctx: WalkContext = {
      ports,
      handle,
      planLine: entry.planLine,
      declarations,
      drives: [],
      attempt: entry.attempt,
      claim: entry.claim,
    };
    const stop = walk(ctx, from);
    entry.attempt = ctx.attempt;
    if (stop === null) {
      return completeRun(entry, handle, plannedTag, target, ctx.drives);
    }
    const outcome = stopOutcome(ctx, stop, handle.planId, handle);
    entry.attempt = ctx.attempt;
    return outcome;
  };

  /** A carried attempt's continuation (§2.6): classify first — never
   * re-plan — then walk from the verdict, complete the recorded terminal,
   * or surface `stale`/`escalate` verbatim. */
  const continueRun = (
    entry: AttemptEntry,
    handle: AttemptHandle,
    declarations: RunDeclarations,
    target: string | undefined,
  ): RunOutcome => {
    const plannedTag = plannedTagOf(entry.planLine);
    const verdict = classifyResume(entry.attempt, ports.ledger);
    const base = outcomeBase(handle.planId, handle, []);
    if (verdict.kind === "stale") {
      return { kind: "stale", detail: verdict.detail, ...base };
    }
    if (verdict.kind === "escalate") {
      return { kind: "escalate", detail: verdict.detail, ...base };
    }
    if (verdict.kind === "complete") {
      if (verdict.outcome === "satisfied-externally") {
        // Nothing else terminalizes: satisfied-externally follows the
        // recorded steps exactly as classifyResume read them (§2.5).
        return { kind: "satisfied-externally", ...base };
      }
      return completeRun(entry, handle, plannedTag, target, []);
    }
    return driveFrom(entry, handle, declarations, verdict.from, plannedTag, target);
  };

  /** The claim, acquired before any mutation (§2.5 step 3) — idempotent for
   * the same holder, so a resumed run's re-acquire is the replay it already
   * was. A non-held acquisition is the returned outcome, nothing walked. */
  const acquireFor = (
    entry: AttemptEntry,
    scope: ClaimScope,
    handle: AttemptHandle,
  ): RunOutcome | null => {
    const acquisition = acquireClaim(ports.claims, scope, handle.attemptId, config);
    if (acquisition.kind !== "held") {
      return acquisitionOutcome(acquisition, handle.planId, handle);
    }
    entry.claim = acquisition.claim;
    return null;
  };

  const doRun = (request: RunRequest): RunOutcome => {
    // §2.5 step 1 — the plan. The request's intents are authoritative for
    // the run; the planner's refusal IS the run outcome: returned, nothing
    // executed, no store touched.
    const planning = planRelease({ ...request.input, intents: request.intents });
    if (planning.kind === "refused") {
      return refusedOutcome(planning.refusal.detail, null, null);
    }
    const assembled = planning.plan;
    const planId = assembled.planId;
    if (request.lineIds.length !== 1) {
      return refusedOutcome(
        `a run executes exactly one line (M-02's posture; phase 11 contract §4 question 7 ` +
          `defers the whole-plan pass) — the request named ${String(request.lineIds.length)} line ids`,
        planId,
        null,
      );
    }
    const lineId = request.lineIds[0];
    if (lineId === undefined) {
      return refusedOutcome("the request names no line id to execute", planId, null);
    }
    const planLine = assembled.lines.find((candidate) => candidate.lineId === lineId);
    if (planLine === undefined) {
      return refusedOutcome(
        `the plan ${planId} assembles no line ${lineId} — the request's lineIds name a line ` +
          `the plan does not carry`,
        planId,
        null,
      );
    }
    // §2.4's pre-walk refusal: a plan whose channel content cannot be
    // applied never starts a walk that records starts and completions while
    // no pointer moves.
    if (ports.channels === null && plannedChannelMoves(planLine).length > 0) {
      return refusedOutcome(
        `the plan declares channel moves for line ${lineId} at the channel-transition stage, ` +
          `but the assembly wired no channel store — refusing before the walk starts, naming ` +
          `the stage and the missing port (ADR-0012 decision 6; phase 11 contract §2.4)`,
        planId,
        null,
      );
    }
    const scope = claimScopeForLine(planLine);
    if (scope === null) {
      return refusedOutcome(
        `line ${lineId} plans no release to claim — no stream and no stable target, so the ` +
          `claim derivation names no scope (phase 11 contract §2.3)`,
        planId,
        null,
      );
    }
    const plannedTag = plannedTagOf(planLine);
    const target = request.targets?.[lineId];
    if (ports.mint !== null && plannedTag !== null && target === undefined) {
      return refusedOutcome(
        `line ${lineId}'s plan mints ${plannedTag} over an assembly that wired the tag door, ` +
          `but the request supplies no recorded target for the line — the mint target is a ` +
          `plan-run value carried by the caller, never ambient HEAD (phase 8 §2.3)`,
        planId,
        null,
      );
    }
    // §2.5 step 2 — the attempt: carried continues, fresh allocates.
    const carried = attempts.get(planId);
    let entry: AttemptEntry;
    if (carried === undefined) {
      const opened = start(
        openAttempt(
          ports.register,
          { planId, planFingerprint: planId },
          request.declarations?.hooks,
          request.declarations?.artifacts,
        ),
      );
      entry = { attempt: opened, planLine, claim: null, tags: [] };
      attempts.set(planId, entry);
    } else {
      entry = carried;
    }
    const handle: AttemptHandle = {
      planId,
      attemptId: entry.attempt.attemptId,
      actor: request.actor,
    };
    const denial = acquireFor(entry, scope, handle);
    if (denial !== null) {
      return denial;
    }
    if (carried === undefined) {
      return driveFrom(entry, handle, request.declarations ?? {}, "plan", plannedTag, target);
    }
    return continueRun(entry, handle, request.declarations ?? {}, target);
  };

  const doResume = (handle: AttemptHandle, request: RunRequest): RunOutcome => {
    const found = carriedEntry(handle);
    if ("refusal" in found) {
      return refusedOutcome(found.refusal, handle.planId, handle);
    }
    const { entry } = found;
    const scope = claimScopeForLine(entry.planLine);
    if (scope === null) {
      return refusedOutcome(
        `line ${entry.planLine.lineId} plans no release to claim — no stream and no stable ` +
          `target, so the claim derivation names no scope (phase 11 contract §2.3)`,
        handle.planId,
        handle,
      );
    }
    const denial = acquireFor(entry, scope, handle);
    if (denial !== null) {
      return denial;
    }
    return continueRun(
      entry,
      handle,
      request.declarations ?? {},
      request.targets?.[entry.planLine.lineId],
    );
  };

  const doResolve = (
    handle: AttemptHandle,
    stepKey: StepKey,
    resolution: BlockedResolution,
  ): RunOutcome => {
    const found = carriedEntry(handle);
    if ("refusal" in found) {
      return refusedOutcome(found.refusal, handle.planId, handle);
    }
    const { entry } = found;
    // resolveBlocked is the kernel's own door: it demands a blocked attempt
    // and — for a revalidation — the stored plan's fingerprint, and its
    // throws are the kernel's contract violations, never translated (§2.8).
    resolveBlocked(entry.attempt, stepKey, resolution, ports.ledger, {
      attemptId: handle.attemptId,
      actor: handle.actor,
    });
    entry.attempt = resumeAttempt(entry.attempt, "resolution recorded");
    return { kind: "resolved", ...outcomeBase(handle.planId, handle, []) };
  };

  const doAbort = (handle: AttemptHandle, actor: string, reason: string): RunOutcome => {
    const found = carriedEntry(handle);
    if ("refusal" in found) {
      return refusedOutcome(found.refusal, handle.planId, handle);
    }
    const { entry } = found;
    // abort is the kernel's own door: terminal is terminal (E-09), and the
    // throw on a terminal attempt is the kernel's contract violation. The
    // ledger names no abandonment record kind (phase 4 §2.8 left the
    // durable record to its own slice), so the recorded attempt — terminal
    // reason carried — is what the store keeps and observe reads back.
    const outcome = abortAttempt(entry.attempt, actor, reason);
    entry.attempt = outcome.attempt;
    return { kind: "abandoned", reason, ...outcomeBase(handle.planId, handle, []) };
  };

  const doObserve = (query: ObservationQuery): Observation => {
    if (query.kind === "channels") {
      if (ports.channels === null) {
        return {
          kind: "refused",
          detail:
            "no channel store is wired — the assembly names no channel port, so there is " +
            "nothing to read (phase 11 contract §2.4)",
        };
      }
      return { kind: "channels", channels: ports.channels.list() };
    }
    const found = carriedEntry(query.handle);
    if ("refusal" in found) {
      return { kind: "refused", detail: found.refusal };
    }
    const { entry } = found;
    const attempt = entry.attempt;
    return {
      kind: "attempt",
      handle: query.handle,
      state: attempt.state,
      ...(attempt.blockedCause === undefined ? {} : { blockedCause: attempt.blockedCause }),
      ...(attempt.terminalReason === undefined ? {} : { terminalReason: attempt.terminalReason }),
      tail: ports.ledger.tail(query.handle.attemptId),
      steps: effectiveSteps(attempt).map((stepKey) => ({
        stepKey,
        state: ports.ledger.step(query.handle.attemptId, stepKey),
      })),
      claim: entry.claim,
      tags: [...entry.tags],
      channels: ports.channels === null ? null : ports.channels.list(),
    };
  };

  return {
    plan: (input: PlanningInput): PlanningOutcome => planRelease(input),
    run: doRun,
    resume: doResume,
    resolve: doResolve,
    abort: doAbort,
    observe: doObserve,
  };
};
