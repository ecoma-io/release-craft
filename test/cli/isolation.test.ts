import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The barrel-seam gate for the CLI layer, executable. Archkeep's tags judge
 * project pairs, never the module a specifier names — "Whether a
 * cross-project import names a barrel or an internal module is the one thing
 * the tags cannot see; that barrel-seam rule stays with the scanner suites"
 * (ADR-0001 §8, as amended by #157) — so the seam is pinned here, the way
 * the planner, execution, app, and adapters-git layers already are.
 *
 * The allowlist is the layer's diet, closed on purpose:
 *
 * - the five layer barrels the `type-cli` row of
 *   module-boundaries.config.mjs permits (app, execution, planner, domain,
 *   adapters/git), each spelled exactly — never the package front door
 *   (`@ecoma-io/release-craft`), whose import from the CLI was the #155
 *   defect and is a boundary violation the arch gate names by file;
 * - the layer's own siblings ("./…");
 * - the one Node built-in the layer reads: "node:fs" in world.ts — the
 *   `--world` document read (phase 12 contract §2.2; §4: the ambient world
 *   enters only as declared configuration).
 *
 * A legal future import is a reviewed widening of this list, never an
 * ambient permission. Dynamic `import(…)` is banned outright, as in every
 * isolation suite: a computed specifier is exactly how an import scan gets
 * bypassed. The subject is the layer, not a module list: the scan walks
 * src/cli, so a new CLI module inherits the gate without this suite naming
 * it. The gate bites: the last test runs the scanner over synthetic text
 * carrying one known offense class each — the isolation suites' own
 * self-test shape.
 */

/** The CLI layer the gate polices, resolved from this suite's location. */
const CLI_DIR = join(import.meta.dirname, "..", "..", "src", "cli");

/** The five parent barrels the `type-cli` row permits, spelled exactly —
 * never the package front door, never a layer's internal module path. */
const ALLOWED_BARRELS: readonly string[] = [
  "@ecoma-io/release-craft/app",
  "@ecoma-io/release-craft/execution",
  "@ecoma-io/release-craft/planner",
  "@ecoma-io/release-craft/domain",
  "@ecoma-io/release-craft/adapters/git",
];

/** The one Node built-in the frozen contract permits, and the only file. */
const ONLY_BUILTIN = "node:fs";
const ONLY_BUILTIN_FILE = "world.ts";

/** One scanned-in offense: which file, and what the scan found there. */
interface Violation {
  readonly file: string;
  readonly detail: string;
}

/** Every CLI source file, sorted, so violations report in stable order. */
function cliFiles(): string[] {
  return readdirSync(CLI_DIR, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

/** Run one projector over every CLI file's text, collecting its violations. */
function scan(project: (file: string, text: string) => Violation[]): Violation[] {
  return cliFiles().flatMap((file) => project(file, readFileSync(join(CLI_DIR, file), "utf8")));
}

/** Violations as reportable strings, prefixed with the layer-relative path. */
function render(violations: readonly Violation[]): string[] {
  return violations.map((violation) => `src/cli/${violation.file} ${violation.detail}`);
}

/**
 * Every import specifier a CLI file names — static `from "…"` clauses and
 * side-effect `import "…"` statements alike. Dynamic `import(…)` is banned
 * outright: a computed specifier is exactly how an import scan gets bypassed.
 */
function importViolations(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  for (const match of text.matchAll(/(?:\bfrom|\bimport)\s+"([^"]+)"/g)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    if (specifier.startsWith("./")) continue;
    if (ALLOWED_BARRELS.includes(specifier)) continue;
    if (specifier === ONLY_BUILTIN && file === ONLY_BUILTIN_FILE) continue;
    violations.push({ file, detail: `imports "${specifier}"` });
  }
  if (/\bimport\s*\(/.test(text)) {
    violations.push({ file, detail: "performs a dynamic import()" });
  }
  return violations;
}

describe("the CLI is a seam-honest consumer layer", () => {
  it("imports only its siblings, the five layer barrels, and world.ts's node:fs", () => {
    expect(cliFiles().length).toBeGreaterThan(0);
    expect(
      render(scan(importViolations)),
      "the CLI composes the layers it renders through their barrels and its own modules — never the package front door (#155), never another layer's internals (ADR-0001 §8)",
    ).toEqual([]);
  });

  it("the gate bites: each offense class is reported, file and specifier", () => {
    // A deep import with a legal tag pair: archkeep's row sees cli → planner
    // and passes it; the seam sees the module and refuses it.
    expect(
      render(
        importViolations(
          "rogue.ts",
          'import { plan } from "@ecoma-io/release-craft/__internal__/planner/plan.js";\n',
        ),
      ),
    ).toEqual(['src/cli/rogue.ts imports "@ecoma-io/release-craft/__internal__/planner/plan.js"']);
    // The #155 class: the package front door, transitively the whole graph.
    expect(
      render(importViolations("rogue.ts", 'import { Version } from "@ecoma-io/release-craft";\n')),
    ).toEqual(['src/cli/rogue.ts imports "@ecoma-io/release-craft"']);
    // A relative edge out of the layer.
    expect(
      render(importViolations("rogue.ts", 'import { engine } from "../app/engine.js";\n')),
    ).toEqual(['src/cli/rogue.ts imports "../app/engine.js"']);
    // The github barrel is not the git barrel — and not the CLI's to import.
    expect(
      render(
        importViolations(
          "rogue.ts",
          'import { openGitHubAdapter } from "@ecoma-io/release-craft/adapters/github";\n',
        ),
      ),
    ).toEqual(['src/cli/rogue.ts imports "@ecoma-io/release-craft/adapters/github"']);
    // The layer's one built-in read, outside its one declared file.
    expect(
      render(importViolations("render.ts", 'import { readFileSync } from "node:fs";\n')),
    ).toEqual(['src/cli/render.ts imports "node:fs"']);
    // A computed specifier is how an import scan gets bypassed.
    expect(
      render(importViolations("rogue.ts", 'const m = await import("./sneaky.js");\n')),
    ).toEqual(["src/cli/rogue.ts performs a dynamic import()"]);
    // The allowed diet reports nothing.
    expect(
      importViolations(
        "world.ts",
        [
          'import { readFileSync } from "node:fs";',
          'import type { PlanningInput } from "@ecoma-io/release-craft/planner";',
          'import { assembleGitBinding } from "@ecoma-io/release-craft/app";',
          'import { openGitBinding } from "@ecoma-io/release-craft/adapters/git";',
          'import { Version } from "@ecoma-io/release-craft/domain";',
          'import type { StepKey } from "@ecoma-io/release-craft/execution";',
          'import { UsageFault } from "./parse.js";',
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
