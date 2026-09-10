#!/usr/bin/env node
/**
 * The determinism stress harness (issues #154, #132): a committed script
 * that drives the suite — or selected files — under escalating parallel
 * load and captures full evidence on every run: the failing files, the
 * assertion text, and the per-run wall-clock. Designed to reproduce the
 * contention flakes so the root cause can be measured, not guessed, and
 * so the #154 class's lost evidence (the issue's own `tail -30`) is never
 * lost again.
 *
 *     node scripts/test-stress.mjs --mode=<mode> [--repeat=N] [options]
 *
 * Modes:
 *   single <file>    Run one file (`--file=<path>`).
 *   pair             Run world.test.ts + provisioning.test.ts together.
 *   suite            One full vitest suite run.
 *   parallel-2x      Two concurrent full-suite runs.
 *   parallel-4x      Four concurrent full-suite runs.
 *   vertical         One git-vertical.test.ts run (the V7 timing probe).
 *
 * Options:
 *   --repeat=N       Repeat the whole mode N times (default 1).
 *   --timeout=SECS   Per vitest run's wall-clock kill (default 600).
 *   --file=PATH      The file `single` runs.
 *   --json[=PATH]    Write the machine-readable run matrix (default
 *                    ./stress-results.json; a value names the file).
 *   --quiet          Print only the per-run verdict lines and the summary.
 *
 * Exit status: 0 when every run passed, 1 when any run failed.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v === undefined ? true : v];
  }),
);

const MODE = args.mode ?? "suite";
const REPEAT = Math.max(1, Number(args.repeat ?? 1));
const TIMEOUT = Math.max(30, Number(args.timeout ?? 600)) * 1000;
const QUIET = args.quiet === true;
const JSON_PATH =
  args.json === true ? "stress-results.json" : typeof args.json === "string" ? args.json : null;

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

const FILES = {
  world: "test/dogfood/world.test.ts",
  provisioning: "test/action/provisioning.test.ts",
  vertical: "test/vertical/git-vertical.test.ts",
};
const PAIR_FILES = [FILES.world, FILES.provisioning];

/** One vitest invocation: the runner, its shared args, and the JSON reporter
 * that carries per-test failure messages the summary reporter drops. */
const VITEST = "pnpm";
const VITEST_ARGS = ["exec", "vitest", "run", "--reporter=json", "--reporter=default"];

/**
 * Runs one vitest process over `files` (null = the whole suite) and resolves
 * with the run's structured verdict. The child is killed at `timeoutMs` — a
 * hang must surface as a failed run, never as a stuck harness.
 */
/** @param {readonly string[] | null} files @param {string} label */
function runVitest(files, label) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(VITEST, [...VITEST_ARGS, ...(files ?? [])], {
      cwd: process.cwd(),
      env: { ...process.env, CI: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      out += "\n[stress-harness] killed after the wall-clock timeout\n";
    }, TIMEOUT);

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = performance.now() - t0;

      // The JSON reporter's output starts with {"numTotalTestSuites" — find
      // it and parse the full object. The human-readable reporter's text
      // follows it in the stream.
      const jsonMarker = '{"numTotalTestSuites"';
      const jsonIdx = out.indexOf(jsonMarker);
      let report = null;
      if (jsonIdx >= 0) {
        try {
          // Walk forward from the marker to the matching closing brace.
          let depth = 0;
          let end = -1;
          for (let i = jsonIdx; i < out.length; i++) {
            if (out[i] === "{") depth++;
            else if (out[i] === "}") {
              depth--;
              if (depth === 0) {
                end = i;
                break;
              }
            }
          }
          if (end > jsonIdx) report = JSON.parse(out.slice(jsonIdx, end + 1));
        } catch {
          report = null;
        }
      }

      // Per-file, per-test failures with their assertion text.
      const failures = [];
      if (report?.testResults) {
        for (const fileResult of report.testResults) {
          if (fileResult.status !== "failed") continue;
          for (const assertion of fileResult.assertionResults ?? []) {
            if (assertion.status === "passed") continue;
            failures.push({
              file: fileResult.name?.replace(/^.*test\//, "test/") ?? fileResult.name,
              test: (assertion.ancestorTitles ?? []).concat(assertion.title ?? []).join(" > "),
              message: (assertion.failureMessages ?? []).join("\n").slice(0, 4000),
              durationMs: assertion.duration,
            });
          }
        }
      }

      const numTests = report?.numTotalTests ?? -1;
      const numFailed = report?.numFailedTests ?? -1;
      const numPassed = report?.numPassedTests ?? -1;
      // A killed run (SIGKILL leaves no JSON) or an unparseable report is a
      // failed run — the harness must never read a crashed child as a pass.
      const ok = code === 0 && report !== null && numFailed === 0;

      resolve({
        label,
        ok,
        exitCode: code,
        durationMs,
        numTests,
        numPassed,
        numFailed,
        failures,
        // Kept for verbose post-mortems; never printed unless asked.
        tail: out.slice(-8000),
        stderrTail: err.slice(-4000),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Modes — each returns the list of concurrent runs one repetition performs
// ---------------------------------------------------------------------------

/** @param {string} mode */
function runMode(mode) {
  switch (mode) {
    case "single":
      return [runVitest([args.file ?? FILES.world], `single:${args.file ?? FILES.world}`)];
    case "pair":
      return [runVitest(PAIR_FILES, "pair")];
    case "suite":
      return [runVitest(null, "suite")];
    case "parallel-2x":
      return [runVitest(null, "2x[A]"), runVitest(null, "2x[B]")];
    case "parallel-4x":
      return [
        runVitest(null, "4x[A]"),
        runVitest(null, "4x[B]"),
        runVitest(null, "4x[C]"),
        runVitest(null, "4x[D]"),
      ];
    case "vertical":
      return [runVitest([FILES.vertical], "vertical")];
    default:
      console.error(`test-stress: unknown mode "${mode}"`);
      console.error("modes: single | pair | suite | parallel-2x | parallel-4x | vertical");
      process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** @type {{ label: string, ok: boolean, exitCode: number | null, durationMs: number, numTests: number, numPassed: number, numFailed: number, failures: { file: string, test: string, durationMs: number, message: string }[] }[]} */
const allRuns = [];

// The CLI's and the Action's suites execute the BUILT bin — dist/src/cli/index.js
// (moon.yml's test task dependsOn build for exactly this reason). A direct
// `vitest run` bypasses Moon's graph, so the harness runs the build itself:
// without it every CLI subprocess test reads exit 1 (module-not-found), the
// #144 shape, and the run matrix measures a missing artifact rather than
// the contention class this harness exists for.
{
  const { spawnSync } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  if (!existsSync(join(process.cwd(), "dist", "src", "cli", "index.js"))) {
    console.log("  [test-stress] dist/ missing — running release-craft:build first");
    const build = spawnSync("pnpm", ["exec", "moon", "run", "release-craft:build"], {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    if (build.status !== 0) {
      console.error(`  [test-stress] build failed (exit ${build.status})`);
      process.exit(2);
    }
  }
}

if (!QUIET) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`  test-stress: mode=${MODE} repeat=${REPEAT} timeout=${TIMEOUT / 1000}s`);
  console.log(`${"=".repeat(72)}`);
}

for (let i = 0; i < REPEAT; i++) {
  if (REPEAT > 1) console.log(`\n--- repetition ${i + 1}/${REPEAT} ---`);
  const runs = await Promise.all(runMode(MODE));
  allRuns.push(...runs);

  for (const r of runs) {
    const verdict = r.ok ? "PASS" : "FAIL";
    const counts =
      r.numFailed > 0 ? `${r.numPassed} passed / ${r.numFailed} FAILED` : `${r.numPassed} passed`;
    console.log(
      `  ${r.ok ? "✓" : "✗"} ${r.label}: ${verdict} ${(r.durationMs / 1000).toFixed(1)}s · ${counts}` +
        (r.exitCode !== 0 ? ` · exit ${r.exitCode}` : ""),
    );
    // Every failure's assertion text goes to the transcript — the exact
    // evidence #154 lost to `tail -30`.
    for (const f of r.failures) {
      console.log(`      FAIL ${f.file} · ${f.test} (${Math.round(f.durationMs ?? 0)}ms)`);
      const first = (f.message ?? "").split("\n").find(Boolean);
      if (first) console.log(`        ${first.slice(0, 300)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Summary + machine-readable matrix
// ---------------------------------------------------------------------------

const total = allRuns.length;
const passed = allRuns.filter((r) => r.ok).length;
const failedRuns = total - passed;
const durationsSec = allRuns.map((r) => r.durationMs / 1000).sort((a, b) => a - b);
/** @param {number} p @returns {number | undefined} */
const percentile = (p) =>
  durationsSec[Math.min(durationsSec.length - 1, Math.floor(durationsSec.length * p))];

console.log(`\n${"=".repeat(72)}`);
console.log(`  SUMMARY ${passed}/${total} runs green · ${failedRuns} red`);
if (durationsSec.length > 0) {
  console.log(
    `  wall-clock s: min=${String(durationsSec[0]?.toFixed(1))} p50=${String(percentile(0.5)?.toFixed(1))} ` +
      `p95=${String(percentile(0.95)?.toFixed(1))} max=${String(durationsSec.at(-1)?.toFixed(1))}`,
  );
}

// Per-file flake census — which files ever failed, how often.
/** @type {Record<string, number>} */
const flakyFiles = {};
for (const r of allRuns) {
  for (const f of r.failures) {
    flakyFiles[f.file] = (flakyFiles[f.file] ?? 0) + 1;
  }
}
const flaky = Object.entries(flakyFiles).sort((a, b) => b[1] - a[1]);
if (flaky.length > 0) {
  console.log("  flaky files (failures across all runs):");
  for (const [file, count] of flaky) console.log(`    ${file}: ${count}`);
}
console.log(`${"=".repeat(72)}\n`);

if (JSON_PATH) {
  const report = {
    mode: MODE,
    repeat: REPEAT,
    timeoutMs: TIMEOUT,
    timestamp: new Date().toISOString(),
    runs: allRuns.map((r) => ({
      label: r.label,
      ok: r.ok,
      exitCode: r.exitCode,
      durationMs: Math.round(r.durationMs),
      numTests: r.numTests,
      numPassed: r.numPassed,
      numFailed: r.numFailed,
      failures: r.failures.map((f) => ({
        file: f.file,
        test: f.test,
        durationMs: f.durationMs,
        message: f.message,
      })),
    })),
    flakyFiles: Object.fromEntries(flaky),
  };
  const outPath = JSON_PATH.startsWith("/") ? JSON_PATH : join(process.cwd(), JSON_PATH);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`  matrix written to ${outPath}`);
}

process.exit(failedRuns > 0 ? 1 : 0);
