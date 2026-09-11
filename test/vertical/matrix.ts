/**
 * The Phase 10 vertical matrix's fixture module — the in-memory slice's
 * shared declaration (contract docs/design/phase10-vertical-matrix-contract.md
 * §2/§3). Everything here is recorded data: the world's commits, refs and
 * tags are hand-written fixture values; the goldens are derived by hand from
 * the phase contracts before any run asserts them. No fixture computes a
 * golden, and no fixture reads a clock or the environment (§5's laws).
 */
import { Channel, Version } from "@ecoma-io/release-craft/domain";
import { stageContentFingerprint } from "@ecoma-io/release-craft/app";

import {
  CANONICAL_STAGES,
  MemoryAttemptRegister,
  MemoryChannelStore,
  MemoryClaimStore,
  MemoryLedger,
  MemoryTransitionLog,
  openAttempt,
  requestStep,
  scheduleArtifacts,
  scheduleHooks,
  start,
  transition,
  type ArtifactProducer,
  type ArtifactStep,
  type Attribution,
  type ChannelApplyOutcome,
  type ChannelState,
  type ChannelStore,
  type Claim,
  type ClaimScope,
  type ExecutionLedger,
  type HookEffect,
  type HookStep,
  type ReleaseAttempt,
  type StageKey,
  type StepKey,
} from "@ecoma-io/release-craft/__internal__/execution/index.js";
import { plan } from "@ecoma-io/release-craft/__internal__/planner/assemble.js";
import type {
  ChannelObservation,
  CommitObservation,
  LineConfig,
  OperatorIntent,
  PlanLine,
  PlannedChannelMove,
  PlannedStream,
  PlanningInput,
  PlanningOutcome,
  PolicyInput,
  RefObservation,
  ReleasePlan,
  TagObservation,
} from "@ecoma-io/release-craft/__internal__/planner/types.js";

// ---------------------------------------------------------------------------
// The policy and the five lines (§3.1) — recorded data
// ---------------------------------------------------------------------------

/** One fixed digest for the whole matrix — opaque content identity. */
export const POLICY_DIGEST = "sha256:" + "m".repeat(64);
/** The fixed wall-clock stand-in — a recorded string, never a read clock. */
export const COMMITTED_AT = "2026-01-01T00:00:00Z";

export function matrixPolicy(): PolicyInput {
  return {
    digest: POLICY_DIGEST,
    bumpMappingId: "default",
    prereleaseLadder: ["alpha", "beta", "rc"],
    prereleaseSeed: "0",
    pre10Dampening: true,
    selfReferenceNamespace: "Release-Craft:",
    tagFormats: {},
  };
}

export function matrixLines(): readonly LineConfig[] {
  return [
    // The ladder line — its declared per-line seed numbers §3.2's ladder
    // from `.1` (D13's fork; the global seed stays "0").
    { id: "main", feedRef: "main", lifecycle: "active", declared: true, streams: { seed: "1" } },
    {
      id: "4.8.x",
      feedRef: "4.8.x",
      lifecycle: "active",
      declared: true,
      versionBand: { major: 4, minor: 8 },
    },
    { id: "3.x", feedRef: "3.x", lifecycle: "active", declared: true, versionBand: { major: 3 } },
    { id: "2.x", feedRef: "2.x", lifecycle: "active", declared: true, versionBand: { major: 2 } },
    {
      id: "1.9-lts",
      feedRef: "1.9-lts",
      lifecycle: "active",
      declared: true,
      versionBand: { major: 1, minor: 9 },
    },
  ];
}

// ---------------------------------------------------------------------------
// The world — the five lines' commit graphs, refs and tags (§3.1's seeds)
// ---------------------------------------------------------------------------

export interface World {
  readonly commits: readonly CommitObservation[];
  readonly refs: readonly RefObservation[];
  readonly tags: readonly TagObservation[];
}

const commit = (
  sha: string,
  message: string,
  opts: { readonly parents?: readonly string[]; readonly containingRefs?: readonly string[] } = {},
): CommitObservation => ({
  sha,
  parents: opts.parents ?? [],
  message,
  committedAt: COMMITTED_AT,
  containingRefs: opts.containingRefs ?? [],
});

/** The initial world, hand-built from §3.1's seed table: `main` tagged to
 * `4.9.2` carrying the breaking rewrite and the carried fix; `4.8.x` and
 * `1.9-lts` carrying the same fix on their own heads; `3.x` and `2.x`
 * carrying their own independent changes (M-02). */
export function freshWorld(): World {
  return {
    commits: [
      commit("m1", "feat: the 4.9 line", { containingRefs: ["main"] }),
      commit("m2", "fix: the 4.9 follow-up", { parents: ["m1"], containingRefs: ["main"] }),
      commit("m3", "chore: the 4.9 runway", { parents: ["m2"], containingRefs: ["main"] }),
      commit("m4", "feat!: the breaking rewrite", { parents: ["m3"], containingRefs: ["main"] }),
      commit("m5", "fix: the carried fix", { parents: ["m4"], containingRefs: ["main"] }),
      commit("f1", "fix: the 4.8 base", { containingRefs: ["4.8.x"] }),
      commit("f2", "fix: the carried fix", { parents: ["f1"], containingRefs: ["4.8.x"] }),
      commit("g1", "feat: the 3.2 line", { containingRefs: ["3.x"] }),
      commit("g2", "feat: the 3.x feature", { parents: ["g1"], containingRefs: ["3.x"] }),
      commit("h1", "fix: the 2.4 base", { containingRefs: ["2.x"] }),
      commit("h2", "fix: the 2.x hotfix", { parents: ["h1"], containingRefs: ["2.x"] }),
      commit("i1", "fix: the 1.9 base", { containingRefs: ["1.9-lts"] }),
      commit("i2", "fix: the carried fix", { parents: ["i1"], containingRefs: ["1.9-lts"] }),
    ],
    refs: [
      { name: "main", head: "m5" },
      { name: "4.8.x", head: "f2" },
      { name: "3.x", head: "g2" },
      { name: "2.x", head: "h2" },
      { name: "1.9-lts", head: "i2" },
    ],
    tags: [
      { name: "4.9.0", commit: "m1" },
      { name: "4.9.1", commit: "m2" },
      { name: "4.9.2", commit: "m3" },
      { name: "4.8.6", commit: "f1" },
      { name: "3.2.1", commit: "g1" },
      { name: "2.4.0", commit: "h1" },
      { name: "1.9.1", commit: "i1" },
    ],
  };
}

/** A mutable world stand-in for the driver: runs record their minted tags
 * here, so the next run's closed input observes the recorded state. */
export interface LiveWorld {
  commits: readonly CommitObservation[];
  refs: readonly RefObservation[];
  tags: TagObservation[];
}

export function liveWorld(): LiveWorld {
  const fresh = freshWorld();
  return { commits: fresh.commits, refs: fresh.refs, tags: [...fresh.tags] };
}

export const snapshot = (world: LiveWorld): World => ({
  commits: world.commits,
  refs: world.refs,
  tags: [...world.tags],
});

// ---------------------------------------------------------------------------
// The goldens — derived by hand from the phase contracts (§2), never from a
// run: the ladder (§3.2), the side cuts (§3.2/§3.3), and the five channels'
// seeded targets (§3.1)
// ---------------------------------------------------------------------------

export const GOLDEN = {
  /** §3.2's four ladder runs — `main`'s declared seed numbers them `.1`. */
  ladder: ["5.0.0-beta.1", "5.0.0-beta.2", "5.0.0-rc.1", "5.0.0"],
  /** The side lines' own cuts: the maintenance/propagation patches and the
   * independent minor and patch (§3.2 beside-the-ladder, §3.3). */
  sides: { "4.8.x": "4.8.7", "3.x": "3.3.0", "2.x": "2.4.1", "1.9-lts": "1.9.2" },
  /** §3.1's five seeded channel targets — the standing state every fixture's
   * channel store seeds, and what every non-promoting run must leave
   * untouched (only the promote run's own plan names moves). */
  channels: {
    stable: { line: "main", version: "4.9.2" },
    beta: { line: "main", version: "4.9.1" },
    rc: { line: "main", version: "4.9.1" },
    next: { line: "main", version: "4.9.2" },
    lts: { line: "1.9-lts", version: "1.9.1" },
  },
} as const;

/** The five channel fixtures, constructed through the domain door. */
export function matrixChannels(): readonly Channel[] {
  return (
    Object.entries(GOLDEN.channels) as readonly (readonly [
      string,
      { readonly line: string; readonly version: string },
    ])[]
  ).map(([id, target]) =>
    Channel.of(id, { line: target.line, version: Version.parse(target.version) }),
  );
}

/** A standing channel state — the §3.1 seeds are all pointed, so the
 * fixture's states carry a non-null target (the store's `ChannelState`
 * widens it to include the hidden state a fresh channel starts in). */
export interface StandingChannelState {
  readonly id: string;
  readonly target: { readonly line: string; readonly version: string };
}

/** The standing channel states in the store's own serialized shape, in
 * declaration order — what every fixture's channel store is seeded with
 * (§3.1), and the expectation every checkpoint reads against. */
export function standingChannelStates(): readonly StandingChannelState[] {
  return (
    Object.entries(GOLDEN.channels) as readonly (readonly [
      string,
      { readonly line: string; readonly version: string },
    ])[]
  ).map(([id, target]) => ({ id, target: { line: target.line, version: target.version } }));
}

/** §3.1's five standing channels as the planner's declared registry — the
 * closed §2.1 input's `channels` field, in declaration order. */
export function matrixChannelRegistry(): readonly ChannelObservation[] {
  return standingChannelStates().map((channel) => ({
    id: channel.id,
    target: { line: channel.target.line, version: channel.target.version },
  }));
}

/** §3.1's checkpoint: every channel reads exactly its seeded target. */
export function assertChannelsUnchanged(channels: readonly Channel[]): void {
  const seeded: Record<string, { readonly line: string; readonly version: string } | undefined> =
    GOLDEN.channels;
  for (const channel of channels) {
    const target = seeded[channel.id];
    if (target === undefined) {
      throw new Error(`fixture broken: channel ${channel.id} is not a matrix channel`);
    }
    if (!channel.pointsAt(target.line, Version.parse(target.version))) {
      throw new Error(
        `channel ${channel.id} moved off ${target.line}@${target.version} — this checkpoint runs ` +
          `over plans that carry no channel moves (#76's door moves a channel only as recorded ` +
          `plan surface), so every standing channel must still read its §3.1 seed`,
      );
    }
  }
}

/** §3.1's checkpoint over a channel store: every standing channel reads
 * exactly its seeded target, and the store holds exactly the five matrix
 * channels — the assertion every run that plans no moves must satisfy. */
export function assertStoreChannelsStanding(store: ChannelStore): void {
  const standing = standingChannelStates();
  const listed = store.list();
  if (listed.length !== standing.length) {
    throw new Error(
      `the channel store holds ${String(listed.length)} channels, the matrix stands five`,
    );
  }
  for (const expected of standing) {
    const observed = store.read(expected.id);
    if (
      observed.target === null ||
      observed.target.line !== expected.target.line ||
      observed.target.version !== expected.target.version
    ) {
      throw new Error(
        `channel ${expected.id} reads ${JSON.stringify(observed.target)}, the matrix stands ` +
          `${expected.target.line}@${expected.target.version} — a run moved a channel its plan never named`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The declared extension steps (§3.4's six artifacts, §3.5's four hooks) —
// the phase 7 §2.1 / phase 6 shape, anchors recorded verbatim
// ---------------------------------------------------------------------------

/** §3.4's six artifact steps — `changelog` rides before `publish-all` so the
 * phase 9 §2.8 gate never meets an unrecorded changelog; no step anchors
 * after the publish stage. */
export function matrixArtifacts(): readonly ArtifactStep[] {
  return [
    {
      id: "package",
      anchor: { stage: "commit", position: "before" },
      guard: "release-line",
      kind: "npm",
      coordinates: "app@<version>",
      dependsOn: [],
      postconditions: ["content-fingerprint-present"],
    },
    {
      id: "binary",
      anchor: { stage: "commit", position: "before" },
      guard: "release-line",
      kind: "binary",
      coordinates: "app-<version>.tar.gz",
      dependsOn: [],
      postconditions: ["content-fingerprint-present"],
    },
    {
      id: "container",
      anchor: { stage: "commit", position: "after" },
      guard: "release-line",
      kind: "container",
      coordinates: "ghcr.io/ecoma/app:<version>",
      dependsOn: ["package"],
      postconditions: ["content-fingerprint-present"],
    },
    {
      id: "sbom",
      anchor: { stage: "commit", position: "after" },
      guard: "release-line",
      kind: "sbom",
      coordinates: "app-<version>.sbom",
      dependsOn: ["package", "binary"],
      postconditions: ["evidence-present"],
    },
    {
      id: "changelog",
      anchor: { stage: "tag", position: "after" },
      guard: "release-line",
      kind: "changelog",
      coordinates: "changelog-<version>.md",
      dependsOn: ["package", "binary"],
      postconditions: ["evidence-present"],
    },
    {
      id: "publish-all",
      anchor: { stage: "publish", position: "before" },
      guard: "release-line",
      kind: "publication",
      coordinates: "release/<version>",
      dependsOn: ["container", "sbom", "changelog"],
      postconditions: ["evidence-present"],
    },
  ];
}

export interface HookFixtures {
  /** §3.5 succeeding — the observation meets the declared postconditions. */
  readonly notify: HookStep;
  /** §3.5 failing — the observation refuses; the walk stops blocked. */
  readonly attest: HookStep;
  /** §3.5 retried — fails once, `resolveBlocked` re-arms, the second lands. */
  readonly sign: HookStep;
  /** §3.5 resumed — the crash window between its start and its completion. */
  readonly publishHook: HookStep;
}

export function matrixHooks(): HookFixtures {
  return {
    notify: {
      id: "notify",
      anchor: { stage: "verify", position: "after" },
      guard: "release-line",
      postconditions: ["evidence-present"],
    },
    attest: {
      id: "attest",
      anchor: { stage: "publish", position: "before" },
      guard: "release-line",
      postconditions: ["evidence-present"],
    },
    sign: {
      id: "sign",
      anchor: { stage: "publish", position: "before" },
      guard: "release-line",
      postconditions: ["content-fingerprint-present"],
    },
    publishHook: {
      id: "announce",
      anchor: { stage: "publish", position: "after" },
      guard: "release-line",
      postconditions: ["evidence-present"],
    },
  };
}

// ---------------------------------------------------------------------------
// The engine assembly — the public doors only, over the memory stores
// ---------------------------------------------------------------------------

export interface Stores {
  readonly register: MemoryAttemptRegister;
  readonly ledger: MemoryLedger;
  readonly claims: MemoryClaimStore;
  readonly log: MemoryTransitionLog;
  /** The channel store (ADR-0012 decision 6's reference implementation),
   * seeded with §3.1's standing channels — the deliverability pointers the
   * application layer moves at the `channel-transition` stage. The kernel
   * never consumes it (invariant 2.1). */
  readonly channels: MemoryChannelStore;
}

/** Zero-config per layer (§5): the stores construct from nothing — no
 * environment, no clock, no configuration surface. */
export function freshStores(): Stores {
  return {
    register: new MemoryAttemptRegister(),
    ledger: new MemoryLedger(),
    claims: new MemoryClaimStore(),
    log: new MemoryTransitionLog(),
    channels: new MemoryChannelStore({ channels: standingChannelStates() }),
  };
}

export const actor = (attempt: ReleaseAttempt, who = "automation"): Attribution => ({
  attemptId: attempt.attemptId,
  actor: who,
});

export const asClaim = (
  settled: Claim | { readonly kind: "denied"; readonly scope: ClaimScope },
): Claim => {
  if (settled.kind !== "claim") {
    throw new Error(`fixture broken: expected a claim, got ${settled.kind}`);
  }
  return settled;
};

export function plannedOf(outcome: PlanningOutcome): Extract<PlanningOutcome, { kind: "planned" }> {
  if (outcome.kind !== "planned") {
    throw new Error(`fixture broken: expected a planned outcome, got ${outcome.kind}`);
  }
  return outcome;
}

export function planLineFor(assembled: ReleasePlan, lineId: string): PlanLine {
  const found = assembled.lines.find((candidate) => candidate.lineId === lineId);
  if (found === undefined) {
    throw new Error(`fixture broken: the plan assembles no line ${lineId}`);
  }
  return found;
}

/** The closed §2.1 input one run's world reconstructs — the run's line alone
 * (M-02: no cross-dependency between any two lines' runs). */
export function runInput(
  world: World,
  lineId: string,
  intents: readonly OperatorIntent[],
): PlanningInput {
  const line = matrixLines().find((candidate) => candidate.id === lineId);
  if (line === undefined) {
    throw new Error(`fixture broken: no matrix line ${lineId}`);
  }
  return {
    policy: matrixPolicy(),
    repository: { commits: world.commits, refs: world.refs },
    history: { tags: world.tags },
    lines: [line],
    components: [{ name: "app", manifestVersion: "4.9.2", paths: ["package.json"] }],
    intents,
    // §3.1's five standing channels are part of the declared world: the
    // registry is the planner's channel content source (ADR-0012 decision 2),
    // and every non-promote run leaves the plan's `channels` absent — absent
    // is byte-identical to the pre-ADR-0012 plan.
    channels: matrixChannelRegistry(),
  };
}

/** The claim scope a run's decision demands — the planned target verbatim:
 * a prerelease stream's sequence scope, else the stable version's record
 * scope. */
export function scopeFor(assembled: ReleasePlan, lineId: string): ClaimScope {
  const line = planLineFor(assembled, lineId);
  const stream: PlannedStream | undefined = line.streams[0];
  if (stream !== undefined) {
    const rendered = stream.version.toString();
    const base = stream.pointerBase ?? rendered.split("-")[0] ?? rendered;
    const suffix = stream.version.toString().split("-")[1] ?? "";
    const sequence = Number.parseInt(suffix.split(".")[1] ?? "0", 10);
    return {
      kind: "prerelease-sequence",
      lineId,
      target: base,
      streamId: stream.identifier,
      sequence,
    };
  }
  if (line.stable === null) {
    throw new Error(`fixture broken: line ${lineId} plans no release to claim`);
  }
  return { kind: "stable-version", lineId, version: line.stable.version };
}

export interface StepDrive {
  readonly stepKey: StepKey;
  readonly outcome: ReturnType<typeof requestStep>;
}

/** One canonical stage through the kernel's doors: the caller has already
 * landed the write-ahead start (ADR-0006 decision 2), the pure door
 * classifies, the advancing record appends to both projections. */
export function driveStage(
  attempt: ReleaseAttempt,
  stage: StepKey,
  stores: Stores,
  planLine: PlanLine,
  preconditions?: readonly { readonly precondition: string; readonly holds: boolean }[],
): StepDrive {
  // The stage's §2.6 content digest — the engine's own derivation
  // (stageContentFingerprint), so the fixture drive stays the same named
  // walk the application boundary performs: identity is not an input.
  const fingerprint = stageContentFingerprint(stage as StageKey, planLine);
  const outcome = requestStep(
    attempt,
    {
      stepKey: stage as Parameters<typeof requestStep>[1]["stepKey"],
      attribution: actor(attempt),
      contentFingerprint: fingerprint,
      ...(preconditions === undefined ? {} : { preconditions }),
    },
    stores.claims.viewFor(attempt.attemptId),
    // The kernel consumes the durable ledger's projection (§2.3) — the
    // schedulers' extension records live here, never only in the log mirror.
    stores.ledger.stepView(),
  );
  if (outcome.kind === "advance") {
    stores.log.append(outcome.record);
    stores.ledger.append({ kind: "step", record: outcome.record });
  }
  return { stepKey: stage, outcome };
}

// ---------------------------------------------------------------------------
// The channel-transition stage's application half (ADR-0012 decisions 3–6)
// ---------------------------------------------------------------------------

/** One decided channel move as the application drove it: the channel, the
 * store's outcome, and the prior target the store's own read observed (the
 * record's `from`). */
export interface AppliedChannelMove {
  readonly channelId: string;
  readonly from: ChannelState["target"];
  readonly outcome: ChannelApplyOutcome;
}

/** The application half of the `channel-transition` stage — the vertical's
 * stand-in for the application layer ADR-0012 decision 6 wires to the store
 * (invariant 2.1: the kernel never consumes the channel store; it names the
 * stage and the application executes the recorded plan's moves through it).
 *
 * The plan's `channel-move`s run in declaration order through the store's
 * compare-and-set: the move assumes the prior target the store's own read
 * observes — never a trusted `from` from the plan (ADR-0012 decision 2: the
 * plan names `to`, never `from`). `applied` proceeds; `noop` is the replay
 * case (the move already stands, ADR-0012 decision 4); `conflict` and
 * `ambiguous` fail loudly — a half-moved promotion is never reported green
 * (invariants 2.5/2.6). Every decided move appends one `channel-transition`
 * ledger record whose `contentFingerprint` is the store outcome's — the
 * record's idempotency key is what the store observed deciding, never what
 * the plan assumed (decision 4). A plan that names no moves records
 * nothing: the stage is byte-identical to its pre-V4 behavior for every
 * non-promoting run.
 *
 * The `promoted-from` edge and the stream close ride the same decision as
 * recorded plan content — they are line-level facts, independent of any
 * channel, and no store move exists for a channel that was never declared.
 */
export function applyPlannedChannelTransitions(application: {
  readonly attempt: ReleaseAttempt;
  readonly planLine: PlanLine;
  /** The held claim token the stage's guards verified — carried like every
   * mutating record (§2.9). */
  readonly claim?: string;
  readonly channels: ChannelStore;
  readonly ledger: ExecutionLedger;
}): readonly AppliedChannelMove[] {
  const moves = (application.planLine.channels ?? []).filter(
    (planned): planned is PlannedChannelMove => planned.kind === "channel-move",
  );
  const applied: AppliedChannelMove[] = [];
  for (const move of moves) {
    const observed = application.channels.read(move.channelId);
    const to = { line: move.to.line, version: move.to.version };
    const outcome = application.channels.applyTransition({
      channelId: move.channelId,
      from: observed.target,
      to,
    });
    if (outcome.kind === "conflict") {
      throw new Error(
        `the channel store refused the planned move of ${JSON.stringify(move.channelId)}: the ` +
          `observed prior target ${JSON.stringify(outcome.observed)} matches neither the move's ` +
          `prior nor its target — a divergent promotion fails closed (invariant 2.5)`,
      );
    }
    if (outcome.kind === "ambiguous") {
      throw new Error(
        `the channel store cannot determine whether the move of ${JSON.stringify(move.channelId)} ` +
          `landed: ${outcome.detail} — the promotion does not race forward on uncertainty ` +
          `(invariant 2.6, ADR-0012 decision 7)`,
      );
    }
    applied.push({ channelId: move.channelId, from: observed.target, outcome });
    application.ledger.append({
      kind: "channel-transition",
      record: {
        attemptId: application.attempt.attemptId,
        stepKey: "channel-transition",
        channelId: move.channelId,
        from: observed.target,
        to,
        attribution: actor(application.attempt),
        guards: [{ guard: "claim-held", passed: true }],
        ...(application.claim === undefined ? {} : { claim: application.claim }),
        contentFingerprint: outcome.contentFingerprint,
      },
    });
  }
  return applied;
}

/** The deterministic effects: each observation carries the postcondition
 * proofs the declaration demands. */
export function artifactProducers(): ReadonlyMap<string, ArtifactProducer> {
  const digestFor = (id: string): string => `digest:${id}`;
  return new Map(
    matrixArtifacts().map((declared) => [
      declared.id,
      (input) => ({
        attribution: { attemptId: input.attemptId, actor: "automation" },
        digest: digestFor(input.artifactId),
        ...(declared.postconditions.includes("evidence-present")
          ? { evidence: `evidence:${input.artifactId}` }
          : {}),
      }),
    ]),
  );
}

export interface HookEffectSpec {
  /** The proofs the observation carries — a missing demanded proof is the
   * hook's refusal and the attempt's block (§2.5). */
  readonly evidence?: string;
  readonly contentFingerprint?: string;
}

export function hookEffects(
  specs: Readonly<Record<string, HookEffectSpec | undefined>>,
): ReadonlyMap<string, HookEffect> {
  return new Map(
    Object.entries(specs).map(([id, spec]) => [
      id,
      (input) => ({
        attribution: { attemptId: input.attemptId, actor: "automation" },
        ...(spec?.evidence === undefined ? {} : { evidence: spec.evidence }),
        ...(spec?.contentFingerprint === undefined
          ? {}
          : { contentFingerprint: spec.contentFingerprint }),
      }),
    ]),
  );
}

// ---------------------------------------------------------------------------
// The run driver — one release through the whole kernel
// ---------------------------------------------------------------------------

export interface RunOptions {
  readonly world: LiveWorld;
  readonly lineId: string;
  readonly intents: readonly OperatorIntent[];
  readonly hooks?: readonly HookStep[];
  readonly artifacts?: readonly ArtifactStep[];
  readonly hookEffects?: ReadonlyMap<string, HookEffect>;
  readonly producers?: ReadonlyMap<string, ArtifactProducer>;
  /** When set, the driver stops right after the write-ahead start of this
   * canonical stage — the crash window (E-01), unclassified. */
  readonly crashAfterStartOf?: StepKey;
  /** When set, the driver stops right after the write-ahead start of this
   * extension step at its own anchor boundary, before its scheduler runs —
   * the extension crash window. The driver writes the write-ahead itself,
   * exactly as the scheduler would have. */
  readonly crashAfterStartOfExtension?: {
    readonly stepKey: StepKey;
    readonly stage: StepKey;
    readonly position: "before" | "after";
  };
}

export interface RunResult {
  readonly stores: Stores;
  readonly attempt: ReleaseAttempt;
  readonly assembled: ReleasePlan;
  readonly planLine: PlanLine;
  readonly token: string;
  readonly scope: ClaimScope;
  /** The minted tag this run recorded into the world — set only when the
   * run completed and the caller asked the world to observe it. */
  readonly mintedTag: string | null;
  readonly drives: readonly StepDrive[];
  /** The canonical stage the walk stopped before — null when it completed. */
  readonly stoppedAt: StepKey | null;
}

/** The walk's mutable attempt cell — schedulers and stages return the
 * successor attempt, and the walk carries it forward. `token` is the held
 * claim the run acquired; the channel-transition application carries it on
 * its records (optional: a resume rebuilt without it still walks — no run
 * that plans moves resumes without it in these suites). */
export interface WalkContext {
  stores: Stores;
  attempt: ReleaseAttempt;
  planLine: PlanLine;
  token?: string;
  hooks?: readonly HookStep[];
  artifacts?: readonly ArtifactStep[];
  hookEffects?: ReadonlyMap<string, HookEffect>;
  producers?: ReadonlyMap<string, ArtifactProducer>;
}

/** Classification verdicts name canonical or extension steps — never any
 * other shape through this fixture. */
const isExtension = (key: StepKey): boolean =>
  key.startsWith("hook:") || key.startsWith("artifact:");

/** The anchor stage a declared extension step hangs from — the verdict's
 * entry point back into the walk. */
const anchorStage = (ctx: WalkContext, key: StepKey): StepKey => {
  const declared =
    (ctx.hooks ?? []).find((hook) => `hook:${hook.id}` === key) ??
    (ctx.artifacts ?? []).find((step) => `artifact:${step.id}` === key);
  if (declared === undefined) {
    throw new Error(`fixture broken: the resume verdict names undeclared step ${key}`);
  }
  return declared.anchor.stage;
};

/** The walk's live state, re-read after every boundary: the schedulers
 * inside boundary() replace the attempt value (blocked on a §2.5 refusal),
 * and flow analysis cannot see the mutation through the call. */
const liveState = (ctx: WalkContext): ReleaseAttempt["state"] => ctx.attempt.state;

const boundary = (
  ctx: WalkContext,
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
    // The extension crash window: the write-ahead start the scheduler would
    // write is exactly what lands before the effect — the driver writes it
    // and dies there, before the scheduler may walk (§2.4, E-01).
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
  if (hooksHere.length > 0 && ctx.hookEffects !== undefined && ctx.attempt.state === "executing") {
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
  if (
    artifactsHere.length > 0 &&
    ctx.producers !== undefined &&
    ctx.attempt.state === "executing"
  ) {
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

/** The canonical walk from `from` — the run driver's loop, exported so the
 * crash windows can resume the very attempt that stopped. `skipStartFor`
 * re-runs a stage whose write-ahead start is already durable (E-02: the
 * effect and its completion land, the start never re-appends). */
export function walkStages(
  ctx: WalkContext,
  from: StepKey,
  opts: RunOptions,
  drives: StepDrive[],
  skipStartFor?: StepKey,
): StepKey | null {
  // `from` is a classification verdict — a canonical stage or an extension
  // step, whose anchor stage is the walk's re-entry point (§2.3). The
  // walkStages caller re-runs that stage; the ledger projection answers the
  // completed steps (never a re-execution, E-02), and `skipStartFor` names a
  // canonical stage whose write-ahead start is already durable.
  const entry = (
    isExtension(from) ? anchorStage(ctx, from) : from
  ) as (typeof CANONICAL_STAGES)[number];
  const startIndex = CANONICAL_STAGES.indexOf(entry);
  if (startIndex < 0) {
    throw new Error(
      `fixture broken: ${from} is not a canonical stage or a declared extension step`,
    );
  }
  for (const stage of CANONICAL_STAGES.slice(startIndex)) {
    if (boundary(ctx, stage, "before", opts.crashAfterStartOfExtension)) {
      return stage;
    }
    if (liveState(ctx) !== "executing") {
      // The boundary suspended the attempt (a hook's §2.5 refusal blocks) —
      // the walk stops in order; nothing further appends.
      return stage;
    }
    // The plan-recorded hold, named as such (#269): the fixture drive
    // records the same derivation the boundary's walk records — the two
    // are proven equal record for record, never asserted equal.
    const preconditions =
      stage === "validate"
        ? ctx.planLine.preconditions.map((row) => ({
            precondition: JSON.stringify(row),
            holds: true,
            derivation: "plan-recorded" as const,
          }))
        : undefined;
    if (stage !== skipStartFor) {
      const fingerprint = stageContentFingerprint(stage, ctx.planLine);
      ctx.stores.ledger.appendStart(ctx.attempt, stage, actor(ctx.attempt), fingerprint);
    }
    if (opts.crashAfterStartOf === stage) {
      // The crash window: the write-ahead start is durable, the effect and
      // its completion never happened (E-01/E-02) — the driver dies here.
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
    const drive = driveStage(ctx.attempt, stage, ctx.stores, ctx.planLine, preconditions);
    drives.push(drive);
    if (drive.outcome.kind !== "advance") {
      // E-02's replay: re-running a stage whose write-ahead start is
      // already durable replays `noop` for its recorded completion — the
      // walk continues past it. Any other non-advance outcome stops the walk.
      if (drive.outcome.kind !== "noop" || stage !== skipStartFor) {
        return stage;
      }
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

/** Drives one release attempt end to end through the public doors. The
 * caller decides whether the world observes the mint — staging runs
 * complete on world copies and never touch the shared world. */
export function runRelease(opts: RunOptions, observeWorld = true): RunResult {
  const outcome = plannedOf(plan(runInput(opts.world, opts.lineId, opts.intents)));
  const assembled = outcome.plan;
  const planLine = planLineFor(assembled, opts.lineId);
  const stores = freshStores();
  const attempt0 = openAttempt(
    stores.register,
    { planId: assembled.planId, planFingerprint: assembled.planId },
    opts.hooks,
    opts.artifacts,
  );
  const ctx: WalkContext = {
    stores,
    attempt: start(attempt0),
    planLine,
    ...(opts.hooks === undefined ? {} : { hooks: opts.hooks }),
    ...(opts.artifacts === undefined ? {} : { artifacts: opts.artifacts }),
    ...(opts.hookEffects === undefined ? {} : { hookEffects: opts.hookEffects }),
    ...(opts.producers === undefined ? {} : { producers: opts.producers }),
  };
  const scope = scopeFor(assembled, opts.lineId);
  const settled = stores.claims.acquire(scope, ctx.attempt.attemptId);
  const token = asClaim(settled).token;
  ctx.token = token;
  const drives: StepDrive[] = [];
  const stoppedAt = walkStages(ctx, "plan", opts, drives);
  let attempt = ctx.attempt;
  let mintedTag: string | null = null;
  if (stoppedAt === null) {
    attempt = transition(attempt, "published");
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
  return { stores, attempt, assembled, planLine, token, scope, mintedTag, drives, stoppedAt };
}

/** A world copy for staging runs — same recorded state, no shared arrays. */
export function copyWorld(world: World): LiveWorld {
  return {
    commits: world.commits,
    refs: world.refs,
    tags: world.tags.map((tag) => ({ ...tag })),
  };
}
