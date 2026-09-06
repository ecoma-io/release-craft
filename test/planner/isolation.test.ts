import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import * as surface from "../../src/index.js";
import { plan } from "../../src/index.js";
import type {
  CommitObservation,
  ComponentMeta,
  LineConfig,
  PlanningInput,
  PolicyInput,
  RefObservation,
  TagObservation,
} from "../../src/index.js";

/**
 * The planner-isolation gate, executable — contract §4 finding A3 made
 * runnable, as the Phase 2 adversarial review demanded (§6 A3: "a suite
 * proving no infrastructure import or side effect, modeled on Phase 1's
 * provider-isolation test"). The gate has two halves:
 *
 *   - Static: every file under the planner layer is scanned for what it
 *     imports and what globals it names. The layer may import its own
 *     modules, the kernel barrel ("@ecoma-io/release-craft/domain"), and
 *     exactly one Node built-in: "node:crypto" in identity.ts, the §2.11
 *     fingerprints' SHA-256. Hashing is pure computation — identical bytes
 *     hash to identical digests — so the frozen exception strengthens
 *     determinism instead of threatening it. No fs, no path, no process,
 *     no clock, no randomness, no dynamic import. The subject is the
 *     layer, not a module list: the scan walks src/planner by glob, so a
 *     new planner file inherits the gate without this suite naming it.
 *
 *   - Behavioral: the static half names the mechanisms; §2.14's double-run
 *     contract proves the behavior. `plan` over a rich fixture twice must
 *     produce deep-equal outcomes — a hidden clock read or randomness
 *     eventually diverges, and the equality here is what catches it.
 *
 * The behavioral fixture is the S-03 world (docs/design/release-scenarios.md,
 * manifest drift): two refs, a six-tag hotfix line, a pending fix on main,
 * a stale manifest riding as declared projection, one release intent —
 * the richest scenario the planner's own golden suite pins.
 */

/** The planner layer the gate polices, resolved from this suite's location. */
const PLANNER_DIR = join(import.meta.dirname, "..", "..", "src", "planner");

/** The one Node built-in the frozen contract permits, and the only file. */
const ONLY_BUILTIN = "node:crypto";
const ONLY_BUILTIN_FILE = "identity.ts";

/** The kernel edge, spelled exactly as the contract allows — the barrel,
 * never a kernel-internal path. */
const KERNEL_BARREL = "@ecoma-io/release-craft/domain";

/** One scanned-in offense: which file, and what the scan found there. */
interface Violation {
  readonly file: string;
  readonly detail: string;
}

/** Every planner source file, sorted, so violations report in stable order. */
function plannerFiles(): string[] {
  return readdirSync(PLANNER_DIR, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

/** Run one projector over every planner file's text, collecting its violations. */
function scan(project: (file: string, text: string) => Violation[]): Violation[] {
  return plannerFiles().flatMap((file) =>
    project(file, readFileSync(join(PLANNER_DIR, file), "utf8")),
  );
}

/** Violations as reportable strings, prefixed with the layer-relative path. */
function render(violations: readonly Violation[]): string[] {
  return violations.map((violation) => `src/planner/${violation.file} ${violation.detail}`);
}

/**
 * Every import specifier a planner file names — static `from "…"` clauses
 * and side-effect `import "…"` statements alike. Dynamic `import(…)` is
 * not a specifier form to allow-list: it is banned outright, because a
 * computed specifier is exactly how an import scan gets bypassed.
 */
function importViolations(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  for (const match of text.matchAll(/(?:\bfrom|\bimport)\s+"([^"]+)"/g)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    const withinLayer = specifier.startsWith("./") || specifier.startsWith("../");
    if (withinLayer) continue;
    if (specifier === KERNEL_BARREL) continue;
    if (specifier === ONLY_BUILTIN && file === ONLY_BUILTIN_FILE) continue;
    violations.push({ file, detail: `imports "${specifier}"` });
  }
  if (/\bimport\s*\(/.test(text)) {
    violations.push({ file, detail: "performs a dynamic import()" });
  }
  return violations;
}

/**
 * The global surface a deterministic layer may never name (invariant 2):
 * the clock in both spellings, randomness, the process object — where
 * environment reads live — and globalThis, the escape hatch that would
 * smuggle any of them back in. The gate fails closed: a hit means the
 * layer names the API, in code or in prose, and both are refused.
 */
const FORBIDDEN_GLOBALS: readonly {
  readonly token: string;
  readonly pattern: RegExp;
  readonly why: string;
}[] = [
  { token: "Date.now", pattern: /\bDate\.now\s*\(/, why: "clock read" },
  { token: "new Date", pattern: /\bnew\s+Date\s*\(/, why: "clock read via construction" },
  { token: "Math.random", pattern: /\bMath\.random\s*\(/, why: "randomness" },
  { token: "process", pattern: /\bprocess\s*[.[]/, why: "process or environment access" },
  { token: "globalThis", pattern: /\bglobalThis\b/, why: "global escape hatch" },
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

// ---------------------------------------------------------------------------
// The S-03 world — fixture builders lifted from the planner's golden
// scenario suite (test/planner/scenario.golden.test.ts), unchanged.
// ---------------------------------------------------------------------------

const COMMITTED_AT = "2026-01-01T00:00:00Z";

/** One fixed digest, S-03's — opaque content identity (invariant 4). */
const DIGEST = "sha256:" + "c".repeat(64);

function policy(): PolicyInput {
  return {
    digest: DIGEST,
    bumpMappingId: "default",
    prereleaseLadder: ["alpha", "beta", "rc"],
    prereleaseSeed: "0",
    pre10Dampening: true,
    selfReferenceNamespace: "Release-Craft:",
    tagFormats: {},
  };
}

function commit(
  sha: string,
  message: string,
  opts: { readonly parents?: readonly string[]; readonly containingRefs?: readonly string[] } = {},
): CommitObservation {
  return {
    sha,
    parents: opts.parents ?? [],
    message,
    committedAt: COMMITTED_AT,
    containingRefs: opts.containingRefs ?? [],
  };
}

function ref(name: string, head: string): RefObservation {
  return { name, head };
}

function tag(name: string, sha: string): TagObservation {
  return { name, commit: sha };
}

function line(): LineConfig {
  return {
    id: "1.x",
    feedRef: "main",
    lifecycle: "active",
    declared: true,
    versionBand: { major: 1 },
  };
}

function component(): ComponentMeta {
  return { name: "release-craft", manifestVersion: "1.9.0", paths: ["package.json"] };
}

/** The closed §2.1 input of the S-03 scenario, at its stated initial state. */
function scenarioInput(): PlanningInput {
  return {
    policy: policy(),
    repository: {
      commits: [
        commit("s03-root", "feat: the 1.9 line", { containingRefs: ["main", "release/1.9"] }),
        commit("s03-1.9.0", "chore: cut 1.9.0", {
          parents: ["s03-root"],
          containingRefs: ["main"],
        }),
        commit("s03-fix-main", "fix: guard empty config", {
          parents: ["s03-1.9.0"],
          containingRefs: ["main"],
        }),
        commit("s03-hf1", "fix: hotfix one", {
          parents: ["s03-1.9.0"],
          containingRefs: ["release/1.9"],
        }),
        commit("s03-hf2", "fix: hotfix two", {
          parents: ["s03-hf1"],
          containingRefs: ["release/1.9"],
        }),
        commit("s03-hf3", "fix: hotfix three", {
          parents: ["s03-hf2"],
          containingRefs: ["release/1.9"],
        }),
        commit("s03-hf4", "fix: hotfix four", {
          parents: ["s03-hf3"],
          containingRefs: ["release/1.9"],
        }),
        commit("s03-hf5", "fix: hotfix five", {
          parents: ["s03-hf4"],
          containingRefs: ["release/1.9"],
        }),
      ],
      refs: [ref("main", "s03-fix-main"), ref("release/1.9", "s03-hf5")],
    },
    history: {
      tags: [
        tag("1.9.0", "s03-1.9.0"),
        tag("1.9.1", "s03-hf1"),
        tag("1.9.2", "s03-hf2"),
        tag("1.9.3", "s03-hf3"),
        tag("1.9.4", "s03-hf4"),
        tag("1.9.5", "s03-hf5"),
      ],
    },
    lines: [line()],
    // The stale manifest rides as declared projection (invariant 6) — the
    // plan must ignore it, never consume it as truth.
    components: [component()],
    intents: [{ kind: "release" }],
  };
}

describe("contract §4 A3 — the planner is an isolated layer", () => {
  it("imports only planner siblings, the kernel barrel, and identity.ts's node:crypto", () => {
    expect(plannerFiles().length).toBeGreaterThan(0);
    const violations = render(scan(importViolations));
    expect(
      violations,
      'the planner imports nothing outside src/planner and the kernel barrel "@ecoma-io/release-craft/domain" — the single permitted Node built-in is "node:crypto" in identity.ts (§2.11: hashing is pure computation)',
    ).toEqual([]);
  });

  it("names no clock, no randomness, no process, no environment (invariant 2, statically)", () => {
    expect(plannerFiles().length).toBeGreaterThan(0);
    const violations = render(scan(sideEffectViolations));
    expect(
      violations,
      "the planner layer names no Date.now, no new Date, no Math.random, no process and no globalThis — identical inputs must decide identically (invariant 2, §2.14)",
    ).toEqual([]);
  });

  it("double-runs plan over the S-03 world to deep-equal outcomes (§2.14)", () => {
    const first = plan(scenarioInput());
    const second = plan(scenarioInput());
    expect(first.kind).toBe("planned");
    expect(second).toEqual(first);
  });

  it("mounts the planner door and the kernel beside it on the package barrel", () => {
    expect(typeof surface.plan).toBe("function");
    expect(surface.Version).toBeDefined();
  });
});
