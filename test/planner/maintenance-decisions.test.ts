/**
 * Scenario golden suite for the multi-line decision level, through the door
 * `plan()` (src/planner/assemble.ts): the M-row decision goldens G-3..G-9 —
 * M-01, M-02, M-03, M-04, M-05, M-06, and M-09 (Table 1,
 * docs/design/phase2-planner-contract.md §5). The attribution mechanics
 * underneath (ancestry attribution, cherry-pick identity, surfaced identity
 * conflicts, releasedness per (line, change)) are pinned in golden.test.ts /
 * extract.adversarial.test.ts / attribute.adversarial.test.ts; this suite
 * pins each row's DECISION-level expectation — the decision records and the
 * minted versions, quote-faithful to the contract's "Expected release
 * decision" and "Expected versions" columns — so the assertions here read
 * plan and decision records only.
 *
 * Fixture posture:
 * - The door releases every line whose own evaluated range carries
 *   release-worthy pending work in one pass, so each row's world is shaped
 *   so the one pass produces exactly the row's expected decision. M-04's
 *   "release 1.9 only" rides the scenario's own timeline: the backport F′
 *   is released while F is still pending for main's next release (F rides
 *   the maintainer's pre-merge ref; main's feed head is still the 2.3.0
 *   cut) — M-09 is the later moment where F reaches main.
 * - M-02 and M-03 release three lines in one pass, so each releasing line
 *   declares `publishes` to its own component ("app" / "web" / "cli") —
 *   three releasing lines over one declared component is the ambiguous
 *   mapping the door refuses (D18 decision 4). The single-release rows
 *   (M-01, M-04, M-05, M-06, M-09) use the D17(8) single-component posture.
 * - M-01's maintenance feed ref is deliberately named `lts` — nothing in
 *   the ref name says 1.9 — so the fix's line membership can only come
 *   from ancestry inside the line's own range, never from the ref name.
 * - Digest letters: every lowercase a–z letter and digit is claimed by the
 *   sibling suites and uppercase A–G by line-policy.test.ts, so this suite
 *   claims the uppercase H–N block.
 */
import { describe, expect, it } from "vitest";

import { plan } from "@ecoma-io/release-craft/__internal__/planner/assemble.js";
import type {
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
} from "@ecoma-io/release-craft/__internal__/planner/types.js";

// ---------------------------------------------------------------------------
// Fixture builders — deterministic, closed inputs per §2.1, mirroring the
// sibling suites' idiom.
// ---------------------------------------------------------------------------

const COMMITTED_AT = "2026-01-01T00:00:00Z";

/** One fixed digest per scenario — opaque content identity (invariant 4). */
const DIGEST_M01 = "sha256:" + "H".repeat(64);
const DIGEST_M02 = "sha256:" + "I".repeat(64);
const DIGEST_M03 = "sha256:" + "J".repeat(64);
const DIGEST_M04 = "sha256:" + "K".repeat(64);
const DIGEST_M05 = "sha256:" + "L".repeat(64);
const DIGEST_M06 = "sha256:" + "M".repeat(64);
const DIGEST_M09 = "sha256:" + "N".repeat(64);

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

/** The cherry-pick provenance trailer of M-03/M-04/M-06/M-09's worlds. */
function cherryOf(origin: string, subject = "fix(parser): handle empty input"): string {
  return `${subject}\n\n(cherry picked from commit ${origin})`;
}

interface FixtureOptions {
  readonly digest: string;
  readonly lines: readonly LineConfig[];
  readonly commits: readonly CommitObservation[];
  readonly refs: readonly RefObservation[];
  readonly tags?: readonly TagObservation[];
  readonly components?: readonly ComponentMeta[];
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

/** One line's no-op record, narrowed so the `ignored` enumeration reads
 * typed — anything else fails the fixture, not an expect. */
function noOpFor(
  outcome: PlanningOutcome,
  lineId: string,
): Extract<LineDecision, { kind: "no-op" }> {
  const decision = decisionFor(outcome, lineId);
  if (decision.kind !== "no-op") {
    throw new Error(`fixture broken: line ${lineId} recorded ${decision.kind}, not a no-op`);
  }
  return decision;
}

// ---------------------------------------------------------------------------
// M-01 (G-3) — a fix on the maintenance line is not a main commit: the fix
// lands on line 1.9 by ancestry (the ref is deliberately not named after
// the line), main's empty effective change set records the no-op
// ---------------------------------------------------------------------------

function m01Input(): PlanningInput {
  return buildInput({
    digest: DIGEST_M01,
    lines: [line("main", "main", { major: 2 }), line("1.9", "lts", { major: 1, minor: 9 })],
    commits: [
      commit("m01-c3", "chore: keep main moving", { containingRefs: ["main"] }),
      commit("m01-c9", "chore: cut 1.9.0", { containingRefs: ["lts"] }),
      commit("m01-f", "fix(parser): handle empty input", {
        parents: ["m01-c9"],
        containingRefs: ["lts"],
      }),
    ],
    refs: [ref("main", "m01-c3"), ref("lts", "m01-f")],
    tags: [tag("2.3.0", "m01-c3"), tag("1.9.0", "m01-c9")],
    components: [component("app", "2.3.0")],
    intents: [{ kind: "release" }],
  });
}

describe("M-01 through the door — the fix lands on the maintenance line by ancestry, not by ref name", () => {
  it("releases 1.9.0 → 1.9.1 on line 1.9 and records main's empty effective change set as a no-op at 2.3.0", () => {
    const outcome = plan(m01Input());
    // The feed ref is named "lts" — the fix's membership in line 1.9 can
    // only come from ancestry inside the line's own range (the 1.9.0 tag's
    // commit to the line's head), never from the ref name.
    expect(decisionFor(outcome, "1.9")).toMatchObject({
      kind: "release",
      bump: "patch",
      range: { lineId: "1.9", releasedUpTo: "m01-c9", head: "m01-f" },
    });
    const line19 = planLineFor(outcome, "1.9");
    expect(line19.stable).toEqual({ version: "1.9.1", tag: "1.9.1" });
    expect(line19.changes).toEqual([
      { id: "m01-f", lineage: ["m01-f"], type: "fix", bump: "patch" },
    ]);
    // main is evaluated in the same pass and records the no-op: an empty
    // effective change set, nothing ignored, and no mint — the plan's only
    // line entry is 1.9's, so main remains 2.3.0.
    const main = noOpFor(outcome, "main");
    expect(main.cause).toBe("no-release-worthy-changes");
    expect(main.range).toEqual({ lineId: "main", releasedUpTo: "m01-c3", head: "m01-c3" });
    expect(main.ignored).toEqual([]);
    expect(plannedOf(outcome).plan.lines.map((entry) => entry.lineId)).toEqual(["1.9"]);
  });
});

// ---------------------------------------------------------------------------
// M-02 (G-4) — three active lines release independently: one pass, three
// plain release decisions (1.9.1 / 2.2.4 / 2.4.0), none depending on or
// blocking another; each releasing line declares its own component
// ---------------------------------------------------------------------------

function m02Input(): PlanningInput {
  return buildInput({
    digest: DIGEST_M02,
    lines: [
      // main rides the band-absent single-namespace idiom (the vertical
      // matrix's rolling line): its declared major-2 band overlapped 2.2's
      // pinned 2.2 band — issue #272's ambiguous configuration, refused by
      // the input door since D66 — while the scenario never needed it (the
      // pointers come from tags on main's own branch).
      { ...line("main", "main"), publishes: "app" },
      { ...line("2.2", "rel/2.2", { major: 2, minor: 2 }), publishes: "web" },
      { ...line("1.9", "rel/1.9", { major: 1, minor: 9 }), publishes: "cli" },
    ],
    commits: [
      commit("m02-c3", "chore: cut 2.3.0", { containingRefs: ["main"] }),
      commit("m02-f3", "feat: the batch export", {
        parents: ["m02-c3"],
        containingRefs: ["main"],
      }),
      commit("m02-d3", "chore: cut 2.2.3", { containingRefs: ["rel/2.2"] }),
      commit("m02-f2", "fix(web): survive a malformed payload", {
        parents: ["m02-d3"],
        containingRefs: ["rel/2.2"],
      }),
      commit("m02-c9", "chore: cut 1.9.0", { containingRefs: ["rel/1.9"] }),
      commit("m02-f1", "fix(cli): quote the path", {
        parents: ["m02-c9"],
        containingRefs: ["rel/1.9"],
      }),
    ],
    refs: [ref("main", "m02-f3"), ref("rel/2.2", "m02-f2"), ref("rel/1.9", "m02-f1")],
    tags: [tag("2.3.0", "m02-c3"), tag("2.2.3", "m02-d3"), tag("1.9.0", "m02-c9")],
    components: [component("app", "2.3.0"), component("web", "2.2.3"), component("cli", "1.9.0")],
    intents: [{ kind: "release" }],
  });
}

describe("M-02 through the door — three active lines release independently in one pass", () => {
  it("records three plain release decisions — 1.9.1 (fix), 2.2.4 (fix), 2.4.0 (feat) — none blocking another", () => {
    const outcome = plan(m02Input());
    const assembled = plannedOf(outcome).plan;
    // All three decisions are present in the one outcome, each a plain
    // release from its own line range: no refusal, no block, no hold on a
    // sibling line's outcome.
    expect(plannedOf(outcome).decisions).toHaveLength(3);
    expect(decisionFor(outcome, "main")).toMatchObject({
      kind: "release",
      bump: "minor",
      range: { lineId: "main", releasedUpTo: "m02-c3", head: "m02-f3" },
    });
    expect(decisionFor(outcome, "2.2")).toMatchObject({
      kind: "release",
      bump: "patch",
      range: { lineId: "2.2", releasedUpTo: "m02-d3", head: "m02-f2" },
    });
    expect(decisionFor(outcome, "1.9")).toMatchObject({
      kind: "release",
      bump: "patch",
      range: { lineId: "1.9", releasedUpTo: "m02-c9", head: "m02-f1" },
    });
    // Each line mints its own next version from its own pointer — the
    // three pointers move independently in the same pass.
    expect(planLineFor(outcome, "main").stable).toEqual({ version: "2.4.0", tag: "2.4.0" });
    expect(planLineFor(outcome, "2.2").stable).toEqual({ version: "2.2.4", tag: "2.2.4" });
    expect(planLineFor(outcome, "1.9").stable).toEqual({ version: "1.9.1", tag: "1.9.1" });
    expect(assembled.lines.map((entry) => entry.lineId)).toEqual(["main", "2.2", "1.9"]);
  });
});

// ---------------------------------------------------------------------------
// M-03 (G-5) — one logical fix on three lines: F authored on main, cherry-
// picked to 2.2 and 1.9; the cherry-pick identity makes all three the same
// logical change, listed exactly once per line, release-worthy on each
// ---------------------------------------------------------------------------

function m03Input(): PlanningInput {
  return buildInput({
    digest: DIGEST_M03,
    lines: [
      // main rides the band-absent single-namespace idiom (the vertical
      // matrix's rolling line): its declared major-2 band overlapped 2.2's
      // pinned 2.2 band — issue #272's ambiguous configuration, refused by
      // the input door since D66 — while the scenario never needed it (the
      // pointers come from tags on main's own branch).
      { ...line("main", "main"), publishes: "app" },
      { ...line("2.2", "rel/2.2", { major: 2, minor: 2 }), publishes: "web" },
      { ...line("1.9", "rel/1.9", { major: 1, minor: 9 }), publishes: "cli" },
    ],
    commits: [
      commit("m03-c3", "chore: cut 2.3.0", { containingRefs: ["main"] }),
      commit("m03-f", "fix(parser): handle empty input", {
        parents: ["m03-c3"],
        containingRefs: ["main"],
      }),
      commit("m03-d3", "chore: cut 2.2.3", { containingRefs: ["rel/2.2"] }),
      commit("m03-f2", cherryOf("m03-f"), { parents: ["m03-d3"], containingRefs: ["rel/2.2"] }),
      commit("m03-c9", "chore: cut 1.9.0", { containingRefs: ["rel/1.9"] }),
      commit("m03-f3", cherryOf("m03-f"), { parents: ["m03-c9"], containingRefs: ["rel/1.9"] }),
    ],
    refs: [ref("main", "m03-f"), ref("rel/2.2", "m03-f2"), ref("rel/1.9", "m03-f3")],
    tags: [tag("2.3.0", "m03-c3"), tag("2.2.3", "m03-d3"), tag("1.9.0", "m03-c9")],
    components: [component("app", "2.3.0"), component("web", "2.2.3"), component("cli", "1.9.0")],
    intents: [{ kind: "release" }],
  });
}

describe("M-03 through the door — cherry-picks across lines release all three lines", () => {
  it("releases main per its own pending set (2.3.1), 2.2 → 2.2.4, and 1.9 → 1.9.1, the shared identity once per line", () => {
    const outcome = plan(m03Input());
    const assembled = plannedOf(outcome).plan;
    // All three lines release in the one pass — main per its own pending
    // change set, the maintenance lines per theirs.
    expect(planLineFor(outcome, "main").stable).toEqual({ version: "2.3.1", tag: "2.3.1" });
    expect(planLineFor(outcome, "2.2").stable).toEqual({ version: "2.2.4", tag: "2.2.4" });
    expect(planLineFor(outcome, "1.9").stable).toEqual({ version: "1.9.1", tag: "1.9.1" });
    expect(assembled.lines.map((entry) => entry.lineId)).toEqual(["main", "2.2", "1.9"]);
    // The cherry-pick identity excludes duplicates per line: each line's
    // change set lists the logical fix exactly once, under the same id —
    // released on one line, still release-worthy on the other two.
    for (const lineId of ["main", "2.2", "1.9"] as const) {
      const changes = planLineFor(outcome, lineId).changes;
      expect(changes).toHaveLength(1);
      const [member] = changes;
      if (member === undefined) {
        throw new Error(`fixture broken: line ${lineId} released an empty change set`);
      }
      expect(member).toMatchObject({ id: "m03-f", type: "fix", bump: "patch" });
    }
    // A legal cherry-pick chain is one identity, not a conflict — nothing
    // was surfaced against it.
    expect(assembled.explanation.conflicts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M-03's same-line leg — the origin F and its cherry-pick F′ BOTH pending on
// one line: extraction resolves the same one identity the cross-line success
// path above rides, so the line's pending set carries that identity twice,
// and the kernel's construction door refuses the change set. The refusal is
// a classified record (§2.9), never an exception — fail closed, nothing
// minted, the duplicate left inside the un-released span for the operator to
// resolve. A coverage pin of the loud path exactly as it stands; #197
// ---------------------------------------------------------------------------

function m03SameLineInput(): PlanningInput {
  return buildInput({
    digest: DIGEST_M03,
    lines: [{ ...line("main", "main", { major: 2 }), publishes: "app" }],
    commits: [
      commit("m03-c3", "chore: cut 2.3.0", { containingRefs: ["main"] }),
      commit("m03-f", "fix(parser): handle empty input", {
        parents: ["m03-c3"],
        containingRefs: ["main"],
      }),
      commit("m03-f2", cherryOf("m03-f"), { parents: ["m03-f"], containingRefs: ["main"] }),
    ],
    refs: [ref("main", "m03-f2")],
    tags: [tag("2.3.0", "m03-c3")],
    components: [component("app", "2.3.0")],
    intents: [{ kind: "release" }],
  });
}

describe("M-03 through the door — the origin and its cherry-pick on ONE line refuse with the kernel-rejection record", () => {
  it("refuses main's release as refused/kernel-rejection naming the duplicated identity, minting nothing", () => {
    const outcome = plan(m03SameLineInput());
    // The negative outcome is a record, never an exception (§2.9): the pass
    // completes, and the refusal is main's classified decision — cause
    // kernel-rejection, the fail-closed reading of a change set the kernel
    // cannot construct because one identity arrives as two members.
    expect(outcome.kind).toBe("planned");
    const decision = decisionFor(outcome, "main");
    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") {
      throw new Error("fixture broken: expected a refused record");
    }
    expect(decision.cause).toBe("kernel-rejection");
    // The duplicate-identity cause reaches the consumer: the shared change id
    // (the origin commit the cherry-pick inherited) and the kernel's own rule
    // are named in the record's detail.
    expect(decision.detail).toContain("m03-f");
    expect(decision.detail).toContain("one identity is one member");
    // Recoverability: nothing minted — the refused line contributes no plan
    // line (no tag, no release entry) — and the record's evaluated range is
    // the un-released span that keeps both commits pending, so repairing the
    // duplicate and re-planning is an ordinary pass.
    expect(decision.range).toEqual({ lineId: "main", releasedUpTo: "m03-c3", head: "m03-f2" });
    expect(plannedOf(outcome).plan.lines).toEqual([]);
    expect(plannedOf(outcome).decisions).toHaveLength(1);
    // The identity machinery itself is the legal cherry-pick chain (M-03's
    // success path): extraction surfaces NO conflict — the refusal is the
    // kernel's identity-uniqueness door downstream, never M-05's surfaced
    // conflict shape.
    expect(plannedOf(outcome).plan.explanation.conflicts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M-04 (G-6) — clean backport: main must not move. F′ is released on 1.9
// while F is still pending for main's own next release (F rides the
// maintainer's pre-merge ref; main's feed head is still the 2.3.0 cut) —
// the pass releases the backport and leaves main, and F, untouched
// ---------------------------------------------------------------------------

function m04Input(): PlanningInput {
  return buildInput({
    digest: DIGEST_M04,
    lines: [line("main", "main", { major: 2 }), line("1.9", "rel/1.9", { major: 1, minor: 9 })],
    commits: [
      commit("m04-c3", "chore: cut 2.3.0", { containingRefs: ["main"] }),
      commit("m04-f", "fix(parser): handle empty input", {
        parents: ["m04-c3"],
        containingRefs: ["pull/42"],
      }),
      commit("m04-c9", "chore: cut 1.9.0", { containingRefs: ["rel/1.9"] }),
      commit("m04-f2", cherryOf("m04-f"), { parents: ["m04-c9"], containingRefs: ["rel/1.9"] }),
    ],
    refs: [ref("main", "m04-c3"), ref("pull/42", "m04-f"), ref("rel/1.9", "m04-f2")],
    tags: [tag("2.3.0", "m04-c3"), tag("1.9.0", "m04-c9")],
    components: [component("app", "2.3.0")],
    intents: [{ kind: "release" }],
  });
}

describe("M-04 through the door — the clean backport releases 1.9 only, main must not move", () => {
  it("releases 1.9.0 → 1.9.1 from F′ while main remains 2.3.0 with F still pending, not released", () => {
    const outcome = plan(m04Input());
    // The backport releases on its own line from its own range.
    expect(decisionFor(outcome, "1.9")).toMatchObject({
      kind: "release",
      bump: "patch",
      range: { lineId: "1.9", releasedUpTo: "m04-c9", head: "m04-f2" },
    });
    const line19 = planLineFor(outcome, "1.9");
    expect(line19.stable).toEqual({ version: "1.9.1", tag: "1.9.1" });
    expect(line19.changes).toEqual([
      { id: "m04-f", lineage: ["m04-f"], type: "fix", bump: "patch" },
    ]);
    // main's record is the no-op with the 2.3.0 cut still bounding its
    // released span — the pass marked nothing released for main: F remains
    // pending for main's own next release (M-09's moment takes it), and no
    // plan line mints on main.
    const main = noOpFor(outcome, "main");
    expect(main.range).toEqual({ lineId: "main", releasedUpTo: "m04-c3", head: "m04-c3" });
    expect(main.ignored).toEqual([]);
    expect(plannedOf(outcome).plan.lines.map((entry) => entry.lineId)).toEqual(["1.9"]);
  });
});

// ---------------------------------------------------------------------------
// M-05 (G-5's sibling row) — conflicting backport: F and F′ share one
// Change-Id with genuinely divergent payloads; the divergence is surfaced
// explanation data, never a refusal, and 1.9 still releases 1.9.1 from F′
// ---------------------------------------------------------------------------

function m05Input(): PlanningInput {
  return buildInput({
    digest: DIGEST_M05,
    lines: [line("main", "main", { major: 2 }), line("1.9", "rel/1.9", { major: 1, minor: 9 })],
    commits: [
      commit("m05-c3", "chore: cut 2.3.0", { containingRefs: ["main"] }),
      commit("m05-f", "fix(parser): handle empty input\n\nChange-Id: Ibackport-42", {
        parents: ["m05-c3"],
        containingRefs: ["pull/7"],
      }),
      commit("m05-c9", "chore: cut 1.9.0", { containingRefs: ["rel/1.9"] }),
      commit(
        "m05-f2",
        "fix(parser): handle empty input via the legacy shim\n\nChange-Id: Ibackport-42",
        { parents: ["m05-c9"], containingRefs: ["rel/1.9"] },
      ),
    ],
    refs: [ref("main", "m05-c3"), ref("pull/7", "m05-f"), ref("rel/1.9", "m05-f2")],
    tags: [tag("2.3.0", "m05-c3"), tag("1.9.0", "m05-c9")],
    components: [component("app", "2.3.0")],
    intents: [{ kind: "release" }],
  });
}

describe("M-05 through the door — the conflicting backport is surfaced data, not a refusal", () => {
  it("releases 1.9 (F′) as 1.9.1 with the divergent payloads on the plan's explanation, main unchanged at 2.3.0", () => {
    const outcome = plan(m05Input());
    // The planned outcome IS the answer: the conflict never refuses the
    // pass — the row's decision is release 1.9 (F′).
    expect(decisionFor(outcome, "1.9")).toMatchObject({
      kind: "release",
      bump: "patch",
      range: { lineId: "1.9", releasedUpTo: "m05-c9", head: "m05-f2" },
    });
    expect(planLineFor(outcome, "1.9").stable).toEqual({ version: "1.9.1", tag: "1.9.1" });
    // One identity, divergent payloads: both claimant commits stay
    // surfaced with the contested Change-Id — never silently merged away.
    const conflicts = plannedOf(outcome).plan.explanation.conflicts;
    expect(conflicts).toHaveLength(1);
    const [conflict] = conflicts;
    if (conflict === undefined) {
      throw new Error("fixture broken: the identity conflict must be surfaced");
    }
    expect(conflict).toMatchObject({ changeId: "Ibackport-42", shas: ["m05-f", "m05-f2"] });
    // main releases F with its own pending change set later — out of this
    // pass: main's record is the no-op at the 2.3.0 cut.
    const main = noOpFor(outcome, "main");
    expect(main.range).toEqual({ lineId: "main", releasedUpTo: "m05-c3", head: "m05-c3" });
    expect(plannedOf(outcome).plan.lines.map((entry) => entry.lineId)).toEqual(["1.9"]);
  });
});

// ---------------------------------------------------------------------------
// M-06 (G-8) — backport of an already-released change: F sits inside main's
// released 2.3.0 span; 1.9 still allocates 1.9.1 from its own history and
// main records the no-op — no re-release or re-tag on main
// ---------------------------------------------------------------------------

function m06Input(): PlanningInput {
  return buildInput({
    digest: DIGEST_M06,
    lines: [line("main", "main", { major: 2 }), line("1.9", "rel/1.9", { major: 1, minor: 9 })],
    commits: [
      commit("m06-c3", "chore: keep main moving", { containingRefs: ["main"] }),
      commit("m06-f", "fix(parser): handle empty input", {
        parents: ["m06-c3"],
        containingRefs: ["main"],
      }),
      commit("m06-c9", "chore: cut 1.9.0", { containingRefs: ["rel/1.9"] }),
      commit("m06-f2", cherryOf("m06-f"), { parents: ["m06-c9"], containingRefs: ["rel/1.9"] }),
    ],
    refs: [ref("main", "m06-f"), ref("rel/1.9", "m06-f2")],
    tags: [tag("2.3.0", "m06-f"), tag("1.9.0", "m06-c9")],
    components: [component("app", "2.3.0")],
    intents: [{ kind: "release" }],
  });
}

describe("M-06 through the door — the backport of an already-released change allocates from 1.9's own history", () => {
  it("releases 1.9.1 for the same identity main already shipped, and records main as a no-op — no re-release, no re-tag", () => {
    const outcome = plan(m06Input());
    // The identity is released on main but not on 1.9 — releasedness is per
    // (line, change), so 1.9 allocates 1.9.1 in its own version history.
    expect(decisionFor(outcome, "1.9")).toMatchObject({
      kind: "release",
      bump: "patch",
      range: { lineId: "1.9", releasedUpTo: "m06-c9", head: "m06-f2" },
    });
    const line19 = planLineFor(outcome, "1.9");
    expect(line19.stable).toEqual({ version: "1.9.1", tag: "1.9.1" });
    expect(line19.changes).toEqual([
      { id: "m06-f", lineage: ["m06-f"], type: "fix", bump: "patch" },
    ]);
    // main's record carries F as already-released the way the record can:
    // the range's released bound IS F's commit (F sits inside the released
    // span), the pending set was empty, and no plan line mints — main stays
    // 2.3.0 with nothing re-released or re-tagged.
    const main = noOpFor(outcome, "main");
    expect(main.cause).toBe("no-release-worthy-changes");
    expect(main.range).toEqual({ lineId: "main", releasedUpTo: "m06-f", head: "m06-f" });
    expect(main.ignored).toEqual([]);
    expect(plannedOf(outcome).plan.lines.map((entry) => entry.lineId)).toEqual(["1.9"]);
  });
});

// ---------------------------------------------------------------------------
// M-09 (G-9) — fix released on maintenance before main receives it: F
// shipped as 1.9.1, then the same identity reaches main as a cherry-pick;
// lineage is traceability, not suppression — main releases 2.3.0 → 2.3.1
// ---------------------------------------------------------------------------

function m09Input(): PlanningInput {
  return buildInput({
    digest: DIGEST_M09,
    lines: [line("main", "main", { major: 2 }), line("1.9", "rel/1.9", { major: 1, minor: 9 })],
    commits: [
      commit("m09-c9", "chore: cut 1.9.0", { containingRefs: ["rel/1.9"] }),
      commit("m09-f", "fix: the shared fix", { parents: ["m09-c9"], containingRefs: ["rel/1.9"] }),
      commit("m09-m3", "chore: cut 2.3.0", { containingRefs: ["main"] }),
      commit("m09-f3", cherryOf("m09-f", "fix: the shared fix"), {
        parents: ["m09-m3"],
        containingRefs: ["main"],
      }),
    ],
    refs: [ref("main", "m09-f3"), ref("rel/1.9", "m09-f")],
    tags: [tag("1.9.0", "m09-c9"), tag("1.9.1", "m09-f"), tag("2.3.0", "m09-m3")],
    components: [component("app", "2.3.0")],
    intents: [{ kind: "release" }],
  });
}

describe("M-09 through the door — lineage is traceability, not suppression", () => {
  it("releases main 2.3.0 → 2.3.1 even though 1.9.1 already shipped the same fix, with no re-release on 1.9", () => {
    const outcome = plan(m09Input());
    // The earlier 1.9.1 shipment neither suppresses main's release nor
    // duplicates it: main releases F″ from its own range.
    expect(decisionFor(outcome, "main")).toMatchObject({
      kind: "release",
      bump: "patch",
      range: { lineId: "main", releasedUpTo: "m09-m3", head: "m09-f3" },
    });
    const mainLine = planLineFor(outcome, "main");
    expect(mainLine.stable).toEqual({ version: "2.3.1", tag: "2.3.1" });
    expect(mainLine.changes).toHaveLength(1);
    const [member] = mainLine.changes;
    if (member === undefined) {
      throw new Error("fixture broken: main released an empty change set");
    }
    expect(member).toMatchObject({ id: "m09-f", type: "fix", bump: "patch" });
    // 1.9's own record is the no-op — the identity already sits inside 1.9's
    // released span (the 1.9.1 cut bounds it), so nothing re-releases there
    // either: the plan's only line entry is main's.
    const one9 = noOpFor(outcome, "1.9");
    expect(one9.range).toEqual({ lineId: "1.9", releasedUpTo: "m09-f", head: "m09-f" });
    expect(one9.ignored).toEqual([]);
    expect(plannedOf(outcome).plan.lines.map((entry) => entry.lineId)).toEqual(["main"]);
  });
});
