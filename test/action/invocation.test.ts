/**
 * The remaining §6 fixture obligations, against the invocation script as a
 * subprocess:
 *
 *   - the argv projection (§2.7): the inputs become the built bin's argv in
 *     the contract's exact command shape — `--assembly git` pinned,
 *     `--max-retries` always forwarded at its declared default, `--json`
 *     pinned, the two multiline inputs one flag occurrence per line;
 *   - the multiline transport rule (§2.3): the one trailing newline a block
 *     scalar carries is punctuation and is dropped; interior empty lines
 *     forward verbatim — the every-tag root is the empty line, and an empty
 *     intent line is the grammar's refusal to surface (exit 64), never a
 *     value this program silently drops;
 *   - obligation 3 (the preserving write): the replayed `outcome` output
 *     equals the relayed stdout byte-for-byte, including the envelope's
 *     trailing newline — the empty content line is what the runner's
 *     file-command parser eats instead of the value's own final newline, so
 *     the naive heredoc shape provably fails the same replay;
 *   - obligation 4 (hostile environment): the runner's planted ambient layer
 *     (`GITHUB_*`, `ACTIONS_*`, `RUNNER_*`, `CI`, the injected `INPUT_*`
 *     channel, `GIT_DIR`) never reaches planning — the echo seam proves the
 *     child's whole environment is exactly {HOME, PATH}, and the run's
 *     verdict is byte-equal to the clean run's modulo the claim token. A
 *     workflow-level `NODE_OPTIONS` plant is overridden by the step's own
 *     `env:` block (§6.4: the run is unchanged), and the counterfactual —
 *     the override stripped — shows the plant killing the step loudly;
 *   - obligation 7 (determinism): identical declared inputs over identical
 *     repositories give byte-equal verdicts modulo the claim token.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACTION_METADATA,
  ARGV_ECHO_BIN,
  ENV_ECHO_BIN,
  annotationOf,
  betaIntent,
  docBytes,
  gitDoc,
  replayOutcome,
  runInvoke,
  withActionRepo,
  withScratchDir,
  withSeededRepo,
  type InvokeInputs,
} from "./harness.js";
import { projectRepo } from "../cli/harness.js";

/** The every-tag root as a consumer would spell it: one empty line. */
const EVERY_TAG = "\n";

const baseInputs = (overrides: Partial<InvokeInputs> = {}): InvokeInputs => ({
  world: "/declared/world.json",
  line: "main",
  actor: "the-release-author",
  tagNamespaces: EVERY_TAG,
  ...overrides,
});

/** The stand-in bins are sources; the harness drives real paths, so each
 * projection look writes the echo bin into a scratch directory first. */
const echoBin = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "release-craft-action-echo-"));
  const bin = join(dir, "argv-echo.mjs");
  writeFileSync(bin, ARGV_ECHO_BIN);
  return bin;
};

/** Drives the script with the argv-echo stand-in bin and returns the argv
 * the script assembled — the window into the projection. The echo's stdout
 * is not an envelope, so the step itself concludes `no verdict` at exit 0;
 * the relayed bytes are the echo's document, and that is what this reads. */
const projectedArgv = (
  overrides: Partial<InvokeInputs> = {},
  options: { env?: NodeJS.ProcessEnv; input?: Buffer; cwd?: string } = {},
): readonly string[] => {
  const drive = runInvoke({ ...baseInputs(overrides), bin: echoBin() }, options);
  const relayed = drive.stdout
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("::error::"));
  expect(relayed).toHaveLength(1);
  const parsed = JSON.parse(relayed[0] ?? "") as { argv: string[] };
  return parsed.argv;
};

describe("fixture: the argv projection is §2.7's command, exactly", () => {
  it("every input lands in order — assembly pinned, retries forwarded, --json pinned", () => {
    expect(
      projectedArgv({
        repo: "client/checkout",
        tagNamespaces: "5.0.0\n",
        intents: "release\nprerelease:beta:main\n",
        maxRetries: "2",
      }),
    ).toStrictEqual([
      "run",
      "--assembly",
      "git",
      "--repo",
      "client/checkout",
      "--tag-namespace",
      "5.0.0",
      "--max-retries",
      "2",
      "--world",
      "/declared/world.json",
      "--intent",
      "release",
      "--intent",
      "prerelease:beta:main",
      "--actor",
      "the-release-author",
      "--line",
      "main",
      "--json",
    ]);
  });

  it("the declared defaults hold: max-retries 0 always forwarded, repo ., no intents channel", () => {
    const argv = projectedArgv();
    expect(argv).toStrictEqual([
      "run",
      "--assembly",
      "git",
      "--repo",
      ".",
      "--tag-namespace",
      "",
      "--max-retries",
      "0",
      "--world",
      "/declared/world.json",
      "--actor",
      "the-release-author",
      "--line",
      "main",
      "--json",
    ]);
  });
});

describe("fixture: the multiline transport rule", () => {
  it("interior empty lines forward verbatim — the every-tag root between named roots", () => {
    expect(projectedArgv({ tagNamespaces: "v\n\n5.0.0\n" })).toStrictEqual([
      "run",
      "--assembly",
      "git",
      "--repo",
      ".",
      "--tag-namespace",
      "v",
      "--tag-namespace",
      "",
      "--tag-namespace",
      "5.0.0",
      "--max-retries",
      "0",
      "--world",
      "/declared/world.json",
      "--actor",
      "the-release-author",
      "--line",
      "main",
      "--json",
    ]);
  });

  it("only the ONE trailing newline is dropped — two declared empty lines are two every-tag roots", () => {
    const argv = projectedArgv({ tagNamespaces: "\n\n" });
    expect(argv.filter((token) => token === "--tag-namespace")).toHaveLength(2);
    const roots = argv.filter((_token, index) => argv[index - 1] === "--tag-namespace");
    expect(roots).toStrictEqual(["", ""]);
  });

  it("an empty multiline input declares no flag occurrences at all", () => {
    expect(projectedArgv({ intents: "" }).filter((token) => token === "--intent")).toHaveLength(0);
  });
});

describe("fixture: the grammar's refusals surface — this program re-decides nothing", () => {
  it(
    "an empty intent line forwards as an empty --intent value and the CLI usage-faults at exit 64",
    { timeout: 45_000 },
    () => {
      withActionRepo("intent-empty-line", (repo, _git, worldPath) => {
        const drive = runInvoke(baseInputs({ world: worldPath, intents: "\n" }), { cwd: repo });
        expect(drive.status).toBe(1);
        expect(annotationOf(drive.stdout)).toBe(
          "::error::usage: flag --intent refuses the empty string as a value",
        );
      });
    },
  );

  it(
    "no declared namespace root is the CLI's refusal, spelled with the every-tag alternative",
    { timeout: 45_000 },
    () => {
      withActionRepo("namespaces-empty", (repo, _git, worldPath) => {
        const drive = runInvoke(baseInputs({ world: worldPath, tagNamespaces: "" }), { cwd: repo });
        expect(drive.status).toBe(1);
        expect(annotationOf(drive.stdout)).toBe(
          "::error::usage: missing --tag-namespace — the git assembly demands at least one declared " +
            'namespace root (the every-tag spelling is the empty string: --tag-namespace "")',
        );
      });
    },
  );

  it(
    "the `-` world spelling finds a closed stdin and usage-faults — piped stdin is this script's, never the child's",
    { timeout: 45_000 },
    () => {
      withActionRepo("world-dash", (repo, _git) => {
        // A whole VALID world document, piped into the script: still the
        // fault. The child's stdin is closed; the file path is the only
        // transport the Action offers (§2.5).
        const piped = runInvoke(baseInputs({ world: "-" }), {
          cwd: repo,
          input: Buffer.from(docBytes(gitDoc("main", [betaIntent], { main: "0".repeat(40) }))),
        });
        const dry = runInvoke(baseInputs({ world: "-" }), { cwd: repo });
        for (const drive of [piped, dry]) {
          expect(drive.status).toBe(1);
          expect(annotationOf(drive.stdout)).toBe(
            "::error::usage: the world document is not valid JSON",
          );
        }
      });
    },
  );
});

// ---------------------------------------------------------------------------
// §6 obligation 3 — the preserving write, replayed like the runner parses
// ---------------------------------------------------------------------------

describe("fixture: the output write survives the runner's file-command parse", () => {
  it(
    "the replayed `outcome` equals the relayed stdout byte-for-byte, trailing newline included",
    { timeout: 45_000 },
    () => {
      withActionRepo("output-write", (repo, _git, worldPath) => {
        const drive = runInvoke(baseInputs({ world: worldPath }), { cwd: repo });
        expect(drive.status).toBe(0);
        const stdout = drive.stdout.toString("utf8");
        // One compact envelope line plus its newline — the whole stdout, no
        // annotation to strip for a proceed row, and far under any buffer
        // ceiling that could turn truncation into a silent shape change.
        const lines = stdout.split("\n");
        expect(lines).toHaveLength(2);
        expect(stdout.endsWith("\n")).toBe(true);
        expect(stdout.length).toBeLessThan(1024 * 1024);
        expect(JSON.parse(lines[0] ?? "") as { kind: string }).toMatchObject({
          kind: "published",
        });
        expect(replayOutcome(drive.outputs)).toBe(stdout);

        // Pin the raw file-command bytes, not merely the replayed value. The
        // header is the runner's heredoc grammar (`NAME<<DELIM`), and the
        // empty content line after stdout is what preserves stdout's final LF.
        const outputText = drive.outputs.toString("utf8");
        const headerEnd = outputText.indexOf("\n");
        expect(headerEnd).toBeGreaterThan(0);
        const header = outputText.slice(0, headerEnd);
        expect(header).toMatch(
          /^outcome<<ghadelimiter_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
        const delimiter = header.slice("outcome<<".length);
        expect(drive.outputs).toEqual(
          Buffer.concat([
            Buffer.from(`${header}\n`),
            drive.stdout,
            Buffer.from(`\n${delimiter}\n`),
          ]),
        );
      });
    },
  );

  it("the naive heredoc shape loses only the final newline when its empty content line is omitted", () => {
    withActionRepo("output-naive", (repo, _git, worldPath) => {
      const drive = runInvoke(baseInputs({ world: worldPath }), { cwd: repo });
      const stdout = drive.stdout.toString("utf8");
      // The header is canonical here; this fixture isolates the second
      // defect only: value, delimiter — no empty content line. The parser
      // takes each content line WITHOUT its trailing newline, so replay loses
      // stdout's own final newline.
      const naive = Buffer.concat([
        Buffer.from("outcome<<ghadelimiter_fixed\n"),
        drive.stdout,
        Buffer.from("ghadelimiter_fixed\n"),
      ]);
      expect(replayOutcome(naive)).not.toBe(stdout);
      expect(replayOutcome(naive)).toBe(stdout.replace(/\n$/, ""));
    });
  });

  it("rejects the old outcome=<< header instead of masking the malformed protocol", () => {
    const malformed = Buffer.from(
      'outcome=<<ghadelimiter_fixed\n{"kind":"published"}\n\nghadelimiter_fixed\n',
    );
    expect(() => replayOutcome(malformed)).toThrow("'=' precedes '<<'; expected outcome<<DELIM");
  });

  it("replays an empty stdout from the canonical zero-content heredoc", () => {
    const empty = Buffer.from("outcome<<ghadelimiter_fixed\nghadelimiter_fixed\n");
    expect(replayOutcome(empty)).toBe("");
  });

  it(
    "a stop row's output carries the verdict envelope too — the annotation is log-only",
    { timeout: 45_000 },
    () => {
      withActionRepo("output-stop-row", (repo, _git, worldPath) => {
        const first = runInvoke(baseInputs({ world: worldPath }), { cwd: repo });
        expect(first.status).toBe(0);
        const second = runInvoke(baseInputs({ world: worldPath }), { cwd: repo });
        expect(second.status).toBe(1);
        const replayed = replayOutcome(second.outputs);
        expect(JSON.parse(replayed) as { kind: string }).toMatchObject({ kind: "conflict" });
        expect(replayed).toBe(second.stdout.toString("utf8").split("::error::")[0]);
        expect(annotationOf(second.stdout)).toMatch(/^::error::conflict: /);
      });
    },
  );
});

// ---------------------------------------------------------------------------
// §6 obligation 4 — the hostile environment never reaches planning
// ---------------------------------------------------------------------------

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

const PLANTED_MARKS = [
  "ghs_hostiletokenvalue",
  "ght_hostiletokenvalue",
  "evil/evil",
  "actionswithtoken",
  "/evil/world.json",
  "/evil/.git",
  "runner-tracking-evil",
];

/** The invoke step's `env:` block, parsed from the action.yml text — the
 * rows a runner composes OVER the workflow- and job-level environment (a
 * step block wins). Values are the literal YAML scalars; the quoted empty
 * string is the NODE_OPTIONS override, and it is read from the artifact so
 * this helper throws if the row this fixture depends on is ever removed. */
const invokeStepEnv = (metadata: string): Record<string, string> => {
  const lines = metadata.split("\n");
  const start = lines.indexOf("      env:");
  if (start === -1) {
    throw new Error("the action.yml invoke step declares no env: block");
  }
  const override: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("        ")) break;
    // The block may teach — comment lines explain the rows without being
    // rows.
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const row = /^ {8}([A-Z_]+): (.*)$/.exec(line);
    if (row === null) break;
    const key = row[1] ?? "";
    const raw = row[2] ?? "";
    override[key] = raw === '""' ? "" : raw.replace(/^"(.*)"$/, "$1");
  }
  return override;
};

describe("fixture: the planted ambient layer ends at the outer hermeticity line", () => {
  it(
    "the child's whole environment is exactly {HOME, PATH}; HOME is a fresh directory, the cwd is the declared one",
    { timeout: 45_000 },
    () => {
      withActionRepo("hostile-echo", (repo, _git, _worldPath) => {
        withScratchDir((scratch) => {
          const bin = join(scratch, "env-echo.mjs");
          writeFileSync(bin, ENV_ECHO_BIN);
          // RUNNER_TEMP is planted at an existing directory: the ONLY thing
          // it may choose is where the child's fresh HOME is made.
          const drive = runInvoke(baseInputs({ bin }), {
            cwd: repo,
            env: { ...HOSTILE, PATH: process.env.PATH ?? "", RUNNER_TEMP: scratch },
          });
          const relayed = drive.stdout
            .toString("utf8")
            .split("\n")
            .filter((line) => line.length > 0 && !line.startsWith("::error::"));
          expect(relayed).toHaveLength(1);
          const echo = JSON.parse(relayed[0] ?? "") as {
            env: Record<string, string>;
            cwd: string;
          };
          expect(Object.keys(echo.env).sort()).toStrictEqual(["HOME", "PATH"]);
          expect(echo.env.HOME?.startsWith(join(scratch, "release-craft-home-"))).toBe(true);
          expect(echo.cwd).toBe(repo);
          // Every planted VALUE is absent from the child's environment —
          // the keys already prove the names are.
          for (const mark of PLANTED_MARKS) {
            expect(JSON.stringify(echo.env)).not.toContain(mark);
          }
        });
      });
    },
  );

  it(
    "a real run under the planted layer plans identically — byte-equal modulo the claim token, no planted value anywhere",
    { timeout: 45_000 },
    () => {
      // Two identical repositories: the hostile drive runs on the first (a
      // fresh repo, so the run publishes), the clean drive on the second —
      // the comparison is the determinism pattern, so a second run on the
      // same repo (which would conflict) never muddies the equality.
      let hostileDrive: ReturnType<typeof runInvoke> | null = null;
      let hostileRepo = "";
      withActionRepo("hostile-real", (repo, _git, worldPath) => {
        hostileRepo = repo;
        hostileDrive = runInvoke(baseInputs({ world: worldPath }), {
          cwd: repo,
          env: { ...HOSTILE, PATH: process.env.PATH ?? "", RUNNER_TEMP: undefined },
        });
      });
      let cleanDrive: ReturnType<typeof runInvoke> | null = null;
      let cleanRepo = "";
      withActionRepo("hostile-clean", (repo, _git, worldPath) => {
        cleanRepo = repo;
        cleanDrive = runInvoke(baseInputs({ world: worldPath }), { cwd: repo });
      });
      const hostile = hostileDrive as unknown as ReturnType<typeof runInvoke>;
      const clean = cleanDrive as unknown as ReturnType<typeof runInvoke>;
      expect(hostile.status).toBe(0);
      expect(annotationOf(hostile.stdout)).toBe("");
      const cleanEnvelope = JSON.parse(replayOutcome(clean.outputs)) as unknown;
      const hostileEnvelope = JSON.parse(replayOutcome(hostile.outputs)) as unknown;
      expect(projectRepo(hostileEnvelope, hostileRepo)).toStrictEqual(
        projectRepo(cleanEnvelope, cleanRepo),
      );
      expect(JSON.parse(replayOutcome(hostile.outputs)) as { kind: string }).toHaveProperty(
        "kind",
        "published",
      );
      for (const mark of PLANTED_MARKS) {
        expect(hostile.stdout.toString("utf8")).not.toContain(mark);
        expect(hostile.stderr.toString("utf8")).not.toContain(mark);
        expect(hostile.outputs.toString("utf8")).not.toContain(mark);
      }
      // GITHUB_OUTPUT was planted at /evil/outputs: the write still went
      // to the file the step passed, never to the ambient name.
      expect(hostile.outputs.length).toBeGreaterThan(0);
    },
  );

  it(
    "a workflow-level planted NODE_OPTIONS is overridden by the step's env block — the run is unchanged (§6.4)",
    { timeout: 45_000 },
    () => {
      // The step's `env:` block, parsed from action.yml itself: the runner
      // composes workflow-level env FIRST and step env OVER it, so whatever
      // NODE_OPTIONS the consumer's workflow plants, this block's value
      // wins for this step. The override is read from the artifact, so a
      // test cannot pass while the row it depends on is gone.
      const stepEnv = invokeStepEnv(ACTION_METADATA);
      expect(stepEnv).toHaveProperty("NODE_OPTIONS", "");
      const planted = {
        ...HOSTILE,
        PATH: process.env.PATH ?? "",
        NODE_OPTIONS: "--require /no/such/release-craft-pwn.mjs",
      };
      withActionRepo("hostile-node-options", (repo, _git, worldPath) => {
        // The counterfactual, first — the row is load-bearing and this is
        // what it prevents: with the step block's override stripped, the
        // plant kills the step's own interpreter loudly, no verdict is
        // rendered, and the repository is untouched (the failure happens
        // before the bin is ever spawned).
        const bare = runInvoke(baseInputs({ world: worldPath }), { cwd: repo, env: planted });
        expect(bare.status).not.toBe(0);
        expect(bare.stdout.toString("utf8")).not.toContain('"kind":"published"');
        expect(bare.outputs.toString("utf8")).not.toContain("published");
        expect(bare.stderr.toString("utf8")).toContain("release-craft-pwn");
        // The step block applied over the plant — the runner's own
        // composition order — and §6.4's letter holds: the run is the clean
        // run, byte for byte, modulo the claim token.
        const drive = runInvoke(baseInputs({ world: worldPath }), {
          cwd: repo,
          env: { ...planted, ...stepEnv },
        });
        expect(drive.status).toBe(0);
        expect(annotationOf(drive.stdout)).toBe("");
        expect(drive.stderr.toString("utf8")).not.toContain("release-craft-pwn");
      });
      let cleanEnvelope: unknown = null;
      let cleanRepo = "";
      withActionRepo("node-options-clean", (repo, _git, worldPath) => {
        cleanRepo = repo;
        const clean = runInvoke(baseInputs({ world: worldPath }), { cwd: repo });
        expect(clean.status).toBe(0);
        cleanEnvelope = JSON.parse(replayOutcome(clean.outputs)) as unknown;
      });
      let plantedEnvelope: unknown = null;
      let plantedRepo = "";
      withActionRepo("node-options-planted", (repo, _git, worldPath) => {
        plantedRepo = repo;
        const drive = runInvoke(baseInputs({ world: worldPath }), {
          cwd: repo,
          env: { ...planted, ...stepEnv },
        });
        expect(drive.status).toBe(0);
        expect(JSON.parse(replayOutcome(drive.outputs)) as { kind: string }).toHaveProperty(
          "kind",
          "published",
        );
        plantedEnvelope = JSON.parse(replayOutcome(drive.outputs)) as unknown;
      });
      expect(projectRepo(plantedEnvelope, plantedRepo)).toStrictEqual(
        projectRepo(cleanEnvelope, cleanRepo),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// §2.3 as amended (#191) — the declared input inventory is closed
// ---------------------------------------------------------------------------

describe("fixture: an undeclared input key is refused, a declared name changes nothing", () => {
  it("an unknown INPUT_ name is a pre-invocation fault naming the key and the declared set", () => {
    withScratchDir((scratch) => {
      const bin = join(scratch, "argv-echo.mjs");
      writeFileSync(bin, ARGV_ECHO_BIN);
      // The runner injects every `with:` key as INPUT_<NAME> — declared or
      // not. `intent` is the classic typo of `intents`; planted here the
      // way the runner would plant it.
      const drive = runInvoke(baseInputs({ bin }), {
        env: { PATH: process.env.PATH ?? "", INPUT_INTENT: "release-anyway" },
      });
      expect(drive.status).toBe(1);
      // The pre-invocation fault posture: no annotation, no output written,
      // the bin never spawned — the step log is the evidence.
      expect(drive.stdout.toString("utf8")).toBe("");
      expect(drive.stderr.toString("utf8")).toContain('undeclared action input "intent"');
      expect(drive.stderr.toString("utf8")).toContain(
        "world, line, actor, tag-namespaces, intents, repo, max-retries, working-directory",
      );
      expect(drive.outputs).toHaveLength(0);
    });
  });

  it("a declared INPUT_ name — including one that reaches no flag — changes nothing", () => {
    withScratchDir((scratch) => {
      const bin = join(scratch, "argv-echo.mjs");
      writeFileSync(bin, ARGV_ECHO_BIN);
      const drive = runInvoke(baseInputs({ bin }), {
        env: {
          PATH: process.env.PATH ?? "",
          INPUT_INTENTS: "release-anyway",
          "INPUT_WORKING-DIRECTORY": "/somewhere",
          "INPUT_TAG-NAMESPACES": "v",
        },
      });
      // The echo bin's stdout is no envelope, so the script still concludes
      // no-verdict — but the pipeline ran: the relay rode, the output was
      // written, and the fault never fired.
      const replayed = replayOutcome(drive.outputs);
      expect(replayed).toContain('"argv"');
      expect(drive.stderr.toString("utf8")).toBe("");
      expect(drive.stderr.toString("utf8")).not.toContain("undeclared action input");
    });
  });

  it("a name of exactly INPUT_ is ignored — the rule is name-based and value-blind", () => {
    withScratchDir((scratch) => {
      const bin = join(scratch, "argv-echo.mjs");
      writeFileSync(bin, ARGV_ECHO_BIN);
      // An env var named exactly `INPUT_` carries nothing after the
      // prefix: no action input's name is the empty string, so the
      // inventory's law (strip the prefix, refuse unknown non-empty
      // names) declares this boundary rather than silently swallowing a
      // key — the declared boundary is pinned so a guard change reds it.
      const drive = runInvoke(baseInputs({ bin }), {
        env: { PATH: process.env.PATH ?? "", INPUT_: "" },
      });
      const replayed = replayOutcome(drive.outputs);
      expect(replayed).toContain('"argv"');
      expect(drive.stderr.toString("utf8")).toBe("");
      expect(drive.stderr.toString("utf8")).not.toContain("undeclared action input");
    });
  });
});

// ---------------------------------------------------------------------------
// §6 obligation 7 — determinism
// ---------------------------------------------------------------------------

describe("fixture: identical declared inputs over identical repositories agree", () => {
  it(
    "two independently seeded repositories give byte-equal verdicts modulo the claim token, and the same conclusion",
    { timeout: 45_000 },
    () => {
      let firstEnvelope: unknown = null;
      let secondEnvelope: unknown = null;
      let firstRepo = "";
      let secondRepo = "";
      withActionRepo("determinism-a", (repo, _git, worldPath) => {
        firstRepo = repo;
        const drive = runInvoke(baseInputs({ world: worldPath }), { cwd: repo });
        expect(drive.status).toBe(0);
        firstEnvelope = JSON.parse(replayOutcome(drive.outputs)) as unknown;
      });
      withActionRepo("determinism-b", (repo, _git, worldPath) => {
        secondRepo = repo;
        const drive = runInvoke(baseInputs({ world: worldPath }), { cwd: repo });
        expect(drive.status).toBe(0);
        secondEnvelope = JSON.parse(replayOutcome(drive.outputs)) as unknown;
      });
      expect(firstRepo).not.toBe(secondRepo);
      expect(projectRepo(secondEnvelope, secondRepo)).toStrictEqual(
        projectRepo(firstEnvelope, firstRepo),
      );
      expect((firstEnvelope as { tag: string }).tag).toBe("5.0.0-beta.1");
      expect((secondEnvelope as { tag: string }).tag).toBe("5.0.0-beta.1");
    },
  );

  it(
    "the same repository run twice from the same declared inputs diverges only where the ledger says it must",
    { timeout: 45_000 },
    () => {
      withSeededRepo("determinism-replay", (repo, _git, heads) => {
        const worldPath = join(repo, "world.json");
        writeFileSync(worldPath, docBytes(gitDoc("main", [betaIntent], heads)));
        const inputs = baseInputs({ world: worldPath });
        const first = runInvoke(inputs, { cwd: repo });
        expect(first.status).toBe(0);
        const second = runInvoke(inputs, { cwd: repo });
        expect(second.status).toBe(1);
        expect(JSON.parse(replayOutcome(second.outputs)) as { kind: string }).toHaveProperty(
          "kind",
          "conflict",
        );
      });
    },
  );
});
