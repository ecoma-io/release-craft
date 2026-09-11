/**
 * Decision tests for §2.7/§2.9 `decide.ts` — bump resolution and the
 * per-line decision records — per
 * [phase2-planner-contract.md](../../docs/design/phase2-planner-contract.md)
 * and ADR-0003 decisions 1, 6 and 13. Fixtures are self-contained:
 * attribution output arrives as declared data (the §2.4 harness contract),
 * with kernel `Change` values built through the barrel door. Assertions
 * target observable records only — kind, cause, bump, ignored enumeration,
 * range/digest passthrough — never implementation internals.
 */
import { describe, expect, it } from "vitest";

import { Change } from "@ecoma-io/release-craft/domain";
import { decideLine, resolveBump } from "@ecoma-io/release-craft/__internal__/planner/decide.js";
import { InvalidPlanningInputError } from "@ecoma-io/release-craft/__internal__/planner/input.js";
import type {
  BootstrapDecision,
  CommitObservation,
  LineAttribution,
  LineConfig,
  LineRange,
  OperatorIntent,
  ParsedCommit,
  PlanningInput,
  PolicyInput,
  TagObservation,
} from "@ecoma-io/release-craft/__internal__/planner/types.js";

const POLICY_DIGEST = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const COMMITTED_AT = "2026-01-01T00:00:00Z";

function policy(): PolicyInput {
  return {
    digest: POLICY_DIGEST,
    bumpMappingId: "default",
    prereleaseLadder: ["alpha", "beta", "rc"],
    prereleaseSeed: "0",
    pre10Dampening: true,
    selfReferenceNamespace: "Release-Craft:",
    tagFormats: {},
  };
}

interface InputOptions {
  readonly intents?: readonly OperatorIntent[];
  readonly bootstrap?: BootstrapDecision;
  readonly commits?: readonly CommitObservation[];
  readonly tags?: readonly TagObservation[];
  readonly lines?: readonly LineConfig[];
}

function planInput(opts: InputOptions = {}): PlanningInput {
  return {
    policy: policy(),
    repository: { commits: opts.commits ?? [], refs: [] },
    history: { tags: opts.tags ?? [] },
    lines: opts.lines ?? [],
    ...(opts.intents !== undefined ? { intents: opts.intents } : {}),
    ...(opts.bootstrap !== undefined ? { bootstrap: opts.bootstrap } : {}),
  };
}

/** One change-classified pending commit, carrying a real kernel change. */
function parsed(
  sha: string,
  type: string,
  changeId: string,
  opts: { readonly breaking?: boolean; readonly scope?: string } = {},
): ParsedCommit {
  return {
    sha,
    classification: "change",
    type,
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    subject: `${type}: fixture subject`,
    breaking: opts.breaking ?? false,
    change: Change.of(changeId, { originCommit: sha }),
  };
}

/** One commit observation carrying the parent graph the range pin reads. */
function observation(sha: string, parents: readonly string[]): CommitObservation {
  return {
    sha,
    parents,
    message: `${sha}: fixture subject`,
    committedAt: COMMITTED_AT,
    containingRefs: [],
  };
}

/** The declared "main" line fixtures for the D18 lifecycle and withhold paths. */
const activeLine: LineConfig = {
  id: "main",
  feedRef: "main",
  lifecycle: "active",
  declared: true,
};

const frozenLine: LineConfig = {
  id: "main",
  feedRef: "main",
  lifecycle: "frozen",
  declared: true,
};

const retiredLine: LineConfig = {
  id: "main",
  feedRef: "main",
  lifecycle: "retired",
  declared: true,
};

const withholdLine: LineConfig = {
  id: "main",
  feedRef: "main",
  lifecycle: "active",
  declared: true,
  withhold: [{ scope: "app", reason: "app is under a change freeze" }],
};

function attribution(
  lineId: string,
  pending: readonly ParsedCommit[],
  released: readonly string[],
): LineAttribution {
  return { lineId, pending, released, excluded: [] };
}

function range(releasedUpTo: string | null = "sha-1-0-1"): LineRange {
  return { lineId: "main", releasedUpTo, head: "sha-head" };
}

/**
 * A planning input over the declared line "main" with an absent version
 * band — the single-line namespace admits every admissible tag (D15) — and
 * the given tag history, whose highest-precedence entry is the line's
 * released pointer (D10). Defaults to the P-03 world: stable 1.1.0 with the
 * in-flight prerelease 1.2.0-rc.1 holding the pointer.
 */
function prereleaseLineInput(
  intents: readonly OperatorIntent[],
  tags: readonly TagObservation[] = [
    { name: "1.1.0", commit: "sha-1-1-0" },
    { name: "1.2.0-rc.1", commit: "sha-c1" },
  ],
): PlanningInput {
  return planInput({
    intents,
    tags,
    lines: [{ id: "main", feedRef: "main", lifecycle: "active", declared: true }],
  });
}

describe("decideLine — §2.9 decision records", () => {
  it("records the chore-only runway as a no-op, enumerating every ignored commit in input order (S-01)", () => {
    const pending = [
      parsed("sha-chore-1", "chore", "chg:c1"),
      parsed("sha-docs-1", "docs", "chg:c2"),
      parsed("sha-ci-1", "ci", "chg:c3"),
    ];

    const evaluated = range();
    const decision = decideLine(
      attribution("main", pending, ["chg:released"]),
      planInput(),
      evaluated,
    );

    expect(decision.kind).toBe("no-op");
    if (decision.kind !== "no-op") {
      throw new Error("expected a no-op record");
    }
    expect(decision.cause).toBe("no-release-worthy-changes");
    expect(decision.ignored.map((entry) => entry.sha)).toEqual([
      "sha-chore-1",
      "sha-docs-1",
      "sha-ci-1",
    ]);
    expect(decision.policyDigest).toBe(POLICY_DIGEST);
    // The evaluated range travels verbatim — same value, not a copy.
    expect(decision.range).toBe(evaluated);
    expect(decision.detail).toContain("sha-docs-1");
  });

  it("blocks the first release when pending work exists but no bootstrap decision is recorded (S-02)", () => {
    const pending = [parsed("sha-feat-1", "feat", "chg:f1"), parsed("sha-fix-1", "fix", "chg:f2")];

    const decision = decideLine(attribution("main", pending, []), planInput(), range(null));

    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") {
      throw new Error("expected a blocked record");
    }
    expect(decision.cause).toBe("bootstrap-required");
    expect(decision.detail).toContain("bootstrap");
  });

  it("releases on a fresh line once the bootstrap decision is recorded (S-02's recorded decision)", () => {
    const pending = [parsed("sha-feat-1", "feat", "chg:f1")];

    const decision = decideLine(
      attribution("main", pending, []),
      planInput({ bootstrap: { version: "1.0.0", who: "operator", when: COMMITTED_AT } }),
      range(null),
    );

    expect(decision.kind).toBe("release");
    if (decision.kind !== "release") {
      throw new Error("expected a release record");
    }
    expect(decision.bump).toBe("minor");
    expect(decision.changes.map((entry) => entry.sha)).toEqual(["sha-feat-1"]);
  });

  it("refuses operator-contradiction when release-as demands a version on a chore-only runway (S-01)", () => {
    const pending = [parsed("sha-chore-1", "chore", "chg:c1")];

    const decision = decideLine(
      attribution("main", pending, ["chg:released"]),
      planInput({ intents: [{ kind: "release-as", version: "1.0.2" }] }),
      range(),
    );

    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") {
      throw new Error("expected a refused record");
    }
    expect(decision.cause).toBe("operator-contradiction");
    expect(decision.detail).toContain("1.0.2");
    expect(decision.policyDigest).toBe(POLICY_DIGEST);
  });

  it("takes Bump.max over members — feat plus fix resolves a minor release", () => {
    const pending = [parsed("sha-fix-1", "fix", "chg:f1"), parsed("sha-feat-1", "feat", "chg:f2")];

    const decision = decideLine(
      attribution("main", pending, ["chg:released"]),
      planInput(),
      range(),
    );

    expect(decision.kind).toBe("release");
    if (decision.kind !== "release") {
      throw new Error("expected a release record");
    }
    expect(decision.bump).toBe("minor");
    expect(decision.changes).toHaveLength(2);
  });

  it("lets a breaking marker dominate a type absent from the mapping — a breaking chore releases major (PL-05)", () => {
    const pending = [
      parsed("sha-chore-flat", "chore", "chg:c1"),
      parsed("sha-chore-breaking", "chore", "chg:c2", { breaking: true }),
    ];

    const decision = decideLine(
      attribution("main", pending, ["chg:released"]),
      planInput(),
      range(),
    );

    expect(decision.kind).toBe("release");
    if (decision.kind !== "release") {
      throw new Error("expected a release record");
    }
    expect(decision.bump).toBe("major");
    // Only the breaking chore is release-worthy; the flat chore contributes
    // nothing even on a releasing line.
    expect(decision.changes.map((entry) => entry.sha)).toEqual(["sha-chore-breaking"]);
  });

  it("surfaces a kernel rejection as a refused record, never re-throwing it (§2.9)", () => {
    // Two members share one change id — a state the real pipeline can reach
    // (extraction surfaces the M-05 conflict but keeps both commits, and §2.4
    // attribution never consults conflicts), and one `ChangeSet.of` rejects.
    const pending = [parsed("sha-a", "fix", "chg:same-id"), parsed("sha-b", "fix", "chg:same-id")];

    const decision = decideLine(
      attribution("main", pending, ["chg:released"]),
      planInput(),
      range(),
    );

    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") {
      throw new Error("expected a refused record");
    }
    expect(decision.cause).toBe("kernel-rejection");
    expect(decision.detail).toContain("chg:same-id");
  });

  it("records a no-op with an empty ignored set when nothing is pending", () => {
    const decision = decideLine(attribution("main", [], ["chg:released"]), planInput(), range());

    expect(decision.kind).toBe("no-op");
    if (decision.kind !== "no-op") {
      throw new Error("expected a no-op record");
    }
    expect(decision.ignored).toHaveLength(0);
  });
});

describe("decideLine — D17(4)(5) intent routing", () => {
  it("promotes an in-flight prerelease to a release with an inherited change set and bump null (P-03, D17(4))", () => {
    const decision = decideLine(
      attribution("main", [], ["chg:rc1"]),
      prereleaseLineInput([{ kind: "promote", lineId: "main" }]),
      range("sha-c1"),
    );

    expect(decision.kind).toBe("release");
    if (decision.kind !== "release") {
      throw new Error("expected a release record");
    }
    expect(decision.bump).toBeNull();
    expect(decision.changes).toHaveLength(0);
    expect(decision.detail).toContain("promot");
  });

  it("names the sibling prerelease demand its promotion subsumes — never a stream extension (D38, #90)", () => {
    const decision = decideLine(
      attribution("main", [], ["chg:rc1"]),
      prereleaseLineInput([
        { kind: "promote", lineId: "main" },
        { kind: "prerelease", stream: "rc", lineId: "main" },
      ]),
      range("sha-c1"),
    );

    expect(decision.kind).toBe("release");
    if (decision.kind !== "release") {
      throw new Error("expected a release record");
    }
    expect(decision.bump).toBeNull();
    // The record names what the pass will not mint (§2.9: a dropped demand
    // is never silent) — the sibling demand is subsumed by the promotion.
    expect(decision.detail).toContain("subsumed");
    expect(decision.detail).toContain("rc");
  });

  it("names every subsumed stream in input order, deduplicated (D38, #90)", () => {
    const decision = decideLine(
      attribution("main", [], ["chg:rc1"]),
      prereleaseLineInput([
        { kind: "prerelease", stream: "beta", lineId: "main" },
        { kind: "promote", lineId: "main" },
        { kind: "prerelease", stream: "rc", lineId: "main" },
        { kind: "prerelease", stream: "beta", lineId: "main" },
      ]),
      range("sha-c1"),
    );

    if (decision.kind !== "release") {
      throw new Error("expected a release record");
    }
    expect(decision.bump).toBeNull();
    expect(decision.detail).toContain("beta, rc");
  });

  it("keeps the promotion record unchanged when no sibling prerelease demand exists", () => {
    const decision = decideLine(
      attribution("main", [], ["chg:rc1"]),
      prereleaseLineInput([{ kind: "promote", lineId: "main" }]),
      range("sha-c1"),
    );

    if (decision.kind !== "release") {
      throw new Error("expected a release record");
    }
    // D38's subsumption clause rides only a combined-intent input — the
    // single-intent promotion record is byte-identical to its pre-D38 shape.
    expect(decision.detail).toBe(
      "promotion of the in-flight prerelease 1.2.0-rc.1 — the change set is inherited from the stream, so no bump was resolved from pending (P-03)",
    );
  });

  it("refuses a promotion with release-worthy changes pending — never a silent absorb (P-03's failure mode)", () => {
    const decision = decideLine(
      attribution("main", [parsed("sha-fix-1", "fix", "chg:f1")], ["chg:rc1"]),
      prereleaseLineInput([{ kind: "promote", lineId: "main" }]),
      range("sha-c1"),
    );

    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") {
      throw new Error("expected a refused record");
    }
    expect(decision.cause).toBe("operator-contradiction");
    expect(decision.detail).toContain("sha-fix-1");
  });

  it("refuses a promotion when the pointer is held by a stable version, not an in-flight prerelease", () => {
    const decision = decideLine(
      attribution("main", [parsed("sha-fix-1", "fix", "chg:f1")], ["chg:stable"]),
      prereleaseLineInput(
        [{ kind: "promote", lineId: "main" }],
        [{ name: "1.2.0", commit: "sha-stable" }],
      ),
      range("sha-stable"),
    );

    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") {
      throw new Error("expected a refused record");
    }
    expect(decision.cause).toBe("operator-contradiction");
    expect(decision.detail).toContain("1.2.0");
  });

  it("refuses a promotion on a line whose pointer is null — no release exists to promote", () => {
    const decision = decideLine(
      attribution("main", [], []),
      prereleaseLineInput([{ kind: "promote", lineId: "main" }], []),
      range(null),
    );

    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") {
      throw new Error("expected a refused record");
    }
    expect(decision.cause).toBe("operator-contradiction");
    expect(decision.detail).toContain("no releases");
  });

  it("records release-anyway over a quiet line as a forced record — never a routine release, no mint (D17(5))", () => {
    const decision = decideLine(
      attribution("main", [parsed("sha-chore-1", "chore", "chg:c1")], ["chg:released"]),
      planInput({ intents: [{ kind: "release-anyway" }] }),
      range(),
    );

    expect(decision.kind).toBe("forced");
    if (decision.kind !== "forced") {
      throw new Error("expected a forced record");
    }
    expect(decision.cause).toBe("release-anyway");
    expect(decision.policyDigest).toBe(POLICY_DIGEST);
    expect(decision.detail).toContain("operator-forced");
  });

  it("lets the ordinary release stand when release-anyway rides a release-worthy runway — the intent is satisfied", () => {
    const decision = decideLine(
      attribution("main", [parsed("sha-feat-1", "feat", "chg:f1")], ["chg:released"]),
      planInput({ intents: [{ kind: "release-anyway" }] }),
      range(),
    );

    expect(decision.kind).toBe("release");
    if (decision.kind !== "release") {
      throw new Error("expected a release record");
    }
    expect(decision.bump).toBe("minor");
    expect(decision.changes.map((entry) => entry.sha)).toEqual(["sha-feat-1"]);
  });

  it("refuses promote and release-anyway together on one line — the intents contradict each other", () => {
    const decision = decideLine(
      attribution("main", [], ["chg:rc1"]),
      prereleaseLineInput([{ kind: "promote", lineId: "main" }, { kind: "release-anyway" }]),
      range("sha-c1"),
    );

    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") {
      throw new Error("expected a refused record");
    }
    expect(decision.cause).toBe("operator-contradiction");
    expect(decision.detail).toContain("release-anyway");
  });

  it("refuses a release-as demand whose version the kernel grammar rejects — before any runway evaluation", () => {
    const decision = decideLine(
      attribution("main", [parsed("sha-feat-1", "feat", "chg:f1")], ["chg:released"]),
      planInput({ intents: [{ kind: "release-as", version: "1.0" }] }),
      range(),
    );

    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") {
      throw new Error("expected a refused record");
    }
    expect(decision.cause).toBe("operator-contradiction");
    expect(decision.detail).toContain("1.0");
  });

  it("does not demand bootstrap when the range's released bound exists but spans no released identities (m-4)", () => {
    const pending = [parsed("sha-chore-1", "chore", "chg:c1")];

    const decision = decideLine(attribution("main", pending, []), planInput(), range("sha-1-0-1"));

    expect(decision.kind).toBe("no-op");
    if (decision.kind !== "no-op") {
      throw new Error("expected a no-op record");
    }
    expect(decision.cause).toBe("no-release-worthy-changes");
  });

  it("collapses exact-duplicate intents before routing — duplicated promotes stay one promotion", () => {
    const decision = decideLine(
      attribution("main", [], ["chg:rc1"]),
      prereleaseLineInput([
        { kind: "promote", lineId: "main" },
        { kind: "promote", lineId: "main" },
      ]),
      range("sha-c1"),
    );

    expect(decision.kind).toBe("release");
    if (decision.kind !== "release") {
      throw new Error("expected a release record");
    }
    expect(decision.bump).toBeNull();
  });
});

describe("decideLine — §2.9 as amended (#263): the released-version replay", () => {
  // The hosted shape of runs 34597572065 / 34597897169, at the decision
  // level: the world observes the release under its full git refname at
  // the line's head, the recorded bootstrap that birthed the line is in
  // the input, and a release demand re-arrives over the unchanged head.
  const replayTags = [{ name: "refs/tags/0.1.0", commit: "sha-head" }];
  const replayBootstrap = { version: "0.1.0", who: "the operator", when: COMMITTED_AT };
  const releasedRange = (): LineRange => ({
    lineId: "main",
    releasedUpTo: "sha-head",
    head: "sha-head",
  });

  it("blocks the unchanged re-dispatch over a released head as the released-version replay (#263)", () => {
    const evaluated = releasedRange();
    const decision = decideLine(
      attribution("main", [], []),
      planInput({
        intents: [{ kind: "release" }],
        bootstrap: replayBootstrap,
        tags: replayTags,
        lines: [activeLine],
      }),
      evaluated,
    );

    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") {
      throw new Error("expected a blocked record");
    }
    expect(decision.cause).toBe("released-version-observed");
    // The record names the observed tag, its version, the head it sits at,
    // and the recorded birth it would re-execute.
    expect(decision.detail).toContain("refs/tags/0.1.0");
    expect(decision.detail).toContain("0.1.0");
    expect(decision.detail).toContain("sha-head");
    expect(decision.detail).toContain("0.1.0, recorded by the operator");
    // Range and digest travel verbatim — same value, not a copy.
    expect(decision.range).toBe(evaluated);
    expect(decision.policyDigest).toBe(POLICY_DIGEST);
  });

  it("keeps the recorded no-op when the same released head carries no release demand (#263)", () => {
    const decision = decideLine(
      attribution("main", [], []),
      planInput({ bootstrap: replayBootstrap, tags: replayTags, lines: [activeLine] }),
      releasedRange(),
    );

    expect(decision.kind).toBe("no-op");
    if (decision.kind !== "no-op") {
      throw new Error("expected a no-op record");
    }
    expect(decision.cause).toBe("no-release-worthy-changes");
  });

  it("releases the next version when the observed tag sits at an older commit and release-worthy work is pending (#263)", () => {
    const pending = [parsed("sha-fix-1", "fix", "chg:f1")];

    const decision = decideLine(
      attribution("main", pending, ["chg:f1"]),
      planInput({
        intents: [{ kind: "release" }],
        bootstrap: replayBootstrap,
        tags: [{ name: "refs/tags/0.1.0", commit: "sha-old" }],
        lines: [activeLine],
      }),
      { lineId: "main", releasedUpTo: "sha-old", head: "sha-head" },
    );

    expect(decision.kind).toBe("release");
    if (decision.kind !== "release") {
      throw new Error("expected a release record");
    }
    expect(decision.bump).toBe("patch");
  });

  it("keeps the recorded no-op when a release demand finds nothing pending since the release (#263)", () => {
    // The birth tag is admitted and the head has moved, but only by
    // non-release-triggering commits: the bounds differ, so the replay
    // record does not stand and the chore-only runway stays the no-op.
    const pending = [parsed("sha-chore-1", "chore", "chg:c1")];

    const decision = decideLine(
      attribution("main", pending, []),
      planInput({
        intents: [{ kind: "release" }],
        bootstrap: replayBootstrap,
        tags: [{ name: "refs/tags/0.1.0", commit: "sha-old" }],
        lines: [activeLine],
      }),
      { lineId: "main", releasedUpTo: "sha-old", head: "sha-head" },
    );

    expect(decision.kind).toBe("no-op");
    if (decision.kind !== "no-op") {
      throw new Error("expected a no-op record");
    }
    expect(decision.cause).toBe("no-release-worthy-changes");
  });

  it("does not claim a recorded birth the line's own band keeps foreign — a quiet released head stays a no-op (#263)", () => {
    // The maintenance posture (S-05): the run's recorded bootstrap names
    // the sibling 0.x line's birth; this line's declared band excludes
    // that version, so the line claims no birth and its fully released
    // head stays the recorded no-op even under the release demand.
    const bandedLine: LineConfig = {
      id: "main",
      feedRef: "main",
      lifecycle: "active",
      declared: true,
      versionBand: { major: 2 },
    };

    const decision = decideLine(
      attribution("main", [], []),
      planInput({
        intents: [{ kind: "release" }],
        bootstrap: replayBootstrap,
        tags: [
          { name: "refs/tags/0.1.0", commit: "sha-head" },
          { name: "2.3.0", commit: "sha-head" },
        ],
        lines: [bandedLine],
      }),
      releasedRange(),
    );

    expect(decision.kind).toBe("no-op");
    if (decision.kind !== "no-op") {
      throw new Error("expected a no-op record");
    }
    expect(decision.cause).toBe("no-release-worthy-changes");
  });

  it("blocks a release-as demand naming a version the line's history already observes (#263)", () => {
    const pending = [parsed("sha-fix-1", "fix", "chg:f1")];

    const decision = decideLine(
      attribution("main", pending, ["chg:f1"]),
      planInput({
        intents: [{ kind: "release-as", version: "0.1.0" }],
        tags: [{ name: "refs/tags/0.1.0", commit: "sha-old" }],
        lines: [activeLine],
      }),
      { lineId: "main", releasedUpTo: "sha-old", head: "sha-head" },
    );

    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") {
      throw new Error("expected a blocked record");
    }
    expect(decision.cause).toBe("released-version-observed");
    expect(decision.detail).toContain("release-as 0.1.0");
    expect(decision.detail).toContain("refs/tags/0.1.0");
  });

  it("honors a release-as demand naming a version the history does not observe (#263)", () => {
    const pending = [parsed("sha-fix-1", "fix", "chg:f1")];

    const decision = decideLine(
      attribution("main", pending, ["chg:f1"]),
      planInput({
        intents: [{ kind: "release-as", version: "0.2.0" }],
        tags: [{ name: "refs/tags/0.1.0", commit: "sha-old" }],
        lines: [activeLine],
      }),
      { lineId: "main", releasedUpTo: "sha-old", head: "sha-head" },
    );

    expect(decision.kind).toBe("release");
    if (decision.kind !== "release") {
      throw new Error("expected a release record");
    }
    expect(decision.bump).toBe("patch");
  });

  it("keeps the ladder's no-op posture when an admissible prerelease demand rides over the released head (#263)", () => {
    // The prerelease demand mints the NEXT version's next sequence — a new
    // identity, never a re-release — so the released head keeps its
    // no-op-plus-streams posture and the replay record does not stand.
    const decision = decideLine(
      attribution("main", [], []),
      planInput({
        intents: [{ kind: "prerelease", stream: "beta", lineId: "main" }],
        bootstrap: replayBootstrap,
        tags: replayTags,
        lines: [activeLine],
      }),
      releasedRange(),
    );

    expect(decision.kind).toBe("no-op");
    if (decision.kind !== "no-op") {
      throw new Error("expected a no-op record");
    }
    expect(decision.cause).toBe("no-release-worthy-changes");
  });
});

describe("decideLine — D18 line policy (lifecycle, withhold)", () => {
  it("refuses a frozen line's release-shaped planning with cause line-frozen, regardless of pending release-worthy changes (D18 decision 2)", () => {
    const pending = [parsed("sha-fix-1", "fix", "chg:f1"), parsed("sha-feat-1", "feat", "chg:f2")];
    const evaluated = range();

    const decision = decideLine(
      attribution("main", pending, ["chg:released"]),
      planInput({ lines: [frozenLine] }),
      evaluated,
    );

    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") {
      throw new Error("expected a refused record");
    }
    expect(decision.cause).toBe("line-frozen");
    expect(decision.detail).toContain("frozen");
    expect(decision.policyDigest).toBe(POLICY_DIGEST);
    expect(decision.range).toBe(evaluated);
  });

  it("refuses a retired line with cause line-retired, naming the state in the detail (D18 decision 2)", () => {
    const decision = decideLine(
      attribution("main", [parsed("sha-fix-1", "fix", "chg:f1")], ["chg:released"]),
      planInput({ lines: [retiredLine] }),
      range(),
    );

    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") {
      throw new Error("expected a refused record");
    }
    expect(decision.cause).toBe("line-retired");
    expect(decision.detail).toContain("retired");
  });

  it("lands a frozen line's intents on the lifecycle refusal — promote and release-anyway never evaluate (D18 decision 2)", () => {
    const decision = decideLine(
      attribution("main", [parsed("sha-feat-1", "feat", "chg:f1")], ["chg:released"]),
      planInput({
        intents: [{ kind: "promote", lineId: "main" }, { kind: "release-anyway" }],
        lines: [frozenLine],
      }),
      range(),
    );

    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") {
      throw new Error("expected a refused record");
    }
    // The intent gates would refuse with operator-contradiction or route
    // the promotion; the lifecycle refusal must precede them all.
    expect(decision.cause).toBe("line-frozen");
  });

  it("keeps an explicitly active line's ordinary release posture — the lifecycle gate is inert (D18 decision 2)", () => {
    const pending = [parsed("sha-fix-1", "fix", "chg:f1"), parsed("sha-feat-1", "feat", "chg:f2")];
    const evaluated = range();

    const decision = decideLine(
      attribution("main", pending, ["chg:released"]),
      planInput({ lines: [activeLine] }),
      evaluated,
    );

    expect(decision.kind).toBe("release");
    if (decision.kind !== "release") {
      throw new Error("expected a release record");
    }
    expect(decision.bump).toBe("minor");
    expect(decision.changes).toHaveLength(2);
    expect(decision.range).toBe(evaluated);
  });

  it("records a fully withheld runway as the withheld policy-filter record, enumerating every withheld commit (D18 decision 3, PL-07)", () => {
    const pending = [
      parsed("sha-fix-1", "fix", "chg:f1", { scope: "app" }),
      parsed("sha-feat-1", "feat", "chg:f2", { scope: "app" }),
    ];
    const evaluated = range();

    const decision = decideLine(
      attribution("main", pending, ["chg:released"]),
      planInput({ lines: [withholdLine] }),
      evaluated,
    );

    expect(decision.kind).toBe("withheld");
    if (decision.kind !== "withheld") {
      throw new Error("expected a withheld record");
    }
    expect(decision.cause).toBe("policy-filter");
    expect(decision.withheld.map((entry) => entry.sha)).toEqual(["sha-fix-1", "sha-feat-1"]);
    expect(decision.detail).toContain("app is under a change freeze");
    expect(decision.policyDigest).toBe(POLICY_DIGEST);
    expect(decision.range).toBe(evaluated);
  });

  it("releases the surviving prefix when a withhold rule matches some changes — the range pins below the earliest withheld commit (D18 decision 3, PL-07)", () => {
    const pending = [
      parsed("sha-fix-1", "fix", "chg:f1", { scope: "deps" }),
      parsed("sha-feat-w", "feat", "chg:w1", { scope: "app" }),
      parsed("sha-fix-2", "fix", "chg:f2", { scope: "deps" }),
    ];

    const decision = decideLine(
      attribution("main", pending, ["chg:released"]),
      planInput({
        commits: [
          observation("sha-1-0-1", []),
          observation("sha-fix-1", ["sha-1-0-1"]),
          observation("sha-feat-w", ["sha-fix-1"]),
          observation("sha-fix-2", ["sha-feat-w"]),
        ],
        lines: [withholdLine],
      }),
      range(),
    );

    expect(decision.kind).toBe("release");
    if (decision.kind !== "release") {
      throw new Error("expected a release record");
    }
    // Only the prefix before the withheld commit releases: the withheld
    // feat and the fix after it stay inside the un-released span.
    expect(decision.changes.map((entry) => entry.sha)).toEqual(["sha-fix-1"]);
    // The withheld feat's minor never leaks into the surviving bump.
    expect(decision.bump).toBe("patch");
    expect(decision.range.head).toBe("sha-fix-1");
    expect(decision.range.releasedUpTo).toBe("sha-1-0-1");
    expect(decision.detail).toContain("sha-feat-w");
  });

  it("defers the whole runway when the earliest withheld commit sits before every release-worthy change (D18 decision 3, PL-07)", () => {
    const pending = [
      parsed("sha-feat-w", "feat", "chg:w1", { scope: "app" }),
      parsed("sha-fix-1", "fix", "chg:f1", { scope: "deps" }),
    ];

    const decision = decideLine(
      attribution("main", pending, ["chg:released"]),
      planInput({
        commits: [
          observation("sha-feat-w", ["sha-1-0-1"]),
          observation("sha-fix-1", ["sha-feat-w"]),
        ],
        lines: [withholdLine],
      }),
      range(),
    );

    expect(decision.kind).toBe("withheld");
    if (decision.kind !== "withheld") {
      throw new Error("expected a withheld record");
    }
    // Pinning below the withheld commit would leave the release span empty,
    // so nothing mints and the follower defers with the withheld commit.
    expect(decision.withheld.map((entry) => entry.sha)).toEqual(["sha-feat-w"]);
  });

  it("lets changes whose scope matches no withhold rule pass through untouched — deferral never eats unrelated changes (D18 decision 3, PL-07)", () => {
    const pending = [
      parsed("sha-fix-1", "fix", "chg:f1", { scope: "deps" }),
      parsed("sha-feat-1", "feat", "chg:f2", { scope: "cli" }),
    ];
    const evaluated = range();

    const decision = decideLine(
      attribution("main", pending, ["chg:released"]),
      planInput({ lines: [withholdLine] }),
      evaluated,
    );

    expect(decision.kind).toBe("release");
    if (decision.kind !== "release") {
      throw new Error("expected a release record");
    }
    expect(decision.changes).toHaveLength(2);
    expect(decision.bump).toBe("minor");
    expect(decision.range).toBe(evaluated);
  });
});

describe("resolveBump — §2.7 declared mapping", () => {
  it("throws InvalidPlanningInputError naming policy.bumpMappingId for an undeclared mapping id", () => {
    const strict: PolicyInput = { ...policy(), bumpMappingId: "strict" };

    expect(() => resolveBump([], strict)).toThrow(InvalidPlanningInputError);
    expect(() => resolveBump([], strict)).toThrow(
      /1 violation: policy\.bumpMappingId: unknown bump mapping id "strict"/,
    );
  });

  it("resolves undefined over a non-release-triggering pending set — the no-op cause", () => {
    const pending = [
      parsed("sha-chore-1", "chore", "chg:c1"),
      parsed("sha-test-1", "test", "chg:c2"),
    ];

    expect(resolveBump(pending, policy())).toBeUndefined();
  });

  it("resolves major when a breaking marker rides a type absent from the mapping (PL-05)", () => {
    const pending = [parsed("sha-chore-breaking", "chore", "chg:c1", { breaking: true })];

    expect(resolveBump(pending, policy())).toBe("major");
  });
});

// ---------------------------------------------------------------------------
// PL-05 — ambiguous commits: the unresolvable evidence and the deduplicated set
// ---------------------------------------------------------------------------

describe("decideLine — PL-05 ambiguous commits", () => {
  it("records the genuinely unresolvable commit as a refused block naming the contested identity — no release, no target or stream, none minted (PL-05a; the decide-layer record is refused/kernel-rejection — one change identity carried by two members)", () => {
    // The row's shape (a) reaches the decision layer as evidence it cannot
    // rank: a merge commit and its branch commit both carry the one change
    // identity, and the kernel's "one identity is one member" rule makes the
    // change set unconstructable. The layer records the block (invariant 4)
    // instead of guessing a winner or silently releasing. (The scope-clash
    // form of the ambiguity fails closed upstream, in attribution — its
    // refusal never reaches decideLine.)
    const pending = [
      parsed("sha-merge-m", "fix", "chg:m1"),
      parsed("sha-branch-m", "fix", "chg:m1"),
    ];

    const evaluated = range();
    const decision = decideLine(
      attribution("main", pending, ["chg:released"]),
      planInput(),
      evaluated,
    );

    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") {
      throw new Error("expected a refused record");
    }
    expect(decision.cause).toBe("kernel-rejection");
    // The ambiguous evidence is named: the contested identity.
    expect(decision.detail).toContain("chg:m1");
    expect(decision.policyDigest).toBe(POLICY_DIGEST);
    expect(decision.range).toBe(evaluated);
    // The row's "(a) none": the recorded block carries no target, no
    // stream, and no minted version — exactly the refused record's fields.
    expect(Object.keys(decision).sort()).toEqual([
      "cause",
      "detail",
      "kind",
      "lineId",
      "policyDigest",
      "range",
    ]);
  });

  it("releases normally from the deduplicated set — the merge commit is structural, the branch member carries the change once (PL-05c)", () => {
    // The row's shape (c): the range holds merge commit M whose branch
    // commit is also individually in range. Under the recorded range-walk
    // policy the merge is deduplicated upstream — extraction classifies it
    // structural, not change-bearing — so the decision layer sees the
    // deduplicated set and answers with an ordinary release, each change
    // exactly once.
    const branchFix = parsed("sha-branch-m", "fix", "chg:m1");
    const deduplicated: LineAttribution = {
      ...attribution("main", [branchFix], ["chg:released"]),
      excluded: [
        {
          sha: "sha-merge-m",
          rule: "unparseable",
          detail: "merge commit: structural, not change-bearing",
        },
      ],
    };

    const decision = decideLine(deduplicated, planInput(), range());

    expect(decision.kind).toBe("release");
    if (decision.kind !== "release") {
      throw new Error("expected a release record");
    }
    // The bump resolves from the deduplicated member alone.
    expect(decision.bump).toBe("patch");
    // The change set carries the deduplicated member(s): the branch fix
    // once — the merge commit's duplicate occurrence is nowhere in it.
    expect(decision.changes.map((entry) => entry.sha)).toEqual(["sha-branch-m"]);
    expect(decision.changes[0]?.change?.id).toBe("chg:m1");
    // A normal release — no withheld, no forced, no extra record fields.
    expect(Object.keys(decision).sort()).toEqual([
      "bump",
      "changes",
      "detail",
      "kind",
      "lineId",
      "policyDigest",
      "range",
    ]);
  });
});
