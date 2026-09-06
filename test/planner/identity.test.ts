/**
 * Unit tests for §2.11 plan identity (ADR-0003 decisions 9–10, D12): the
 * canonical JSON form and the two content fingerprints. Fixtures are
 * self-contained; assertions target observable strings and fingerprint
 * (in)equality only — never implementation internals.
 */
import { describe, expect, it } from "vitest";

import { Version } from "@ecoma-io/release-craft/domain";

import { canonicalJson, inputsFingerprint, planFingerprint } from "../../src/planner/identity.js";
import type {
  CommitObservation,
  PlanLine,
  PlanningInput,
  ReleasePlan,
} from "../../src/planner/types.js";

const COMMITTED_AT = "2026-01-01T00:00:00Z";

function planLine(lineId: string, changeId: string): PlanLine {
  return {
    lineId,
    stable: { version: "1.3.0", tag: "v1.3.0" },
    streams: [
      {
        identifier: "rc",
        version: Version.parse("1.3.0-rc.0"),
        tag: "v1.3.0-rc.0",
        seed: "0",
        pointerBase: "1.2.0",
        movesPointer: false,
      },
    ],
    changes: [{ id: changeId, lineage: [changeId], type: "feat", bump: "minor" }],
    propagation: { edges: [], order: [], notMoved: [] },
    preconditions: [{ kind: "tag-absent", tag: "v1.3.0" }],
    artifacts: ["changelog"],
  };
}

function plan(lines: readonly PlanLine[], supersedes: string | null): Omit<ReleasePlan, "planId"> {
  return {
    supersedes,
    policyDigest: "test-policy-v1",
    inputsFingerprint: `inputs_sha256:${"0".repeat(64)}`,
    refusedIntents: [],
    lines,
    explanation: { foreignTags: [], conflicts: [], excluded: [], withheld: [] },
  };
}

function commit(sha: string, message: string): CommitObservation {
  return { sha, parents: [], message, committedAt: COMMITTED_AT, containingRefs: [] };
}

function input(commits: readonly CommitObservation[]): PlanningInput {
  return {
    policy: {
      digest: "test-policy-v1",
      bumpMappingId: "default",
      prereleaseLadder: ["alpha", "beta", "rc"],
      prereleaseSeed: "0",
      pre10Dampening: true,
      selfReferenceNamespace: "Release-Craft:",
      tagFormats: {},
    },
    repository: { commits, refs: [{ name: "main", head: "sha-a" }] },
    history: { tags: [{ name: "v1.2.0", commit: "sha-a" }] },
    lines: [{ id: "main", feedRef: "main", lifecycle: "active", declared: true }],
  };
}

describe("canonicalJson — §2.11 canonical form", () => {
  it("sorts object keys recursively and emits no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("keeps array order and serializes numbers via String(n)", () => {
    expect(canonicalJson([{ b: 1, a: 2 }, [3, 2, 1]])).toBe('[{"a":2,"b":1},[3,2,1]]');
    expect(canonicalJson({ s: 'x"y\n', n: 1.0, t: true, z: null })).toBe(
      '{"n":1,"s":"x\\"y\\n","t":true,"z":null}',
    );
  });

  it("omits object fields whose value is undefined", () => {
    expect(canonicalJson({ a: 1, b: undefined, c: { d: undefined, e: null } })).toBe(
      '{"a":1,"c":{"e":null}}',
    );
  });

  it("serializes a kernel Version as its canonical string", () => {
    expect(canonicalJson({ v: Version.parse("1.2.3-rc.1+build.1") })).toBe(
      '{"v":"1.2.3-rc.1+build.1"}',
    );
  });

  it("refuses cyclic values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/);
  });

  it("refuses values with no canonical serialization", () => {
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(TypeError);
    expect(() => canonicalJson({ count: 1n })).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });
});

describe("planFingerprint — §2.11 plan identity", () => {
  it("emits the frozen plan_sha256 format", () => {
    expect(planFingerprint(plan([planLine("main", "sha-1")], null))).toMatch(
      /^plan_sha256:[0-9a-f]{64}$/,
    );
  });

  it("is equal for identical plans built separately (invariant 2)", () => {
    const left = planFingerprint(plan([planLine("main", "sha-1")], null));
    const right = planFingerprint(plan([planLine("main", "sha-1")], null));
    expect(left).toBe(right);
  });

  it("is equal when field insertion order differs — canonical form absorbs it", () => {
    const reordered: PlanLine = {
      artifacts: ["changelog"],
      preconditions: [{ kind: "tag-absent", tag: "v1.3.0" }],
      propagation: { edges: [], order: [], notMoved: [] },
      changes: [{ id: "sha-1", lineage: ["sha-1"], type: "feat", bump: "minor" }],
      streams: [
        {
          identifier: "rc",
          version: Version.parse("1.3.0-rc.0"),
          tag: "v1.3.0-rc.0",
          seed: "0",
          pointerBase: "1.2.0",
          movesPointer: false,
        },
      ],
      stable: { version: "1.3.0", tag: "v1.3.0" },
      lineId: "main",
    };
    expect(planFingerprint(plan([reordered], null))).toBe(
      planFingerprint(plan([planLine("main", "sha-1")], null)),
    );
  });

  it("differs when the change set differs at the same version (E-11)", () => {
    const left = planFingerprint(plan([planLine("main", "sha-1")], null));
    const right = planFingerprint(plan([planLine("main", "sha-2")], null));
    expect(left).not.toBe(right);
  });

  it("differs when any other closed-tuple field differs", () => {
    const base = planFingerprint(plan([planLine("main", "sha-1")], null));
    const otherSupersedes = planFingerprint(
      plan([planLine("main", "sha-1")], `plan_sha256:${"1".repeat(64)}`),
    );
    expect(otherSupersedes).not.toBe(base);
    const otherPolicy: Omit<ReleasePlan, "planId"> = {
      ...plan([planLine("main", "sha-1")], null),
      policyDigest: "other-policy",
    };
    expect(planFingerprint(otherPolicy)).not.toBe(base);
    const otherInputs: Omit<ReleasePlan, "planId"> = {
      ...plan([planLine("main", "sha-1")], null),
      inputsFingerprint: `inputs_sha256:${"2".repeat(64)}`,
    };
    expect(planFingerprint(otherInputs)).not.toBe(base);
  });
});

describe("inputsFingerprint — §2.11/E-04 input-world identity", () => {
  it("emits the frozen inputs_sha256 format", () => {
    expect(inputsFingerprint(input([commit("sha-a", "feat: one")]))).toMatch(
      /^inputs_sha256:[0-9a-f]{64}$/,
    );
  });

  it("is equal for identical inputs built separately (invariant 2)", () => {
    const left = inputsFingerprint(input([commit("sha-a", "feat: one")]));
    const right = inputsFingerprint(input([commit("sha-a", "feat: one")]));
    expect(left).toBe(right);
  });

  it("differs when one commit joins the world (E-04 staleness recognition)", () => {
    const before = inputsFingerprint(input([commit("sha-a", "feat: one")]));
    const after = inputsFingerprint(
      input([commit("sha-a", "feat: one"), commit("sha-b", "fix: two")]),
    );
    expect(after).not.toBe(before);
  });

  it("keeps a docs-only commit out of the world (PL-08) — the fingerprint is unchanged", () => {
    const before = inputsFingerprint(input([commit("sha-a", "feat: one")]));
    const after = inputsFingerprint(
      input([commit("sha-a", "feat: one"), commit("sha-b", "docs: notes")]),
    );
    expect(after).toBe(before);
  });

  it("changes when a release-triggering commit joins the world (PL-08's complement)", () => {
    const before = inputsFingerprint(input([commit("sha-a", "feat: one")]));
    const after = inputsFingerprint(
      input([commit("sha-a", "feat: one"), commit("sha-b", "feat: two")]),
    );
    expect(after).not.toBe(before);
  });

  it("changes when a breaking commit of an unlisted type joins (PL-05: the marker dominates)", () => {
    const before = inputsFingerprint(input([commit("sha-a", "feat: one")]));
    const after = inputsFingerprint(
      input([commit("sha-a", "feat: one"), commit("sha-b", "chore!: drop the old flag")]),
    );
    expect(after).not.toBe(before);
  });
});
