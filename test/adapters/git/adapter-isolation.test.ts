import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fixture 6 — the isolation gate's new layer, executable (contract §4;
 * ADR-0009 decisions 3 and 7). Two structural scans pin the layering:
 *
 * - the engine cannot reach the binding: no file under `src/execution`
 *   names "../adapters/" — that parent edge is not one the engine may
 *   draw, in code or in prose;
 * - the binding consumes, never re-owns: every import under
 *   `src/adapters/git` is a Node built-in, the execution barrel
 *   ("@ecoma-io/release-craft/execution"), the planner barrel
 *   ("@ecoma-io/release-craft/planner"), or a relative sibling — judged
 *   by the target it resolves to, never by its prefix (#188). Engine
 *   internals beyond the barrel, test tooling, and
 *   provider packages are all outside the allowlist.
 *
 * The subject is the layer, not a module list: each scan walks its
 * directory, so a new file inherits the gate without this suite naming
 * it. The gate bites: the last test runs both scanners over synthetic
 * text carrying one known offense each — the execution kernel's gate's
 * own self-test shape.
 */

/** The repo root, resolved from this suite's location. */
const ROOT = join(import.meta.dirname, "..", "..", "..");
const ENGINE_DIR = join(ROOT, "src", "execution");
const BINDING_DIR = join(ROOT, "src", "adapters", "git");

/** The two parent barrels the binding may name, spelled exactly — the
 * layer aliases archkeep's cross-project rule requires (never a relative
 * path out of src/adapters/git, never the package front door). */
const ENGINE_BARREL = "@ecoma-io/release-craft/execution";
const PLANNER_BARREL = "@ecoma-io/release-craft/planner";

/** One scanned-in offense: which file, and what the scan found there. */
interface Violation {
  readonly file: string;
  readonly detail: string;
}

/** Every source file of a layer, relative and sorted, for stable reports.
 * The walk matches every TypeScript module spelling (.ts/.tsx/.mts/.cts),
 * so a new extension inherits the gate instead of escaping it. */
function layerFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.[cm]?tsx?$/.test(name))
    .sort();
}

/** Run one projector over every file of a layer, collecting its violations. */
function scanLayer(dir: string, project: (file: string, text: string) => Violation[]): Violation[] {
  return layerFiles(dir).flatMap((file) => project(file, readFileSync(join(dir, file), "utf8")));
}

/** The engine's one forbidden edge: any reach toward the binding — the
 * relative "../adapters/" spelling and the package alias alike, in code or
 * in prose; the gate fails closed either way. */
function engineReachViolations(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  if (text.includes("../adapters/")) violations.push({ file, detail: 'reaches "../adapters/"' });
  if (text.includes('"@ecoma-io/release-craft/adapters'))
    violations.push({ file, detail: 'reaches "@ecoma-io/release-craft/adapters"' });
  return violations;
}

/**
 * Whether one relative specifier, resolved from `file` (a layer-relative
 * path), stays inside the binding layer. The law judges the resolved
 * target, not the spelling (#188): "./git-run.js" is a sibling, while
 * "./../execution/kernel.js" is a cross-project import wearing the sibling
 * prefix.
 */
function resolvesInsideLayer(file: string, specifier: string): boolean {
  const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
  return resolved !== ".." && !resolved.startsWith("../");
}

/**
 * Every import specifier a binding file names — static `from "…"`
 * clauses and side-effect `import "…"` statements alike, in both quote
 * spellings with whitespace optional (a scanner blind to `from'…'` or
 * `from"…"` depends on a formatter for its sight; a keyword preceded by a
 * word character, a quote, or a hyphen is a word in prose or an object
 * literal, not an import). The specifier is one token without whitespace,
 * so a quote that closes a string value ("…recompute from") cannot open
 * one. A relative specifier is judged by the target
 * it resolves to: one that stays inside src/adapters/git is a sibling;
 * one that escapes it is a cross-project import and must name a barrel.
 * Dynamic `import(…)` is banned outright: a computed specifier is exactly
 * how an import scan gets bypassed. The allowlist is the layer's diet:
 * Node built-ins (the no-runtime-dependency house rule keeps git on node's
 * own child_process), the package barrel's ports, the planner barrel's
 * canonicalJson, and the binding's own siblings.
 */
function bindingImportViolations(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  for (const match of text.matchAll(/(?<![\w'"-])(?:\bfrom|\bimport)\s*(['"])([^'"\s]+)\1/g)) {
    const specifier = match[2];
    if (specifier === undefined) continue;
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      if (resolvesInsideLayer(file, specifier)) continue;
      violations.push({
        file,
        detail: `imports "${specifier}" — a relative specifier that resolves outside src/adapters/git is a cross-project import and must name a barrel`,
      });
      continue;
    }
    const allowed =
      specifier.startsWith("node:") || specifier === ENGINE_BARREL || specifier === PLANNER_BARREL;
    if (!allowed) violations.push({ file, detail: `imports "${specifier}"` });
  }
  if (/\bimport\s*\(/.test(text)) {
    violations.push({ file, detail: "performs a dynamic import()" });
  }
  return violations;
}

describe("the git binding is an isolated layer", () => {
  it("is unreachable from the engine — src/execution names no ../adapters/", () => {
    expect(layerFiles(ENGINE_DIR).length).toBeGreaterThan(0);
    const violations = scanLayer(ENGINE_DIR, engineReachViolations).map(
      (violation) => `src/execution/${violation.file} ${violation.detail}`,
    );
    expect(
      violations,
      "the engine cannot reach the binding — ../adapters/ is not an edge src/execution may draw (ADR-0009 decision 3)",
    ).toEqual([]);
  });

  it("imports only node builtins, the two barrels, and its own siblings", () => {
    expect(layerFiles(BINDING_DIR).length).toBeGreaterThan(0);
    const violations = scanLayer(BINDING_DIR, bindingImportViolations).map(
      (violation) => `src/adapters/git/${violation.file} ${violation.detail}`,
    );
    expect(
      violations,
      "the binding consumes the ports through the package barrel and speaks to git through its own modules — nothing else (ADR-0009 decision 7)",
    ).toEqual([]);
  });

  it("the gate bites: each scanner reports its offense on synthetic text", () => {
    expect(
      engineReachViolations(
        "rogue.ts",
        'import { openGitBinding } from "../adapters/git/index.js";\n',
      ).map((violation) => `src/execution/${violation.file} ${violation.detail}`),
    ).toEqual(['src/execution/rogue.ts reaches "../adapters/"']);
    expect(
      engineReachViolations(
        "rogue-alias.ts",
        'import { openGitBinding } from "@ecoma-io/release-craft/adapters/git";\n',
      ).map((violation) => `src/execution/${violation.file} ${violation.detail}`),
    ).toEqual(['src/execution/rogue-alias.ts reaches "@ecoma-io/release-craft/adapters"']);
    expect(
      engineReachViolations("clean.ts", 'import { requestStep } from "./attempt.js";\n'),
    ).toEqual([]);

    expect(
      bindingImportViolations(
        "rogue.ts",
        'import { requestStep } from "../../execution/kernel.js";\n',
      ).map((violation) => `src/adapters/git/${violation.file} ${violation.detail}`),
    ).toEqual([
      'src/adapters/git/rogue.ts imports "../../execution/kernel.js" — a relative specifier that resolves outside src/adapters/git is a cross-project import and must name a barrel',
    ]);
    // The sibling prefix is not a pass: the target decides (#188).
    expect(
      bindingImportViolations(
        "rogue.ts",
        'import { requestStep } from "./../execution/kernel.js";\n',
      ).map((violation) => `src/adapters/git/${violation.file} ${violation.detail}`),
    ).toEqual([
      'src/adapters/git/rogue.ts imports "./../execution/kernel.js" — a relative specifier that resolves outside src/adapters/git is a cross-project import and must name a barrel',
    ]);
    expect(
      bindingImportViolations("git-run.ts", 'import { spawnSync } from "node:child_process";\n'),
    ).toEqual([]);
    // Single quotes, and no whitespace before the specifier: both are
    // import spellings the scanner must see.
    expect(
      bindingImportViolations(
        "rogue.ts",
        "import { requestStep } from '@ecoma-io/release-craft/__internal__/execution/kernel.js';\n",
      ).map((violation) => `src/adapters/git/${violation.file} ${violation.detail}`),
    ).toEqual([
      'src/adapters/git/rogue.ts imports "@ecoma-io/release-craft/__internal__/execution/kernel.js"',
    ]);
    expect(
      bindingImportViolations("rogue.ts", 'import x from"@ecoma-io/release-craft";\n').map(
        (violation) => `src/adapters/git/${violation.file} ${violation.detail}`,
      ),
    ).toEqual(['src/adapters/git/rogue.ts imports "@ecoma-io/release-craft"']);
    expect(
      bindingImportViolations(
        "clean.ts",
        [
          'import { spawnSync } from "node:child_process";',
          'import { requestStep } from "@ecoma-io/release-craft/execution";',
          'import { canonicalJson } from "@ecoma-io/release-craft/planner";',
          'import { openGitRun } from "./git-run.js";',
        ].join("\n"),
      ),
    ).toEqual([]);
    // Synthetic offense text, not a real dynamic import: this suite
    // exercises the scanner's module-loading boundary detection, so the
    // banned spelling must appear as data for the gate to bite on.
    expect(
      bindingImportViolations("rogue.ts", 'const m = await import("./sneaky.js");\n').map(
        (violation) => `src/adapters/git/${violation.file} ${violation.detail}`,
      ),
    ).toEqual(["src/adapters/git/rogue.ts performs a dynamic import()"]);
  });
});
