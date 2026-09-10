/**
 * End-to-end golden scenarios for the PR-3 layer — S-01, S-02, S-03,
 * S-04, S-05 and M-07 of docs/design/release-scenarios.md, pinned at the
 * decision-record level (phase2-planner-contract.md §2.5, §2.7, §2.9 and
 * §2.13; decision-log D15).
 *
 * Where the PR-2 golden file feeds `attribute` declared ranges, every test
 * here composes the real modules end to end — `normalize` → `extract` →
 * `loadTagHistory` → `deriveRanges` → `attribute` → `decideLine` — so the
 * scenarios pin exactly the layer PR-3 owns: history projection, range
 * derivation, bump resolution, decision records. Ranges and histories are
 * derived from the observations, never declared.
 *
 * Version computation is PR-4: no assertion here derives or pins a next
 * version. A decision record and its evaluated range are this layer's
 * entire output surface, and that is all these fixtures demand of it.
 */

import { describe, expect, it } from "vitest";

import { attribute } from "@ecoma-io/release-craft/__internal__/planner/attribute.js";
import { decideLine, resolveBump } from "@ecoma-io/release-craft/__internal__/planner/decide.js";
import { extract } from "@ecoma-io/release-craft/__internal__/planner/extract.js";
import {
  deriveRanges,
  loadTagHistory,
} from "@ecoma-io/release-craft/__internal__/planner/history.js";
import { normalize } from "@ecoma-io/release-craft/__internal__/planner/input.js";
import type {
  BootstrapDecision,
  CommitObservation,
  ComponentMeta,
  LineAttribution,
  LineConfig,
  LineDecision,
  LineHistory,
  LineRange,
  OperatorIntent,
  PlanningInput,
  PolicyInput,
  RefObservation,
  TagHistoryResult,
  TagObservation,
} from "@ecoma-io/release-craft/__internal__/planner/types.js";

// ---------------------------------------------------------------------------
// Fixture builders — deterministic, closed inputs per §2.1, mirroring the
// attribute.adversarial.test.ts idiom
// ---------------------------------------------------------------------------

const COMMITTED_AT = "2026-01-01T00:00:00Z";

/** One fixed digest per scenario — opaque content identity (invariant 4). */
const DIGEST_S01 = "sha256:" + "a".repeat(64);
const DIGEST_S02 = "sha256:" + "b".repeat(64);
const DIGEST_S03 = "sha256:" + "c".repeat(64);
const DIGEST_M07 = "sha256:" + "d".repeat(64);
const DIGEST_S04 = "sha256:" + "e".repeat(64);
const DIGEST_S05 = "sha256:" + "f".repeat(64);

function policy(digest: string): PolicyInput {
  return {
    digest,
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

function component(name: string, manifestVersion: string): ComponentMeta {
  return { name, manifestVersion, paths: ["package.json"] };
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
}

/** The closed §2.1 input a scenario's stated initial state reconstructs. */
function buildInput(opts: FixtureOptions): PlanningInput {
  return {
    policy: policy(opts.digest),
    repository: { commits: opts.commits, refs: opts.refs },
    history: { tags: opts.tags ?? [] },
    lines: opts.lines,
    ...(opts.components === undefined ? {} : { components: opts.components }),
    ...(opts.bootstrap === undefined ? {} : { bootstrap: opts.bootstrap }),
    ...(opts.intents === undefined ? {} : { intents: opts.intents }),
  };
}

// ---------------------------------------------------------------------------
// The composition under test — the real modules, one pass. Purity is §2.14's
// determinism contract, so each scenario also fingerprint-checks a second
// pass against the first.
// ---------------------------------------------------------------------------

interface Planned {
  readonly history: TagHistoryResult;
  readonly ranges: readonly LineRange[];
  readonly attributions: readonly LineAttribution[];
  readonly decisions: readonly LineDecision[];
}

function planLines(raw: PlanningInput): Planned {
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
  return { history, ranges, attributions: outcome.lines, decisions };
}

function historyFor(planned: Planned, lineId: string): LineHistory {
  const found = planned.history.lines.find((candidate) => candidate.lineId === lineId);
  if (found === undefined) {
    throw new Error(`fixture broken: line ${lineId} missing from history projection`);
  }
  return found;
}

function attributionFor(planned: Planned, lineId: string): LineAttribution {
  const found = planned.attributions.find((candidate) => candidate.lineId === lineId);
  if (found === undefined) {
    throw new Error(`fixture broken: line ${lineId} missing from attribution`);
  }
  return found;
}

function decisionFor(planned: Planned, lineId: string): LineDecision {
  const found = planned.decisions.find((candidate) => candidate.lineId === lineId);
  if (found === undefined) {
    throw new Error(`fixture broken: line ${lineId} has no decision record`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// S-01 — chore-only runway: the recorded no-op (a decision that produces
// nothing is still an event)
// ---------------------------------------------------------------------------

describe("S-01: chore-only runway — the recorded no-op", () => {
  // Stated initial state: branch main only, tags 1.0.0/1.0.1, manifest
  // 1.0.1; stated inputs: chore merges since 1.0.1 and "cut whatever is due".
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

  it("records the runway as a no-op carrying cause, ordered ignored commits, range and digest", () => {
    const planned = planLines(input());
    const decision = decisionFor(planned, "1.x");
    expect(decision.kind).toBe("no-op");
    expect(decision).toMatchObject({
      kind: "no-op",
      cause: "no-release-worthy-changes",
      lineId: "1.x",
      policyDigest: DIGEST_S01,
      range: { lineId: "1.x", releasedUpTo: "s01-1.0.1", head: "s01-chore-2" },
      ignored: [{ sha: "s01-chore-1" }, { sha: "s01-chore-2" }],
    });
    // §2.14: the same closed inputs must fingerprint-equal on a second pass.
    expect(planLines(input())).toEqual(planned);
  });

  it("resolves no bump for the chores — the default mapping's absence is the no-op cause (§2.7)", () => {
    const planned = planLines(input());
    expect(resolveBump(attributionFor(planned, "1.x").pending, input().policy)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// S-02 — first release ever: bootstrap is underdetermined and the manifest
// (0.0.0) is not truth; the recorded bootstrap decision unlocks the release
// ---------------------------------------------------------------------------

describe("S-02: first release ever — two absent truths", () => {
  // Stated initial state: branch main only, zero tags, manifest 0.0.0,
  // release-worthy history pending; stated input: "make the first release".
  function input(bootstrap?: BootstrapDecision): PlanningInput {
    const opts: FixtureOptions = {
      digest: DIGEST_S02,
      lines: [line("default", "main", undefined, false)],
      commits: [
        commit("s02-feat-core", "feat: core loop", { containingRefs: ["main"] }),
        commit("s02-feat-cli", "feat: cli scaffold", {
          parents: ["s02-feat-core"],
          containingRefs: ["main"],
        }),
        commit("s02-fix", "fix: parser edge case", {
          parents: ["s02-feat-cli"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "s02-fix")],
      tags: [],
      components: [component("release-craft", "0.0.0")],
      intents: [{ kind: "release" }],
    };
    return buildInput(bootstrap === undefined ? opts : { ...opts, bootstrap });
  }

  it("blocks with bootstrap-required while the initial-version decision is absent", () => {
    const planned = planLines(input());
    const decision = decisionFor(planned, "default");
    expect(decision.kind).toBe("blocked");
    expect(decision).toMatchObject({
      kind: "blocked",
      cause: "bootstrap-required",
      lineId: "default",
      policyDigest: DIGEST_S02,
      range: { lineId: "default", releasedUpTo: null, head: "s02-fix" },
    });
  });

  it("releases once the operator's bootstrap decision is recorded — minor over the whole history", () => {
    const recorded: BootstrapDecision = {
      version: "1.0.0",
      who: "the operator",
      when: COMMITTED_AT,
    };
    const planned = planLines(input(recorded));
    const decision = decisionFor(planned, "default");
    expect(decision.kind).toBe("release");
    expect(decision).toMatchObject({
      kind: "release",
      bump: "minor",
      lineId: "default",
      policyDigest: DIGEST_S02,
      range: { lineId: "default", releasedUpTo: null, head: "s02-fix" },
      changes: [{ sha: "s02-feat-core" }, { sha: "s02-feat-cli" }, { sha: "s02-fix" }],
    });
    expect(planLines(input(recorded))).toEqual(planned);
  });
});

// ---------------------------------------------------------------------------
// S-03 — manifest drift: the line's tag history outranks the manifest; the
// range is bounded by the line's own 1.9.5 tag, never by manifest 1.9.0
// ---------------------------------------------------------------------------

describe("S-03: manifest drift — the hotfixes that never came home", () => {
  // Stated initial state: main's manifest 1.9.0; tag 1.9.0 on main and
  // 1.9.1..1.9.5 on the hotfix line (their commits are observed but not
  // reachable from main's head); one pending fix on main beyond 1.9.0.
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_S03,
      lines: [line("1.x", "main", { major: 1 })],
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
      tags: [
        tag("1.9.0", "s03-1.9.0"),
        tag("1.9.1", "s03-hf1"),
        tag("1.9.2", "s03-hf2"),
        tag("1.9.3", "s03-hf3"),
        tag("1.9.4", "s03-hf4"),
        tag("1.9.5", "s03-hf5"),
      ],
      // The stale manifest rides as declared ComponentMeta (invariant 6) and
      // appears in no assertion below: this scenario exists to prove the
      // projection is ignored, never consumed as truth.
      components: [component("release-craft", "1.9.0")],
      intents: [{ kind: "release" }],
    });
  }

  it("bounds the range at the line's own 1.9.5 tag — never at the manifest's 1.9.0", () => {
    const planned = planLines(input());
    const history = historyFor(planned, "1.x");
    expect(history.tags.map((admissible) => admissible.name)).toEqual([
      "1.9.0",
      "1.9.1",
      "1.9.2",
      "1.9.3",
      "1.9.4",
      "1.9.5",
    ]);
    expect(history.foreign).toEqual([]);
    const decision = decisionFor(planned, "1.x");
    expect(decision.range).toEqual({
      lineId: "1.x",
      releasedUpTo: "s03-hf5",
      head: "s03-fix-main",
    });
  });

  it("releases the pending main fix as a patch without re-listing the released hotfixes", () => {
    const planned = planLines(input());
    const decision = decisionFor(planned, "1.x");
    expect(decision.kind).toBe("release");
    expect(decision).toMatchObject({
      kind: "release",
      bump: "patch",
      lineId: "1.x",
      policyDigest: DIGEST_S03,
      range: { releasedUpTo: "s03-hf5", head: "s03-fix-main" },
      changes: [{ sha: "s03-fix-main" }],
    });
    expect(planLines(input())).toEqual(planned);
  });
});

// ---------------------------------------------------------------------------
// S-04 — release-worthy without changelog-worthy: the bump-driving
// classification and the note-producing classification are independent
// (Table 1, S-04). The contract's config excluding scope `internal` from
// changelog notes is a note-classification knob — no such field exists on
// PlanningInput — so the decision-record layer's pin is that the internal
// scope neither demotes nor skips the release; conflating the two
// classifications would skip it.
// ---------------------------------------------------------------------------

describe("S-04: release-worthy, not changelog-worthy", () => {
  // Stated initial state: branch main only, tags through 1.0.4, manifest
  // 1.0.4; stated inputs: the two fix(internal) merges pending and
  // operator intent "release".
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_S04,
      lines: [line("1.x", "main", { major: 1 })],
      commits: [
        commit("s04-1.0.0", "feat: the 1.0 line", { containingRefs: ["main"] }),
        commit("s04-1.0.4", "fix: the previous patch", {
          parents: ["s04-1.0.0"],
          containingRefs: ["main"],
        }),
        commit("s04-fix-1", "fix(internal): harden token scrubbing", {
          parents: ["s04-1.0.4"],
          containingRefs: ["main"],
        }),
        commit("s04-fix-2", "fix(internal): close race in session cache", {
          parents: ["s04-fix-1"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "s04-fix-2")],
      tags: [tag("1.0.0", "s04-1.0.0"), tag("1.0.4", "s04-1.0.4")],
      components: [component("release-craft", "1.0.4")],
      intents: [{ kind: "release" }],
    });
  }

  it("releases both internal-scoped fixes as a patch — note exclusion never suppresses the release", () => {
    const planned = planLines(input());
    const decision = decisionFor(planned, "1.x");
    expect(decision.kind).toBe("release");
    expect(decision).toMatchObject({
      kind: "release",
      bump: "patch",
      lineId: "1.x",
      policyDigest: DIGEST_S04,
      range: { lineId: "1.x", releasedUpTo: "s04-1.0.4", head: "s04-fix-2" },
      changes: [{ sha: "s04-fix-1" }, { sha: "s04-fix-2" }],
    });
    // §2.14: the same closed inputs must fingerprint-equal on a second pass.
    expect(planLines(input())).toEqual(planned);
  });

  it("resolves the patch from the fix classification alone — the internal scope rides parsed and inert (§2.7)", () => {
    const planned = planLines(input());
    expect(attributionFor(planned, "1.x").pending).toMatchObject([
      { sha: "s04-fix-1", type: "fix", scope: "internal", breaking: false },
      { sha: "s04-fix-2", type: "fix", scope: "internal", breaking: false },
    ]);
    expect(resolveBump(attributionFor(planned, "1.x").pending, input().policy)).toBe("patch");
  });
});

// ---------------------------------------------------------------------------
// S-05 — major cut while the maintenance line lives: the new 2.x line cuts
// 2.0.0 from its own birth range while line 1.x stays live and unaffected
// (Table 1, S-05). The tags interleave in walk order — global tag order is
// not version order (§2.13).
// ---------------------------------------------------------------------------

describe("S-05: major cut, maintenance line lives", () => {
  // Stated initial state: main (manifest 1.0.0, never released past the
  // shared root) carries the breaking commit; release/1.x is live through
  // 1.0.2 with one pending chore. The new 2.x line has no 2.x tags, so its
  // range starts at line birth and the first version is the operator's
  // recorded bootstrap call — "cut 2.0.0 from main" (S-02's law); the
  // breaking feat! resolves the major, resetting minor and patch.
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_S05,
      lines: [line("1.x", "release/1.x", { major: 1 }), line("2.x", "main", { major: 2 })],
      commits: [
        commit("s05-root", "feat: the shared 1.0 foundation", {
          containingRefs: ["main", "release/1.x"],
        }),
        commit("s05-1x-1", "fix: harden the 1.x parser", {
          parents: ["s05-root"],
          containingRefs: ["release/1.x"],
        }),
        commit("s05-1x-2", "chore: cut 1.0.2", {
          parents: ["s05-1x-1"],
          containingRefs: ["release/1.x"],
        }),
        commit("s05-1x-chore", "chore: prune stale 1.x docs", {
          parents: ["s05-1x-2"],
          containingRefs: ["release/1.x"],
        }),
        commit("s05-cut", "chore: branch for the 2.x line", {
          parents: ["s05-root"],
          containingRefs: ["main"],
        }),
        commit("s05-feat", "feat!: require config schema v2", {
          parents: ["s05-cut"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "s05-feat"), ref("release/1.x", "s05-1x-chore")],
      // Walk order is the input order: the 1.x line's newer tags interleave
      // around 1.0.0, the tag sitting on the commit main's history shares.
      tags: [tag("1.0.1", "s05-1x-1"), tag("1.0.0", "s05-root"), tag("1.0.2", "s05-1x-2")],
      // The stale manifest rides as declared projection and appears in no
      // assertion below (invariant 6, mirroring S-03).
      components: [component("release-craft", "1.0.0")],
      bootstrap: { version: "2.0.0", who: "the operator", when: COMMITTED_AT },
      intents: [{ kind: "release" }],
    });
  }

  it("cuts 2.0.0 from main — the breaking feat! resolves major over the birth range", () => {
    const planned = planLines(input());
    const decision = decisionFor(planned, "2.x");
    expect(decision.kind).toBe("release");
    expect(decision).toMatchObject({
      kind: "release",
      bump: "major",
      lineId: "2.x",
      policyDigest: DIGEST_S05,
      range: { lineId: "2.x", releasedUpTo: null, head: "s05-feat" },
      changes: [{ sha: "s05-root" }, { sha: "s05-feat" }],
    });
    // §2.14: the same closed inputs must fingerprint-equal on a second pass.
    expect(planLines(input())).toEqual(planned);
  });

  it("keeps each line's history its own — 1.0.x is foreign to 2.x and version order survives the walk order (§2.13)", () => {
    const planned = planLines(input());
    const oneX = historyFor(planned, "1.x");
    expect(oneX.tags.map((admissible) => admissible.name)).toEqual(["1.0.0", "1.0.1", "1.0.2"]);
    expect(oneX.foreign).toEqual([]);
    // foreign keeps walk (input) order: 1.0.1 and 1.0.2 — the live 1.x
    // line's newer tags — walk around 1.0.0, and none of them is 2.x's
    // bound.
    const twoX = historyFor(planned, "2.x");
    expect(twoX.tags).toEqual([]);
    expect(twoX.foreign.map((tagged) => tagged.name)).toEqual(["1.0.1", "1.0.0", "1.0.2"]);
  });

  it("leaves the maintenance line a recorded no-op — evaluated, ignored, untouched", () => {
    const planned = planLines(input());
    const decision = decisionFor(planned, "1.x");
    expect(decision.kind).toBe("no-op");
    expect(decision).toMatchObject({
      kind: "no-op",
      cause: "no-release-worthy-changes",
      lineId: "1.x",
      policyDigest: DIGEST_S05,
      range: { lineId: "1.x", releasedUpTo: "s05-1x-2", head: "s05-1x-chore" },
      ignored: [{ sha: "s05-1x-chore" }],
    });
  });
});

// ---------------------------------------------------------------------------
// M-07 — divergent maintenance line: each line's range comes from its own
// tags and its own head; band admission rejects foreign tags both ways
// ---------------------------------------------------------------------------

describe("M-07: divergent maintenance line — commits main never had", () => {
  // Stated initial state: main released 2.3.0 with nothing pending; line 1.9
  // released 1.9.0 carrying a feat and a fix that main never received.
  function input(): PlanningInput {
    return buildInput({
      digest: DIGEST_M07,
      lines: [
        line("2.x", "main", { major: 2 }),
        line("1.9", "release/1.9", { major: 1, minor: 9 }),
      ],
      commits: [
        commit("m07-root", "feat: the shared root", { containingRefs: ["main", "release/1.9"] }),
        commit("m07-2x-feat", "feat: the 2.x capability", {
          parents: ["m07-root"],
          containingRefs: ["main"],
        }),
        commit("m07-2.3.0", "chore: cut 2.3.0", {
          parents: ["m07-2x-feat"],
          containingRefs: ["main"],
        }),
        commit("m07-1.9.0", "chore: cut 1.9.0", {
          parents: ["m07-root"],
          containingRefs: ["release/1.9"],
        }),
        commit("m07-divergent-feat", "feat: the divergent capability", {
          parents: ["m07-1.9.0"],
          containingRefs: ["release/1.9"],
        }),
        commit("m07-divergent-fix", "fix: the divergent fix", {
          parents: ["m07-divergent-feat"],
          containingRefs: ["release/1.9"],
        }),
      ],
      refs: [ref("main", "m07-2.3.0"), ref("release/1.9", "m07-divergent-fix")],
      tags: [tag("2.3.0", "m07-2.3.0"), tag("1.9.0", "m07-1.9.0")],
      intents: [{ kind: "release" }],
    });
  }

  it("rejects each line's foreign tag by band, both ways (D15, E-06)", () => {
    const planned = planLines(input());
    expect(historyFor(planned, "2.x")).toMatchObject({
      lineId: "2.x",
      tags: [{ name: "2.3.0", commit: "m07-2.3.0" }],
      foreign: [{ name: "1.9.0", commit: "m07-1.9.0" }],
    });
    expect(historyFor(planned, "1.9")).toMatchObject({
      lineId: "1.9",
      tags: [{ name: "1.9.0", commit: "m07-1.9.0" }],
      foreign: [{ name: "2.3.0", commit: "m07-2.3.0" }],
    });
  });

  it("releases 1.9 with a minor bump carrying both divergent commits from its own range", () => {
    const planned = planLines(input());
    const decision = decisionFor(planned, "1.9");
    expect(decision.kind).toBe("release");
    expect(decision).toMatchObject({
      kind: "release",
      bump: "minor",
      lineId: "1.9",
      policyDigest: DIGEST_M07,
      range: { lineId: "1.9", releasedUpTo: "m07-1.9.0", head: "m07-divergent-fix" },
      changes: [{ sha: "m07-divergent-feat" }, { sha: "m07-divergent-fix" }],
    });
    expect(planLines(input())).toEqual(planned);
  });

  it("leaves 2.x a no-op: released 2.3.0, empty pending, nothing ignored", () => {
    const planned = planLines(input());
    const decision = decisionFor(planned, "2.x");
    expect(decision.kind).toBe("no-op");
    expect(decision).toMatchObject({
      kind: "no-op",
      cause: "no-release-worthy-changes",
      lineId: "2.x",
      policyDigest: DIGEST_M07,
      range: { lineId: "2.x", releasedUpTo: "m07-2.3.0", head: "m07-2.3.0" },
      ignored: [],
    });
  });
});
