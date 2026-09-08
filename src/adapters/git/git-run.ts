/**
 * The git runner — the binding's one spawn point for the `git` binary.
 * ADR-0009 decision 7 limits the binding to local git object and ref
 * operations, and the no-runtime-dependency house rule keeps the invocation
 * on node's own child_process. Every primitive in the layer speaks through a
 * `GitRun` opened on exactly one repository path, so no binding module names
 * a cwd, an environment, or a buffer ceiling of its own (contract §2.1: the
 * layer consumes, never re-owns).
 */

import { spawnSync } from "node:child_process";

/**
 * An environmental fault of the git invocation itself — the binary missing,
 * the repository corrupt, a ref lock lost. It is not domain vocabulary: the
 * binding's doors map domain outcomes to returned values (contract §2.2's
 * refusal is "never a thrown surprise outside the door") and let this error
 * stand for what it is — the substrate failed.
 */
export class GitFaultError extends Error {
  /** The argv that failed, exactly as handed to the runner. */
  readonly args: readonly string[];
  /** The exit status, or null when git could not be spawned at all. */
  readonly status: number | null;
  /** git's stderr for the failed invocation. */
  readonly stderr: string;

  constructor(args: readonly string[], status: number | null, stderr: string) {
    super(`git ${args.join(" ")} failed (exit ${String(status ?? "unknown")}): ${stderr}`);
    this.name = "GitFaultError";
    this.args = args;
    this.status = status;
    this.stderr = stderr;
  }
}

/**
 * One synchronous git invocation bound to the opened repository: `input` is
 * piped to stdin (hash-object and commit-tree need it), stdout is returned
 * as text. Synchronous because the ports the binding implements are
 * synchronous (the Phase 4/5 locks) and the CAS primitives below lean on
 * git's per-ref lockfile, not on any orchestration of our own.
 */
export type GitRun = (args: readonly string[], input?: string) => string;

/**
 * The fixed identity and clock every deterministic commit carries. Exported
 * for the test fixture, whose root commit must be exactly as deterministic
 * as the binding's own (contract §4's real-repository fixtures must produce
 * object ids that are a pure function of the test's writes).
 */
export const COMMIT_ENV = {
  GIT_AUTHOR_NAME: "ecoma release-craft",
  GIT_AUTHOR_EMAIL: "binding@ecoma.local",
  GIT_COMMITTER_NAME: "ecoma release-craft",
  GIT_COMMITTER_EMAIL: "binding@ecoma.local",
  GIT_AUTHOR_DATE: "@0 +0000",
  GIT_COMMITTER_DATE: "@0 +0000",
} as const;

/** Ledger tails and claim records are small; the ceiling exists so a runaway
 * rev-list fails loudly instead of truncating silently. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * The git process variables that would resolve a spawned git away from its
 * own `cwd`: repository, work tree, index, and object-database overrides
 * that hook runners and CI wrappers export around their own plumbing. A
 * spawned git's repository must come from the `cwd` alone — the binding
 * opens on one repository; the fixtures build their own — so these are
 * stripped before every spawn. This is the leak that let a fixture commit
 * land on the invoking repository's refs while the suite ran inside a
 * hook.
 */
const LEAKED_GIT_CONTEXT: ReadonlySet<string> = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG",
]);

/**
 * The hermetic floor every binding or fixture git spawn runs on: process
 * env minus the leaked repository context, plus no system gitconfig and
 * no credential prompts, plus the deterministic commit identity. Exported
 * for the test fixture, whose spawns must be as hermetic as the
 * binding's own.
 */
export function hermeticGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    // GIT_TRACE* is ambient too: any export makes git write diagnostics to
    // stderr, which would ride the exit-1 shape the ref read's absence
    // discrimination keys on (#95) — a healthy absent ref would read as
    // corruption — and leak operator debugging output into every fault line.
    Object.entries(process.env).filter(
      ([key]) => !LEAKED_GIT_CONTEXT.has(key) && !key.startsWith("GIT_TRACE"),
    ),
  );
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    // The user gitconfig is as ambient as the system one for the binding's
    // law (ADR-0009 decision 7: nothing beyond the repository) — GIT_CONFIG_
    // NOSYSTEM covers only /etc/gitconfig, so the global file is pointed at
    // the empty device and a leaked GIT_CONFIG_GLOBAL is stripped above.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...COMMIT_ENV,
  };
}

/**
 * Opens the binding's git runner on `repo`. The environment is process.env
 * plus the hermetic floor — no system gitconfig, no credential prompts
 * (ADR-0009 decision 7: the binding reads nothing beyond its repository) —
 * and COMMIT_ENV. Baking COMMIT_ENV in is the cleanest way to fix the commit
 * clock while keeping `GitRun`'s two-argument signature: commit dates have
 * no `-c` spelling, and the fixed identity is inert for every
 * non-committing invocation the binding makes (contract §3's law — no clock,
 * no operator identity in the binding).
 */
export function openGitRun(repo: string): GitRun {
  const env = hermeticGitEnv();
  return (args, input) => {
    const result = spawnSync("git", [...args], {
      cwd: repo,
      input,
      env,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER_BYTES,
    });
    if (result.error !== undefined || result.status !== 0) {
      // A spawn failure carries no stderr; the error's own message is the
      // honest content for the fault line.
      throw new GitFaultError(args, result.status, result.stderr || result.error?.message || "");
    }
    return result.stdout;
  };
}
