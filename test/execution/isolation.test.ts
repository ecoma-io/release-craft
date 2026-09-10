import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import * as surface from "../../src/index.js";

/**
 * The execution-isolation gate, executable — the fixture-isolation clause
 * of the Phase 4 contract (ADR-0005, mirroring the planner's §4 A3 gate).
 * The kernel is pure decision machinery over frozen values and passed-in
 * views: it imports its own modules, the planner barrel's canonicalJson,
 * and exactly one Node built-in — node:crypto in identity.ts for attempt
 * identity. No fs, no path, no clock, no randomness, no process, no
 * timers, no dynamic import. The subject is the layer, not a module list:
 * the scan walks src/execution, so a new kernel file inherits the gate
 * without this suite naming it.
 *
 * The gate bites: the last test runs both scanners over synthetic text
 * carrying one known offense each and expects the offense reported.
 */

/** The execution layer the gate polices, resolved from this suite's location. */
const EXECUTION_DIR = join(import.meta.dirname, "..", "..", "src", "execution");

/** The one Node built-in the frozen contract permits, and the only file. */
const ONLY_BUILTIN = "node:crypto";
const ONLY_BUILTIN_FILE = "identity.ts";

/** The one parent edge the kernel may draw — the planner's canonicalJson,
 * spelled exactly as the contract allows, never a planner-internal path. */
const PLANNER_BARREL = "@ecoma-io/release-craft/planner";

/** One scanned-in offense: which file, and what the scan found there. */
interface Violation {
  readonly file: string;
  readonly detail: string;
}

/** Every execution source file, sorted, so violations report in stable order. */
function executionFiles(): string[] {
  return readdirSync(EXECUTION_DIR, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

/** Run one projector over every execution file's text, collecting its violations. */
function scan(project: (file: string, text: string) => Violation[]): Violation[] {
  return executionFiles().flatMap((file) =>
    project(file, readFileSync(join(EXECUTION_DIR, file), "utf8")),
  );
}

/** Violations as reportable strings, prefixed with the layer-relative path. */
function render(violations: readonly Violation[]): string[] {
  return violations.map((violation) => `src/execution/${violation.file} ${violation.detail}`);
}

/**
 * Every import specifier an execution file names — static `from "…"`
 * clauses and side-effect `import "…"` statements alike. Dynamic `import(…)`
 * is banned outright: a computed specifier is exactly how an import scan
 * gets bypassed.
 */
function importViolations(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  for (const match of text.matchAll(/(?:\bfrom|\bimport)\s+"([^"]+)"/g)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    if (specifier.startsWith("./")) continue;
    if (specifier === PLANNER_BARREL) continue;
    if (specifier === ONLY_BUILTIN && file === ONLY_BUILTIN_FILE) continue;
    violations.push({ file, detail: `imports "${specifier}"` });
  }
  if (/\bimport\s*\(/.test(text)) {
    violations.push({ file, detail: "performs a dynamic import()" });
  }
  return violations;
}

/**
 * The global surface a deterministic kernel may never name: the clock in
 * both spellings, randomness, timers, fetch, the console, the process
 * object, and the escape hatches (globalThis, __dirname, require) that
 * would smuggle any of them back in. The gate fails closed: a hit means
 * the layer names the API, in code or in prose, and both are refused.
 */
const FORBIDDEN_GLOBALS: readonly {
  readonly token: string;
  readonly pattern: RegExp;
  readonly why: string;
}[] = [
  { token: "Date.now", pattern: /\bDate\.now\s*\(/, why: "clock read" },
  { token: "new Date", pattern: /\bnew\s+Date\s*\(/, why: "clock read via construction" },
  { token: "Math.random", pattern: /\bMath\.random\s*\(/, why: "randomness" },
  { token: "setTimeout", pattern: /\bsetTimeout\s*\(/, why: "timer" },
  { token: "setInterval", pattern: /\bsetInterval\s*\(/, why: "timer" },
  { token: "setImmediate", pattern: /\bsetImmediate\s*\(/, why: "timer" },
  { token: "fetch", pattern: /\bfetch\s*\(/, why: "network access" },
  { token: "console", pattern: /\bconsole\s*\./, why: "console output" },
  { token: "process", pattern: /\bprocess\s*[.[]/, why: "process or environment access" },
  { token: "globalThis", pattern: /\bglobalThis\b/, why: "global escape hatch" },
  { token: "localStorage", pattern: /\blocalStorage\b/, why: "storage access" },
  { token: "Bun", pattern: /\bBun\s*\./, why: "runtime-specific API" },
  { token: "Deno", pattern: /\bDeno\s*\./, why: "runtime-specific API" },
  { token: "__dirname", pattern: /__dirname/, why: "filesystem location access" },
  { token: "require", pattern: /\brequire\s*\(/, why: "CommonJS escape hatch" },
];

/** Name-and-shame scan: every forbidden global the file's text trips. */
function sideEffectViolations(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  for (const forbidden of FORBIDDEN_GLOBALS) {
    if (forbidden.pattern.test(text)) {
      violations.push({ file, detail: `names ${forbidden.token} — ${forbidden.why}` });
    }
  }
  return violations;
}

describe("the execution kernel is an isolated layer", () => {
  it("imports only kernel siblings, the planner barrel, and identity.ts's node:crypto", () => {
    expect(executionFiles().length).toBeGreaterThan(0);
    const violations = render(scan(importViolations));
    expect(
      violations,
      'the kernel imports nothing outside src/execution and the planner barrel (the @ecoma-io/release-craft/planner package alias) — the single permitted Node built-in is "node:crypto" in identity.ts (attempt identity hashing is pure computation)',
    ).toEqual([]);
  });

  it("names no clock, no randomness, no timer, no process, no console (statically)", () => {
    expect(executionFiles().length).toBeGreaterThan(0);
    const violations = render(scan(sideEffectViolations));
    expect(
      violations,
      "the kernel names no clock, no randomness, no timers, no fetch, no console, no process and no escape hatches — it decides, the engine acts (ADR-0005)",
    ).toEqual([]);
  });

  it("the gate bites: each scanner reports its offense on synthetic text", () => {
    expect(
      render(importViolations("rogue.ts", 'import { readdirSync } from "node:fs";\n')),
    ).toEqual(['src/execution/rogue.ts imports "node:fs"']);
    expect(
      render(importViolations("rogue.ts", 'const m = await import("./sneaky.js");\n')),
    ).toEqual(["src/execution/rogue.ts performs a dynamic import()"]);
    expect(render(sideEffectViolations("rogue.ts", "const stamp = Date.now();\n"))).toEqual([
      "src/execution/rogue.ts names Date.now — clock read",
    ]);
    expect(
      render(sideEffectViolations("rogue.ts", "globalThis.localStorage.getItem('k');\n")),
    ).toEqual([
      "src/execution/rogue.ts names globalThis — global escape hatch",
      "src/execution/rogue.ts names localStorage — storage access",
    ]);
  });

  it("mounts the execution kernel beside the planner on the package barrel", () => {
    expect(typeof surface.requestStep).toBe("function");
    expect(typeof surface.Version).toBe("function");
  });
});
