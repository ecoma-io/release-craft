/**
 * The CLI suite's harness (phase 12 contract §6): every fixture drives the
 * BUILT bin — `dist/src/cli/index.js` in a child process — because the
 * process surface, not the module, is the subject. The direct side of the
 * pass-through fixtures builds its engine through the CLI's own selection
 * module (`src/cli/selection.ts`) over the same world-document bytes the
 * child received, so "the CLI renders the door's value verbatim" is tested
 * by construction: identical assembly, identical boundary values, only the
 * transport differs.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect } from "vitest";

import {
  channelRefFor,
  GitChannelStore,
  type GitRun,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import { selectEngine } from "@ecoma-io/release-craft/__internal__/cli/selection.js";
import type { AssemblySelection } from "@ecoma-io/release-craft/__internal__/cli/parse.js";
import type { Observation, OperatorIntent, PlanningInput, RunOutcome } from "../../src/index.js";
import { withTempRepo } from "../adapters/git/temp-repo.js";
import { liveWorld, runInput, standingChannelStates } from "../vertical/matrix.js";
import { seedLineHeads } from "../vertical/matrix-git.js";

/** The built bin the suite executes — the build task is the test task's
 * dependency (moon.yml), so this path always holds the current sources. */
export const CLI_BIN = join(import.meta.dirname, "..", "..", "dist", "src", "cli", "index.js");

export interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** One child-process invocation of the built bin. `input` feeds stdin (the
 * `--world -` spelling); `env` replaces the child's environment wholesale. */
export const runCli = (
  args: readonly string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): CliResult => {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    encoding: "utf8",
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  if (result.error !== undefined) {
    throw new Error(`the CLI process failed to spawn: ${String(result.error)}`);
  }
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
};

/** The child's stdout as the one JSON document §3.1 promises. */
export const cliJson = (result: CliResult): unknown => JSON.parse(result.stdout) as unknown;

/** Pass-through equality (§6 obligation 3): the child's `--json` stdout
 * equals the direct door value, SERIALIZED. Both sides go through JSON —
 * the direct side's outcome carries domain value objects (Change, Version)
 * whose prototypes a `toStrictEqual` would see and a JSON document cannot —
 * so the comparison is exactly the contract's: the child's bytes are what
 * the door's value serializes to. */
export const expectPassThrough = (child: CliResult, direct: unknown): void => {
  expect(JSON.parse(child.stdout)).toStrictEqual(JSON.parse(JSON.stringify(direct)) as unknown);
};

/** Projects the two values a git-assembly outcome may quote that are
 * genuinely per-repository: the repository path embedded in a fault text's
 * own argv, and the claim token — `randomBytes` at the claim store (the
 * binding's one intentionally random value), quoted by every stage
 * record's claim guard. Everything else must be byte-equal. */
export const projectRepo = (value: unknown, repo = "\0"): unknown =>
  JSON.parse(
    JSON.stringify(value)
      .split(repo)
      .join("REPO")
      .replace(/"claim":"[0-9a-f]{64}"/g, '"claim":"CLAIM"')
      // A serialized value may carry the outcome as a STRING (a CliResult's
      // stdout) — its quotes are escaped there, so match that spelling too.
      .replace(/\\"claim\\":\\"[0-9a-f]{64}\\"/g, '\\"claim\\":\\"CLAIM\\"'),
  ) as unknown;

export const memorySelection = (maxRetries = 0): AssemblySelection => ({
  assembly: "memory",
  maxRetries,
});

export const gitSelection = (repo: string, maxRetries = 0): AssemblySelection => ({
  assembly: "git",
  repo,
  tagNamespaces: [""],
  maxRetries,
});

// ---------------------------------------------------------------------------
// World documents — the closed input as JSON bytes
// ---------------------------------------------------------------------------

/** §3.2's beta intent on the matrix's main line. */
export const betaIntent = { kind: "prerelease", stream: "beta", lineId: "main" } as const;

export const promoteIntent = { kind: "promote", lineId: "main" } as const;

/** The memory world document for one matrix line: the closed input exactly
 * as the boundary fixtures build it, serialized once and shared by both
 * sides of a pass-through fixture. */
export const memoryDoc = (lineId: string, intents: readonly unknown[] = []): PlanningInput =>
  runInput(liveWorld(), lineId, intents as never);

/** The git world document: the same matrix world with the run line's ref
 * head (and that head's commit sha) replaced by the real seeded oid — the
 * mint target the git assembly will rev-parse. Extra tags stand for the
 * recorded state a previous process's run left in the world; `tagFormats`
 * overrides the policy's declared per-line formats (the matrix declares
 * none — the bare default). */
export const gitDoc = (
  lineId: string,
  intents: readonly unknown[],
  heads: Readonly<Record<string, string>>,
  extraTags: readonly { readonly name: string; readonly commit: string }[] = [],
  tagFormats: Readonly<Record<string, string>> = {},
): PlanningInput => {
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

/** The world document's exact bytes — the value both the child (via stdin
 * or file) and the direct side (via parse) consume. */
export const docBytes = (doc: PlanningInput): string => `${JSON.stringify(doc, null, 2)}\n`;

// ---------------------------------------------------------------------------
// Direct-side doors — the same assembly the CLI builds, called in-process
// ---------------------------------------------------------------------------

export const directRun = (
  selection: AssemblySelection,
  docText: string,
  line: string,
  intents: readonly OperatorIntent[] = [],
  actor = "automation",
): RunOutcome => {
  const input = JSON.parse(docText) as PlanningInput;
  // The document's declared tag formats ride along — the same pass-through
  // `index.ts` performs, so the direct side's naming renders exactly what
  // the child's renders.
  return selectEngine(selection, input.policy.tagFormats).run({
    input,
    lineIds: [line],
    intents: intents.length > 0 ? intents : (input.intents ?? []),
    actor,
    targets: deriveTargetsOf(input),
  });
};

export const directPlan = (selection: AssemblySelection, docText: string) => {
  const input = JSON.parse(docText) as PlanningInput;
  // The document verbatim — the same boundary input the entrypoint hands
  // the engine since #319's fix: absence stays absence, the door fabricates
  // no `intents` field the world did not declare.
  return selectEngine(selection, input.policy.tagFormats).plan(input);
};

export const directResume = (
  selection: AssemblySelection,
  docText: string,
  handle: {
    planId: string;
    attemptId: string;
    actor: string;
  },
): RunOutcome => {
  const input = JSON.parse(docText) as PlanningInput;
  return selectEngine(selection, input.policy.tagFormats).resume(handle, {
    input,
    lineIds: [],
    intents: [],
    actor: handle.actor,
    targets: deriveTargetsOf(input),
  });
};

export const directObserve = (
  selection: AssemblySelection,
  query: { kind: "channels" },
): Observation => selectEngine(selection).observe(query);

/** The CLI's own derivation, applied to the direct side's request — the
 * same function the entrypoint uses, so a target drift between the two
 * sides of a fixture is impossible by construction. */
const deriveTargetsOf = (input: PlanningInput): Readonly<Record<string, string>> => {
  const headByRef: Record<string, string> = {};
  for (const ref of input.repository.refs) {
    headByRef[ref.name] = ref.head;
  }
  const targets: Record<string, string> = {};
  for (const line of input.lines) {
    const head = headByRef[line.feedRef];
    if (head !== undefined) {
      targets[line.id] = head;
    }
  }
  return targets;
};

// ---------------------------------------------------------------------------
// Repository fixtures
// ---------------------------------------------------------------------------

/** A fresh temporary git repository carrying the matrix's seeded line heads
 * and the five standing channels — the exact world a git-assembly process
 * expects, deterministic in every object id (the fixture commits at the
 * fixed clock). */
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

/** A temp directory fixture for the `--world <path>` spelling. */
export function withTempDir(name: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), `release-craft-cli-${name}-`));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
