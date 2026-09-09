/**
 * The certification fixture's A-git cells (phase 14 contract §3.3,
 * `git-01` … `git-14`; `git-13` is census-only and enforced by the exit
 * table's cross-pin — see the manifest). Every cell drives the real git
 * binding over a hermetic repository: the process transport through the
 * built bin, the boundary transport through the independent construction
 * (`assembleGitBinding` over an opened binding, never the CLI's selection
 * module). The byte-pinned cells diff their live bytes against the
 * committed `expected/*.json` after the recorded projection (§4.3) — the
 * repository path becomes REPO and the claim token's whole value becomes
 * CLAIM; everything else compares verbatim, and `memory-10` is the control
 * proving the projection is the only delta.
 *
 * Durability's crash windows are seated the only way a host's death can be
 * seated at this surface: the declared hook effect throwing mid-walk (the
 * memory suite's `memory-06` posture — a caller posture, not user code,
 * §8). The fault escapes the door with the write-ahead start durable, and
 * the resume classifies from the reloaded tail — the attempt's identity
 * recovered from the repository, the only survivor (its ledger refs are
 * named by attempt id, `ledgerAttemptIds`).
 *
 * One recorded finding shapes `git-05`'s boundary half: the raised-bound
 * retry over the durable register is unreachable AS THE CONTRACT PINS IT
 * (a published `0`) — the retried scope always outruns the plan's own tag
 * by one, and the binding's mint door refuses the walk at the mismatch
 * (`no claim held by attempt … derives tag …`). The cell keeps the
 * implementable halves (the CLI's bound-0 conflict, the fold parity) and
 * records the finding verbatim in its manifest provenance.
 */

import { describe, expect, it } from "vitest";

import {
  InvalidExecutionTransitionError,
  type ClaimScope,
  type LedgerRecord,
  type RunOutcome,
} from "../../src/index.js";
import {
  GitChannelStore,
  claimRegisterRefFor,
  commitRecord,
  readRef,
} from "../../src/adapters/git/index.js";
import { beta, fullDeclaration, promote, rc, runRequest, runToWorld } from "../app/harness.js";
import { liveWorld } from "../vertical/matrix.js";
import { naming, recordedTags } from "../vertical/matrix-git.js";
import {
  attestDeclaration,
  crashedHandle,
  docBytes,
  expectedScenario,
  gitAssembly,
  gitAssemblyWithChannels,
  gitCutScenario,
  gitDoc,
  gitFaultScenarios,
  gitPromoteScenario,
  gitRunArgs,
  ladderExtraTags,
  ledgerAttemptIds,
  ledgerPlanId,
  ledgerTail,
  ledgerTailBytes,
  lockChannelRefs,
  project,
  rawGitClaims,
  runBin,
  seededHead,
  withSeededRepo,
} from "./drive.js";

// ---------------------------------------------------------------------------
// Suite-local reading helpers
// ---------------------------------------------------------------------------

/** One step's recorded transitions, append order. */
const recordedTos = (tail: readonly LedgerRecord[], stepKey: string): readonly string[] =>
  tail.flatMap((record) =>
    record.kind === "step" && record.record.stepKey === stepKey ? [record.record.to] : [],
  );

/** The plan's ordinal counter bytes — the derived-ordinal growth made
 * legible (the register has no read door; its ref content is the record). */
const ordinalCounter = (git: (args: readonly string[]) => string): { nextOrdinal: number } => {
  const ref = git(["for-each-ref", "--format=%(refname)", "refs/ecoma/register/"])
    .split("\n")
    .filter((line) => line.length > 0)[0];
  if (ref === undefined) {
    throw new Error("fixture broken: no attempt register ref in the repository");
  }
  const tip = readRef(git, ref);
  if (tip === null) {
    throw new Error(`fixture broken: the attempt register ref ${ref} reads as absent`);
  }
  return JSON.parse(commitRecord(git, tip)) as { nextOrdinal: number };
};

/** The line's claim-register records — the durable claims the denials and
 * mints adjudicate from (ADR-0011 decision 3's named read exception). */
const claimRegisterRecords = (
  git: (args: readonly string[]) => string,
  lineId: string,
): readonly {
  readonly scope: ClaimScope;
  readonly token: string;
  readonly holder: string;
}[] => {
  const tip = readRef(git, claimRegisterRefFor(lineId));
  if (tip === null) {
    return [];
  }
  return (JSON.parse(commitRecord(git, tip)) as { claims: [] }).claims;
};

/** The child's rendered outcome. */
const rendered = (child: { stdout: string }): RunOutcome => JSON.parse(child.stdout) as RunOutcome;

/** The ladder staged through the boundary door over the real repository —
 * the world's history accumulates the three prerelease tags, the minted
 * tags stand in the repo. */
const stageLadder = (repo: string, world: ReturnType<typeof liveWorld>, target: string): void => {
  const engine = gitAssembly(repo);
  for (const intent of [beta, beta, rc]) {
    const staged = runToWorld(engine, world, {
      ...runRequest(world, "main", [intent]),
      targets: { main: target },
    });
    if (staged.kind !== "published") {
      throw new Error(`fixture broken: the ladder stage got ${staged.kind}`);
    }
  }
};

/** A run whose announce hook throws on its first invocation — the crash
 * seat shared by the durability cells. The announce hook is the walk's
 * last declared step: everything before it (the mint is the completion's
 * own act) stands durable when the fault escapes. */
const crashingDeclaration = (message: string) => {
  const declaration = fullDeclaration();
  const effects = new Map(declaration.hookEffects ?? []);
  effects.set("announce", () => {
    throw new Error(message);
  });
  return { ...declaration, hookEffects: effects };
};

/** The boundary request over the SAME closed document the process transport
 * carries — the plan id both transports compute must be one plan's, so a
 * boundary-seeded record is the record the fresh process answers. The
 * target is the run line's own seeded head (the mint's recorded base). */
const gitBoundaryRequest = (
  heads: Readonly<Record<string, string>>,
  intents: readonly (typeof beta | typeof promote | typeof rc)[],
  declarations?: ReturnType<typeof attestDeclaration> | ReturnType<typeof crashingDeclaration>,
) => ({
  input: gitDoc("main", [...intents], heads),
  lineIds: ["main"],
  intents,
  actor: "automation",
  targets: { main: seededHead(heads, "main") },
  ...(declarations === undefined ? {} : { declarations }),
});

/** A run whose announce hook throws, over the shared document. */
const crashingRequest = (heads: Readonly<Record<string, string>>, message: string) =>
  gitBoundaryRequest(heads, [beta], crashingDeclaration(message));

/** The channel store whose first move lands through the real store and
 * then kills the host — the crash window inside the channel-transition
 * stage: the store holds the landed move, the ledger holds no record of
 * it. The memory suite's caller posture (§8: the declared effect, never
 * user code) applied at the port, because the git binding's walk exposes
 * no hook anchor mid-stage. */
const dyingAfterFirstMove = (real: GitChannelStore) => {
  let moves = 0;
  return {
    read: (channelId: string) => real.read(channelId),
    list: () => real.list(),
    applyTransition: (move: Parameters<GitChannelStore["applyTransition"]>[0]) => {
      const outcome = real.applyTransition(move);
      moves += 1;
      if (moves > 1) {
        return outcome;
      }
      throw new Error("the host died between the channel moves");
    },
  };
};

/** The divergent seat: the store's first move lands through the real
 * store and then kills the host (the crash window), and the replay's
 * decision is raced — a foreign move lands just before the delegate, so
 * the store's own re-read finds neither the move's prior nor its target
 * standing and conflicts (ADR-0012 decision 4's refusal). One port, both
 * halves of the divergent story: the carrying engine seats the crash and
 * the replay. */
const divergentSeat = (
  real: GitChannelStore,
  foreign: Parameters<GitChannelStore["applyTransition"]>[0],
) => {
  let calls = 0;
  return {
    read: (channelId: string) => real.read(channelId),
    list: () => real.list(),
    applyTransition: (move: Parameters<GitChannelStore["applyTransition"]>[0]) => {
      calls += 1;
      if (calls === 1) {
        real.applyTransition(move);
        throw new Error("the host died between the channel moves");
      }
      real.applyTransition(foreign);
      return real.applyTransition(move);
    },
  };
};

// ---------------------------------------------------------------------------
// The cells
// ---------------------------------------------------------------------------

describe("the certification fixture · A-git", () => {
  it(
    "git-01 · W2 · the flagship promote walk through the process — the minted 5.0.0, the drives riding verbatim, the envelope as reviewed bytes",
    { timeout: 45_000 },
    () => {
      withSeededRepo("cert-git-01", (repo, git, heads) => {
        const child = gitPromoteScenario(repo, heads);
        expect(child.status).toBe(0);
        expect(child.stderr).toBe("");
        const outcome = rendered(child);
        expect(outcome.kind).toBe("published");
        if (outcome.kind !== "published") {
          throw new Error("expected a published outcome");
        }
        expect(outcome.tag).toBe("5.0.0");
        expect(outcome.drives.length).toBeGreaterThan(0);
        expect(recordedTags(git, naming.namespaces)).toContain("5.0.0");

        // The byte layer: the projected envelope, diffed verbatim.
        const recorded = expectedScenario("git-01", "promote (the process envelope)");
        expect(child.status).toBe(recorded.exit);
        expect(project(child.stdout, repo)).toBe(recorded.stdout);
      });
    },
  );

  it(
    "git-02 · W3 · the maintenance cut through the process — cross-line independence, the second byte-pinned walk",
    { timeout: 45_000 },
    () => {
      withSeededRepo("cert-git-02", (repo, git, heads) => {
        const child = gitCutScenario(repo, heads);
        expect(child.status).toBe(0);
        expect(child.stderr).toBe("");
        const outcome = rendered(child);
        expect(outcome.kind).toBe("published");
        if (outcome.kind !== "published") {
          throw new Error("expected a published outcome");
        }
        expect(outcome.tag).toBe("4.8.7");
        // M-02: the cut never touched the ladder line.
        expect(recordedTags(git, naming.namespaces)).toStrictEqual(["4.8.7"]);

        const recorded = expectedScenario("git-02", "cut (the process envelope)");
        expect(child.status).toBe(recorded.exit);
        expect(project(child.stdout, repo)).toBe(recorded.stdout);
      });
    },
  );

  it(
    "git-03 · W1 (second run) · the sequence advanced across processes — the ladder's second rung through a fresh process",
    { timeout: 45_000 },
    () => {
      withSeededRepo("cert-git-03", (repo, git, heads) => {
        const head = seededHead(heads, "main");
        // Rung 1: the first process mints beta.1; its lease stands in the
        // durable claim register — the only recorded memory the second
        // process inherits.
        const first = runBin(gitRunArgs(repo, "main"), {
          input: docBytes(gitDoc("main", [beta], heads)),
        });
        expect(first.status).toBe(0);
        expect(rendered(first)).toMatchObject({ kind: "published", tag: "5.0.0-beta.1" });

        // Rung 2: a second, fresh process — its document observes rung 1
        // (W1's own definition of the second run), the register holds the
        // first lease, and the beta stream advances to `.2`.
        const second = runBin(gitRunArgs(repo, "main"), {
          input: docBytes(gitDoc("main", [beta], heads, [{ name: "5.0.0-beta.1", commit: head }])),
        });
        expect(second.status).toBe(0);
        expect(second.stderr).toBe("");
        const outcome = rendered(second);
        expect(outcome.kind).toBe("published");
        if (outcome.kind !== "published") {
          throw new Error("expected a published outcome");
        }
        expect(outcome.tag).toBe("5.0.0-beta.2");
        expect(recordedTags(git, naming.namespaces)).toStrictEqual([
          "5.0.0-beta.1",
          "5.0.0-beta.2",
        ]);
      });
    },
  );

  it(
    "git-04 · W5 × I1 · E-07 over the durable register — the denial names the winner's attempt id, the loser's records stand",
    { timeout: 120_000 },
    () => {
      withSeededRepo("cert-git-04", (repo, _git, heads) => {
        // The process half: the promote publishes; the identical second
        // process is denied, naming the first attempt.
        const first = gitPromoteScenario(repo, heads);
        expect(first.status).toBe(0);
        const winnerHandle = (rendered(first) as { handle: { attemptId: string } }).handle;
        const second = gitPromoteScenario(repo, heads);
        expect(second.status).toBe(11);
        expect(second.stderr).toBe("");
        const denied = rendered(second);
        expect(denied.kind).toBe("denied");
        if (denied.kind !== "denied") {
          throw new Error("expected a denied outcome");
        }
        expect(denied.holder).toBe(winnerHandle.attemptId);
        expect(denied.drives).toStrictEqual([]);

        // The boundary half: a blocked winner holds the stable-version
        // claim; a fresh binding's loser — the plan's next durable ordinal —
        // is denied naming it, and the loser's own records stand.
        withSeededRepo("cert-git-04-boundary", (repo2, git2, heads2) => {
          const target2 = seededHead(heads2, "main");
          const world = liveWorld();
          stageLadder(repo2, world, target2);
          const winner = gitAssembly(repo2);
          const stopped = winner.run({
            ...runRequest(world, "main", [promote], attestDeclaration()),
            targets: { main: target2 },
          });
          expect(stopped.kind).toBe("blocked");
          if (stopped.kind !== "blocked" || stopped.handle === null) {
            throw new Error("expected a blocked winner holding the claim");
          }
          const winnerAttemptId = stopped.handle.attemptId;
          const loserOutcome = gitAssembly(repo2).run({
            ...runRequest(world, "main", [promote]),
            targets: { main: target2 },
          });
          expect(loserOutcome.kind).toBe("denied");
          if (loserOutcome.kind !== "denied" || loserOutcome.handle === null) {
            throw new Error("expected a denied outcome");
          }
          expect(loserOutcome.holder).toBe(winnerAttemptId);
          // The durable register is where the loser's story stands: the
          // winner's held claim is the record the denial adjudicated from
          // (the stable-version scope, naming the winner), and the loser's
          // own allocation burned the plan's second ordinal — a denial
          // writes no ledger tail, its evidence is the register.
          expect(
            claimRegisterRecords(git2, "main").some(
              (record) =>
                record.holder === winnerAttemptId &&
                record.scope.kind === "stable-version" &&
                record.scope.version === "5.0.0",
            ),
          ).toBe(true);
          expect(ordinalCounter(git2)).toStrictEqual({ nextOrdinal: 2 });
        });
      });
    },
  );

  it(
    "git-05 · W5 × I2 · E-08 over the durable register — the explicit bound-0 conflict beside the immediate-conflict fold parity pin",
    { timeout: 45_000 },
    () => {
      withSeededRepo("cert-git-05", (repo, _git, heads) => {
        // The fail-closed bound 0 renders the explicit conflict (0 of 0):
        // the first run's beta lease stands in the durable register, the
        // identical second process's denial carries the winner's recorded
        // sequence, and the exhausted bound conflicts — exit 14.
        const first = runBin(gitRunArgs(repo, "main"), {
          input: docBytes(gitDoc("main", [beta], heads)),
        });
        expect(first.status).toBe(0);
        const second = runBin(gitRunArgs(repo, "main"), {
          input: docBytes(gitDoc("main", [beta], heads)),
        });
        expect(second.status).toBe(14);
        const conflict = rendered(second);
        expect(conflict.kind).toBe("conflict");
        if (conflict.kind !== "conflict") {
          throw new Error("expected a conflict outcome");
        }
        expect(conflict.detail).toContain("0 of 0");
        expect(conflict.drives).toStrictEqual([]);
      });

      // The fold parity pin (retrySequence's first branch): a denial
      // carrying no recorded holder sequence — the exclusion path's shape —
      // conflicts immediately, whatever the bound. The exclusion is seeded
      // through the claim store itself (the binding's namespace-gated
      // wrapper refuses the release-line scope): a release-line claim on
      // the line excludes every other claim on it.
      withSeededRepo("cert-git-05-fold", (repo, _git, heads) => {
        const held = rawGitClaims(repo).acquire(
          { kind: "release-line", lineId: "main" },
          "fixture:exclusion-holder",
        );
        expect(held.kind).toBe("claim");
        const outcome = gitAssembly(repo, 2).run(gitBoundaryRequest(heads, [beta]));
        expect(outcome.kind).toBe("conflict");
        if (outcome.kind !== "conflict") {
          throw new Error("expected an immediate conflict");
        }
        expect(outcome.detail).toContain(
          "denial carries no recorded holder sequence to recompute from",
        );
        expect(outcome.drives).toStrictEqual([]);
      });
    },
  );

  it(
    "git-06 · W2 × I10 · ADR-0012's door at the surface — the moves land in the write-ahead window, the replay classifies, a divergent prior conflicts",
    // The fixture's heaviest cell (two crash+resume cycles over the
    // channel store): ~37 s locally, ~70 s on a two-core CI runner —
    // three minutes is headroom for runner variance, not a hang mask
    // (vitest.config's own posture for the real-disk suites).
    { timeout: 180_000 },
    () => {
      // The clean half: the promote's announce hook throws after the moves
      // and the walk's records stand; the fresh binding's resume replays
      // the transition — every replay record self-describes as no movement
      // (from equals to).
      withSeededRepo("cert-git-06", (repo, git, heads) => {
        const target = seededHead(heads, "main");
        const world = liveWorld();
        stageLadder(repo, world, target);
        // The crash seats inside the channel-transition stage: the store
        // has landed the first move, the ledger holds no record of it. The
        // caller posture (the memory suite's declared-effect seating)
        // applied at the port — the git binding's walk exposes no hook
        // anchor mid-stage, and a mid-stage death is the window the
        // write-ahead discipline exists for.
        const crashedEngine = gitAssemblyWithChannels(
          repo,
          dyingAfterFirstMove(new GitChannelStore(repo)),
        );
        const idsBefore = ledgerAttemptIds(repo);
        expect(() =>
          crashedEngine.run({
            ...runRequest(world, "main", [promote], fullDeclaration()),
            targets: { main: target },
          }),
        ).toThrow("the host died between the channel moves");
        const attemptId = ledgerAttemptIds(repo).find((id) => !idsBefore.includes(id));
        if (attemptId === undefined) {
          throw new Error("fixture broken: the crashed attempt left no ledger ref");
        }

        // The write-ahead window, read from the repository: the stage's
        // started record stands and the completion does not; the landed
        // move stands only in the store — the ledger holds no move record.
        const tail = ledgerTail(repo, attemptId);
        expect(recordedTos(tail, "channel-transition")).toStrictEqual(["started"]);
        expect(tail.filter((record) => record.kind === "channel-transition")).toStrictEqual([]);
        expect(new GitChannelStore(repo).read("stable").target).toStrictEqual({
          line: "main",
          version: "5.0.0",
        });
        // The mint belongs to the completion, which the crash preceded:
        // the staged ladder's tags stand, the promoted 5.0.0 does not.
        const tagsBefore = recordedTags(git, naming.namespaces);
        expect(tagsBefore).toStrictEqual(["5.0.0-beta.1", "5.0.0-beta.2", "5.0.0-rc.1"]);

        // The resume classifies from the store's own state: the landed
        // move replays `noop` — its record lands with from equal to to —
        // the second move applies, the stage completes, and the mint
        // follows. Never a second move, never a second mint.
        const resumed = crashedEngine.resume(
          crashedHandle(ledgerPlanId(repo, attemptId), attemptId),
          {
            ...runRequest(liveWorld(), "main", [promote], fullDeclaration()),
            targets: { main: target },
          },
        );
        expect(resumed.kind).toBe("published");
        if (resumed.kind !== "published") {
          throw new Error("expected a published outcome");
        }
        expect(resumed.tag).toBe("5.0.0");
        expect(recordedTags(git, naming.namespaces)).toStrictEqual(["5.0.0", ...tagsBefore]);
        const window = ledgerTail(repo, attemptId);
        const startedIndex = window.findIndex(
          (record) =>
            record.kind === "step" &&
            record.record.stepKey === "channel-transition" &&
            record.record.to === "started",
        );
        const completedIndex = window.findIndex(
          (record) =>
            record.kind === "step" &&
            record.record.stepKey === "channel-transition" &&
            record.record.to === "completed",
        );
        expect(startedIndex).toBeGreaterThanOrEqual(0);
        expect(completedIndex).toBeGreaterThan(startedIndex);
        const moveRecords = window.filter((record) => record.kind === "channel-transition");
        expect(moveRecords.map((record) => record.record.channelId)).toStrictEqual([
          "stable",
          "next",
        ]);
        for (const moveRecord of moveRecords) {
          const index = window.indexOf(moveRecord);
          expect(index).toBeGreaterThan(startedIndex);
          expect(index).toBeLessThan(completedIndex);
        }
        // The replay classification: stable's record is the noop (from
        // equals to — the store already held the move), next's record is
        // the applied move.
        expect(moveRecords[0]?.record.from).toStrictEqual(moveRecords[0]?.record.to);
        expect(moveRecords[0]?.record.to).toStrictEqual({ line: "main", version: "5.0.0" });
        expect(moveRecords[1]?.record.from).toStrictEqual({ line: "main", version: "4.9.2" });
        expect(moveRecords[1]?.record.to).toStrictEqual({ line: "main", version: "5.0.0" });
      });

      // The divergent half: the same mid-stage death, and a writer moves
      // the channel behind the walk's back. The race is seated where the
      // store adjudicates it — the foreign move lands between the replay's
      // read and the store's decision, so the decision re-reads neither
      // its prior nor its target standing and conflicts. The doctrine
      // never moves forward over a foreign move.
      withSeededRepo("cert-git-06-divergent", (repo, _git, heads) => {
        const target = seededHead(heads, "main");
        const world = liveWorld();
        stageLadder(repo, world, target);
        const engine = gitAssemblyWithChannels(
          repo,
          divergentSeat(new GitChannelStore(repo), {
            channelId: "stable",
            from: { line: "main", version: "5.0.0" },
            to: { line: "3.x", version: "3.3.0" },
          }),
        );
        const idsBefore = ledgerAttemptIds(repo);
        expect(() =>
          engine.run({
            ...runRequest(world, "main", [promote], fullDeclaration()),
            targets: { main: target },
          }),
        ).toThrow("the host died between the channel moves");
        const attemptId = ledgerAttemptIds(repo).find((id) => !idsBefore.includes(id));
        if (attemptId === undefined) {
          throw new Error("fixture broken: the crashed attempt left no ledger ref");
        }
        const outcome = engine.resume(crashedHandle(ledgerPlanId(repo, attemptId), attemptId), {
          ...runRequest(liveWorld(), "main", [promote], fullDeclaration()),
          targets: { main: target },
        });
        expect(outcome.kind).toBe("conflict");
        if (outcome.kind !== "conflict") {
          throw new Error("expected the divergent conflict");
        }
        expect(outcome.detail).toContain("a divergent promotion fails closed");
        // The foreign move stands — the doctrine never moves forward over it.
        expect(new GitChannelStore(repo).read("stable").target).toStrictEqual({
          line: "3.x",
          version: "3.3.0",
        });
      });
    },
  );

  it(
    "git-07 · W2 × I9 · the ambiguity window twice — the deterministic .lock fault stops the walk, and the read a proceeding caller would have had to misread is pinned beside it",
    { timeout: 180_000 },
    () => {
      // The process half.
      withSeededRepo("cert-git-07-process", (repo, _git, heads) => {
        const first = runBin(gitRunArgs(repo, "main"), {
          input: docBytes(gitDoc("main", [beta], heads)),
        });
        expect(first.status).toBe(0);
        lockChannelRefs(repo, ["stable", "next"]);
        const child = runBin(gitRunArgs(repo, "main"), {
          input: docBytes(gitDoc("main", [promote], heads, ladderExtraTags(heads))),
        });
        expect(child.status).toBe(15);
        expect(child.stderr).toBe("");
        const outcome = rendered(child);
        expect(outcome.kind).toBe("ambiguous");
        if (outcome.kind !== "ambiguous" || outcome.handle === null) {
          throw new Error("expected an ambiguous outcome carrying its attempt");
        }

        // The read beside it: the channels observation still answers from
        // the recorded states — nothing renders as a null or an empty list
        // a proceeding caller could misread.
        const read = runBin([
          "show",
          "channels",
          "--assembly",
          "git",
          "--repo",
          repo,
          "--tag-namespace",
          "",
          "--json",
        ]);
        expect(read.status).toBe(0);
        expect(rendered(read).kind).toBe("channels");
      });

      // The boundary half.
      withSeededRepo("cert-git-07-boundary", (repo, _git, heads) => {
        const target = seededHead(heads, "main");
        const world = liveWorld();
        stageLadder(repo, world, target);
        lockChannelRefs(repo, ["stable", "next"]);
        const outcome = gitAssembly(repo).run({
          ...runRequest(world, "main", [promote]),
          targets: { main: target },
        });
        expect(outcome.kind).toBe("ambiguous");
        if (outcome.kind !== "ambiguous" || outcome.handle === null) {
          throw new Error("expected an ambiguous outcome carrying its attempt");
        }
      });
    },
  );

  it(
    "git-08 · W1 × I3 · durability's proof — a fresh binding resumes from the reloaded tail, byte-exact, and lands the uninterrupted verdict",
    { timeout: 180_000 },
    () => {
      withSeededRepo("cert-git-08", (repo, _git, heads) => {
        const target = seededHead(heads, "main");
        // The carrying engine seats the crash and seats the resume; what
        // the reload proves is the repository — the tail's bytes are
        // re-read through fresh ledger reads below, never through the
        // engine's own memory.
        const engine = gitAssembly(repo);
        expect(() => engine.run(crashingRequest(heads, "the announce host died mid-walk"))).toThrow(
          "the announce host died mid-walk",
        );
        const attemptId = ledgerAttemptIds(repo)[0];
        if (attemptId === undefined) {
          throw new Error("fixture broken: the crashed attempt left no ledger ref");
        }
        const bytes = ledgerTailBytes(repo, attemptId);
        expect(bytes.length).toBeGreaterThan(0);

        // A fresh binding on the same repo (a reload) reads the same bytes.
        expect(ledgerTailBytes(repo, attemptId)).toStrictEqual(bytes);

        // The resume classifies from the reloaded tail and completes; the
        // tail grew append-only — every crashed byte still stands.
        const resumed = engine.resume(crashedHandle(ledgerPlanId(repo, attemptId), attemptId), {
          ...runRequest(liveWorld(), "main", [beta], fullDeclaration()),
          targets: { main: target },
        });
        expect(resumed.kind).toBe("published");
        if (resumed.kind !== "published") {
          throw new Error("expected a published outcome");
        }
        expect(resumed.tag).toBe("5.0.0-beta.1");
        const grown = ledgerTailBytes(repo, attemptId);
        expect(grown.slice(0, bytes.length)).toStrictEqual(bytes);

        // Resumed-equals-uninterrupted: a walk that never crashed lands
        // the identical verdict.
        withSeededRepo("cert-git-08-clean", (repo2, _git2, heads2) => {
          const direct = gitAssembly(repo2).run({
            ...runRequest(liveWorld(), "main", [beta], fullDeclaration()),
            targets: { main: seededHead(heads2, "main") },
          });
          expect(direct.kind).toBe("published");
          if (direct.kind !== "published") {
            throw new Error("expected a published outcome");
          }
          expect(direct.tag).toBe(resumed.tag);
        });
      });
    },
  );

  it(
    "git-09 · W2 × I4 · E-01's no-return boundary live — the recorded tag step stands, the resume completes in place, never a second mint",
    { timeout: 120_000 },
    () => {
      withSeededRepo("cert-git-09", (repo, git, heads) => {
        const target = seededHead(heads, "main");
        // The announce hook throws after the walk's tag step completed its
        // records — the mint belongs to the completion, so the crash window
        // is exactly "tag recorded, plan valid, the attempt not terminal".
        // The carrying engine seats both the crash and the resume; the
        // records stand in the repository and are re-read below.
        const engine = gitAssembly(repo);
        expect(() =>
          engine.run(crashingRequest(heads, "the announce webhook crashed after the tag")),
        ).toThrow("the announce webhook crashed after the tag");
        const attemptId = ledgerAttemptIds(repo)[0];
        if (attemptId === undefined) {
          throw new Error("fixture broken: the crashed attempt left no ledger ref");
        }
        // The recorded tag step stands; the ref does not exist yet (the
        // mint is the completion's own act, never re-run).
        expect(recordedTos(ledgerTail(repo, attemptId), "tag")).toStrictEqual([
          "started",
          "completed",
        ]);
        expect(recordedTags(git, naming.namespaces)).toStrictEqual([]);

        const outcome = engine.resume(crashedHandle(ledgerPlanId(repo, attemptId), attemptId), {
          ...runRequest(liveWorld(), "main", [beta], fullDeclaration()),
          targets: { main: target },
        });
        expect(outcome.kind).toBe("published");
        if (outcome.kind !== "published") {
          throw new Error("expected a published outcome");
        }
        expect(outcome.tag).toBe("5.0.0-beta.1");
        // Complete-in-place: the recorded tag step never re-opened — the
        // minted tag stands once, the completion is the recorded one.
        expect(recordedTags(git, naming.namespaces)).toStrictEqual(["5.0.0-beta.1"]);
        expect(recordedTos(ledgerTail(repo, attemptId), "tag")).toStrictEqual([
          "started",
          "completed",
        ]);
      });
    },
  );

  it(
    "git-10 · W3 × I5 · the abort's fresh-process refusal — quoting the recorded actor, reason, and attempt id, with the ordinal burn recorded",
    { timeout: 45_000 },
    () => {
      withSeededRepo("cert-git-10", (repo, git, heads) => {
        // The abort through the boundary door — over the SAME closed
        // document the process transport carries, so the fresh process
        // answers for the same plan.
        const engine = gitAssembly(repo);
        const stopped = engine.run(gitBoundaryRequest(heads, [beta], attestDeclaration()));
        expect(stopped.kind).toBe("blocked");
        if (stopped.kind !== "blocked" || stopped.handle === null || stopped.planId === null) {
          throw new Error("expected a blocked attempt");
        }
        const abandoned = engine.abort(
          stopped.handle,
          "human:maintainer",
          "reason:aborted-by-the-fixture",
        );
        expect(abandoned.kind).toBe("abandoned");
        // The blocked run's allocation is the counter's one commit — the
        // plan's first (1-based) ordinal, recorded byte-exactly.
        expect(ordinalCounter(git)).toStrictEqual({ nextOrdinal: 1 });

        // The fresh process re-running the aborted plan refuses, quoting
        // the record — and its own allocation burned the second ordinal,
        // so the derived-ordinal growth stays legible.
        const child = runBin(gitRunArgs(repo, "main"), {
          input: docBytes(gitDoc("main", [beta], heads)),
        });
        expect(child.status).toBe(10);
        expect(child.stderr).toBe("");
        const outcome = rendered(child);
        expect(outcome.kind).toBe("refused");
        if (outcome.kind !== "refused") {
          throw new Error("expected a refused outcome");
        }
        expect(outcome.detail).toContain("human:maintainer");
        expect(outcome.detail).toContain("reason:aborted-by-the-fixture");
        expect(outcome.detail).toContain(stopped.handle.attemptId);
        expect(outcome.drives).toStrictEqual([]);
        // The fresh process's own allocation burned the second ordinal —
        // the counter's forward-only growth stays legible across the
        // transport boundary.
        expect(ordinalCounter(git)).toStrictEqual({ nextOrdinal: 2 });
        expect(recordedTags(git, naming.namespaces)).toStrictEqual([]);
      });
    },
  );

  it(
    "git-11 · I6 · the two renderings of one doctrine — terminal is terminal on the carried attempt, and the fresh process's carried door refuses",
    { timeout: 45_000 },
    () => {
      withSeededRepo("cert-git-11", (repo, _git, heads) => {
        const target = seededHead(heads, "main");
        const engine = gitAssembly(repo);
        const published = engine.run({
          ...runRequest(liveWorld(), "main", [beta], fullDeclaration()),
          targets: { main: target },
        });
        expect(published.kind).toBe("published");
        if (published.kind !== "published" || published.handle === null) {
          throw new Error("expected a published outcome");
        }
        const winner = published.handle;

        // Where the engine still carries the attempt, the later resume
        // throws the named violation.
        expect(() =>
          engine.resume(crashedHandle(winner.planId, winner.attemptId), {
            ...runRequest(liveWorld(), "main", [beta], fullDeclaration()),
            targets: { main: target },
          }),
        ).toThrow(InvalidExecutionTransitionError);

        // From a fresh process the carried-attempt door refuses instead.
        const child = runBin(
          [
            "resume",
            "--assembly",
            "git",
            "--repo",
            repo,
            "--tag-namespace",
            "",
            "--world",
            "-",
            "--actor",
            "automation",
            "--plan",
            winner.planId,
            "--attempt",
            winner.attemptId,
            "--json",
          ],
          { input: docBytes(gitDoc("main", [beta], heads)) },
        );
        expect(child.status).toBe(10);
        const outcome = rendered(child);
        expect(outcome.kind).toBe("refused");
        if (outcome.kind !== "refused") {
          throw new Error("expected a refused outcome");
        }
        expect(outcome.detail).toContain("unknown attempt");
      });
    },
  );

  it(
    "git-12 · W1 × I11 · the declared lie's two fault bands, each to its recorded section — exit 70 twice, distinct rows, stdout empty",
    { timeout: 45_000 },
    () => {
      withSeededRepo("cert-git-12", (repo, _git, heads) => {
        const { planner, mint } = gitFaultScenarios(repo, heads);
        // The unobserved feedRef faults at the planner's range
        // classification before anything executes.
        expect(planner.status).toBe(70);
        expect(planner.stdout).toBe("");
        expect(planner.stderr).toContain("InvalidPlanningInputError");
        expect(planner.stderr).toContain("no observed ref named");
        // The unobserved ref head faults at the mint after the walk's
        // records stand.
        expect(mint.status).toBe(70);
        expect(mint.stdout).toBe("");
        expect(mint.stderr).toContain("GitFaultError");

        // The two rows must never collapse into one cell: the faults name
        // different errors, and only the second leaves recorded evidence —
        // the mint faults after the walk's records stand, the planner
        // faults before anything executes.
        expect(planner.stderr).not.toContain("GitFaultError");
        const mintLeaves = ledgerAttemptIds(repo);
        expect(mintLeaves.length).toBe(1);
        expect(ledgerTailBytes(repo, mintLeaves[0] as string).length).toBeGreaterThan(0);

        // The byte layer: the projected fault texts as reviewed bytes.
        const recordedPlanner = expectedScenario(
          "git-12",
          "the unobserved feedRef (planner fault)",
        );
        expect(planner.status).toBe(recordedPlanner.exit);
        expect(project(planner.stderr, repo)).toBe(recordedPlanner.stderr);
        const recordedMint = expectedScenario("git-12", "the unobserved ref head (mint fault)");
        expect(mint.status).toBe(recordedMint.exit);
        expect(mint.stdout).toBe(recordedMint.stdout);
        expect(project(mint.stderr, repo)).toBe(recordedMint.stderr);
      });
    },
  );

  it(
    "git-14 · I12 · the engine's own pre-walk target refusal on the hand-built-request path — refused, handle null, drives empty",
    { timeout: 45_000 },
    () => {
      withSeededRepo("cert-git-14", (repo, _git, _heads) => {
        const outcome = gitAssembly(repo).run(runRequest(liveWorld(), "main", [beta]));
        expect(outcome.kind).toBe("refused");
        if (outcome.kind !== "refused") {
          throw new Error("expected a refused outcome");
        }
        expect(outcome.handle).toBeNull();
        expect(outcome.drives).toStrictEqual([]);
      });
    },
  );
});
