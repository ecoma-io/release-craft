/**
 * Black-box tests for §2.13 tag-history projection and §2.5 range derivation
 * (PR-3), per
 * [phase2-planner-contract.md](../../docs/design/phase2-planner-contract.md),
 * ADR-0003 decision 16, and decision-log D15. Fixtures are self-contained;
 * assertions target observable outcomes — per-line admitted/foreign sets,
 * foreign details, derived ranges — never implementation internals.
 */
import { describe, expect, it } from "vitest";

import { deriveRanges, loadTagHistory } from "../../src/planner/history.js";
import { InvalidPlanningInputError } from "../../src/planner/input.js";
import type {
  ForeignTag,
  LineConfig,
  LineHistory,
  PolicyInput,
  RefObservation,
  TagHistoryResult,
  TagObservation,
} from "../../src/planner/types.js";

const POLICY_DIGEST = "test-history-v1";

function policy(): PolicyInput {
  return {
    digest: POLICY_DIGEST,
    bumpMappingId: "default",
    prereleaseLadder: ["alpha", "beta", "rc"],
    prereleaseSeed: "0",
    pre10Dampening: true,
    selfReferenceNamespace: "Release-Craft:",
    tagFormats: {},
  };
}

function tag(name: string, commit: string): TagObservation {
  return { name, commit };
}

function line(
  id: string,
  feedRef: string,
  band?: { readonly major: number; readonly minor?: number },
): LineConfig {
  return band === undefined
    ? { id, feedRef, lifecycle: "active", declared: true }
    : { id, feedRef, lifecycle: "active", declared: true, versionBand: band };
}

function ref(name: string, head: string): RefObservation {
  return { name, head };
}

function historyById(history: TagHistoryResult, lineId: string): LineHistory {
  const found = history.lines.find((candidate) => candidate.lineId === lineId);
  if (found === undefined) {
    throw new Error(`fixture broken: line ${lineId} missing from history output`);
  }
  return found;
}

function namesOf(entries: readonly { readonly name: string }[]): string[] {
  return entries.map((entry) => entry.name);
}

function foreignNamed(lineHistory: LineHistory, name: string): ForeignTag {
  const found = lineHistory.foreign.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`fixture broken: ${name} missing from ${lineHistory.lineId}'s foreign list`);
  }
  return found;
}

describe("loadTagHistory — §2.13 projection (D15, ADR-0003 decision 16)", () => {
  it("surfaces an unparseable tag as foreign, naming the kernel's parse failure", () => {
    const result = loadTagHistory(
      [tag("1.0.1", "sha-a"), tag("not-a-version", "sha-b"), tag("01.2.3", "sha-c")],
      [line("l1", "feed/1")],
      policy(),
    );

    const l1 = historyById(result, "l1");
    expect(namesOf(l1.tags)).toEqual(["1.0.1"]);
    // Foreign entries keep input tag order — the stable explanation order.
    expect(namesOf(l1.foreign)).toEqual(["not-a-version", "01.2.3"]);
    for (const name of ["not-a-version", "01.2.3"]) {
      // The detail names the failure: the kernel message carries its machine
      // reason and echoes the offending name (leading-zero "01.2.3" included).
      expect(foreignNamed(l1, name).detail).toContain("invalid semantic version");
      expect(foreignNamed(l1, name).detail).toContain(name);
    }
    const admitted = l1.tags[0];
    if (admitted === undefined) {
      throw new Error("fixture broken: expected the in-band tag admitted");
    }
    expect(admitted.version.major).toBe(1);
  });

  it("admits band-equal tags and surfaces out-of-band ones, naming the line and band they failed", () => {
    const lines = [
      line("maint-1", "feed/1", { major: 1 }),
      line("maint-2-9", "feed/2", { major: 2, minor: 9 }),
    ];
    const tags = [
      tag("1.9.0", "sha-a"),
      tag("1.10.0", "sha-b"),
      tag("2.9.0", "sha-c"),
      tag("2.10.0", "sha-d"),
    ];

    const result = loadTagHistory(tags, lines, policy());

    const maint1 = historyById(result, "maint-1");
    // A major-only band fixes the series and leaves the minor free.
    expect(namesOf(maint1.tags)).toEqual(["1.9.0", "1.10.0"]);
    expect(namesOf(maint1.foreign)).toEqual(["2.9.0", "2.10.0"]);
    expect(foreignNamed(maint1, "2.10.0").detail).toContain('line "maint-1"');
    expect(foreignNamed(maint1, "2.10.0").detail).toContain("major 1");

    const maint29 = historyById(result, "maint-2-9");
    // A major+minor band fixes both series: same-major, other-minor is foreign.
    expect(namesOf(maint29.tags)).toEqual(["2.9.0"]);
    expect(namesOf(maint29.foreign)).toEqual(["1.9.0", "1.10.0", "2.10.0"]);
    expect(foreignNamed(maint29, "2.10.0").detail).toContain('line "maint-2-9"');
    expect(foreignNamed(maint29, "2.10.0").detail).toContain("major 2, minor 9");
  });

  it("admits every parsed tag when the line declares no band (single-line repo)", () => {
    const result = loadTagHistory(
      [tag("0.1.0", "sha-a"), tag("2.0.0", "sha-b"), tag("3.1.4-rc.1", "sha-c")],
      [line("main", "feed/0")],
      policy(),
    );

    const main = historyById(result, "main");
    expect(namesOf(main.tags)).toEqual(["0.1.0", "2.0.0", "3.1.4-rc.1"]);
    expect(main.foreign).toEqual([]);
  });

  it("admits a tag on one line while surfacing it as foreign on the other (S-03's 1.9.x vs 2.x)", () => {
    const lines = [line("v1", "feed/1", { major: 1 }), line("v2", "feed/2", { major: 2 })];

    const result = loadTagHistory([tag("1.9.1", "sha-a"), tag("2.0.1", "sha-b")], lines, policy());

    const v1 = historyById(result, "v1");
    const v2 = historyById(result, "v2");
    expect(namesOf(v1.tags)).toEqual(["1.9.1"]);
    expect(namesOf(v1.foreign)).toEqual(["2.0.1"]);
    expect(namesOf(v2.tags)).toEqual(["2.0.1"]);
    expect(namesOf(v2.foreign)).toEqual(["1.9.1"]);
  });

  it("orders a line's history ascending by kernel precedence, breaking precedence ties by tag name", () => {
    const result = loadTagHistory(
      [
        tag("2.0.0", "sha-a"),
        tag("1.10.0", "sha-b"),
        tag("1.9.0", "sha-c"),
        tag("1.2.3+build.2", "sha-d"),
        tag("1.2.3+build.1", "sha-e"),
      ],
      [line("main", "feed/0")],
      policy(),
    );

    const main = historyById(result, "main");
    // Numeric per component: 1.9.0 < 1.10.0 — lexicographic order would
    // invert them. Build metadata ties on precedence, so the two 1.2.3s
    // order by name — and precede 1.9.0 regardless of their names.
    expect(namesOf(main.tags)).toEqual([
      "1.2.3+build.1",
      "1.2.3+build.2",
      "1.9.0",
      "1.10.0",
      "2.0.0",
    ]);
  });
});

describe("deriveRanges — §2.5 derivation", () => {
  it("bounds each line independently: latest tag below, feed-ref head above, null at line birth", () => {
    const lines = [line("maint-1", "feed/1", { major: 1 }), line("fresh", "feed/2", { major: 2 })];
    const history = loadTagHistory(
      [tag("1.0.0", "sha-a"), tag("1.2.0", "sha-b"), tag("1.9.0", "sha-c")],
      lines,
      policy(),
    );

    const ranges = deriveRanges(history, [ref("feed/1", "sha-h1"), ref("feed/2", "sha-h2")], lines);

    // maint-1's bound is its LATEST release (1.9.0, not the first tag);
    // fresh's empty history is the line's birth — null, not invented. The
    // lines are independent (M-07): one says nothing about the other.
    expect(ranges).toEqual([
      { lineId: "maint-1", releasedUpTo: "sha-c", head: "sha-h1" },
      { lineId: "fresh", releasedUpTo: null, head: "sha-h2" },
    ]);
  });

  it("throws for a feedRef with no observed ref, naming lines[i].feedRef", () => {
    const lines = [line("ok", "feed/1", { major: 1 }), line("dangling", "feed/9", { major: 2 })];
    const history = loadTagHistory([tag("1.0.0", "sha-a")], lines, policy());

    let thrown: unknown;
    try {
      deriveRanges(history, [ref("feed/1", "sha-h1")], lines);
    } catch (error) {
      thrown = error;
    }

    if (!(thrown instanceof InvalidPlanningInputError)) {
      throw new Error("expected deriveRanges to throw InvalidPlanningInputError");
    }
    expect(thrown.message).toContain("lines[1].feedRef");
    expect(thrown.violations).toHaveLength(1);
    const violation = thrown.violations[0];
    if (violation === undefined) {
      throw new Error("expected the feedRef violation to be reported");
    }
    expect(violation.field).toBe("lines[1].feedRef");
    expect(violation.problem).toContain("feed/9");
  });

  it("collects every line's violation in one throw, in lines order", () => {
    const lines = [line("dangling", "feed/9", { major: 1 }), line("ghost", "feed/2", { major: 2 })];
    // A history projected over different lines: "ghost" has no entry, so its
    // missing projection is collected alongside the dangling feedRef.
    const history = loadTagHistory([], [line("unrelated", "feed/1", { major: 1 })], policy());

    let thrown: unknown;
    try {
      deriveRanges(history, [ref("feed/2", "sha-h2")], lines);
    } catch (error) {
      thrown = error;
    }

    if (!(thrown instanceof InvalidPlanningInputError)) {
      throw new Error("expected deriveRanges to throw InvalidPlanningInputError");
    }
    expect(thrown.violations.map((violation) => violation.field)).toEqual([
      "lines[0].feedRef",
      "lines[1]",
    ]);
  });

  // Neither signature takes component metadata: the manifest cannot bound a
  // range even in principle (§2.5, invariant 6, S-03) — a tag whose commit
  // matches no manifest version is still history.
  it("keeps a tag whose commit matches no manifest projection as plain history", () => {
    const lines = [line("main", "feed/0")];
    const result = loadTagHistory([tag("1.4.2", "sha-not-in-any-manifest")], lines, policy());

    const main = historyById(result, "main");
    expect(namesOf(main.tags)).toEqual(["1.4.2"]);

    const ranges = deriveRanges(result, [ref("feed/0", "sha-head")], lines);
    expect(ranges).toEqual([
      { lineId: "main", releasedUpTo: "sha-not-in-any-manifest", head: "sha-head" },
    ]);
  });
});
