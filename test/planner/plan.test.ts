/**
 * §2.6–§2.8 target computation (`plan.ts`) — black-box tests over the
 * observable `TargetPlan`/`PlannedStream` values: stable bump arithmetic
 * through the kernel's bump doors with pre-1.0 dampening (§2.7), prerelease
 * sequencing over the rebuilt line state (§2.8), the declared seed (fork 17,
 * decision-log D13), the recorded pointer base and move flag (D9), and the
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

function line(id: string = "app"): LineConfig {
  return { id, feedRef: "main", lifecycle: "active", declared: true };
}

/** A rebuilt line state in the §2.13 shape: pointer plus observed stream keys. */
function stateOf(
  pointer: string | null,
  streams: readonly (readonly [string, string, number])[] = [],
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
    const plan = planTargets(release("patch"), stateOf("1.2.3"), line(), policy());

    expect(plan.stable?.version.toString()).toBe("1.2.4");
    expect(plan.stable?.tag).toBe("1.2.4");
    // The frozen PlanTargets signature carries no intents: the targets-only
    // view plans no streams (planStreams is the composed seam).
    expect(plan.streams).toStrictEqual([]);
  });

  it("applies minor and major bumps through the kernel doors", () => {
    const minor = planTargets(release("minor"), stateOf("1.2.3"), line(), policy());
    const major = planTargets(release("major"), stateOf("1.2.3"), line(), policy());

    expect(minor.stable?.version.toString()).toBe("1.3.0");
    expect(major.stable?.version.toString()).toBe("2.0.0");
  });

  it("dampens a major bump while the pointer sits below 1.0.0 (§2.7)", () => {
    const plan = planTargets(release("major"), stateOf("0.4.2"), line(), policy());

    expect(plan.stable?.version.toString()).toBe("0.5.0");
  });

  it("does not dampen when the knob is off or the pointer has left 0.y.z", () => {
    const knobOff = planTargets(
      release("major"),
      stateOf("0.4.2"),
      line(),
      policy({ pre10Dampening: false }),
    );
    const pastOne = planTargets(release("major"), stateOf("1.2.0"), line(), policy());

    expect(knobOff.stable?.version.toString()).toBe("1.0.0");
    expect(pastOne.stable?.version.toString()).toBe("2.0.0");
  });

  it("treats a null pointer as line birth: bumps from zero, never dampened", () => {
    const patch = planTargets(release("patch"), stateOf(null), line(), policy());
    const minor = planTargets(release("minor"), stateOf(null), line(), policy());
    const major = planTargets(release("major"), stateOf(null), line(), policy());

    expect(patch.stable?.version.toString()).toBe("0.0.1");
    expect(minor.stable?.version.toString()).toBe("0.1.0");
    expect(major.stable?.version.toString()).toBe("1.0.0");
  });

  it("gives a non-release decision a null stable target", () => {
    const plan = planTargets(noOp(), stateOf("1.2.3"), line(), policy());

    expect(plan.stable).toBeNull();
    expect(plan.streams).toStrictEqual([]);
  });
});

describe("planStreams — prerelease sequencing (§2.8)", () => {
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
    const state = stateOf("1.2.0-rc.1", [["1.2.0", "rc", 1]]);

    const streams = planStreams([intent("rc")], release("major"), state, line(), policy());

    // The stable target recomputes to 2.0.0; the re-based rc key is fresh,
    // so the sequence resets to the seed instead of continuing to rc.2.
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
    // 1.2.0-alpha.5 below the rc.1 pointer — D9's refusal, covered below.)
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

  it("refuses a mint that sorts below the released pointer (D9's override branch)", () => {
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

describe("tag formatting (fork 11)", () => {
  it("applies the declared per-line tag format template to stream and stable tags", () => {
    const streamPolicy = policy({
      tagFormats: { app: "ecoma-app-v{major}.{minor}.{patch}-{prerelease}" },
    });
    const streams = planStreams(
      [intent("rc")],
      release("patch"),
      stateOf("1.2.0-rc.3", [["1.2.0", "rc", 3]]),
      line(),
      streamPolicy,
    );
    expect(streams[0]?.tag).toBe("ecoma-app-v1.2.0-rc.4");

    const stablePolicy = policy({ tagFormats: { app: "ecoma-app-v{major}.{minor}.{patch}" } });
    const stable = planTargets(release("minor"), stateOf("1.2.3"), line(), stablePolicy);
    expect(stable.stable?.tag).toBe("ecoma-app-v1.3.0");
  });

  it("defaults to the bare version when no format is declared for the line", () => {
    const plan = planTargets(release("minor"), stateOf("1.2.3"), line(), policy());

    expect(plan.stable?.tag).toBe("1.3.0");
  });
});
