/**
 * Golden attribution fixtures — the M/PL scenarios the contract assigns to
 * the PR-2 workstreams (inputs+extraction, attribution), with expectations
 * quoted from the scenario matrix via the contract's scenario inventory
 * (phase2-planner-contract.md §5).
 *
 * Scope discipline: PR-2 owns extraction and attribution only. Version
 * computation (`1.9.1`, `2.4.0`, …) belongs to the bump/version-planning
 * workstreams (PR-3/PR-4); the no-op/withheld records belong to PR-3. These
 * fixtures therefore assert identities, lineage, per-line pending sets,
 * releasedness, exclusions, and refusals — not versions.
 *
 * The suites unskip at the integration commit, when the implementation
 * modules land; they gate the merge. Range bounds are declared fixture data
 * (the scenario inputs name the tags): deriving them from
 * `TagObservation[]` is the history loader's contract (PR-3).
 */

import { describe, expect, it } from "vitest";

import type {
  AttributionOutcome,
  CommitObservation,
  ExtractionResult,
  LineRange,
  PlanningInput,
  PolicyInput,
} from "@ecoma-io/release-craft/__internal__/planner/types.js";
import { attribute } from "@ecoma-io/release-craft/__internal__/planner/attribute.js";
import { extract } from "@ecoma-io/release-craft/__internal__/planner/extract.js";
import { planChanges } from "@ecoma-io/release-craft/__internal__/planner/harness.js";

// ---------------------------------------------------------------------------
// Fixture builders — deterministic, closed inputs per §2.1
// ---------------------------------------------------------------------------

const policy: PolicyInput = {
  digest: "test-policy-v1",
  bumpMappingId: "default",
  prereleaseLadder: ["alpha", "beta", "rc"],
  prereleaseSeed: "0",
  pre10Dampening: true,
  selfReferenceNamespace: "Release-Craft:",
  tagFormats: {},
};

function commit(
  sha: string,
  parents: string[],
  message: string,
  containingRefs: string[] = [],
): CommitObservation {
  return { sha, parents, message, committedAt: "2026-01-01T00:00:00Z", containingRefs };
}

function input(commits: CommitObservation[]): PlanningInput {
  return {
    policy,
    repository: {
      commits,
      refs: [
        { name: "main", head: commits[0]?.sha ?? "" },
        { name: "1.9", head: commits[0]?.sha ?? "" },
        { name: "2.2", head: commits[0]?.sha ?? "" },
      ],
    },
    history: { tags: [] },
    lines: [
      { id: "main", feedRef: "main", lifecycle: "active", declared: true },
      { id: "1.9", feedRef: "1.9", lifecycle: "active", declared: true },
      { id: "2.2", feedRef: "2.2", lifecycle: "active", declared: true },
    ],
  };
}

function range(lineId: string, releasedUpTo: string | null, head: string): LineRange {
  return { lineId, releasedUpTo, head };
}

/** Narrows the attribution outcome so line data is read typed, not cast. */
function attributedLines(
  outcome: AttributionOutcome,
): Extract<AttributionOutcome, { kind: "attributed" }>["lines"] {
  if (outcome.kind !== "attributed") throw new Error("expected attributed outcome");
  return outcome.lines;
}

function pendingIds(outcome: AttributionOutcome, lineId: string): string[] {
  const line = attributedLines(outcome).find((l) => l.lineId === lineId);
  if (!line) throw new Error(`no attribution for line ${lineId}`);
  return line.pending.map((c) => c.change?.id ?? c.sha);
}

function extracted(input_: PlanningInput): ExtractionResult {
  return extract(input_.repository.commits, input_.policy);
}

// ---------------------------------------------------------------------------
// M-01 — a fix on the maintenance line is not a main commit
// ---------------------------------------------------------------------------

describe("M-01: ancestry attribution", () => {
  const commits = [
    commit("c3", ["c2"], "chore: keep main moving", ["main"]),
    commit("c9", ["c8"], "chore: cut 1.9.0", ["1.9"]),
    commit("f", ["c9"], "fix(parser): handle empty input", ["1.9"]),
  ];
  const ranges = [range("main", "c3", "c3"), range("1.9", "c9", "f")];

  it("attributes F to line 1.9 by ancestry and leaves main empty", () => {
    const inp = input(commits);
    const outcome = attribute(extracted(inp), inp, ranges);
    expect(outcome.kind).toBe("attributed");
    expect(pendingIds(outcome, "1.9")).toEqual(["f"]);
    expect(pendingIds(outcome, "main")).toEqual([]);
  });

  it("fails closed when the same commit sits in two lines' pending spans", () => {
    const inp = input(commits);
    const outcome = attribute(extracted(inp), inp, [
      range("main", "c3", "f"),
      range("1.9", "c9", "f"),
    ]);
    expect(outcome.kind).toBe("refused");
    expect(outcome).toMatchObject({
      refusal: { cause: "ambiguous-attribution", commits: ["f"] },
    });
  });
});

// ---------------------------------------------------------------------------
// M-03 — one logical fix on three lines: cherry-picks share one identity
// ---------------------------------------------------------------------------

describe("M-03: cherry-pick identity", () => {
  const c3 = commit("c3", ["c2"], "chore: keep main moving", ["main"]);
  const d3 = commit("d3", ["d2"], "chore: cut 2.2.3", ["2.2"]);
  const c9 = commit("c9", ["c8"], "chore: cut 1.9.0", ["1.9"]);
  const f = commit("f", ["c3"], "fix(parser): handle empty input", ["main"]);
  const fPrime = commit(
    "f2",
    ["d3"],
    "fix(parser): handle empty input\n\n(cherry picked from commit f)",
    ["2.2"],
  );
  const fDouble = commit(
    "f3",
    ["c9"],
    "fix(parser): handle empty input\n\n(cherry picked from commit f)",
    ["1.9"],
  );
  const inp = input([c3, d3, c9, f, fPrime, fDouble]);

  it("resolves all three commits to one change identity", () => {
    const result = extracted(inp);
    const family = result.commits.filter((c) => ["f", "f2", "f3"].includes(c.sha));
    const ids = new Set(family.filter((c) => c.change).map((c) => c.change?.id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe("f");
    expect(result.commits.find((c) => c.sha === "f2")?.identitySource).toBe("cherry-pick-origin");
  });

  it("keeps each line's own commit pending on that line", () => {
    const outcome = attribute(extracted(inp), inp, [
      range("main", "c3", "f"),
      range("2.2", "d3", "f2"),
      range("1.9", "c9", "f3"),
    ]);
    expect(outcome.kind).toBe("attributed");
    expect(pendingIds(outcome, "main")).toEqual(["f"]);
    expect(pendingIds(outcome, "2.2")).toEqual(["f"]);
    expect(pendingIds(outcome, "1.9")).toEqual(["f"]);
  });
});

// ---------------------------------------------------------------------------
// M-04 — clean backport: main must not move; releasedness per (line, change)
// ---------------------------------------------------------------------------

describe("M-04: clean backport", () => {
  const commits = [
    commit("c3", ["c2"], "feat: the 2.3.0 feature", ["main"]),
    commit("f", ["c3"], "fix(parser): handle empty input", ["main"]),
    commit("c9", ["c8"], "chore: cut 1.9.0", ["1.9"]),
    commit("f2", ["c9"], "fix(parser): handle empty input\n\n(cherry picked from commit f)", [
      "1.9",
    ]),
  ];
  const inp = input(commits);

  it("keeps F pending on main while F' is pending on 1.9", () => {
    const outcome = attribute(extracted(inp), inp, [
      range("main", "c3", "f"),
      range("1.9", "c9", "f2"),
    ]);
    expect(outcome.kind).toBe("attributed");
    expect(pendingIds(outcome, "main")).toEqual(["f"]);
    expect(pendingIds(outcome, "1.9")).toEqual(["f"]);
    const lines = attributedLines(outcome);
    expect(lines.find((l) => l.lineId === "main")?.released).not.toContain("f");
    expect(lines.find((l) => l.lineId === "1.9")?.released).not.toContain("f");
  });
});

// ---------------------------------------------------------------------------
// M-06 — backport of an already-released change: suppression is per line
// ---------------------------------------------------------------------------

describe("M-06: releasedness does not cross lines", () => {
  const commits = [
    commit("c3", ["c2"], "chore: keep main moving", ["main"]),
    commit("f", ["c3"], "fix(parser): handle empty input", ["main"]),
    commit("c9", ["c8"], "chore: cut 1.9.0", ["1.9"]),
    commit("f2", ["c9"], "fix(parser): handle empty input\n\n(cherry picked from commit f)", [
      "1.9",
    ]),
  ];
  const inp = input(commits);

  it("treats F as released on main only; F' stays pending on 1.9", () => {
    const outcome = attribute(extracted(inp), inp, [
      range("main", "f", "f"),
      range("1.9", "c9", "f2"),
    ]);
    expect(outcome.kind).toBe("attributed");
    const lines = attributedLines(outcome);
    expect(lines.find((l) => l.lineId === "main")?.released).toContain("f");
    expect(lines.find((l) => l.lineId === "1.9")?.released).not.toContain("f");
    expect(pendingIds(outcome, "1.9")).toEqual(["f"]);
    expect(pendingIds(outcome, "main")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M-07 — divergent maintenance line: the line's own range, never main's
// ---------------------------------------------------------------------------

describe("M-07: per-line range", () => {
  const commits = [
    commit("c9", ["c8"], "chore: cut 1.9.0", ["1.9"]),
    commit("d", ["c9"], "feat: main-never-had capability", ["1.9"]),
    commit("f1", ["d"], "fix: follow-up on the capability", ["1.9"]),
  ];
  const inp = input(commits);

  it("discovers D and F1 from 1.9's own range", () => {
    const outcome = attribute(extracted(inp), inp, [range("1.9", "c9", "f1")]);
    expect(outcome.kind).toBe("attributed");
    expect(pendingIds(outcome, "1.9")).toEqual(["d", "f1"]);
  });
});

// ---------------------------------------------------------------------------
// M-09 — fix released on maintenance before main receives it
// ---------------------------------------------------------------------------

describe("M-09: lineage is traceability, not suppression", () => {
  const commits = [
    commit("c9", ["c8"], "chore: cut 1.9.0", ["1.9"]),
    commit("f", ["c9"], "fix: the shared fix", ["1.9"]),
    commit("m3", ["m2"], "chore: cut 2.3.0", ["main"]),
    commit("f3", ["m3"], "fix: the shared fix\n\n(cherry picked from commit f)", ["main"]),
  ];
  const inp = input(commits);

  it("keeps F'' pending on main even though F shipped on 1.9", () => {
    const outcome = attribute(extracted(inp), inp, [
      range("1.9", "f", "f"),
      range("main", "m3", "f3"),
    ]);
    expect(outcome.kind).toBe("attributed");
    const lines = attributedLines(outcome);
    expect(lines.find((l) => l.lineId === "1.9")?.released).toContain("f");
    expect(lines.find((l) => l.lineId === "main")?.released).not.toContain("f");
    expect(pendingIds(outcome, "main")).toEqual(["f"]);
  });
});

// ---------------------------------------------------------------------------
// PL-04 — the release PR's own output is not a change (self-reference)
// ---------------------------------------------------------------------------

describe("PL-04: self-reference exclusion", () => {
  const commits = [
    commit("c3", ["c2"], "chore: keep main moving", ["main"]),
    commit("r", ["c3"], "chore: release main\n\nRelease-Craft: plan 01d4479c", ["main"]),
  ];
  const inp = input(commits);

  it("excludes the bookkeeping commit before classification and surfaces it", () => {
    const result = extracted(inp);
    expect(result.commits.find((c) => c.sha === "r")?.classification).toBe("self-reference");
    expect(result.excluded.map((e) => e.sha)).toContain("r");
    const outcome = attribute(result, inp, [range("main", "c3", "r")]);
    expect(outcome.kind).toBe("attributed");
    expect(pendingIds(outcome, "main")).toEqual([]);
    const lines = attributedLines(outcome);
    expect(lines.find((l) => l.lineId === "main")?.excluded.map((e) => e.sha)).toContain("r");
  });
});

// ---------------------------------------------------------------------------
// §2.12 — a malformed self-reference marker fails toward explicit review
// ---------------------------------------------------------------------------

describe("§2.12: malformed self-reference marker", () => {
  const commits = [
    commit("c3", ["c2"], "chore: keep main moving", ["main"]),
    commit("rm", ["c3"], "chore: odd bookkeeping\n\nRelease-Craft:", ["main"]),
  ];
  const inp = input(commits);

  it("refuses with the malformed commit named, never silently excluded", () => {
    const result = extracted(inp);
    expect(result.commits.find((c) => c.sha === "rm")?.classification).toBe("malformed-marker");
    const outcome = attribute(result, inp, [range("main", "c3", "rm")]);
    expect(outcome.kind).toBe("refused");
    expect(outcome).toMatchObject({
      refusal: { cause: "malformed-self-reference-marker", commits: ["rm"] },
    });
  });
});

// ---------------------------------------------------------------------------
// Determinism — identical inputs, identical results, stable order (§2.3)
// ---------------------------------------------------------------------------

describe("extraction determinism", () => {
  it("returns identical extraction and attribution across runs", () => {
    const commits = [
      commit("c3", ["c2"], "feat: a feature", ["main"]),
      commit("f", ["c3"], "fix: a fix", ["main"]),
    ];
    const inp = input(commits);
    const once = extracted(inp);
    const twice = extracted(inp);
    expect(once).toEqual(twice);
    const ranges = [range("main", "c3", "f")];
    expect(attribute(once, inp, ranges)).toEqual(attribute(twice, inp, ranges));
  });
});

// ---------------------------------------------------------------------------
// Harness — the composition root: one pass, normalize → extract → attribute
// ---------------------------------------------------------------------------

describe("harness: one planning pass", () => {
  it("composes extraction and attribution for a valid closed input", () => {
    const commits = [
      commit("c3", [], "chore: keep main moving", ["main"]),
      commit("c9", [], "chore: cut 1.9.0", ["1.9"]),
      commit("f", ["c9"], "fix(parser): handle empty input", ["1.9"]),
    ];
    const inp = input(commits);

    const result = planChanges(inp, [range("main", "c3", "c3"), range("1.9", "c9", "f")]);

    expect(result.extraction.commits).toHaveLength(3);
    expect(result.attribution.kind).toBe("attributed");
    expect(pendingIds(result.attribution, "1.9")).toEqual(["f"]);
    expect(pendingIds(result.attribution, "main")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §2.9 — a kernel-rejected change identity surfaces as an unparseable
// record, never a throw: the kernel is the identity authority, the planner
// reports its refusal and moves on
// ---------------------------------------------------------------------------

describe("§2.9: kernel-rejected change identity", () => {
  it("surfaces a padded marker id as unparseable with the kernel's reason", () => {
    const commits = [
      commit("c3", ["c2"], "chore: keep main moving", ["main"]),
      commit("p", ["c3"], "fix: odd one\n\nChange-Id:  padded id ", ["main"]),
    ];
    const inp = input(commits);

    const result = extracted(inp);

    expect(result.commits.find((c) => c.sha === "p")?.classification).toBe("unparseable");
    const exclusion = result.excluded.find((e) => e.sha === "p");
    expect(exclusion?.rule).toBe("unparseable");
    expect(exclusion?.detail).toContain("whitespace");
  });
});

// ---------------------------------------------------------------------------
// PL-04 — decision level: no release is attributable to the release PR's own
// commit R ("no release attributable to R; if other pending commits exist the
// plan proceeds without R; otherwise PL-06's empty-change-set behavior
// applies" — the decision row atop the self-reference exclusion above)
// ---------------------------------------------------------------------------

describe("PL-04: no release attributable to R", () => {
  // R carries the reserved self-reference trailer namespace exactly as the
  // attribution-layer exclusion fixture builds it; on line 1.9 its subject
  // names the line's release PR.
  const r = (parent: string) =>
    commit("r", [parent], "chore: release 1.9\n\nRelease-Craft: plan 01d4479c", ["1.9"]);

  /** Every pending change id across the attributed plan — the raw material
   * the decision layer grades. R must never appear among them. */
  function allPendingIds(outcome: AttributionOutcome): string[] {
    return attributedLines(outcome).flatMap((l) => l.pending.map((c) => c.change?.id ?? c.sha));
  }

  it("proceeds without R when a release-worthy fix is pending beside it", () => {
    const commits = [
      commit("c9", ["c8"], "chore: cut 1.9.0", ["1.9"]),
      r("c9"),
      commit("f", ["r"], "fix(parser): handle empty input", ["1.9"]),
    ];
    const inp = input(commits);
    const outcome = attribute(extracted(inp), inp, [range("1.9", "c9", "f")]);
    expect(outcome.kind).toBe("attributed");
    // The release's change set is the fix alone (the patch cut beyond the
    // 1.9.0 baseline is driven by F, not by R).
    expect(allPendingIds(outcome)).toEqual(["f"]);
    // No pending member anywhere in the plan carries R: no release is
    // attributable to R.
    expect(allPendingIds(outcome)).not.toContain("r");
    // R is surfaced as excluded bookkeeping, not silently dropped.
    expect(
      attributedLines(outcome)
        .find((l) => l.lineId === "1.9")
        ?.excluded.map((e) => e.sha),
    ).toContain("r");
  });

  it("records the empty change set when R is all that is left (the PL-06 posture)", () => {
    const commits = [commit("c9", ["c8"], "chore: cut 1.9.0", ["1.9"]), r("c9")];
    const inp = input(commits);
    const outcome = attribute(extracted(inp), inp, [range("1.9", "c9", "r")]);
    expect(outcome.kind).toBe("attributed");
    // Nothing release-worthy survives R's exclusion: the line's change set
    // is empty — the no-op posture, nothing mints beyond the 1.9.0 baseline.
    expect(allPendingIds(outcome)).toEqual([]);
    // R itself is surfaced as excluded, never a change.
    expect(
      attributedLines(outcome)
        .find((l) => l.lineId === "1.9")
        ?.excluded.map((e) => e.sha),
    ).toContain("r");
  });
});
