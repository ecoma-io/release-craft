/**
 * §2.6–§2.8 target computation (`plan.ts`) — black-box tests over the
 * observable `TargetPlan`/`PlannedStream` values: stable bump arithmetic
 * through the kernel's bump doors with pre-1.0 dampening (§2.7), the D17
 * target rules (promotion, the P-04/P-05 in-flight-target rule, D17(3)
 * suppression, release-as, the D17(1)/S-02 birth refusal), prerelease
 * sequencing over the rebuilt line state (§2.8), the declared seed (fork 17,
 * decision-log D13), the recorded pointer base and move flag (D10), and the
 * tag-format knob (fork 11). Fixtures are self-contained, mirroring the
 * attribute.adversarial.test.ts idiom; assertions target observable
 * outcomes only — versions, tags, seeds, pointer bases — never internals.
 */
import { describe, expect, it } from "vitest";

import { Version } from "@ecoma-io/release-craft/domain";
import type { Bump } from "@ecoma-io/release-craft/domain";

import { InvalidPlanningInputError } from "../../src/planner/input.js";
import { planStreams, planTargets } from "../../src/planner/plan.js";
import type {
  LineConfig,
  LineDecision,
  LineRange,
  LineState,
  OperatorIntent,
  PolicyInput,
  StreamKeyState,
} from "../../src/planner/types.js";

const POLICY_DIGEST = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

function policy(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    digest: POLICY_DIGEST,
    bumpMappingId: "default",
    prereleaseLadder: ["alpha", "beta", "rc"],
    prereleaseSeed: "0",
    pre10Dampening: true,
    selfReferenceNamespace: "Release-Craft:",
    tagFormats: {},
    ...overrides,
  };
}

function line(id: string = "app", overrides: Partial<Omit<LineConfig, "id">> = {}): LineConfig {
  return {
    id,
    feedRef: "main",
    lifecycle: "active",
    declared: true,
    ...overrides,
  };
}

/** A rebuilt line state in the §2.13 shape: pointer plus observed stream keys. */
function stateOf(
  pointer: string | null,
  streams: readonly (readonly [string, string, number])[] = [],
  stableBase: string | null = null,
): LineState {
  const keys: StreamKeyState[] = [];
  for (const entry of streams) {
    keys.push({
      target: Version.parse(entry[0]),
      identifier: entry[1],
      sequence: entry[2],
    });
  }
  return {
    pointer: pointer === null ? null : Version.parse(pointer),
    stableBase: stableBase === null ? null : Version.parse(stableBase),
    streams: keys,
  };
}

const RANGE: LineRange = { lineId: "app", releasedUpTo: null, head: "head-sha" };

function release(bump: Bump): LineDecision {
  return {
    kind: "release",
    bump,
    changes: [],
    lineId: "app",
    range: RANGE,
    policyDigest: POLICY_DIGEST,
    detail: "fixture release decision",
  };
}

/** A promotion decision (P-03): bump null, the change set inherited. */
function promotion(): LineDecision {
  return {
    kind: "release",
    bump: null,
    changes: [],
    lineId: "app",
    range: RANGE,
    policyDigest: POLICY_DIGEST,
    detail: "fixture promotion decision",
  };
}

function noOp(): LineDecision {
  return {
    kind: "no-op",
    cause: "no-release-worthy-changes",
    ignored: [],
    lineId: "app",
    range: RANGE,
    policyDigest: POLICY_DIGEST,
    detail: "fixture no-op decision",
  };
}

function intent(stream: string, lineId: string = "app"): OperatorIntent {
  return { kind: "prerelease", stream, lineId };
}

describe("planTargets — stable bump arithmetic (§2.7)", () => {
  it("applies a patch bump to the rebuilt pointer", () => {
    const plan = planTargets([], release("patch"), stateOf("1.2.3"), line(), policy());

    expect(plan.stable?.version.toString()).toBe("1.2.4");
    expect(plan.stable?.tag).toBe("1.2.4");
    // planTargets composes the streams too; with no intents demanded, the
    // stream list is empty (planStreams is the composed seam).
    expect(plan.streams).toStrictEqual([]);
  });

  it("applies minor and major bumps through the kernel doors", () => {
    const minor = planTargets([], release("minor"), stateOf("1.2.3"), line(), policy());
    const major = planTargets([], release("major"), stateOf("1.2.3"), line(), policy());

    expect(minor.stable?.version.toString()).toBe("1.3.0");
    expect(major.stable?.version.toString()).toBe("2.0.0");
  });

  it("dampens a major bump while the pointer sits below 1.0.0 (§2.7)", () => {
    const plan = planTargets([], release("major"), stateOf("0.4.2"), line(), policy());

    expect(plan.stable?.version.toString()).toBe("0.5.0");
  });

  it("does not dampen when the knob is off or the pointer has left 0.y.z", () => {
    const knobOff = planTargets(
      [],
      release("major"),
      stateOf("0.4.2"),
      line(),
      policy({ pre10Dampening: false }),
    );
    const pastOne = planTargets([], release("major"), stateOf("1.2.0"), line(), policy());

    expect(knobOff.stable?.version.toString()).toBe("1.0.0");
    expect(pastOne.stable?.version.toString()).toBe("2.0.0");
  });

  it("refuses a release decision on a birthed line — the bootstrap target is door-composed (D17(1)/S-02)", () => {
    // The first release targets the recorded bootstrap version, input
    // PlanTargets does not receive; deriving a bump-from-zero fallback here
    // is exactly the silently-wrong behavior D17(1) rules out.
    const attempt = (): unknown =>
      planTargets([], release("minor"), stateOf(null), line(), policy());

    expect(attempt).toThrow(InvalidPlanningInputError);
    expect(attempt).toThrow(/D17\(1\)/);
    expect(attempt).toThrow(/S-02/);
  });

  it("gives a non-release decision a null stable target", () => {
    const plan = planTargets([], noOp(), stateOf("1.2.3"), line(), policy());

    expect(plan.stable).toBeNull();
    expect(plan.streams).toStrictEqual([]);
  });
});

describe("planTargets — D17 target rules", () => {
  it("keeps the in-flight target when the recompute lands at it (P-04)", () => {
    // stableBase 1.1.0 + minor recomputes 1.2.0; the in-flight target
    // (bumpPatch of pointer 1.2.0-rc.2) is 1.2.0 — equal precedence keeps
    // the in-flight target, so the stream continues rc.2 → rc.3.
    const wouldBe = planTargets(
      [],
      release("minor"),
      stateOf("1.2.0-rc.2", [["1.2.0", "rc", 2]], "1.1.0"),
      line(),
      policy(),
    );
    expect(wouldBe.stable?.version.toString()).toBe("1.2.0");

    const suppressed = planTargets(
      [intent("rc")],
      release("minor"),
      stateOf("1.2.0-rc.2", [["1.2.0", "rc", 2]], "1.1.0"),
      line(),
      policy(),
    );
    // D17(3): the prerelease intent suppresses the stable co-mint — the
    // streams carry the target instead.
    expect(suppressed.stable).toBeNull();
    expect(suppressed.streams.map((planned) => planned.version.toString())).toStrictEqual([
      "1.2.0-rc.3",
    ]);
  });

  it("moves the target above the in-flight class and resets the key (P-05)", () => {
    // stableBase 1.1.0 + major recomputes 2.0.0, outranking the in-flight
    // 1.2.0 — the target moves and the fresh key reseeds (rc.0, not rc.2).
    const wouldBe = planTargets(
      [],
      release("major"),
      stateOf("1.2.0-rc.1", [["1.2.0", "rc", 1]], "1.1.0"),
      line(),
      policy(),
    );
    expect(wouldBe.stable?.version.toString()).toBe("2.0.0");

    const suppressed = planTargets(
      [intent("rc")],
      release("major"),
      stateOf("1.2.0-rc.1", [["1.2.0", "rc", 1]], "1.1.0"),
      line(),
      policy(),
    );
    expect(suppressed.stable).toBeNull();
    expect(suppressed.streams.map((planned) => planned.version.toString())).toStrictEqual([
      "2.0.0-rc.0",
    ]);
  });

  it("dampens the recomputed candidate, never the in-flight target itself", () => {
    // stableBase 0.3.2 + major dampens to 0.4.0 — equal to the in-flight
    // target, so it stands; the knob off recomputes 1.0.0, which outranks.
    const damped = planTargets(
      [],
      release("major"),
      stateOf("0.4.0-rc.1", [["0.4.0", "rc", 1]], "0.3.2"),
      line(),
      policy(),
    );
    expect(damped.stable?.version.toString()).toBe("0.4.0");

    const raw = planTargets(
      [],
      release("major"),
      stateOf("0.4.0-rc.1", [["0.4.0", "rc", 1]], "0.3.2"),
      line(),
      policy({ pre10Dampening: false }),
    );
    expect(raw.stable?.version.toString()).toBe("1.0.0");
  });

  it("promotes the pointed-at release when the decision's bump is null (P-03)", () => {
    const plan = planTargets(
      [],
      promotion(),
      stateOf("1.2.0-rc.2", [["1.2.0", "rc", 2]]),
      line(),
      policy(),
    );

    expect(plan.stable?.version.toString()).toBe("1.2.0");
  });

  it("keeps the promotion's stable and plans no stream under a sibling prerelease demand (D38, #90)", () => {
    // The sibling demand runs toward the promotion's own mint (bumpPatch of
    // the pointer) — the promotion subsumes it: D17(3)'s suppression has no
    // purchase here, and no sequence entry is planned. The single-intent
    // suppression above is untouched: that decision carries its own content;
    // this one inherits an empty change set (nothing to route to a stream).
    const plan = planTargets(
      [intent("rc")],
      promotion(),
      stateOf("1.2.0-rc.2", [["1.2.0", "rc", 2]]),
      line(),
      policy(),
    );

    expect(plan.stable?.version.toString()).toBe("1.2.0");
    expect(plan.streams).toStrictEqual([]);
  });

  it("overrides the computed stable with the first release-as version (compatibility row 2)", () => {
    const plan = planTargets(
      [{ kind: "release-as", version: "3.1.4" }],
      release("minor"),
      stateOf("1.2.3"),
      line(),
      policy(),
    );
    expect(plan.stable?.version.toString()).toBe("3.1.4");
    expect(plan.stable?.tag).toBe("3.1.4");

    const firstWins = planTargets(
      [
        { kind: "release-as", version: "3.1.4" },
        { kind: "release-as", version: "4.0.0" },
      ],
      release("minor"),
      stateOf("1.2.3"),
      line(),
      policy(),
    );
    expect(firstWins.stable?.version.toString()).toBe("3.1.4");
  });
});

describe("planStreams — prerelease sequencing (§2.8)", () => {
  it("plans no stream for a promotion-shaped decision — the promotion subsumes the demand (D38, #90)", () => {
    const streams = planStreams(
      [intent("rc")],
      promotion(),
      stateOf("1.2.0-rc.2", [["1.2.0", "rc", 2]]),
      line(),
      policy(),
    );

    expect(streams).toStrictEqual([]);
  });

  it("continues an observed key at the next sequence: rc.3 → rc.4 (P-04/P-06 shape)", () => {
    const state = stateOf("1.2.0-rc.3", [["1.2.0", "rc", 3]]);

    const streams = planStreams([intent("rc")], release("patch"), state, line(), policy());

    expect(streams.map((planned) => planned.version.toString())).toStrictEqual(["1.2.0-rc.4"]);
    expect(streams[0]?.identifier).toBe("rc");
    // A prerelease mint above the released prerelease pointer moves it (M-08).
    expect(streams[0]?.movesPointer).toBe(true);
    expect(streams[0]?.pointerBase).toBe("1.2.0-rc.3");
  });

  it("seeds a fresh key at the declared seed 0 (P-07's first mint)", () => {
    const streams = planStreams(
      [intent("rc")],
      release("patch"),
      stateOf("1.2.3"),
      line(),
      policy(),
    );

    expect(streams[0]?.version.toString()).toBe("1.2.4-rc.0");
    expect(streams[0]?.seed).toBe("0");
    expect(streams[0]?.pointerBase).toBe("1.2.3");
    expect(streams[0]?.movesPointer).toBe(true);
  });

  it("seeds a fresh key at the declared seed 1 (M-08's first-ever rc.1)", () => {
    const streams = planStreams(
      [intent("rc")],
      release("minor"),
      stateOf("2.3.0"),
      line(),
      policy({ prereleaseSeed: "1" }),
    );

    expect(streams[0]?.version.toString()).toBe("2.4.0-rc.1");
    expect(streams[0]?.seed).toBe("1");
    expect(streams[0]?.pointerBase).toBe("2.3.0");
    // The mint outranks the stable pointer by precedence: the pointer moves.
    expect(streams[0]?.movesPointer).toBe(true);
  });

  it("a moved target starts a new key at the seed, resetting the sequence (P-05)", () => {
    const state = stateOf("1.2.0-rc.1", [["1.2.0", "rc", 1]], "1.1.0");

    const streams = planStreams([intent("rc")], release("major"), state, line(), policy());

    // The stable target recomputes to 2.0.0 from the stable base; the
    // re-based rc key is fresh, so the sequence resets to the seed instead
    // of continuing to rc.2.
    expect(streams[0]?.version.toString()).toBe("2.0.0-rc.0");
    expect(streams[0]?.identifier).toBe("rc");
    expect(streams[0]?.seed).toBe("0");
  });

  it("advances only the demanded stream against one shared target (P-06)", () => {
    const state = stateOf("1.2.0-rc.1", [
      ["1.2.0", "alpha", 4],
      ["1.2.0", "rc", 1],
    ]);

    // P-06's operator intent is "advance rc only": one stream planned, the
    // alpha key observed but untouched. (Demanding alpha here would plan
    // 1.2.0-alpha.5 below the rc.1 pointer — D10's refusal, covered below.)
    const streams = planStreams([intent("rc")], release("patch"), state, line(), policy());

    expect(streams.map((planned) => planned.version.toString())).toStrictEqual(["1.2.0-rc.2"]);
    expect(streams[0]?.identifier).toBe("rc");
    expect(streams[0]?.pointerBase).toBe("1.2.0-rc.1");
    expect(streams[0]?.movesPointer).toBe(true);
  });

  it("mints from the pointer's own next patch when no release decision exists", () => {
    const streams = planStreams([intent("rc")], noOp(), stateOf("1.2.3"), line(), policy());

    expect(streams[0]?.version.toString()).toBe("1.2.4-rc.0");
    expect(streams[0]?.movesPointer).toBe(true);
  });

  it("ignores intents that demand streams of other lines", () => {
    const streams = planStreams(
      [intent("rc", "other")],
      release("patch"),
      stateOf("1.2.3"),
      line(),
      policy(),
    );

    expect(streams).toStrictEqual([]);
  });

  it("plans a stream on a line birth: no pointer standing, nothing to move", () => {
    const streams = planStreams([intent("rc")], noOp(), stateOf(null), line(), policy());

    expect(streams[0]?.version.toString()).toBe("0.0.1-rc.0");
    expect(streams[0]?.pointerBase).toBeNull();
    expect(streams[0]?.movesPointer).toBe(false);
  });

  it("refuses a mint that sorts below the released pointer (D10's override branch)", () => {
    // P-02's ladder regression shape: rc is live at rc.1 while the operator
    // demands beta — beta.0 sorts below rc.1, and this policy input declares
    // no ladder override, so planning fails closed naming both versions.
    const state = stateOf("1.2.4-rc.1", [["1.2.4", "rc", 1]]);
    const attempt = (): unknown =>
      planStreams([intent("beta")], release("patch"), state, line(), policy());

    expect(attempt).toThrow(InvalidPlanningInputError);
    expect(attempt).toThrow(/1\.2\.4-beta\.0/);
    expect(attempt).toThrow(/1\.2\.4-rc\.1/);
  });
});

describe("planStreams — the line's declared stream policy (§2.8, D18)", () => {
  it("mints a listed opaque identifier and omits an unlisted one from the same plan", () => {
    const configured = line("app", { streams: { allow: ["nightly"] } });

    const streams = planStreams(
      [intent("nightly"), intent("alpha")],
      release("patch"),
      stateOf("1.2.3"),
      configured,
      policy(),
    );

    // The opaque identifier is legal exactly by declaration (fork 4): it
    // mints. The unlisted alpha is refused by the declared posture —
    // omitted here, never thrown; assemble composes the refusal record.
    expect(streams.map((planned) => planned.identifier)).toStrictEqual(["nightly"]);
    expect(streams[0]?.version.toString()).toBe("1.2.4-nightly.0");
    expect(streams[0]?.seed).toBe("0");
  });

  it("mints zero streams for a line whose declared posture is allow none", () => {
    const configured = line("app", { streams: { allow: "none" } });

    const streams = planStreams(
      [intent("rc")],
      release("patch"),
      stateOf("1.2.3"),
      configured,
      policy(),
    );

    // M-08's stable-only knob: the demand is refused, never a stable fallback.
    expect(streams).toStrictEqual([]);
  });

  it("a refused demand does not suppress the line's stable target (D18)", () => {
    const targets = planTargets(
      [intent("rc")],
      release("patch"),
      stateOf("1.2.3"),
      line("app", { streams: { allow: "none" } }),
      policy(),
    );

    // M-08's stable half: the prerelease demand is refused, but the line's
    // own release still mints — the plan never goes silently empty.
    expect(targets.stable?.version.toString()).toBe("1.2.4");
    expect(targets.streams).toStrictEqual([]);
  });

  it("an admissible demand still suppresses the stable co-mint alongside refused ones", () => {
    const targets = planTargets(
      [intent("nightly"), intent("alpha")],
      release("patch"),
      stateOf("1.2.3"),
      line("app", { streams: { allow: ["nightly"] } }),
      policy(),
    );

    // D17(3) holds for the admissible nightly demand: the streams carry
    // the target and no stable co-mints; alpha is merely refused.
    expect(targets.stable).toBeNull();
    expect(targets.streams.map((planned) => planned.identifier)).toStrictEqual(["nightly"]);
  });

  it("a line-level seed override wins for its line; the other keeps the global seed (D18)", () => {
    const seeded = line("seeded", { streams: { seed: "1" } });
    const plain = line("plain");
    const demands = [intent("rc", "seeded"), intent("rc", "plain")];

    const seededStreams = planStreams(
      demands,
      release("patch"),
      stateOf("1.2.3"),
      seeded,
      policy(),
    );
    const plainStreams = planStreams(demands, release("patch"), stateOf("1.2.3"), plain, policy());

    // The declared line override lands in the recorded seed (fork 17): the
    // seeded line's fresh key starts at rc.1...
    expect(seededStreams[0]?.version.toString()).toBe("1.2.4-rc.1");
    expect(seededStreams[0]?.seed).toBe("1");
    // ...while the line without the override still reads the global seed.
    expect(plainStreams[0]?.version.toString()).toBe("1.2.4-rc.0");
    expect(plainStreams[0]?.seed).toBe("0");
  });

  it("an absent streams declaration keeps the default posture: every demand mints", () => {
    const streams = planStreams(
      [intent("alpha"), intent("rc")],
      release("patch"),
      stateOf("1.2.3"),
      line(),
      policy(),
    );

    // Defaults-as-data (ADR-0004): no streams declaration is allow "all",
    // the global seed governs, and the plan is bit-for-bit the old shape.
    expect(streams.map((planned) => planned.identifier)).toStrictEqual(["alpha", "rc"]);
    expect(streams[0]?.version.toString()).toBe("1.2.4-alpha.0");
    expect(streams[1]?.seed).toBe("0");
  });
});

describe("tag formatting (fork 11)", () => {
  it("applies the declared per-line tag format template to stream and stable tags", () => {
    // One declared format names both kinds: the {prerelease} token renders
    // `-` + identifiers for a prerelease and empty for a stable (input.ts
    // requires the token), so no template carries a literal separator.
    const bothPolicy = policy({
      tagFormats: { app: "ecoma-app-v{major}.{minor}.{patch}{prerelease}" },
    });
    const streams = planStreams(
      [intent("rc")],
      release("patch"),
      stateOf("1.2.0-rc.3", [["1.2.0", "rc", 3]]),
      line(),
      bothPolicy,
    );
    expect(streams[0]?.tag).toBe("ecoma-app-v1.2.0-rc.4");

    const stable = planTargets([], release("minor"), stateOf("1.2.3"), line(), bothPolicy);
    expect(stable.stable?.tag).toBe("ecoma-app-v1.3.0");
  });

  it("defaults to the bare version when no format is declared for the line", () => {
    const plan = planTargets([], release("minor"), stateOf("1.2.3"), line(), policy());

    expect(plan.stable?.tag).toBe("1.3.0");
  });
});
