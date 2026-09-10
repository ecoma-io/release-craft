import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * One suite for the repository's TypeScript sources. There is a build (unlike
 * the org's .mjs-first repos), but the suite still points at the sources the
 * runner itself executes — dist/ is an artifact of the build gate, not a test
 * subject.
 *
 * `coverage.include` names the sources rather than letting Vitest infer them
 * from imports. Every file the glob matches lands in the report whether or
 * not a test ever imported it, so a new uncovered file pushes the percentage
 * down — the only direction that makes a threshold mean anything. (Vitest 4
 * folded the old `coverage.all` switch into exactly this behaviour.)
 *
 * The thresholds are a floor, not a target, and they are enforced from the
 * first commit rather than retrofitted — a threshold added later is set to
 * whatever the number already happens to be.
 */
const SOURCES = ["src/**/*.ts", "core/domain/**/*.ts"];

export default defineConfig({
  // The package aliases are declared once per tool that must resolve them:
  // tsconfig `paths` for tsc and archkeep's resolution, package.json
  // `exports` for the emitted dist, and here for Vitest, which executes the
  // sources and does not read tsconfig paths. Each alias names its layer's
  // barrel (ADR-0001 decision 8, as amended by ADR-0002 decision-log D6);
  // each value's contract lives in its own file behind it. The `__internal__`
  // prefix maps the test suites onto the src tree without an exports entry —
  // tests import inside the layers, and a dist file that ever referenced the
  // prefix would fail to resolve loudly rather than silently re-export.
  resolve: {
    alias: [
      {
        find: "@ecoma-io/release-craft/__internal__/",
        replacement: fileURLToPath(new URL("./src/", import.meta.url)),
      },
      {
        find: "@ecoma-io/release-craft/domain",
        replacement: fileURLToPath(new URL("./core/domain/index.ts", import.meta.url)),
      },
      {
        find: "@ecoma-io/release-craft/planner",
        replacement: fileURLToPath(new URL("./src/planner/index.ts", import.meta.url)),
      },
      {
        find: "@ecoma-io/release-craft/execution",
        replacement: fileURLToPath(new URL("./src/execution/index.ts", import.meta.url)),
      },
      {
        find: "@ecoma-io/release-craft/app",
        replacement: fileURLToPath(new URL("./src/app/index.ts", import.meta.url)),
      },
      {
        find: "@ecoma-io/release-craft/adapters/git",
        replacement: fileURLToPath(new URL("./src/adapters/git/index.ts", import.meta.url)),
      },
      {
        find: "@ecoma-io/release-craft/adapters/github",
        replacement: fileURLToPath(new URL("./src/adapters/github/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // A glob that stops matching anything is a suite nobody ran. Without this,
    // vitest reports green for zero tests.
    passWithNoTests: false,
    // The contract fixtures execute real git on real disk (temp repos),
    // and Moon runs this suite beside lint, format, typecheck, build and
    // arch — CPU contention can push one long fixture past the 5s
    // default even though nothing hangs. Give the real-disk suites room
    // instead of making a hang the only failure mode they can express.
    testTimeout: 20_000,
    // Vitest's default worker count is `availableParallelism - 1`, which on a
    // shared machine (a PR runner, a dev box running several suites, the
    // pre-push hook running beside the editor) oversubscribes the CPUs the
    // moment every worker's fixtures spawn their own subprocesses — git
    // clones, `pnpm install` storms, node CLI runs — each of which blocks a
    // core the scheduler cannot reclaim. Capping workers bounds the
    // concurrency so a loaded run degrades linearly rather than failing
    // every time-sensitive fixture at once (#154, #132); the 4×-parallel
    // stress harness (scripts/test-stress.mjs) is the recorded evidence for
    // this number on 16 logical CPUs.
    maxWorkers: 4,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      include: SOURCES,
      exclude: ["**/*.test.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
