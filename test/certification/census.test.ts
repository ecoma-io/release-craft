/**
 * The manifest's own laws (phase 14 contract §5 and §9), asserted against
 * the recorded data of `matrix.ts` and `manifest.ts`. This suite is the
 * fixture's bookkeeping made executable: the census, the completeness
 * checks, the probes. The cells themselves live in the assembly suites;
 * nothing here drives an engine.
 *
 * The census compares the manifest's window claims against the RECORDED
 * taxonomy of `matrix.ts` — never against a copy the manifest holds of
 * itself — so a window dropped from the record is uncovered, and a window
 * claimed but never recorded is refused on sight (R0).
 */

import { describe, expect, it } from "vitest";

import { hermeticGitEnv } from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import { runBinEnv } from "./drive.js";
import { TAXONOMY, WALKS } from "./matrix.js";
import {
  census,
  censusPairs,
  expectedFileDefects,
  expectedFiles,
  fixtureModules,
  importViolations,
  isolationViolations,
  MANIFEST,
  manifestDefects,
  refusalInventoryViolations,
  suiteSources,
  unproducedRows,
} from "./manifest.js";

describe("the manifest's executable census · the recorded taxonomy", () => {
  it("holds exactly the contract's thirteen windows, each cited", () => {
    expect(TAXONOMY.map((window) => window.id)).toStrictEqual([
      "I1",
      "I2",
      "I3",
      "I4",
      "I5",
      "I6",
      "I7",
      "I8",
      "I9",
      "I10",
      "I11",
      "I12",
      "I3ext",
    ]);
    for (const window of TAXONOMY) {
      expect(window.name.length, `${window.id} names its window`).toBeGreaterThan(0);
      expect(window.recordedBy.length, `${window.id} cites its recording contract`).toBeGreaterThan(
        0,
      );
    }
  });

  it("holds exactly the contract's five walks", () => {
    expect(WALKS.map((walk) => walk.id)).toStrictEqual(["W1", "W2", "W3", "W4", "W5"]);
    for (const walk of WALKS) {
      expect(walk.run.length).toBeGreaterThan(0);
      expect(walk.ancestry.length).toBeGreaterThan(0);
    }
  });
});

describe("the manifest's executable census · earned ∪ refused == taxonomy", () => {
  it("every recorded window is claimed by at least one (window, carrier-scope) pair", () => {
    const verdict = census();
    expect(verdict.uncovered).toStrictEqual([]);
  });

  it("the pairs carry claims from real rows, and I3ext is two pairs — earned on the boundary, refused on the process transports", () => {
    const { earned, refused } = censusPairs();
    const i3ext = [
      ...earned.filter((pair) => pair.window === "I3ext"),
      ...refused.filter((pair) => pair.window === "I3ext"),
    ];
    expect(i3ext).toStrictEqual([
      { window: "I3ext", scope: "boundary", row: "memory-06" },
      { window: "I3ext", scope: "CLI", row: "refused-01" },
      { window: "I3ext", scope: "Action", row: "refused-01" },
    ]);
  });
});

describe("the manifest's executable census · earned ∩ refused == ∅", () => {
  it("no (window, carrier-scope) pair is both earned and refused", () => {
    const verdict = census();
    expect(verdict.conflicts).toStrictEqual([]);
  });

  it("I4 is earned on the git boundary and refused on A-memory — disjoint scopes", () => {
    const { earned, refused } = censusPairs();
    expect(earned.filter((pair) => pair.window === "I4")).toStrictEqual([
      { window: "I4", scope: "boundary", row: "git-09" },
    ]);
    expect(refused.filter((pair) => pair.window === "I4")).toStrictEqual([
      { window: "I4", scope: "A-memory", row: "refused-02" },
    ]);
  });
});

describe("the manifest's completeness · one row per cell, statuses as recorded", () => {
  it("holds thirty-six earned rows and eleven refusals, in the recorded statuses", () => {
    expect(MANIFEST.length).toBe(47);
    const byStatus = (status: string): number =>
      MANIFEST.filter((row) => row.status === status).length;
    expect(byStatus("live")).toBe(35);
    expect(byStatus("typed-row")).toBe(0);
    expect(byStatus("census-only")).toBe(1);
    expect(byStatus("refused")).toBe(11);
    expect(MANIFEST.filter((row) => row.status !== "refused").length).toBe(36);
  });

  it("every cell id is unique and in the fixture's own shape", () => {
    expect(manifestDefects()).toStrictEqual([]);
  });

  it("the census-only row (git-13) names its enforcement, and every refused row names its rule", () => {
    const git13 = MANIFEST.find((row) => row.id === "git-13");
    expect(git13?.status).toBe("census-only");
    expect(git13?.enforcement).toContain("exit-codes.test.ts");
    expect(git13?.enforcement).toContain("exit-table.ts");
    const refused = MANIFEST.filter((row) => row.status === "refused");
    expect(refused.length).toBe(11);
    for (const row of refused) {
      expect(row.refusal?.rule.length, `${row.id} names its rule`).toBeGreaterThan(0);
      expect(
        row.refusal?.note.length,
        `${row.id} states the refusing rule's ground`,
      ).toBeGreaterThan(0);
    }
  });

  it("no typed rows remain — the Action rows' declared mover (phase 13's composite and invocation script) has landed, so every declared cell is produced", () => {
    const typed = MANIFEST.filter((row) => row.status === "typed-row");
    expect(typed).toStrictEqual([]);
    // The change protocol's own posture, pinned now that it holds: a row
    // typed as pending a mover must name its mover — and the six Action
    // rows named this slice's prerequisite, which main carries since the
    // Action implementation merged. The rows are live, driving the real
    // invocation script.
    for (const row of MANIFEST.filter((candidate) => candidate.status === "live")) {
      expect(row.reachability, `${row.id} carries no pending declaration`).toBeUndefined();
    }
  });
});

describe("the manifest's completeness · expected/ orphans, either direction", () => {
  it("no file without a row, no row naming an absent file", () => {
    expect(expectedFileDefects(expectedFiles())).toStrictEqual([]);
  });
});

describe("the manifest's executable laws · the probes over the fixture's own modules", () => {
  it("no environment, clock, or randomness read under the fixture's modules", () => {
    expect(isolationViolations()).toStrictEqual([]);
  });

  it("no non-barrel src/ import, and the CLI never enters as an import", () => {
    expect(importViolations()).toStrictEqual([]);
  });

  it("no fixture module names a refused input", () => {
    expect(refusalInventoryViolations()).toStrictEqual([]);
  });

  it("the process transport's constructed environment is exactly the invocation script's two-name allowlist", () => {
    // The construction (`runBinEnv`, phase 13 §4's outer line mirrored) is
    // pinned as an exact key set, not a strip list: nothing ambient can
    // ride along at all, so an ambient `NODE_OPTIONS`, agent marker, locale
    // variable, or `GIT_*` value is absent by construction — on every
    // machine, vacuously where this worker's ambient carries none.
    const env = runBinEnv("/scratch/release-craft-home-pinned");
    expect(Object.keys(env).sort()).toStrictEqual(["HOME", "PATH"]);
    expect(env.HOME).toBe("/scratch/release-craft-home-pinned");
    // The one ambient value carried rides the binding's own floor — the
    // fixture reads no environment of its own (the probe above), and the
    // floor's PATH is the ambient PATH untouched (its filter strips only
    // the leaked git context and GIT_TRACE*).
    expect(env.PATH).toBe(hermeticGitEnv().PATH ?? "");
  });

  it("the subprocess consults the constructed environment — the source spelling is coupled to the law", () => {
    // The structural pin above judges the construction; this one judges
    // that `runBin` still consults it. The probes are textual by design
    // (the negative inventory's own style, the CLI hermeticity scan's
    // self-bite posture): the mutant this bites is the inheritance revert —
    // deleting the `env` key returns the subprocess to the worker's whole
    // ambient and removes exactly this spelling. The behavioral plant that
    // also catches that mutant lives outside the fixture
    // (`test/certification-env.test.ts`): the isolation probe's
    // no-ambient-read law cannot apply to the guard that plants one.
    expect(fixtureModules()["drive.ts"]).toContain("env: runBinEnv(home)");
  });

  it("every live or typed row id is produced by a test title in its suite (§5's produced-by law)", () => {
    expect(unproducedRows(suiteSources())).toStrictEqual([]);
  });
});
