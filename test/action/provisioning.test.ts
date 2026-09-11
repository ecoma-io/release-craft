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
 * proven by the positive control leg below.
 *
 * The agent markers are stripped on top to pin the reporter's shape: they
 * never moved the exit code (refuted as the historical trigger), but a
 * marker leak flips the install's reporter to NDJSON, and the fixture reads
 * the reporter's lines as fault-shape evidence. The emitter is not pnpm
 * itself — no pnpm bundle on the writer's machine, 10.32.0 through 12.3.4,
 * carries the banner (#221): moon routes task commands through proto's
 * shims (`~/.proto/shims` leads the task PATH ahead of the corepack shim),
 * and proto prints its NDJSON agent banner onto the child's stdout when any
 * of its detection inputs survives the spawn env. The old three-variable
 * strip leaked exactly such an input — the ambient `AI_AGENT` — which is
 * why the failure fired only in moon-driven full-suite runs (proto-first
 * PATH) and never in isolation (corepack-first PATH) or CI (no agent
 * ambient). The list below mirrors the env inputs that fire
 * `detect_agent_from_vars` in the `ai_env` crate 0.1.3 — the version proto
 * 0.60.2 pins in its Cargo.toml — read from the crate source, plus `AGENT`,
 * kept from the original strip as defense in depth for detectors beyond
 * proto's. The source, not a bisect, is the authority here: a bisect that
 * sets each candidate to a generic non-empty value is structurally blind to
 * the crate's value-gated checks (`CURSOR_EXTENSION_HOST_ROLE` fires only
 * on `agent-exec`; `AI_AGENT` only on a self-id it classifies), and the
 * first bisect's candidate list simply omitted `CODEX_CI` and `OPENCODE`.
 * For the two value-gated inputs the strip still takes the exact key for
 * ANY value, an over-strip that is correct for a sanitizing fixture: the
 * env pin below asserts key absence, which only a value-independent rule
 * can guarantee, and no leg of this fixture needs a non-agent
 * extension-host role or self-id to survive the spawn env. (The crate also
 * reads `CLAUDE_CODE_IS_COWORK`, but only to refine the classification
 * after `CLAUDECODE`/`CLAUDE_CODE` already fired, so it cannot flip the
 * reporter alone; and it probes the filesystem for `/opt/.devin`, which no
 * env strip can cover.) With none of these inputs set, the detection never
 * fires and no proto resolution can flip the reporter; the banner line
 * itself is additionally event-gated inside proto — it rides exec-error
 * events, and healthy runs print nothing even where a marker leaked — so
 * the pins below, not the reporter assertion alone, carry the guarantee.
 */
const AGENT_MARKERS: Record<string, true> = {
  AI_AGENT: true,
  AGENT: true,
  ANTIGRAVITY_AGENT: true,
  AUGMENT_AGENT: true,
  CLAUDECODE: true,
  CLAUDE_CODE: true,
  CODEX_CI: true,
  CODEX_SANDBOX: true,
  CODEX_THREAD_ID: true,
  COPILOT_ALLOW_ALL: true,
  COPILOT_CLI: true,
  COPILOT_GITHUB_TOKEN: true,
  COPILOT_MODEL: true,
  CURSOR_AGENT: true,
  CURSOR_EXTENSION_HOST_ROLE: true,
  CURSOR_TRACE_ID: true,
  GEMINI_CLI: true,
  OPENCODE: true,
  OPENCODE_CLIENT: true,
  REPL_ID: true,
};

const INSTALL_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(hermeticGitEnv()).filter(([key]) => !(key in AGENT_MARKERS)),
);

/**
 * The fixture's install argv. The composite's own line is `install
 * --frozen-lockfile --ignore-scripts` (phase 13 §2.2); the fixture adds one
 * fixture-only flag — `--prefer-offline`, "skip staleness checks for cached
 * data, but request missing data from the server" (pnpm 11.25's own flag
 * documentation, the version this fixture's installs run under). A frozen
 * lockfile fixes the resolution graph, but a bare install still validates
 * its cached metadata against the registry before acting on it; the flag
 * drops that check, so a registry outage or a rate-limited runner cannot
 * turn this determinism fixture into a network test. It narrows the network
 * surface to exactly what the store lacks — a genuinely cold store still
 * requests its missing tarballs from the server, so the flag is a
 * staleness-check removal, not an offline guarantee. Factored as a function
 * so the exact argv is pinnable below, both legs.
 */
const installArgs = (extraArgs: readonly string[]): readonly string[] => [
  "install",
  "--frozen-lockfile",
  "--prefer-offline",
  ...extraArgs,
];

const install = (dir: string, extraArgs: readonly string[]) =>
  spawnSync("pnpm", installArgs(extraArgs), {
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
        // ambient presence flips the spawned toolchain's reporter to NDJSON
        // (proto's detection, see AGENT_MARKERS). Removing the strip fails
        // here wherever the harness ambient carries any of them — it does
        // on agent-driven machines (`AI_AGENT`).
        expect(
          Object.keys(INSTALL_ENV).filter((key) => key in AGENT_MARKERS),
          "the fixture's installs inherited the ambient agent markers — the strip was removed",
        ).toEqual([]);
        // The strip itself, pinned against silent trimming: every env input
        // `ai_env` 0.1.3's `detect_agent_from_vars` fires on — nineteen of
        // them, in the crate's own evaluation order (see AGENT_MARKERS for
        // the source) — must stay in the map. `AGENT` is deliberately
        // unpinned: it is not one of the crate's inputs, it is this
        // fixture's own defense-in-depth addition. The env pin above is
        // vacuous on machines whose ambient lacks a given marker, so a
        // "simplifying" deletion of exactly those entries would otherwise
        // pass everywhere until an ambient that carries one meets the
        // proto-first PATH again.
        expect(Object.keys(AGENT_MARKERS)).toEqual(
          expect.arrayContaining([
            // The crate's evaluation order, top to bottom.
            "CURSOR_TRACE_ID",
            "CURSOR_AGENT",
            "CURSOR_EXTENSION_HOST_ROLE",
            "GEMINI_CLI",
            "CODEX_SANDBOX",
            "CODEX_CI",
            "CODEX_THREAD_ID",
            "ANTIGRAVITY_AGENT",
            "AUGMENT_AGENT",
            "OPENCODE_CLIENT",
            "OPENCODE",
            "CLAUDECODE",
            "CLAUDE_CODE",
            "REPL_ID",
            "COPILOT_CLI",
            "COPILOT_MODEL",
            "COPILOT_ALLOW_ALL",
            "COPILOT_GITHUB_TOKEN",
            "AI_AGENT",
          ]),
        );
        // The offline floor, pinned as exact argv on both legs that act on
        // it: the unflagged (defect) leg and the scripts-free (composite)
        // leg. A silently dropped `--prefer-offline` would turn this
        // determinism fixture back into a network test (the metadata
        // staleness check returns), and any added flag would change what
        // the legs prove without review — only an exact match passes.
        expect(installArgs([])).toStrictEqual(["install", "--frozen-lockfile", "--prefer-offline"]);
        expect(installArgs(["--ignore-scripts"])).toStrictEqual([
          "install",
          "--frozen-lockfile",
          "--prefer-offline",
          "--ignore-scripts",
        ]);
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
        // The reporter's shape, pinned observably: the NDJSON agent banner
        // would ride this discriminator line into the output above and
        // re-shape the fault evidence the assertions read. In a marker-free
        // CI ambient this passes vacuously; wherever the markers leak, it
        // fails loudly — the strip's contract is never silently lost.
        expect(
          witnessed,
          "the install reported through the toolchain shim's NDJSON agent reporter — the ambient agent markers leaked past the floor",
        ).not.toMatch(/Detected an AI agent environment/);
      });
      // The positive control, deterministic by construction: the SAME tree
      // under the SAME install, but with the ambient leak the composition
      // carries — GIT_DIR pointed at a repository — flipped to exit 0. The
      // hermetic floor above is what carries the first leg's assertion, not
      // the tree's shape alone; this leg reproduces the composition fault on
      // demand so the mechanism can never silently regress (#154).
      withMaterialization((leaked) => {
        const leakedRun = spawnSync("pnpm", installArgs([]), {
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
