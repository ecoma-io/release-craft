/**
 * End-to-end golden scenarios for the PR-4 planning layer — P-01, P-02, P-04,
 * P-05, P-06, P-07, PL-01, PL-02, PL-03, E-04, E-11 and an M-08-style
 * main-line case of docs/design/release-scenarios.md, pinned at the layer
 * this PR owns: line
 * state rebuild (§2.13), targets and streams (§2.6–§2.8), dependency
 * propagation (§2.15) and plan identity (§2.10–§2.11, §2.14; decision-log
 * D9/D10/D12/D13/D16, forks 11 and 17).
 *
 * Where the PR-3 golden file stops at the decision record, every test here
 * composes the real modules one stage further — normalize → extract →
 * loadTagHistory → deriveRanges → attribute → decideLine → rebuildLineState →
 * planTargets/planStreams → planPropagation → planFingerprint /
 * inputsFingerprint — so the scenarios pin exactly the planning layer's
 * outputs. §2.14: the planner is pure, so each scenario re-runs its world and
 * requires equality; E-04 pins the fingerprint form of that contract.
 *
 * Fixture posture mirrors scenario.golden.test.ts and
 * attribute.adversarial.test.ts: opaque per-scenario policy digests, the
 * default bump mapping, the alpha→beta→rc ladder, prereleaseSeed "0" (D13:
 * the P-01/P-02/P-04/P-05/P-06/P-07 fixtures take the kernel default; only
 * the M-08-style fixture declares the ".1" policy) and the
 * "Release-Craft:" self-reference namespace.
 */
import { describe, expect, it } from "vitest";

import { Version } from "@ecoma-io/release-craft/domain";

import { attribute } from "../../src/planner/attribute.js";
import { decideLine, resolveBump } from "../../src/planner/decide.js";
import { extract } from "../../src/planner/extract.js";
import { deriveRanges, loadTagHistory } from "../../src/planner/history.js";
import { canonicalJson, inputsFingerprint, planFingerprint } from "../../src/planner/identity.js";
import { normalize } from "../../src/planner/input.js";
import { planStreams, planTargets } from "../../src/planner/plan.js";
import { planPropagation } from "../../src/planner/propagate.js";
import { rebuildLineState } from "../../src/planner/state.js";
import type {
  BootstrapDecision,
  CommitObservation,
  ComponentMeta,
  LineAttribution,
  LineConfig,
  LineDecision,
  LineHistory,
  LineRange,
  LineState,
  OperatorIntent,
  PlanningInput,
  PlanLine,
  PolicyInput,
  RefObservation,
  ReleasePlan,
  TagHistoryResult,
  TagObservation,
} from "../../src/planner/types.js";

// ---------------------------------------------------------------------------
// Fixture builders — deterministic, closed inputs per §2.1, mirroring the
// scenario.golden.test.ts idiom
// ---------------------------------------------------------------------------

const COMMITTED_AT = "2026-01-01T00:00:00Z";

/** One fixed digest per scenario — opaque content identity (invariant 4). */
const DIGEST_P01 = "sha256:" + "e".repeat(64);
const DIGEST_P02 = "sha256:" + "f".repeat(64);
const DIGEST_P05 = "sha256:" + "g".repeat(64);
const DIGEST_P06 = "sha256:" + "h".repeat(64);
const DIGEST_P07 = "sha256:" + "i".repeat(64);
const DIGEST_P04 = "sha256:" + "p".repeat(64);
const DIGEST_M08 = "sha256:" + "q".repeat(64);
const DIGEST_PL01 = "sha256:" + "j".repeat(64);
const DIGEST_PL02 = "sha256:" + "k".repeat(64);
const DIGEST_PL03 = "sha256:" + "l".repeat(64);
const DIGEST_E04 = "sha256:" + "m".repeat(64);
const DIGEST_E04_AMENDED = "sha256:" + "n".repeat(64);
const DIGEST_E11 = "sha256:" + "o".repeat(64);

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
  if (versionBand === undefined) return config;
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
// The composition under test — the real modules, one pass through the PR-3
// boundary and one stage further into the planning layer. Purity is §2.14's
// determinism contract, so each scenario re-runs its world and requires
// equality; E-04 pins the fingerprint form of that contract.
// ---------------------------------------------------------------------------

interface PlannedWorld {
  readonly input: PlanningInput;
  readonly history: TagHistoryResult;
  readonly ranges: readonly LineRange[];
  readonly attributions: readonly LineAttribution[];
  readonly decisions: readonly LineDecision[];
}

function planDecisions(raw: PlanningInput): PlannedWorld {
  const input = normalize(raw);
  const extraction = extract(input.repository.commits, input.policy);
  const history = loadTagHistory(input.history.tags, input.lines, input.policy);
  const ranges = deriveRanges(history, input.repository.refs, input.lines);
  const outcome = attribute(extraction, input, ranges);
  if (outcome.kind !== "attributed") {
    throw new Error(`fixture broken: attribution refused — ${outcome.refusal.cause}`);
  }
  const decisions = outcome.lines.map((attribution) => {
    const range = ranges.find((candidate) => candidate.lineId === attribution.lineId);
    if (range === undefined) {
      throw new Error(`fixture broken: line ${attribution.lineId} has no derived range`);
    }
    return decideLine(attribution, input, range);
  });
  return { input, history, ranges, attributions: outcome.lines, decisions };
}

function historyFor(world: PlannedWorld, lineId: string): LineHistory {
  const found = world.history.lines.find((candidate) => candidate.lineId === lineId);
  if (found === undefined) {
    throw new Error(`fixture broken: line ${lineId} missing from history projection`);
  }
  return found;
}

function decisionFor(world: PlannedWorld, lineId: string): LineDecision {
  const found = world.decisions.find((candidate) => candidate.lineId === lineId);
  if (found === undefined) {
    throw new Error(`fixture broken: line ${lineId} has no decision record`);
  }
  return found;
}

function lineFor(world: PlannedWorld, lineId: string): LineConfig {
  const found = world.input.lines.find((candidate) => candidate.id === lineId);
  if (found === undefined) {
    throw new Error(`fixture broken: line ${lineId} missing from the input`);
  }
  return found;
}

/** §2.13: state is always rebuilt from the projected history, never carried. */
function stateFor(world: PlannedWorld, lineId: string): LineState {
  return rebuildLineState(historyFor(world, lineId));
}

/** The line's planned targets from the frozen §2.6/§2.7 door, over the
 * scenario's own intents. */
function targetsFor(world: PlannedWorld, lineId: string) {
  return planTargets(
    world.input.intents ?? [],
    decisionFor(world, lineId),
    stateFor(world, lineId),
    lineFor(world, lineId),
    world.input.policy,
  );
}

/** The line's would-be stable target with the intents stripped — the
 * D17(3)-unsuppressed view the prerelease streams run toward. */
function wouldBeStableFor(world: PlannedWorld, lineId: string): string | null {
  const bare = planTargets(
    [],
    decisionFor(world, lineId),
    stateFor(world, lineId),
    lineFor(world, lineId),
    world.input.policy,
  );
  return bare.stable?.version.toString() ?? null;
}

/** §2.8: streams answer the operator's prerelease intents for one line. The
 * single planStreams callsite in this file — every scenario goes through it. */
function streamsFor(world: PlannedWorld, lineId: string, intents: readonly OperatorIntent[]) {
  const decision = decisionFor(world, lineId);
  return planStreams(
    intents,
    decision,
    stateFor(world, lineId),
    lineFor(world, lineId),
    world.input.policy,
  );
}

/** PlanLine assembly (§2.11's closed tuple) from the layer's outputs — the
 * deterministic mapping an integrator performs. Change entries carry the
 * decided inputs: kernel id, recorded lineage chain, type, own bump. */
function planLineOf(world: PlannedWorld, lineId: string): PlanLine {
  const decision = decisionFor(world, lineId);
  if (decision.kind !== "release") {
    throw new Error(`fixture broken: line ${lineId} has no release decision to assemble`);
  }
  const target = targetsFor(world, lineId);
  if (target.stable === null) {
    throw new Error(`fixture broken: line ${lineId} assembled without a stable target`);
  }
  const components = world.input.components ?? [];
  const changes = decision.changes.map((parsed) => {
    const bump = resolveBump([parsed], world.input.policy);
    if (bump === undefined) {
      throw new Error(`fixture broken: contributing change ${parsed.sha} resolves to no bump`);
    }
    return {
      id: parsed.change?.id ?? parsed.sha,
      lineage: [parsed.change?.lineage.originCommit ?? parsed.sha],
      type: parsed.type ?? "untyped",
      bump,
    };
  });
  return {
    lineId,
    stable: { version: target.stable.version.toString(), tag: target.stable.tag },
    streams: target.streams,
    changes,
    propagation: planPropagation(components, [
      { component: "release-craft", version: target.stable.version },
    ]),
    preconditions: [{ kind: "tag-absent", tag: target.stable.tag }],
    artifacts: [],
  };
}

// ---------------------------------------------------------------------------
// P-01 — alpha increments: lexicographic order lies (the stream head alpha.9
// must mint alpha.10 numerically; SemVer §11.4)
// ---------------------------------------------------------------------------

describe("P-01: alpha increments — the numeric successor of alpha.9", () => {
  // Stated initial state: main; tag 1.2.0-alpha.9 published; manifest 1.1.7
  // (a projection — never consumed as truth, invariant 6/S-03). Inputs: one
  // fix; intent "continue the alpha stream".
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_P01,
      lines: [line("1.x", "main", { major: 1 })],
      commits: [
        commit("p01-c1", "feat: open the 1.2.0 runway", { containingRefs: ["main"] }),
        commit("p01-c2", "fix: retry idempotency keys", {
          parents: ["p01-c1"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "p01-c2")],
      tags: [tag("1.2.0-alpha.9", "p01-c1")],
      components: [component("release-craft", "1.1.7")],
      intents: [{ kind: "prerelease", stream: "alpha", lineId: "1.x" }],
    });
  }

  it("rebuilds the stream key (1.2.0, alpha) at sequence 9 with the prerelease head as pointer", () => {
    const world = planDecisions(input());
    // §2.14: the same closed inputs rebuild identically on a second pass.
    expect(planDecisions(input())).toEqual(world);
    const state = stateFor(world, "1.x");
    if (state.pointer === null) {
      throw new Error("fixture broken: the alpha.9 tag must raise a pointer");
    }
    expect(state.pointer.toString()).toBe("1.2.0-alpha.9");
    expect(state.streams).toHaveLength(1);
    const alphaKey = state.streams.find((candidate) => candidate.identifier === "alpha");
    if (alphaKey === undefined) {
      throw new Error("fixture broken: the alpha.9 tag must rebuild an alpha key");
    }
    expect(alphaKey.target.toString()).toBe("1.2.0");
    expect(alphaKey.sequence).toBe(9);
  });

  it("mints 1.2.0-alpha.10 — numerically above alpha.9 where the string order would go back", () => {
    const world = planDecisions(input());
    const decision = decisionFor(world, "1.x");
    expect(decision.kind).toBe("release");
    const streams = streamsFor(world, "1.x", [
      { kind: "prerelease", stream: "alpha", lineId: "1.x" },
    ]);
    expect(streams).toHaveLength(1);
    const mint = streams.find((candidate) => candidate.identifier === "alpha");
    if (mint === undefined) {
      throw new Error("fixture broken: the alpha intent must mint one stream");
    }
    expect(mint).toMatchObject({
      identifier: "alpha",
      seed: "0",
      pointerBase: "1.2.0-alpha.9",
      movesPointer: true,
      tag: "1.2.0-alpha.10",
    });
    expect(mint.version.toString()).toBe("1.2.0-alpha.10");
    // The trap itself (P-01/N2): precedence says forward, string sort says back.
    expect(mint.version.compare(Version.parse("1.2.0-alpha.9"))).toBeGreaterThan(0);
    const mintAsString = mint.version.toString();
    const previousAsString = Version.parse("1.2.0-alpha.9").toString();
    expect(mintAsString < previousAsString).toBe(true);
  });

  it("transitions the stream head alpha.9 → alpha.10 in the rebuilt state, target unchanged", () => {
    const world = buildInput({
      digest: DIGEST_P01,
      lines: [line("1.x", "main", { major: 1 })],
      commits: [
        commit("p01-c1", "feat: open the 1.2.0 runway", { containingRefs: ["main"] }),
        commit("p01-c2", "fix: retry idempotency keys", {
          parents: ["p01-c1"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "p01-c2")],
      // The publication from the previous test's plan has landed.
      tags: [tag("1.2.0-alpha.9", "p01-c1"), tag("1.2.0-alpha.10", "p01-c2")],
      components: [component("release-craft", "1.1.7")],
    });
    const state = stateFor(planDecisions(world), "1.x");
    if (state.pointer === null) {
      throw new Error("fixture broken: published alphas must raise a pointer");
    }
    expect(state.pointer.toString()).toBe("1.2.0-alpha.10");
    const alphaKey = state.streams.find((candidate) => candidate.identifier === "alpha");
    if (alphaKey === undefined) {
      throw new Error("fixture broken: the alpha key must survive the publication");
    }
    expect(alphaKey.target.toString()).toBe("1.2.0");
    expect(alphaKey.sequence).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// P-02 — same target, three costumes: alpha → beta → rc (a fresh sequence per
// identifier at its seed; the ladder walk leaves three coexisting keys)
// ---------------------------------------------------------------------------

describe("P-02: same target, three costumes — the ladder walk", () => {
  // Stated initial state: main; 1.2.0-alpha.3 published; no new commits —
  // the operator re-streams ("move to beta", later "promote to rc").
  function input(
    tags: readonly TagObservation[],
    intents: readonly OperatorIntent[],
  ): PlanningInput {
    return buildInput({
      digest: DIGEST_P02,
      lines: [line("1.x", "main", { major: 1 })],
      commits: [commit("p02-c1", "feat: the 1.2.0 feature set", { containingRefs: ["main"] })],
      refs: [ref("main", "p02-c1")],
      tags,
      components: [component("release-craft", "1.2.0-alpha.3")],
      intents,
    });
  }

  it("mints a fresh sequence per identifier — beta.0 then rc.0, each a forward jump", () => {
    const betaWorld = planDecisions(
      input(
        [tag("1.2.0-alpha.3", "p02-c1")],
        [{ kind: "prerelease", stream: "beta", lineId: "1.x" }],
      ),
    );
    const betaStreams = streamsFor(betaWorld, "1.x", [
      { kind: "prerelease", stream: "beta", lineId: "1.x" },
    ]);
    expect(betaStreams).toHaveLength(1);
    const betaMint = betaStreams.find((candidate) => candidate.identifier === "beta");
    if (betaMint === undefined) {
      throw new Error("fixture broken: the beta intent must mint one stream");
    }
    expect(betaMint).toMatchObject({
      identifier: "beta",
      seed: "0",
      pointerBase: "1.2.0-alpha.3",
      tag: "1.2.0-beta.0",
    });
    expect(betaMint.version.toString()).toBe("1.2.0-beta.0");
    // SemVer §11.4.2: the identifier dominates — beta.0 sorts above alpha.3
    // despite the reset sequence.
    expect(betaMint.version.compare(Version.parse("1.2.0-alpha.3"))).toBeGreaterThan(0);

    const rcWorld = planDecisions(
      input(
        [tag("1.2.0-alpha.3", "p02-c1"), tag("1.2.0-beta.0", "p02-c1")],
        [{ kind: "prerelease", stream: "rc", lineId: "1.x" }],
      ),
    );
    const rcStreams = streamsFor(rcWorld, "1.x", [
      { kind: "prerelease", stream: "rc", lineId: "1.x" },
    ]);
    expect(rcStreams).toHaveLength(1);
    const rcMint = rcStreams.find((candidate) => candidate.identifier === "rc");
    if (rcMint === undefined) {
      throw new Error("fixture broken: the rc intent must mint one stream");
    }
    expect(rcMint).toMatchObject({
      identifier: "rc",
      seed: "0",
      pointerBase: "1.2.0-beta.0",
      tag: "1.2.0-rc.0",
    });
    expect(rcMint.version.toString()).toBe("1.2.0-rc.0");
    expect(rcMint.version.compare(Version.parse("1.2.0-beta.0"))).toBeGreaterThan(0);
  });

  it("records the zero-content publication deliberately — a no-op decision beside a minted stream", () => {
    const betaWorld = planDecisions(
      input(
        [tag("1.2.0-alpha.3", "p02-c1")],
        [{ kind: "prerelease", stream: "beta", lineId: "1.x" }],
      ),
    );
    const decision = decisionFor(betaWorld, "1.x");
    // §2.9: no pending release-worthy change → the recorded no-op; the
    // stream publication exists because the operator's intent demands it
    // (§2.8), not because the empty group minted anything (S-01/PL-06).
    expect(decision).toMatchObject({
      kind: "no-op",
      cause: "no-release-worthy-changes",
      lineId: "1.x",
      policyDigest: DIGEST_P02,
    });
    const streams = streamsFor(betaWorld, "1.x", [
      { kind: "prerelease", stream: "beta", lineId: "1.x" },
    ]);
    expect(streams).toHaveLength(1);
  });

  it("keeps all three costumes in the rebuilt state — alpha at 3, beta and rc at their seed", () => {
    const world = planDecisions(
      input(
        [
          tag("1.2.0-alpha.3", "p02-c1"),
          tag("1.2.0-beta.0", "p02-c1"),
          tag("1.2.0-rc.0", "p02-c1"),
        ],
        [],
      ),
    );
    const state = stateFor(world, "1.x");
    if (state.pointer === null) {
      throw new Error("fixture broken: the ladder's top must raise a pointer");
    }
    // The pointer is highest-by-precedence: rc outranks beta outranks alpha
    // (D10 — the projection moves when a higher precedence publishes).
    expect(state.pointer.toString()).toBe("1.2.0-rc.0");
    // Keys sort by target precedence, then identifier ASCII (state.ts's
    // documented order): one target, so alpha, beta, rc.
    expect(
      state.streams.map((candidate) => ({
        target: candidate.target.toString(),
        identifier: candidate.identifier,
        sequence: candidate.sequence,
      })),
    ).toEqual([
      { target: "1.2.0", identifier: "alpha", sequence: 3 },
      { target: "1.2.0", identifier: "beta", sequence: 0 },
      { target: "1.2.0", identifier: "rc", sequence: 0 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// P-05 — breaking mid-RC: the target moves under you (2.0.0-rc.0, a fresh key
// at its seed; the 1.2.0-rc.* sequence abandoned, never deleted)
// ---------------------------------------------------------------------------

describe("P-05: breaking mid-RC — the target moves under you", () => {
  // Stated initial state: main; 1.1.0 released, then 1.2.0-rc.1 published
  // (target 1.2.0 — a line opens an RC from its released base). Inputs: one
  // breaking merge `feat!: rename the config schema`; intent "continue
  // stabilization". Single-line repo: the line declares no version band, so
  // it admits every admissible tag — the minted 2.0.0-rc.0 belongs to this
  // line even though the target moved out of the 1.x series (P-05's "the
  // target moves under you"; a declared {major:1} band would surface it as
  // foreign, E-06).
  function input(extraTags: readonly TagObservation[]): PlanningInput {
    return buildInput({
      digest: DIGEST_P05,
      lines: [line("1.x", "main")],
      commits: [
        commit("p05-c0", "feat: the 1.1 series", { containingRefs: ["main"] }),
        commit("p05-c1", "feat: the 1.2.0 set", {
          parents: ["p05-c0"],
          containingRefs: ["main"],
        }),
        commit("p05-c2", "feat!: rename the config schema", {
          parents: ["p05-c1"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "p05-c2")],
      tags: [tag("1.1.0", "p05-c0"), tag("1.2.0-rc.1", "p05-c1"), ...extraTags],
      components: [component("release-craft", "1.2.0-rc.1")],
      intents: [{ kind: "prerelease", stream: "rc", lineId: "1.x" }],
    });
  }

  it("recomputes the target to 2.0.0 and re-bases rc at its seed — 2.0.0-rc.0, not rc.2", () => {
    const world = planDecisions(input([]));
    expect(planDecisions(input([]))).toEqual(world);
    const decision = decisionFor(world, "1.x");
    // The breaking marker dominates any type (§2.7): major, not patch.
    expect(decision.kind).toBe("release");
    if (decision.kind !== "release") {
      throw new Error("fixture broken: a breaking feat must decide a release");
    }
    expect(decision.bump).toBe("major");
    const state = stateFor(world, "1.x");
    if (state.pointer === null) {
      throw new Error("fixture broken: the rc.1 tag must raise a pointer");
    }
    expect(state.pointer.toString()).toBe("1.2.0-rc.1");
    // D17(2): the candidate recomputed from the line's stable base 1.1.0 —
    // applyBump(1.1.0, major) = 2.0.0 — outranks the in-flight target
    // (bumpPatch of 1.2.0-rc.1 = 1.2.0), so the target moves. D17(3): the
    // scenario's rc intent suppresses the stable co-mint — the plan's stable
    // is null and the streams carry the target; the would-be view (intents
    // stripped) still computes 2.0.0.
    expect(wouldBeStableFor(world, "1.x")).toBe("2.0.0");
    expect(targetsFor(world, "1.x").stable).toBeNull();
    const streams = streamsFor(world, "1.x", [{ kind: "prerelease", stream: "rc", lineId: "1.x" }]);
    expect(streams).toHaveLength(1);
    const mint = streams.find((candidate) => candidate.identifier === "rc");
    if (mint === undefined) {
      throw new Error("fixture broken: the rc intent must mint one stream");
    }
    expect(mint).toMatchObject({
      identifier: "rc",
      seed: "0",
      pointerBase: "1.2.0-rc.1",
      movesPointer: true,
      tag: "2.0.0-rc.0",
    });
    expect(mint.version.toString()).toBe("2.0.0-rc.0");
    // No cross-target continuation: the fresh key starts at its seed instead
    // of continuing 1.2.0-rc.1 → rc.2 (P-05's "keep the identifier, reset the
    // sequence" reading; a target move is a new key, §2.8).
    expect(mint.version.compare(Version.parse("1.2.0-rc.1"))).toBeGreaterThan(0);
  });

  it("keeps the abandoned 1.2.0 rc key in the rebuilt state — never stabilized, never deleted", () => {
    const world = planDecisions(input([tag("2.0.0-rc.0", "p05-c2")]));
    const state = stateFor(world, "1.x");
    if (state.pointer === null) {
      throw new Error("fixture broken: the new rc must raise a pointer");
    }
    expect(state.pointer.toString()).toBe("2.0.0-rc.0");
    expect(
      state.streams.map((candidate) => ({
        target: candidate.target.toString(),
        identifier: candidate.identifier,
        sequence: candidate.sequence,
      })),
    ).toEqual([
      { target: "1.2.0", identifier: "rc", sequence: 1 },
      { target: "2.0.0", identifier: "rc", sequence: 0 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// P-04 — feat mid-RC: the boolean breaks (1.2.0-rc.3, the in-flight target
// 1.2.0 stands — a sequence bump, not a state flip)
// ---------------------------------------------------------------------------

describe("P-04: feat mid-RC — the boolean breaks", () => {
  // Stated initial state: main; 1.0.0 and 1.1.0 released; the 1.2.0 runway
  // opened as an rc (1.2.0-rc.1 and rc.2 published); one feat lands mid-RC.
  // Intent: "continue the rc stream".
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_P04,
      lines: [line("1.x", "main", { major: 1 })],
      commits: [
        commit("p04-c0", "feat: the 1.0 series", { containingRefs: ["main"] }),
        commit("p04-c1", "feat: the 1.1 series", {
          parents: ["p04-c0"],
          containingRefs: ["main"],
        }),
        commit("p04-c2", "feat: open the 1.2.0 runway", {
          parents: ["p04-c1"],
          containingRefs: ["main"],
        }),
        commit("p04-c3", "feat: the mid-RC payload", {
          parents: ["p04-c2"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "p04-c3")],
      tags: [
        tag("1.0.0", "p04-c0"),
        tag("1.1.0", "p04-c1"),
        tag("1.2.0-rc.1", "p04-c2"),
        tag("1.2.0-rc.2", "p04-c2"),
      ],
      components: [component("release-craft", "1.2.0-rc.2")],
      intents: [{ kind: "prerelease", stream: "rc", lineId: "1.x" }],
    });
  }

  it("keeps the in-flight target 1.2.0 — the rc sequence continues at rc.3", () => {
    const world = planDecisions(input());
    expect(planDecisions(input())).toEqual(world);
    const state = stateFor(world, "1.x");
    expect(state.pointer?.toString()).toBe("1.2.0-rc.2");
    // D17(2)'s base: the highest released stable survives under the rc pointer.
    expect(state.stableBase?.toString()).toBe("1.1.0");
    // Equal-precedence recompute: applyBump(1.1.0, minor) = 1.2.0 equals the
    // in-flight target (the pointer's bumpPatch) — the target and its
    // sequence stand; a feat is not a heavier join (N2: sequence bump, not a
    // state flip).
    expect(wouldBeStableFor(world, "1.x")).toBe("1.2.0");
    expect(decisionFor(world, "1.x")).toMatchObject({ kind: "release", bump: "minor" });
    // D17(3): the rc intent suppresses the stable co-mint — stream-only.
    expect(targetsFor(world, "1.x").stable).toBeNull();
    const streams = streamsFor(world, "1.x", [{ kind: "prerelease", stream: "rc", lineId: "1.x" }]);
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      identifier: "rc",
      seed: "0",
      pointerBase: "1.2.0-rc.2",
      movesPointer: true,
      tag: "1.2.0-rc.3",
    });
  });
});

// ---------------------------------------------------------------------------
// M-08-style — main-line prerelease: the stream is the publication (2.4.0-rc.1,
// stream-only; the stable co-mint suppressed, the would-be 2.4.0 the target)
// ---------------------------------------------------------------------------

describe("M-08-style: main-line prerelease — stream-only under an intent", () => {
  // M-08's main-line half within this PR's scope: the line's first-ever
  // prerelease publishes stream-only (D17(3)); the stable co-mint stays
  // would-be. The fixture declares the ".1" seed (D13: only M-08/E-08
  // declare the ".1" policy).
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_M08,
      lines: [line("main-line", "main")],
      commits: [
        commit("m08-c1", "feat: the 2.3 series", { containingRefs: ["main"] }),
        commit("m08-c2", "feat: the next runway", {
          parents: ["m08-c1"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "m08-c2")],
      tags: [tag("2.3.0", "m08-c1")],
      components: [component("release-craft", "2.3.0")],
      policy: { ...policy(DIGEST_M08), prereleaseSeed: "1" },
      intents: [{ kind: "prerelease", stream: "rc", lineId: "main-line" }],
    });
  }

  it("publishes 2.4.0-rc.1 stream-only — the stable co-mint suppressed", () => {
    const world = planDecisions(input());
    expect(planDecisions(input())).toEqual(world);
    // The stable-pointer branch: applyBump(2.3.0, minor) = 2.4.0 is the
    // would-be stable the stream runs toward.
    expect(wouldBeStableFor(world, "main-line")).toBe("2.4.0");
    // D17(3): stream-only — the plan's stable stays null.
    expect(targetsFor(world, "main-line").stable).toBeNull();
    const streams = streamsFor(world, "main-line", [
      { kind: "prerelease", stream: "rc", lineId: "main-line" },
    ]);
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      identifier: "rc",
      seed: "1",
      pointerBase: "2.3.0",
      movesPointer: true,
      tag: "2.4.0-rc.1",
    });
  });
});

// ---------------------------------------------------------------------------
// P-06 — two streams, one target (alpha exploratory, rc stabilization; the
// operator advances rc only and alpha's head stays put)
// ---------------------------------------------------------------------------

describe("P-06: two streams, one target — advance rc only", () => {
  // Stated initial state: main; both 1.2.0-alpha.4 and 1.2.0-rc.1 published.
  // Inputs: one fix; intent "advance rc only".
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_P06,
      lines: [line("1.x", "main", { major: 1 })],
      commits: [
        commit("p06-c1", "feat: the scheduler", { containingRefs: ["main"] }),
        commit("p06-c2", "fix: race in the scheduler", {
          parents: ["p06-c1"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "p06-c2")],
      tags: [tag("1.2.0-alpha.4", "p06-c1"), tag("1.2.0-rc.1", "p06-c1")],
      components: [component("release-craft", "1.2.0-rc.1")],
      intents: [{ kind: "prerelease", stream: "rc", lineId: "1.x" }],
    });
  }

  it("advances only the requested stream — 1.2.0-rc.2, the alpha head untouched at 4", () => {
    const world = planDecisions(input());
    expect(planDecisions(input())).toEqual(world);
    const state = stateFor(world, "1.x");
    if (state.pointer === null) {
      throw new Error("fixture broken: the published streams must raise a pointer");
    }
    // Highest by precedence: rc outranks alpha at the same core (ASCII).
    expect(state.pointer.toString()).toBe("1.2.0-rc.1");
    expect(
      state.streams.map((candidate) => ({
        identifier: candidate.identifier,
        sequence: candidate.sequence,
      })),
    ).toEqual([
      { identifier: "alpha", sequence: 4 },
      { identifier: "rc", sequence: 1 },
    ]);
    const decision = decisionFor(world, "1.x");
    expect(decision.kind).toBe("release");
    const streams = streamsFor(world, "1.x", [{ kind: "prerelease", stream: "rc", lineId: "1.x" }]);
    // A single "next version" pointer would bump the wrong stream or both —
    // stream-keyed state advances exactly the requested key (N2).
    expect(streams).toHaveLength(1);
    const mint = streams.find((candidate) => candidate.identifier === "rc");
    if (mint === undefined) {
      throw new Error("fixture broken: the rc intent must mint one stream");
    }
    expect(mint).toMatchObject({
      identifier: "rc",
      seed: "0",
      pointerBase: "1.2.0-rc.1",
      movesPointer: true,
      tag: "1.2.0-rc.2",
    });
    expect(mint.version.toString()).toBe("1.2.0-rc.2");
    expect(streams.find((candidate) => candidate.identifier === "alpha")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P-07 — RC-first on the maintenance line, under a 2.x main (line-scoped
// computation: the 1.x line fed by release/1.2 computes from its own tags)
// ---------------------------------------------------------------------------

describe("P-07: RC-first on the maintenance line, under a 2.x main", () => {
  // Stated initial state: main at 2.1.0; branch release/1.2 at 1.2.3;
  // maintenance fixes ride an RC before stable. Inputs: on release/1.2 one
  // fix; intent "release it as an RC first, from the maintenance line".
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_P07,
      lines: [line("2.x", "main", { major: 2 }), line("1.x", "release/1.2", { major: 1 })],
      commits: [
        commit("p07-m1", "feat: the 2.x line", { containingRefs: ["main"] }),
        commit("p07-m2", "chore: the 2.x runway", {
          parents: ["p07-m1"],
          containingRefs: ["main"],
        }),
        commit("p07-r1", "feat: the 1.2 series", { containingRefs: ["release/1.2"] }),
        commit("p07-r2", "fix: backport safe default", {
          parents: ["p07-r1"],
          containingRefs: ["release/1.2"],
        }),
      ],
      refs: [ref("main", "p07-m2"), ref("release/1.2", "p07-r2")],
      tags: [tag("2.1.0", "p07-m1"), tag("1.2.3", "p07-r1")],
      components: [component("release-craft", "2.1.0")],
      intents: [{ kind: "prerelease", stream: "rc", lineId: "1.x" }],
    });
  }

  it("computes the maintenance line from its own tags — 1.2.4-rc.0, never a main-flavored answer", () => {
    const world = planDecisions(input());
    expect(planDecisions(input())).toEqual(world);
    const state = stateFor(world, "1.x");
    if (state.pointer === null) {
      throw new Error("fixture broken: the 1.2.3 tag must raise the line's own pointer");
    }
    // Line-scoped (N1): the pointer comes from release/1.2's own tags, not
    // from main's 2.1.0.
    expect(state.pointer.toString()).toBe("1.2.3");
    const decision = decisionFor(world, "1.x");
    expect(decision.kind).toBe("release");
    if (decision.kind !== "release") {
      throw new Error("fixture broken: the backported fix must decide a release");
    }
    expect(decision.bump).toBe("patch");
    // The policy-mandated RC: the stream mints 1.2.4-rc.0 — the patch target
    // 1.2.4 with a fresh rc key at its seed. Neither a global-pointer answer
    // (2.1.1-rc.0) nor the skipped-RC stable (1.2.4) is in the output.
    // D17(3): the rc intent suppresses the stable co-mint; the would-be view
    // (intents stripped) still computes the patch target 1.2.4 the stream
    // runs toward.
    expect(wouldBeStableFor(world, "1.x")).toBe("1.2.4");
    expect(targetsFor(world, "1.x").stable).toBeNull();
    const streams = streamsFor(world, "1.x", [{ kind: "prerelease", stream: "rc", lineId: "1.x" }]);
    expect(streams).toHaveLength(1);
    const mint = streams.find((candidate) => candidate.identifier === "rc");
    if (mint === undefined) {
      throw new Error("fixture broken: the rc intent must mint one stream");
    }
    expect(mint).toMatchObject({
      identifier: "rc",
      seed: "0",
      pointerBase: "1.2.3",
      movesPointer: true,
      tag: "1.2.4-rc.0",
    });
    expect(mint.version.toString()).toBe("1.2.4-rc.0");
    expect(mint.version.compare(Version.parse("2.1.1-rc.0"))).toBeLessThan(0);
    expect(mint.version.toString()).not.toBe("1.2.4");
  });

  it("leaves the 2.x main line untouched — its own pointer, its own recorded no-op, no streams", () => {
    const world = planDecisions(input());
    const mainState = stateFor(world, "2.x");
    if (mainState.pointer === null) {
      throw new Error("fixture broken: the 2.1.0 tag must raise the main line's pointer");
    }
    expect(mainState.pointer.toString()).toBe("2.1.0");
    expect(mainState.streams).toEqual([]);
    const mainDecision = decisionFor(world, "2.x");
    expect(mainDecision).toMatchObject({
      kind: "no-op",
      cause: "no-release-worthy-changes",
      lineId: "2.x",
    });
    // No intent names 2.x, so no stream mints there — the maintenance line's
    // plan is entirely line-scoped.
    expect(streamsFor(world, "2.x", [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PL-01 — monorepo: one package changed, one package released (the neighbors
// carry negative evidence; the minted tag follows the declared per-line tag
// format — fork 11's naming knob)
// ---------------------------------------------------------------------------

describe("PL-01: one package changed, one package released", () => {
  // Stated initial state: packages app, lib-a, lib-b; the fix touches only
  // lib-a; lib-a is released 1.2.0. The per-package tag naming is declared
  // input configuration (fork 11): the policy names the minted tag.
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_PL01,
      lines: [line("1.x", "main", { major: 1 })],
      commits: [
        commit("pl01-c1", "feat(lib-a): the 1.2.0 guard rails", { containingRefs: ["main"] }),
        commit("pl01-c2", "fix(lib-a): guard empty config", {
          parents: ["pl01-c1"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "pl01-c2")],
      tags: [tag("1.2.0", "pl01-c1")],
      components: [
        component("app", "3.0.0"),
        component("lib-a", "1.2.0"),
        component("lib-b", "2.1.0"),
      ],
      // Fork 11's declared template grammar: {major}/{minor}/{patch}/
      // {prerelease} tokens; a stable version renders {prerelease} empty.
      policy: policy(DIGEST_PL01, { "1.x": "lib-a-{major}.{minor}.{patch}{prerelease}" }),
      intents: [{ kind: "release" }],
    });
  }

  it("mints the patch target under the declared per-package tag format (fork 11)", () => {
    const world = planDecisions(input());
    expect(planDecisions(input())).toEqual(world);
    const decision = decisionFor(world, "1.x");
    expect(decision.kind).toBe("release");
    const target = targetsFor(world, "1.x");
    if (target.stable === null) {
      throw new Error("fixture broken: the release decision must compute a stable target");
    }
    expect(target.stable.version.toString()).toBe("1.2.1");
    // The bare-default tag would be "1.2.1"; the declared format renames the
    // minted tag while the version component stays the kernel-parsed value.
    expect(target.stable.tag).toBe("lib-a-1.2.1");
  });

  it("propagates exactly the lib-a release — the neighbors carry no-reverse-dependency evidence", () => {
    const world = planDecisions(input());
    const target = targetsFor(world, "1.x");
    if (target.stable === null) {
      throw new Error("fixture broken: the release decision must compute a stable target");
    }
    const propagation = planPropagation(world.input.components ?? [], [
      { component: "lib-a", version: target.stable.version },
    ]);
    expect(propagation.edges).toEqual([]);
    expect(propagation.order).toEqual(["lib-a"]);
    // Invariant 14: non-impact is demonstrable, not assumed — app and lib-b
    // declare no dependency on lib-a, and the plan says so.
    expect(propagation.notMoved).toEqual([
      { component: "app", why: "no-reverse-dependency" },
      { component: "lib-b", why: "no-reverse-dependency" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// PL-02 — dependency propagation (case 1: caret-compatible patch, no edges;
// case 2: breaking, edges lib-a → lib-b → app in topological order)
// ---------------------------------------------------------------------------

describe("PL-02: dependency propagation — the changed package has dependents", () => {
  // Stated initial state: lib-a 1.2.0; lib-b depends on lib-a "^1.2.0"; app
  // depends on lib-a "^1.2.0" and lib-b "^1.5.0". The graph arrives as closed
  // declared input (D16), never discovered (invariant 2).
  const components: readonly ComponentMeta[] = [
    component("lib-a", "1.2.0"),
    component("lib-b", "1.5.0", [{ name: "lib-a", range: "^1.2.0" }]),
    component("app", "3.1.0", [
      { name: "lib-a", range: "^1.2.0" },
      { name: "lib-b", range: "^1.5.0" },
    ]),
  ];

  function input(breaking: boolean): PlanningInput {
    return buildInput({
      digest: DIGEST_PL02,
      lines: [line("1.x", "main", { major: 1 })],
      commits: [
        commit("pl02-c1", "feat(lib-a): the 1.2.0 serializer", { containingRefs: ["main"] }),
        commit(
          "pl02-c2",
          breaking
            ? "feat(lib-a)!: break the serializer contract"
            : "fix(lib-a): correct the serializer",
          {
            parents: ["pl02-c1"],
            containingRefs: ["main"],
          },
        ),
      ],
      refs: [ref("main", "pl02-c2")],
      tags: [tag("1.2.0", "pl02-c1")],
      components,
      intents: [{ kind: "release" }],
    });
  }

  it("case 1 — the caret-compatible patch widens nothing: empty edges, range-compatible dependents", () => {
    const world = planDecisions(input(false));
    expect(planDecisions(input(false))).toEqual(world);
    const target = targetsFor(world, "1.x");
    if (target.stable === null) {
      throw new Error("fixture broken: the release decision must compute a stable target");
    }
    expect(target.stable.version.toString()).toBe("1.2.1");
    const propagation = planPropagation(components, [
      { component: "lib-a", version: target.stable.version },
    ]);
    // ^1.2.0 still accepts 1.2.1 — no edge, and the negative evidence names
    // the deterministic reason for each dependent (invariant 14). The order
    // is the affected closure, range-INDEPENDENT: the dependents stay
    // scheduled even though neither moves.
    expect(propagation.edges).toEqual([]);
    expect(propagation.order).toEqual(["lib-a", "lib-b", "app"]);
    expect(propagation.notMoved).toEqual([
      { component: "lib-b", why: "range-compatible" },
      { component: "app", why: "range-compatible" },
    ]);
  });

  it("case 2 — the breaking release widens both direct dependents; the closure rides in topo order", () => {
    const world = planDecisions(input(true));
    const decision = decisionFor(world, "1.x");
    if (decision.kind !== "release") {
      throw new Error("fixture broken: the breaking change must decide a release");
    }
    expect(decision.bump).toBe("major");
    const target = targetsFor(world, "1.x");
    if (target.stable === null) {
      throw new Error("fixture broken: the release decision must compute a stable target");
    }
    expect(target.stable.version.toString()).toBe("2.0.0");
    const propagation = planPropagation(components, [
      { component: "lib-a", version: target.stable.version },
    ]);
    // ^1.2.0 no longer accepts 2.0.0: both DIRECT dependents of lib-a must
    // widen — lib-b and, since app also declares ^1.2.0 on lib-a, app too.
    // Edges are per direct declaration, released component → dependent, in
    // topological order; lib-b→app would only appear if lib-b itself
    // released. The closure/order still rides the full transitive graph.
    expect(propagation.edges).toEqual([
      { from: "lib-a", to: "lib-b", reason: "range-widening" },
      { from: "lib-a", to: "app", reason: "range-widening" },
    ]);
    expect(propagation.order).toEqual(["lib-a", "lib-b", "app"]);
    expect(propagation.notMoved).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PL-03 — unrelated isolation: neighbors must not move (the leaf fix releases
// tool-x alone; the docs-only commit triggers nothing anywhere; negative
// evidence is a first-class plan output)
// ---------------------------------------------------------------------------

describe("PL-03: unrelated isolation — neighbors must not move", () => {
  const components: readonly ComponentMeta[] = [
    component("tool-x", "0.3.0"),
    component("lib-a", "1.0.0"),
  ];

  function firstRun(): PlanningInput {
    return buildInput({
      digest: DIGEST_PL03,
      lines: [line("0.x", "main", { major: 0 })],
      commits: [
        commit("pl03-t1", "feat: the first tool-x", { containingRefs: ["main"] }),
        commit("pl03-x1", "fix(tool-x): correct CLI exit code", {
          parents: ["pl03-t1"],
          containingRefs: ["main"],
        }),
        commit("pl03-d1", "docs(lib-a): expand README", {
          parents: ["pl03-x1"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "pl03-d1")],
      tags: [tag("0.3.0", "pl03-t1")],
      components,
      intents: [{ kind: "release" }],
    });
  }

  function secondRun(): PlanningInput {
    return buildInput({
      digest: DIGEST_PL03,
      lines: [line("0.x", "main", { major: 0 })],
      commits: [
        commit("pl03-t1", "feat: the first tool-x", { containingRefs: ["main"] }),
        commit("pl03-x1", "fix(tool-x): correct CLI exit code", {
          parents: ["pl03-t1"],
          containingRefs: ["main"],
        }),
        commit("pl03-d1", "docs(lib-a): expand README", {
          parents: ["pl03-x1"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "pl03-d1")],
      // The first run's publication has landed; only the docs commit pends.
      tags: [tag("0.3.0", "pl03-t1"), tag("0.3.1", "pl03-x1")],
      components,
    });
  }

  it("releases tool-x alone — 0.3.1, the docs commit filtered by policy, lib-a evidenced", () => {
    const world = planDecisions(firstRun());
    expect(planDecisions(firstRun())).toEqual(world);
    const decision = decisionFor(world, "0.x");
    if (decision.kind !== "release") {
      throw new Error("fixture broken: the leaf fix must decide a release");
    }
    expect(decision.bump).toBe("patch");
    // The docs commit is non-releasing by the declared mapping (§2.7), so it
    // is not among the contributing changes — filtering by policy, not by
    // hard-coding.
    expect(decision.changes.map((parsed) => parsed.sha)).toEqual(["pl03-x1"]);
    const target = targetsFor(world, "0.x");
    if (target.stable === null) {
      throw new Error("fixture broken: the release decision must compute a stable target");
    }
    expect(target.stable.version.toString()).toBe("0.3.1");
    const propagation = planPropagation(components, [
      { component: "tool-x", version: target.stable.version },
    ]);
    expect(propagation.edges).toEqual([]);
    expect(propagation.order).toEqual(["tool-x"]);
    // Nothing depends on the leaf — the plan states why the neighbor stayed.
    expect(propagation.notMoved).toEqual([{ component: "lib-a", why: "no-reverse-dependency" }]);
  });

  it("a second run over the docs commit alone records the no-op — no version anywhere", () => {
    const world = planDecisions(secondRun());
    const decision = decisionFor(world, "0.x");
    expect(decision).toMatchObject({
      kind: "no-op",
      cause: "no-release-worthy-changes",
      lineId: "0.x",
    });
    if (decision.kind !== "no-op") {
      throw new Error("fixture broken: the docs-only runway must decide a no-op");
    }
    expect(decision.ignored.map((parsed) => parsed.sha)).toEqual(["pl03-d1"]);
    // The no-op mints nothing: no stable target, no stream.
    expect(targetsFor(world, "0.x").stable).toBeNull();
    expect(streamsFor(world, "0.x", [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// E-04 — policy flips under a stored plan (§2.14 double-run determinism plus
// the fingerprint recognition data: equal worlds fingerprint equal, one
// flipped policy field makes both fingerprints differ)
// ---------------------------------------------------------------------------

describe("E-04: policy flips under a stored plan — fingerprints are the recognition data", () => {
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

  /** The stored plan shape (§2.11): the closed tuple minus its planId. */
  function assemble(world: PlannedWorld): Omit<ReleasePlan, "planId"> {
    return {
      supersedes: null,
      policyDigest: world.input.policy.digest,
      inputsFingerprint: inputsFingerprint(world.input),
      lines: [planLineOf(world, "1.x")],
      refusedIntents: [],
      explanation: { foreignTags: [], conflicts: [], excluded: [], withheld: [] },
    };
  }

  it("plans the identical world twice — equal inputs fingerprint, equal plan fingerprint", () => {
    const world = planDecisions(input(DIGEST_E04, "0"));
    expect(planDecisions(input(DIGEST_E04, "0"))).toEqual(world);
    const planA = assemble(world);
    const planB = assemble(planDecisions(input(DIGEST_E04, "0")));
    expect(planA).toEqual(planB);
    const planIdA = planFingerprint(planA);
    const planIdB = planFingerprint(planB);
    expect(planIdA).toBe(planIdB);
    expect(planIdA).toMatch(/^plan_sha256:[0-9a-f]{64}$/);
    const worldFingerprint = inputsFingerprint(input(DIGEST_E04, "0"));
    expect(worldFingerprint).toBe(inputsFingerprint(input(DIGEST_E04, "0")));
    expect(worldFingerprint).toMatch(/^inputs_sha256:[0-9a-f]{64}$/);
  });

  it("flipping one policy field (the seed) makes both fingerprints differ — the stored plan is stale", () => {
    const before = assemble(planDecisions(input(DIGEST_E04, "0")));
    const after = assemble(planDecisions(input(DIGEST_E04_AMENDED, "1")));
    // E-04: the amended world is recognizable — inputs fingerprint differs,
    // and so does the content fingerprint of the plan built from it.
    expect(inputsFingerprint(input(DIGEST_E04_AMENDED, "1"))).not.toBe(
      inputsFingerprint(input(DIGEST_E04, "0")),
    );
    expect(planFingerprint(after)).not.toBe(planFingerprint(before));
  });

  it("canonicalJson is key-order-insensitive and stable across calls (§2.11)", () => {
    const left = canonicalJson({ b: 2, a: { d: 4, c: 3 } });
    expect(left).toBe(canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
    expect(left).toBe(canonicalJson({ b: 2, a: { d: 4, c: 3 } }));
  });
});

// ---------------------------------------------------------------------------
// E-11 — plan from stale state: hotfix interleave (the same next-version
// number from two different worlds — version equality implies nothing about
// plan equality)
// ---------------------------------------------------------------------------

describe("E-11: hotfix interleave — same target version, different plans", () => {
  // Two worlds over the same released base 1.4.2; each pending set justifies
  // the same minor bump to 1.5.0, but the change sets differ.
  function input(changeShas: readonly [string, string]): PlanningInput {
    return buildInput({
      digest: DIGEST_E11,
      lines: [line("1.x", "main", { major: 1 })],
      commits: [
        commit("e11-c1", "feat: the 1.4 line", { containingRefs: ["main"] }),
        commit(changeShas[0], "feat: the headline feature", {
          parents: ["e11-c1"],
          containingRefs: ["main"],
        }),
        commit(changeShas[1], "fix: the follow-up correction", {
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

  function assemble(world: PlannedWorld): Omit<ReleasePlan, "planId"> {
    return {
      supersedes: null,
      policyDigest: world.input.policy.digest,
      inputsFingerprint: inputsFingerprint(world.input),
      lines: [planLineOf(world, "1.x")],
      refusedIntents: [],
      explanation: { foreignTags: [], conflicts: [], excluded: [], withheld: [] },
    };
  }

  it("same target version string from two change sets — but different plan identities", () => {
    const worldA = planDecisions(input(["e11-a2", "e11-a3"]));
    const worldB = planDecisions(input(["e11-b2", "e11-b3"]));
    const planA = assemble(worldA);
    const planB = assemble(worldB);
    const lineA = planA.lines.find((candidate) => candidate.lineId === "1.x");
    const lineB = planB.lines.find((candidate) => candidate.lineId === "1.x");
    if (
      lineA === undefined ||
      lineB === undefined ||
      lineA.stable === null ||
      lineB.stable === null
    ) {
      throw new Error("fixture broken: both worlds must assemble a stable target");
    }
    // The version is NOT the plan: both worlds land on 1.5.0…
    expect(lineA.stable.version).toBe("1.5.0");
    expect(lineB.stable.version).toBe("1.5.0");
    // …yet the plans differ because the decided change sets differ.
    expect(lineA.changes.map((change) => change.id)).not.toEqual(
      lineB.changes.map((change) => change.id),
    );
    expect(planFingerprint(planA)).not.toBe(planFingerprint(planB));
    expect(inputsFingerprint(worldA.input)).not.toBe(inputsFingerprint(worldB.input));
  });
});
