/**
 * Slice 10.5 — the GitHub-backed vertical (contract
 * docs/design/phase10-vertical-matrix-contract.md §4 "10.5"). The assembled
 * adapter (ADR-0010's `openGitHubAdapter`) runs over the matrix, constructed
 * zero-config: repository path, credentials, the injected transport —
 * nothing ambient. Publication derives every remote row from recorded
 * evidence alone (the changelog seam, §2.8); the tag mint is the binding's
 * create-if-absent door and the remote push is the adapter's
 * synchronization; reconciliation compares the remote against the binding
 * per R-10..R-12 under D30's per-listing observation outcomes — a listing
 * failure is an outcome, never a demotion — and an out-of-band remote
 * mutation is detected on the next reconcile. The concurrency rows drive
 * ADR-0011's hostile pattern at this slice's interception seam (§7): the
 * arm-gated concurrent writer lands between the publication door's
 * idempotency read and its create, and a lost write re-evaluates and lands
 * or denies — never both-accepts.
 *
 * Every test name carries its §6 invariant row and the §3 step it proves.
 * The goldens come from the fixture module's hand-derived data, never from
 * a run (§2) — the one 10.4-precedented exception: a declared walk's
 * extension order is the scheduler's, so the declared crash windows' golden
 * is a separate repository's own uninterrupted reference run. Git-window
 * tests carry explicit headroom (the real-git subprocess walks brush
 * vitest's default under the CI runner's parallel load); a hang still fails
 * the gate — the timeouts only widen the room.
 */
import { describe, expect, it } from "vitest";

import {
  CANONICAL_STAGES,
  channelStateFingerprint,
  classifyResume,
  openAttempt,
  resolveBlocked,
  resume,
  retrySequence,
  stageContentFingerprint,
  start,
  supersedePlan,
  type ChannelTransitionRecord,
  type Claim,
  type ClaimDenied,
  type HookEffect,
} from "../../src/index.js";
import { openGitHubAdapter } from "@ecoma-io/release-craft/__internal__/adapters/github/index.js";
import {
  claimRegisterRefFor,
  GitFaultError,
  openGitBinding,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import { plan } from "@ecoma-io/release-craft/__internal__/planner/assemble.js";
import { withTempRepo } from "../adapters/git/temp-repo.js";
import {
  actor,
  applyPlannedChannelTransitions,
  assertStoreChannelsStanding,
  COMMITTED_AT,
  GOLDEN,
  hookEffects,
  liveWorld,
  matrixHooks,
  plannedOf,
  runInput,
  snapshot,
} from "./matrix.js";
import {
  gitStores,
  naming,
  readClaimsAt,
  runGitRelease,
  tailBytes,
  type Declarations,
  type GitStores,
  type RunOptions,
} from "./matrix-git.js";
import {
  CHANGELOG_PATH,
  credentials,
  DIVERGENT_BODY,
  OUT_OF_BAND_SHA,
  OUT_OF_BAND_TAG,
  openFakeRemote,
  recordedTagRows,
  withGitHubVertical,
  type GitHubVerticalState,
} from "./matrix-github.js";

// ---------------------------------------------------------------------------
// Shared staging helpers — recorded goldens and the bytes-over-values reads
// ---------------------------------------------------------------------------

const beta = { kind: "prerelease", stream: "beta", lineId: "main" } as const;
const rc = { kind: "prerelease", stream: "rc", lineId: "main" } as const;
const promote = { kind: "promote", lineId: "main" } as const;

/** The completed step keys of a run, append order. */
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

const asMinted = (mintedTag: string | null): string => {
  if (mintedTag === null) {
    throw new Error("fixture broken: the completed run minted no tag");
  }
  return mintedTag;
};

/** The uninterrupted reference run's completions — a separate repository's
 * own declared walk of the same release. The bare windows' golden is the
 * hand-derived canonical sequence; the DECLARED windows' extension order is
 * the scheduler's (artifacts and hooks fire at their anchors in the walk's
 * own order), so their golden is the reference — the 10.4 suite's own shape
 * for exactly these windows. The keys are captured under the fixture's
 * lifetime and outlive the deleted repo. */
const referenceKeys = (declaration?: Declarations): readonly string[] => {
  let keys: readonly string[] | undefined;
  withGitHubVertical("v7-reference", (vertical) => {
    const run = runGitRelease(
      {
        state: vertical.state,
        stores: gitStores(vertical.repo),
        world: liveWorld(),
        lineId: "main",
        intents: [beta],
        declarations: declaration ?? vertical.declarations,
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

const asDenied = (settled: Claim | ClaimDenied): ClaimDenied => {
  if (settled.kind !== "denied") {
    throw new Error(`fixture broken: expected a denial, got ${settled.kind}`);
  }
  return settled;
};

/** The tail's records with the claim token labelled in first-sighting order —
 * the git store allocates random tokens (`randomBytes`), so two independent
 * repositories agree on every field but that token (V6's normalization, the
 * 10.4 suite's own shape). */
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

/**
 * The remote surface one repository derives — sync, publication,
 * verification, reconciliation — read back through the fake remote and the
 * binding's read doors, with the register blobs' random-token material
 * labelled (each claim ref's target is the register blob oid, a function of
 * the random tokens it holds). Two independent repositories' traces compare
 * byte-equal (V6), and a crashed-and-resumed repository's trace compares
 * byte-equal to an uninterrupted one's (V7 composed with publication).
 */
const publicationTrace = (vertical: GitHubVerticalState, tag: string): string => {
  const remote = openFakeRemote();
  const adapter = vertical.adapter(remote.transport);
  const sync = adapter.syncRemote();
  for (const row of recordedTagRows(vertical.state)) {
    remote.putTag(row.name, row.target);
  }
  const publish = adapter.publishRelease(tag);
  const verify = adapter.verifyRelease(tag);
  const reconcile = adapter.reconcile();
  const labels = new Map<string, string>();
  const label = (token: string): string => {
    const seen = labels.get(token);
    if (seen !== undefined) {
      return seen;
    }
    const fresh = `t${String(labels.size + 1)}`;
    labels.set(token, fresh);
    return fresh;
  };
  const rows = sync.refs.map((row) =>
    row.kind === "claim"
      ? {
          ...row,
          target: `<register:${vertical.state.binding.content
            .claims(row.ref)
            .map((record) => label(record.token))
            .join(",")}>`,
        }
      : row,
  );
  return JSON.stringify({
    rows,
    publish,
    verify,
    reconcile,
    body: remote.releases.get(tag) ?? null,
  });
};

/** Seeds the fake remote from the binding's recorded tags — the seeding
 * shape the sync report's `pushed` rows are asserted beside first. */
const seedRemote = (vertical: GitHubVerticalState): ReturnType<typeof openFakeRemote> => {
  const remote = openFakeRemote();
  for (const row of recordedTagRows(vertical.state)) {
    remote.putTag(row.name, row.target);
  }
  return remote;
};

// ---------------------------------------------------------------------------
// V1 — plan integrity, over the adapter's own stack
// ---------------------------------------------------------------------------

describe("V1 — plan integrity, github-backed", () => {
  it(
    "V1 · main beta run · the same inputs re-plan identically and the walk executes the planned canonical sequence",
    { timeout: 80_000 }, // one real-git walk — headroom, not a hang mask
    () => {
      withGitHubVertical("v1-plan", (vertical) => {
        const input = runInput(snapshot(liveWorld()), "main", [beta]);
        const first = plannedOf(plan(input)).plan;
        const second = plannedOf(plan(input)).plan;
        expect(second.planId).toBe(first.planId);

        const run = runGitRelease({
          state: vertical.state,
          stores: gitStores(vertical.repo),
          world: liveWorld(),
          lineId: "main",
          intents: [beta],
        });
        expect(run.attempt.planId).toBe(first.planId);
        expect(completedKeys(run)).toStrictEqual([...CANONICAL_STAGES]);
      });
    },
  );

  it(
    "V1 · content fingerprints · every canonical completion verifies its fingerprint and the publication body reads back the recorded bytes",
    { timeout: 80_000 }, // one real-git walk plus the adapter doors — headroom, not a hang mask
    () => {
      withGitHubVertical("v1-fingerprints", (vertical) => {
        const run = runGitRelease({
          state: vertical.state,
          stores: gitStores(vertical.repo),
          world: liveWorld(),
          lineId: "main",
          intents: [beta],
          declarations: vertical.declarations,
        });
        expect(run.stoppedAt).toBeNull();
        for (const stage of CANONICAL_STAGES) {
          const completion = run.stores.ledger.stepView().completed(run.attempt.attemptId, stage);
          if (completion === null) {
            throw new Error(`fixture broken: ${stage} never recorded a completion`);
          }
          // The §2.6 digest over the stage's declared content — the
          // engine's own derivation, identity not among the inputs (#195).
          expect(completion.contentFingerprint).toBe(stageContentFingerprint(stage, run.planLine));
        }
        // The changelog the publication door derives is recorded evidence:
        // the §2.8 seam reads the recorded tree's bytes, and the release
        // body is exactly those bytes — never a restatement.
        const tag = asMinted(run.mintedTag);
        const remote = seedRemote(vertical);
        const adapter = vertical.adapter(remote.transport);
        expect(adapter.syncRemote().refs.every((row) => row.outcome.state === "pushed")).toBe(true);
        expect(adapter.publishRelease(tag)).toStrictEqual({
          kind: "ok",
          url: `https://github.fake/ecoma-io/release-craft/releases/tag/${tag}`,
        });
        expect(remote.releases.get(tag)).toBe(
          vertical.state.binding.content.file(vertical.changelogDigest, CHANGELOG_PATH),
        );
      });
    },
  );
});

// ---------------------------------------------------------------------------
// V2 — identity, over the adapter's own stack
// ---------------------------------------------------------------------------

describe("V2 — identity, github-backed", () => {
  it(
    "V2 · commit-window · the identity is stable across the crash and the resumed run's records carry it",
    { timeout: 80_000 }, // two real-git walks — headroom, not a hang mask
    () => {
      withGitHubVertical("v2-identity", (vertical) => {
        const stores = gitStores(vertical.repo);
        const world = liveWorld();
        const base: RunOptions = {
          state: vertical.state,
          stores,
          world,
          lineId: "main",
          intents: [beta],
        };
        const stopped = runGitRelease({ ...base, crashAfterStartOf: "commit" }, false);
        expect(stopped.stoppedAt).toBe("commit");
        const resumed = runGitRelease(base, false);
        expect(resumed.attempt.attemptId).toBe(stopped.attempt.attemptId);
        for (const record of stores.ledger.tail(stopped.attempt.attemptId)) {
          const holder =
            record.kind === "step" || record.kind === "channel-transition"
              ? record.record.attemptId
              : record.attemptId;
          expect(holder).toBe(stopped.attempt.attemptId);
        }
      });
    },
  );

  it(
    "V2 · five lines · five lines' runs never share an attempt, and the sync enumerates each line's register",
    { timeout: 120_000 }, // five real-git walks — headroom, not a hang mask
    () => {
      withGitHubVertical("v2-five-lines", (vertical) => {
        const stores = gitStores(vertical.repo);
        const world = liveWorld();
        const main = runGitRelease({
          state: vertical.state,
          stores,
          world,
          lineId: "main",
          intents: [beta],
        });
        const sides = ["4.8.x", "3.x", "2.x", "1.9-lts"].map((lineId) =>
          runGitRelease({
            state: vertical.state,
            stores,
            world,
            lineId,
            intents: [{ kind: "release" }],
          }),
        );
        const ids = [main, ...sides].map((run) => run.attempt.attemptId);
        expect(new Set(ids).size).toBe(5);
        // The adapter's synchronization reads the binding's recorded refs:
        // one register per line (the ref name hashes the line id), and the
        // five minted tags beside them.
        const report = vertical.adapter(openFakeRemote().transport).syncRemote();
        expect(
          report.refs
            .filter((row) => row.kind === "claim")
            .map((row) => row.ref)
            .sort(),
        ).toStrictEqual(
          ["1.9-lts", "2.x", "3.x", "4.8.x", "main"]
            .map((lineId) => claimRegisterRefFor(lineId))
            .sort(),
        );
        expect(report.refs.filter((row) => row.kind === "tag")).toHaveLength(5);
      });
    },
  );
});

// ---------------------------------------------------------------------------
// V3 — prerelease sequence, over the adapter's own stack
// ---------------------------------------------------------------------------

describe("V3 — prerelease sequence, github-backed", () => {
  it(
    "V3 · ladder runs 1–2 · beta.1 then beta.2, only the beta stream moves, and the minted tags are real refs",
    { timeout: 90_000 }, // two real-git walks — headroom, not a hang mask
    () => {
      withGitHubVertical("v3-ladder", (vertical) => {
        const stores = gitStores(vertical.repo);
        const world = liveWorld();
        const base: RunOptions = {
          state: vertical.state,
          stores,
          world,
          lineId: "main",
          intents: [beta],
        };
        const first = runGitRelease(base);
        expect(first.mintedTag).toBe(GOLDEN.ladder[0]);
        const second = runGitRelease({ ...base, intents: [beta] });
        expect(second.mintedTag).toBe(GOLDEN.ladder[1]);
        expect(second.planLine.streams.map((stream) => stream.identifier)).toStrictEqual(["beta"]);
        // The tags are real refs, and the adapter's synchronization is the
        // remote write that lands them.
        const remote = openFakeRemote();
        const report = vertical.adapter(remote.transport).syncRemote();
        expect(
          report.refs
            .filter((row) => row.kind === "tag")
            .every((row) => row.outcome.state === "pushed"),
        ).toBe(true);
      });
    },
  );

  it(
    "V3 · ladder run 3 · the rc stream opens from its own key beside beta",
    { timeout: 90_000 }, // three real-git walks — headroom, not a hang mask
    () => {
      withGitHubVertical("v3-rc", (vertical) => {
        const stores = gitStores(vertical.repo);
        const world = liveWorld();
        const base: RunOptions = {
          state: vertical.state,
          stores,
          world,
          lineId: "main",
          intents: [beta],
        };
        runGitRelease(base);
        runGitRelease(base);
        const rcRun = runGitRelease({ ...base, intents: [rc] });
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
    },
  );
});

// ---------------------------------------------------------------------------
// V4 — promotion, published through the assembled adapter
// ---------------------------------------------------------------------------

describe("V4 — promotion, github-backed", () => {
  it(
    "V4 · ladder run 4 · the promote lands the stable record, moves the planned channels, replays noop, and the adapter publishes the release",
    { timeout: 120_000 }, // four real-git walks plus the adapter doors — headroom, not a hang mask
    () => {
      withGitHubVertical("v4-promote", (vertical) => {
        const stores = gitStores(vertical.repo);
        const world = liveWorld();
        const base: RunOptions = {
          state: vertical.state,
          stores,
          world,
          lineId: "main",
          intents: [beta],
          declarations: vertical.declarations,
        };
        assertStoreChannelsStanding(vertical.state.binding.channels);
        runGitRelease({ ...base, intents: [beta] });
        runGitRelease({ ...base, intents: [beta] });
        runGitRelease({ ...base, intents: [rc] });
        assertStoreChannelsStanding(vertical.state.binding.channels);
        const promoteRun = runGitRelease({ ...base, intents: [promote] });
        expect(promoteRun.mintedTag).toBe(GOLDEN.ladder[3]);
        expect(promoteRun.scope.kind).toBe("stable-version");
        // The plan's channel content (ADR-0012 decision 2).
        expect(promoteRun.planLine.channels).toStrictEqual([
          { kind: "channel-move", channelId: "stable", to: { line: "main", version: "5.0.0" } },
          { kind: "channel-move", channelId: "next", to: { line: "main", version: "5.0.0" } },
          { kind: "promoted-from", from: "5.0.0-rc.1", to: { line: "main", version: "5.0.0" } },
          { kind: "stream-close", stream: "rc", target: "5.0.0" },
        ]);
        // The executed outcome through the binding: stable and next read the
        // promoted stable; the untouched channels stand at their seeds.
        expect(vertical.state.binding.channels.read("stable")).toStrictEqual({
          id: "stable",
          target: { line: "main", version: "5.0.0" },
        });
        expect(vertical.state.binding.channels.read("next")).toStrictEqual({
          id: "next",
          target: { line: "main", version: "5.0.0" },
        });
        expect(vertical.state.binding.channels.read("lts")).toStrictEqual({
          id: "lts",
          target: { line: "1.9-lts", version: "1.9.1" },
        });
        // The replay: a fresh binding re-drives the application over the
        // recorded state — every move classifies noop, never moving twice,
        // and exactly two noop records join the tail (ADR-0012 decision 4).
        const reloaded = openGitBinding({ repo: vertical.repo, tagNaming: naming });
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
          expect(record.claim).toBe(promoteRun.token);
        }
        // The remote half: the synchronization is the only remote write, the
        // publication derives the body from recorded evidence alone.
        const remote = seedRemote(vertical);
        const adapter = vertical.adapter(remote.transport);
        const sync = adapter.syncRemote();
        expect(sync.refs).toHaveLength(5); // the main line's register + the four minted tags
        expect(sync.refs.every((row) => row.outcome.state === "pushed")).toBe(true);
        expect(adapter.publishRelease(GOLDEN.ladder[3])).toStrictEqual({
          kind: "ok",
          url: `https://github.fake/ecoma-io/release-craft/releases/tag/${GOLDEN.ladder[3]}`,
        });
        expect(adapter.verifyRelease(GOLDEN.ladder[3])).toStrictEqual({ kind: "verified" });
        expect(remote.releases.get(GOLDEN.ladder[3])).toBe(
          vertical.state.binding.content.file(vertical.changelogDigest, CHANGELOG_PATH),
        );
      });
    },
  );
});

// ---------------------------------------------------------------------------
// V5 — supersession, over the adapter's own stack
// ---------------------------------------------------------------------------

describe("V5 — supersession, github-backed", () => {
  it(
    "V5 · supersede staging · the abandoned attempt supersedes, its lease releases by token, and no channel points at an abandoned version",
    { timeout: 90_000 }, // three real-git walks — headroom, not a hang mask
    () => {
      withGitHubVertical("v5-supersede", (vertical) => {
        const stores = gitStores(vertical.repo);
        const world = liveWorld();
        const base: RunOptions = {
          state: vertical.state,
          stores,
          world,
          lineId: "main",
          intents: [beta],
        };
        runGitRelease(base);
        // A aims at beta.2 and dies before tag — voidable, its lease held.
        const a = runGitRelease({ ...base, crashAfterStartOf: "commit" }, false);
        expect(a.stoppedAt).toBe("commit");
        expect(readClaimsAt(vertical.state, claimRegisterRefFor("main"))).toHaveLength(2);
        // A prerelease claim is a lease: released by token, the register
        // drops the record, and verify reads lost.
        stores.claims.release(a.token);
        expect(readClaimsAt(vertical.state, claimRegisterRefFor("main"))).toHaveLength(1);
        expect(stores.claims.verify(a.token).kind).toBe("lost");
        // The world pivots; B plans the beta.2 target under a new plan.
        const ref = world.refs.find((candidate) => candidate.name === "main");
        if (ref === undefined) {
          throw new Error("fixture broken: no main ref");
        }
        world.commits = [
          ...world.commits,
          {
            sha: "m6",
            parents: [ref.head],
            message: "fix: the pivot",
            committedAt: COMMITTED_AT,
            containingRefs: ["main"],
          },
        ];
        world.refs = world.refs.map((candidate) =>
          candidate.name === "main" ? { name: "main", head: "m6" } : candidate,
        );
        const b = runGitRelease({ ...base });
        expect(b.mintedTag).toBe("5.0.0-beta.2");
        // A's plan is abandoned by relation: A supersedes now (before tag),
        // the terminal B untouched.
        const voided = supersedePlan({
          oldPlanId: a.attempt.planId,
          newPlanId: b.attempt.planId,
          attempts: [a.attempt, b.attempt],
          steps: stores.ledger.stepView(),
        });
        expect(voided.pastTag).toStrictEqual([]);
        expect(voided.superseded.map((attempt) => attempt.attemptId)).toStrictEqual([
          a.attempt.attemptId,
        ]);
        expect(voided.superseded[0]?.state).toBe("superseded");
        expect(voided.superseded[0]?.terminalReason).toBe(`superseded-by:${b.attempt.planId}`);
        // No channel points at an abandoned version — B's run plans no moves.
        assertStoreChannelsStanding(vertical.state.binding.channels);
        // Past-tag leg: an attempt whose tag completed is unvoidable — it
        // stands and only the relation records.
        const past = runGitRelease({ ...base, crashAfterStartOf: "publish" }, false);
        expect(past.stores.ledger.step(past.attempt.attemptId, "tag")).toBe("completed");
        const outcome = supersedePlan({
          oldPlanId: past.attempt.planId,
          newPlanId: b.attempt.planId,
          attempts: [past.attempt],
          steps: past.stores.ledger.stepView(),
        });
        expect(outcome.superseded).toStrictEqual([]);
        expect(outcome.pastTag.map((attempt) => attempt.attemptId)).toStrictEqual([
          past.attempt.attemptId,
        ]);
        past.stores.claims.release(past.token);
        expect(past.stores.claims.verify(past.token).kind).toBe("lost");
      });
    },
  );
});

// ---------------------------------------------------------------------------
// V6 — immutability and determinism, including the derived remote rows
// ---------------------------------------------------------------------------

describe("V6 — immutability and determinism, github-backed", () => {
  it(
    "V6 · reload · a fresh binding on the same repo reads the tail byte-identical",
    { timeout: 80_000 }, // one real-git walk — headroom, not a hang mask
    () => {
      withGitHubVertical("v6-reload", (vertical) => {
        const stores = gitStores(vertical.repo);
        const run = runGitRelease({
          state: vertical.state,
          stores,
          world: liveWorld(),
          lineId: "main",
          intents: [beta],
          declarations: vertical.declarations,
        });
        const bytes = tailBytes(stores.ledger, run.attempt.attemptId);
        expect(bytes.length).toBeGreaterThan(0);
        expect(tailBytes(gitStores(vertical.repo).ledger, run.attempt.attemptId)).toStrictEqual(
          bytes,
        );
      });
    },
  );

  it(
    "V6 · determinism · two fresh repos run the matrix identically → the ledger tails agree and the derived remote rows agree (tokens labelled)",
    { timeout: 120_000 }, // two repositories × two real-git walks — headroom, not a hang mask
    () => {
      const trace = (): string => {
        let captured: string | undefined;
        withGitHubVertical("v6-determinism", (vertical) => {
          const stores = gitStores(vertical.repo);
          const world = liveWorld();
          const base: RunOptions = {
            state: vertical.state,
            stores,
            world,
            lineId: "main",
            intents: [beta],
            declarations: vertical.declarations,
          };
          const run1 = runGitRelease(base);
          const run2 = runGitRelease(base);
          captured = JSON.stringify({
            t1: normalizedTail(stores, run1.attempt.attemptId),
            t2: normalizedTail(stores, run2.attempt.attemptId),
            remote: publicationTrace(vertical, GOLDEN.ladder[0]),
          });
        });
        if (captured === undefined) {
          throw new Error("fixture broken: no trace captured");
        }
        return captured;
      };
      expect(trace()).toStrictEqual(trace());
    },
  );
});

// ---------------------------------------------------------------------------
// V7 — recovery, over the adapter's own stack
// ---------------------------------------------------------------------------

describe("V7 — recovery, github-backed", () => {
  for (const stage of CANONICAL_STAGES) {
    it(
      `V7 · ${stage}-window · the git-backed crash classifies from the recorded tail and the resume completes the run`,
      { timeout: 80_000 }, // two real-git walks per window — headroom, not a hang mask
      () => {
        withGitHubVertical("v7-window", (vertical) => {
          const stores = gitStores(vertical.repo);
          const world = liveWorld();
          const base: RunOptions = {
            state: vertical.state,
            stores,
            world,
            lineId: "main",
            intents: [beta],
          };
          const stopped = runGitRelease({ ...base, crashAfterStartOf: stage }, false);
          expect(stopped.stoppedAt).toBe(stage);
          // The write-ahead start is a durable git commit — a fresh ledger on
          // the same repo reloads it and classifies identically.
          expect(classifyResume(stopped.attempt, gitStores(vertical.repo).ledger)).toStrictEqual({
            kind: "resume",
            from: stage,
          });
          const resumed = runGitRelease(base, false);
          expect(resumed.stoppedAt).toBeNull();
          // The resumed run's completions equal the uninterrupted golden —
          // exactly the canonical sequence, no re-execution, no skip.
          expect(completedKeys(resumed)).toStrictEqual([...CANONICAL_STAGES]);
        });
      },
    );
  }

  it(
    "V7 · artifact-window · the walk stops inside the DAG and the resume completes changelog and the rest",
    { timeout: 120_000 }, // two declared real-git walks — headroom, not a hang mask
    () => {
      withGitHubVertical("v7-artifact", (vertical) => {
        const stores = gitStores(vertical.repo);
        const world = liveWorld();
        const base: RunOptions = {
          state: vertical.state,
          stores,
          world,
          lineId: "main",
          intents: [beta],
          declarations: vertical.declarations,
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
        expect(completedKeys(resumed)).toStrictEqual(referenceKeys());
      });
    },
  );

  it(
    "V7 · hook:announce crash · the mid-effect crash classifies and the resume runs the effect exactly once more",
    { timeout: 120_000 }, // two declared real-git walks — headroom, not a hang mask
    () => {
      withGitHubVertical("v7-announce", (vertical) => {
        const stores = gitStores(vertical.repo);
        const world = liveWorld();
        const base: RunOptions = {
          state: vertical.state,
          stores,
          world,
          lineId: "main",
          intents: [beta],
          declarations: vertical.declarations,
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
        expect(resumed.stoppedAt).toBeNull();
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
        expect(completedKeys(resumed)).toStrictEqual(referenceKeys());
      });
    },
  );

  it(
    "V7 · recovery composes with publication · a crashed-and-resumed run derives the same remote rows as an uninterrupted one",
    { timeout: 120_000 }, // three real-git walks plus the adapter doors — headroom, not a hang mask
    () => {
      const crashedThenResumed = (): string => {
        let trace: string | undefined;
        withGitHubVertical("v7-compose-crash", (vertical) => {
          const stores = gitStores(vertical.repo);
          const world = liveWorld();
          const base: RunOptions = {
            state: vertical.state,
            stores,
            world,
            lineId: "main",
            intents: [beta],
            declarations: vertical.declarations,
          };
          const stopped = runGitRelease({ ...base, crashAfterStartOf: "tag" }, false);
          expect(stopped.stoppedAt).toBe("tag");
          const resumed = runGitRelease(base);
          trace = publicationTrace(vertical, asMinted(resumed.mintedTag));
        });
        if (trace === undefined) {
          throw new Error("fixture broken: no trace captured");
        }
        return trace;
      };
      const uninterrupted = (): string => {
        let trace: string | undefined;
        withGitHubVertical("v7-compose-clean", (vertical) => {
          const run = runGitRelease({
            state: vertical.state,
            stores: gitStores(vertical.repo),
            world: liveWorld(),
            lineId: "main",
            intents: [beta],
            declarations: vertical.declarations,
          });
          trace = publicationTrace(vertical, asMinted(run.mintedTag));
        });
        if (trace === undefined) {
          throw new Error("fixture broken: no trace captured");
        }
        return trace;
      };
      expect(crashedThenResumed()).toStrictEqual(uninterrupted());
    },
  );

  it(
    "V7 · channel-transition window · the promote crash re-executes the uncompleted transition exactly once and a second replay classifies noop",
    { timeout: 120_000 },
    () => {
      withGitHubVertical("v7-channel", (vertical) => {
        const stores = gitStores(vertical.repo);
        const world = liveWorld();
        // Build the promote-ready world: beta.1, beta.2 (the ladder), then
        // rc.1 as the in-flight prerelease the promotion will consume.
        runGitRelease({
          state: vertical.state,
          stores,
          world,
          lineId: "main",
          intents: [beta],
        });
        runGitRelease({
          state: vertical.state,
          stores,
          world,
          lineId: "main",
          intents: [beta],
        });
        runGitRelease({
          state: vertical.state,
          stores,
          world,
          lineId: "main",
          intents: [rc],
        });
        const base: RunOptions = {
          state: vertical.state,
          stores,
          world,
          lineId: "main",
          intents: [promote],
          declarations: vertical.declarations,
        };
        // The promote crashes between the write-ahead `started` record and
        // the application's execution of the planned moves (ADR-0012
        // decision 3): the store still holds the pre-promotion targets.
        const stopped = runGitRelease({ ...base, crashAfterStartOf: "channel-transition" }, false);
        expect(stopped.stoppedAt).toBe("channel-transition");
        // The write-ahead start is a durable git commit — a fresh ledger on
        // the same repo reloads it and classifies identically.
        expect(classifyResume(stopped.attempt, gitStores(vertical.repo).ledger)).toStrictEqual({
          kind: "resume",
          from: "channel-transition",
        });
        // The application never ran on the crashed attempt: no
        // channel-transition record joins the persisted tail yet.
        const beforeResume = gitStores(vertical.repo)
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
        expect(vertical.state.binding.channels.read("stable")).toStrictEqual({
          id: "stable",
          target: { line: "main", version: "5.0.0" },
        });
        expect(vertical.state.binding.channels.read("next")).toStrictEqual({
          id: "next",
          target: { line: "main", version: "5.0.0" },
        });
        expect(vertical.state.binding.channels.read("beta")).toStrictEqual({
          id: "beta",
          target: { line: "main", version: "4.9.1" },
        });
        expect(vertical.state.binding.channels.read("rc")).toStrictEqual({
          id: "rc",
          target: { line: "main", version: "4.9.1" },
        });
        expect(vertical.state.binding.channels.read("lts")).toStrictEqual({
          id: "lts",
          target: { line: "1.9-lts", version: "1.9.1" },
        });
        // The tail carries exactly two channel-transition records from the
        // resume's application — the E-01 re-execution landed once.
        const channelRecords = gitStores(vertical.repo)
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
          channels: vertical.state.binding.channels,
          ledger: gitStores(vertical.repo).ledger,
        });
        expect(replay.map((move) => move.outcome.kind)).toStrictEqual(["noop", "noop"]);
        const replayedRecords = gitStores(vertical.repo)
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
        expect(completedKeys(resumed)).toStrictEqual(referenceKeys());
      });
    },
  );

  it(
    "V7 · hook:attest failure · the refusal records, the attempt blocks, and only a resolution re-arms",
    { timeout: 120_000 },
    () => {
      withGitHubVertical("v7-attest", (vertical) => {
        const stores = gitStores(vertical.repo);
        const world = liveWorld();
        const hooks = matrixHooks();
        const declaration: Declarations = {
          ...vertical.declarations,
          hooks: [hooks.attest, hooks.notify],
          // The effect RUNS and its observation refuses the proof — the
          // engine records what the caller-injected seam returned (§2.5).
          hookEffects: hookEffects({
            attest: {},
            notify: { evidence: "evidence:notify" },
          }),
        };
        const base: RunOptions = {
          state: vertical.state,
          stores,
          world,
          lineId: "main",
          intents: [beta],
          declarations: declaration,
        };
        const stopped = runGitRelease(base, false);
        expect(stopped.stoppedAt).toBe("publish");
        expect(stopped.attempt.state).toBe("blocked");
        expect(stopped.attempt.blockedCause).toBe("validation:hook:attest:evidence-present");
        // The failure is a recorded step in the git ledger, never a throw —
        // `failed` sits in the tail.
        expect(stopped.stores.ledger.step(stopped.attempt.attemptId, "hook:attest")).toBe("failed");
        // Blocked without a recorded resolution: escalation, not revival (E-04).
        expect(classifyResume(stopped.attempt, stopped.stores.ledger).kind).toBe("escalate");
      });
    },
  );

  it(
    "V7 · hook:sign retried · the first refusal blocks, the resolution re-arms, the second observation lands beside it",
    { timeout: 120_000 },
    () => {
      withGitHubVertical("v7-sign", (vertical) => {
        const stores = gitStores(vertical.repo);
        const world = liveWorld();
        const hooks = matrixHooks();
        let signCalls = 0;
        const signEffect: HookEffect = (input) => {
          signCalls += 1;
          return {
            attribution: { attemptId: input.attemptId, actor: "automation" },
            ...(signCalls === 1 ? {} : { contentFingerprint: `content:sign:${String(signCalls)}` }),
          };
        };
        const effects: ReadonlyMap<string, HookEffect> = new Map<string, HookEffect>([
          ...hookEffects({ notify: { evidence: "evidence:notify" } }),
          ["sign", signEffect],
        ]);
        const declaration: Declarations = {
          ...vertical.declarations,
          hooks: [hooks.sign, hooks.notify],
          hookEffects: effects,
        };
        const base: RunOptions = {
          state: vertical.state,
          stores,
          world,
          lineId: "main",
          intents: [beta],
          declarations: declaration,
        };
        const stopped = runGitRelease(base, false);
        expect(stopped.stoppedAt).toBe("publish");
        expect(stopped.attempt.state).toBe("blocked");
        expect(stopped.attempt.blockedCause).toBe(
          "validation:hook:sign:content-fingerprint-present",
        );

        // resolveBlocked is the only re-arm door: the resolution appends to
        // the git ledger (a durable commit), the attempt re-arms, and
        // classification walks back to the refused key (§2.7).
        resolveBlocked(
          stopped.attempt,
          "hook:sign",
          { kind: "revalidation", planFingerprint: stopped.attempt.planFingerprint },
          stopped.stores.ledger,
          actor(stopped.attempt),
        );
        const rearmed = resume(stopped.attempt, "revalidation recorded");
        expect(classifyResume(rearmed, stopped.stores.ledger)).toStrictEqual({
          kind: "resume",
          from: "hook:sign",
        });
        // Re-run over the SAME persisted repo: the walk re-enters at the
        // recorded tail's refused key and the second observation lands.
        stores.rearm(rearmed);
        const resumed = runGitRelease(base, false);
        expect(resumed.stoppedAt).toBeNull();
        // The retry appends beside the refusal — the failed record stays in
        // the git tail, never rewritten (§2.5).
        expect(stopped.stores.ledger.step(stopped.attempt.attemptId, "hook:sign")).toBe(
          "completed",
        );
        const signRecords = stopped.stores.ledger
          .tail(stopped.attempt.attemptId)
          .flatMap((record) =>
            record.kind === "step" && record.record.stepKey === "hook:sign"
              ? [record.record.to]
              : [],
          );
        expect(signRecords).toStrictEqual(["started", "failed", "started", "completed"]);
        expect(signCalls).toBe(2);
        expect(completedKeys(resumed)).toStrictEqual(referenceKeys(declaration));
      });
    },
  );
});

// ---------------------------------------------------------------------------
// V8 — concurrency at the transport seam (ADR-0011's hostile pattern)
// ---------------------------------------------------------------------------

describe("V8 — concurrency, github-backed (the hostile transport)", () => {
  it(
    "V8 · exclusive claim · the register accepts exactly one holder per scope and the loser's denial names the winner",
    { timeout: 80_000 }, // one real-git walk — headroom, not a hang mask
    () => {
      withGitHubVertical("v8-exclusive", (vertical) => {
        const stores = gitStores(vertical.repo);
        const world = liveWorld();
        const run = runGitRelease({
          state: vertical.state,
          stores,
          world,
          lineId: "main",
          intents: [beta],
        });
        const attemptB = start(
          openAttempt(stores.register, {
            planId: run.attempt.planId,
            planFingerprint: run.attempt.planId,
          }),
        );
        const denial = asDenied(
          vertical.state.binding.claims.acquire(run.scope, attemptB.attemptId),
        );
        expect(denial.holder).toBe(run.attempt.attemptId);
        // E-08 at this layer too: the denial carries the winner's recorded
        // sequence, and the bounded retry recomputes from it — the base the
        // re-plan consumes, never a max.
        expect(denial.holderSequence).toBe(1);
        expect(retrySequence(denial, 0, { maxRetries: 1 })).toStrictEqual({
          kind: "retry",
          sequence: 2,
        });
        expect(readClaimsAt(vertical.state, claimRegisterRefFor("main"))).toHaveLength(1);
      });
    },
  );

  it(
    "V8 · hostile transport · writer B lands between the idempotency read and the create — the re-publish lands ok, never a duplicate",
    { timeout: 80_000 }, // one declared real-git walk — headroom, not a hang mask
    () => {
      withGitHubVertical("v8-lands", (vertical) => {
        const run = runGitRelease({
          state: vertical.state,
          stores: gitStores(vertical.repo),
          world: liveWorld(),
          lineId: "main",
          intents: [beta],
          declarations: vertical.declarations,
        });
        const tag = asMinted(run.mintedTag);
        const remote = seedRemote(vertical);
        const adapter = vertical.adapter(remote.transport);
        expect(adapter.syncRemote().refs.every((row) => row.outcome.state === "pushed")).toBe(true);
        // Writer B publishes the SAME recorded changelog while A's create is
        // in flight: the arm-gated interception lands it between A's
        // idempotency read and A's create.
        const recorded = vertical.state.binding.content.file(
          vertical.changelogDigest,
          CHANGELOG_PATH,
        );
        if (recorded === null) {
          throw new Error("fixture broken: the recorded tree holds no changelog");
        }
        remote.armConcurrentWriter(recorded);
        // The provider answers the raced create determinately (422
        // already_exists, issue #178) — the recorded conflict decision,
        // never the retryable class the collapse wore.
        const first = adapter.publishRelease(tag);
        if (first.kind !== "refused" || first.reason !== "release-conflict") {
          throw new Error(
            `expected the raced create's release-conflict refusal, got ${JSON.stringify(first)}`,
          );
        }
        expect(first.detail).toContain("already exists");
        expect(remote.concurrentWriterFired()).toBe(true);
        // The conflict decision's caller action — the idempotent re-run —
        // re-evaluates: the idempotency read now finds the remote already
        // satisfied — the re-run lands as ok, and no second create is ever
        // issued (never both-accept).
        expect(adapter.publishRelease(tag)).toStrictEqual({
          kind: "ok",
          url: `https://github.fake/ecoma-io/release-craft/releases/tag/${tag}`,
        });
        expect(remote.releases.size).toBe(1);
        expect(remote.releases.get(tag)).toBe(recorded);
        expect(adapter.verifyRelease(tag)).toStrictEqual({ kind: "verified" });
        expect(remote.calls.filter((call) => call.init?.method === "POST")).toHaveLength(1);
      });
    },
  );

  it(
    "V8 · hostile transport · writer B lands a divergent body in the create window — the re-publish denies as release-conflict, never both-accept",
    { timeout: 80_000 }, // one declared real-git walk — headroom, not a hang mask
    () => {
      withGitHubVertical("v8-denies", (vertical) => {
        const run = runGitRelease({
          state: vertical.state,
          stores: gitStores(vertical.repo),
          world: liveWorld(),
          lineId: "main",
          intents: [beta],
          declarations: vertical.declarations,
        });
        const tag = asMinted(run.mintedTag);
        const remote = seedRemote(vertical);
        const adapter = vertical.adapter(remote.transport);
        expect(adapter.syncRemote().refs.every((row) => row.outcome.state === "pushed")).toBe(true);
        // Writer B publishes a DIFFERENT body for the same tag in the window.
        remote.armConcurrentWriter(DIVERGENT_BODY);
        // The raced create is answered determinately (issue #178): the
        // recorded conflict decision, never a retryable failure.
        const raced = adapter.publishRelease(tag);
        if (raced.kind !== "refused" || raced.reason !== "release-conflict") {
          throw new Error(
            `expected the raced create's release-conflict refusal, got ${JSON.stringify(raced)}`,
          );
        }
        expect(remote.concurrentWriterFired()).toBe(true);
        // The re-evaluation reads B's release, compares it against the
        // recorded changelog, and denies — the recorded conflict decision.
        const second = adapter.publishRelease(tag);
        if (second.kind !== "refused" || second.reason !== "release-conflict") {
          throw new Error(`expected a release-conflict refusal, got ${JSON.stringify(second)}`);
        }
        expect(remote.releases.size).toBe(1);
        expect(remote.releases.get(tag)).toBe(DIVERGENT_BODY);
        expect(adapter.verifyRelease(tag)).toMatchObject({
          kind: "refused",
          reason: "release-conflict",
        });
        expect(remote.calls.filter((call) => call.init?.method === "POST")).toHaveLength(1);
      });
    },
  );
});

// ---------------------------------------------------------------------------
// V9 — divergence, over the adapter's own stack
// ---------------------------------------------------------------------------

describe("V9 — divergence, github-backed", () => {
  it(
    "V9 · propagation · the carried fix mints per line, plans stay single-line and disjoint, and the reconciled remote verifies every line",
    { timeout: 120_000 }, // four real-git walks — headroom, not a hang mask
    () => {
      withGitHubVertical("v9-propagation", (vertical) => {
        const stores = gitStores(vertical.repo);
        const world = liveWorld();
        const sideLines = ["4.8.x", "3.x", "2.x", "1.9-lts"] as const;
        const carried = sideLines.map((lineId) =>
          runGitRelease({
            state: vertical.state,
            stores,
            world,
            lineId,
            intents: [{ kind: "release" }],
          }),
        );
        expect(carried.map((run) => run.mintedTag)).toStrictEqual(
          sideLines.map((lineId) => GOLDEN.sides[lineId]),
        );
        expect(new Set(carried.map((run) => run.attempt.planId)).size).toBe(4);
        const minted = world.tags.map((tag) => tag.name);
        expect(new Set(minted).size).toBe(minted.length);
        // The adapter's remote surface over the four lines: the sync lands
        // every recorded ref, and the reconciliation — over the complete
        // paginated listing — verifies every recorded tag and claims no
        // divergence.
        const remote = seedRemote(vertical);
        const adapter = vertical.adapter(remote.transport);
        expect(adapter.syncRemote().refs.every((row) => row.outcome.state === "pushed")).toBe(true);
        const report = adapter.reconcile();
        if (report.tags.state !== "listed" || report.releases.state !== "listed") {
          throw new Error("fixture broken: the clean listings did not complete");
        }
        expect(report.tags.verifiedTags).toStrictEqual(["1.9.2", "2.4.1", "3.3.0", "4.8.7"]);
        expect(report.tags.divergences).toStrictEqual([]);
        expect(report.releases.divergences).toStrictEqual([]);
        expect(report.tags.pagination).toBe("complete");
      });
    },
  );

  it("V9 · collision · a two-lines-one-tag plan refuses naming the tag, both lines, both heads (M-11)", () => {
    const outcome = plan({
      policy: {
        digest: "sha256:" + "c".repeat(64),
        bumpMappingId: "default",
        prereleaseLadder: ["rc"],
        prereleaseSeed: "0",
        pre10Dampening: true,
        selfReferenceNamespace: "Release-Craft:",
        tagFormats: {},
      },
      repository: {
        commits: [
          {
            sha: "c1",
            parents: [],
            message: "feat: base",
            committedAt: COMMITTED_AT,
            containingRefs: ["feed/a", "feed/b"],
          },
          {
            sha: "c2",
            parents: ["c1"],
            message: "fix: on a",
            committedAt: COMMITTED_AT,
            containingRefs: ["feed/a"],
          },
          {
            sha: "c3",
            parents: ["c1"],
            message: "fix: on b",
            committedAt: COMMITTED_AT,
            containingRefs: ["feed/b"],
          },
        ],
        refs: [
          { name: "feed/a", head: "c2" },
          { name: "feed/b", head: "c3" },
        ],
      },
      history: { tags: [{ name: "1.0.0", commit: "c1" }] },
      lines: [
        { id: "a", feedRef: "feed/a", lifecycle: "active", declared: true, publishes: "app" },
        { id: "b", feedRef: "feed/b", lifecycle: "active", declared: true, publishes: "web" },
      ],
      components: [
        { name: "app", manifestVersion: "1.0.0", paths: ["package.json"] },
        { name: "web", manifestVersion: "1.0.0", paths: ["package.json"] },
      ],
      intents: [{ kind: "release" }],
    });
    if (outcome.kind !== "refused") {
      throw new Error("fixture broken: the collision world planned instead of refusing");
    }
    expect(outcome.refusal.cause).toBe("version-collision");
    expect(outcome.refusal.commits).toStrictEqual(["c2", "c3"]);
    expect(outcome.refusal.detail).toContain('"1.0.1"');
    expect(outcome.refusal.detail).toContain('"a"');
    expect(outcome.refusal.detail).toContain('"b"');
  });
});

// ---------------------------------------------------------------------------
// V10 — reconciliation per R-10..R-12 under D30's per-listing outcomes
// ---------------------------------------------------------------------------

describe("V10 — reconciliation, github-backed", () => {
  it(
    "V10 · clean · the recorded surface reconciles clean: both listings listed over the complete pagination, every recorded tag verified",
    { timeout: 80_000 }, // one declared real-git walk — headroom, not a hang mask
    () => {
      withGitHubVertical("v10-clean", (vertical) => {
        const run = runGitRelease({
          state: vertical.state,
          stores: gitStores(vertical.repo),
          world: liveWorld(),
          lineId: "main",
          intents: [beta],
          declarations: vertical.declarations,
        });
        const tag = asMinted(run.mintedTag);
        const remote = seedRemote(vertical);
        const adapter = vertical.adapter(remote.transport);
        expect(adapter.syncRemote().refs.every((row) => row.outcome.state === "pushed")).toBe(true);
        expect(adapter.publishRelease(tag)).toMatchObject({ kind: "ok" });
        expect(adapter.verifyRelease(tag)).toStrictEqual({ kind: "verified" });
        const report = adapter.reconcile();
        expect(report.tags).toStrictEqual({
          state: "listed",
          listed: 1,
          pagination: "complete",
          divergences: [],
          verifiedTags: [tag],
        });
        expect(report.releases).toStrictEqual({
          state: "listed",
          listed: 1,
          pagination: "complete",
          divergences: [],
        });
      });
    },
  );

  it(
    "V10 · out-of-band tag · the next reconcile detects the remote's out-of-band tag across pagination (R-11)",
    { timeout: 90_000 }, // three real-git walks — headroom, not a hang mask
    () => {
      withGitHubVertical("v10-unadopted-tag", (vertical) => {
        const stores = gitStores(vertical.repo);
        const world = liveWorld();
        const base: RunOptions = {
          state: vertical.state,
          stores,
          world,
          lineId: "main",
          intents: [beta],
        };
        runGitRelease(base);
        runGitRelease(base);
        const rcRun = runGitRelease({ ...base, intents: [rc] });
        const remote = seedRemote(vertical);
        const adapter = vertical.adapter(remote.transport);
        expect(adapter.syncRemote().refs.every((row) => row.outcome.state === "pushed")).toBe(true);
        const before = adapter.reconcile();
        if (before.tags.state !== "listed") {
          throw new Error("fixture broken: the clean listing did not complete");
        }
        expect(before.tags.divergences).toStrictEqual([]);
        expect(before.tags.verifiedTags).toStrictEqual([
          GOLDEN.ladder[0],
          GOLDEN.ladder[1],
          GOLDEN.ladder[2],
        ]);
        expect(remote.calls.some((call) => call.path.includes("page=2"))).toBe(true);
        // The out-of-band writer lands a tag the binding holds no record of —
        // through no adapter door — and the next reconcile detects it.
        remote.putTag(OUT_OF_BAND_TAG, OUT_OF_BAND_SHA);
        const after = adapter.reconcile();
        if (after.tags.state !== "listed") {
          throw new Error("fixture broken: the divergent listing did not complete");
        }
        expect(after.tags.verifiedTags).toStrictEqual([
          GOLDEN.ladder[0],
          GOLDEN.ladder[1],
          GOLDEN.ladder[2],
        ]);
        expect(after.tags.divergences).toStrictEqual([
          {
            kind: "unadopted-tag",
            tag: OUT_OF_BAND_TAG,
            detail: `the remote has the tag ${OUT_OF_BAND_TAG} at ${OUT_OF_BAND_SHA}, but the binding holds no record of it`,
          },
        ]);
        expect(rcRun.mintedTag).toBe(GOLDEN.ladder[2]);
      });
    },
  );

  it(
    "V10 · out-of-band release · the next reconcile detects a release for a tag the binding holds no record of (R-12)",
    { timeout: 80_000 }, // one real-git walk — headroom, not a hang mask
    () => {
      withGitHubVertical("v10-unadopted-release", (vertical) => {
        const run = runGitRelease({
          state: vertical.state,
          stores: gitStores(vertical.repo),
          world: liveWorld(),
          lineId: "main",
          intents: [beta],
        });
        const remote = seedRemote(vertical);
        const adapter = vertical.adapter(remote.transport);
        expect(adapter.syncRemote().refs.every((row) => row.outcome.state === "pushed")).toBe(true);
        remote.putRelease(OUT_OF_BAND_TAG, DIVERGENT_BODY);
        const report = adapter.reconcile();
        if (report.releases.state !== "listed" || report.tags.state !== "listed") {
          throw new Error("fixture broken: the listings did not complete");
        }
        expect(report.releases.divergences).toStrictEqual([
          {
            kind: "unadopted-release",
            tag: OUT_OF_BAND_TAG,
            detail: `the remote has a release for ${OUT_OF_BAND_TAG}, but the binding holds no record of the tag`,
          },
        ]);
        expect(report.tags.verifiedTags).toStrictEqual([asMinted(run.mintedTag)]);
      });
    },
  );

  it(
    "V10 · moved tag · an out-of-band retarget of a recorded tag is divergence, never silently resolved",
    { timeout: 80_000 }, // one real-git walk — headroom, not a hang mask
    () => {
      withGitHubVertical("v10-moved-tag", (vertical) => {
        const run = runGitRelease({
          state: vertical.state,
          stores: gitStores(vertical.repo),
          world: liveWorld(),
          lineId: "main",
          intents: [beta],
        });
        const tag = asMinted(run.mintedTag);
        const remote = seedRemote(vertical);
        const adapter = vertical.adapter(remote.transport);
        expect(adapter.syncRemote().refs.every((row) => row.outcome.state === "pushed")).toBe(true);
        const before = adapter.reconcile();
        if (before.tags.state !== "listed") {
          throw new Error("fixture broken: the clean listing did not complete");
        }
        expect(before.tags.divergences).toStrictEqual([]);
        // The out-of-band writer retargets the recorded tag; the next
        // reconcile names the drift on both sides — never a silent resolve.
        remote.putTag(tag, OUT_OF_BAND_SHA);
        const after = adapter.reconcile();
        if (after.tags.state !== "listed") {
          throw new Error("fixture broken: the divergent listing did not complete");
        }
        const recordedTarget = recordedTagRows(vertical.state).find((row) => row.name === tag);
        expect(after.tags.divergences).toStrictEqual([
          {
            kind: "unadopted-tag",
            tag,
            detail: `the remote has the tag ${tag} at ${OUT_OF_BAND_SHA}, but the binding records it at ${String(recordedTarget?.target)}`,
          },
        ]);
      });
    },
  );

  it(
    "V10 · refused listing · a rate-limited tags listing is an outcome — never a demotion — and the sibling's comparison stands",
    { timeout: 80_000 }, // one real-git walk — headroom, not a hang mask
    () => {
      withGitHubVertical("v10-refused", (vertical) => {
        const run = runGitRelease({
          state: vertical.state,
          stores: gitStores(vertical.repo),
          world: liveWorld(),
          lineId: "main",
          intents: [beta],
        });
        const remote = seedRemote(vertical);
        const adapter = vertical.adapter(remote.transport);
        expect(adapter.syncRemote().refs.every((row) => row.outcome.state === "pushed")).toBe(true);
        remote.failTags(429, { "x-ratelimit-reset": "123" });
        const report = adapter.reconcile();
        expect(report.tags).toStrictEqual({
          state: "refused",
          reason: "rate-limited",
          detail: "the API's rate limit is exhausted; it resets at 123",
        });
        // The refused listing claims no comparison; the sibling's stands.
        if (report.releases.state !== "listed") {
          throw new Error("fixture broken: the sibling listing was preempted");
        }
        expect(report.releases.divergences).toStrictEqual([]);
        // Both listings were always requested — the failure preempted none.
        expect(remote.calls.map((call) => call.path.split("?")[0])).toStrictEqual([
          "/repos/ecoma-io/release-craft/tags",
          "/repos/ecoma-io/release-craft/releases",
        ]);
        expect(asMinted(run.mintedTag)).toBe(GOLDEN.ladder[0]);
      });
    },
  );

  it(
    "V10 · unobserved listing · an unreachable releases listing claims nothing — never a partial comparison",
    { timeout: 80_000 }, // one real-git walk — headroom, not a hang mask
    () => {
      withGitHubVertical("v10-unobserved", (vertical) => {
        const run = runGitRelease({
          state: vertical.state,
          stores: gitStores(vertical.repo),
          world: liveWorld(),
          lineId: "main",
          intents: [beta],
        });
        const tag = asMinted(run.mintedTag);
        const remote = seedRemote(vertical);
        const adapter = vertical.adapter(remote.transport);
        expect(adapter.syncRemote().refs.every((row) => row.outcome.state === "pushed")).toBe(true);
        remote.failReleases(0);
        const report = adapter.reconcile();
        expect(report.releases).toStrictEqual({ state: "transport-failure" });
        if (report.tags.state !== "listed") {
          throw new Error("fixture broken: the sibling listing was preempted");
        }
        expect(report.tags.verifiedTags).toStrictEqual([tag]);
        expect(report.tags.divergences).toStrictEqual([]);
      });
    },
  );
});

// ---------------------------------------------------------------------------
// V11 — zero-config and the hermetic surface
// ---------------------------------------------------------------------------

describe("V11 — zero-config and the hermetic surface, github-backed", () => {
  it("V11 · zero-config · the adapter opens on a repository path, credentials, and the injected transport — nothing ambient", () => {
    withGitHubVertical("v11-zero", (vertical) => {
      const adapter = vertical.adapter(openFakeRemote().transport);
      // The construction took only the binding, the credentials, and the
      // transport; a repository with nothing recorded syncs to an empty
      // report — no configuration surface ever appeared.
      expect(adapter.syncRemote()).toStrictEqual({ refs: [] });
    });
    // A repository with no origin configured is an environmental fault of
    // the repository itself — thrown loudly, never a remote outcome.
    withTempRepo("v11-no-origin", (repo) => {
      const binding = openGitBinding({ repo, tagNaming: naming });
      const adapter = openGitHubAdapter(binding, credentials, openFakeRemote().transport);
      expect(() => adapter.syncRemote()).toThrow(GitFaultError);
    });
  });

  it(
    "V11 · hermetic surface · the transport sees only adapter-derived calls and no derived row carries token or clock material",
    { timeout: 80_000 }, // one declared real-git walk — headroom, not a hang mask
    () => {
      withGitHubVertical("v11-hermetic", (vertical) => {
        const run = runGitRelease({
          state: vertical.state,
          stores: gitStores(vertical.repo),
          world: liveWorld(),
          lineId: "main",
          intents: [beta],
          declarations: vertical.declarations,
        });
        const tag = asMinted(run.mintedTag);
        const remote = seedRemote(vertical);
        const adapter = vertical.adapter(remote.transport);
        adapter.syncRemote();
        for (const row of recordedTagRows(vertical.state)) {
          remote.putTag(row.name, row.target);
        }
        adapter.publishRelease(tag);
        adapter.verifyRelease(tag);
        adapter.reconcile();
        // Every call is an adapter-derived API path — never ambient material,
        // never the credential.
        for (const call of remote.calls) {
          expect(call.path.startsWith("/repos/ecoma-io/release-craft/")).toBe(true);
        }
        const surface = JSON.stringify({
          calls: remote.calls,
          releases: [...remote.releases.entries()],
          urls: [...remote.releaseUrls.entries()],
        });
        expect(surface.includes("t0k3n")).toBe(false);
        expect(/\d{4}-\d{2}-\d{2}T/.test(surface)).toBe(false);
      });
    },
  );
});
