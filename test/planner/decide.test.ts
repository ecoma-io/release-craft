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
import { decideLine, resolveBump } from "../../src/planner/decide.js";
import { InvalidPlanningInputError } from "../../src/planner/input.js";
import type {
  BootstrapDecision,
  LineAttribution,
  LineConfig,
  LineRange,
  OperatorIntent,
  ParsedCommit,
  PlanningInput,
  PolicyInput,
  TagObservation,
} from "../../src/planner/types.js";

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
  readonly tags?: readonly TagObservation[];
  readonly lines?: readonly LineConfig[];
}

function planInput(opts: InputOptions = {}): PlanningInput {
  return {
    policy: policy(),
    repository: { commits: [], refs: [] },
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
  opts: { readonly breaking?: boolean } = {},
): ParsedCommit {
  return {
    sha,
    classification: "change",
    type,
    subject: `${type}: fixture subject`,
    breaking: opts.breaking ?? false,
    change: Change.of(changeId, { originCommit: sha }),
  };
}

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
