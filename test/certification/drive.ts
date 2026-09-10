/**
 * The certification fixture's one shared drive module (phase 14 contract
 * §2.3, §4.3): the generator and the suites drive every transport through
 * THIS module — the two never fork a runner.
 *
 * What lives here:
 * - the process transport: the built bin in a child process (`runBin`),
 *   never the CLI as an import (§8);
 * - the boundary transport: assemblies over the recorded world — the app
 *   harness's `freshAssembly` for memory, `assembleGitBinding` over an
 *   opened binding for git (the independent construction §2.3 pins; the
 *   CLI's own selection module is never consumed);
 * - the recorded world documents (`memoryDoc`, `gitDoc`, `docBytes`) and
 *   the hermetic repository fixture (`withSeededRepo`, the `.lock` fault
 *   seater) — the CLI harness carries its own copies because the fixture
 *   may not import it, so the bytes here are kept identical by law
 *   (memory-10/git-01's pairing judges them);
 * - the projection rule (§4.3), recorded and versioned, applied
 *   identically at generation and at comparison;
 * - the byte-pinned cells' scenario drivers and the expected-file reader
 *   and writer (only the generator writes; the suites only compare).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  assembleGitBinding,
  assembleMemoryStores,
  type AttemptHandle,
  type ChannelStore,
  type Engine,
  type ExecutionLedger,
  type Attribution,
  type LedgerRecord,
  type LedgerStepState,
  type MemoryClaimStore,
  type ReleaseAttempt,
  type RunDeclarations,
  type RunOutcome,
  type StepKey,
  type StepRecordsView,
  type TransitionRecord,
} from "../../src/index.js";
import {
  channelRefFor,
  GitChannelStore,
  GitClaimStore,
  GitLedger,
  openGitBinding,
  openGitRun,
  type GitRun,
} from "../../src/adapters/git/index.js";
import { withTempRepo } from "../adapters/git/temp-repo.js";
import {
  beta,
  freshAssembly,
  promote,
  rc,
  registerSeededAfter,
  runRequest,
  runToWorld,
} from "../app/harness.js";
import {
  freshStores,
  liveWorld,
  matrixHooks,
  runInput,
  standingChannelStates,
} from "../vertical/matrix.js";
import { naming, seedLineHeads, tailBytes } from "../vertical/matrix-git.js";
import { FIXTURE_DIR } from "./manifest.js";

// ---------------------------------------------------------------------------
// The process transport — the built bin in a child process
// ---------------------------------------------------------------------------

/** The built bin the fixture executes — the build task precedes the test
 * task, so the path always holds the current sources. */
export const CLI_BIN = join(import.meta.dirname, "..", "..", "dist", "src", "cli", "index.js");

export interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** One child-process invocation of the built bin. `input` feeds stdin (the
 * `--world -` spelling); the child's environment is never touched (§8: the
 * fixture reads no environment). */
export const runBin = (args: readonly string[], options: { input?: string } = {}): CliResult => {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    encoding: "utf8",
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  if (result.error !== undefined) {
    throw new Error(`the fixture's CLI process failed to spawn: ${String(result.error)}`);
  }
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
};

// ---------------------------------------------------------------------------
// The projection rule (§4.3) — recorded, versioned, applied identically at
// generation and at comparison
// ---------------------------------------------------------------------------

export const PROJECTION_RULE =
  "phase 14 §4.3 v1 — the repository path becomes REPO in plain and JSON-escaped " +
  "text spellings; a JSON string whose parsed value is exactly 64 lowercase hex " +
  "characters (the claim token's whole shape) becomes CLAIM. Whole-value, never " +
  "substring: plan_sha256/attempt_sha256 values and refs/release-craft/channels names " +
  "carry 64-hex substrings inside longer strings and stay verbatim.";

/** The projection applied over envelope or fault text. The repo path is
 * per-repository; the claim token is the binding's one random value. */
export const project = (text: string, repo = ""): string => {
  let projected = text;
  if (repo.length > 0) {
    projected = projected.split(repo).join("REPO");
    const escaped = repo.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    if (escaped !== repo) {
      projected = projected.split(escaped).join("REPO");
    }
  }
  return projected
    .replace(/"([0-9a-f]{64})"/g, '"CLAIM"')
    .replace(/\\"[0-9a-f]{64}\\"/g, '\\"CLAIM\\"');
};

// ---------------------------------------------------------------------------
// The recorded world as documents — the closed input's bytes
// ---------------------------------------------------------------------------

/** The memory world document for one matrix line, with the run's intents. */
export const memoryDoc = (lineId: string, intents: readonly unknown[] = []) =>
  runInput(liveWorld(), lineId, intents as never);

/** The git world document: the same matrix world with the run line's ref
 * head (and that head's commit sha) replaced by the real seeded oid — the
 * mint target the git assembly will rev-parse. Extra tags stand for the
 * recorded state a previous run left in the world. Kept byte-identical to
 * the CLI harness's builder by law: the pairing of memory-10 and git-01 is
 * the proof that the projection is the only delta. */
export const gitDoc = (
  lineId: string,
  intents: readonly unknown[],
  heads: Readonly<Record<string, string>>,
  extraTags: readonly { readonly name: string; readonly commit: string }[] = [],
  tagFormats: Readonly<Record<string, string>> = {},
) => {
  const base = runInput(liveWorld(), lineId, intents as never);
  return {
    ...base,
    policy: { ...base.policy, tagFormats },
    repository: {
      commits: base.repository.commits.map((candidate) => {
        const ref = base.repository.refs.find(
          (candidateRef) => candidateRef.head === candidate.sha,
        );
        const real = ref === undefined ? undefined : heads[ref.name];
        return real === undefined ? candidate : { ...candidate, sha: real };
      }),
      refs: base.repository.refs.map((ref) => {
        const real = heads[ref.name];
        return real === undefined ? ref : { ...ref, head: real };
      }),
    },
    history: { tags: [...base.history.tags, ...extraTags] },
  };
};

/** The world document's exact bytes — what the child (via stdin) and the
 * direct side (via parse) both consume. */
export const docBytes = (doc: unknown): string => `${JSON.stringify(doc, null, 2)}\n`;

// ---------------------------------------------------------------------------
// The hermetic repository fixture — the git assembly's recorded world
// ---------------------------------------------------------------------------

/** A fresh temporary git repository carrying the matrix's seeded line heads
 * and the five standing channels — the exact world a git-assembly process
 * expects, deterministic in every object id. Byte-identical to the CLI
 * harness's fixture of the same name (see `gitDoc` above). */
export function withSeededRepo(
  name: string,
  fn: (repo: string, git: GitRun, heads: Readonly<Record<string, string>>) => void,
): void {
  withTempRepo(name, (repo, git) => {
    const heads = seedLineHeads(git);
    const channels = new GitChannelStore(repo);
    for (const channel of standingChannelStates()) {
      const outcome = channels.applyTransition({
        channelId: channel.id,
        from: null,
        to: { line: channel.target.line, version: channel.target.version },
      });
      if (outcome.kind !== "applied") {
        throw new Error(`fixture broken: seeding channel ${channel.id} got ${outcome.kind}`);
      }
    }
    fn(repo, git, heads);
  });
}

/** Pre-creates `.lock` files beside the named channels' refs — the
 * deterministic ambiguity window (invariant 2.6): the CAS's land cannot
 * take the ref, the store returns `ambiguous`, the walk stops. */
export const lockChannelRefs = (repo: string, channelIds: readonly string[]): void => {
  for (const channelId of channelIds) {
    const ref = channelRefFor(channelId);
    const refDir = join(repo, ".git", dirname(ref));
    mkdirSync(refDir, { recursive: true });
    writeFileSync(join(repo, ".git", `${ref}.lock`), "");
  }
};

/** A git boundary engine over the repository — the independent construction
 * §2.3 pins: the opened binding and the vertical's recorded naming, never
 * the CLI's selection module. */
export const gitAssembly = (repo: string, maxRetries = 2): Engine =>
  assembleGitBinding(openGitBinding({ repo, tagNaming: naming }), { maxRetries });

/** The git boundary engine with one port overridden — the fixture's seat
 * for a caller-side fault at that port (the memory suite's declared-effect
 * posture, applied at the channel store because the git binding's walk
 * exposes no hook anchor mid-stage). The port is the caller's to seat:
 * the fixture wires it, the product never does. */
export const gitAssemblyWithChannels = (repo: string, channels: ChannelStore): Engine =>
  assembleGitBinding(
    { ...openGitBinding({ repo, tagNaming: naming }), channels },
    { maxRetries: 2 },
  );

/** The repository's durable ledger, constructed the vertical fixture's own
 * way (`new GitLedger` over the repo's runner, exactly `gitStores` builds
 * it) — the tail a crashed walk left behind (the fixture's own crash
 * windows escape the door, so the identity comes from the repo, the only
 * survivor). */
export const gitLedger = (repo: string): GitLedger => new GitLedger(openGitRun(repo));

/** The repository's claim store itself — `gitStores`'s own construction,
 * no wrapper. The binding's namespace-gated wrapper refuses the
 * `release-line` scope (policy data the binding's naming never mints), so
 * the fold-parity seeding acquires through the store itself — the same
 * register refs the wrapper's engine reads. */
export const rawGitClaims = (repo: string): GitClaimStore => new GitClaimStore(repo);

/** The attempt's recorded ledger tail, read fresh from the repository. */
export const ledgerTail = (repo: string, attemptId: string): readonly LedgerRecord[] =>
  gitLedger(repo).tail(attemptId);

/** The attempt's ledger tail as canonical bytes, read fresh from the
 * repository — the byte-pinned durability comparison. */
export const ledgerTailBytes = (repo: string, attemptId: string): readonly string[] =>
  tailBytes(gitLedger(repo), attemptId);

/** The attempt's recorded plan fingerprint, guarded — the resume handle's
 * plan half, recovered from the repository. */
export const ledgerPlanId = (repo: string, attemptId: string): string => {
  const planId = gitLedger(repo).planFingerprint(attemptId);
  if (planId === null) {
    throw new Error(`fixture broken: no recorded plan fingerprint for ${attemptId}`);
  }
  return planId;
};

/** The exact inverse of the adapter's ref-component encoding (upper-case
 * percent escapes, ASCII only) — the ref name back into the engine id. */
const decodeRefComponent = (value: string): string =>
  value.replace(/%([0-9A-F]{2})/g, (_whole, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );

/** The attempt ids the repository's ledger refs carry — the repo itself is
 * the story a fresh process reads (there is no register read door). The
 * refs are named by attempt id under the adapter's percent encoding; the
 * ids decode back to the engine's spelling (`attempt_sha256:<hex>`). */
export const ledgerAttemptIds = (repo: string): readonly string[] =>
  openGitRun(repo)(["for-each-ref", "--format=%(refname)", "refs/release-craft/ledger/"])
    .split("\n")
    .filter((ref) => ref.length > 0)
    .map((ref) => decodeRefComponent(ref.slice("refs/release-craft/ledger/".length)));

/** The attempt-ledger refs' commit chains, exactly as git reports them —
 * one `%an|%ae|%cn|%ce|%s` line per substrate commit, ref by ref in
 * for-each-ref order. This is the fixture's identity pin (#164): the
 * binding writes COMMIT_ENV's author/committer name and email and the
 * append subject template into the consumer repository's git metadata, so
 * the recorded bytes carry them verbatim — a drift in either constant
 * fails the byte comparison instead of passing silently. */
export const ledgerIdentityLog = (repo: string): string => {
  const git = openGitRun(repo);
  const refs = git(["for-each-ref", "--format=%(refname)", "refs/release-craft/ledger/"])
    .split("\n")
    .filter((ref) => ref.length > 0);
  return refs.map((ref) => git(["log", "--format=%an|%ae|%cn|%ce|%s", ref]).trimEnd()).join("\n");
};

/** The mint target per line: the recorded base the tag door mints onto —
 * the run line's own ref head from the same world. */
export const gitTarget = (heads: Readonly<Record<string, string>>, lineId: string): string => {
  const target = heads[lineId];
  if (target === undefined) {
    throw new Error(`fixture broken: no seeded head for ${lineId}`);
  }
  return target;
};

// ---------------------------------------------------------------------------
// The boundary transport's crash window wrapper (memory-05) — a fault
// seated where a store sits, the declared injection the memory factory
// admits (R2). The git binding builds its stores inside its own factory,
// so this class has no git counterpart by law.
// ---------------------------------------------------------------------------

/** A ledger whose write-ahead start for the armed stage lands durable and
 * then kills its process — the write-ahead crash mid-walk (I3): the
 * started record stands, the stage's effect never runs, the fault escapes
 * the door. Disarmed (a second assembly over the same bundle), every read
 * and write delegates. */
export class CrashingLedger implements ExecutionLedger {
  readonly #inner: ExecutionLedger;
  /** Every attempt id a write carried, first write first — the handle the
   * resume needs after the crash. */
  readonly attemptIds: string[] = [];
  /** Every plan fingerprint a write carried, first write first. */
  readonly planIds: string[] = [];
  #armedOn: StepKey | null = null;
  #crashed = false;

  constructor(inner: ExecutionLedger) {
    this.#inner = inner;
  }

  /** Arms the crash on the named stage's write-ahead start. */
  armOn(stage: StepKey): void {
    this.#armedOn = stage;
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
    const record = this.#inner.appendStart(
      attempt,
      stepKey,
      attribution,
      contentFingerprint,
      guard,
    );
    if (this.#armedOn === stepKey && !this.#crashed) {
      this.#crashed = true;
      throw new Error("the process died between the write-ahead start and the stage's effect");
    }
    return record;
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

// ---------------------------------------------------------------------------
// The byte-pinned cells' scenario drivers — ONE code path for the generator
// and the suites (§4.3: the recorded bytes and the compared bytes are
// produced by the same doors, so a drift in the door moves both and the
// diff catches it)
// ---------------------------------------------------------------------------

/** The attest hook's declaration: the effect returns the given proof, or
 * none at all (the blocked window memory-08 re-arms from). */
export const attestDeclaration = (evidence?: string): RunDeclarations => {
  const hook = matrixHooks().attest;
  return {
    hooks: [hook],
    hookEffects: new Map([
      [
        hook.id,
        (input) => ({
          attribution: { attemptId: input.attemptId, actor: "automation" },
          ...(evidence === undefined ? {} : { evidence }),
        }),
      ],
    ]),
  };
};

/** A boundary engine whose loser allocates the plan's SECOND ordinal — the
 * shared-store scenarios' different attempt identity for the same plan
 * (the app harness's declared posture for the losing side of E-07/E-08). */
export const loserEngine = (
  planId: string,
  claims: MemoryClaimStore,
  maxRetries: number,
): Engine => {
  const stores = freshStores();
  return assembleMemoryStores(
    {
      register: registerSeededAfter(planId),
      ledger: stores.ledger,
      claims,
      channels: stores.channels,
    },
    { maxRetries },
  );
};

/** The handle a crashed attempt resumes from: the register's own identity
 * for the plan, read back from the ledger's captured writes. */
export const crashedHandle = (planId: string, attemptId: string): AttemptHandle => ({
  planId,
  attemptId,
  actor: "automation",
});

/** memory-01's scenario: the process plan, first of the recorded double. */
export const memoryPlanScenario = (): CliResult => {
  const args = ["plan", "--assembly", "memory", "--world", "-", "--json"];
  return runBin(args, { input: docBytes(memoryDoc("main", [beta])) });
};

/** memory-02's scenario: the process run and the same walk through the
 * boundary door — the pass-through pair. */
export const memoryRunScenario = (): { readonly child: CliResult; readonly direct: RunOutcome } => {
  const args = [
    "run",
    "--assembly",
    "memory",
    "--world",
    "-",
    "--actor",
    "automation",
    "--line",
    "main",
    "--json",
  ];
  const child = runBin(args, { input: docBytes(memoryDoc("main", [beta])) });
  const direct = freshAssembly().engine.run(runRequest(liveWorld(), "main", [beta]));
  return { child, direct };
};

/** memory-03's scenario: the promote race — the winner blocks mid-walk
 * holding the stable-version claim, the loser is denied naming it. */
export const memoryDenialScenario = (): {
  readonly winner: RunOutcome;
  readonly loser: RunOutcome;
} => {
  const world = liveWorld();
  const winner = freshAssembly();
  for (const intent of [beta, beta, rc]) {
    const staged = runToWorld(winner.engine, world, runRequest(world, "main", [intent]));
    if (staged.kind !== "published") {
      throw new Error(`fixture broken: the ladder stage got ${staged.kind}`);
    }
  }
  const stopped = winner.engine.run(runRequest(world, "main", [promote], attestDeclaration()));
  if (stopped.kind !== "blocked" || stopped.planId === null) {
    throw new Error(`fixture broken: the winner got ${stopped.kind}, expected blocked`);
  }
  const loser = loserEngine(stopped.planId, winner.stores.claims, 2).run(
    runRequest(world, "main", [promote]),
  );
  return { winner: stopped, loser };
};

// ---------------------------------------------------------------------------
// The git cells' drivers — the process transport's grammar and the boundary
// transport's requests over the hermetic repository
// ---------------------------------------------------------------------------

/** One seeded head from the hermetic repository, guarded. */
export const seededHead = (heads: Readonly<Record<string, string>>, lineId: string): string => {
  const head = heads[lineId];
  if (head === undefined) {
    throw new Error(`fixture broken: no seeded head for ${lineId}`);
  }
  return head;
};

/** The git cells' run-line CLI arguments — the process transport's grammar
 * (the declared tag namespace, the world on stdin, the fail-closed bound
 * unless raised). */
export const gitRunArgs = (
  repo: string,
  line: string,
  options: { maxRetries?: number } = {},
): string[] => [
  "run",
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
  "--line",
  line,
  "--json",
  ...(options.maxRetries === undefined ? [] : ["--max-retries", String(options.maxRetries)]),
];

/** The §3.2 ladder's three staged prerelease tags, recorded at the run
 * line's head — the history a promote document carries. */
export const ladderExtraTags = (
  heads: Readonly<Record<string, string>>,
): readonly { readonly name: string; readonly commit: string }[] => {
  const head = seededHead(heads, "main");
  return [
    { name: "5.0.0-beta.1", commit: head },
    { name: "5.0.0-beta.2", commit: head },
    { name: "5.0.0-rc.1", commit: head },
  ];
};

/** The git scenarios' world documents — one builder per scenario, the
 * recorded world serialized once (§6): the process transport carries the
 * bytes on stdin, the Action transport carries the SAME bytes as the world
 * file. One builder, both transports — the scenario data cannot drift. */

/** The promote scenario's document — the staged ladder recorded in the
 * world's history (git-01 and action-01's subject). */
export const gitPromoteDocument = (heads: Readonly<Record<string, string>>) =>
  gitDoc("main", [promote], heads, ladderExtraTags(heads));

/** The beta scenario's document — the prerelease walk's plain document. */
export const gitBetaDocument = (heads: Readonly<Record<string, string>>) =>
  gitDoc("main", [beta], heads);

/** The planner-fault document — the declared lie the range classification
 * faults over (the unobserved feedRef). */
export const gitPlannerFaultDocument = (heads: Readonly<Record<string, string>>) => {
  const honest = gitBetaDocument(heads);
  return {
    ...honest,
    lines: honest.lines.map((line) =>
      line.id === "main" ? { ...line, feedRef: "no-such-ref" } : line,
    ),
  };
};

/** The mint-fault document — the ref head the repository does not observe
 * (the unobserved target; the mint faults after the walk's records stand).
 * The lying head is a fixed 40-hex-shape value, never a real oid. */
export const gitMintFaultDocument = () => gitDoc("main", [beta], { main: "e".repeat(40) });

/** The pre-walk-refusal document — the minting line's feedRef names a ref
 * the document does not record, so the CLI derives no target (I12). */
export const gitUnrefedDocument = (heads: Readonly<Record<string, string>>) => {
  const doc = gitPromoteDocument(heads);
  return {
    ...doc,
    repository: {
      ...doc.repository,
      refs: doc.repository.refs.filter((ref) => ref.name !== "main"),
    },
  };
};

/** git-01's scenario: the promote walk through the process over the staged
 * ladder document — the flagship envelope. */
export const gitPromoteScenario = (
  repo: string,
  heads: Readonly<Record<string, string>>,
): CliResult => runBin(gitRunArgs(repo, "main"), { input: docBytes(gitPromoteDocument(heads)) });

/** git-02's scenario: the maintenance cut through the process — the
 * side line's run with no intents. */
export const gitCutScenario = (repo: string, heads: Readonly<Record<string, string>>): CliResult =>
  runBin(gitRunArgs(repo, "4.8.x"), { input: docBytes(gitDoc("4.8.x", [], heads)) });

/** git-12's scenario: the declared lie's two fault bands in one repository —
 * the unobserved feedRef (faults at the planner's range classification)
 * and the unobserved ref head (faults at the mint, records standing). */
export const gitFaultScenarios = (
  repo: string,
  heads: Readonly<Record<string, string>>,
): { readonly planner: CliResult; readonly mint: CliResult } => {
  const planner = runBin(gitRunArgs(repo, "main"), {
    input: docBytes(gitPlannerFaultDocument(heads)),
  });
  const mint = runBin(gitRunArgs(repo, "main"), { input: docBytes(gitMintFaultDocument()) });
  return { planner, mint };
};

// ---------------------------------------------------------------------------
// The expected bytes — committed data, compared at test time
// ---------------------------------------------------------------------------

export interface ExpectedScenario {
  /** The invocation's recorded label (the scenario within the cell). */
  readonly label: string;
  /** The process exit, or null for a boundary-transport scenario (the
   * boundary renders no exits). */
  readonly exit: number | null;
  /** The projected stdout — or, for a boundary scenario, the projected
   * serialization of the door's value. */
  readonly stdout: string;
  /** The projected stderr, where the class pins it. */
  readonly stderr: string;
}

export interface ExpectedDoc {
  readonly cell: string;
  readonly projection: string;
  readonly scenarios: readonly ExpectedScenario[];
}

export const expectedPath = (cell: string): string => join(FIXTURE_DIR, "expected", `${cell}.json`);

/** The committed bytes for a cell, or null when the file does not exist —
 * a missing file a manifest row names is the orphan law's finding, not a
 * crash. */
export const readExpected = (cell: string): ExpectedDoc | null => {
  try {
    return JSON.parse(readFileSync(expectedPath(cell), "utf8")) as ExpectedDoc;
  } catch {
    return null;
  }
};

/** The generator's only write. No gated path calls this. */
export const writeExpected = (cell: string, doc: ExpectedDoc): void => {
  mkdirSync(join(FIXTURE_DIR, "expected"), { recursive: true });
  writeFileSync(expectedPath(cell), `${JSON.stringify(doc, null, 2)}\n`);
};

/** The committed bytes for one scenario, compared at test time. A missing
 * file or label is a fixture defect (the manifest's orphan laws find it);
 * it is never an excuse to snapshot fresh bytes. */
export const expectedScenario = (cell: string, label: string): ExpectedScenario => {
  const doc = readExpected(cell);
  if (doc === null) {
    throw new Error(
      `no committed expected bytes for ${cell} — the reviewed file must exist ` +
        `(generate once with test/certification/generate.ts; never snapshot at test time)`,
    );
  }
  const scenario = doc.scenarios.find((candidate) => candidate.label === label);
  if (scenario === undefined) {
    throw new Error(`${cell} records no scenario labelled "${label}"`);
  }
  return scenario;
};
