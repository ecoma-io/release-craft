/**
 * The provisioning leg, executed — the one shape no earlier layer drove, and
 * the first self-dogfood run caught (issue #142, run 34388697784). The
 * composite's "Install the lockfile" step installs inside the runner's
 * materialization of this repository, and that materialization is NOT a git
 * repository: the runner extracts the pinned action as an archive, there is
 * no `.git`. The package's own `prepare` script (`lefthook install`) cannot
 * succeed there — its `git rev-parse` exits 128, the install fails, and the
 * run door is never reached.
 *
 * This fixture rebuilds the materialization's exact shape — the three
 * files the install consumes, `package.json`, `pnpm-lock.yaml`, and the
 * policy file `pnpm-workspace.yaml` (pnpm 11.25 verifies the lockfile
 * against the supply-chain age policy declared there; the runner's
 * archive materialization carries it, so the fixture must too), copied
 * from this repository, no `.git`, under the tmpdir — and pins the
 * posture both ways (§2.2): without the flag, pnpm runs the package's
 * lifecycle scripts and they die; with the flag the composite's step
 * carries, the same install completes in the same tree. The metadata row
 * itself is pinned statically in `metadata.test.ts` and enforced by the
 * policy gate (`scripts/check-action-metadata.mjs`).
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hermeticGitEnv } from "../../src/adapters/git/index.js";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

/**
 * A scratch directory holding exactly what the runner's materialization
 * holds of the install's inputs — the manifest and the lockfile, no `.git` —
 * cleaned up whether the body passes or fails.
 */
function withMaterialization(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "release-craft-materialization-"));
  try {
    copyFileSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
    copyFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), join(dir, "pnpm-lock.yaml"));
    copyFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), join(dir, "pnpm-workspace.yaml"));
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
/**
 * The environment the fixture's installs run under. The ambient composition
 * (the moon-spawned worker, not the test author's shell) leaks git context —
 * GIT_DIR among it. With GIT_DIR exported, the prepare script's `lefthook
 * install` finds a repository anyway, its git probe succeeds, and the
 * unflagged install exits 0: the materialization shape stops reproducing the
 * defect, with or without any other ambient variable (#154 — the same leak
 * that let the dogfood closure observe the ambient checkout's commits). The
 * installs therefore run on the binding's hermetic floor, the same one the
 * world fixture's closure runs on. The agent markers are stripped on top only
 * to pin the reporter's shape: pnpm detects them and flips to NDJSON output —
 * cosmetic (they never moved the exit code), but the fixture reads the
 * reporter's lines as its fault-shape evidence.
 */
const INSTALL_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(hermeticGitEnv()).filter(
    ([key]) => key !== "CLAUDECODE" && key !== "CLAUDE_CODE" && key !== "AGENT",
  ),
);

const install = (dir: string, extraArgs: readonly string[]) =>
  spawnSync("pnpm", ["install", "--frozen-lockfile", ...extraArgs], {
    cwd: dir,
    encoding: "utf8",
    env: INSTALL_ENV,
  });

describe("fixture 1 — the provisioning installs in the non-git materialization", () => {
  it(
    "the scripts-free install completes where the lifecycle scripts die",
    // Two cold installs over the lockfile — seconds with a warm pnpm store,
    // the floor of a fresh runner's provisioning — so the budget is real.
    { timeout: 120_000 },
    () => {
      withMaterialization((bare) => {
        // The defect's exact condition: without the flag, pnpm runs the
        // package's own `prepare` (`lefthook install`), whose git probe
        // faults in the materialization — the install fails, the door is
        // never reached. The guards keep the leg honest: a pnpm that never
        // spawns, or dies before exiting, must not read as the failure this
        // leg asserts (`error` set, or `status: null`).
        const scriptsRun = install(bare, []);
        expect(scriptsRun.error, `pnpm failed to run: ${String(scriptsRun.error)}`).toBeUndefined();
        expect(scriptsRun.status, `pnpm was killed before exiting:\n${scriptsRun.stderr}`).toEqual(
          expect.any(Number),
        );
        expect(
          scriptsRun.status,
          `the unflagged install exited 0 — the materialization shape no longer reproduces the defect:\n${scriptsRun.stdout}${scriptsRun.stderr}`,
        ).not.toBe(0);
        // And the failure must be THE cause, not merely nonzero: pnpm ran
        // the prepare script's body (`$ lefthook install`) and reported its
        // lifecycle failure — the same pair the dogfood's log carries
        // (`. prepare$ lefthook install` → `[ELIFECYCLE]`). An unrelated
        // install error would leave the flag's value unproven.
        const witnessed = `${scriptsRun.stdout}${scriptsRun.stderr}`;
        expect(
          witnessed,
          "the unflagged install failed without running lefthook — not the defect's cause",
        ).toMatch(/lefthook install/);
        expect(
          witnessed,
          "the unflagged install failed without pnpm's ELIFECYCLE marker — the cause is not a lifecycle script",
        ).toMatch(/\[ELIFECYCLE\]/);
      });
      // The positive control, deterministic by construction: the SAME tree
      // under the SAME install, but with the ambient leak the composition
      // carries — GIT_DIR pointed at a repository — flipped to exit 0. The
      // hermetic floor above is what carries the first leg's assertion, not
      // the tree's shape alone; this leg reproduces the composition fault on
      // demand so the mechanism can never silently regress (#154).
      withMaterialization((leaked) => {
        const leakedRun = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
          cwd: leaked,
          encoding: "utf8",
          env: { ...INSTALL_ENV, GIT_DIR: join(REPO_ROOT, ".git") },
        });
        expect(leakedRun.status, `the leak control failed to exit:\n${leakedRun.stderr}`).toBe(0);
      });
      withMaterialization((materialized) => {
        // The composite's run line: the provisioning's product installs
        // clean in the same non-git shape, no lifecycle script executed.
        const scriptsFree = install(materialized, ["--ignore-scripts"]);
        expect(
          scriptsFree.error,
          `pnpm failed to run: ${String(scriptsFree.error)}`,
        ).toBeUndefined();
        // Same honesty on this leg: only a real exit code reads as the
        // completion the composite's step promises.
        expect(
          scriptsFree.status,
          `pnpm was killed before exiting:\n${scriptsFree.stderr}`,
        ).toEqual(expect.any(Number));
        expect(
          scriptsFree.status,
          `the scripts-free install failed (exit ${String(scriptsFree.status)}):\n${scriptsFree.stdout}${scriptsFree.stderr}`,
        ).toBe(0);
      });
    },
  );
});
