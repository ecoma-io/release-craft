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
const DIGEST_M10_RENAME = "sha256:" + "H".repeat(64);
const DIGEST_M10_RETIRE = "sha256:" + "I".repeat(64);
const DIGEST_ATK6 = "sha256:" + "J".repeat(64);
const DIGEST_ATK7 = "sha256:" + "K".repeat(64);
const DIGEST_ATK8 = "sha256:" + "L".repeat(64);

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

// ---------------------------------------------------------------------------
// M-10 — the rename half: the line's id and feed ref carry the new name
// ("1.9-lts") while the history keeps the 1.9.x tags — the release resolves
// from the line's own tags regardless of the name
// ---------------------------------------------------------------------------

describe("M-10 through the door — the renamed line releases normally", () => {
  it("releases 1.9.1 on the renamed line, resolved from its own 1.9.x tags", () => {
    const outcome = plan(
      buildInput({
        digest: DIGEST_M10_RENAME,
        lines: [line("1.9-lts", "feed/1.9-lts", { major: 1, minor: 9 })],
        commits: [
          commit("m10r-base", "feat: the 1.9 line", { containingRefs: ["feed/1.9-lts"] }),
          commit("m10r-fix", "fix: the lts fix", {
            parents: ["m10r-base"],
            containingRefs: ["feed/1.9-lts"],
          }),
        ],
        refs: [ref("feed/1.9-lts", "m10r-fix")],
        tags: [tag("1.9.0", "m10r-base")],
        components: [component("release-craft", "1.9.0")],
        intents: [{ kind: "release" }],
      }),
    );
    // The rename is an input-level observation: the line id and feed ref
    // carry the new name while the tags stay 1.9.x — the base resolves from
    // the line's own tag regardless of the name, and the line releases
    // normally (M-10: rename → release 1.9-lts normally, 1.9.1).
    expect(decisionFor(outcome, "1.9-lts")).toMatchObject({
      kind: "release",
      bump: "patch",
      range: { lineId: "1.9-lts", releasedUpTo: "m10r-base", head: "m10r-fix" },
    });
    const renamed = planLineFor(outcome, "1.9-lts");
    expect(renamed.stable).toEqual({ version: "1.9.1", tag: "1.9.1" });
    expect(renamed.changes).toEqual([
      { id: "m10r-fix", lineage: ["m10r-fix"], type: "fix", bump: "patch" },
    ]);
    expect(plannedOf(outcome).plan.lines.map((entry) => entry.lineId)).toEqual(["1.9-lts"]);
  });
});

// ---------------------------------------------------------------------------
// M-10 — the retire half: the retired line's decision record is a refusal
// whose range still names the pending span (the withheld commit at its
// head), and no plan line, target, or stream results for it — the global
// release demand never mints
// ---------------------------------------------------------------------------

describe("M-10 through the door — the retired line withholds its pending release-worthy commit", () => {
  it("records the refusal carrying the pending commit and mints nothing for the line", () => {
    const outcome = plan(
      buildInput({
        digest: DIGEST_M10_RETIRE,
        lines: [{ ...line("1.9", "feed/1.9", { major: 1, minor: 9 }), lifecycle: "retired" }],
        commits: [
          commit("m10q-base", "feat: the 1.9 line", { containingRefs: ["feed/1.9"] }),
          commit("m10q-f", "fix: the pending fix the retirement withholds", {
            parents: ["m10q-base"],
            containingRefs: ["feed/1.9"],
          }),
        ],
        refs: [ref("feed/1.9", "m10q-f")],
        tags: [tag("1.9.0", "m10q-base")],
        intents: [{ kind: "release" }],
      }),
    );
    // Retire → no release; F withheld (M-10): the refusal record still
    // scopes the pending span — the released bound stands at the tag, the
    // head names the withheld commit — while release-shaped planning
    // refuses outright.
    expect(decisionFor(outcome, "1.9")).toMatchObject({
      kind: "refused",
      cause: "line-retired",
      lineId: "1.9",
      policyDigest: DIGEST_M10_RETIRE,
      range: { lineId: "1.9", releasedUpTo: "m10q-base", head: "m10q-f" },
    });
    expect(decisionFor(outcome, "1.9").detail).toContain(`line "1.9" is retired`);
    expect(decisionFor(outcome, "1.9").detail).toContain(
      "no targets, no streams, no release entry",
    );
    // The refusal record is the retired line's whole presence: no plan
    // line, no target, no stream, and no per-line refusal record — the
    // release demand never mints.
    const assembled = plannedOf(outcome).plan;
    expect(assembled.lines).toEqual([]);
    expect(assembled.refusedIntents).toEqual([]);
    expect(plannedOf(outcome).decisions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Attack 6 — all-deferred: the withhold rule matches every release-worthy
// commit, the breaking one included, beside a docs commit — everything
// defers, nothing mints, and the un-released span keeps the whole set
// ---------------------------------------------------------------------------

describe("the all-deferred attack through the door — nothing release-worthy survives the rules", () => {
  it("yields the withheld record enumerating the breaking commit and the fix, no plan line, no no-op", () => {
    const outcome = plan(
      buildInput({
        digest: DIGEST_ATK6,
        lines: [
          {
            ...line("1.9", "feed/1.9", { major: 1, minor: 9 }),
            withhold: [{ scope: "api", reason: "api is frozen for the migration window" }],
          },
        ],
        commits: [
          commit("atk6-base", "feat: the 1.9 line", { containingRefs: ["feed/1.9"] }),
          // The breaking commit is the earliest withheld one: the major
          // driver defers, so nothing mints — range pinning defers the
          // later fix along with it, and the docs commit at the tip is
          // not release-triggering and stays inside the un-released span.
          commit("atk6-brk", "feat(api)!: break the wire protocol", {
            parents: ["atk6-base"],
            containingRefs: ["feed/1.9"],
          }),
          commit("atk6-fix", "fix(api): the deferred fix", {
            parents: ["atk6-brk"],
            containingRefs: ["feed/1.9"],
          }),
          commit("atk6-docs", "docs: the frozen-window note", {
            parents: ["atk6-fix"],
            containingRefs: ["feed/1.9"],
          }),
        ],
        refs: [ref("feed/1.9", "atk6-docs")],
        tags: [tag("1.9.0", "atk6-base")],
        intents: [{ kind: "release" }],
      }),
    );
    // The withheld enumeration is scoped to the rule-matching release-worthy
    // set: the breaking feat and the fix defer — the docs commit is
    // policy-ignored, never enumerated, and the withheld record replaces
    // both a mint and a no-op.
    const decision = decisionFor(outcome, "1.9");
    expect(decision).toMatchObject({
      kind: "withheld",
      cause: "policy-filter",
      lineId: "1.9",
      policyDigest: DIGEST_ATK6,
      withheld: [{ sha: "atk6-brk" }, { sha: "atk6-fix" }],
    });
    expect(decision.detail).toContain(`atk6-brk (feat): "api is frozen for the migration window"`);
    expect(decision.detail).toContain(`atk6-fix (fix): "api is frozen for the migration window"`);
    expect(decision.detail).toContain("deferred inside the un-released span, never deleted");
    const assembled = plannedOf(outcome).plan;
    expect(assembled.lines).toEqual([]);
    expect(assembled.refusedIntents).toEqual([]);
    expect(plannedOf(outcome).decisions).toHaveLength(1);
    // The persisted explanation carries the whole deferred set, curated
    // with the matched scope and the rule's reason (D18, PL-07).
    expect(assembled.explanation.withheld).toEqual([
      {
        lineId: "1.9",
        sha: "atk6-brk",
        scope: "api",
        reason: "api is frozen for the migration window",
      },
      {
        lineId: "1.9",
        sha: "atk6-fix",
        scope: "api",
        reason: "api is frozen for the migration window",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Attack 7 — the retired line under both demand shapes: the release-shaped
// demand lands on the line-retired decision record, the prerelease demand
// records per the declared stream posture, and neither fabricates a target
// or a stream
// ---------------------------------------------------------------------------

describe("the retired-line attack through the door — both demand shapes record, neither mints", () => {
  it("records the release refusal and the stable-only posture refusal, fabricating no target or stream", () => {
    const outcome = plan(
      buildInput({
        digest: DIGEST_ATK7,
        lines: [
          {
            ...line("1.9", "feed/1.9", { major: 1, minor: 9 }),
            lifecycle: "retired",
            streams: { allow: "none" },
          },
        ],
        commits: [
          commit("atk7-base", "feat: the 1.9 line", { containingRefs: ["feed/1.9"] }),
          commit("atk7-f", "fix: the pending fix on the retired line", {
            parents: ["atk7-base"],
            containingRefs: ["feed/1.9"],
          }),
        ],
        refs: [ref("feed/1.9", "atk7-f")],
        tags: [tag("1.9.0", "atk7-base")],
        intents: [{ kind: "release" }, { kind: "prerelease", stream: "rc", lineId: "1.9" }],
      }),
    );
    // The release-shaped demand's refusal is the line-retired record; the
    // prerelease demand rides the declared stable-only posture — D18
    // decisions 1 and 2 compose independently on the refused line.
    expect(decisionFor(outcome, "1.9")).toMatchObject({
      kind: "refused",
      cause: "line-retired",
      lineId: "1.9",
      policyDigest: DIGEST_ATK7,
    });
    expect(plannedOf(outcome).plan.refusedIntents).toEqual([
      {
        intent: { kind: "prerelease", stream: "rc", lineId: "1.9" },
        lineId: "1.9",
        reason: `line 1.9 is stable-only — the line's declared stream policy admits no prerelease streams (D18)`,
      },
    ]);
    // Neither demand fabricates anything: the refusal record is the line's
    // whole presence — no plan line, no target, no stream.
    expect(plannedOf(outcome).plan.lines).toEqual([]);
    expect(plannedOf(outcome).decisions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Attack 8 — the binding-alias gap: two releasing lines whose declared
// publishes name the SAME component — the mapping is ambiguous and the
// door refuses, naming the declared component and both colliding lines
// (D18 decision 4 posture; the alias variant the two-component goldens and
// the lost-binding negative do not cover)
// ---------------------------------------------------------------------------

describe("the binding-alias attack through the door — one declared component, two releasing lines", () => {
  it("refuses the ambiguous mapping, naming the shared component and both colliding lines", () => {
    const world = buildInput({
      digest: DIGEST_ATK8,
      lines: [
        { ...line("2.x", "main", { major: 2 }), publishes: "app" },
        { ...line("1.9", "feed/1.9", { major: 1, minor: 9 }), publishes: "app" },
      ],
      commits: [
        commit("atk8-2a", "feat: the 2.x line", { containingRefs: ["main"] }),
        commit("atk8-break", "feat!: break the app surface", {
          parents: ["atk8-2a"],
          containingRefs: ["main"],
        }),
        commit("atk8-19a", "feat: the 1.9 line", { containingRefs: ["feed/1.9"] }),
        commit("atk8-fix", "fix: the 1.9 fix", {
          parents: ["atk8-19a"],
          containingRefs: ["feed/1.9"],
        }),
      ],
      refs: [ref("main", "atk8-break"), ref("feed/1.9", "atk8-fix")],
      tags: [tag("2.0.0", "atk8-2a"), tag("1.9.0", "atk8-19a")],
      components: [component("app", "2.0.0")],
      intents: [{ kind: "release" }],
    });
    // Both lines release (major on 2.x, patch on 1.9), so the binding sees
    // two releases claiming one declared component — a declared component
    // carries one release per pass, and the ambiguity is the door's
    // refusal naming the component and both lines, never a fabricated
    // mapping.
    const attempt = (): PlanningOutcome => plan(world);
    expect(attempt).toThrow(InvalidPlanningInputError);
    expect(attempt).toThrow(/both bind their releases to component "app"/);
    expect(attempt).toThrow(/"2\.x"/);
    expect(attempt).toThrow(/"1\.9"/);
    expect(attempt).toThrow(/the mapping is ambiguous/);
    expect(attempt).toThrow(/publishes/);
  });
});
