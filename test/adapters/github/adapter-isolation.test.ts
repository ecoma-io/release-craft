import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The barrel-seam gate for the GitHub adapter layer, executable — the
 * adapters-git suite's twin (issue #188). Archkeep's tags judge project
 * pairs, never the module a specifier names: the
 * `adapters-github → adapters-git` row passes any module of the binding,
 * including an internal one. "Whether a cross-project import names a barrel
 * or an internal module is the one thing the tags cannot see; that
 * barrel-seam rule stays with the scanner suites" (ADR-0001 §8, as amended
 * by #157) — and phase 9's contract states the same law one layer up:
 * "Everything here consumes the git binding's barrel — never its internals,
 * never the engine's internals."
 *
 * The allowlist is the layer's diet, closed on purpose:
 *
 * - the git binding's barrel, spelled exactly
 *   ("@ecoma-io/release-craft/adapters/git") — the one cross-project edge
 *   the layer draws (ADR-0009 decision 7; ADR-0010 decision 1);
 * - the layer's own siblings ("./…");
 * - the one Node built-in the layer spawns: "node:child_process" in
 *   remote-git.ts, the adapter's own git runner.
 *
 * A legal future import is a reviewed widening of this list, never an
 * ambient permission. Dynamic `import(…)` is banned outright, as in every
 * isolation suite: a computed specifier is exactly how an import scan gets
 * bypassed. The subject is the layer, not a module list: the scan walks
 * src/adapters/github, so a new adapter module inherits the gate without
 * this suite naming it. The gate bites: the last test runs the scanner over
 * synthetic text carrying one known offense class each — the issue's probe
 * among them.
 */

/** The layer the gate polices, resolved from this suite's location. */
const ADAPTER_DIR = join(import.meta.dirname, "..", "..", "..", "src", "adapters", "github");

/** The one parent barrel the layer may name, spelled exactly — never the
 * package front door, never the binding's internal modules, never an
 * upward edge into app or cli. */
const GIT_BARREL = "@ecoma-io/release-craft/adapters/git";

/** The one Node built-in the frozen contract permits, and the only file. */
const ONLY_BUILTIN = "node:child_process";
const ONLY_BUILTIN_FILE = "remote-git.ts";

/** One scanned-in offense: which file, and what the scan found there. */
interface Violation {
  readonly file: string;
  readonly detail: string;
}

/** Every adapter source file, sorted, so violations report in stable order. */
function adapterFiles(): string[] {
  return readdirSync(ADAPTER_DIR, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

/** Run one projector over every adapter file's text, collecting its violations. */
function scan(project: (file: string, text: string) => Violation[]): Violation[] {
  return adapterFiles().flatMap((file) =>
    project(file, readFileSync(join(ADAPTER_DIR, file), "utf8")),
  );
}

/** Violations as reportable strings, prefixed with the layer-relative path. */
function render(violations: readonly Violation[]): string[] {
  return violations.map((violation) => `src/adapters/github/${violation.file} ${violation.detail}`);
}

/**
 * Every import specifier an adapter file names — static `from "…"` clauses
 * and side-effect `import "…"` statements alike. Dynamic `import(…)` is
 * banned outright: a computed specifier is exactly how an import scan gets
 * bypassed.
 */
function importViolations(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  for (const match of text.matchAll(/(?:\bfrom|\bimport)\s+"([^"]+)"/g)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    if (specifier.startsWith("./")) continue;
    if (specifier === GIT_BARREL) continue;
    if (specifier === ONLY_BUILTIN && file === ONLY_BUILTIN_FILE) continue;
    violations.push({ file, detail: `imports "${specifier}"` });
  }
  if (/\bimport\s*\(/.test(text)) {
    violations.push({ file, detail: "performs a dynamic import()" });
  }
  return violations;
}

describe("the GitHub adapter consumes the binding through the barrel seam", () => {
  it("imports only its siblings, the git binding's barrel, and remote-git.ts's node:child_process", () => {
    expect(adapterFiles().length).toBeGreaterThan(0);
    expect(
      render(scan(importViolations)),
      "the adapter consumes the binding's barrel and its own modules — never the binding's internals, never the engine's internals (phase 9 contract, scope; ADR-0009 decision 7)",
    ).toEqual([]);
  });

  it("the gate bites: each offense class is reported, file and specifier", () => {
    // The issue's probe: a legal tag pair over a deep import — archkeep's
    // row sees adapters-github → adapters-git and passes it; the seam sees
    // the module and refuses it.
    expect(
      render(
        importViolations(
          "rogue.ts",
          'import { openGitRun } from "@ecoma-io/release-craft/__internal__/adapters/git/git-run.js";\n',
        ),
      ),
    ).toEqual([
      'src/adapters/github/rogue.ts imports "@ecoma-io/release-craft/__internal__/adapters/git/git-run.js"',
    ]);
    // The binding's module behind the barrel's own spelling is not the barrel.
    expect(
      render(
        importViolations(
          "rogue.ts",
          'import { openGitRun } from "@ecoma-io/release-craft/adapters/git/git-run.js";\n',
        ),
      ),
    ).toEqual([
      'src/adapters/github/rogue.ts imports "@ecoma-io/release-craft/adapters/git/git-run.js"',
    ]);
    // The package front door.
    expect(
      render(importViolations("rogue.ts", 'import { Version } from "@ecoma-io/release-craft";\n')),
    ).toEqual(['src/adapters/github/rogue.ts imports "@ecoma-io/release-craft"']);
    // An upward edge: the adapter composes inward, never toward the surface.
    expect(
      render(
        importViolations(
          "rogue.ts",
          'import { assembleMemoryStores } from "@ecoma-io/release-craft/app";\n',
        ),
      ),
    ).toEqual(['src/adapters/github/rogue.ts imports "@ecoma-io/release-craft/app"']);
    // A relative edge out of the layer.
    expect(
      render(
        importViolations("rogue.ts", 'import { requestStep } from "../../execution/kernel.js";\n'),
      ),
    ).toEqual(['src/adapters/github/rogue.ts imports "../../execution/kernel.js"']);
    // The one built-in spawn, outside its one declared file.
    expect(
      render(importViolations("sync.ts", 'import { spawnSync } from "node:child_process";\n')),
    ).toEqual(['src/adapters/github/sync.ts imports "node:child_process"']);
    // A computed specifier is how an import scan gets bypassed.
    expect(
      render(importViolations("rogue.ts", 'const m = await import("./sneaky.js");\n')),
    ).toEqual(["src/adapters/github/rogue.ts performs a dynamic import()"]);
    // The allowed diet reports nothing — the binding's barrel, a sibling,
    // and the built-in spawn in its one declared file.
    expect(
      importViolations(
        "adapter.ts",
        [
          'import type { GitBinding } from "@ecoma-io/release-craft/adapters/git";',
          'import { GitRemoteSync } from "./sync.js";',
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(
      importViolations("remote-git.ts", 'import { spawnSync } from "node:child_process";\n'),
    ).toEqual([]);
  });
});
