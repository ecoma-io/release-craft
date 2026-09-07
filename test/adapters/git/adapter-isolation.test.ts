import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fixture 6 — the isolation gate's new layer, executable (contract §4;
 * ADR-0009 decisions 3 and 7). Two structural scans pin the layering:
 *
 * - the engine cannot reach the binding: no file under `src/execution`
 *   names "../adapters/" — that parent edge is not one the engine may
 *   draw, in code or in prose;
 * - the binding consumes, never re-owns: every import under
 *   `src/adapters/git` is a Node built-in, the package barrel
 *   ("../../index.js"), the planner barrel ("../../planner/index.js"),
 *   or a relative sibling ("./…"). Engine internals beyond the barrel,
 *   test tooling, and provider packages are all outside the allowlist.
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

/** The two parent barrels the binding may name, spelled exactly. */
const ENGINE_BARREL = "../../index.js";
const PLANNER_BARREL = "../../planner/index.js";

/** One scanned-in offense: which file, and what the scan found there. */
interface Violation {
  readonly file: string;
  readonly detail: string;
}

/** Every source file of a layer, relative and sorted, for stable reports. */
function layerFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

/** Run one projector over every file of a layer, collecting its violations. */
function scanLayer(dir: string, project: (file: string, text: string) => Violation[]): Violation[] {
  return layerFiles(dir).flatMap((file) => project(file, readFileSync(join(dir, file), "utf8")));
}

/** The engine's one forbidden edge: any reach toward "../adapters/" —
 * in code or in prose; the gate fails closed either way. */
function engineReachViolations(file: string, text: string): Violation[] {
  return text.includes("../adapters/") ? [{ file, detail: 'reaches "../adapters/"' }] : [];
}

/**
 * Every import specifier a binding file names — static `from "…"`
 * clauses and side-effect `import "…"` statements alike. Dynamic
 * `import(…)` is banned outright: a computed specifier is exactly how an
 * import scan gets bypassed. The allowlist is the layer's diet: Node
 * built-ins (the no-runtime-dependency house rule keeps git on node's
 * own child_process), the package barrel's ports, the planner barrel's
 * canonicalJson, and the binding's own siblings.
 */
function bindingImportViolations(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  for (const match of text.matchAll(/(?:\bfrom|\bimport)\s+"([^"]+)"/g)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    const allowed =
      specifier.startsWith("node:") ||
      specifier === ENGINE_BARREL ||
      specifier === PLANNER_BARREL ||
      specifier.startsWith("./");
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
      engineReachViolations("clean.ts", 'import { requestStep } from "./attempt.js";\n'),
    ).toEqual([]);

    expect(
      bindingImportViolations(
        "rogue.ts",
        'import { requestStep } from "../../execution/kernel.js";\n',
      ).map((violation) => `src/adapters/git/${violation.file} ${violation.detail}`),
    ).toEqual(['src/adapters/git/rogue.ts imports "../../execution/kernel.js"']);
    expect(
      bindingImportViolations(
        "clean.ts",
        [
          'import { spawnSync } from "node:child_process";',
          'import { requestStep } from "../../index.js";',
          'import { canonicalJson } from "../../planner/index.js";',
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
