/**
 * integration door of src/planner/assemble.ts over the landed PR-2/PR-3/PR-4
 * modules: S-01, S-02, S-03, M-07, P-06, PL-02, E-04, E-11 and the §2.4
 * fail-closed refusal of docs/design/release-scenarios.md, plus the door
 * pins D17 adds — the P-03 promote door, the release-anyway forced record,
 * the ReleasePlan.explanation aggregation, and the line↔component mapping
 * refusal — and the D18 line-policy composition adds — the recorded stream
 * refusals (M-08), the allow-list posture, the declared publishes binding,
 * and the refused/withheld line consumption — with the §2.11 plan-shape
 * rules (minted-tag preconditions and artifacts) and the frozen-shape
 * readings the assembly pins:
 *
 * 1. Component mapping (§2.15, D17(8) → D18 Decision 4, PL-01's seam): each
 *    releasing line's release entry binds to the component its declared
 *    `publishes` names; absent the declaration, the D17(8) single-component
 *    posture carries the release. A releasing line without the declaration
 *    in any other world, a binding naming an undeclared component, or two
 *    lines binding one component is refused, naming the gap. Zero-release
 *    plans propagate honestly over an empty release list (negative
 *    evidence per declared component).
 * 2. Propagation attachment (§2.11's tuple wording): the one plan-level
 *    PropagationPlan rides verbatim on every assembled line.
 *
 * Fixture builders mirror scenario.golden.test.ts / plan.golden.test.ts.
 * §2.14: the door is pure, so planned scenarios re-run their input and
 * require whole-outcome equality — E-04 pins the fingerprint form.
 */
import { describe, expect, it } from "vitest";

import { Version } from "@ecoma-io/release-craft/domain";

import { plan } from "../../src/planner/assemble.js";
import { inputsFingerprint, planFingerprint } from "../../src/planner/identity.js";
import { InvalidPlanningInputError } from "../../src/planner/input.js";
import type {
  BootstrapDecision,
  CommitObservation,
  ComponentMeta,
  LineConfig,
  LineDecision,
  OperatorIntent,
  PlanningInput,
  PlanningOutcome,
  PlanLine,
  PolicyInput,
  RefObservation,
  TagObservation,
} from "../../src/planner/types.js";

// ---------------------------------------------------------------------------
// Fixture builders — deterministic, closed inputs per §2.1, mirroring the
// golden suites' idiom
// ---------------------------------------------------------------------------

const COMMITTED_AT = "2026-01-01T00:00:00Z";

/** One fixed digest per scenario — opaque content identity (invariant 4). */
const DIGEST_S01 = "sha256:" + "p".repeat(64);
const DIGEST_S02 = "sha256:" + "q".repeat(64);
const DIGEST_S03 = "sha256:" + "r".repeat(64);
const DIGEST_M07 = "sha256:" + "s".repeat(64);
const DIGEST_P06 = "sha256:" + "t".repeat(64);
const DIGEST_PL02 = "sha256:" + "u".repeat(64);
const DIGEST_E04 = "sha256:" + "v".repeat(64);
const DIGEST_E04_AMENDED = "sha256:" + "w".repeat(64);
const DIGEST_E11 = "sha256:" + "x".repeat(64);
const DIGEST_REFUSED = "sha256:" + "y".repeat(64);
const DIGEST_DEDUPE = "sha256:" + "z".repeat(64);
const DIGEST_P03 = "sha256:" + "0".repeat(64);
const DIGEST_FORCED = "sha256:" + "1".repeat(64);
const DIGEST_EXPLAIN = "sha256:" + "2".repeat(64);
const DIGEST_P07 = "sha256:" + "3".repeat(64);
const DIGEST_M08 = "sha256:" + "4".repeat(64);
const DIGEST_D18_LIST = "sha256:" + "5".repeat(64);
const DIGEST_D18_BIND = "sha256:" + "6".repeat(64);
const DIGEST_D18_SOLO = "sha256:" + "7".repeat(64);
const DIGEST_D18_REFUSED = "sha256:" + "8".repeat(64);
const DIGEST_D18_WITHHELD = "sha256:" + "9".repeat(64);

function policy(digest: string, tagFormats: Readonly<Record<string, string>> = {}): PolicyInput {
  return {
    digest,
    bumpMappingId: "default",
    prereleaseLadder: ["alpha", "beta", "rc"],
    prereleaseSeed: "0",
    pre10Dampening: true,
    selfReferenceNamespace: "Release-Craft:",
    tagFormats,
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

function ref(name: string, head: string): RefObservation {
  return { name, head };
}

function tag(name: string, sha: string): TagObservation {
  return { name, commit: sha };
}

function line(
  id: string,
  feedRef: string,
  versionBand?: { readonly major: number; readonly minor?: number },
  declared = true,
): LineConfig {
  const config: LineConfig = { id, feedRef, lifecycle: "active", declared };
  if (versionBand === undefined) {
    return config;
  }
  return { ...config, versionBand };
}

function component(
  name: string,
  manifestVersion: string,
  dependencies?: readonly { readonly name: string; readonly range: string }[],
): ComponentMeta {
  return dependencies === undefined
    ? { name, manifestVersion, paths: ["package.json"] }
    : { name, manifestVersion, paths: ["package.json"], dependencies };
}

interface FixtureOptions {
  readonly digest: string;
  readonly lines: readonly LineConfig[];
  readonly commits: readonly CommitObservation[];
  readonly refs: readonly RefObservation[];
  readonly tags?: readonly TagObservation[];
  readonly components?: readonly ComponentMeta[];
  readonly bootstrap?: BootstrapDecision;
  readonly intents?: readonly OperatorIntent[];
  readonly policy?: PolicyInput;
}

/** The closed §2.1 input a scenario's stated initial state reconstructs. */
function buildInput(opts: FixtureOptions): PlanningInput {
  return {
    policy: opts.policy ?? policy(opts.digest),
    repository: { commits: opts.commits, refs: opts.refs },
    history: { tags: opts.tags ?? [] },
    lines: opts.lines,
    ...(opts.components === undefined ? {} : { components: opts.components }),
    ...(opts.bootstrap === undefined ? {} : { bootstrap: opts.bootstrap }),
    ...(opts.intents === undefined ? {} : { intents: opts.intents }),
  };
}

// ---------------------------------------------------------------------------
// Narrowing helpers — every assertion runs against the planned branch
// ---------------------------------------------------------------------------

/** §2.9: the refusal is an outcome, not an exception — tests that expect a
 * plan narrow here, and anything else fails the fixture, not an expect. */
function plannedOf(outcome: PlanningOutcome): Extract<PlanningOutcome, { kind: "planned" }> {
  if (outcome.kind !== "planned") {
    throw new Error(`fixture broken: expected a planned outcome, got ${outcome.kind}`);
  }
  return outcome;
}

/** One line's decision record, found by id among the collected decisions. */
function decisionFor(outcome: PlanningOutcome, lineId: string): LineDecision {
  const found = plannedOf(outcome).decisions.find((candidate) => candidate.lineId === lineId);
  if (found === undefined) {
    throw new Error(`fixture broken: line ${lineId} has no decision record`);
  }
  return found;
}

/** The single assembled plan line of a one-minting-line scenario. */
function planLineOf(outcome: PlanningOutcome): PlanLine {
  const found = plannedOf(outcome).plan.lines[0];
  if (found === undefined) {
    throw new Error("fixture broken: the plan assembles no line");
  }
  return found;
}

// ---------------------------------------------------------------------------
// S-01 — chore-only runway: the empty successor plan beside the no-op record
// ---------------------------------------------------------------------------

describe("S-01 through the door — the chore-only runway", () => {
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_S01,
      lines: [line("1.x", "main", { major: 1 })],
      commits: [
        commit("s01-1.0.0", "feat: the first release", { containingRefs: ["main"] }),
        commit("s01-1.0.1", "fix: the follow-up patch", {
          parents: ["s01-1.0.0"],
          containingRefs: ["main"],
        }),
        commit("s01-chore-1", "chore: bump devdep floor", {
          parents: ["s01-1.0.1"],
          containingRefs: ["main"],
        }),
        commit("s01-chore-2", "chore: prune the unused release script", {
          parents: ["s01-chore-1"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "s01-chore-2")],
      tags: [tag("1.0.0", "s01-1.0.0"), tag("1.0.1", "s01-1.0.1")],
      components: [component("release-craft", "1.0.1")],
      intents: [{ kind: "release" }],
    });
  }

  it("plans the empty successor (`lines: []`) while the decisions carry the no-op", () => {
    const outcome = plan(input());
    const { plan: assembled } = plannedOf(outcome);
    expect(assembled.lines).toEqual([]);
    expect(assembled.supersedes).toBeNull();
    expect(assembled.policyDigest).toBe(DIGEST_S01);
    expect(plannedOf(outcome).decisions).toHaveLength(1);
    expect(decisionFor(outcome, "1.x")).toMatchObject({
      kind: "no-op",
      cause: "no-release-worthy-changes",
      lineId: "1.x",
      policyDigest: DIGEST_S01,
      range: { lineId: "1.x", releasedUpTo: "s01-1.0.1", head: "s01-chore-2" },
      ignored: [{ sha: "s01-chore-1" }, { sha: "s01-chore-2" }],
    });
  });

  it("fingerprints the closed tuple — planId over the plan sans planId (§2.11)", () => {
    const { plan: assembled } = plannedOf(plan(input()));
    expect(assembled.planId).toMatch(/^plan_sha256:[0-9a-f]{64}$/);
    // D18: the tuple is the assembled plan's own fields — a spread, so a
    // future tuple field cannot drift out of this pin.
    const { planId: _omit, ...tuple } = assembled;
    expect(assembled.planId).toBe(planFingerprint(tuple));
    expect(assembled.inputsFingerprint).toBe(inputsFingerprint(input()));
  });
});

// ---------------------------------------------------------------------------
// S-02 — the un-bootstrapped first release: block as record, then unlock
// ---------------------------------------------------------------------------

describe("S-02 through the door — the un-bootstrapped first release", () => {
  function input(bootstrap?: BootstrapDecision): PlanningInput {
    return buildInput({
      digest: DIGEST_S02,
      lines: [line("default", "main")],
      commits: [
        commit("s02-feat-core", "feat: the core workflow", { containingRefs: ["main"] }),
        commit("s02-feat-cli", "feat: the command surface", {
          parents: ["s02-feat-core"],
          containingRefs: ["main"],
        }),
        commit("s02-fix", "fix: the parser edge", {
          parents: ["s02-feat-cli"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "s02-fix")],
      components: [component("release-craft", "0.0.0")],
      ...(bootstrap === undefined ? {} : { bootstrap }),
    });
  }

  it("without a recorded bootstrap decision the first release blocks as a record", () => {
    const outcome = plan(input());
    expect(plannedOf(outcome).plan.lines).toEqual([]);
    expect(decisionFor(outcome, "default")).toMatchObject({
      kind: "blocked",
      cause: "bootstrap-required",
      lineId: "default",
      policyDigest: DIGEST_S02,
      range: { lineId: "default", releasedUpTo: null, head: "s02-fix" },
    });
  });

  it("the operator's recorded bootstrap unlocks the release — the target is the bootstrap version verbatim", () => {
    const outcome = plan(input({ version: "1.0.0", who: "the operator", when: COMMITTED_AT }));
    expect(decisionFor(outcome, "default")).toMatchObject({
      kind: "release",
      bump: "minor",
      range: { lineId: "default", releasedUpTo: null, head: "s02-fix" },
    });
    // D17(1): "either is valid, silently derived is not" — the recorded
    // bootstrap version is the stable target verbatim (1.0.0, not the birth
    // bump 0.1.0), while the decision's bump still records the change class.
    // Each change entry carries its own resolved bump (reviewer m-3): the
    // fix is a patch alone, not the group's winning minor.
    expect(planLineOf(outcome)).toEqual({
      lineId: "default",
      stable: { version: "1.0.0", tag: "1.0.0" },
      streams: [],
      changes: [
        { id: "s02-feat-core", lineage: ["s02-feat-core"], type: "feat", bump: "minor" },
        { id: "s02-feat-cli", lineage: ["s02-feat-cli"], type: "feat", bump: "minor" },
        { id: "s02-fix", lineage: ["s02-fix"], type: "fix", bump: "patch" },
      ],
      propagation: { edges: [], order: ["release-craft"], notMoved: [] },
      preconditions: [{ kind: "tag-absent", tag: "1.0.0" }],
      artifacts: ["1.0.0"],
    });
  });
});

// ---------------------------------------------------------------------------
// S-03 — the healthy patch release, manifest outranked by tag history
// ---------------------------------------------------------------------------

describe("S-03 through the door — the healthy patch release", () => {
  function input(policyOverrides?: PolicyInput): PlanningInput {
    return buildInput({
      digest: policyOverrides?.digest ?? DIGEST_S03,
      lines: [line("1.x", "main", { major: 1 })],
      commits: [
        commit("s03-1.9.0", "feat: the 1.9 line", { containingRefs: ["main"] }),
        commit("s03-hf1", "fix: the first patch", {
          parents: ["s03-1.9.0"],
          containingRefs: ["main"],
        }),
        commit("s03-hf2", "fix: the second patch", {
          parents: ["s03-hf1"],
          containingRefs: ["main"],
        }),
        commit("s03-hf3", "fix: the third patch", {
          parents: ["s03-hf2"],
          containingRefs: ["main"],
        }),
        commit("s03-hf4", "fix: the fourth patch", {
          parents: ["s03-hf3"],
          containingRefs: ["main"],
        }),
        commit("s03-hf5", "fix: the fifth patch", {
          parents: ["s03-hf4"],
          containingRefs: ["main", "release/1.9"],
        }),
        commit("s03-fix-main", "fix: guard empty config", {
          parents: ["s03-hf5"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "s03-fix-main"), ref("release/1.9", "s03-hf5")],
      tags: [
        tag("1.9.0", "s03-1.9.0"),
        tag("1.9.1", "s03-hf1"),
        tag("1.9.2", "s03-hf2"),
        tag("1.9.3", "s03-hf3"),
        tag("1.9.4", "s03-hf4"),
        tag("1.9.5", "s03-hf5"),
      ],
      components: [component("release-craft", "1.9.0")],
      intents:
        policyOverrides === undefined
          ? [{ kind: "release" }]
          : [{ kind: "prerelease", stream: "rc", lineId: "1.x" }],
      ...(policyOverrides === undefined ? {} : { policy: policyOverrides }),
    });
  }
  it("plans the patch successor while the stale manifest is consumed nowhere", () => {
    const outcome = plan(input());
    expect(decisionFor(outcome, "1.x")).toMatchObject({
      kind: "release",
      bump: "patch",
      policyDigest: DIGEST_S03,
      range: { lineId: "1.x", releasedUpTo: "s03-hf5", head: "s03-fix-main" },
      changes: [{ sha: "s03-fix-main" }],
    });
    expect(planLineOf(outcome)).toEqual({
      lineId: "1.x",
      stable: { version: "1.9.6", tag: "1.9.6" },
      streams: [],
      changes: [{ id: "s03-fix-main", lineage: ["s03-fix-main"], type: "fix", bump: "patch" }],
      propagation: { edges: [], order: ["release-craft"], notMoved: [] },
      preconditions: [{ kind: "tag-absent", tag: "1.9.6" }],
      artifacts: ["1.9.6"],
    });
    // Invariant 6: tag history outranks the manifest — 1.9.0 (its only
    // occurrence in the input world) appears nowhere in the plan.
    expect(JSON.stringify(plannedOf(outcome).plan)).not.toContain("1.9.0");
    // §2.14: the door is pure — identical inputs, identical whole outcome.
    expect(plan(input())).toEqual(outcome);
  });

  it("renders a token-bearing format on the stream mint, one precondition per minted tag", () => {
    const overrides: PolicyInput = {
      ...policy(DIGEST_DEDUPE),
      tagFormats: { "1.x": "v{major}.{minor}.{patch}{prerelease}" },
    };
    const outcome = plan(input(overrides));
    const assembled = planLineOf(outcome);
    // D17(3): the rc intent suppresses the stable co-mint — the stream is
    // the publication, so the declared format renders on the stream mint
    // alone: one minted tag, one precondition and one artifact (fork 11's
    // naming knob, door-side). The old same-label stable/stream dedupe
    // premise is unreachable here: the door refuses formats without the
    // {prerelease} token, and a prerelease intent suppresses the stable
    // outright.
    expect(assembled.stable).toBe(null);
    const stream = assembled.streams[0];
    if (stream === undefined) {
      throw new Error("fixture broken: the rc stream must be planned");
    }
    expect(stream.identifier).toBe("rc");
    expect(stream.version.equals(Version.parse("1.9.6-rc.0"))).toBe(true);
    expect(stream.tag).toBe("v1.9.6-rc.0");
    expect(assembled.preconditions).toEqual([{ kind: "tag-absent", tag: "v1.9.6-rc.0" }]);
    expect(assembled.artifacts).toEqual(["v1.9.6-rc.0"]);
  });
});

// ---------------------------------------------------------------------------
// S-04/S-05 — the bump-driving classification is independent of
// changelog-worthiness; the major cut beside a live maintenance line
// ---------------------------------------------------------------------------

describe("S-04 through the door — release-worthy, not changelog-worthy", () => {
  const DIGEST_S04 = "sha256:" + "u".repeat(64);

  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_S04,
      lines: [line("1.x", "main", { major: 1 })],
      commits: [
        commit("s04-1.0.4", "feat: the 1.0 line", { containingRefs: ["main"] }),
        commit("s04-fix-1", "fix: guard the parser against empty config", {
          parents: ["s04-1.0.4"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "s04-fix-1")],
      tags: [tag("1.0.4", "s04-1.0.4")],
      components: [component("release-craft", "1.0.4")],
      intents: [{ kind: "release" }],
    });
  }

  it("releases the patch 1.0.5 from the fix alone — the internal-scoped fix is release-worthy", () => {
    const outcome = plan(input());
    expect(decisionFor(outcome, "1.x")).toMatchObject({
      kind: "release",
      bump: "patch",
      range: { lineId: "1.x", releasedUpTo: "s04-1.0.4", head: "s04-fix-1" },
    });
    const assembled = planLineOf(outcome);
    if (assembled.stable === null) {
      throw new Error("fixture broken: the patch must be planned");
    }
    expect(assembled.stable.version).toBe("1.0.5");
    expect(assembled.stable.tag).toBe("1.0.5");
  });
});

describe("S-05 through the door — the major cut beside a live maintenance line", () => {
  const DIGEST_S05 = "sha256:" + "v".repeat(64);

  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_S05,
      lines: [line("2.x", "main", { major: 2 }), line("1.x", "release/1", { major: 1 })],
      commits: [
        commit("s05-1.0.0", "feat: the shared base", { containingRefs: ["main", "release/1"] }),
        commit("s05-1.0.1", "fix: the maintenance patch", {
          parents: ["s05-1.0.0"],
          containingRefs: ["release/1"],
        }),
        commit("s05-feat", "feat!: the new major", {
          parents: ["s05-1.0.0"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "s05-feat"), ref("release/1", "s05-1.0.1")],
      // Interleaved walk order: the 1.x tags are NEWER in name order than
      // the 2.x base — each line's history stays its own (§2.13).
      tags: [tag("1.0.1", "s05-1.0.1"), tag("1.0.0", "s05-1.0.0")],
      bootstrap: { version: "2.0.0", who: "the operator", when: "2026-01-01T00:00:00Z" },
      components: [component("release-craft", "1.0.1")],
      intents: [{ kind: "release" }],
    });
  }

  it("cuts 2.0.0 on the new line while the maintenance line stays a recorded no-op", () => {
    const outcome = plan(input());
    expect(decisionFor(outcome, "2.x")).toMatchObject({ kind: "release", bump: "major" });
    const lines = plannedOf(outcome).plan.lines;
    const cutting = lines.find((candidate) => candidate.lineId === "2.x");
    if (cutting?.stable == null) {
      throw new Error("fixture broken: the major cut must be planned");
    }
    expect(cutting.stable.version).toBe("2.0.0");
    expect(cutting.stable.tag).toBe("2.0.0");
    expect(decisionFor(outcome, "1.x")).toMatchObject({ kind: "no-op" });
    expect(lines.find((candidate) => candidate.lineId === "1.x")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// M-07 — two lines with own ranges: the no-op mints nothing, input order holds
// ---------------------------------------------------------------------------

describe("M-07 through the door — two lines, own ranges, divergent histories", () => {
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_M07,
      lines: [line("2.x", "2.x", { major: 2 }), line("1.9", "1.9", { major: 1, minor: 9 })],
      commits: [
        commit("m07-root", "chore: the fork point"),
        commit("m07-2.3.0", "feat: the 2.3 line", {
          parents: ["m07-root"],
          containingRefs: ["2.x"],
        }),
        commit("m07-1.9.0", "feat: the 1.9 line", {
          parents: ["m07-root"],
          containingRefs: ["1.9"],
        }),
        commit("m07-divergent-feat", "feat: the divergent minor", {
          parents: ["m07-1.9.0"],
          containingRefs: ["1.9"],
        }),
        commit("m07-divergent-fix", "fix: the divergent follow-up", {
          parents: ["m07-divergent-feat"],
          containingRefs: ["1.9"],
        }),
      ],
      refs: [ref("2.x", "m07-2.3.0"), ref("1.9", "m07-divergent-fix")],
      tags: [tag("2.3.0", "m07-2.3.0"), tag("1.9.0", "m07-1.9.0")],
      // D17(8) default posture: absent publishes, the one declared
      // component carries the single releasing line (D18).
      components: [component("release-craft", "1.9.0")],
      intents: [{ kind: "release" }],
    });
  }

  it("collects both decisions in input order and assembles only the minting line", () => {
    const outcome = plan(input());
    expect(plannedOf(outcome).decisions.map((record) => record.lineId)).toEqual(["2.x", "1.9"]);
    expect(decisionFor(outcome, "2.x")).toMatchObject({
      kind: "no-op",
      cause: "no-release-worthy-changes",
      range: { lineId: "2.x", releasedUpTo: "m07-2.3.0", head: "m07-2.3.0" },
      ignored: [],
    });
    expect(decisionFor(outcome, "1.9")).toMatchObject({
      kind: "release",
      bump: "minor",
      range: { lineId: "1.9", releasedUpTo: "m07-1.9.0", head: "m07-divergent-fix" },
    });
    const assembled = planLineOf(outcome);
    expect(assembled.lineId).toBe("1.9");
    expect(assembled).toEqual({
      lineId: "1.9",
      stable: { version: "1.10.0", tag: "1.10.0" },
      streams: [],
      changes: [
        { id: "m07-divergent-feat", lineage: ["m07-divergent-feat"], type: "feat", bump: "minor" },
        { id: "m07-divergent-fix", lineage: ["m07-divergent-fix"], type: "fix", bump: "patch" },
      ],
      propagation: { edges: [], order: ["release-craft"], notMoved: [] },
      preconditions: [{ kind: "tag-absent", tag: "1.10.0" }],
      artifacts: ["1.10.0"],
    });
    // The change entries carry each member's own resolved bump (reviewer
    // m-3): the fix is a patch alone — the group winner (the feat's minor)
    // no longer rides on it.
    expect(assembled.changes[1]?.bump).toBe("patch");
  });
});

// ---------------------------------------------------------------------------
// P-06 — two prerelease streams over one target beside the recorded no-op
// ---------------------------------------------------------------------------

describe("P-06 through the door — two streams over one target", () => {
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_P06,
      lines: [line("1.x", "main", { major: 1 })],
      commits: [
        commit("p06-c1", "feat: the 1.2 line", { containingRefs: ["main"] }),
        commit("p06-chore", "chore: note the stream policy", {
          parents: ["p06-c1"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "p06-chore")],
      tags: [tag("1.2.0-alpha.4", "p06-c1")],
      components: [component("release-craft", "1.2.0")],
      intents: [
        { kind: "prerelease", stream: "beta", lineId: "1.x" },
        { kind: "prerelease", stream: "rc", lineId: "1.x" },
      ],
    });
  }

  it("mints beta and rc at the seed over the alpha pointer, stable null (§2.6/§2.8)", () => {
    const outcome = plan(input());
    expect(decisionFor(outcome, "1.x")).toMatchObject({
      kind: "no-op",
      cause: "no-release-worthy-changes",
      ignored: [{ sha: "p06-chore" }],
    });
    const assembled = planLineOf(outcome);
    expect(assembled.lineId).toBe("1.x");
    // A plan minting only prereleases carries no stable target (§2.6), and
    // the no-op decision contributes no change set (§2.11).
    expect(assembled.stable).toBeNull();
    expect(assembled.changes).toEqual([]);
    expect(assembled.streams).toHaveLength(2);
    const [beta, rc] = assembled.streams;
    if (beta === undefined || rc === undefined) {
      throw new Error("fixture broken: both streams must be planned");
    }
    // Fresh keys over target 1.2.0 (the release the alpha pointer points
    // at): both mints start at the policy seed (§2.8, P-02's fresh-key rule)
    // and both advance the pointer past 1.2.0-alpha.4.
    expect(beta).toMatchObject({
      identifier: "beta",
      tag: "1.2.0-beta.0",
      seed: "0",
      pointerBase: "1.2.0-alpha.4",
      movesPointer: true,
    });
    expect(beta.version.equals(Version.parse("1.2.0-beta.0"))).toBe(true);
    expect(rc).toMatchObject({
      identifier: "rc",
      tag: "1.2.0-rc.0",
      seed: "0",
      pointerBase: "1.2.0-alpha.4",
      movesPointer: true,
    });
    expect(rc.version.equals(Version.parse("1.2.0-rc.0"))).toBe(true);
    // Reading 2: the plan-level propagation (no releases → empty edges)
    // rides on the line verbatim; release-craft moved nowhere.
    expect(assembled.propagation).toEqual({
      edges: [],
      order: [],
      notMoved: [{ component: "release-craft", why: "no-reverse-dependency" }],
    });
    expect(plan(input())).toEqual(outcome);
  });

  it("makes every minted tag one precondition and one artifact, in mint order", () => {
    const assembled = planLineOf(plan(input()));
    expect(assembled.preconditions).toEqual([
      { kind: "tag-absent", tag: "1.2.0-beta.0" },
      { kind: "tag-absent", tag: "1.2.0-rc.0" },
    ]);
    expect(assembled.artifacts).toEqual(["1.2.0-beta.0", "1.2.0-rc.0"]);
  });
});

// ---------------------------------------------------------------------------
// PL-02 case 2 — the ambiguous line↔component mapping is refused (D17(8))
// ---------------------------------------------------------------------------

describe("PL-02 case 2 through the door — the ambiguous mapping is refused", () => {
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_PL02,
      lines: [line("1.x", "main", { major: 1 })],
      commits: [
        commit("pl02-c1", "feat: the 1.2 line", { containingRefs: ["main"] }),
        commit("pl02-break", "feat!: break the lib-a surface", {
          parents: ["pl02-c1"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "pl02-break")],
      tags: [tag("1.2.0", "pl02-c1")],
      components: [
        component("lib-a", "1.2.0"),
        component("lib-b", "1.5.0", [{ name: "lib-a", range: "^1.2.0" }]),
        component("app", "1.0.0", [
          { name: "lib-a", range: "^1.2.0" },
          { name: "lib-b", range: "^1.5.0" },
        ]),
      ],
      intents: [{ kind: "release" }],
    });
  }

  it("refuses to fabricate the line↔component release mapping (D17(8))", () => {
    // Three declared components and one releasing line with no declared
    // publishes: the one-component posture cannot carry the release, and
    // the door refuses to fabricate the line↔component release mapping.
    // It raises the caller contract violation naming the binding gap.
    // PL-02's propagation semantics — the range-widening edges this door
    // used to assemble — stay pinned at the direct planPropagation layer in
    // plan.golden.test.ts.
    const attempt = (): PlanningOutcome => plan(input());
    expect(attempt).toThrow(InvalidPlanningInputError);
    expect(attempt).toThrow(/1\.x/);
    expect(attempt).toThrow(/line↔component release mapping/);
  });
});

// ---------------------------------------------------------------------------
// M-08 — the stable-only line: the prerelease request is a recorded
// refusal, the line's own release still mints (D18)
// ---------------------------------------------------------------------------

describe("M-08 through the door — the refused rc beside the stable mint", () => {
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_M08,
      lines: [{ ...line("1.9", "feed/1.9", { major: 1, minor: 9 }), streams: { allow: "none" } }],
      commits: [
        commit("m08-c1", "feat: the 1.9 line", { containingRefs: ["feed/1.9"] }),
        commit("m08-fix", "fix: the stable-only fix", {
          parents: ["m08-c1"],
          containingRefs: ["feed/1.9"],
        }),
      ],
      refs: [ref("feed/1.9", "m08-fix")],
      tags: [tag("1.9.0", "m08-c1")],
      components: [component("release-craft", "1.9.0")],
      intents: [{ kind: "release" }, { kind: "prerelease", stream: "rc", lineId: "1.9" }],
    });
  }

  it("records the refused rc intent while the line's own stable still mints (D18)", () => {
    const outcome = plan(input());
    // M-08's rejection half: the rc request on the stable-only line is a
    // recorded refusal naming the declared posture — never an exception,
    // never a stable fallback.
    expect(decisionFor(outcome, "1.9")).toMatchObject({
      kind: "release",
      bump: "patch",
      range: { lineId: "1.9", releasedUpTo: "m08-c1", head: "m08-fix" },
    });
    const assembled = plannedOf(outcome).plan;
    expect(assembled.refusedIntents).toEqual([
      {
        intent: { kind: "prerelease", stream: "rc", lineId: "1.9" },
        lineId: "1.9",
        reason: `line 1.9 is stable-only — the line's declared stream policy admits no prerelease streams (D18)`,
      },
    ]);
    // M-08's release half: the refusal changes nothing else in the plan —
    // 1.9.1 mints in the same pass and no stream is planned for the line.
    const minted = planLineOf(outcome);
    expect(minted.lineId).toBe("1.9");
    expect(minted.stable).toEqual({ version: "1.9.1", tag: "1.9.1" });
    expect(minted.streams).toEqual([]);
    expect(minted.changes).toEqual([
      { id: "m08-fix", lineage: ["m08-fix"], type: "fix", bump: "patch" },
    ]);
    expect(minted.propagation).toEqual({
      edges: [],
      order: ["release-craft"],
      notMoved: [],
    });
    // §2.14: the door is pure — identical inputs, identical whole outcome.
    expect(plan(input())).toEqual(outcome);
  });
});

// ---------------------------------------------------------------------------
// D18 §2.8 — the allow-list posture: a listed identifier is a declaration
// that mints; an unlisted one is the recorded refusal
// ---------------------------------------------------------------------------

describe("D18 §2.8 through the door — the allow-list posture", () => {
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_D18_LIST,
      lines: [{ ...line("1.x", "main", { major: 1 }), streams: { allow: ["beta"] } }],
      commits: [
        commit("lst-c1", "feat: the 1.2 line", { containingRefs: ["main"] }),
        commit("lst-fix", "fix: the joining fix", {
          parents: ["lst-c1"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "lst-fix")],
      tags: [tag("1.2.0", "lst-c1")],
      components: [component("release-craft", "1.2.0")],
      intents: [
        { kind: "prerelease", stream: "rc", lineId: "1.x" },
        { kind: "prerelease", stream: "beta", lineId: "1.x" },
      ],
    });
  }

  it("refuses the unlisted rc demand and mints the declared beta stream", () => {
    const outcome = plan(input());
    const assembled = plannedOf(outcome).plan;
    // The rc demand sits outside the declared allow list — one record,
    // naming the list; the beta demand is a declaration, so no record.
    expect(assembled.refusedIntents).toEqual([
      {
        intent: { kind: "prerelease", stream: "rc", lineId: "1.x" },
        lineId: "1.x",
        reason: `line 1.x's declared allow list ("beta") does not admit prerelease stream "rc" (D18)`,
      },
    ]);
    // The admissible beta demand suppresses the stable co-mint (D17(3)) and
    // mints at the would-be stable target: the stream is the publication.
    expect(decisionFor(outcome, "1.x")).toMatchObject({ kind: "release", bump: "patch" });
    const minted = planLineOf(outcome);
    expect(minted.stable).toBeNull();
    expect(minted.changes).toEqual([
      { id: "lst-fix", lineage: ["lst-fix"], type: "fix", bump: "patch" },
    ]);
    expect(minted.streams.map((stream) => stream.identifier)).toEqual(["beta"]);
    const stream = minted.streams[0];
    if (stream === undefined) {
      throw new Error("fixture broken: the beta stream must be planned");
    }
    expect(stream.tag).toBe("1.2.1-beta.0");
    expect(minted.propagation.order).toEqual(["release-craft"]);
    expect(plan(input())).toEqual(outcome);
  });
});

// ---------------------------------------------------------------------------
// D18 Decision 4 — the declared publishes binding dissolves the D17(8)
// refusal exactly where every releasing line declares it
// ---------------------------------------------------------------------------

describe("D18 Decision 4 through the door — the declared publishes binding", () => {
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_D18_BIND,
      lines: [
        { ...line("1.x", "main", { major: 1 }), publishes: "lib-a" },
        { ...line("2.x", "next", { major: 2 }), publishes: "lib-b" },
      ],
      commits: [
        commit("bnd-c1", "feat: the 1.x line", { containingRefs: ["main"] }),
        commit("bnd-minor", "feat: the 1.x feature", {
          parents: ["bnd-c1"],
          containingRefs: ["main"],
        }),
        commit("bnd-c2", "feat: the 2.x line", { containingRefs: ["next"] }),
        commit("bnd-break", "feat!: break the lib-b surface", {
          parents: ["bnd-c2"],
          containingRefs: ["next"],
        }),
      ],
      refs: [ref("main", "bnd-minor"), ref("next", "bnd-break")],
      tags: [tag("1.2.0", "bnd-c1"), tag("2.0.0", "bnd-c2")],
      components: [
        component("lib-a", "1.2.0"),
        component("lib-b", "2.0.0", [{ name: "lib-a", range: "^1.2.0" }]),
        component("app", "1.0.0", [
          { name: "lib-a", range: "^1.2.0" },
          { name: "lib-b", range: "^2.0.0" },
        ]),
      ],
      intents: [{ kind: "release" }],
    });
  }

  it("assembles two releasing lines bound to two declared components", () => {
    const outcome = plan(input());
    const assembled = plannedOf(outcome).plan;
    // The dissolved D17(8) refusal: two releasing lines, each declaring its
    // binding — the mapping is closed input, the plan assembles both mints.
    expect(assembled.lines.map((entry) => entry.lineId)).toEqual(["1.x", "2.x"]);
    const [first, second] = assembled.lines;
    if (first === undefined || second === undefined) {
      throw new Error("fixture broken: both lines must assemble");
    }
    expect(decisionFor(outcome, "1.x")).toMatchObject({ kind: "release", bump: "minor" });
    expect(decisionFor(outcome, "2.x")).toMatchObject({ kind: "release", bump: "major" });
    expect(first.stable).toEqual({ version: "1.3.0", tag: "1.3.0" });
    expect(second.stable).toEqual({ version: "3.0.0", tag: "3.0.0" });
    // Both entries flowed into the one plan-level propagation: lib-b's
    // breaking 3.0.0 widens app's ^2.0.0, while lib-a's minor 1.3.0 stays
    // inside every ^1.2.0. Both releases are ordered nodes; app is widened.
    expect(first.propagation).toEqual({
      edges: [{ from: "lib-b", to: "app", reason: "range-widening" }],
      order: ["lib-a", "lib-b", "app"],
      notMoved: [],
    });
    expect(second.propagation).toEqual(first.propagation);
    expect(plan(input())).toEqual(outcome);
  });

  it("keeps the D17(8) refusal when the multi-component world lacks the binding", () => {
    const world = input();
    const stripped = {
      ...world,
      lines: world.lines.map((config) => {
        if (config.id !== "2.x") {
          return config;
        }
        const { publishes: _omit, ...rest } = config;
        return rest;
      }),
    };
    // The declaration is the dissolve: where it is missing in a world the
    // one-component posture cannot carry, the door refuses with the same
    // exception, naming the line and the binding gap.
    const attempt = (): PlanningOutcome => plan(stripped);
    expect(attempt).toThrow(InvalidPlanningInputError);
    expect(attempt).toThrow(/2\.x/);
    expect(attempt).toThrow(/publishes/);
    expect(attempt).toThrow(/line↔component release mapping/);
  });

  it("refuses two releasing lines binding the same declared component", () => {
    const world = input();
    const clashing = {
      ...world,
      lines: world.lines.map((config) => ({ ...config, publishes: "lib-a" })),
    };
    // A declared component carries one release per pass: two lines on one
    // component is the ambiguous mapping, named with both lines.
    const attempt = (): PlanningOutcome => plan(clashing);
    expect(attempt).toThrow(InvalidPlanningInputError);
    expect(attempt).toThrow(/"1\.x"/);
    expect(attempt).toThrow(/"2\.x"/);
    expect(attempt).toThrow(/"lib-a"/);
  });

  it("refuses a binding naming an undeclared component", () => {
    // The undeclared name never reaches the binding resolution: input
    // normalization's closed component universe refuses it first, through
    // the same exception, naming the gap.
    const world = input();
    const stray = {
      ...world,
      lines: world.lines.map((config) => ({ ...config, publishes: "ghost" })),
    };
    const attempt = (): PlanningOutcome => plan(stray);
    expect(attempt).toThrow(InvalidPlanningInputError);
    expect(attempt).toThrow(/"ghost"/);
    expect(attempt).toThrow(/undeclared component/);
  });
});

// ---------------------------------------------------------------------------
// D18's zero-declaration path — the single-component posture without
// publishes is bit-for-bit today's behavior
// ---------------------------------------------------------------------------

describe("the single-component posture through the door — absent publishes unchanged", () => {
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_D18_SOLO,
      lines: [line("1.x", "main", { major: 1 })],
      commits: [
        commit("solo-c1", "feat: the 1.2 line", { containingRefs: ["main"] }),
        commit("solo-fix", "fix: the solo patch", {
          parents: ["solo-c1"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "solo-fix")],
      tags: [tag("1.2.0", "solo-c1")],
      components: [component("release-craft", "1.2.0")],
      intents: [{ kind: "release" }],
    });
  }

  it("carries the release on the one declared component with nothing declared (D18)", () => {
    const outcome = plan(input());
    const assembled = plannedOf(outcome).plan;
    // Absent publishes keeps the D17(8) posture: the single declared
    // component carries the release, and no refusal is recorded.
    expect(assembled.refusedIntents).toEqual([]);
    const minted = planLineOf(outcome);
    expect(minted.lineId).toBe("1.x");
    expect(minted.stable).toEqual({ version: "1.2.1", tag: "1.2.1" });
    expect(minted.propagation).toEqual({
      edges: [],
      order: ["release-craft"],
      notMoved: [],
    });
  });
});

// ---------------------------------------------------------------------------
// D18 Decision 2 — the lifecycle refusal: a refused line contributes no
// plan line through the same path as any refused decision
// ---------------------------------------------------------------------------

describe("D18 lifecycle through the door — the retired line's refused record", () => {
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_D18_REFUSED,
      lines: [
        { ...line("1.x", "main", { major: 1 }), lifecycle: "retired" },
        line("2.x", "next", { major: 2 }),
      ],
      commits: [
        commit("life-c1", "feat: the 1.x line", { containingRefs: ["main"] }),
        commit("life-fix", "fix: late work on the retired line", {
          parents: ["life-c1"],
          containingRefs: ["main"],
        }),
        commit("life-c2", "feat: the 2.x line", { containingRefs: ["next"] }),
        commit("life-feat", "feat: the 2.x feature", {
          parents: ["life-c2"],
          containingRefs: ["next"],
        }),
      ],
      refs: [ref("main", "life-fix"), ref("next", "life-feat")],
      tags: [tag("1.0.0", "life-c1"), tag("2.0.0", "life-c2")],
      components: [component("release-craft", "2.0.0")],
      intents: [{ kind: "release" }],
    });
  }

  it("gives the retired line a refused record, no plan line beside the mint", () => {
    const outcome = plan(input());
    // D18 decision 2: release-shaped planning refuses on the retired line —
    // the record stands on the decisions, the plan assembles nothing for
    // the line, and the active line's mint is unaffected.
    expect(decisionFor(outcome, "1.x")).toMatchObject({
      kind: "refused",
      cause: "line-retired",
      lineId: "1.x",
      policyDigest: DIGEST_D18_REFUSED,
    });
    const assembled = plannedOf(outcome).plan;
    expect(assembled.lines.map((entry) => entry.lineId)).toEqual(["2.x"]);
    const minted = assembled.lines[0];
    if (minted === undefined) {
      throw new Error("fixture broken: the active line must assemble");
    }
    expect(minted.stable).toEqual({ version: "2.1.0", tag: "2.1.0" });
    expect(assembled.refusedIntents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D18 Decision 3 — the withhold deferral: a withheld line contributes no
// plan line, the record enumerates the deferred set
// ---------------------------------------------------------------------------

describe("D18 withhold through the door — the deferred line's withheld record", () => {
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_D18_WITHHELD,
      lines: [
        {
          ...line("1.x", "main", { major: 1 }),
          withhold: [{ scope: "security", reason: "pending CVE triage" }],
        },
      ],
      commits: [
        commit("wh-c1", "feat: the 1.2 line", { containingRefs: ["main"] }),
        commit("wh-fix", "fix(security): the deferred fix", {
          parents: ["wh-c1"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "wh-fix")],
      tags: [tag("1.2.0", "wh-c1")],
      intents: [{ kind: "release" }],
    });
  }

  it("gives the withheld line a record and no plan line (D18 decision 3)", () => {
    const outcome = plan(input());
    // PL-07 through the door: the matching change defers, never deletes —
    // the record enumerates it and the line left with nothing
    // release-worthy assembles no plan line.
    expect(decisionFor(outcome, "1.x")).toMatchObject({
      kind: "withheld",
      cause: "policy-filter",
      lineId: "1.x",
      policyDigest: DIGEST_D18_WITHHELD,
      withheld: [{ sha: "wh-fix" }],
    });
    expect(plannedOf(outcome).plan.lines).toEqual([]);
    expect(plannedOf(outcome).plan.refusedIntents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// P-03 — the promote intent across a zero diff
// ---------------------------------------------------------------------------

describe("P-03 through the door — the promote intent over the in-flight rc", () => {
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_P03,
      lines: [line("1.x", "main")],
      commits: [commit("p03-c1", "feat: the 1.2 line", { containingRefs: ["main"] })],
      refs: [ref("main", "p03-c1")],
      tags: [tag("1.2.0-rc.2", "p03-c1")],
      components: [component("release-craft", "1.2.0")],
      intents: [{ kind: "promote", lineId: "1.x" }],
    });
  }

  it("promotes the pointed-at release — stable bumpPatch of the rc pointer, no change set", () => {
    const outcome = plan(input());
    // D17(4): a promote over an in-flight prerelease is a release decision
    // with an inherited (empty) change set and bump null — the change set is
    // the stream's, nothing was resolved from pending (the evaluated range
    // is empty: the rc tag and main's head are the same commit).
    expect(decisionFor(outcome, "1.x")).toMatchObject({
      kind: "release",
      bump: null,
      range: { lineId: "1.x", releasedUpTo: "p03-c1", head: "p03-c1" },
    });
    // The target is the pointed-at release: bumpPatch over 1.2.0-rc.2 is
    // 1.2.0 (SemVer §11.3). One releasing line meets one declared component
    // (D17(8)), so the propagation plan maps it without negative evidence.
    // ADR-0012 decision 2: the promote names its planned channel
    // transitions even with no channels declared — the promoted-from edge
    // (1.2.0-rc.2 → 1.2.0) and the promoted stream's close (rc on 1.2.0);
    // no channel move can be named for an undeclared registry.
    expect(planLineOf(outcome)).toEqual({
      lineId: "1.x",
      stable: { version: "1.2.0", tag: "1.2.0" },
      streams: [],
      changes: [],
      propagation: { edges: [], order: ["release-craft"], notMoved: [] },
      preconditions: [{ kind: "tag-absent", tag: "1.2.0" }],
      artifacts: ["1.2.0"],
      channels: [
        { kind: "promoted-from", from: "1.2.0-rc.2", to: { line: "1.x", version: "1.2.0" } },
        { kind: "stream-close", stream: "rc", target: "1.2.0" },
      ],
    });
    // §2.14: the door is pure — identical inputs, identical whole outcome.
    expect(plan(input())).toEqual(outcome);
  });
});

// ---------------------------------------------------------------------------
// P-07 — the joining fix while the rc is in flight: the stream is the
// publication
// ---------------------------------------------------------------------------

describe("P-07 through the door — the suppressed stable publishes the component at the stream target", () => {
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_P07,
      lines: [line("1.x", "main")],
      commits: [
        commit("p07-c1", "fix: the released base", { containingRefs: ["main"] }),
        commit("p07-c2", "fix: the joining fix", {
          parents: ["p07-c1"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "p07-c2")],
      tags: [tag("1.2.3", "p07-c1"), tag("1.2.4-rc.1", "p07-c1")],
      components: [component("release-craft", "1.2.3")],
      intents: [{ kind: "release" }, { kind: "prerelease", stream: "rc", lineId: "1.x" }],
    });
  }

  it("releases through the stream only — stable suppressed, component mapped at the rc target", () => {
    const outcome = plan(input());
    // D17(2)'s equal-precedence case (P-04): the fix recomputes 1.2.4 from
    // the 1.2.3 stable base and the in-flight target bumpPatch(1.2.4-rc.1)
    // is 1.2.4 — equal, so the target and its sequence stand (rc.2). D17(3):
    // the prerelease intent suppresses the stable co-mint, and D17(8) still
    // counts the line as a publication: the component's release entry is
    // the stream's target, not an empty list silently propagated.
    expect(decisionFor(outcome, "1.x")).toMatchObject({
      kind: "release",
      bump: "patch",
      range: { lineId: "1.x", releasedUpTo: "p07-c1", head: "p07-c2" },
    });
    const assembled = planLineOf(outcome);
    expect(assembled.stable).toBe(null);
    const stream = assembled.streams[0];
    if (stream === undefined) {
      throw new Error("fixture broken: the rc stream must be planned");
    }
    expect(stream.identifier).toBe("rc");
    expect(stream.version.equals(Version.parse("1.2.4-rc.2"))).toBe(true);
    expect(stream.tag).toBe("1.2.4-rc.2");
    expect(assembled.changes).toEqual([
      { id: "p07-c2", lineage: ["p07-c2"], type: "fix", bump: "patch" },
    ]);
    expect(assembled.propagation).toEqual({
      edges: [],
      order: ["release-craft"],
      notMoved: [],
    });
    expect(assembled.preconditions).toEqual([{ kind: "tag-absent", tag: "1.2.4-rc.2" }]);
    expect(assembled.artifacts).toEqual(["1.2.4-rc.2"]);
    // §2.14: the door is pure — identical inputs, identical whole outcome.
    expect(plan(input())).toEqual(outcome);
  });
  it("mints every demanded stream and maps the line once — the highest stream is the release entry", () => {
    // D17(8)'s recorded pick rule: several streams on one releasing line
    // mint in full, and the component's single release entry carries the
    // highest target by precedence (rc.1 over beta.2). With exactly one
    // declared component the picked version is not observable in the
    // propagation shape — it becomes observable with the binding
    // (PR-6/PR-7) — so this pin guards the observable half: no refusal,
    // both streams planned, one propagation mapping.
    const world = buildInput({
      digest: DIGEST_P07,
      lines: [line("1.x", "main")],
      commits: [
        commit("p07-c1", "fix: the released base", { containingRefs: ["main"] }),
        commit("p07-c2", "fix: the joining fix", {
          parents: ["p07-c1"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "p07-c2")],
      tags: [tag("1.2.3", "p07-c1"), tag("1.2.4-beta.1", "p07-c1")],
      components: [component("release-craft", "1.2.3")],
      // Fork 17's declared-seed world (M-08/E-08 declare `.1`): the
      // pointer is the beta.1 stream, so both demanded streams legally
      // mint at or above it (D10) — rc.1 fresh and beta.2 continuing.
      policy: { ...policy(DIGEST_P07), prereleaseSeed: "1" },
      intents: [
        { kind: "release" },
        { kind: "prerelease", stream: "rc", lineId: "1.x" },
        { kind: "prerelease", stream: "beta", lineId: "1.x" },
      ],
    });
    const outcome = plan(world);
    const assembled = planLineOf(outcome);
    expect(assembled.stable).toBe(null);
    expect(assembled.streams.map((stream) => stream.tag)).toEqual(["1.2.4-rc.1", "1.2.4-beta.2"]);
    expect(assembled.propagation).toEqual({
      edges: [],
      order: ["release-craft"],
      notMoved: [],
    });
  });
});

// ---------------------------------------------------------------------------
// release-anyway — the forced record, nothing minted
// ---------------------------------------------------------------------------

describe("the release-anyway intent through the door — the forced record", () => {
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_FORCED,
      lines: [line("1.x", "main", { major: 1 })],
      commits: [
        commit("f-c1", "feat: the 1.0 line", { containingRefs: ["main"] }),
        commit("f-chore", "chore: the quiet runway", {
          parents: ["f-c1"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "f-chore")],
      tags: [tag("1.0.0", "f-c1")],
      intents: [{ kind: "release-anyway" }],
    });
  }

  it("records the forced decision and mints no line, no artifact (D17(5))", () => {
    const outcome = plan(input());
    // D17(5): "recorded as operator-forced, never as a routine release" —
    // the forced mint is declared-policy territory, so the pure door
    // assembles no PlanLine for it: no stable target, no streams, no
    // artifacts, and no components are declared to map.
    expect(decisionFor(outcome, "1.x")).toMatchObject({
      kind: "forced",
      cause: "release-anyway",
      lineId: "1.x",
      policyDigest: DIGEST_FORCED,
    });
    expect(plannedOf(outcome).plan.lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D17(6) — the explanation data: foreign tags, conflicts, excluded commits
// ---------------------------------------------------------------------------

describe("the explanation data through the door — excluded is not invisible", () => {
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_EXPLAIN,
      lines: [line("1.x", "main", { major: 1 })],
      commits: [
        commit("x1-c1", "feat: the 1.2 line", { containingRefs: ["main"] }),
        commit("x1-c2", "just some prose, no conventional header", {
          parents: ["x1-c1"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "x1-c2")],
      tags: [tag("1.1.0", "x1-c1"), tag("2.0.0", "x1-c1")],
    });
  }

  it("surfaces the foreign tag and the excluded commit on the plan", () => {
    const outcome = plan(input());
    const assembled = plannedOf(outcome).plan;
    // D17(6)/§2.13/E-06: the 2.0.0 tag is outside line "1.x"'s declared band
    // (major 1) — surfaced verbatim, in input tag order; the prose commit is
    // unparseable — surfaced with its rule; no identity conflicts exist and
    // the field is still present, empty.
    expect(assembled.explanation.foreignTags).toEqual([
      {
        name: "2.0.0",
        commit: "x1-c1",
        detail: `version 2.0.0 is outside line "1.x"'s declared band (major 1)`,
      },
    ]);
    expect(assembled.explanation.conflicts).toEqual([]);
    expect(assembled.explanation.excluded[0]).toMatchObject({
      sha: "x1-c2",
      rule: "unparseable",
    });
    expect(assembled.explanation.excluded[0]?.detail).toBeTypeOf("string");
    // The no-op decision stands beside the surfaced data: the prose commit
    // never reached the decision at all — extraction excluded it from the
    // pending set, so the decision's own ignored list is empty and the
    // explanation is the only place the exclusion is visible (E-06's
    // invisible-no-more).
    expect(decisionFor(outcome, "1.x")).toMatchObject({
      kind: "no-op",
      cause: "no-release-worthy-changes",
      ignored: [],
    });
  });

  it("changes the planId when the explanation changes — the fingerprint covers it", () => {
    const assembled = plannedOf(plan(input())).plan;
    expect(assembled.explanation.foreignTags).toHaveLength(1);
    // §2.11: the fingerprint input is the closed tuple — explanation among
    // the plan's semantic fields. Two plans differing only in their
    // explanation data fingerprint differently: hashing the tuple with the
    // explanation emptied must not reproduce the planId.
    // D18: the tuple is built from the assembled plan's own fields — a
    // spread, so a future tuple field cannot drift out of this pin.
    const { planId: _omit, ...tuple } = assembled;
    expect(assembled.planId).toBe(planFingerprint(tuple));
    const stripped = {
      ...tuple,
      explanation: { foreignTags: [], conflicts: [], excluded: [], withheld: [] },
    };
    expect(assembled.planId).not.toBe(planFingerprint(stripped));
  });
});

// ---------------------------------------------------------------------------
// E-04 — §2.14: double-run equality, one-field flip, fingerprint form
// ---------------------------------------------------------------------------

describe("E-04 through the door — determinism and identity", () => {
  function input(digest: string, seed: "0" | "1"): PlanningInput {
    return buildInput({
      digest,
      lines: [line("1.x", "main", { major: 1 })],
      commits: [
        commit("e04-c1", "feat: the 1.4 line", { containingRefs: ["main"] }),
        commit("e04-c2", "feat: export the metrics API", {
          parents: ["e04-c1"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "e04-c2")],
      tags: [tag("1.4.2", "e04-c1")],
      components: [component("release-craft", "1.4.2")],
      policy: { ...policy(digest), prereleaseSeed: seed },
      intents: [{ kind: "release" }],
    });
  }

  it("is double-run equal — the whole outcome, planId included (§2.14)", () => {
    const outcome = plan(input(DIGEST_E04, "0"));
    expect(plan(input(DIGEST_E04, "0"))).toEqual(outcome);
    const first = plannedOf(outcome).plan;
    const second = plannedOf(plan(input(DIGEST_E04, "0"))).plan;
    expect(first.planId).toBe(second.planId);
    expect(first.inputsFingerprint).toBe(second.inputsFingerprint);
    expect(first.planId).toMatch(/^plan_sha256:[0-9a-f]{64}$/);
    expect(first.inputsFingerprint).toMatch(/^inputs_sha256:[0-9a-f]{64}$/);
  });

  it("recognizes a one-field flip by the fingerprints, not the versions", () => {
    const before = plannedOf(plan(input(DIGEST_E04, "0"))).plan;
    const after = plannedOf(plan(input(DIGEST_E04_AMENDED, "1"))).plan;
    expect(after.inputsFingerprint).not.toBe(before.inputsFingerprint);
    expect(after.planId).not.toBe(before.planId);
    // The targets coincide — the flip lives in the identity, not the bump.
    expect(after.lines[0]?.stable).toEqual(before.lines[0]?.stable);
  });
});

// ---------------------------------------------------------------------------
// E-11 — same resulting version, different change identity, different planId
// ---------------------------------------------------------------------------

describe("E-11 through the door — same version, different plan", () => {
  function input(changeShas: readonly [string, string]): PlanningInput {
    return buildInput({
      digest: DIGEST_E11,
      lines: [line("1.x", "main", { major: 1 })],
      commits: [
        commit("e11-c1", "feat: the 1.4 line", { containingRefs: ["main"] }),
        commit(changeShas[0], "feat: the first improvement", {
          parents: ["e11-c1"],
          containingRefs: ["main"],
        }),
        commit(changeShas[1], "feat: the second improvement", {
          parents: [changeShas[0]],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", changeShas[1])],
      tags: [tag("1.4.2", "e11-c1")],
      components: [component("release-craft", "1.4.2")],
      intents: [{ kind: "release" }],
    });
  }

  it("keeps the plan's identity bound to the change set, not the version", () => {
    const outcomeA = plan(input(["e11-a2", "e11-a3"]));
    const outcomeB = plan(input(["e11-b2", "e11-b3"]));
    const assembledA = planLineOf(outcomeA);
    const assembledB = planLineOf(outcomeB);
    expect(assembledA.stable).toEqual({ version: "1.5.0", tag: "1.5.0" });
    expect(assembledB.stable).toEqual({ version: "1.5.0", tag: "1.5.0" });
    expect(assembledA.changes.map((change) => change.id)).toEqual(["e11-a2", "e11-a3"]);
    expect(assembledB.changes.map((change) => change.id)).toEqual(["e11-b2", "e11-b3"]);
    expect(plannedOf(outcomeA).plan.planId).not.toBe(plannedOf(outcomeB).plan.planId);
  });
});

// ---------------------------------------------------------------------------
// §2.4 fail-closed — the ambiguous-attribution refusal leaks nothing else
// ---------------------------------------------------------------------------

describe("the ambiguous-attribution refusal through the door", () => {
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_REFUSED,
      lines: [line("l1", "feed/1"), line("l2", "feed/2"), line("l3", "feed/3")],
      commits: [
        commit("sha-shared", "fix: the shared fix"),
        commit("sha-a", "chore: line a work", { parents: ["sha-shared"] }),
        commit("sha-b", "chore: line b work", { parents: ["sha-shared"] }),
        commit("sha-c", "chore: line c work", { parents: ["sha-shared"] }),
      ],
      refs: [ref("feed/1", "sha-a"), ref("feed/2", "sha-b"), ref("feed/3", "sha-c")],
    });
  }

  it("refuses with the shared commit and no plan, no decisions, no partial state", () => {
    const outcome = plan(input());
    if (outcome.kind !== "refused") {
      throw new Error(`fixture broken: expected a refusal, got ${outcome.kind}`);
    }
    // Nothing else leaks: no plan key, no decisions key.
    expect(Object.keys(outcome).sort()).toEqual(["kind", "refusal"]);
    expect(outcome.refusal.cause).toBe("ambiguous-attribution");
    expect(outcome.refusal.commits).toEqual(["sha-shared"]);
    expect(outcome.refusal.policyDigest).toBe(DIGEST_REFUSED);
    expect(Object.keys(outcome.refusal).sort()).toEqual([
      "cause",
      "commits",
      "detail",
      "kind",
      "policyDigest",
    ]);
  });
});
