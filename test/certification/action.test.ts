/**
 * The certification fixture's Action-transport scenario cells (phase 14
 * contract §3.3's `action-01` … `action-06`, instantiated per §6). The
 * contract owns the scenario set — the recorded world's exact bytes, the
 * argv the grammar demands, the expected exit, envelope kind, conclusion,
 * and annotation fields — and the invocation script (the composite's one
 * in-repo program) renders them. The suite drives the SAME file the
 * workflow's step drives, through the phase 13 harness's subprocess drive
 * and runner-parse replay; nothing here re-implements a mechanism.
 *
 * The world documents are the git scenario builders of `drive.ts` — one
 * builder, both transports — so a scenario's bytes cannot drift between
 * the CLI cells and the Action cells.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACTION_METADATA,
  ambientWithRunnerPath,
  annotationOf,
  envelopeBinSource,
  replayOutcome,
  runInvoke,
  SIGKILL_BIN,
  withScratchDir,
} from "../action/harness.js";
import { beta } from "../app/harness.js";
import {
  docBytes,
  expectedScenario,
  gitBetaDocument,
  gitMintFaultDocument,
  gitPlannerFaultDocument,
  gitPromoteDocument,
  gitUnrefedDocument,
  project,
  withSeededRepo,
} from "./drive.js";

/** The wire spellings of the scenario intents (the CLI grammar's). */
const PROMOTE = "promote:main\n";
const PRERELEASE = `prerelease:${beta.stream}:${beta.lineId}\n`;

/** The stand-in invocation's inputs: the stand-in bin is the only meaningful
 * value — no world is read, because the bin IS the run. */
const standInInputs = (bin: string): Parameters<typeof runInvoke>[0] => ({
  world: "world.json",
  line: "main",
  actor: "automation",
  tagNamespaces: "",
  repo: ".",
  maxRetries: "0",
  bin,
});

/** One invocation of the scenario transport: the document's exact bytes as
 * the world file (serialized once, in the repository), the every-tag root
 * as the single empty namespace line, the fail-closed bound forwarded. */
const invokeScenario = (
  repo: string,
  document: unknown,
  options: { intents: string },
): ReturnType<typeof runInvoke> => {
  const worldPath = join(repo, "world.json");
  writeFileSync(worldPath, docBytes(document));
  return runInvoke(
    {
      world: worldPath,
      line: "main",
      actor: "automation",
      // One empty line: the every-tag root, one flag occurrence.
      tagNamespaces: "\n",
      intents: options.intents,
      repo: ".",
      maxRetries: "0",
    },
    { cwd: repo },
  );
};

/** The scenario invocation under an optional planted ambient — the hostile
 * drive composes the runner's PATH over the plant, exactly the step env
 * block's composition. */
const invokeAmbient = (
  repo: string,
  heads: Readonly<Record<string, string>>,
  ambient: NodeJS.ProcessEnv | undefined,
): ReturnType<typeof runInvoke> => {
  const worldPath = join(repo, "world.json");
  writeFileSync(worldPath, docBytes(gitPromoteDocument(heads)));
  return runInvoke(
    {
      world: worldPath,
      line: "main",
      actor: "automation",
      tagNamespaces: "\n",
      intents: PROMOTE,
      repo: ".",
      maxRetries: "0",
    },
    {
      cwd: repo,
      ...(ambient === undefined
        ? {}
        : { env: ambientWithRunnerPath({ ...ambient, RUNNER_TEMP: undefined }) }),
    },
  );
};

/** The first line of a stderr relay — the fault bands' annotation text. */
const firstStderrLine = (stderr: Buffer): string => stderr.toString("utf8").split("\n")[0] ?? "";

describe("the certification fixture · the Action transport", () => {
  it(
    "action-01 · W2 · the promote scenario through the invocation script — the replayed output byte-equal to git-01's recorded stdout, the conclusion success",
    { timeout: 45_000 },
    () => {
      withSeededRepo("cert-action-01", (repo, _git, heads) => {
        const result = invokeScenario(repo, gitPromoteDocument(heads), { intents: PROMOTE });
        // The step is green: the proceed row annotates nothing.
        expect(result.status).toBe(0);
        expect(annotationOf(result.stdout)).toBe("");
        // The one `outcome` output, replayed through the runner's
        // documented file-command parse, is byte-equal to the same
        // invocation's CLI stdout — and that stdout is git-01's recorded
        // envelope: the projected diff against the committed bytes is the
        // byte-equality pin, the same file the CLI cell diffs.
        const replayed = replayOutcome(result.outputs);
        const recorded = expectedScenario("git-01", "promote (the process envelope)");
        expect(project(replayed, repo)).toBe(recorded.stdout);
        expect((JSON.parse(replayed) as { kind: string }).kind).toBe("published");
      });
    },
  );

  it(
    "action-02 · W5 × I1, W5 × I2 (bound 0), I12's CLI-classified half · the stop rows through the invocation — the denial, the bound-0 conflict, and the target lie's process rendering, each concluding failure with its field verbatim",
    { timeout: 90_000 },
    () => {
      // I1, the mid-claim denial: the second identical invocation is
      // denied, naming the first attempt — the annotation quotes the
      // holder field verbatim.
      withSeededRepo("cert-action-02-denied", (repo, _git, heads) => {
        const first = invokeScenario(repo, gitPromoteDocument(heads), { intents: PROMOTE });
        expect(first.status).toBe(0);
        const winner = (
          JSON.parse(replayOutcome(first.outputs)) as { handle: { attemptId: string } }
        ).handle;
        const second = invokeScenario(repo, gitPromoteDocument(heads), { intents: PROMOTE });
        expect(second.status).toBe(1);
        const envelope = JSON.parse(replayOutcome(second.outputs)) as {
          kind: string;
          holder: string;
        };
        expect(envelope.kind).toBe("denied");
        expect(envelope.holder).toBe(winner.attemptId);
        expect(annotationOf(second.stdout)).toBe(`::error::denied: ${winner.attemptId}`);
      });

      // I2 at the fail-closed bound 0: the second identical beta
      // invocation finds the first's prerelease lease standing and its own
      // bound exhausted — the explicit conflict (0 of 0), drives empty,
      // the annotation quoting the detail verbatim.
      withSeededRepo("cert-action-02-conflict", (repo, _git, heads) => {
        const first = invokeScenario(repo, gitBetaDocument(heads), { intents: PRERELEASE });
        expect(first.status).toBe(0);
        const second = invokeScenario(repo, gitBetaDocument(heads), { intents: PRERELEASE });
        expect(second.status).toBe(1);
        const envelope = JSON.parse(replayOutcome(second.outputs)) as {
          kind: string;
          detail: string;
          drives: string[];
        };
        expect(envelope.kind).toBe("conflict");
        expect(envelope.detail).toContain("0 of 0");
        expect(envelope.drives).toStrictEqual([]);
        expect(annotationOf(second.stdout)).toBe(`::error::conflict: ${envelope.detail}`);
      });

      // I12's CLI-classified half: the minting line's feedRef names a ref
      // the document does not record — the process transports never render
      // the boundary's refused(null-handle) shape (git-14's row); the CLI
      // classifies the same lie as a planning fault, exit 70, stdout
      // empty, the first stderr line quoted verbatim.
      withSeededRepo("cert-action-02-unrefed", (repo, _git, heads) => {
        const child = invokeScenario(repo, gitUnrefedDocument(heads), { intents: PROMOTE });
        expect(child.status).toBe(1);
        expect(replayOutcome(child.outputs)).toBe("");
        const annotation = annotationOf(child.stdout);
        expect(annotation).toBe(`::error::${firstStderrLine(child.stderr)}`);
        expect(annotation).toContain("InvalidPlanningInputError");
        expect(annotation).toContain('no observed ref named "main"');
      });
    },
  );

  it(
    "action-03 · I11 · the fault rows — exit 64 and exit 70 conclude failure quoting the first stderr line verbatim, stdout empty",
    { timeout: 90_000 },
    () => {
      // The usage fault: an intent spelling the grammar refuses at parse
      // time (exit 64, before any engine sees it) — stdout empty, the
      // usage line quoted verbatim. The invocation carries `--intents`
      // from workflow input, so a consumer typo is the reachable shape.
      withSeededRepo("cert-action-03-usage", (repo, _git, heads) => {
        // The fault precedes any read of the world — the document's bytes
        // are irrelevant; the invocation simply carries the repository.
        const child = invokeScenario(repo, gitPromoteDocument(heads), {
          intents: "not-an-intent\n",
        });
        expect(child.status).toBe(1);
        expect(replayOutcome(child.outputs)).toBe("");
        const annotation = annotationOf(child.stdout);
        expect(annotation).toBe(`::error::${firstStderrLine(child.stderr)}`);
        expect(annotation).toContain("is not an operator intent");
      });

      // The unobserved feedRef faults at the planner's range
      // classification: stdout empty, no recorded evidence, the first
      // stderr line quoted verbatim — and byte-equal to git-12's
      // committed first band, the same scenario.
      withSeededRepo("cert-action-03-planner", (repo, _git, heads) => {
        const child = invokeScenario(repo, gitPlannerFaultDocument(heads), {
          intents: PRERELEASE,
        });
        expect(child.status).toBe(1);
        expect(replayOutcome(child.outputs)).toBe("");
        const expected = expectedScenario("git-12", "the unobserved feedRef (planner fault)");
        expect(project(firstStderrLine(child.stderr), repo)).toBe(
          expected.stderr.split("\n")[0] ?? "",
        );
        expect(annotationOf(child.stdout)).toBe(`::error::${firstStderrLine(child.stderr)}`);
      });

      // The unobserved ref head faults at the mint after the walk's
      // records stand: stdout empty, the fault text quoted verbatim —
      // git-12's second band, byte-equal.
      withSeededRepo("cert-action-03-mint", (repo, _git, _heads) => {
        const child = invokeScenario(repo, gitMintFaultDocument(), { intents: PRERELEASE });
        expect(child.status).toBe(1);
        expect(replayOutcome(child.outputs)).toBe("");
        const expected = expectedScenario("git-12", "the unobserved ref head (mint fault)");
        expect(project(firstStderrLine(child.stderr), repo)).toBe(
          expected.stderr.split("\n")[0] ?? "",
        );
        expect(annotationOf(child.stdout)).toBe(`::error::${firstStderrLine(child.stderr)}`);
      });
    },
  );

  it(
    "action-04 · the no-verdict rows — a killed child, an unparseable envelope, and a kind↔exit mismatch each conclude failure with the raw evidence",
    { timeout: 90_000 },
    () => {
      withScratchDir((scratch) => {
        // The killed child: the raw signal is the recorded evidence, the
        // output still written (empty), never green.
        const killer = join(scratch, "kill.mjs");
        writeFileSync(killer, SIGKILL_BIN);
        const killed = runInvoke(standInInputs(killer));
        expect(killed.status).toBe(1);
        expect(annotationOf(killed.stdout)).toBe("::error::no verdict: signal SIGKILL");
        expect(replayOutcome(killed.outputs)).toBe("");

        // The unparseable envelope: no verdict exists, the raw exit is
        // recorded.
        const garbage = join(scratch, "garbage.mjs");
        writeFileSync(garbage, envelopeBinSource("not an envelope\n", 3));
        const unparseable = runInvoke(standInInputs(garbage));
        expect(unparseable.status).toBe(1);
        expect(annotationOf(unparseable.stdout)).toBe("::error::no verdict: exit 3");

        // The kind↔exit mismatch: the CLI under the pin and the Action
        // disagree — the raw exit is recorded, never a guessed verdict.
        const mismatch = join(scratch, "mismatch.mjs");
        writeFileSync(mismatch, envelopeBinSource(`${JSON.stringify({ kind: "published" })}\n`, 5));
        const disagreeing = runInvoke(standInInputs(mismatch));
        expect(disagreeing.status).toBe(1);
        expect(annotationOf(disagreeing.stdout)).toBe("::error::no verdict: exit 5");
      });
    },
  );

  it(
    "action-05 · W2 · the hostile ambient, fixture 4's verbatim — the envelope equals the clean run byte for byte, and no planted value is reachable",
    { timeout: 90_000 },
    () => {
      // The planted ambient, fixture 4's values verbatim: lying GITHUB_*
      // values, ACTIONS_*, RUNNER_*, CI=true, an INPUT_WORLD naming a
      // different document, a GIT_DIR pointing elsewhere, a token-shaped
      // GH_TOKEN. The one composition the runner adds on top is the
      // step's own env block: the NODE_OPTIONS plant is declared cleared,
      // read from the artifact beside the pins.
      const HOSTILE: NodeJS.ProcessEnv = {
        GITHUB_TOKEN: "ghs_hostiletokenvalue",
        GH_TOKEN: "ght_hostiletokenvalue",
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "evil/evil",
        GITHUB_REF: "refs/heads/evil",
        GITHUB_OUTPUT: "/evil/outputs",
        ACTIONS_RESULTS_URL: "https://evil.example/results",
        ACTIONS_RUNTIME_TOKEN: "actionswithtoken",
        ACTIONS_CACHE_URL: "https://evil.example/cache",
        RUNNER_TRACKING_ID: "runner-tracking-evil",
        CI: "true",
        INPUT_WORLD: "/evil/world.json",
        GIT_DIR: "/evil/.git",
        GIT_WORK_TREE: "/evil/worktree",
        GIT_INDEX_FILE: "/evil/index",
        NODE_ENV: "production",
        NO_COLOR: "1",
      };
      const MARKS = [
        "ghs_hostiletokenvalue",
        "ght_hostiletokenvalue",
        "evil/evil",
        "actionswithtoken",
        "/evil/world.json",
        "/evil/.git",
        "runner-tracking-evil",
      ];
      // MARKS carries the 7 DISTINCTIVE plants' values (GITHUB_TOKEN,
      // GH_TOKEN, GITHUB_REPOSITORY, ACTIONS_RUNTIME_TOKEN, INPUT_WORLD,
      // GIT_DIR, RUNNER_TRACKING_ID) of the ambient's 17 keys. The
      // unchecked remainder — `CI=true`, `GITHUB_ACTIONS=true`,
      // `GITHUB_REF=refs/heads/evil`, `GITHUB_OUTPUT=/evil/outputs`,
      // `ACTIONS_RESULTS_URL`, `ACTIONS_CACHE_URL`,
      // `GIT_WORK_TREE=/evil/worktree`, `GIT_INDEX_FILE=/evil/index`,
      // `NODE_ENV=production`, `NO_COLOR=1` — rides the same starvation:
      // the child's environment is exactly {HOME, PATH} (the shape pinned
      // by the implementation suite's env-echo cell), so no remaining key
      // can reach the run either.
      expect(ACTION_METADATA).toContain('NODE_OPTIONS: ""');

      // Two identical repositories — the determinism pattern: the hostile
      // drive runs on the first, the clean drive on the second, so no
      // second-run conflict muddies the byte comparison.
      let hostileResult: ReturnType<typeof runInvoke> | null = null;
      let hostileRepo = "";
      withSeededRepo("cert-action-05-hostile", (repo, _git, heads) => {
        hostileRepo = repo;
        hostileResult = invokeAmbient(repo, heads, HOSTILE);
      });
      let cleanResult: ReturnType<typeof runInvoke> | null = null;
      let cleanRepo = "";
      withSeededRepo("cert-action-05-clean", (repo, _git, heads) => {
        cleanRepo = repo;
        cleanResult = invokeAmbient(repo, heads, undefined);
      });
      const hostile = hostileResult as unknown as ReturnType<typeof runInvoke>;
      const clean = cleanResult as unknown as ReturnType<typeof runInvoke>;

      expect(hostile.status).toBe(0);
      expect(annotationOf(hostile.stdout)).toBe("");
      // Byte for byte, modulo the one random value the recorded
      // projection owns: the hostile envelope equals the clean envelope.
      expect(project(replayOutcome(hostile.outputs), hostileRepo)).toBe(
        project(replayOutcome(clean.outputs), cleanRepo),
      );
      expect((JSON.parse(replayOutcome(hostile.outputs)) as { kind: string }).kind).toBe(
        "published",
      );
      // No planted value is reachable in the envelope, the annotation, or
      // the conclusion — and GITHUB_OUTPUT was planted at /evil/outputs:
      // the write still went to the file the step passed.
      for (const mark of MARKS) {
        expect(hostile.stdout.toString("utf8")).not.toContain(mark);
        expect(hostile.stderr.toString("utf8")).not.toContain(mark);
        expect(hostile.outputs.toString("utf8")).not.toContain(mark);
      }
      expect(hostile.outputs.length).toBeGreaterThan(0);
    },
  );

  it(
    "action-06 · the drift row's paired files — the composite's declared toolchain values equal the repository's .node-version and packageManager",
    { timeout: 45_000 },
    () => {
      // The row's data owned here: which files (`.node-version`,
      // `package.json`'s `packageManager`) pair with which declared
      // fields (`node-version`, `version`), read from the composite's
      // executable lines.
      const executable = ACTION_METADATA.split("\n").filter((line) => !line.trim().startsWith("#"));
      const declared = (field: string): string => {
        const row = executable.find((line) => line.trimStart().startsWith(`${field}:`));
        if (row === undefined) {
          throw new Error(`the composite declares no ${field} row`);
        }
        return row.split(":")[1]?.trim() ?? "";
      };
      const declaredNode = declared("node-version");
      const declaredPnpm = declared("version");
      const pinnedNode = readFileSync(
        join(import.meta.dirname, "..", "..", ".node-version"),
        "utf8",
      ).trim();
      const packageJson = JSON.parse(
        readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8"),
      ) as { packageManager: string };
      expect(declaredNode).toBe(pinnedNode);
      expect(declaredPnpm).toBe(packageJson.packageManager.split("@")[1]);
      // The file-keyed mechanism stays unrepresentable, not merely unused.
      expect(ACTION_METADATA).not.toContain("node-version-file");
      expect(ACTION_METADATA).not.toContain("package_json_file");
    },
  );
});
