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
 * This fixture rebuilds the materialization's exact shape — the two files
 * the install consumes, `package.json` and `pnpm-lock.yaml`, copied from
 * this repository, no `.git`, under the tmpdir — and pins the scripts-free
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
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const install = (dir: string, extraArgs: readonly string[]) =>
  spawnSync("pnpm", ["install", "--frozen-lockfile", ...extraArgs], {
    cwd: dir,
    encoding: "utf8",
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
        // never reached. The spawn-error guard keeps the leg honest: an
        // unresolvable pnpm arrives as `status: null`, which must not read
        // as the failure this leg asserts.
        const scriptsRun = install(bare, []);
        expect(scriptsRun.error, `pnpm failed to run: ${String(scriptsRun.error)}`).toBeUndefined();
        expect(
          scriptsRun.status,
          `the unflagged install exited 0 — the materialization shape no longer reproduces the defect:\n${scriptsRun.stdout}${scriptsRun.stderr}`,
        ).not.toBe(0);
      });
      withMaterialization((materialized) => {
        // The composite's run line: the provisioning's product installs
        // clean in the same non-git shape, no lifecycle script executed.
        const scriptsFree = install(materialized, ["--ignore-scripts"]);
        expect(
          scriptsFree.error,
          `pnpm failed to run: ${String(scriptsFree.error)}`,
        ).toBeUndefined();
        expect(
          scriptsFree.status,
          `the scripts-free install failed (exit ${String(scriptsFree.status)}):\n${scriptsFree.stdout}${scriptsFree.stderr}`,
        ).toBe(0);
      });
    },
  );
});
