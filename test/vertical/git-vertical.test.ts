/**
 * Slice 10.4 — the git-backed vertical (contract
 * docs/design/phase10-vertical-matrix-contract.md §4 "10.4"). The binding's
 * real persistence under the full matrix: the ledger, the attempt register,
 * and the claim register are the binding's recorded refs, and the matrix
 * reads back through the binding's read doors only. The deterministic
 * concurrency harness (ADR-0011's hostile-git pattern) drives two attempts
 * one move at a time inside the matrix's `claim` stages; the crash windows
 * kill mid-write and pin the register and the ledger at consistent tips on
 * either side. Double runs land identical recorded state (the fixed identity
 * and clock make them so) — with the one normalization the engine's own
 * determinism note demands: the claim tokens the git store allocates
 * (`randomBytes(32)`, claim-store-git.ts) are labelled in first-sighting
 * order, exactly as the dual-backend register transcript does, so the two
 * independent repositories' tails agree on every field but the random token.
 * Within one repository the reload is byte-exact.
 *
 * Every test name carries its §6 invariant row and the §3 step it proves.
 * The goldens come from the fixture module's hand-derived table, never from
 * a run (§2).
 */
import { describe, expect, it } from "vitest";

import { plan } from "@ecoma-io/release-craft/__internal__/planner/assemble.js";
import {
  CANONICAL_STAGES,
  channelStateFingerprint,
  classifyResume,
  ledgerRequestStep,
  openAttempt,
  start,
  type ChannelTransitionRecord,
  type Claim,
  type ClaimDenied,
  type ClaimScope,
} from "../../src/index.js";
import {
  GOLDEN,
  actor,
  applyPlannedChannelTransitions,
  artifactProducers,
  assertStoreChannelsStanding,
  copyWorld,
  hookEffects,
  liveWorld,
  matrixArtifacts,
  matrixHooks,
  plannedOf,
  runInput,
  snapshot,
} from "./matrix.js";
import { withTempRepo } from "../adapters/git/temp-repo.js";
import {
  GitClaimStore,
  claimRegisterRefFor,
  openGitBinding,
  readRef,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import {
  buildShim,
  claimView,
  gitStores,
  naming,
  openGitState,
  readClaimsAt,
  recordedTags,
  runGitRelease,
  tailBytes,
  withHostilePath,
  type Declarations,
  type GitState,
  type GitStores,
  type RunOptions,
} from "./matrix-git.js";

// ---------------------------------------------------------------------------
// Shared staging helpers — recorded declarations, no fixture computes
// ---------------------------------------------------------------------------

const beta = { kind: "prerelease", stream: "beta", lineId: "main" } as const;
const rc = { kind: "prerelease", stream: "rc", lineId: "main" } as const;
const promote = { kind: "promote", lineId: "main" } as const;

/** The always-succeeding declaration a run carries: all six §3.4 artifacts
 * plus §3.5's succeeding and resumed hooks, each with its proof. */
const fullDeclaration = (): Declarations => {
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

/** The completed step keys of a git run, append order. */
const completedKeys = (run: {
  stores: GitStores;
  attempt: { attemptId: string };
}): readonly string[] => {
  const keys: string[] = [];
  for (const record of run.stores.ledger.tail(run.attempt.attemptId)) {
    if (record.kind !== "step" || record.record.to !== "completed") {
      continue;
    }
    if (!keys.includes(record.record.stepKey)) {
      keys.push(record.record.stepKey);
    }
  }
  return keys;
};

const asDenied = (settled: Claim | ClaimDenied | undefined): ClaimDenied => {
  if (settled === undefined) {
    throw new Error(`fixture broken: the hostile acquire never settled`);
  }
  if (settled.kind !== "denied") {
    throw new Error(`fixture broken: expected a denial, got ${settled.kind}`);
  }
  return settled;
};

/** The claim register's records read back through the binding's read door. */
const claimsAtLine = (
  state: GitState,
  lineId: string,
): readonly { scope: ClaimScope; token: string; holder: string }[] =>
  readClaimsAt(state, claimRegisterRefFor(lineId)) ?? [];

/** The register's records with tokens labelled in first-sighting order — the
 * V6 value-equality assertion, since the git store allocates random tokens
 * (claim-store-git.ts's `randomBytes`) and the port promises behavior, not
 * token spelling. */
const normalizedClaims = (
  state: GitState,
  lineId: string,
): readonly { scope: ClaimScope; holder: string; token: string }[] => {
  const labels = new Map<string, string>();
  const records = claimsAtLine(state, lineId);
  return records.map((record) => {
    let label = labels.get(record.token);
    if (label === undefined) {
      label = `t${String(labels.size + 1)}`;
      labels.set(record.token, label);
    }
    return { scope: record.scope, holder: record.holder, token: label };
  });
};

/** The tail's records with the claim token labelled — the crossing-repos
 * determinism assertion. The engine records the store's token into every
 * completion of a claim-requiring stage (outcome.ts) — and, once the
 * application slice appends them, into every `channel-transition` record
 * (ADR-0012 decision 4) — and the git store allocates random tokens; a
 * reference run and a resumed run on their own repositories agree on every
 * field but that token. Both claim-carrying kinds are labelled here.
 * Built on the git read door, exactly as every other byte read here. */
const normalizedTail = (stores: GitStores, attemptId: string): readonly string[] => {
  const tokens = new Map<string, string>();
  const label = (token: string): string => {
    const seen = tokens.get(token);
    if (seen !== undefined) {
      return seen;
    }
    const fresh = `t${String(tokens.size + 1)}`;
    tokens.set(token, fresh);
    return fresh;
  };
  return stores.ledger.tail(attemptId).map((record) => {
    const payload =
      record.kind === "step" || record.kind === "channel-transition" ? record.record : undefined;
    if (payload === undefined || payload.claim === undefined) {
      return JSON.stringify(record);
    }
    return JSON.stringify({
      ...record,
      record: { ...payload, claim: label(payload.claim) },
    });
  });
};

// ---------------------------------------------------------------------------
// V1 — plan integrity, over the git ledger
// ---------------------------------------------------------------------------

describe("V1 — plan integrity, git-backed", () => {
  it("V1 · main beta run · the same inputs re-plan identically and the git-backed walk executes the planned sequence", () => {
    withTempRepo("v1-plan", (repo) => {
      const state = openGitState(repo);
      const stores = gitStores(repo);
      const world = liveWorld();
      const input = runInput(snapshot(world), "main", [beta]);
      const first = plannedOf(plan(input)).plan;
      const second = plannedOf(plan(input)).plan;
      expect(second.planId).toBe(first.planId);

      const run = runGitRelease({ state, stores, world, lineId: "main", intents: [beta] });
      expect(run.attempt.planId).toBe(first.planId);
      // The executed steps are exactly the planned canonical sequence — the
      // git ledger's completed records are the walk's own recorded output.
      expect(completedKeys(run)).toStrictEqual([...CANONICAL_STAGES]);
    });
  });

  it("V1 · main beta run · every completion records and verifies its content fingerprint (E-03)", () => {
    withTempRepo("v1-fingerprint", (repo) => {
      const state = openGitState(repo);
      const stores = gitStores(repo);
      const world = liveWorld();
      const run = runGitRelease({ state, stores, world, lineId: "main", intents: [beta] });
      for (const stage of CANONICAL_STAGES) {
        const fingerprint = `content:${stage}:${run.attempt.attemptId}`;
        const completion = run.stores.ledger.stepView().completed(run.attempt.attemptId, stage);
        if (completion === null) {
          throw new Error(`fixture broken: ${stage} never recorded a completion`);
        }
        expect(completion.contentFingerprint).toBe(fingerprint);
      }
      // The minted tag is recorded in the real repo through the binding's
      // mint door, and the read door enumerates it.
      expect(recordedTags(state.git, naming.namespaces)).toContain("5.0.0-beta.1");
    });
  });
});

// ---------------------------------------------------------------------------
// V2 — identity, over the git ledger
// ---------------------------------------------------------------------------

describe("V2 — identity, git-backed", () => {
  it(
    "V2 · commit-window · the identity is stable across the crash and its git-backed resume",
    // This window sits at the 20s global edge under the CI runner's
    // parallel-suite contention (observed 22.7s there) — the grouping
    // comment below covers its siblings; this one earns its own override.
    { timeout: 45_000 },
    () => {
      withTempRepo("v2-identity", (repo) => {
        const state = openGitState(repo);
        const stores = gitStores(repo);
        const world = liveWorld();
        const declaration = fullDeclaration();
        const base: RunOptions = {
          state,
          stores,
          world,
          lineId: "main",
          intents: [beta],
          declarations: declaration,
        };
        const stopped = runGitRelease({ ...base, crashAfterStartOf: "commit" }, false);
        if (stopped.stoppedAt !== "commit") {
          throw new Error(`fixture broken: the walk stopped at ${String(stopped.stoppedAt)}`);
        }
        // Resume over the SAME repo — a fresh binding reloads the recorded
        // tail and the identity is stable.
        const resumed = runGitRelease(base, false);
        expect(resumed.attempt.attemptId).toBe(stopped.attempt.attemptId);
        const tail = stopped.stores.ledger.tail(stopped.attempt.attemptId);
        for (const record of tail) {
          const holder =
            record.kind === "step" || record.kind === "channel-transition"
              ? record.record.attemptId
              : record.attemptId;
          expect(holder).toBe(stopped.attempt.attemptId);
        }
      });
    },
  );

  // V2/the four heavy multi-line walks mint five lines (five full plans,
  // claims, walks, mints) over real-git subprocesses, and the V7 windows
  // above sit right at the 20s global edge (vitest.config.ts) under the CI
  // runner's parallel-suite contention — so this grouping carries its own
  // timeout too. A hang still fails the gate; this only widens the room.
  it(
    "V2 · five lines · five lines' git-ledger runs never share an attempt",
    { timeout: 45_000 },
    () => {
      withTempRepo("v2-five-lines", (repo) => {
        const state = openGitState(repo);
        const stores = gitStores(repo);
        const world = liveWorld();
        const main = runGitRelease({ state, stores, world, lineId: "main", intents: [beta] });
        const sides = ["4.8.x", "3.x", "2.x", "1.9-lts"].map((lineId) =>
          runGitRelease({ state, stores, world, lineId, intents: [{ kind: "release" }] }),
        );
        const ids = [main, ...sides].map((run) => run.attempt.attemptId);
        expect(new Set(ids).size).toBe(5);
      });
    },
  );
});

// ---------------------------------------------------------------------------
// V3 — prerelease sequence, over the git ledger
// ---------------------------------------------------------------------------

describe("V3 — prerelease sequence, git-backed", () => {
  it("V3 · ladder runs 1–2 · beta.1 then beta.2, and only the beta stream moves", () => {
    withTempRepo("v3-ladder", (repo) => {
      const state = openGitState(repo);
      const stores = gitStores(repo);
      const world = liveWorld();
      const first = runGitRelease({ state, stores, world, lineId: "main", intents: [beta] });
      expect(first.mintedTag).toBe(GOLDEN.ladder[0]);
      expect(first.scope).toStrictEqual({
        kind: "prerelease-sequence",
        lineId: "main",
        target: "5.0.0",
        streamId: "beta",
        sequence: 1,
      });
      const second = runGitRelease({ state, stores, world, lineId: "main", intents: [beta] });
      expect(second.mintedTag).toBe(GOLDEN.ladder[1]);
      expect(second.scope).toStrictEqual({
        kind: "prerelease-sequence",
        lineId: "main",
        target: "5.0.0",
        streamId: "beta",
        sequence: 2,
      });
      // Only the demanded stream is in the plan: no other stream's number moved.
      expect(second.planLine.streams.map((stream) => stream.identifier)).toStrictEqual(["beta"]);
      // The two ladder tags are recorded in the real repo, in the right order.
      expect(recordedTags(state.git, naming.namespaces)).toStrictEqual([
        "5.0.0-beta.1",
        "5.0.0-beta.2",
      ]);
    });
  });

  it("V3 · ladder run 3 · the rc stream opens from its own key beside beta", () => {
    withTempRepo("v3-rc", (repo) => {
      const state = openGitState(repo);
      const stores = gitStores(repo);
      const world = liveWorld();
      runGitRelease({ state, stores, world, lineId: "main", intents: [beta] });
      runGitRelease({ state, stores, world, lineId: "main", intents: [beta] });
      const rcRun = runGitRelease({ state, stores, world, lineId: "main", intents: [rc] });
      expect(rcRun.mintedTag).toBe(GOLDEN.ladder[2]);
      expect(rcRun.scope).toStrictEqual({
        kind: "prerelease-sequence",
        lineId: "main",
        target: "5.0.0",
        streamId: "rc",
        sequence: 1,
      });
      expect(rcRun.planLine.streams.map((stream) => stream.identifier)).toStrictEqual(["rc"]);
    });
  });

  it("V3 · same-scope staging · the loser's denial carries the winner's sequence as its retry base (E-08)", () => {
    withTempRepo("v3-staging", (repo) => {
      const state = openGitState(repo);
      const stores = gitStores(repo);
      const world = liveWorld();
      runGitRelease({ state, stores, world, lineId: "main", intents: [beta] });
      // A aims at beta.2 through the shared git register and dies inside
      // claim — holding the stream's lease (the register keeps it, leases
      // persist).
      const base: RunOptions = { state, stores, world, lineId: "main", intents: [beta] };
      const a = runGitRelease({ ...base, crashAfterStartOf: "claim" }, false);
      expect(a.stoppedAt).toBe("claim");
      expect(a.scope).toStrictEqual({
        kind: "prerelease-sequence",
        lineId: "main",
        target: "5.0.0",
        streamId: "beta",
        sequence: 2,
      });
      // A second attempt of the SAME plan, through the same register, is a
      // distinct attempt — the git register allocates its ordinal.
      const attemptB = start(
        openAttempt(a.stores.register, {
          planId: a.attempt.planId,
          planFingerprint: a.attempt.planId,
        }),
      );
      expect(attemptB.attemptId).not.toBe(a.attempt.attemptId);
      // The exclusion law on the git register: the loser is denied, naming
      // the winner and carrying the winner's sequence (E-08).
      const denial = asDenied(a.stores.claims.acquire(a.scope, attemptB.attemptId));
      expect(denial.holder).toBe(a.attempt.attemptId);
      expect(denial.holderSequence).toBe(2);
      // The register reads back through the binding: the ladder's beta.1
      // lease AND A's beta.2 lease — leases persist (sorted by scope).
      const held = claimsAtLine(state, "main");
      expect(held).toHaveLength(2);
      expect(held[0]?.scope).toStrictEqual({
        kind: "prerelease-sequence",
        lineId: "main",
        target: "5.0.0",
        streamId: "beta",
        sequence: 1,
      });
      expect(held[1]?.holder).toBe(a.attempt.attemptId);
      expect(held[1]?.scope).toStrictEqual(a.scope);
    });
  });
});

// ---------------------------------------------------------------------------
// V4 — promotion, over the git ledger
// ---------------------------------------------------------------------------

describe("V4 — promotion, git-backed", () => {
  // Headroom, not a hang mask: the git V4 writes four real ref
  // transactions (two channel moves plus two noop-replay appends) on top of
  // the ladder's four runs — under full-suite parallel load it can brush the
  // default timeout, and the brief sanctions explicit headroom for genuinely
  // slow git-window tests.
  it(
    "V4 · ladder run 4 · the promote run moves the planned channels into recorded refs and a fresh binding reloads them",
    { timeout: 40_000 },
    () => {
      withTempRepo("v4-promote", (repo) => {
        const state = openGitState(repo);
        const stores = gitStores(repo);
        const world = liveWorld();
        // The standing channels are RECORDED refs (the fixture seeded them
        // through the binding's own CAS, never a hand-written ref) — the
        // binding's read door proves them before any run.
        assertStoreChannelsStanding(state.binding.channels);
        runGitRelease({ state, stores, world, lineId: "main", intents: [beta] });
        runGitRelease({ state, stores, world, lineId: "main", intents: [beta] });
        runGitRelease({ state, stores, world, lineId: "main", intents: [rc] });
        // No pre-promote run plans a move: the pointers stand.
        assertStoreChannelsStanding(state.binding.channels);
        const promoteRun = runGitRelease({
          state,
          stores,
          world,
          lineId: "main",
          intents: [promote],
        });
        expect(promoteRun.mintedTag).toBe(GOLDEN.ladder[3]);
        expect(promoteRun.planLine.stable?.tag).toBe("5.0.0");
        expect(promoteRun.scope.kind).toBe("stable-version");
        if (promoteRun.scope.kind !== "stable-version") {
          throw new Error("fixture broken: the promote scope is not a stable-version record");
        }
        expect(promoteRun.scope.version).toBe("5.0.0");
        // The stable mint is recorded as a real tag.
        expect(recordedTags(state.git, naming.namespaces)).toContain("5.0.0");
        // The plan's channel content (ADR-0012 decision 2): the §3.1 declared
        // moves in declaration order, then the promoted-from edge, then the rc
        // stream close.
        expect(promoteRun.planLine.channels).toStrictEqual([
          { kind: "channel-move", channelId: "stable", to: { line: "main", version: "5.0.0" } },
          { kind: "channel-move", channelId: "next", to: { line: "main", version: "5.0.0" } },
          { kind: "promoted-from", from: "5.0.0-rc.1", to: { line: "main", version: "5.0.0" } },
          { kind: "stream-close", stream: "rc", target: "5.0.0" },
        ]);
        // The executed outcome through the same binding: stable and next read
        // the promoted stable; beta, rc, and lts stand at §3.1's seeds.
        expect(state.binding.channels.read("stable")).toStrictEqual({
          id: "stable",
          target: { line: "main", version: "5.0.0" },
        });
        expect(state.binding.channels.read("next")).toStrictEqual({
          id: "next",
          target: { line: "main", version: "5.0.0" },
        });
        expect(state.binding.channels.read("beta")).toStrictEqual({
          id: "beta",
          target: { line: "main", version: "4.9.1" },
        });
        expect(state.binding.channels.read("rc")).toStrictEqual({
          id: "rc",
          target: { line: "main", version: "4.9.1" },
        });
        expect(state.binding.channels.read("lts")).toStrictEqual({
          id: "lts",
          target: { line: "1.9-lts", version: "1.9.1" },
        });
        // The store holds exactly the matrix's five channels — the git store
        // enumerates recorded refs, so the fixture pins the set, not a
        // ref-derivation order (the memory stores pin declaration order).
        expect(
          state.binding.channels
            .list()
            .map((channel) => channel.id)
            .sort(),
        ).toStrictEqual(["beta", "lts", "next", "rc", "stable"]);
        // Durability: a FRESH binding on the same repository reloads the moved
        // pointers exactly — the moves live in recorded refs, not in process
        // memory.
        const reloaded = openGitBinding({ repo, tagNaming: naming });
        expect(reloaded.channels.read("stable")).toStrictEqual({
          id: "stable",
          target: { line: "main", version: "5.0.0" },
        });
        expect(reloaded.channels.read("next")).toStrictEqual({
          id: "next",
          target: { line: "main", version: "5.0.0" },
        });
        // The reloaded ledger carries the two transition records, keyed by the
        // store-computed fingerprints (ADR-0012 decision 4).
        const transitions: ChannelTransitionRecord[] = [];
        for (const record of reloaded.ledger.tail(promoteRun.attempt.attemptId)) {
          if (record.kind === "channel-transition") {
            transitions.push(record.record);
          }
        }
        expect(transitions.map((record) => record.channelId)).toStrictEqual(["stable", "next"]);
        for (const record of transitions) {
          expect(record.from).toStrictEqual({ line: "main", version: "4.9.2" });
          expect(record.to).toStrictEqual({ line: "main", version: "5.0.0" });
          expect(record.contentFingerprint).toBe(
            channelStateFingerprint({
              id: record.channelId,
              target: { line: "main", version: "4.9.2" },
            }),
          );
          expect(record.claim).toBe(promoteRun.token);
        }
        // The replay: re-driving the application over the reloaded store
        // classifies every move noop — the recorded pointers are never moved
        // twice (ADR-0012 decision 4).
        const tailBefore = reloaded.ledger
          .tail(promoteRun.attempt.attemptId)
          .filter((record) => record.kind === "channel-transition").length;
        const replay = applyPlannedChannelTransitions({
          attempt: promoteRun.attempt,
          planLine: promoteRun.planLine,
          claim: promoteRun.token,
          channels: reloaded.channels,
          ledger: reloaded.ledger,
        });
        expect(replay.map((move) => move.outcome.kind)).toStrictEqual(["noop", "noop"]);
        // The noop replays are recorded like every attempt (durable evidence,
        // invariant 2.4): exactly two replay records join the reloaded ledger,
        // each self-describing as no movement — from equals to, and the
        // fingerprint keys the moved state the store observed deciding — so a
        // served-window projection (ADR-0012 decision 4) reads them as
        // non-events.
        const replayed: ChannelTransitionRecord[] = [];
        for (const record of reloaded.ledger.tail(promoteRun.attempt.attemptId)) {
          if (record.kind === "channel-transition") {
            replayed.push(record.record);
          }
        }
        expect(replayed.length).toBe(tailBefore + 2);
        for (const record of replayed.slice(tailBefore)) {
          expect(record.stepKey).toBe("channel-transition");
          expect(record.from).toStrictEqual({ line: "main", version: "5.0.0" });
          expect(record.to).toStrictEqual({ line: "main", version: "5.0.0" });
          expect(record.contentFingerprint).toBe(
            channelStateFingerprint({
              id: record.channelId,
              target: { line: "main", version: "5.0.0" },
            }),
          );
          expect(record.guards).toStrictEqual([{ guard: "claim-held", passed: true }]);
          expect(record.claim).toBe(promoteRun.token);
        }
      });
    },
  );
});

// ---------------------------------------------------------------------------
// V7 — recovery, over the git ledger
// ---------------------------------------------------------------------------

describe("V7 — recovery, git-backed", () => {
  /** The uninterrupted reference run's completions — a separate repository's
   * own run of the same release, so it never meets the window run's held
   * claim on the shared register. The reference's keys (a plain string[]
   * captured under the repo's lifetime) outlive the deleted repo. */
  const referenceKeys = (declaration?: Declarations): readonly string[] => {
    let keys: readonly string[] | undefined;
    withTempRepo("v7-reference", (referenceRepo) => {
      const state = openGitState(referenceRepo);
      const run = runGitRelease(
        {
          state,
          stores: gitStores(referenceRepo),
          world: copyWorld(liveWorld()),
          lineId: "main",
          intents: [beta],
          ...(declaration === undefined ? {} : { declarations: declaration }),
        },
        false,
      );
      keys = completedKeys(run);
    });
    if (keys === undefined) {
      throw new Error("fixture broken: the reference produced no run");
    }
    return keys;
  };

  for (const stage of CANONICAL_STAGES) {
    // Each window runs its uninterrupted reference on a separate repository,
    // the crash window, and the resume — real-git subprocesses throughout.
    // The global 20s testTimeout (vitest.config.ts, raised for the real-disk
    // suites) is far under one window's cost under contention: the CI runner
    // (2 vCPUs beside the other suites) measures the windows at 33–39s and
    // Moon's parallel local load pushed one past even 40s once ADR-0012's
    // ninth canonical stage lengthened every walk — so the per-test timeout
    // is sized from those measurements. A hang still fails the gate — this
    // only widens the room.
    it(
      `V7 · ${stage}-window · the git-backed crash classifies from the recorded tail and the resume completes the run`,
      { timeout: 60_000 },
      () => {
        withTempRepo("v7-window", (repo) => {
          const state = openGitState(repo);
          const stores = gitStores(repo);
          const world = liveWorld();
          const declaration = fullDeclaration();
          const base: RunOptions = {
            state,
            stores,
            world,
            lineId: "main",
            intents: [beta],
            declarations: declaration,
          };
          const stopped = runGitRelease({ ...base, crashAfterStartOf: stage }, false);
          expect(stopped.stoppedAt).toBe(stage);
          // The write-ahead start is a durable git commit — a fresh binding on
          // the same repo reloads it and classifies identically.
          const reloadedLedger = gitStores(repo).ledger;
          expect(classifyResume(stopped.attempt, reloadedLedger)).toStrictEqual({
            kind: "resume",
            from: stage,
          });
          // Resume over the SAME persisted repo: the walk re-enters at the
          // recorded tail's first uncompleted step.
          const resumed = runGitRelease(base, false);
          expect(resumed.stoppedAt).toBeNull();
          // No completed step re-executed, no uncompleted step skipped.
          expect(completedKeys(resumed)).toStrictEqual(referenceKeys(declaration));
        });
      },
    );
  }

  it(
    "V7 · artifact-window · the walk stops inside the DAG and the git resume completes changelog and the rest",
    { timeout: 60_000 },
    () => {
      withTempRepo("v7-artifact", (repo) => {
        const state = openGitState(repo);
        const stores = gitStores(repo);
        const world = liveWorld();
        const declaration = fullDeclaration();
        const base: RunOptions = {
          state,
          stores,
          world,
          lineId: "main",
          intents: [beta],
          declarations: declaration,
        };
        const stopped = runGitRelease(
          {
            ...base,
            crashAfterStartOfExtension: {
              stepKey: "artifact:changelog",
              stage: "tag",
              position: "after",
            },
          },
          false,
        );
        expect(stopped.stoppedAt).toBe("tag");
        expect(stopped.stores.ledger.step(stopped.attempt.attemptId, "artifact:sbom")).toBe(
          "completed",
        );
        expect(stopped.stores.ledger.step(stopped.attempt.attemptId, "artifact:changelog")).toBe(
          "started",
        );
        expect(classifyResume(stopped.attempt, stopped.stores.ledger)).toStrictEqual({
          kind: "resume",
          from: "artifact:changelog",
        });
        const resumed = runGitRelease(base, false);
        expect(resumed.stoppedAt).toBeNull();
        expect(stopped.stores.ledger.step(stopped.attempt.attemptId, "artifact:changelog")).toBe(
          "completed",
        );
        expect(stopped.stores.ledger.step(stopped.attempt.attemptId, "artifact:publish-all")).toBe(
          "completed",
        );
        expect(completedKeys(resumed)).toStrictEqual(referenceKeys(declaration));
      });
    },
  );

  it(
    "V7 · hook:announce crash · the mid-effect crash classifies and the git resume runs the effect exactly once more",
    { timeout: 60_000 },
    () => {
      withTempRepo("v7-announce", (repo) => {
        const state = openGitState(repo);
        const stores = gitStores(repo);
        const world = liveWorld();
        const declaration = fullDeclaration();
        const base: RunOptions = {
          state,
          stores,
          world,
          lineId: "main",
          intents: [beta],
          declarations: declaration,
        };
        const stopped = runGitRelease(
          {
            ...base,
            crashAfterStartOfExtension: {
              stepKey: "hook:announce",
              stage: "publish",
              position: "after",
            },
          },
          false,
        );
        expect(stopped.stoppedAt).toBe("publish");
        expect(stopped.stores.ledger.step(stopped.attempt.attemptId, "hook:announce")).toBe(
          "started",
        );
        expect(classifyResume(stopped.attempt, stopped.stores.ledger)).toStrictEqual({
          kind: "resume",
          from: "hook:announce",
        });
        const resumed = runGitRelease(base, false);
        expect(stopped.stores.ledger.step(stopped.attempt.attemptId, "hook:announce")).toBe(
          "completed",
        );
        const completions = stopped.stores.ledger
          .tail(stopped.attempt.attemptId)
          .flatMap((record) =>
            record.kind === "step" &&
            record.record.stepKey === "hook:announce" &&
            record.record.to === "completed"
              ? [record.record]
              : [],
          );
        expect(completions).toHaveLength(1);
        expect(completedKeys(resumed)).toStrictEqual(referenceKeys(declaration));
      });
    },
  );

  it(
    "V7 · channel-transition window · the promote crash re-executes the uncompleted transition exactly once and a second replay classifies noop",
    { timeout: 60_000 },
    () => {
      withTempRepo("v7-channel", (repo) => {
        const state = openGitState(repo);
        const stores = gitStores(repo);
        const world = liveWorld();
        const declaration = fullDeclaration();
        // Build the promote-ready world: beta.1, beta.2 (the ladder), then
        // rc.1 as the in-flight prerelease the promotion will consume.
        runGitRelease({ state, stores, world, lineId: "main", intents: [beta] });
        runGitRelease({ state, stores, world, lineId: "main", intents: [beta] });
        runGitRelease({ state, stores, world, lineId: "main", intents: [rc] });
        const base: RunOptions = {
          state,
          stores,
          world,
          lineId: "main",
          intents: [promote],
          declarations: declaration,
        };
        // The promote crashes between the write-ahead `started` record and
        // the application's execution of the planned moves (ADR-0012
        // decision 3): the store still holds the pre-promotion targets.
        const stopped = runGitRelease({ ...base, crashAfterStartOf: "channel-transition" }, false);
        expect(stopped.stoppedAt).toBe("channel-transition");
        // The write-ahead start is a durable git commit — a fresh ledger on
        // the same repo reloads it and classifies identically.
        expect(classifyResume(stopped.attempt, gitStores(repo).ledger)).toStrictEqual({
          kind: "resume",
          from: "channel-transition",
        });
        // The application never ran on the crashed attempt: no
        // channel-transition record joins the persisted tail yet.
        const beforeResume = gitStores(repo)
          .ledger.tail(stopped.attempt.attemptId)
          .filter((record) => record.kind === "channel-transition");
        expect(beforeResume).toHaveLength(0);
        // Resume over the SAME persisted repo: the application re-runs
        // against the reloaded store, the moves apply cleanly against the
        // pre-promotion targets (decision 3's E-01 re-execution).
        const resumed = runGitRelease(base, false);
        expect(resumed.stoppedAt).toBeNull();
        // The channel store holds exactly the planned post-promotion
        // targets; beta, rc, and lts stand at §3.1's seeds.
        expect(state.binding.channels.read("stable")).toStrictEqual({
          id: "stable",
          target: { line: "main", version: "5.0.0" },
        });
        expect(state.binding.channels.read("next")).toStrictEqual({
          id: "next",
          target: { line: "main", version: "5.0.0" },
        });
        expect(state.binding.channels.read("beta")).toStrictEqual({
          id: "beta",
          target: { line: "main", version: "4.9.1" },
        });
        expect(state.binding.channels.read("rc")).toStrictEqual({
          id: "rc",
          target: { line: "main", version: "4.9.1" },
        });
        expect(state.binding.channels.read("lts")).toStrictEqual({
          id: "lts",
          target: { line: "1.9-lts", version: "1.9.1" },
        });
        // The tail carries exactly two channel-transition records from the
        // resume's application — the E-01 re-execution landed once.
        const channelRecords = gitStores(repo)
          .ledger.tail(stopped.attempt.attemptId)
          .flatMap((record) => (record.kind === "channel-transition" ? [record.record] : []));
        expect(channelRecords).toHaveLength(2);
        expect(channelRecords.map((record) => record.channelId)).toStrictEqual(["stable", "next"]);
        for (const record of channelRecords) {
          expect(record.from).toStrictEqual({ line: "main", version: "4.9.2" });
          expect(record.to).toStrictEqual({ line: "main", version: "5.0.0" });
        }
        // A second replay of the application over the same reloaded store
        // (the completed transition re-visited) classifies every move noop —
        // the recorded fingerprint keys the moved state, never a silent
        // second move (ADR-0012 decisions 3, 4, 5).
        const replay = applyPlannedChannelTransitions({
          attempt: resumed.attempt,
          planLine: resumed.planLine,
          claim: resumed.token,
          channels: state.binding.channels,
          ledger: gitStores(repo).ledger,
        });
        expect(replay.map((move) => move.outcome.kind)).toStrictEqual(["noop", "noop"]);
        const replayedRecords = gitStores(repo)
          .ledger.tail(stopped.attempt.attemptId)
          .flatMap((record) => (record.kind === "channel-transition" ? [record.record] : []));
        expect(replayedRecords).toHaveLength(4);
        for (const record of replayedRecords.slice(2)) {
          expect(record.from).toStrictEqual({ line: "main", version: "5.0.0" });
          expect(record.to).toStrictEqual({ line: "main", version: "5.0.0" });
          expect(record.contentFingerprint).toBe(
            channelStateFingerprint({
              id: record.channelId,
              target: { line: "main", version: "5.0.0" },
            }),
          );
        }
        expect(completedKeys(resumed)).toStrictEqual(referenceKeys(declaration));
      });
    },
  );
});

// ---------------------------------------------------------------------------
// V8 — concurrency (the ADR-0011 hostile harness inside the git `claim`)
// ---------------------------------------------------------------------------

describe("V8 — concurrency, git-backed (the ADR-0011 harness)", () => {
  it("V8 · exclusive claim · the git register accepts exactly one holder per scope, and the loser's denial names the winner", () => {
    withTempRepo("v8-exclusive", (repo) => {
      const state = openGitState(repo);
      const stores = gitStores(repo);
      const world = liveWorld();
      const run = runGitRelease({ state, stores, world, lineId: "main", intents: [beta] });
      // A second attempt of the same plan through the same register is a
      // distinct attempt; the git register holds the winner, the loser
      // re-reads and names it.
      const attemptB = start(
        openAttempt(gitStores(repo).register, {
          planId: run.attempt.planId,
          planFingerprint: run.attempt.planId,
        }),
      );
      const denial = asDenied(state.binding.claims.acquire(run.scope, attemptB.attemptId));
      expect(denial.holder).toBe(run.attempt.attemptId);
      expect(claimsAtLine(state, "main")).toHaveLength(1);
    });
  });

  it("V8 · hostile diverge · writer B lands between A's read and its CAS — A re-evaluates and denies, never both-accept", () => {
    withTempRepo("v8-diverge", (repo) => {
      const state = openGitState(repo);
      const lineRegister = claimRegisterRefFor("main");
      // Writer B (a second attempt on the same line's prerelease scope)
      // lands between A's evaluation of the empty register and A's CAS.
      const writerB = {
        scope: {
          kind: "prerelease-sequence",
          lineId: "main",
          target: "5.0.0",
          streamId: "beta",
          sequence: 1,
        } as ClaimScope,
        token: "b".repeat(64),
        holder: "attempt_b",
      };
      const envelope = `{"claims":[${JSON.stringify({ kind: "claim", scope: writerB.scope, token: writerB.token, holder: writerB.holder })}]}`;
      const shim = buildShim({ registerRef: lineRegister, payload: envelope, mode: "diverge" });
      try {
        let settled: Claim | ClaimDenied | undefined;
        withHostilePath(shim.dir, () => {
          // GitClaimStore captures its run env at construction — the store
          // must open INSIDE the hostile path for the shim's `git` to be on
          // PATH (the claiming attempt does).
          const hostileClaims = new GitClaimStore(repo);
          shim.arm();
          settled = hostileClaims.acquire(writerB.scope, "attempt_a");
        });
        // A evaluated an empty register; the register's CAS lost, the
        // re-read found B's record (the same scope), and the exclusion law
        // denied — naming the winner and its sequence (E-08).
        const denial = asDenied(settled);
        expect(denial).toStrictEqual({
          kind: "denied",
          scope: writerB.scope,
          holder: "attempt_b",
          holderSequence: 1,
        });
        const held = claimsAtLine(state, "main");
        expect(held).toHaveLength(1);
        expect(held[0]?.holder).toBe("attempt_b");
      } finally {
        shim.cleanup();
      }
    });
  });

  it("V8 · crash mid-write · the hostile shim kills git inside the claim CAS — the register stays at a consistent tip and the next CAS recovers", () => {
    withTempRepo("v8-crash", (repo) => {
      const state = openGitState(repo);
      const lineRegister = claimRegisterRefFor("main");
      const shim = buildShim({ registerRef: lineRegister, mode: "crash" });
      try {
        let crashed = false;
        withHostilePath(shim.dir, () => {
          const hostileClaims = new GitClaimStore(repo);
          shim.arm();
          try {
            hostileClaims.acquire(
              {
                kind: "prerelease-sequence",
                lineId: "main",
                target: "5.0.0",
                streamId: "beta",
                sequence: 1,
              },
              "attempt_a",
            );
          } catch {
            // The substrate died mid-write — a fault, not a claim.
            crashed = true;
          }
        });
        expect(crashed).toBe(true);
        // Either side of every CAS the register is a value: here it never
        // moved at all.
        expect(readRef(state.git, lineRegister)).toBeNull();
        // Recovery is the next compare-and-set, outside the hostile path —
        // the store's own runner now opens a real git.
        const recoveredStore = gitStores(repo).claims;
        const recovered = recoveredStore.acquire(
          {
            kind: "prerelease-sequence",
            lineId: "main",
            target: "5.0.0",
            streamId: "beta",
            sequence: 1,
          },
          "attempt_a",
        );
        if (recovered.kind !== "claim") {
          throw new Error("fixture broken: recovery did not claim");
        }
        expect(recoveredStore.verify(recovered.token).kind).toBe("held");
      } finally {
        shim.cleanup();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// E-02 — replay semantics over the git ledger
// ---------------------------------------------------------------------------

describe("E-02 — replay semantics, git-backed", () => {
  it("E-02 · completed replay · a proven-same content fingerprint replays noop; a different one is a conflict", () => {
    withTempRepo("e02-replay", (repo) => {
      const state = openGitState(repo);
      const stores = gitStores(repo);
      const world = liveWorld();
      const run = runGitRelease({
        state,
        stores,
        world,
        lineId: "main",
        intents: [beta],
        terminalize: false,
      });
      expect(run.stoppedAt).toBeNull();
      expect(run.attempt.state).toBe("executing");
      const attempt = run.attempt;
      const attemptId = attempt.attemptId;
      const same = ledgerRequestStep(
        attempt,
        {
          stepKey: "publish",
          attribution: actor(attempt),
          contentFingerprint: `content:publish:${attemptId}`,
        },
        claimView(state, attemptId),
        gitStores(repo).ledger,
      );
      expect(same).toStrictEqual({ kind: "noop", stepKey: "publish" });
      const changed = ledgerRequestStep(
        attempt,
        {
          stepKey: "publish",
          attribution: actor(attempt),
          contentFingerprint: `content:publish:different`,
        },
        claimView(state, attemptId),
        gitStores(repo).ledger,
      );
      if (changed.kind !== "conflict") {
        throw new Error(`expected a conflict, got ${changed.kind}`);
      }
      expect(changed.stepKey).toBe("publish");
      expect(changed.detail).toContain("not proven equal");
    });
  });
});

// ---------------------------------------------------------------------------
// V9 — divergence, over the git ledger
// ---------------------------------------------------------------------------

describe("V9 — divergence, git-backed", () => {
  // The carried fix mints four side lines (four full plans, claims, walks,
  // mints) over real-git subprocesses — the same heaviness V2's multi-line
  // walk earned its own timeout; see the V2 comment above.
  it(
    "V9 · propagation · the carried fix mints per line, plans stay single-line and disjoint",
    { timeout: 45_000 },
    () => {
      withTempRepo("v9-propagation", (repo) => {
        const state = openGitState(repo);
        const stores = gitStores(repo);
        const world = liveWorld();
        const sideLines = ["4.8.x", "3.x", "2.x", "1.9-lts"] as const;
        const carried = sideLines.map((lineId) =>
          runGitRelease({ state, stores, world, lineId, intents: [{ kind: "release" }] }),
        );
        // Every side line's cut mints the golden — the carried fix on
        // 4.8.x and 1.9-lts, the independent changes on 3.x and 2.x.
        expect(carried.map((run) => run.mintedTag)).toStrictEqual(
          sideLines.map((lineId) => GOLDEN.sides[lineId]),
        );
        // Plans are single-line (M-02) and disjoint — every attempt its own plan.
        expect(new Set(carried.map((run) => run.attempt.planId)).size).toBe(4);
        // No version repeats across lines; the minted tags are in the real
        // repo (recordedTags sorts).
        const minted = world.tags.map((tag) => tag.name);
        expect(new Set(minted).size).toBe(minted.length);
        expect(recordedTags(state.git, naming.namespaces)).toStrictEqual([
          "1.9.2",
          "2.4.1",
          "3.3.0",
          "4.8.7",
        ]);
      });
    },
  );
});

// ---------------------------------------------------------------------------
// V6 — immutability and determinism, over the git ledger
// ---------------------------------------------------------------------------

describe("V6 — immutability and determinism, git-backed", () => {
  it(
    "V6 · reload · a fresh binding on the same repo reads the tail byte-identical and the register value reads back",
    // The reload walk re-reads the whole recorded repo through real git and
    // sat at the 20s global edge under parallel-suite contention (observed
    // red once there, green in isolation and on CI) — a hang still fails
    // the gate; this only widens the room.
    { timeout: 45_000 },
    () => {
      withTempRepo("v6-reload", (repo) => {
        const state = openGitState(repo);
        const stores = gitStores(repo);
        const world = liveWorld();
        const declaration = fullDeclaration();
        const run = runGitRelease({
          state,
          stores,
          world,
          lineId: "main",
          intents: [beta],
          declarations: declaration,
        });
        const attemptId = run.attempt.attemptId;
        const bytes = tailBytes(run.stores.ledger, attemptId);
        expect(bytes.length).toBeGreaterThan(0);
        // A fresh binding on the same repo (a reload) reads the same bytes.
        const reloaded = gitStores(repo).ledger;
        expect(tailBytes(reloaded, attemptId)).toStrictEqual(bytes);
        // The register reads back the claim record for the run's scope.
        const register = claimsAtLine(state, "main");
        expect(register).toHaveLength(1);
        expect(register[0]?.scope).toStrictEqual(run.scope);
      });
    },
  );

  // The determinism assertions double-run the full matrix (two full plans,
  // claims, walks, mints, resumes) over real-git subprocesses, so they sit
  // right at the 20s global edge (vitest.config.ts) under the CI runner's
  // parallel-suite contention — behaviour established for the V7 windows
  // above. A hang still fails the gate; this only widens the room.
  it(
    "V6 · determinism · two fresh repos run the matrix identically → the ledger tails agree (tokens labelled) and the registers agree (tokens labelled)",
    { timeout: 45_000 },
    () => {
      const matrixTrace = (): readonly string[] => {
        const trace: string[] = [];
        withTempRepo("v6-determinism", (repo) => {
          const state = openGitState(repo);
          const stores = gitStores(repo);
          const world = liveWorld();
          const run1 = runGitRelease({ state, stores, world, lineId: "main", intents: [beta] });
          const run2 = runGitRelease({ state, stores, world, lineId: "main", intents: [beta] });
          trace.push(run1.attempt.planId);
          trace.push(JSON.stringify(run1.mintedTag));
          trace.push(JSON.stringify(run2.mintedTag));
          trace.push(JSON.stringify(normalizedTail(stores, run1.attempt.attemptId)));
          trace.push(JSON.stringify(normalizedTail(stores, run2.attempt.attemptId)));
          trace.push(JSON.stringify(normalizedClaims(state, "main")));
        });
        return trace;
      };
      expect(matrixTrace()).toStrictEqual(matrixTrace());
    },
  );
});

// ---------------------------------------------------------------------------
// V11 — zero-config and determinism, over the git binding
// ---------------------------------------------------------------------------

describe("V11 — zero-config and determinism, git-backed", () => {
  it("V11 · zero-config · the stores construct from a repository path alone", () => {
    withTempRepo("v11-zero", (repo) => {
      const stores = gitStores(repo);
      expect(stores.claims).toBeDefined();
      expect(stores.register).toBeDefined();
      expect(stores.ledger.tail("attempt_does_not_exist")).toStrictEqual([]);
      const state = openGitState(repo);
      expect(state.binding.claims).toBeDefined();
    });
  });

  // Same double-run determinism shape as V6's: a full matrix twice over
  // real git. See the V6 timeout comment above.
  it(
    "V11 · determinism · the binding re-runs on a fresh repo and lands identical recorded state",
    { timeout: 45_000 },
    () => {
      const matrixTrace = (): {
        readonly tags: readonly string[];
        readonly t1: readonly string[];
        readonly t2: readonly string[];
      } => {
        let captured: { tags: string[]; t1: readonly string[]; t2: readonly string[] } | undefined;
        withTempRepo("v11-determinism", (repo) => {
          const state = openGitState(repo);
          const stores = gitStores(repo);
          const world = liveWorld();
          const run1 = runGitRelease({ state, stores, world, lineId: "main", intents: [beta] });
          const run2 = runGitRelease({ state, stores, world, lineId: "main", intents: [beta] });
          captured = {
            tags: world.tags.map((tag) => tag.name),
            t1: normalizedTail(stores, run1.attempt.attemptId),
            t2: normalizedTail(stores, run2.attempt.attemptId),
          };
        });
        if (captured === undefined) {
          throw new Error("fixture broken: no trace captured");
        }
        return captured;
      };
      expect(matrixTrace()).toStrictEqual(matrixTrace());
    },
  );
});
