#!/usr/bin/env node
// The GitHub Action's invocation program — the one in-repo script the
// composite's `run:` step drives and the artifact suite drives as a
// subprocess (phase 13 contract §2.7: "one script file in this repository").
//
// Its whole job is the projection the contract assigns it (invariant 2.10 at
// the automation layer): action inputs in, one command out, the verdict
// rendered. It performs zero validation of its own — the closed grammar is
// the validation, and a value the grammar refuses surfaces as the CLI's exit
// 64 with the synopsis, annotated. Concretely, in order:
//
//   1. project the inputs into the built bin's argv, in §2.7's exact order —
//      `run --assembly git --repo … --tag-namespace … --max-retries …
//      --world … --intent … --actor … --line … --json`;
//   2. spawn the bin under the OUTER hermeticity line (§4): an environment
//      of exactly two names — `PATH` (the step's own, so `node` and `git`
//      resolve) and `HOME` (a fresh empty directory under `$RUNNER_TEMP`) —
//      with stdin closed. Every input enters as argv; the runner's ambient
//      layer (`GITHUB_*`, `ACTIONS_*`, `RUNNER_*`, `CI`, the injected
//      `INPUT_*` channel, a planted `NODE_OPTIONS`) reaches nothing past
//      this line. Allowlist, never blocklist: `env -i` plus two names is the
//      whole policy, and the review of the policy is the review of this list;
//   3. capture the `--json` envelope byte-for-byte and relay it to the step
//      log verbatim — display, not translation;
//   4. write the one `outcome` output through the PRESERVING WRITE (§3.1):
//      the envelope, then one empty content line, then the delimiter. The
//      runner's file-command parser consumes the value's final newline
//      before the delimiter (actions/runner#1182), so a bare heredoc would
//      deliver the envelope without its trailing newline; the empty line is
//      the byte the parser eats instead, and the replayed value equals the
//      captured stdout exactly;
//   5. annotate and exit per the conclusion table (§3.2) — the table keyed
//      on the envelope's kind, checked against the CLI's exit code: the exit
//      is the kind's integrity check, and their disagreement is the
//      no-verdict row. The step conclusion is not the exit code:
//      `satisfied-externally` exits 1 and concludes success. A fault never
//      renders as a verdict; a missing verdict fails closed (never green,
//      never neutral).
//
// This program is the outer line, so it may read the runner's environment —
// it reads exactly two names (`PATH`, `RUNNER_TEMP`) to build the child's
// allowlist, and names no `INPUT_*` variable: the composite's step
// interpolates the declared inputs into this program's argv through the
// step's own `env:` block (reviewed metadata, one shell-quoted word each),
// which is the one channel the contract allows. Everything else arrives as
// argv below.
//
// Exit codes: 0 the conclusion is success · 1 failure (a stop-band verdict,
// a fault, a no-verdict row, or this program's own pre-invocation fault —
// which annotates nothing; the failing step's own log and conclusion are the
// evidence).
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The conclusion table (§3.2) — one row per `RunOutcome` kind
 * (`src/app/types.ts`'s union, the same twelve rows `src/cli/exit-codes.ts`
 * carries for them), keyed on the envelope kind: the exit code the kind must
 * agree with (the integrity pin — both derive from `EXIT_CODES`), the step
 * conclusion it renders, and the outcome field the `::error::` annotation
 * quotes verbatim (null for the proceed rows, which annotate nothing).
 *
 * The table is total over the run union on purpose: a kind outside it (the
 * planning and observation doors' kinds) arriving through a `run` invocation
 * is engine drift, and the no-verdict row names it.
 *
 * @type {Readonly<Record<string, { exit: number, conclusion: "success" | "failure", field: string | null }>>}
 */
const CONCLUSION_TABLE = {
  // — the proceed band: the door did what the invocation asked —
  published: { exit: 0, conclusion: "success", field: null },
  "satisfied-externally": { exit: 1, conclusion: "success", field: null },
  resolved: { exit: 2, conclusion: "success", field: null },
  abandoned: { exit: 3, conclusion: "success", field: null },
  // — the stop band: every row concludes failure; the annotation is the
  // row's own word, so the surrounding automation tells "needs a human" from
  // "broken" by the kind it reads, never by an exit code it guesses at —
  refused: { exit: 10, conclusion: "failure", field: "detail" },
  denied: { exit: 11, conclusion: "failure", field: "holder" },
  blocked: { exit: 12, conclusion: "failure", field: "cause" },
  failed: { exit: 13, conclusion: "failure", field: "cause" },
  conflict: { exit: 14, conclusion: "failure", field: "detail" },
  ambiguous: { exit: 15, conclusion: "failure", field: "detail" },
  stale: { exit: 16, conclusion: "failure", field: "detail" },
  escalate: { exit: 17, conclusion: "failure", field: "detail" },
};

/** The usage fault's exit (phase 12 §3.2, inherited). */
const EXIT_USAGE = 64;
/** The escaped-throw's exit (phase 12 §3.2, inherited). */
const EXIT_FAULT = 70;

/**
 * This program's own argv protocol — the composite's step passes exactly
 * these, one value each, shell-quoted. The values are the action inputs in
 * their raw transport form (the two multiline inputs as one string); their
 * CONTENT is never validated here: an empty `--actor`, an unknown
 * `--intent` spelling, an empty `tag-namespaces` all forward verbatim and
 * are the grammar's refusals to surface, not this program's.
 *
 * @type {ReadonlySet<string>}
 */
const DEMANDED = new Set([
  "bin",
  "outputs-file",
  "world",
  "line",
  "actor",
  "tag-namespaces",
  "repo",
  "max-retries",
]);

/**
 * Parses this program's argv. Every flag takes exactly one value; `--intents`
 * may be empty (the metadata's default), and every demanded flag must appear.
 * A protocol violation is a pre-invocation fault: this program never reaches
 * the bin, so it annotates nothing and fails the step by its own exit.
 *
 * @param {readonly string[]} argv
 * @returns {Map<string, string>}
 */
function parseProtocol(argv) {
  /** @type {Map<string, string>} */
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) {
      throw new Error(`unexpected argument "${String(token)}" — the protocol is flags only`);
    }
    const name = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`flag --${name} demands a value`);
    }
    if (values.has(name)) {
      throw new Error(`flag --${name} is declared once`);
    }
    values.set(name, value);
    index += 1;
  }
  for (const name of DEMANDED) {
    if (!values.has(name)) {
      throw new Error(`missing --${name} — the invocation step passes every protocol flag`);
    }
  }
  return values;
}

/**
 * Splits one multiline input into its lines: the one trailing newline a YAML
 * block scalar carries is the scalar's own punctuation and is dropped; every
 * interior line — empty ones included — forwards as written (§2.3's
 * multiline rule: one value per line, one flag occurrence each).
 *
 * @param {string} raw
 * @returns {string[]}
 */
function multilineLines(raw) {
  if (raw === "") {
    return [];
  }
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * The runner's annotation encoding, applied to verbatim text: the log
 * protocol escapes `%`, CR and LF (`%25`, `%0D`, `%0A`), which is how a
 * multi-line field value rides one annotation line and decodes back —
 * encoding, not translation.
 *
 * @param {string} text
 * @returns {string}
 */
function annotationLine(text) {
  const escaped = text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  return `::error::${escaped}`;
}

/**
 * The first line of a process's stderr, verbatim — the annotation the two
 * fault bands quote (§3.2: the usage and escaped-throw rows quote the first
 * stderr line; stdout is empty on both).
 *
 * @param {Buffer} stderr
 * @returns {string}
 */
function firstStderrLine(stderr) {
  return stderr.toString("utf8").split("\n")[0] ?? "";
}

/**
 * The preserving write (§3.1): the one `outcome` output, carrying the
 * captured stdout byte-for-byte. The runner's file-command parser takes each
 * content line without its trailing newline and drops the delimiter line, so
 * the write is the value, then one empty content line, then the delimiter —
 * the parser eats the empty line's terminator instead of the value's own
 * final newline, and the replayed value equals the captured stdout exactly.
 * An empty stdout is written as a zero-content value, which replays to "".
 *
 * @param {string} file the `$GITHUB_OUTPUT` path (passed by the step)
 * @param {Buffer} stdout the child's captured stdout
 * @returns {void}
 */
function writeOutcomeOutput(file, stdout) {
  // Random per write, like the runner's own heredoc delimiters: a delimiter
  // that could collide with the value would truncate it. This program is the
  // outer line — its own entropy touches nothing the bin reads.
  const delimiter = `ghadelimiter_${randomUUID()}`;
  const head = Buffer.from(`outcome=<<${delimiter}\n`);
  const body =
    stdout.length > 0
      ? Buffer.concat([stdout, Buffer.from(`\n${delimiter}\n`)])
      : Buffer.from(`${delimiter}\n`);
  writeFileSync(file, Buffer.concat([head, body]));
}

/**
 * Runs the built bin once and renders what came back: the conclusion, the
 * annotation, the output. Returns the step's exit code — 0 for a success
 * conclusion, 1 otherwise.
 *
 * @param {Map<string, string>} values the protocol values
 * @returns {number}
 */
function invoke(values) {
  // §2.7's command, in its exact order. `--assembly git` is pinned (§2.6);
  // `--max-retries` is always forwarded, default "0" (§2.3); `--json` is
  // pinned (§2.3).
  const tagNamespaces = multilineLines(values.get("tag-namespaces") ?? "");
  const intents = multilineLines(values.get("intents") ?? "");
  /** @type {string[]} */
  const argv = [
    "run",
    "--assembly",
    "git",
    "--repo",
    values.get("repo") ?? "",
    ...tagNamespaces.flatMap((root) => ["--tag-namespace", root]),
    "--max-retries",
    values.get("max-retries") ?? "",
    "--world",
    values.get("world") ?? "",
    ...intents.flatMap((intent) => ["--intent", intent]),
    "--actor",
    values.get("actor") ?? "",
    "--line",
    values.get("line") ?? "",
    "--json",
  ];

  // The outer line (§4): `env -i` semantics through the two-name allowlist.
  // The child stands in this program's own working directory — the step's
  // declared `${{ inputs.working-directory }}` — so the declared `repo` and
  // `world` paths resolve against the cwd the metadata declared. Stdin is
  // closed: the invocation reads nothing interactively, and the `-` world
  // spelling finds an empty stream and usage-faults (§2.5).
  const home = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "release-craft-home-"));
  let child;
  try {
    child = spawnSync(process.execPath, [values.get("bin") ?? "", ...argv], {
      env: { PATH: process.env.PATH ?? "", HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "buffer",
      // The envelope is kilobytes; the ceiling exists so a runaway stdout
      // fails loudly instead of truncating silently (the same posture as the
      // binding's own spawn ceiling).
      maxBuffer: 64 * 1024 * 1024,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  if (child.error !== undefined) {
    // A pre-invocation fault: the invocation never happened, so no verdict
    // exists to render and no annotation is emitted (§3.2's no-verdict row,
    // parenthetical) — the failing step's own log and conclusion are the
    // evidence, and the `outcome` output is never written.
    process.stderr.write(`action-invoke: the bin could not be spawned: ${String(child.error)}\n`);
    return 1;
  }

  const stdout = child.stdout ?? Buffer.alloc(0);
  const stderr = child.stderr ?? Buffer.alloc(0);
  // The envelope rides verbatim, out as well as in (§3.1): the captured
  // stdout is the step log's display of it, before any annotation.
  if (stdout.length > 0) {
    process.stdout.write(stdout);
  }
  if (stderr.length > 0) {
    process.stderr.write(stderr);
  }
  writeOutcomeOutput(values.get("outputs-file") ?? "", stdout);

  const exit = child.status;
  if (exit === null) {
    // Killed by a signal — the caller's timeout, a runner death, an OOM.
    // Fail closed loudly at the last layer (§3.3): never green, never
    // neutral. The recorded evidence is what a human reads.
    process.stdout.write(`${annotationLine(`no verdict: signal ${String(child.signal)}`)}\n`);
    return 1;
  }

  // The envelope, if there is one: exactly the captured stdout, parsed. The
  // kind is the one verdict; the exit code is its integrity check.
  let kind = null;
  /** @type {Record<string, unknown> | null} */
  let envelope = null;
  try {
    const parsed = /** @type {unknown} */ (JSON.parse(stdout.toString("utf8")));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const candidate = /** @type {Record<string, unknown>} */ (parsed);
      if (typeof candidate.kind === "string") {
        kind = candidate.kind;
        envelope = candidate;
      }
    }
  } catch {
    // No envelope — the fault bands and the no-verdict row decide below.
  }

  if (kind !== null && envelope !== null) {
    const row = CONCLUSION_TABLE[kind];
    if (row !== undefined && row.exit === exit) {
      // A verdict, rendered by the table. The proceed rows annotate nothing;
      // every stop row quotes its field verbatim (`denied` with no holder
      // recorded quotes the kind alone — nothing is invented).
      if (row.conclusion === "failure") {
        const value = row.field === null ? null : (envelope[row.field] ?? null);
        const message = typeof value === "string" && value.length > 0 ? `${kind}: ${value}` : kind;
        process.stdout.write(`${annotationLine(message)}\n`);
      }
      return row.conclusion === "success" ? 0 : 1;
    }
    // Kind↔exit mismatch (or a kind outside the run union) — the CLI under
    // the pinned SHA and this Action disagree, which is exactly the loud way
    // to find that (§3.3). The raw exit is recorded; the run produced no
    // verdict.
    process.stdout.write(`${annotationLine(`no verdict: exit ${String(exit)}`)}\n`);
    return 1;
  }

  // No envelope. The two fault bands quote the first stderr line verbatim;
  // a fault whose stderr is somehow empty has nothing to quote and falls to
  // the no-verdict row rather than inventing a verdict (§3.3).
  if (exit === EXIT_USAGE || exit === EXIT_FAULT) {
    const line = firstStderrLine(stderr);
    const message = line === "" ? `no verdict: exit ${String(exit)}` : line;
    process.stdout.write(`${annotationLine(message)}\n`);
    return 1;
  }
  process.stdout.write(`${annotationLine(`no verdict: exit ${String(exit)}`)}\n`);
  return 1;
}

try {
  process.exitCode = invoke(parseProtocol(process.argv.slice(2)));
} catch (error) {
  // A pre-invocation fault in this program's own protocol: the failing
  // step's log and conclusion are the evidence — no annotation, no output.
  process.stderr.write(
    `action-invoke: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
