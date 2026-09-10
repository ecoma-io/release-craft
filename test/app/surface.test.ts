/**
 * The surface-negative, isolation, and no-ambient gates, executable (the
 * application boundary contract §5, obligations 2, 6, and 7; §2.9's
 * negative inventory; §3's laws). The subject is the layer, not a module
 * list: the scans walk `src/app` and `test/app`, so a new boundary file
 * inherits every gate without this suite naming it.
 *
 * - Surface-negative (obligation 2): the barrel's runtime exports and the
 *   engine value's doors are the exact closed sets the contract names, and
 *   no door names anything from §2.9's inventory of stores and mutation
 *   primitives.
 * - No ambient (obligation 6): no boundary module names a clock, randomness,
 *   timers, fetch, console, process, or an escape hatch — statically, code
 *   and prose alike, the execution layer's gate carried up one layer.
 * - Isolation (obligation 7): no kernel, planner, or adapter module imports
 *   the boundary; no boundary module names a provider concept; no boundary
 *   test reaches past the barrels into a layer's internal modules.
 *
 * The gate bites: the last test runs every scanner over synthetic text
 * carrying one known offense each and expects the offense reported.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import * as app from "@ecoma-io/release-craft/app";
import { freshAssembly } from "./harness.js";

// ---------------------------------------------------------------------------
// The scans
// ---------------------------------------------------------------------------

/** One scanned-in offense: which file, and what the scan found there. */
interface Violation {
  readonly file: string;
  readonly detail: string;
}

/** Every boundary source file, sorted, so violations report in stable order. */
function appFiles(): string[] {
  const dir = join(import.meta.dirname, "..", "..", "src", "app");
  return readdirSync(dir, { encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

/** Every boundary test file (this directory), sorted the same way. */
function appTestFiles(): string[] {
  return readdirSync(import.meta.dirname, { encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

/** Run one projector over every file's text, collecting its violations. */
function scan(
  files: readonly string[],
  base: string,
  project: (file: string, text: string) => Violation[],
): Violation[] {
  return files.flatMap((file) => project(file, readFileSync(join(base, file), "utf8")));
}

/** The exact sibling and barrel imports a boundary module may name (§2.1):
 * its own modules and the layer barrels it composes, each named by its
 * package alias (`@ecoma-io/release-craft/…` — the spelling archkeep's
 * cross-project rule requires) — never an internal module of another layer,
 * never the package front door (`@ecoma-io/release-craft`, the barrel that
 * re-exports this very boundary). No Node built-in is permitted: the
 * boundary composes, it computes nothing that needs one. */
const ALLOWED_APP_IMPORTS: readonly string[] = [
  "./types.js",
  "./claims.js",
  "./channels.js",
  "./engine.js",
  "./release-pr-types.js",
  "./release-pr.js",
  "./assemble.js",
  "./index.js",
  "@ecoma-io/release-craft/execution",
  "@ecoma-io/release-craft/planner",
  "@ecoma-io/release-craft/adapters/git",
];

function importViolations(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  for (const match of text.matchAll(/(?:\bfrom|\bimport)\s+"([^"]+)"/g)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    if (ALLOWED_APP_IMPORTS.includes(specifier)) continue;
    violations.push({ file, detail: `imports "${specifier}"` });
  }
  if (/\bimport\s*\(/.test(text)) {
    violations.push({ file, detail: "performs a dynamic import()" });
  }
  return violations;
}

/** The global surface a deterministic boundary may never name — the
 * execution layer's gate, verbatim (obligation 6 extends it to the
 * boundary's modules). */
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

function sideEffectViolations(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  for (const forbidden of FORBIDDEN_GLOBALS) {
    if (forbidden.pattern.test(text)) {
      violations.push({ file, detail: `names ${forbidden.token} — ${forbidden.why}` });
    }
  }
  return violations;
}

/** Provider concepts (invariant 2.11; §1's non-goals): no provider name, no
 * provider client, no registry, credential, secret — in code or in prose.
 * The claim token is the kernel's own port vocabulary, not a credential,
 * so `token` is deliberately absent from this list. */
const PROVIDER_TOKENS: readonly {
  readonly token: string;
  readonly pattern: RegExp;
  readonly why: string;
}[] = [
  { token: "github", pattern: /\bgithub\b/i, why: "a provider name" },
  { token: "gitlab", pattern: /\bgitlab\b/i, why: "a provider name" },
  { token: "octokit", pattern: /\boctokit\b/i, why: "a provider client" },
  { token: "graphql", pattern: /\bgraphql\b/i, why: "a provider API surface" },
  { token: "registry", pattern: /\bregistry\b/i, why: "provider vocabulary" },
  { token: "credential", pattern: /\bcredential\b/i, why: "provider vocabulary" },
  { token: "secret", pattern: /\bsecret\b/i, why: "provider vocabulary" },
  { token: "provider", pattern: /\bprovider\b/i, why: "provider vocabulary" },
];

function providerViolations(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  for (const forbidden of PROVIDER_TOKENS) {
    if (forbidden.pattern.test(text)) {
      violations.push({ file, detail: `names ${forbidden.token} — ${forbidden.why}` });
    }
  }
  return violations;
}

/** No kernel, planner, or adapter module imports the boundary (obligation
 * 7): `src/app` is the top of the DAG — an edge drawn downward would make
 * the boundary a layer instead of a top. */
function layerImportViolations(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  for (const match of text.matchAll(/(?:\bfrom|\bimport)\s+"([^"]+)"/g)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    if (specifier.includes("app/")) {
      violations.push({ file, detail: `imports the application boundary "${specifier}"` });
    }
  }
  return violations;
}

const INTERNAL_LAYER_RE =
  /src\/(?:adapters|planner|execution)\/|src\/app\/(?!index\.(?:js|ts))|@ecoma-io\/release-craft\/__internal__\//;

/** No boundary test reaches past the barrels (obligation 7): the package
 * barrel, the boundary's own barrel, the fixtures, and this directory's
 * own modules — never a layer's internal module path. */
function testImportViolations(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  for (const match of text.matchAll(/(?:\bfrom|\bimport)\s+"([^"]+)"/g)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    if (INTERNAL_LAYER_RE.test(specifier)) {
      violations.push({ file, detail: `reaches an internal module "${specifier}"` });
    }
  }
  if (/\bimport\s*\(/.test(text)) {
    violations.push({ file, detail: "performs a dynamic import()" });
  }
  return violations;
}

/** Violations as reportable strings, prefixed with the scanned file. */
function render(violations: readonly Violation[]): string[] {
  return violations.map(({ file, detail }) => `${file} ${detail}`);
}

// ---------------------------------------------------------------------------
// Obligation 2 — the surface-negative inventory
// ---------------------------------------------------------------------------

describe("obligation 2 — the surface is doors and records, never a store or a primitive", () => {
  it("the boundary barrel's runtime exports are exactly the contract's closed set", () => {
    expect(Object.keys(app).sort()).toStrictEqual([
      "InvalidAssemblyConfigError",
      "MemoryRecordSink",
      "ReleasePRScopeError",
      "assembleGitBinding",
      "assembleMemoryStores",
      "claimScopeForLine",
      "openReleasePRGate",
      "parseIdentityClaim",
      "plannedChannelMoves",
      "renderReleasePRProjection",
      "stageContentFingerprint",
    ]);
    // The one class the boundary throws is an error like the kernel's own.
    expect(new app.InvalidAssemblyConfigError("detail") instanceof Error).toBe(true);
  });

  it("the engine value carries exactly the §2.6 doors, and none names §2.9's inventory", () => {
    const { engine } = freshAssembly();
    expect(Object.keys(engine)).toStrictEqual([
      "plan",
      "run",
      "resume",
      "resolve",
      "abort",
      "observe",
    ]);
    // §2.9's negative inventory, executable: a drive-by door that names a
    // store or a raw mutation primitive fails this loop, not a review.
    const inventory = [
      "store",
      "ledger",
      "register",
      "claims",
      "channels",
      "append",
      "mint",
      "acquir",
      "release",
      "transition",
      "drive",
      "start",
      "requeststep",
      "walk",
    ];
    for (const door of Object.keys(engine)) {
      expect(typeof engine[door as keyof typeof engine]).toBe("function");
      for (const banned of inventory) {
        expect(door.toLowerCase()).not.toContain(banned);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Obligations 6 and 7 — the boundary's module gates
// ---------------------------------------------------------------------------

describe("obligations 6 and 7 — the boundary modules are closed, ambient-free, provider-blind", () => {
  it("imports only its own modules, the package barrel, and the git binding's barrel", () => {
    expect(appFiles().length).toBeGreaterThan(0);
    expect(
      render(
        scan(appFiles(), join(import.meta.dirname, "..", "..", "src", "app"), importViolations),
      ),
    ).toEqual([]);
  });

  it("names no clock, no randomness, no timer, no process, no console (statically)", () => {
    expect(
      render(
        scan(appFiles(), join(import.meta.dirname, "..", "..", "src", "app"), sideEffectViolations),
      ),
    ).toEqual([]);
  });

  it("names no provider concept, in code or in prose", () => {
    expect(
      render(
        scan(appFiles(), join(import.meta.dirname, "..", "..", "src", "app"), providerViolations),
      ),
    ).toEqual([]);
  });

  it("no kernel, planner, or adapter module imports the boundary — the DAG tops out here", () => {
    const src = join(import.meta.dirname, "..", "..", "src");
    for (const layer of ["planner", "execution", "adapters"] as const) {
      const dir = join(src, layer);
      const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((name) =>
        name.endsWith(".ts"),
      );
      expect(files.length).toBeGreaterThan(0);
      expect(
        render(scan(files, dir, layerImportViolations)),
        `no ${layer} module may import the application boundary`,
      ).toEqual([]);
    }
  });

  it("no boundary test reaches past the barrels into a layer's internal modules", () => {
    expect(appTestFiles().length).toBeGreaterThan(1);
    // This suite is excluded from its own scan: it is the gate, and the
    // gate-bites fixtures below carry synthetic offenses by design.
    const scanned = appTestFiles().filter((name) => name !== "surface.test.ts");
    expect(render(scan(scanned, import.meta.dirname, testImportViolations))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The gate bites
// ---------------------------------------------------------------------------

describe("the gate bites: each scanner reports its offense on synthetic text", () => {
  it("every scanner names its offense, file and detail", () => {
    expect(render(importViolations("rogue.ts", 'import x from "node:fs";\n'))).toEqual([
      'rogue.ts imports "node:fs"',
    ]);
    expect(
      render(importViolations("rogue.ts", 'import y from "../adapters/git/refs.js";\n')),
    ).toEqual(['rogue.ts imports "../adapters/git/refs.js"']);
    expect(
      render(importViolations("rogue.ts", 'const m = await import("./sneaky.js");\n')),
    ).toEqual(["rogue.ts performs a dynamic import()"]);
    expect(render(sideEffectViolations("rogue.ts", "const stamp = Date.now();\n"))).toEqual([
      "rogue.ts names Date.now — clock read",
    ]);
    expect(render(sideEffectViolations("rogue.ts", "const env = process.env.HOME;\n"))).toEqual([
      "rogue.ts names process — process or environment access",
    ]);
    expect(render(providerViolations("rogue.ts", 'const where = "github";\n'))).toEqual([
      "rogue.ts names github — a provider name",
    ]);
    expect(render(providerViolations("rogue.ts", "// the provider's registry\n"))).toEqual([
      "rogue.ts names registry — provider vocabulary",
      "rogue.ts names provider — provider vocabulary",
    ]);
    expect(
      render(layerImportViolations("kernel.ts", 'import { plan } from "../app/index.js";\n')),
    ).toEqual(['kernel.ts imports the application boundary "../app/index.js"']);
    expect(
      render(
        testImportViolations(
          "rogue.test.ts",
          'import { x } from "@ecoma-io/release-craft/__internal__/execution/ledger.js";\n',
        ),
      ),
    ).toEqual([
      'rogue.test.ts reaches an internal module "@ecoma-io/release-craft/__internal__/execution/ledger.js"',
    ]);
    expect(
      render(
        testImportViolations(
          "rogue.test.ts",
          'import { y } from "@ecoma-io/release-craft/__internal__/app/engine.js";\n',
        ),
      ),
    ).toEqual([
      'rogue.test.ts reaches an internal module "@ecoma-io/release-craft/__internal__/app/engine.js"',
    ]);
  });
});
