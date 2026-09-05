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
  // The package alias is declared once per tool that must resolve it: tsconfig
  // `paths` for tsc and archkeep's resolution, package.json `exports` for the
  // emitted dist, and here for Vitest, which executes the sources and does not
  // read tsconfig paths. All three name the same kernel entrypoint — the
  // barrel core/domain/index.ts (ADR-0001 decision 8, as amended by ADR-0002
  // decision-log D6); each value's contract lives in its own file behind it.
  resolve: {
    alias: {
      "@ecoma-io/release-craft/domain": fileURLToPath(
        new URL("./core/domain/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // A glob that stops matching anything is a suite nobody ran. Without this,
    // vitest reports green for zero tests.
    passWithNoTests: false,
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
