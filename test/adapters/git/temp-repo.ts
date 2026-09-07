/**
 * The shared fixture for the binding's tests (contract §4: binding tests run
 * over real, temporary repositories). Each fixture repository carries one
 * empty root commit whose identity and clock are the binding's fixed ones
 * (COMMIT_ENV), so every object id a test observes is a pure function of the
 * test's own writes — the same determinism the binding itself is held to
 * (contract §3).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { COMMIT_ENV, openGitRun, type GitRun } from "../../../src/adapters/git/index.js";

/** The shape createTempRepo hands back: the repository path, a runner bound
 * to it, and the cleanup every test owes. */
export interface TempRepo {
  readonly repo: string;
  readonly git: GitRun;
  cleanup(): void;
}

/** The hermetic environment the fixture's own spawns need. The runner bakes
 * the same floor, but `git init` must run before a runner can be opened on
 * the directory, so the fixture spawns it directly. */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  ...COMMIT_ENV,
};

const spawnGit = (repo: string, args: readonly string[]): void => {
  const result = spawnSync("git", [...args], { cwd: repo, env: GIT_ENV, encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${String(result.status ?? "unknown")}): ${result.stderr}`,
    );
  }
};

/** Initializes the fixture repository in place: local identity config (belt
 * and suspenders beside COMMIT_ENV — the env wins) and the deterministic
 * empty root commit. */
const initRepo = (repo: string): void => {
  spawnGit(repo, ["init"]);
  spawnGit(repo, ["config", "user.name", "ecoma release-craft"]);
  spawnGit(repo, ["config", "user.email", "binding@ecoma.local"]);
  spawnGit(repo, ["config", "commit.gpgsign", "false"]);
  spawnGit(repo, ["commit", "--allow-empty", "-m", "ecoma: root"]);
};

/**
 * Creates a fresh temporary repository under the OS temp dir: initialized,
 * locally configured, holding one empty root commit at the fixed clock.
 * `cleanup()` removes it; tests must always reach it (try/finally).
 */
export function createTempRepo(): TempRepo {
  const repo = mkdtempSync(join(tmpdir(), "release-craft-git-binding-"));
  try {
    initRepo(repo);
  } catch (error) {
    rmSync(repo, { recursive: true, force: true });
    throw error;
  }
  return {
    repo,
    git: openGitRun(repo),
    cleanup() {
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

/**
 * Runs `fn` against a fresh fixture repository tagged `name`, removing the
 * repository afterwards whether the body passes or fails.
 */
export function withTempRepo(name: string, fn: (repo: string, git: GitRun) => void): void {
  const repo = mkdtempSync(join(tmpdir(), `release-craft-git-binding-${name}-`));
  try {
    initRepo(repo);
    fn(repo, openGitRun(repo));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}
