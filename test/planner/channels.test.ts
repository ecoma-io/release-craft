/**
 * ADR-0012 decision 2 — the planner's planned channel transitions, through
 * `plannedChannelTransitions` (the derivation, unit-level) and the `plan`
 * door (the assembly and the closed input boundary):
 *
 * 1. The derivation: a promote names its moves for the declared channels
 *    PR-01's vocabulary moves (`stable`/`next`, in declaration order), then
 *    the promoted-from edge, then the promoted stream's close — the close's
 *    stream identifier read from the in-flight pointer's prerelease, never
 *    from the registry. Channels tracking prerelease streams and other
 *    lines' channels are untouched.
 * 2. The field's presence: every promote carries `channels`; every other
 *    run leaves the field absent even with a declared registry — absent is
 *    byte-identical to the pre-ADR-0012 plan (fingerprint identity).
 * 3. Identity (§2.11, E-04): the declared registry is part of the input's
 *    policy-relevant projection, so worlds differing in declared channels
 *    carry different input fingerprints — and different plan identities,
 *    even where the planned content happens to coincide.
 * 4. The boundary (§2.1): a malformed registry is refused, naming the
 *    violated field; a valid one passes through unchanged.
 *
 * §2.14: the door is pure — the channels scenario re-runs its input and
 * requires whole-outcome equality. Fixture builders mirror
 * assemble.test.ts (the P-03 world is the promote posture).
 */
import { describe, expect, it } from "vitest";

import { Version } from "@ecoma-io/release-craft/domain";

import { plannedChannelTransitions } from "../../src/planner/channels.js";
import { plan } from "../../src/planner/assemble.js";
import { inputsFingerprint } from "../../src/planner/identity.js";
import { InvalidPlanningInputError, normalize } from "../../src/planner/input.js";
import type {
  ChannelObservation,
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
// Fixture builders — deterministic, closed inputs per §2.1, mirroring
// assemble.test.ts's idiom
// ---------------------------------------------------------------------------

const COMMITTED_AT = "2026-01-01T00:00:00Z";

/** One fixed digest — opaque content identity (invariant 4). */
const DIGEST = "sha256:" + "c".repeat(64);

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
): LineConfig {
  const config: LineConfig = { id, feedRef, lifecycle: "active", declared: true };
  if (versionBand === undefined) {
    return config;
  }
  return { ...config, versionBand };
}

function component(name: string, manifestVersion: string): ComponentMeta {
  return { name, manifestVersion, paths: ["package.json"] };
}

interface FixtureOptions {
  readonly lines: readonly LineConfig[];
  readonly commits: readonly CommitObservation[];
  readonly refs: readonly RefObservation[];
  readonly tags?: readonly TagObservation[];
  readonly components?: readonly ComponentMeta[];
  readonly intents?: readonly OperatorIntent[];
  readonly channels?: readonly ChannelObservation[];
}

/** The closed §2.1 input a scenario's stated initial state reconstructs. */
function buildInput(opts: FixtureOptions): PlanningInput {
  return {
    policy: policy(DIGEST),
    repository: { commits: opts.commits, refs: opts.refs },
    history: { tags: opts.tags ?? [] },
    lines: opts.lines,
    ...(opts.components === undefined ? {} : { components: opts.components }),
    ...(opts.intents === undefined ? {} : { intents: opts.intents }),
    ...(opts.channels === undefined ? {} : { channels: opts.channels }),
  };
}

// ---------------------------------------------------------------------------
// Narrowing helpers — every assertion runs against the planned branch
// ---------------------------------------------------------------------------

function plannedOf(outcome: PlanningOutcome): Extract<PlanningOutcome, { kind: "planned" }> {
  if (outcome.kind !== "planned") {
    throw new Error(`fixture broken: expected a planned outcome, got ${outcome.kind}`);
  }
  return outcome;
}

function decisionFor(outcome: PlanningOutcome, lineId: string): LineDecision {
  const found = plannedOf(outcome).decisions.find((candidate) => candidate.lineId === lineId);
  if (found === undefined) {
    throw new Error(`fixture broken: line ${lineId} has no decision record`);
  }
  return found;
}

function planLineOf(outcome: PlanningOutcome): PlanLine {
  const found = plannedOf(outcome).plan.lines[0];
  if (found === undefined) {
    throw new Error("fixture broken: the plan assembles no line");
  }
  return found;
}

function reject(input: PlanningInput): InvalidPlanningInputError {
  try {
    normalize(input);
  } catch (error) {
    if (error instanceof InvalidPlanningInputError) return error;
    throw error;
  }
  throw new Error("unreachable — normalize accepted an input expected to be rejected");
}

/** The violated field paths of a rejection, in traversal order. */
function fieldsOf(rejected: InvalidPlanningInputError): string[] {
  return rejected.violations.map((violation) => violation.field);
}

// ---------------------------------------------------------------------------
// The derivation — plannedChannelTransitions, unit-level
// ---------------------------------------------------------------------------

describe("plannedChannelTransitions — the promote's planned transitions", () => {
  // The promote posture the assemble door guarantees: pointer 1.2.0-rc.2,
  // promoted stable 1.2.0 (bumpPatch of the pointer, SemVer §11.3).
  const pointer = Version.parse("1.2.0-rc.2");
  const promoted = Version.parse("1.2.0");

  it("moves the declared stable and next in declaration order, then the edge, then the close", () => {
    const transitions = plannedChannelTransitions(
      [
        { id: "stable", target: { line: "1.x", version: "1.1.0" } },
        { id: "next", target: { line: "1.x", version: "1.1.0" } },
      ],
      "1.x",
      pointer,
      promoted,
    );

    expect(transitions).toStrictEqual([
      { kind: "channel-move", channelId: "stable", to: { line: "1.x", version: "1.2.0" } },
      { kind: "channel-move", channelId: "next", to: { line: "1.x", version: "1.2.0" } },
      { kind: "promoted-from", from: "1.2.0-rc.2", to: { line: "1.x", version: "1.2.0" } },
      { kind: "stream-close", stream: "rc", target: "1.2.0" },
    ]);
  });

  it("reads the closed stream from the pointer's prerelease, never from the registry", () => {
    // A registry that names no channel after the stream at all: the close
    // still closes the promoted prerelease's stream — the stream is a fact
    // of the pointer, not of what happens to be declared.
    const transitions = plannedChannelTransitions([], "1.x", pointer, promoted);

    expect(transitions).toStrictEqual([
      { kind: "promoted-from", from: "1.2.0-rc.2", to: { line: "1.x", version: "1.2.0" } },
      { kind: "stream-close", stream: "rc", target: "1.2.0" },
    ]);
  });

  it("leaves stream-tracking channels and other lines' channels untouched", () => {
    // `rc-preview` tracks this line's in-flight stream (PR-01's stream
    // vocabulary keeps the stream at its head — a promote closes the stream,
    // it does not repoint its watchers); `stable` on `9.x` is another line's
    // channel, out of this promotion's scope entirely.
    const transitions = plannedChannelTransitions(
      [
        { id: "rc-preview", target: { line: "1.x", version: "1.2.0-rc.2" } },
        { id: "stable", target: { line: "9.x", version: "9.0.0" } },
        { id: "next", target: { line: "1.x", version: "1.1.0" } },
      ],
      "1.x",
      pointer,
      promoted,
    );

    expect(transitions).toStrictEqual([
      { kind: "channel-move", channelId: "next", to: { line: "1.x", version: "1.2.0" } },
      { kind: "promoted-from", from: "1.2.0-rc.2", to: { line: "1.x", version: "1.2.0" } },
      { kind: "stream-close", stream: "rc", target: "1.2.0" },
    ]);
  });

  it("treats declaration order as data — [next, stable] moves next first", () => {
    const transitions = plannedChannelTransitions(
      [
        { id: "next", target: { line: "1.x", version: "1.1.0" } },
        { id: "stable", target: { line: "1.x", version: "1.1.0" } },
      ],
      "1.x",
      pointer,
      promoted,
    );

    const movedIds = transitions
      .filter((transition) => transition.kind === "channel-move")
      .map((transition) => transition.channelId);
    expect(movedIds).toStrictEqual(["next", "stable"]);
  });

  it("surfaces the caller contract violation when the pointer carries no prerelease", () => {
    // Unreachable through the door — the promote decision refuses a pointer
    // with no prerelease — so reaching it here is a caller bug, named as one.
    expect(() =>
      plannedChannelTransitions([], "1.x", Version.parse("1.2.0"), Version.parse("1.2.1")),
    ).toThrow(/caller contract violation/);
  });
});

// ---------------------------------------------------------------------------
// Through the door — the promote with a declared registry (the P-03 world)
// ---------------------------------------------------------------------------

describe("plan — the promote over an in-flight rc with a declared channel registry", () => {
  function input(channels: readonly ChannelObservation[]): PlanningInput {
    return buildInput({
      lines: [line("1.x", "main")],
      commits: [commit("p03-c1", "feat: the 1.2 line", { containingRefs: ["main"] })],
      refs: [ref("main", "p03-c1")],
      tags: [tag("1.2.0-rc.2", "p03-c1")],
      components: [component("release-craft", "1.2.0")],
      intents: [{ kind: "promote", lineId: "1.x" }],
      channels,
    });
  }

  const registry: readonly ChannelObservation[] = [
    { id: "stable", target: { line: "1.x", version: "1.1.0" } },
    { id: "next", target: { line: "1.x", version: "1.1.0" } },
    { id: "rc-preview", target: { line: "1.x", version: "1.2.0-rc.2" } },
    { id: "lts", target: { line: "9.x", version: "9.0.0" } },
  ];

  it("plans exactly the declared moves, the promoted-from edge, and the stream close", () => {
    const outcome = plan(input(registry));

    expect(decisionFor(outcome, "1.x")).toMatchObject({ kind: "release", bump: null });
    expect(planLineOf(outcome).channels).toStrictEqual([
      { kind: "channel-move", channelId: "stable", to: { line: "1.x", version: "1.2.0" } },
      { kind: "channel-move", channelId: "next", to: { line: "1.x", version: "1.2.0" } },
      { kind: "promoted-from", from: "1.2.0-rc.2", to: { line: "1.x", version: "1.2.0" } },
      { kind: "stream-close", stream: "rc", target: "1.2.0" },
    ]);
  });

  it("is pure over the declared registry — identical inputs, identical whole outcome (§2.14)", () => {
    const outcome = plan(input(registry));
    expect(plan(input(registry))).toEqual(outcome);
  });

  it("names the decision's own pointer on the promoted-from edge — the last among precedence ties", () => {
    // Two admissible tags tie in precedence and differ only in build
    // metadata (§2.13's tie rule): the history sort is total, but the
    // rebuilt state keeps the tie's FIRST entry while the promote decision
    // names the LAST (`pointerFor`). The edge must carry the decision's
    // pointer — one plan, one identity for the prerelease it promotes.
    const tied = buildInput({
      lines: [line("1.x", "main")],
      commits: [commit("p03-c1", "feat: the 1.2 line", { containingRefs: ["main"] })],
      refs: [ref("main", "p03-c1")],
      tags: [tag("1.2.0-rc.2+a", "p03-c1"), tag("1.2.0-rc.2+b", "p03-c1")],
      components: [component("release-craft", "1.2.0")],
      intents: [{ kind: "promote", lineId: "1.x" }],
      channels: registry,
    });

    const outcome = plan(tied);
    const decision = decisionFor(outcome, "1.x");
    expect(decision).toMatchObject({ kind: "release", bump: null });
    expect(planLineOf(outcome).channels).toContainEqual({
      kind: "promoted-from",
      from: "1.2.0-rc.2+b",
      to: { line: "1.x", version: "1.2.0" },
    });
  });

  it("carries its full channels plan when a sibling prerelease intent demands the same stream (#90)", () => {
    // #90/D38: a promotion-shaped decision never carries a stream extension.
    // This world used to pin the opposite (#89's review finding F2): the
    // sibling prerelease demand suppressed the stable co-mint (D17(3)), so
    // the run minted on the stream and carried no `channels` key. That
    // scenario is unreachable since D38 — a promotion's stable co-mint is
    // never suppressed, because D17(3) has no purchase on a decision whose
    // change set is inherited and empty (nothing to route to a stream). The
    // demand is subsumed: the promotion mint stands, the rc stream closes
    // instead of extending, and the full transitions ride the plan.
    const combined = buildInput({
      lines: [line("1.x", "main")],
      commits: [commit("p03-c1", "feat: the 1.2 line", { containingRefs: ["main"] })],
      refs: [ref("main", "p03-c1")],
      tags: [tag("1.2.0-rc.2", "p03-c1")],
      components: [component("release-craft", "1.2.0")],
      intents: [
        { kind: "promote", lineId: "1.x" },
        { kind: "prerelease", stream: "rc", lineId: "1.x" },
      ],
      channels: registry,
    });

    const outcome = plan(combined);
    expect(decisionFor(outcome, "1.x")).toMatchObject({ kind: "release", bump: null });
    const planLine = planLineOf(outcome);
    expect(planLine.stable).toStrictEqual({ version: "1.2.0", tag: "1.2.0" });
    expect(planLine.streams).toStrictEqual([]);
    expect(planLine.channels).toStrictEqual([
      { kind: "channel-move", channelId: "stable", to: { line: "1.x", version: "1.2.0" } },
      { kind: "channel-move", channelId: "next", to: { line: "1.x", version: "1.2.0" } },
      { kind: "promoted-from", from: "1.2.0-rc.2", to: { line: "1.x", version: "1.2.0" } },
      { kind: "stream-close", stream: "rc", target: "1.2.0" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The field's absence — every non-promote run, even with a declared registry
// ---------------------------------------------------------------------------

describe("plan — the channels field is absent for every non-promote run", () => {
  const registry: readonly ChannelObservation[] = [
    { id: "stable", target: { line: "1.x", version: "1.1.0" } },
  ];

  it("a prerelease run plans no channel transitions", () => {
    const outcome = plan(
      buildInput({
        lines: [line("1.x", "main")],
        commits: [
          commit("r-1.0.0", "feat: the first release", { containingRefs: ["main"] }),
          commit("r-chore", "chore: bump the devdep floor", {
            parents: ["r-1.0.0"],
            containingRefs: ["main"],
          }),
        ],
        refs: [ref("main", "r-chore")],
        tags: [tag("1.0.0", "r-1.0.0")],
        components: [component("release-craft", "1.0.0")],
        intents: [{ kind: "prerelease", stream: "rc", lineId: "1.x" }],
        channels: registry,
      }),
    );

    const planLine = planLineOf(outcome);
    // A prerelease intent over a no-release-worthy runway decides no-op (the
    // stream planning is a §2.6 posture, not a decision kind) — still not a
    // promotion, so still no channel transitions.
    expect(decisionFor(outcome, "1.x")).toMatchObject({
      kind: "no-op",
      cause: "no-release-worthy-changes",
    });
    expect("channels" in planLine).toBe(false);
  });

  it("a stable release run plans no channel transitions", () => {
    const outcome = plan(
      buildInput({
        lines: [line("1.x", "main", { major: 1 })],
        commits: [
          commit("s-1.0.0", "feat: the first release", { containingRefs: ["main"] }),
          commit("s-fix", "fix: the follow-up patch", {
            parents: ["s-1.0.0"],
            containingRefs: ["main"],
          }),
        ],
        refs: [ref("main", "s-fix")],
        tags: [tag("1.0.0", "s-1.0.0")],
        components: [component("release-craft", "1.0.0")],
        intents: [{ kind: "release" }],
        channels: registry,
      }),
    );

    const planLine = planLineOf(outcome);
    expect(decisionFor(outcome, "1.x").kind).toBe("release");
    expect(decisionFor(outcome, "1.x")).toMatchObject({ bump: "patch" });
    expect("channels" in planLine).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Identity — the registry is part of the input's policy-relevant projection
// ---------------------------------------------------------------------------

describe("inputsFingerprint — the declared registry is part of the world", () => {
  function stableWorld(channels?: readonly ChannelObservation[]): PlanningInput {
    return buildInput({
      lines: [line("1.x", "main", { major: 1 })],
      commits: [
        commit("w-1.0.0", "feat: the first release", { containingRefs: ["main"] }),
        commit("w-fix", "fix: the follow-up patch", {
          parents: ["w-1.0.0"],
          containingRefs: ["main"],
        }),
      ],
      refs: [ref("main", "w-fix")],
      tags: [tag("1.0.0", "w-1.0.0")],
      components: [component("release-craft", "1.0.0")],
      intents: [{ kind: "release" }],
      ...(channels === undefined ? {} : { channels }),
    });
  }

  it("worlds differing in declared channels carry different input fingerprints", () => {
    const without = stableWorld();
    const withChannels = stableWorld([{ id: "stable", target: { line: "1.x", version: "1.0.0" } }]);

    expect(inputsFingerprint(without)).not.toBe(inputsFingerprint(withChannels));
  });

  it("plan identity follows the world — same content, different worlds, different plans", () => {
    // The stable run plans no channel transitions, so the two plans' content
    // coincides — but E-04's staleness re-judgment is world-bound (§2.11):
    // a stored plan re-judged against a world whose projected fingerprint
    // differs is stale. The registry moves the fingerprint, so the planId
    // moves with it.
    const without = plan(stableWorld());
    const withChannels = plan(
      stableWorld([{ id: "stable", target: { line: "1.x", version: "1.0.0" } }]),
    );

    expect(plannedOf(without).plan.planId).not.toBe(plannedOf(withChannels).plan.planId);
  });
});

// ---------------------------------------------------------------------------
// The closed input boundary — the registry is validated (§2.1)
// ---------------------------------------------------------------------------

describe("normalize — the declared channel registry", () => {
  it("passes a valid registry through unchanged — the caller's array stays the caller's", () => {
    const channels: readonly ChannelObservation[] = [
      { id: "stable", target: { line: "1.x", version: "1.2.0-rc.2" } },
      { id: "next", target: { line: "1.x", version: "1.1.0" } },
    ];
    const input = buildInput({
      lines: [line("1.x", "main")],
      commits: [commit("v-c1", "feat: the 1.2 line", { containingRefs: ["main"] })],
      refs: [ref("main", "v-c1")],
      channels,
    });

    const result = normalize(input);
    expect(result.channels).toBe(channels);
  });

  it("refuses a non-array registry, naming the field", () => {
    const bad = {
      ...buildInput({
        lines: [line("1.x", "main")],
        commits: [commit("v-c1", "feat: the 1.2 line", { containingRefs: ["main"] })],
        refs: [ref("main", "v-c1")],
      }),
      channels: { id: "stable" },
    } as unknown as PlanningInput;

    const rejected = reject(bad);
    expect(rejected.violations).toHaveLength(1);
    expect(rejected.violations[0]?.field).toBe("channels");
  });

  it("refuses a non-object entry, naming its position", () => {
    const bad = {
      ...buildInput({
        lines: [line("1.x", "main")],
        commits: [commit("v-c1", "feat: the 1.2 line", { containingRefs: ["main"] })],
        refs: [ref("main", "v-c1")],
      }),
      channels: ["stable"],
    } as unknown as PlanningInput;

    const rejected = reject(bad);
    expect(rejected.violations).toHaveLength(1);
    expect(rejected.violations[0]?.field).toBe("channels[0]");
  });

  it("refuses an empty channel id and an empty target line, naming each field", () => {
    const bad = {
      ...buildInput({
        lines: [line("1.x", "main")],
        commits: [commit("v-c1", "feat: the 1.2 line", { containingRefs: ["main"] })],
        refs: [ref("main", "v-c1")],
      }),
      channels: [{ id: "", target: { line: "", version: "1.0.0" } }],
    } as unknown as PlanningInput;

    const rejected = reject(bad);
    expect(fieldsOf(rejected)).toStrictEqual(["channels[0].id", "channels[0].target.line"]);
  });

  it("refuses a missing or malformed target", () => {
    const bad = {
      ...buildInput({
        lines: [line("1.x", "main")],
        commits: [commit("v-c1", "feat: the 1.2 line", { containingRefs: ["main"] })],
        refs: [ref("main", "v-c1")],
      }),
      channels: [{ id: "stable" }, { id: "next", target: "1.0.0" }],
    } as unknown as PlanningInput;

    const rejected = reject(bad);
    expect(fieldsOf(rejected)).toStrictEqual(["channels[0].target", "channels[1].target"]);
  });

  it("refuses an unparseable target version, quoting the value", () => {
    const bad = {
      ...buildInput({
        lines: [line("1.x", "main")],
        commits: [commit("v-c1", "feat: the 1.2 line", { containingRefs: ["main"] })],
        refs: [ref("main", "v-c1")],
      }),
      channels: [{ id: "stable", target: { line: "1.x", version: "one.two.three" } }],
    } as unknown as PlanningInput;

    const rejected = reject(bad);
    expect(rejected.violations).toHaveLength(1);
    expect(rejected.violations[0]?.field).toBe("channels[0].target.version");
    expect(rejected.violations[0]?.problem).toContain('"one.two.three"');
  });

  it("refuses a registry naming a channel twice", () => {
    const bad = {
      ...buildInput({
        lines: [line("1.x", "main")],
        commits: [commit("v-c1", "feat: the 1.2 line", { containingRefs: ["main"] })],
        refs: [ref("main", "v-c1")],
      }),
      channels: [
        { id: "stable", target: { line: "1.x", version: "1.0.0" } },
        { id: "stable", target: { line: "1.x", version: "1.1.0" } },
      ],
    } as unknown as PlanningInput;

    const rejected = reject(bad);
    expect(rejected.violations).toHaveLength(1);
    expect(rejected.violations[0]?.field).toBe("channels[1].id");
    expect(rejected.violations[0]?.problem).toContain('"stable"');
  });
});
