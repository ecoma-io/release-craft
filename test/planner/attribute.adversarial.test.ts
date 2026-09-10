/**
 * Adversarial black-box tests for §2.4 attribution (ancestry authority,
 * fail-closed refusals) over the §2.3/§2.12 extraction surface, per
 * [phase2-planner-contract.md](../../docs/design/phase2-planner-contract.md)
 * and ADR-0003. Fixtures are self-contained; assertions target observable
 * outcomes only — pending sets, released identities, per-line exclusions,
 * refusal cause + commits — never the implementation's internals.
 */
import { describe, expect, it } from "vitest";

import { attribute } from "@ecoma-io/release-craft/__internal__/planner/attribute.js";
import { extract } from "@ecoma-io/release-craft/__internal__/planner/extract.js";
import {
  InvalidPlanningInputError,
  normalize,
} from "@ecoma-io/release-craft/__internal__/planner/input.js";
import type {
  CommitObservation,
  LineAttribution,
  LineConfig,
  LineRange,
  PlanningInput,
  PolicyInput,
  RefObservation,
} from "@ecoma-io/release-craft/__internal__/planner/types.js";

const POLICY_DIGEST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const COMMITTED_AT = "2026-01-01T00:00:00Z";

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

function commit(
  sha: string,
  message: string,
  opts: {
    readonly parents?: readonly string[];
    readonly containingRefs?: readonly string[];
  } = {},
): CommitObservation {
  return {
    sha,
    parents: opts.parents ?? [],
    message,
    committedAt: COMMITTED_AT,
    containingRefs: opts.containingRefs ?? [],
  };
}

function line(id: string, feedRef: string): LineConfig {
  return { id, feedRef, lifecycle: "active", declared: true };
}

function buildInput(
  lines: readonly LineConfig[],
  commits: readonly CommitObservation[],
  refs: readonly RefObservation[],
): PlanningInput {
  return {
    policy: policy(),
    repository: { commits, refs },
    history: { tags: [] },
    lines,
  };
}

function range(lineId: string, head: string, releasedUpTo: string | null = null): LineRange {
  return { lineId, releasedUpTo, head };
}

/** Deterministic view of a line's pending commits, sorted for comparison. */
function pendingShas(attribution: LineAttribution): string[] {
  return attribution.pending.map((parsed) => parsed.sha).sort();
}

function lineById(lines: readonly LineAttribution[], lineId: string): LineAttribution {
  const found = lines.find((candidate) => candidate.lineId === lineId);
  if (found === undefined) {
    throw new Error(`fixture broken: line ${lineId} missing from attribution output`);
  }
  return found;
}

describe("attribute — adversarial attribution", () => {
  it("refuses with ambiguous-attribution naming the sha shared by three lines' pending spans", () => {
    const shared = commit("sha-shared", "fix: the shared fix");
    const headA = commit("sha-a", "chore: line a work", { parents: ["sha-shared"] });
    const headB = commit("sha-b", "chore: line b work", { parents: ["sha-shared"] });
    const headC = commit("sha-c", "chore: line c work", { parents: ["sha-shared"] });
    const lines = [line("l1", "feed/1"), line("l2", "feed/2"), line("l3", "feed/3")];
    const commits = [shared, headA, headB, headC];
    const refs = [
      { name: "feed/1", head: "sha-a" },
      { name: "feed/2", head: "sha-b" },
      { name: "feed/3", head: "sha-c" },
    ];
    const input = normalize(buildInput(lines, commits, refs));
    const extraction = extract(commits, policy());

    const outcome = attribute(extraction, input, [
      range("l1", "sha-a"),
      range("l2", "sha-b"),
      range("l3", "sha-c"),
    ]);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") {
      throw new Error("expected a refused outcome");
    }
    expect(outcome.refusal.cause).toBe("ambiguous-attribution");
    expect(outcome.refusal.commits).toContain("sha-shared");
    expect(outcome.refusal.commits).toHaveLength(1);
    expect(outcome.refusal.policyDigest).toBe(POLICY_DIGEST);
  });

  it("refuses malformed-self-reference-marker for a malformed marker inside an otherwise-attributable span", () => {
    const mBase = commit("m-base", "fix: baseline");
    const mMark = commit("m-mark", "Release-Craft", { parents: ["m-base"] });
    const mHead = commit("m-head", "fix: real work", { parents: ["m-mark"] });
    const bBase = commit("b-base", "fix: other line");
    const bHead = commit("b-head", "fix: other head", { parents: ["b-base"] });
    const lines = [line("a", "feed/a"), line("b", "feed/b")];
    const commits = [mBase, mMark, mHead, bBase, bHead];
    const refs = [
      { name: "feed/a", head: "m-head" },
      { name: "feed/b", head: "b-head" },
    ];
    const input = normalize(buildInput(lines, commits, refs));
    const extraction = extract(commits, policy());

    const outcome = attribute(extraction, input, [range("a", "m-head"), range("b", "b-head")]);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") {
      throw new Error("expected a refused outcome");
    }
    expect(outcome.refusal.cause).toBe("malformed-self-reference-marker");
    expect(outcome.refusal.commits).toContain("m-mark");
    expect(outcome.refusal.commits).toHaveLength(1);
  });

  it("checks the malformed marker before ambiguity when both refusals apply", () => {
    const shared = commit("sha-shared", "fix: the shared fix");
    const m1 = commit("m1", "Release-Craft", { parents: ["sha-shared"] });
    const headA = commit("sha-a", "chore: line a work", { parents: ["m1"] });
    const headB = commit("sha-b", "chore: line b work", { parents: ["sha-shared"] });
    const headC = commit("sha-c", "chore: line c work", { parents: ["sha-shared"] });
    const lines = [line("l1", "feed/1"), line("l2", "feed/2"), line("l3", "feed/3")];
    const commits = [shared, m1, headA, headB, headC];
    const refs = [
      { name: "feed/1", head: "sha-a" },
      { name: "feed/2", head: "sha-b" },
      { name: "feed/3", head: "sha-c" },
    ];
    const input = normalize(buildInput(lines, commits, refs));
    const extraction = extract(commits, policy());

    const outcome = attribute(extraction, input, [
      range("l1", "sha-a"),
      range("l2", "sha-b"),
      range("l3", "sha-c"),
    ]);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") {
      throw new Error("expected a refused outcome");
    }
    // The shared sha is pending in all three spans (ambiguous), yet the
    // malformed marker wins the refusal (§2.4 fail-closed ordering).
    expect(outcome.refusal.cause).toBe("malformed-self-reference-marker");
    expect(outcome.refusal.commits).toContain("m1");
    expect(outcome.refusal.commits).toHaveLength(1);
  });

  it("attributes around a self-reference commit, surfacing it in the line's exclusions", () => {
    const sBase = commit("s-base", "fix: groundwork");
    const sRel = commit("s-rel", "Release-Craft: release 1.2.3", { parents: ["s-base"] });
    const sHead = commit("s-head", "fix: the change", { parents: ["s-rel"] });
    const eHead = commit("e-head", "fix: elsewhere");
    const lines = [line("s", "feed/s"), line("e", "feed/e")];
    const commits = [sBase, sRel, sHead, eHead];
    const refs = [
      { name: "feed/s", head: "s-head" },
      { name: "feed/e", head: "e-head" },
    ];
    const input = normalize(buildInput(lines, commits, refs));
    const extraction = extract(commits, policy());

    const outcome = attribute(extraction, input, [range("s", "s-head"), range("e", "e-head")]);

    expect(outcome.kind).toBe("attributed");
    if (outcome.kind !== "attributed") {
      throw new Error("expected an attributed outcome");
    }
    expect(outcome.lines.map((attribution) => attribution.lineId)).toEqual(["s", "e"]);
    const sLine = lineById(outcome.lines, "s");
    expect(pendingShas(sLine)).toEqual(["s-base", "s-head"]);
    expect(sLine.pending.map((parsed) => parsed.sha)).not.toContain("s-rel");
    expect(sLine.excluded).toHaveLength(1);
    expect(sLine.excluded[0]?.sha).toBe("s-rel");
    expect(sLine.excluded[0]?.rule).toBe("self-reference");
    expect(sLine.released).toHaveLength(0);
    const eLine = lineById(outcome.lines, "e");
    expect(pendingShas(eLine)).toEqual(["e-head"]);
  });

  it("treats releasedUpTo null as the whole reachable span pending", () => {
    const c0 = commit("c0", "fix: first");
    const c1 = commit("c1", "fix: second", { parents: ["c0"] });
    const lines = [line("only", "main")];
    const commits = [c0, c1];
    const refs = [{ name: "main", head: "c1" }];
    const input = normalize(buildInput(lines, commits, refs));
    const extraction = extract(commits, policy());

    const outcome = attribute(extraction, input, [range("only", "c1", null)]);

    expect(outcome.kind).toBe("attributed");
    if (outcome.kind !== "attributed") {
      throw new Error("expected an attributed outcome");
    }
    const only = lineById(outcome.lines, "only");
    expect(pendingShas(only)).toEqual(["c0", "c1"]);
    expect(only.released).toHaveLength(0);
  });

  it("moves the released bound's identities to released, keeping only the rest pending", () => {
    const c0 = commit("c0", "fix: first");
    const c1 = commit("c1", "fix: second", { parents: ["c0"] });
    const lines = [line("only", "main")];
    const commits = [c0, c1];
    const refs = [{ name: "main", head: "c1" }];
    const input = normalize(buildInput(lines, commits, refs));
    const extraction = extract(commits, policy());

    const outcome = attribute(extraction, input, [range("only", "c1", "c0")]);

    expect(outcome.kind).toBe("attributed");
    if (outcome.kind !== "attributed") {
      throw new Error("expected an attributed outcome");
    }
    const only = lineById(outcome.lines, "only");
    expect(pendingShas(only)).toEqual(["c1"]);
    expect(only.released).toEqual(["c0"]);
  });

  it("throws InvalidPlanningInputError naming the line when a range names an unknown lineId", () => {
    const c0 = commit("c0", "fix: something");
    const lines = [line("l1", "main")];
    const input = normalize(buildInput(lines, [c0], [{ name: "main", head: "c0" }]));
    const extraction = extract([c0], policy());

    const attempt = () => attribute(extraction, input, [range("ghost", "c0")]);

    expect(attempt).toThrow(InvalidPlanningInputError);
    expect(attempt).toThrow(/ghost/);
  });

  it("throws InvalidPlanningInputError naming the line when two ranges carry one lineId", () => {
    const c0 = commit("c0", "fix: something");
    const lines = [line("l1", "main")];
    const input = normalize(buildInput(lines, [c0], [{ name: "main", head: "c0" }]));
    const extraction = extract([c0], policy());

    const attempt = () => attribute(extraction, input, [range("l1", "c0"), range("l1", "c0")]);

    expect(attempt).toThrow(InvalidPlanningInputError);
    expect(attempt).toThrow(/l1/);
  });

  it("throws InvalidPlanningInputError naming the sha when a range's head is absent from the commits", () => {
    const c0 = commit("c0", "fix: something");
    const lines = [line("l1", "main")];
    const input = normalize(buildInput(lines, [c0], [{ name: "main", head: "c0" }]));
    const extraction = extract([c0], policy());

    const attempt = () => attribute(extraction, input, [range("l1", "sha-absent")]);

    expect(attempt).toThrow(InvalidPlanningInputError);
    expect(attempt).toThrow(/sha-absent/);
  });

  it("attributes by the parent graph, not containingRefs, when the two diverge", () => {
    // Refs claim d0 for main; the parent graph reaches d0 only from 1.9.
    const d0 = commit("d0", "fix: the real fix", { containingRefs: ["main"] });
    const d19 = commit("d19", "feat: 1.9 work", { parents: ["d0"] });
    const m0 = commit("m0", "feat: mainline work");
    const dmain = commit("dmain", "feat: more mainline", { parents: ["m0"] });
    const lines = [line("1.9", "release/1.9"), line("main", "main")];
    const commits = [d0, d19, m0, dmain];
    const refs = [
      { name: "release/1.9", head: "d19" },
      { name: "main", head: "dmain" },
    ];
    const input = normalize(buildInput(lines, commits, refs));
    const extraction = extract(commits, policy());

    const outcome = attribute(extraction, input, [range("1.9", "d19"), range("main", "dmain")]);

    expect(outcome.kind).toBe("attributed");
    if (outcome.kind !== "attributed") {
      throw new Error("expected an attributed outcome");
    }
    expect(outcome.lines.map((attribution) => attribution.lineId)).toEqual(["1.9", "main"]);
    const oneNine = lineById(outcome.lines, "1.9");
    expect(pendingShas(oneNine)).toEqual(["d0", "d19"]);
    const main = lineById(outcome.lines, "main");
    expect(pendingShas(main)).toEqual(["dmain", "m0"]);
    expect(main.pending.map((parsed) => parsed.sha)).not.toContain("d0");
  });

  it("attributes a cherry-pick pair sharing one identity across two lines without refusing", () => {
    const p0 = commit("p0", "fix: login flow");
    const p1 = commit("p1", "fix: login flow\n\n(cherry picked from commit p0)");
    const lines = [line("a", "feed/a"), line("b", "feed/b")];
    const commits = [p0, p1];
    const refs = [
      { name: "feed/a", head: "p0" },
      { name: "feed/b", head: "p1" },
    ];
    const input = normalize(buildInput(lines, commits, refs));
    const extraction = extract(commits, policy());

    // Legality precondition (M-03): the pair is one identity, no conflict.
    expect(extraction.conflicts).toHaveLength(0);
    const copy = extraction.commits.find((parsed) => parsed.sha === "p1");
    expect(copy?.change?.id).toBe("p0");

    const outcome = attribute(extraction, input, [range("a", "p0"), range("b", "p1")]);

    expect(outcome.kind).toBe("attributed");
    if (outcome.kind !== "attributed") {
      throw new Error("expected an attributed outcome");
    }
    expect(pendingShas(lineById(outcome.lines, "a"))).toEqual(["p0"]);
    expect(pendingShas(lineById(outcome.lines, "b"))).toEqual(["p1"]);
  });

  it("attributes despite a surfaced extraction identity conflict — M-05 data is not a refusal", () => {
    const x1 = commit("x1", "fix: one\n\nChange-Id: Iconf123");
    const x2 = commit("x2", "fix: two\n\nChange-Id: Iconf123", { parents: ["x1"] });
    const lines = [line("only", "main")];
    const commits = [x1, x2];
    const refs = [{ name: "main", head: "x2" }];
    const input = normalize(buildInput(lines, commits, refs));
    const extraction = extract(commits, policy());

    expect(extraction.conflicts).toHaveLength(1);
    expect(extraction.conflicts[0]?.changeId).toBe("Iconf123");

    const outcome = attribute(extraction, input, [range("only", "x2")]);

    expect(outcome.kind).toBe("attributed");
    if (outcome.kind !== "attributed") {
      throw new Error("expected an attributed outcome");
    }
    expect(pendingShas(lineById(outcome.lines, "only"))).toEqual(["x1", "x2"]);
  });

  it("throws InvalidPlanningInputError naming the sha when releasedUpTo is absent from the commits", () => {
    const c0 = commit("c0", "fix: something");
    const lines = [line("l1", "main")];
    const input = normalize(buildInput(lines, [c0], [{ name: "main", head: "c0" }]));
    const extraction = extract([c0], policy());

    const attempt = (): unknown => attribute(extraction, input, [range("l1", "c0", "sha-absent")]);

    expect(attempt).toThrow(InvalidPlanningInputError);
    expect(attempt).toThrow(/sha-absent/);
  });

  it("never surfaces a self-reference that sits outside every pending span", () => {
    const c0 = commit("c0", "fix: base");
    const sr = commit("sr", "chore: bookkeeping\n\nRelease-Craft: skipped", {
      parents: ["c0"],
    });
    const lines = [line("l1", "main")];
    const input = normalize(buildInput(lines, [c0, sr], [{ name: "main", head: "sr" }]));
    const extraction = extract([c0, sr], policy());

    const outcome = attribute(extraction, input, [range("l1", "c0")]);

    expect(outcome.kind).toBe("attributed");
    if (outcome.kind !== "attributed") {
      throw new Error("expected an attributed outcome");
    }
    const l1 = lineById(outcome.lines, "l1");
    expect(pendingShas(l1)).toEqual(["c0"]);
    expect(l1.excluded).toHaveLength(0);
  });
});
