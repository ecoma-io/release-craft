/**
 * `proposeBootstrap` (issue #208, the surface of issue #207's door) as a
 * pure function: the gaps it refuses, the baselines it names, the
 * declared values it carries verbatim, the tag-format inference whose
 * evidence is quoted, and the determinism invariant (identical
 * observations propose identical worlds). No assembly, no I/O — the door
 * composes records and the tests assert the composition.
 */

import { describe, expect, it } from "vitest";

import {
  BOOTSTRAP_BASELINE_POLICY,
  proposeBootstrap,
  type BootstrapObservations,
  type BootstrapProposal,
  type BootstrapProposeResult,
  type BootstrapRefusal,
} from "@ecoma-io/release-craft/app";

/** Minimal observations — the door reads only `history.tags[].name` and
 * passes the evidence halves through; the shapes are the planner's own. */
const observations = (
  overrides: Partial<BootstrapObservations> = {},
  tagNames: readonly string[] = [],
): BootstrapObservations => ({
  repository: { commits: [], refs: [] },
  history: { tags: tagNames.map((name) => ({ name, commit: `m-${name}` })) },
  ...overrides,
});

const soleLine: BootstrapObservations["lines"] = [
  { id: "main", feedRef: "refs/heads/main", lifecycle: "active", declared: true },
];

/** The narrowing guards keep every `expect` at the test body's top level
 * (the vitest rules forbid conditional expects); a mis-shaped result is
 * a thrown failure, not a skipped assertion. */
const expectGaps = (result: BootstrapProposeResult): BootstrapRefusal => {
  if (!("gaps" in result)) {
    throw new Error("expected gaps, got a proposal");
  }
  return result;
};

const expectProposed = (result: BootstrapProposeResult): BootstrapProposal => {
  if (!("input" in result)) {
    throw new Error("expected a proposal, got gaps");
  }
  return result;
};

describe("issue #208 — proposeBootstrap refuses the gaps it cannot carry", () => {
  it("an absent digest and an absent line list are the two declaration gaps, in order", () => {
    const refusal = expectGaps(proposeBootstrap(observations()));
    expect(refusal.gaps.map((gap) => gap.field)).toStrictEqual(["policy.digest", "lines"]);
    expect(refusal.gaps[0]?.problem).toContain("invariant 4");
    expect(refusal.gaps[1]?.problem).toContain("invariant 7");
  });

  it("an empty digest and an empty line list are the same refusals", () => {
    const refusal = expectGaps(
      proposeBootstrap(observations({ policy: { digest: "" }, lines: [] as never })),
    );
    expect(refusal.gaps.map((gap) => gap.field)).toStrictEqual(["policy.digest", "lines"]);
  });
});

describe("issue #208 — the completed policy: declared verbatim, absent named as baseline", () => {
  it("declared fields pass through and the ledger says declared", () => {
    const { input, inferences } = expectProposed(
      proposeBootstrap(
        observations({
          policy: {
            digest: "sha256:" + "a".repeat(64),
            bumpMappingId: "default",
            prereleaseSeed: "1",
          },
          lines: soleLine,
        }),
      ),
    );
    expect(input.policy.digest).toBe("sha256:" + "a".repeat(64));
    expect(input.policy.prereleaseSeed).toBe("1");
    const declared = inferences.filter((row) => row.kind === "declared");
    expect(declared.map((row) => row.field)).toContain("policy.digest");
    expect(declared.map((row) => row.field)).toContain("policy.prereleaseSeed");
  });

  it("absent fields take the baseline and the ledger names it, with the value quoted", () => {
    const { input, inferences } = expectProposed(
      proposeBootstrap(observations({ policy: { digest: "d" }, lines: soleLine })),
    );
    expect(input.policy.bumpMappingId).toBe(BOOTSTRAP_BASELINE_POLICY.bumpMappingId);
    expect(input.policy.prereleaseLadder).toStrictEqual(BOOTSTRAP_BASELINE_POLICY.prereleaseLadder);
    expect(input.policy.prereleaseSeed).toBe(BOOTSTRAP_BASELINE_POLICY.prereleaseSeed);
    expect(input.policy.pre10Dampening).toBe(BOOTSTRAP_BASELINE_POLICY.pre10Dampening);
    expect(input.policy.selfReferenceNamespace).toBe(
      BOOTSTRAP_BASELINE_POLICY.selfReferenceNamespace,
    );
    const baselined = inferences.filter((row) => row.kind === "baseline");
    expect(baselined.map((row) => row.field)).toContain("policy.bumpMappingId");
    const row = baselined.find((candidate) => candidate.field === "policy.prereleaseLadder");
    expect(row?.evidence).toContain(JSON.stringify(BOOTSTRAP_BASELINE_POLICY.prereleaseLadder));
    expect(row?.evidence).toContain("override it in the declared policy");
  });

  it("absent declaration halves stay absent in the proposed world", () => {
    const { input } = expectProposed(
      proposeBootstrap(observations({ policy: { digest: "d" }, lines: soleLine })),
    );
    expect(input).not.toHaveProperty("intents");
    expect(input).not.toHaveProperty("channels");
  });
});

describe("issue #208 — the tag-format inference proposes only the unambiguous case", () => {
  it("one line, no declared format, exactly one prefix: the format is proposed with the tags quoted", () => {
    const { input, inferences } = expectProposed(
      proposeBootstrap(
        observations({ policy: { digest: "d" }, lines: soleLine }, [
          "lib-a-v1.2.3",
          "lib-a-v2.0.0-rc.1",
        ]),
      ),
    );
    expect(input.policy.tagFormats).toStrictEqual({
      main: "lib-a-v{major}.{minor}.{patch}{prerelease}",
    });
    const inference = inferences.find((row) => row.field === 'policy.tagFormats["main"]');
    expect(inference?.kind).toBe("inferred");
    expect(inference?.evidence).toContain(JSON.stringify("lib-a-v1.2.3"));
    expect(inference?.evidence).toContain(JSON.stringify("lib-a-v2.0.0-rc.1"));
    expect(inference?.evidence).toContain("Re-declare the policy digest");
  });

  it("two distinct prefixes propose nothing", () => {
    const { input, inferences } = expectProposed(
      proposeBootstrap(
        observations({ policy: { digest: "d" }, lines: soleLine }, [
          "lib-a-v1.2.3",
          "other-v2.0.0",
        ]),
      ),
    );
    expect(input.policy.tagFormats).toStrictEqual({});
    expect(inferences.some((row) => row.kind === "inferred")).toBe(false);
  });

  it("a declared format for the line proposes nothing", () => {
    const { input, inferences } = expectProposed(
      proposeBootstrap(
        observations(
          {
            policy: { digest: "d", tagFormats: { main: "v{major}.{minor}.{patch}{prerelease}" } },
            lines: soleLine,
          },
          ["lib-a-v1.2.3"],
        ),
      ),
    );
    expect(input.policy.tagFormats).toStrictEqual({
      main: "v{major}.{minor}.{patch}{prerelease}",
    });
    expect(inferences.some((row) => row.kind === "inferred")).toBe(false);
  });

  it("two declared lines propose nothing — there is no sole line to attribute the prefix to", () => {
    const twoLines: BootstrapObservations["lines"] = [
      { id: "main", feedRef: "refs/heads/main", lifecycle: "active", declared: true },
      { id: "next", feedRef: "refs/heads/next", lifecycle: "active", declared: true },
    ];
    const { inferences } = expectProposed(
      proposeBootstrap(
        observations({ policy: { digest: "d" }, lines: twoLines }, ["lib-a-v1.2.3"]),
      ),
    );
    expect(inferences.some((row) => row.kind === "inferred")).toBe(false);
  });

  it("tags without a version-shaped suffix are no evidence at all", () => {
    const { input, inferences } = expectProposed(
      proposeBootstrap(
        observations({ policy: { digest: "d" }, lines: soleLine }, ["nightly", "release"]),
      ),
    );
    expect(input.policy.tagFormats).toStrictEqual({});
    expect(inferences.some((row) => row.kind === "inferred")).toBe(false);
  });
});

describe("issue #208 — the door is pure (invariant 2, inherited)", () => {
  it("identical observations propose identical worlds and ledgers", () => {
    const doc = observations({ policy: { digest: "d" }, lines: soleLine }, ["lib-a-v1.2.3"]);
    expect(proposeBootstrap(doc)).toStrictEqual(proposeBootstrap(doc));
  });
});
