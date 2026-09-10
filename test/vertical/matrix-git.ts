/**
 * Slice 10.4 — the git-backed vertical fixture (contract
 * docs/design/phase10-vertical-matrix-contract.md §4 "10.4").
 *
 * The binding's real persistence under the full matrix: the ledger, the
 * attempt register, and the claim register are the binding's recorded refs,
 * and the matrix reads back through the binding's read doors only. Every
 * door the 10.2/10.3 fixture drove on memory stores is driven here on a real,
 * hermetic git repository (withTempRepo): the planner still consumes the §3
 * declared world (matrix.ts's recorded inputs), and the binding's refs — the
 * per-attempt ledger streams, the per-plan ordinal counters, the per-line
 * claim registers, and the minted tags — are exactly the recorded state the
 * assertions read back.
 *
 * Between runs nothing lives in process memory: the recorded tail persists in
 * the repository, and a resume classifies through `classifyResume` over the
 * RELOADED git tail and dispatches through `ledgerRequestStep` — no step
 * recomputes, a completed step replays `noop`/`conflict` over fingerprints
 * (E-02), and every §3.6 crash window's resume classification-matches the
 * uninterrupted run's.
 *
 * The concurrency rows drive the ADR-0011 hostile harness (claim-register
 * the PATH-shim pattern) inside the `claim` stages — GitClaimStore opens its
 * own runner, so the interception seam is a `git` on PATH whose shim
 * diverges the register between an attempt's read and its CAS, or kills
 * mid-write (the crash window pinning the register at a consistent tip).
 *
 * Every golden is the matrix.ts recorded data consumed verbatim — no fixture
 * computes. No clock, no environment, no randomness (§5).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CANONICAL_STAGES,
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
  type ClaimStore,
  type ClaimView,
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
} from "@ecoma-io/release-craft/__internal__/planner/types.js";
import {
  GitAttemptRegister,
  GitClaimStore,
  GitLedger,
  claimRegisterRefFor,
  commitRecord,
  openGitBinding,
  openGitRun,
  readRef,
  type GitRun,
  type GitTagNaming,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import {
  actor,
  applyPlannedChannelTransitions,
  GOLDEN,
  artifactProducers,
  hookEffects,
  matrixArtifacts,
  matrixChannels,
  matrixHooks,
  planLineFor,
  plannedOf,
  runInput,
  standingChannelStates,
} from "./matrix.js";
import type { LiveWorld } from "./matrix.js";

export { GOLDEN, matrixChannels, standingChannelStates };

// ---------------------------------------------------------------------------
// The repository seeding — the real refs the mint door targets
// ---------------------------------------------------------------------------

/** One real empty commit per matrix line head, deterministic under the
 * runner's fixed identity and clock (COMMIT_ENV). The mint door resolves its
 * target to a commit oid (`rev-parse <target>^{commit}`), so the matrix's
 * mints need a real object to point at — never the fake-sha world. Seeded
 * identically on every fresh repo, so tag refs come out byte-equal. */
export const seedLineHeads = (git: GitRun): Record<string, string> => {
  const outside: Record<string, string> = {};
  for (const lineId of ["main", "4.8.x", "3.x", "2.x", "1.9-lts"]) {
    const blob = git(["hash-object", "-w", "--stdin"], `line ${lineId} head\n`).trim();
    const tree = git(["mktree"], `100644 blob ${blob}\trecord\n`).trim();
    const commit = git(["commit-tree", tree, "-m", `ecoma: ${lineId} head`]).trim();
    git(["update-ref", `refs/heads/${lineId}`, commit]);
    outside[lineId] = commit;
  }
  return outside;
};

// ---------------------------------------------------------------------------
// The binding and naming — the §3 scopes map onto the matrix's version strings
// ---------------------------------------------------------------------------

/** Re-exported so a caller may open a FRESH binding over the same repository
 * (a restarted process — nothing process-local survives) without reaching
 * past the adapter barrel from a boundary test (§5 obligation 7). */
export { openGitBinding };

/** The tag naming the matrix's scopes derive (values exactly the matrix
 * version strings, no prefix): a prerelease sequence mints
 * `<target>-<streamId>.<sequence>` (`5.0.0-beta.1`), a stable version mints
 * the version itself (`5.0.0`). The matrix's scopes are only these two kinds,
 * so the binding's namespace wrapper denies nothing. */
export const naming: GitTagNaming = {
  namespaces: [""],
  tagFor: (scope: ClaimScope): string | null =>
    scope.kind === "prerelease-sequence"
      ? `${scope.target}-${scope.streamId}.${String(scope.sequence)}`
      : scope.kind === "stable-version"
        ? scope.version
        : null,
};

/** The claim scope a run's decision demands, in the shape the binding's
 * naming reproduces the plan's minted tag from. The memory fixture's
 * `scopeFor` derives the prerelease `target` from the stream's `pointerBase`
 * — the pointer the stream runs toward, which is the OLD released version
 * (`4.9.2`), not the tag the mint door would create. The git binding derives
 * the tag name from the scope alone, so this fixture derives the scope from
 * the plan's OWN version: the minted tag's base is the version up to its
 * first `-` (for `5.0.0-beta.1` that base is `5.0.0`), and the sequence is
 * read off the version's `-<stream>.<n>` suffix. This is a fixture-local
 * mapping — the planner's `Version` renders the exact string the mint door
 * must reproduce, so the naming produces the plan's own tag, never a
 * computed golden (contract §2/§3). */
export const claimScopeFor = (planLine: PlanLine): ClaimScope => {
  const stream = planLine.streams[0];
  if (stream !== undefined) {
    const rendered = stream.version.toString();
    const dash = rendered.indexOf("-");
    const base = dash < 0 ? rendered : rendered.slice(0, dash);
    const suffix = dash < 0 ? "" : rendered.slice(dash + 1);
    const sequence = Number.parseInt(suffix.split(".")[1] ?? "0", 10);
    return {
      kind: "prerelease-sequence",
      lineId: planLine.lineId,
      target: base,
      streamId: stream.identifier,
      sequence,
    };
  }
  if (planLine.stable === null) {
    throw new Error(`fixture broken: line ${planLine.lineId} plans no release to claim`);
  }
  return { kind: "stable-version", lineId: planLine.lineId, version: planLine.stable.version };
};

/** The binding feature 10.4 drives through: the three ports plus the mint
 * door and the read doors, all on one repository. */
export interface GitState {
  readonly repo: string;
  readonly binding: ReturnType<typeof openGitBinding>;
  readonly git: GitRun;
  /** The per-line head oids the mint door targets (§4: "reads back through
   * the binding's read doors only" — the target is supplied by the
   * assembly, never chosen by the binding). */
  readonly lineHeads: Record<string, string>;
}

/** Zero-config (§5): the stores construct from a repository path alone. */
export function openGitState(repo: string): GitState {
  const git = openGitRun(repo);
  const binding = openGitBinding({ repo, tagNaming: naming });
  const lineHeads = seedLineHeads(git);
  // §3.1's standing channels are RECORDED into the repository the same way
  // the store itself records them — the CAS moves each channel out of the
  // hidden state, never a hand-written ref (ADR-0012 decision 6). A fresh
  // repository's channels all read hidden, so every move applies.
  for (const channel of standingChannelStates()) {
    const outcome = binding.channels.applyTransition({
      channelId: channel.id,
      from: null,
      to: { line: channel.target.line, version: channel.target.version },
    });
    if (outcome.kind !== "applied") {
      throw new Error(
        `fixture broken: seeding channel ${channel.id} got ${outcome.kind} — a fresh repository's channels are hidden`,
      );
    }
  }
  return { repo, binding, git, lineHeads };
}

/** The port's claims — the binding's wrapper (already namespace-gated). */
export const claimsOf = (state: GitState): ClaimStore => state.binding.claims;

// ---------------------------------------------------------------------------
// The claim view — the one git store's seam (ClaimView is injected, §2.7)
// ---------------------------------------------------------------------------

/** The claim view `requestStep`/`ledgerRequestStep`/schedulers consume
 * (§2.7): the attempt's held claim plus a current-state token re-verification.
 * `GitClaimStore` has no `viewFor` (that is MemoryClaimStore-only), so the
 * fixture derives the view from the git store — injected, never ambient. */
export const claimView = (state: GitState, attemptId: string): ClaimView => {
  const claim = allClaimRecordsOf(state).find((record) => record.holder === attemptId) ?? null;
  return {
    held:
      claim === null
        ? null
        : { kind: "claim", scope: claim.scope, token: claim.token, holder: claim.holder },
    verify: (token): boolean => {
      const verification = state.binding.claims.verify(token);
      return verification.kind === "held" && verification.claim.holder === attemptId;
    },
  };
};

/** Every claim record the repository holds (the all-register walk, ADR-0011
 * decision 3's read exception the tag door and these reads share). */
export const allClaimRecordsOf = (state: GitState): readonly ClaimRecordOf[] => {
  const { git } = state;
  return git(["for-each-ref", "--format=%(refname)", "refs/release-craft/claims/"])
    .split("\n")
    .filter((line) => line.length > 0)
    .flatMap((ref) => readClaimsAt(state, ref) ?? []);
};

type ClaimRecordOf = { scope: ClaimScope; token: string; holder: string };

/** The claim register a ref holds (the per-line register envelope), or null
 * when the ref is absent. Reads back through the binding's read door only —
 * a blob that is not a register refuses loudly (ADR-0011 decision 5). */
export const readClaimsAt = (state: GitState, ref: string): readonly ClaimRecordOf[] | null => {
  const tip = readRef(state.git, ref);
  if (tip === null) {
    return null;
  }
  const envelope: unknown = JSON.parse(commitRecord(state.git, tip)) as unknown;
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    !("claims" in envelope) ||
    !Array.isArray(envelope.claims)
  ) {
    throw new TypeError(
      `the claim namespace pins register envelopes ({"claims":[…]}); ${ref} does not`,
    );
  }
  return (envelope.claims as unknown[]).map((record) => record as ClaimRecordOf);
};

// ---------------------------------------------------------------------------
// The stores — the git-backed attempt register, ledger, and claim store
// ---------------------------------------------------------------------------

export interface GitStores {
  readonly register: GitAttemptRegister;
  readonly ledger: GitLedger;
  readonly claims: GitClaimStore;
  /** The persisted attempt map — durable-store state keyed by planId,
   * carried across calls, exactly as 10.3's fixture carries it. A plan's
   * first run allocates its attempt (that plan's ordinal 1, ADR-0011's
   * per-line register); a resume continues the SAME logical attempt
   * (§2.1's content-anchored identity, V2); a NEW plan (the next ladder
   * run on a grown world) allocates fresh. */
  readonly attempts: ReadonlyMap<string, ReleaseAttempt>;
  /** Re-arm door: the driver stashes a re-armed successor attempt. */
  rearm(attempt: ReleaseAttempt): void;
}

/** Constructs the three git stores from a repository path, zero-config, each
 * time with a fresh attempt map. A caller that resumes across calls passes
 * the SAME `GitStores` value (its map persists). */
export function gitStores(repo: string): GitStores {
  const git = openGitRun(repo);
  const attempts = new Map<string, ReleaseAttempt>();
  return {
    register: new GitAttemptRegister(git),
    ledger: new GitLedger(git),
    claims: new GitClaimStore(repo),
    attempts,
    rearm: (attempt) => {
      attempts.set(attempt.planId, attempt);
    },
  };
}

// ---------------------------------------------------------------------------
// The byte read doors — tail, register blob, refs
// ---------------------------------------------------------------------------

/** The byte identity of a git ledger tail, record by record — the V6
 * assertion over the binding's read door (contract §7: "persisted tails
 * compare byte-exact"). A `GitLedger` tail deep-freezes on reload; this is a
 * deterministic canonical rendering so "reads back byte-identical" is
 * asserted, not assumed. */
export const tailBytes = (ledger: GitLedger, attemptId: string): readonly string[] =>
  ledger.tail(attemptId).map((record) => JSON.stringify(record));

/** The register blob for a line — the claim register's canonical bytes
 * (ADR-0011 decision 5's loud refusal on foreign layouts). */
export const registerBlob = (git: GitRun, lineId: string): string =>
  commitRecord(git, readRef(git, claimRegisterRefFor(lineId)) ?? "");

/** The recorded tags the binding's refs door enumerates (only minted
 *  tags — the fixture's historical tags are never made real refs). */
export const recordedTags = (git: GitRun, namespaces: readonly string[]): readonly string[] => {
  const prefix = namespaces.some((root) => root === "") ? "refs/tags/" : "refs/tags/";
  // filter within each declared namespace root; with [""], every tag.
  return git(["for-each-ref", "--format=%(refname)", prefix])
    .split("\n")
    .filter((line) => line.startsWith("refs/tags/") && line.length > 0)
    .map((ref) => ref.slice("refs/tags/".length))
    .sort();
};

// ---------------------------------------------------------------------------
// The run driver — one release through the git doors
// ---------------------------------------------------------------------------

export interface Declarations {
  readonly hooks?: readonly HookStep[];
  readonly artifacts?: readonly ArtifactStep[];
  readonly hookEffects?: ReadonlyMap<string, HookEffect>;
  readonly producers?: ReadonlyMap<string, ArtifactProducer>;
}

/** The always-succeeding declaration the git run carries: §3.5's succeeding
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
  readonly state: GitState;
  readonly stores: GitStores;
  readonly world: LiveWorld;
  readonly lineId: string;
  readonly intents: readonly OperatorIntent[];
  readonly declarations?: Declarations;
  /** When set, the driver stops right after the write-ahead start of this
   * canonical stage (E-01) — the walk never runs the effect, but the start
   * IS a durable git commit (the record tail write-ahead). */
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
   * NON-terminal attempt. */
  readonly terminalize?: boolean;
}

export interface RunResult {
  readonly stores: GitStores;
  readonly attempt: ReleaseAttempt;
  readonly planLine: PlanLine;
  readonly scope: ClaimScope;
  readonly token: string;
  readonly mintedTag: string | null;
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
  state: GitState;
  stores: GitStores;
  hooks?: readonly HookStep[];
  artifacts?: readonly ArtifactStep[];
  hookEffects?: ReadonlyMap<string, HookEffect>;
  producers?: ReadonlyMap<string, ArtifactProducer>;
  /** The claim token the run acquired — carried for the mint door after the
   * walk completes. Cleared when the run stopped before any acquisition. */
  token: string;
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
 * and after it. All writes go through the git ledger; the claim view is the
 * git store's derived view. */
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
    // would write lands before the effect — a durable git commit — and the
    // driver dies there, before the scheduler may walk.
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
      claimView(ctx.state, ctx.attempt.attemptId),
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
      claimView(ctx.state, ctx.attempt.attemptId),
      ctx.producers,
    );
    ctx.attempt = run.attempt;
  }
  return false;
};

/** The replay walk from `from` — the resume verdict's entry stage. Every
 * step request dispatches through `ledgerRequestStep` (the §2.8 record-path
 * replay door) with the git-derived claim view; the ledger is the git
 * ledger, so every write-ahead start and completion is a durable git
 * commit. E-02's replay semantics: a completed step replays `noop` over a
 * matching content fingerprint (the walk continues past it) — never a
 * re-execution — and a mismatched fingerprint is a recorded `conflict`. */
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
      // through the binding's channel store here; the kernel's completion
      // appends below. A plan that names no moves records nothing.
      applyPlannedChannelTransitions({
        attempt: ctx.attempt,
        planLine: ctx.planLine,
        ...(ctx.token === "" ? {} : { claim: ctx.token }),
        channels: ctx.state.binding.channels,
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
      claimView(ctx.state, ctx.attempt.attemptId),
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

/** Drives one release through the git doors over the caller's persisted
 * state. The stores (git register/ledger/claims + the persisted attempt
 * map) are carried on the repo; calls are re-entrant, so a resume for the
 * same plan continues the SAME attempt over the recorded tail. The caller
 * decides whether the world observes the mint. */
export function runGitRelease(opts: RunOptions, observeWorld = true): RunResult {
  const outcome: PlanningOutcome = plannedOf(plan(runInput(opts.world, opts.lineId, opts.intents)));
  const assembled = outcome.plan;
  const planLine = planLineFor(assembled, opts.lineId);
  const { state, stores } = opts;
  // Did the stores carry THIS plan before this call (a resume over the
  // recorded tail), or is this call the plan's first run (a ladder run on a
  // grown world re-plans to a new planId)? Checked BEFORE the attempt is
  // armed into the stores — a post-call check would always read "carried".
  const alreadyRan = stores.attempts.has(assembled.planId);
  const carried = stores.attempts.get(assembled.planId);
  const attempt: ReleaseAttempt =
    carried !== undefined
      ? carried
      : start(
          openAttempt(
            stores.register,
            { planId: assembled.planId, planFingerprint: assembled.planId },
            opts.declarations?.hooks,
            opts.declarations?.artifacts,
          ),
        );
  const ctx: Ctx = {
    attempt,
    planLine,
    state,
    stores,
    token: "",
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
  if (carried === undefined) {
    stores.rearm(ctx.attempt);
  }
  const scope = claimScopeFor(planLine);
  const settled = stores.claims.acquire(scope, ctx.attempt.attemptId);
  if (settled.kind !== "claim") {
    throw new Error(
      `fixture broken: the claim store denied ${ctx.attempt.attemptId} — the replay owns the scope`,
    );
  }
  ctx.token = settled.token;
  const drives: RunResult["drives"] = [];
  // Resume over the recorded tail (§2.3): a run whose stores already carry
  // this plan's attempt continues from the classification's `from` — the
  // first effective step the ledger does not record completed — re-running
  // only that step (its write-ahead start is already a durable git commit).
  // A fresh plan starts from `plan` as usual.
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
  let finalAttempt = ctx.attempt;
  let mintedTag: string | null = null;
  const terminalize = opts.terminalize ?? true;
  if (stoppedAt === null && terminalize) {
    finalAttempt = transition(ctx.attempt, "published");
    stores.rearm(finalAttempt);
    const minted = planLine.streams[0]?.tag ?? planLine.stable?.tag ?? null;
    if (minted !== null) {
      const target = state.lineHeads[opts.lineId];
      if (target === undefined) {
        throw new Error(`fixture broken: no seeded head for line ${opts.lineId}`);
      }
      const result = state.binding.mintTag({
        attemptId: ctx.attempt.attemptId,
        token: ctx.token,
        tag: minted,
        target,
      });
      if (result.kind !== "minted") {
        throw new Error(`fixture broken: the mint refused ${minted}: ${result.detail}`);
      }
      mintedTag = result.tag;
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
    attempt: finalAttempt,
    planLine,
    scope,
    token: ctx.token,
    mintedTag,
    drives,
    stoppedAt,
  };
}

// ---------------------------------------------------------------------------
// The hostile-git harness (ADR-0011's pattern, reused per-slice) — a `git`
// PATH shim that intercepts one step of a store's claim cycle and, before
// delegating, makes one divergent move of its own — the concurrent writer's
// landing — or dies mid-write (the crash window). GitClaimStore opens its
// own runner, so the interception seam is the PATH shim, exactly as
// claim-register.test.ts establishes.
// ---------------------------------------------------------------------------

export interface Shim {
  readonly dir: string;
  arm(): void;
  fired(): boolean;
  cleanup(): void;
}

export const buildShim = (spec: {
  readonly registerRef: string;
  readonly payload?: string;
  readonly mode: "diverge" | "crash";
  readonly fireOnRead?: number;
}): Shim => {
  const dir = mkdtempSync(join(tmpdir(), "release-craft-git-hostile-"));
  const found = spawnSync("which", ["git"], { encoding: "utf8" });
  const real = found.stdout.trim();
  if (real === "") {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`the fixture needs a real git to delegate to: ${found.stderr}`);
  }
  const armed = join(dir, "armed");
  const flag = join(dir, "fired");
  const counter = join(dir, "reads");
  const payload = join(dir, "payload.json");
  if (spec.payload !== undefined) {
    writeFileSync(payload, spec.payload);
  }
  const diverge =
    spec.mode === "diverge" && spec.payload !== undefined
      ? [
          `BLOB=$(cat "${payload}" | "${real}" hash-object -w --stdin)`,
          `TREE=$(printf '100644 blob %s\\trecord\\n' "$BLOB" | "${real}" mktree)`,
          `COMMIT=$("${real}" commit-tree "$TREE" -m "release-craft: append")`,
          `"${real}" update-ref "${spec.registerRef}" "$COMMIT" || exit 1`,
        ].join("\n")
      : "kill -9 $$";
  const intercept =
    spec.fireOnRead === undefined
      ? [
          `if [ "$1" = "update-ref" ] && [ "$2" = "${spec.registerRef}" ] && [ -e "${armed}" ] && [ ! -e "${flag}" ]; then`,
          `  touch "${flag}"`,
          diverge,
          "fi",
        ]
      : [
          `if [ "$1" = "rev-parse" ] && [ "$4" = "${spec.registerRef}" ] && [ -e "${armed}" ] && [ ! -e "${flag}" ]; then`,
          `  N=$(cat "${counter}" 2>/dev/null || echo 0)`,
          `  N=$((N+1))`,
          `  echo "$N" > "${counter}"`,
          `  if [ "$N" -ge ${String(spec.fireOnRead)} ]; then`,
          `    touch "${flag}"`,
          diverge
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n"),
          "  fi",
          "fi",
        ];
  const script = ["#!/bin/sh", ...intercept, `exec "${real}" "$@"`, ""].join("\n");
  const shim = join(dir, "git");
  writeFileSync(shim, script);
  chmodSync(shim, 0o755);
  return {
    dir,
    arm: () => {
      writeFileSync(armed, "");
    },
    fired: () => existsSync(flag),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

/** Runs `fn` with the shim first on PATH — every `git` the store spawns in
 * there resolves through it. Restored whether `fn` passes or fails. */
export const withHostilePath = (dir: string, fn: () => void): void => {
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous ?? ""}`;
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previous;
    }
  }
};

// ---------------------------------------------------------------------------
// The reference run — every window's resume must classification-match it
// ---------------------------------------------------------------------------

export interface RunResultOf {
  readonly stores: GitStores;
  readonly attempt: ReleaseAttempt;
  readonly planLine: PlanLine;
  readonly scope: ClaimScope;
  readonly token: string;
  readonly mintedTag: string | null;
  readonly drives: readonly {
    readonly stepKey: StepKey;
    readonly outcome: ReturnType<typeof ledgerRequestStep>;
  }[];
  readonly stoppedAt: StepKey | null;
}

/** The reference run every window's resume must classification-match: the
 * same declarations, no interruption, on its own repo/state. The persisted-tail
 * equality half of §6 recovery. Shares the state's binding and repo — a
 * reference is a second run over the same recorded state, never a fresh
 * unbounded binding. */
export function gitReference(state: GitState, opts: RunOptions): RunResultOf {
  const world = copyWorld(opts.world);
  return runGitRelease(
    {
      ...opts,
      state,
      world,
    },
    false,
  );
}

/** A world copy for staging runs — same recorded state, no shared arrays. */
export function copyWorld(world: LiveWorld): LiveWorld {
  return {
    commits: world.commits,
    refs: world.refs,
    tags: world.tags.map((tag) => ({ ...tag })),
  };
}
