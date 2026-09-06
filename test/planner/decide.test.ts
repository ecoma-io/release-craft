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
  LineRange,
  OperatorIntent,
  ParsedCommit,
  PlanningInput,
  PolicyInput,
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
}

function planInput(opts: InputOptions = {}): PlanningInput {
  return {
    policy: policy(),
    repository: { commits: [], refs: [] },
    history: { tags: [] },
    lines: [],
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
