/**
 * Scenario golden suite for the D18 line-policy seam, through the door
 * `plan()` (src/planner/assemble.ts): the DECLARED SCENARIOS as end-to-end
 * goldens — M-08's two-line policy resolution and its double-run purity pin,
 * PL-07's withhold deferral with the unfreeze recovery, the per-line
 * lifecycle refusals composing beside an active line, and the declared
 * publishes binding (ADR-0004 decision 4). The per-mechanism door pins live
 * in assemble.test.ts; this suite pins the scenario-level outcomes, so the
 * assertions here read plan and decision records only.
 *
 * Fixture posture:
 * - M-08 binds per declaration: both releasing lines declare `publishes` to
 *   their own component ("app" / "lib") — two releasing lines over one
 *   declared component is the ambiguous mapping the door refuses (D18
 *   decision 4), so the single-component posture cannot carry this world.
 * - M-08's declared 2.4.0-rc.1 pins a minor bump on main; the default policy
 *   maps a breaking change to major (3.0.0-rc.1, as assemble.test.ts's own
 *   Decision 4 golden pins), so B carries a plain `feat:` — the breaking
 *   detail of the scenario text is the one part this golden cannot pin.
 * - Withheld deferrals surface two-fold (D18, PL-07): the decision record
 *   carries the raw commits (the `withheld` list on a `kind: "withheld"`
 *   record, the pin named in a pinned release's `detail`), and the plan's
 *   persisted `explanation.withheld` curates each deferral with its line,
 *   matched scope, and the rule's reason. `explanation.excluded` remains
 *   extraction-stage data only (self-reference / malformed-marker /
 *   unparseable) and never carries withhold deferrals.
 */
import { describe, expect, it } from "vitest";

import { plan } from "../../src/planner/assemble.js";
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
// sibling suites' idiom. Digest letters: every lowercase a–z and digit 0–9
// is already claimed by the sibling suites, so this suite claims the
// uppercase block.
// ---------------------------------------------------------------------------

const COMMITTED_AT = "2026-01-01T00:00:00Z";

/** One fixed digest per scenario — opaque content identity (invariant 4). */
const DIGEST_M08 = "sha256:" + "A".repeat(64);
const DIGEST_PL07 = "sha256:" + "C".repeat(64);
const DIGEST_PL07_UNFROZEN = "sha256:" + "D".repeat(64);
const DIGEST_PL07_ALL = "sha256:" + "E".repeat(64);
const DIGEST_LC = "sha256:" + "F".repeat(64);
const DIGEST_BIND = "sha256:" + "G".repeat(64);

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

/** One line's assembled plan line, found by id among the plan's lines. */
function planLineFor(outcome: PlanningOutcome, lineId: string): PlanLine {
  const found = plannedOf(outcome).plan.lines.find((entry) => entry.lineId === lineId);
  if (found === undefined) {
    throw new Error(`fixture broken: line ${lineId} assembles no plan line`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// M-08 — per-line policies: the rc stream mints on main while the
// stable-only line records the refused demand and still mints its own
// stable patch in the same pass
// ---------------------------------------------------------------------------

function m08Input(opts: { readonly demandOn19?: boolean } = {}): PlanningInput {
  const demandOn19 = opts.demandOn19 ?? true;
  return buildInput({
    digest: DIGEST_M08,
    lines: [
      {
        ...line("main", "main", { major: 2 }),
        streams: { allow: ["rc"], seed: "1" },
        publishes: "app",
      },
      {
        ...line("1.9", "feed/1.9", { major: 1, minor: 9 }),
        streams: { allow: "none" },
        publishes: "lib",
      },
    ],
    commits: [
      commit("m08-c1", "feat: the main line", { containingRefs: ["main"] }),
      commit("m08-b", "feat: the plugin surface", {
        parents: ["m08-c1"],
        containingRefs: ["main"],
      }),
      commit("m08-c2", "feat: the 1.9 line", { containingRefs: ["feed/1.9"] }),
      commit("m08-fix", "fix: the stable-only fix", {
        parents: ["m08-c2"],
        containingRefs: ["feed/1.9"],
      }),
    ],
    refs: [ref("main", "m08-b"), ref("feed/1.9", "m08-fix")],
    tags: [tag("2.3.0", "m08-c1"), tag("1.9.0", "m08-c2")],
    components: [component("app", "2.3.0"), component("lib", "1.9.0")],
    intents: [
      { kind: "release" },
      { kind: "prerelease", stream: "rc", lineId: "main" },
      ...(demandOn19
        ? ([{ kind: "prerelease", stream: "rc", lineId: "1.9" }] as OperatorIntent[])
        : []),
    ],
  });
}

describe("M-08 through the door — the rc mint on main beside the stable patch", () => {
  it("mints the declared 2.4.0-rc.1, records the stable-only refusal, and releases 1.9.1 in one pass", () => {
    const outcome = plan(m08Input());
    // main's line policy admits the rc stream and seeds fresh keys at .1 —
    // the admissible demand suppresses the stable co-mint (D17(3)); the
    // stream is the publication (M-08's pointer transition: movesPointer).
    expect(decisionFor(outcome, "main")).toMatchObject({
      kind: "release",
      bump: "minor",
      range: { lineId: "main", releasedUpTo: "m08-c1", head: "m08-b" },
    });
    const mainLine = planLineFor(outcome, "main");
    expect(mainLine.stable).toBeNull();
    expect(mainLine.streams).toHaveLength(1);
    const stream = mainLine.streams[0];
    if (stream === undefined) {
      throw new Error("fixture broken: the rc stream must be planned");
    }
    expect(stream).toMatchObject({
      identifier: "rc",
      tag: "2.4.0-rc.1",
      seed: "1",
      movesPointer: true,
    });
    expect(stream.version.toString()).toBe("2.4.0-rc.1");
    expect(mainLine.changes).toEqual([
      { id: "m08-b", lineage: ["m08-b"], type: "feat", bump: "minor" },
    ]);
    // The operator's rc demand on the stable-only line is a recorded refusal
    // naming the declared posture — never an exception, never a fallback.
    const assembled = plannedOf(outcome).plan;
    expect(assembled.refusedIntents).toEqual([
      {
        intent: { kind: "prerelease", stream: "rc", lineId: "1.9" },
        lineId: "1.9",
        reason: `line 1.9 is stable-only — the line's declared stream policy admits no prerelease streams (D18)`,
      },
    ]);
    // The refusal never suppressed the line's own release: 1.9.1 mints in
    // the same pass, and both lines propagate — each bound to its declared
    // component through the one plan-level propagation.
    expect(decisionFor(outcome, "1.9")).toMatchObject({
      kind: "release",
      bump: "patch",
      range: { lineId: "1.9", releasedUpTo: "m08-c2", head: "m08-fix" },
    });
    const libLine = planLineFor(outcome, "1.9");
    expect(libLine.stable).toEqual({ version: "1.9.1", tag: "1.9.1" });
    expect(libLine.streams).toEqual([]);
    expect(libLine.changes).toEqual([
      { id: "m08-fix", lineage: ["m08-fix"], type: "fix", bump: "patch" },
    ]);
    expect(assembled.lines.map((entry) => entry.lineId)).toEqual(["main", "1.9"]);
    expect(mainLine.propagation.edges).toEqual([]);
    expect(mainLine.propagation.order).toEqual(expect.arrayContaining(["app", "lib"]));
    expect(libLine.propagation).toEqual(mainLine.propagation);
  });

  it("is double-run identical — planId and refusedIntents included, and the refusal is plan content", () => {
    const first = plan(m08Input());
    const second = plan(m08Input());
    // §2.14 purity: the whole outcome — the refusal record among it —
    // reproduces bit for bit.
    expect(second).toEqual(first);
    const firstPlan = plannedOf(first).plan;
    const secondPlan = plannedOf(second).plan;
    expect(secondPlan.planId).toBe(firstPlan.planId);
    expect(secondPlan.refusedIntents).toEqual(firstPlan.refusedIntents);
    expect(firstPlan.planId).toMatch(/^plan_sha256:[0-9a-f]{64}$/);
    // The fingerprint covers refusals: the same world minus the refused
    // demand plans identically for both lines but fingerprints differently —
    // requested-but-refused is plan content, not ambient operator state.
    const steady = plannedOf(plan(m08Input({ demandOn19: false }))).plan;
    expect(steady.refusedIntents).toEqual([]);
    expect(steady.planId).not.toBe(firstPlan.planId);
    expect(steady.lines.map((entry) => entry.lineId)).toEqual(["main", "1.9"]);
  });
});

// ---------------------------------------------------------------------------
// PL-07 — the withhold deferral: the release range pins below the earliest
// withheld commit, the released prefix carries only surviving changes, and
// an unfreeze releases the deferred commit (deferral, not deletion)
// ---------------------------------------------------------------------------

function pl07Input(digest: string, opts: { readonly withhold: boolean }): PlanningInput {
  return buildInput({
    digest,
    lines: [
      opts.withhold
        ? {
            ...line("1.9", "feed/1.9", { major: 1, minor: 9 }),
            withhold: [{ scope: "app", reason: "app is frozen on the 1.9 line" }],
          }
        : line("1.9", "feed/1.9", { major: 1, minor: 9 }),
    ],
    commits: [
      commit("pl7-c1", "feat: the 1.9 line", { containingRefs: ["feed/1.9"] }),
      commit("pl7-cli", "fix(cli): the released-prefix fix", {
        parents: ["pl7-c1"],
        containingRefs: ["feed/1.9"],
      }),
      commit("pl7-app", "fix(app): the withheld fix", {
        parents: ["pl7-cli"],
        containingRefs: ["feed/1.9"],
      }),
    ],
    refs: [ref("feed/1.9", "pl7-app")],
    tags: [tag("1.9.0", "pl7-c1")],
    components: [component("release-craft", "1.9.0")],
    intents: [{ kind: "release" }],
  });
}

describe("PL-07 through the door — the withheld commit pins the range, the unfreeze releases it", () => {
  it("releases only the surviving prefix with the range head pinned below the withheld commit", () => {
    const outcome = plan(pl07Input(DIGEST_PL07, { withhold: true }));
    // The earliest withheld commit (pl7-app) bounds the release: releasedUpTo
    // stands, head pins at the withheld commit's parent, and the change set
    // carries only the surviving cli fix — the app fix defers, never deletes.
    const decision = decisionFor(outcome, "1.9");
    expect(decision).toMatchObject({
      kind: "release",
      bump: "patch",
      range: { lineId: "1.9", releasedUpTo: "pl7-c1", head: "pl7-cli" },
    });
    expect(decision.detail).toContain("pins below the earliest withheld commit pl7-app");
    expect(decision.detail).toContain("stay inside the un-released span");
    const minted = planLineFor(outcome, "1.9");
    expect(minted.stable).toEqual({ version: "1.9.1", tag: "1.9.1" });
    expect(minted.changes).toEqual([
      { id: "pl7-cli", lineage: ["pl7-cli"], type: "fix", bump: "patch" },
    ]);
    // The withheld surface is two-fold (D18, PL-07): the decision record
    // carries the raw commits, and the plan's persisted explanation curates
    // the deferral — line, matched scope, the rule's reason — so a stored
    // plan shows what is waiting. excluded (extraction-stage) stays empty.
    expect(plannedOf(outcome).plan.explanation.excluded).toEqual([]);
    expect(plannedOf(outcome).plan.explanation.withheld).toEqual([
      {
        lineId: "1.9",
        sha: "pl7-app",
        scope: "app",
        reason: "app is frozen on the 1.9 line",
      },
    ]);
  });

  it("releases the deferred commit once the withhold rule is removed — the range advances past it", () => {
    const outcome = plan(pl07Input(DIGEST_PL07_UNFROZEN, { withhold: false }));
    // Recoverability: the deferral kept the app fix inside the un-released
    // span, so the unfrozen pass sweeps it — the range now advances to the
    // line tip and both fixes release.
    const decision = decisionFor(outcome, "1.9");
    expect(decision).toMatchObject({
      kind: "release",
      bump: "patch",
      range: { lineId: "1.9", releasedUpTo: "pl7-c1", head: "pl7-app" },
    });
    expect(
      plannedOf(outcome).plan.lines.map((entry) => entry.changes.map((change) => change.id)),
    ).toEqual([["pl7-cli", "pl7-app"]]);
  });
});

// ---------------------------------------------------------------------------
// PL-07 all-withheld — nothing release-worthy survives the rules: the
// withheld record enumerates the deferred set, no plan line, and an
// admissible stream demand composes to nothing
// ---------------------------------------------------------------------------

describe("PL-07 through the door — the line withheld whole beside an admissible stream demand", () => {
  it("yields the withheld record enumerating the commits, no plan line, no stream, no refusal record", () => {
    const outcome = plan(
      buildInput({
        digest: DIGEST_PL07_ALL,
        lines: [
          {
            ...line("1.9", "feed/1.9", { major: 1, minor: 9 }),
            withhold: [{ scope: "app", reason: "app is frozen on the 1.9 line" }],
          },
        ],
        commits: [
          commit("wh1-c1", "feat: the 1.9 line", { containingRefs: ["feed/1.9"] }),
          commit("wh1-f1", "fix(app): the first deferred fix", {
            parents: ["wh1-c1"],
            containingRefs: ["feed/1.9"],
          }),
          commit("wh1-f2", "fix(app): the second deferred fix", {
            parents: ["wh1-f1"],
            containingRefs: ["feed/1.9"],
          }),
          // A release-worthy commit after the earliest withheld one defers
          // with it — the natural consequence of range pinning — while the
          // withheld enumeration stays scoped to the rule-matching set.
          commit("wh1-g", "feat(cli): the cli feature", {
            parents: ["wh1-f2"],
            containingRefs: ["feed/1.9"],
          }),
        ],
        refs: [ref("feed/1.9", "wh1-g")],
        tags: [tag("1.9.0", "wh1-c1")],
        intents: [{ kind: "release" }, { kind: "prerelease", stream: "rc", lineId: "1.9" }],
      }),
    );
    const decision = decisionFor(outcome, "1.9");
    expect(decision).toMatchObject({
      kind: "withheld",
      cause: "policy-filter",
      lineId: "1.9",
      withheld: [{ sha: "wh1-f1" }, { sha: "wh1-f2" }],
    });
    expect(decision.detail).toContain(`wh1-f1 (fix): "app is frozen on the 1.9 line"`);
    expect(decision.detail).toContain("deferred inside the un-released span, never deleted");
    // The composition gate: the withheld line contributes no plan line at
    // all — the admissible rc demand is not a refusal record and mints no
    // stream, so no stream version for the line exists anywhere in the plan.
    const assembled = plannedOf(outcome).plan;
    expect(assembled.lines).toEqual([]);
    expect(assembled.refusedIntents).toEqual([]);
    // The persisted explanation carries the whole deferred set, curated
    // with the matched scope and the rule's reason (D18, PL-07) — the
    // stored plan shows what is waiting, in input order.
    expect(assembled.explanation.withheld).toEqual([
      {
        lineId: "1.9",
        sha: "wh1-f1",
        scope: "app",
        reason: "app is frozen on the 1.9 line",
      },
      {
        lineId: "1.9",
        sha: "wh1-f2",
        scope: "app",
        reason: "app is frozen on the 1.9 line",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle — the per-line refusals (line-frozen / line-retired) compose
// beside an active line: the decision record is the refused line's whole
// presence, refused-posture stream demands still record, admissible ones
// compose to nothing
// ---------------------------------------------------------------------------

describe("the lifecycle goldens through the door — refusals per line, the plan unaffected", () => {
  it("refuses the frozen and retired lines by record and plans the active line in the same pass", () => {
    const outcome = plan(
      buildInput({
        digest: DIGEST_LC,
        lines: [
          {
            ...line("1.x", "feed/1.x", { major: 1 }),
            lifecycle: "frozen",
            streams: { allow: "none" },
          },
          { ...line("2.x", "feed/2.x", { major: 2 }), lifecycle: "frozen" },
          { ...line("3.x", "feed/3.x", { major: 3 }), lifecycle: "retired" },
          line("main", "main", { major: 4 }),
        ],
        commits: [
          commit("lc-1a", "feat: the 1.x line", { containingRefs: ["feed/1.x"] }),
          commit("lc-1f", "fix: late work on the frozen line", {
            parents: ["lc-1a"],
            containingRefs: ["feed/1.x"],
          }),
          commit("lc-2a", "feat: the 2.x line", { containingRefs: ["feed/2.x"] }),
          commit("lc-2f", "fix: late work on the second frozen line", {
            parents: ["lc-2a"],
            containingRefs: ["feed/2.x"],
          }),
          commit("lc-3a", "feat: the 3.x line", { containingRefs: ["feed/3.x"] }),
          commit("lc-3f", "fix: late work on the retired line", {
            parents: ["lc-3a"],
            containingRefs: ["feed/3.x"],
          }),
          commit("lc-ma", "feat: the main line", { containingRefs: ["main"] }),
          commit("lc-mf", "feat: the main feature", {
            parents: ["lc-ma"],
            containingRefs: ["main"],
          }),
        ],
        refs: [
          ref("feed/1.x", "lc-1f"),
          ref("feed/2.x", "lc-2f"),
          ref("feed/3.x", "lc-3f"),
          ref("main", "lc-mf"),
        ],
        components: [component("release-craft", "4.0.0")],
        tags: [
          tag("1.0.0", "lc-1a"),
          tag("2.0.0", "lc-2a"),
          tag("3.0.0", "lc-3a"),
          tag("4.0.0", "lc-ma"),
        ],
        intents: [
          { kind: "release" },
          { kind: "prerelease", stream: "rc", lineId: "1.x" },
          { kind: "prerelease", stream: "rc", lineId: "2.x" },
          { kind: "prerelease", stream: "rc", lineId: "3.x" },
        ],
      }),
    );
    // The frozen line's refused record names the state; its rc demand rides
    // the declared stable-only posture, so D18 Decision 1 (stream posture)
    // and Decision 2 (lifecycle refusal) compose independently — the posture
    // record stands even though the line refuses planning outright.
    expect(decisionFor(outcome, "1.x")).toMatchObject({
      kind: "refused",
      cause: "line-frozen",
      lineId: "1.x",
      policyDigest: DIGEST_LC,
    });
    expect(decisionFor(outcome, "1.x").detail).toContain(`line "1.x" is frozen`);
    // The second frozen line carries no stream declaration (allow-all), so
    // its rc demand is admissible and composes to nothing — no refusal
    // record; the lifecycle refusal itself is unchanged.
    expect(decisionFor(outcome, "2.x")).toMatchObject({
      kind: "refused",
      cause: "line-frozen",
      lineId: "2.x",
    });
    expect(decisionFor(outcome, "2.x").detail).toContain(`line "2.x" is frozen`);
    expect(decisionFor(outcome, "3.x")).toMatchObject({
      kind: "refused",
      cause: "line-retired",
      lineId: "3.x",
    });
    expect(decisionFor(outcome, "3.x").detail).toContain(`line "3.x" is retired`);
    // The refusals are per-line: the active line plans normally in the same
    // pass, and the refused lines contribute no plan line — no targets, no
    // streams, so no stream version for them exists anywhere in the plan.
    expect(decisionFor(outcome, "main")).toMatchObject({ kind: "release", bump: "minor" });
    const assembled = plannedOf(outcome).plan;
    expect(assembled.lines.map((entry) => entry.lineId)).toEqual(["main"]);
    const minted = planLineFor(outcome, "main");
    expect(minted.stable).toEqual({ version: "4.1.0", tag: "4.1.0" });
    expect(assembled.lines.flatMap((entry) => entry.streams)).toEqual([]);
    expect(assembled.refusedIntents).toEqual([
      {
        intent: { kind: "prerelease", stream: "rc", lineId: "1.x" },
        lineId: "1.x",
        reason: `line 1.x is stable-only — the line's declared stream policy admits no prerelease streams (D18)`,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The declared publishes binding (D18 Decision 4) — two releasing lines each
// bound to their own declared component, and the negative: a world that lost
// one binding is refused, naming the line and the gap
// ---------------------------------------------------------------------------

function bindInput(): PlanningInput {
  return buildInput({
    digest: DIGEST_BIND,
    lines: [
      { ...line("2.x", "main", { major: 2 }), publishes: "core" },
      { ...line("1.9", "feed/1.9", { major: 1, minor: 9 }), publishes: "cli" },
    ],
    commits: [
      commit("bnd-2a", "feat: the 2.x line", { containingRefs: ["main"] }),
      commit("bnd-break", "feat!: break the core surface", {
        parents: ["bnd-2a"],
        containingRefs: ["main"],
      }),
      commit("bnd-19a", "feat: the 1.9 line", { containingRefs: ["feed/1.9"] }),
      commit("bnd-fix", "fix: the cli fix", {
        parents: ["bnd-19a"],
        containingRefs: ["feed/1.9"],
      }),
    ],
    refs: [ref("main", "bnd-break"), ref("feed/1.9", "bnd-fix")],
    tags: [tag("2.0.0", "bnd-2a"), tag("1.9.0", "bnd-19a")],
    components: [
      component("core", "2.0.0"),
      component("cli", "1.9.0", [{ name: "core", range: "^2.0.0" }]),
    ],
    intents: [{ kind: "release" }],
  });
}

describe("the binding goldens through the door — two lines, two declared components", () => {
  it("plans both lines and binds each release to its declared component through propagation", () => {
    const outcome = plan(bindInput());
    const assembled = plannedOf(outcome).plan;
    // Both releasing lines plan in one pass: the breaking change mints the
    // major on 2.x, the fix mints the patch on 1.9.
    expect(assembled.lines.map((entry) => entry.lineId)).toEqual(["2.x", "1.9"]);
    expect(decisionFor(outcome, "2.x")).toMatchObject({
      kind: "release",
      bump: "major",
      range: { lineId: "2.x", releasedUpTo: "bnd-2a", head: "bnd-break" },
    });
    expect(decisionFor(outcome, "1.9")).toMatchObject({
      kind: "release",
      bump: "patch",
      range: { lineId: "1.9", releasedUpTo: "bnd-19a", head: "bnd-fix" },
    });
    const coreLine = planLineFor(outcome, "2.x");
    const cliLine = planLineFor(outcome, "1.9");
    expect(coreLine.stable).toEqual({ version: "3.0.0", tag: "3.0.0" });
    expect(cliLine.stable).toEqual({ version: "1.9.1", tag: "1.9.1" });
    // The binding is the composition: core's declared line publishes 3.0.0,
    // which widens cli's declared ^2.0.0 — both declared components appear
    // in the one plan-level propagation riding every assembled line.
    expect(coreLine.propagation).toEqual({
      edges: [{ from: "core", to: "cli", reason: "range-widening" }],
      order: ["core", "cli"],
      notMoved: [],
    });
    expect(cliLine.propagation).toEqual(coreLine.propagation);
  });

  it("refuses the world that lost one binding, naming the line and the mapping gap", () => {
    const world = bindInput();
    const stripped = {
      ...world,
      lines: world.lines.map((config) => {
        if (config.id !== "1.9") {
          return config;
        }
        const { publishes: _omit, ...rest } = config;
        return rest;
      }),
    };
    // The declaration is the dissolve: in a world the one-component posture
    // cannot carry, the releasing line without it is the fabrication the
    // door refuses — the same exception, naming the line and the gap.
    const attempt = (): PlanningOutcome => plan(stripped);
    expect(attempt).toThrow(InvalidPlanningInputError);
    expect(attempt).toThrow(/"1\.9"/);
    expect(attempt).toThrow(/publishes/);
    expect(attempt).toThrow(/line↔component release mapping/);
  });
});
