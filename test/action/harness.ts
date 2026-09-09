/**
 * The Action artifact suite's harness (phase 13 contract §6): the suite is
 * an artifact suite — it drives the composite's invocation as a transcript.
 * The subject is `action/invoke.mjs`, the ONE in-repo script the composite's
 * invocation step drives; the suite executes that same file as a subprocess,
 * over a real temp-repo git binding and the built bin (`dist/src/cli/index.js`,
 * built from the pinned tree — moon.yml's test task depends on the build
 * task, so dist is never stale). The `$GITHUB_OUTPUT` file the step would
 * receive is pointed at a scratch file, and the runner's documented
 * file-command parse is replayed over the bytes the script wrote (§3.1).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { betaIntent, docBytes, gitDoc, withSeededRepo } from "../cli/harness.js";
import type { GitRun } from "../../src/adapters/git/index.js";

/** The invocation program — the composite's step and this suite drive the
 * same file; there is no second definition of the projection. */
export const INVOKE_SCRIPT = join(import.meta.dirname, "..", "..", "action", "invoke.mjs");

/** The built bin the composite executes — the same tree the consumer pinned. */
export const ACTION_BIN = join(import.meta.dirname, "..", "..", "dist", "src", "cli", "index.js");

/** The metadata the runner would read (`uses: ecoma-io/release-craft@sha`). */
export const ACTION_METADATA = readFileSync(
  join(import.meta.dirname, "..", "..", "action.yml"),
  "utf8",
);

/** The one `outcome` output's name — the Action's whole output surface (§3.1). */
export const OUTCOME_OUTPUT = "outcome";

/** The inputs one invocation carries, in their raw transport form: the two
 * multiline inputs as single strings, exactly as `${{ inputs.* }}` delivers
 * them (block scalars carry one trailing newline). */
export interface InvokeInputs {
  readonly world: string;
  readonly line: string;
  readonly actor: string;
  readonly tagNamespaces: string;
  readonly intents?: string;
  readonly repo?: string;
  readonly maxRetries?: string;
  /** The program the script spawns — the built bin by default; the fixtures
   * inject stand-ins (an envelope printer, an argv echo) through this seam. */
  readonly bin?: string;
  readonly outputsFile?: string;
}

export interface InvokeResult {
  /** The step conclusion's own exit: 0 success, 1 failure (§3.2). */
  readonly status: number;
  /** The script's stdout: the relayed envelope, then the annotation line. */
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  /** The raw bytes written to the `$GITHUB_OUTPUT` file. */
  readonly outputs: Buffer;
}

/** One invocation, driven the way the workflow drives it: the script as a
 * subprocess, the environment replaced wholesale when planted, stdin
 * deliverable (the child's stdin is closed — the script never reads it). */
export const runInvoke = (
  inputs: InvokeInputs,
  options: { env?: NodeJS.ProcessEnv; input?: string | Buffer; cwd?: string } = {},
): InvokeResult => {
  const scratch = mkdtempSync(join(tmpdir(), "release-craft-action-out-"));
  const outputsFile = inputs.outputsFile ?? join(scratch, "github-output");
  const args = [
    INVOKE_SCRIPT,
    "--bin",
    inputs.bin ?? ACTION_BIN,
    "--outputs-file",
    outputsFile,
    "--world",
    inputs.world,
    "--line",
    inputs.line,
    "--actor",
    inputs.actor,
    "--tag-namespaces",
    inputs.tagNamespaces,
    "--repo",
    inputs.repo ?? ".",
    "--max-retries",
    inputs.maxRetries ?? "0",
    ...(inputs.intents === undefined ? [] : ["--intents", inputs.intents]),
  ];
  const result = spawnSync(process.execPath, args, {
    encoding: "buffer",
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  if (result.error !== undefined) {
    rmSync(scratch, { recursive: true, force: true });
    throw new Error(`the invocation script failed to spawn: ${String(result.error)}`);
  }
  const outputs = existsSync(outputsFile) ? readFileSync(outputsFile) : Buffer.alloc(0);
  rmSync(scratch, { recursive: true, force: true });
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    outputs,
  };
};

/**
 * The runner's file-command parse, replayed over the written bytes (§3.1's
 * platform fact, actions/runner#1182): the parser takes each content line
 * WITHOUT its trailing newline and drops the delimiter line — content joined
 * by newline is the value. This replay is what makes the preserving write's
 * empty content line load-bearing: without it the value's own final newline
 * is consumed and byte-equality fails.
 *
 * @param {Buffer} bytes the file-command bytes
 * @returns {string} the value the runner would deliver as outputs.outcome
 */
export const replayOutcome = (bytes: Buffer): string => {
  const lines = bytes.toString("utf8").split("\n");
  const head = lines[0] ?? "";
  if (!head.startsWith(`${OUTCOME_OUTPUT}=<<`)) {
    throw new Error(`not a delimited file-command write: ${JSON.stringify(head)}`);
  }
  const delimiter = head.slice(`${OUTCOME_OUTPUT}=<<`.length);
  const end = lines.indexOf(delimiter, 1);
  if (end === -1) {
    throw new Error(`the delimiter line is missing — the write is malformed`);
  }
  return lines.slice(1, end).join("\n");
};

/** The stdout's annotation line — the last non-empty line, `::error::`-shaped
 * when the verdict failed. Empty for the proceed rows, which annotate
 * nothing. */
export const annotationOf = (stdout: Buffer): string => {
  const lines = stdout
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1] ?? "";
  return last.startsWith("::error::") ? last : "";
};

/** A scratch directory fixture for stand-in bins and outputs files. */
export function withScratchDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "release-craft-action-scratch-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Writes a stand-in bin: a real node program at a real path, printing the
 * given bytes on stdout and exiting with the given code. This is the
 * harness's outcome-injection seam (§6 obligation 2): the rows the
 * declarations-less one-shot `run` cannot produce today are driven through
 * the script's full pipeline — spawn, capture, conclude, write, annotate,
 * exit — with the envelope's kind and the exit code chosen by the fixture. */
export const envelopeBinSource = (stdout: string, code: number): string =>
  `process.stdout.write(${JSON.stringify(stdout)});\nprocess.exitCode = ${String(code)};\n`;

/** A stand-in bin that prints its own argv as one JSON document — the window
 * into the projection: the suite reads the assembled argv without executing
 * the engine. */
export const ARGV_ECHO_BIN =
  'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");\n';

/** A stand-in bin that prints its own environment and cwd as one JSON
 * document — the window into the outer hermeticity line: the suite reads the
 * child's whole environment and asserts the allowlist held. */
export const ENV_ECHO_BIN =
  'process.stdout.write(JSON.stringify({ env: process.env, cwd: process.cwd() }) + "\\n");\n';

/** A stand-in bin that kills itself — the no-verdict posture's signal leg. */
export const SIGKILL_BIN = 'process.kill(process.pid, "SIGKILL");\n';

/**
 * A real temp-repo fixture shaped the way a consumer's run looks: the
 * repository is the caller's checkout, the declared world document lives in
 * it, and the invocation stands in the repository with the default
 * `--repo .`. Deterministic heads (the binding's fixed clock), cleaned up
 * whether the body passes or fails.
 */
export function withActionRepo(
  name: string,
  fn: (
    repo: string,
    git: GitRun,
    worldPath: string,
    heads: Readonly<Record<string, string>>,
  ) => void,
): void {
  withSeededRepo(name, (repo, git, heads) => {
    const worldPath = join(repo, "world.json");
    writeFileSync(worldPath, docBytes(gitDoc("main", [betaIntent], heads)));
    fn(repo, git, worldPath, heads);
  });
}

// Re-exported so a fixture file needs one harness import.
export { betaIntent, docBytes, gitDoc, withSeededRepo };
