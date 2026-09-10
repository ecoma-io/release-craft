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

import { hermeticGitEnv } from "@ecoma-io/release-craft/adapters/git";

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
 * The environment the fixture's installs run under, and the hermeticity
 * contract both this fixture and its pins read. The ambient composition (the
 * moon-spawned worker, not the test author's shell) leaks git context —
 * GIT_DIR among it — and with GIT_DIR exported the prepare script's
 * `lefthook install` finds a repository anyway: its probe succeeds, the
 * unflagged install exits 0, the materialization shape stops reproducing the
 * defect. The installs therefore run on the binding's hermetic floor, the
 * same one the world fixture's closure runs on — sufficiency of that leak is
 * proven by the positive control leg below. The agent markers are stripped on
 * top to pin the reporter's shape: they never moved the exit code (refuted as
 * the historical trigger), but pnpm switches to NDJSON output when they leak,
 * and the fixture reads the reporter's lines as fault-shape evidence.
 */
const AGENT_MARKERS: Record<string, true> = {
  CLAUDECODE: true,
  CLAUDE_CODE: true,
  AGENT: true,
};

const INSTALL_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(hermeticGitEnv()).filter(([key]) => !(key in AGENT_MARKERS)),
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
        // The hermeticity contract, pinned so the floor is mutation-proven:
        // the env handed to the spawns carries none of the markers whose
        // ambient presence flips pnpm's reporter to NDJSON. Removing the
        // strip fails here wherever the harness ambient carries them.
        expect(
          Object.keys(INSTALL_ENV).filter((key) => key in AGENT_MARKERS),
          "the fixture's installs inherited the ambient agent markers — the strip was removed",
        ).toEqual([]);
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
        // The reporter's shape, pinned observably: pnpm's NDJSON agent mode
        // would ride this discriminator line into the output above and
        // re-shape the fault evidence the assertions read. In a marker-free
        // CI ambient this passes vacuously; wherever the markers leak, it
        // fails loudly — the strip's contract is never silently lost.
        expect(
          witnessed,
          "the install reported through pnpm's NDJSON agent reporter — the ambient markers leaked past the floor",
        ).not.toMatch(/Detected an AI agent environment/);
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
