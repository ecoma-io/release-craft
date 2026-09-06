/**
 * Adversarial black-box tests for §2.3 extraction (fork 8 identity) and the
 * §2.12 self-reference exclusion, per
 * [phase2-planner-contract.md](../../docs/design/phase2-planner-contract.md)
 * and ADR-0003. Fixtures are self-contained; assertions target observable
 * outcomes only — classification, identity, lineage, surfacing — never the
 * implementation's internals.
 */
import { describe, expect, it } from "vitest";

import { extract } from "../../src/planner/extract.js";
import type { CommitObservation, ExtractionResult, PolicyInput } from "../../src/planner/types.js";

const NAMESPACE = "Release-Craft:";
const COMMITTED_AT = "2026-01-01T00:00:00Z";

function policy(): PolicyInput {
  return {
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    bumpMappingId: "default",
    prereleaseLadder: ["alpha", "beta", "rc"],
    prereleaseSeed: "0",
    pre10Dampening: true,
    selfReferenceNamespace: NAMESPACE,
    tagFormats: {},
  };
}

function commit(
  sha: string,
  message: string,
  opts: { readonly parents?: readonly string[] } = {},
): CommitObservation {
  return {
    sha,
    parents: opts.parents ?? [],
    message,
    committedAt: COMMITTED_AT,
    containingRefs: [],
  };
}

function parsedBySha(result: ExtractionResult, sha: string) {
  const parsed = result.commits.find((candidate) => candidate.sha === sha);
  if (parsed === undefined) {
    throw new Error(`fixture broken: ${sha} missing from extraction output`);
  }
  return parsed;
}

describe("extract — adversarial identity and classification", () => {
  it("resolves a cherry-pick chain (f3 from f2 from f) to one identity with the lineage chain recorded", () => {
    const f = commit("f0f0f0", "fix: add retry");
    const f2 = commit("f1f1f1", "fix: add retry\n\n(cherry picked from commit f0f0f0)", {
      parents: ["f0f0f0"],
    });
    const f3 = commit("f2f2f2", "fix: add retry\n\n(cherry picked from commit f1f1f1)", {
      parents: ["f1f1f1"],
    });

    const result = extract([f, f2, f3], policy());

    const root = parsedBySha(result, "f0f0f0");
    expect(root.classification).toBe("change");
    expect(root.identitySource).toBe("commit-sha");
    expect(root.change?.id).toBe("f0f0f0");

    const mid = parsedBySha(result, "f1f1f1");
    expect(mid.classification).toBe("change");
    expect(mid.identitySource).toBe("cherry-pick-origin");
    expect(mid.change?.id).toBe("f0f0f0");
    expect(mid.change?.lineage.originCommit).toBe("f0f0f0");

    const tip = parsedBySha(result, "f2f2f2");
    expect(tip.classification).toBe("change");
    expect(tip.identitySource).toBe("cherry-pick-origin");
    expect(tip.change?.id).toBe("f0f0f0");
    expect(tip.change?.lineage.originCommit).toBe("f1f1f1");

    // A legal cherry-pick chain is one identity, not a conflict (M-03).
    expect(result.conflicts).toHaveLength(0);
    expect(result.excluded).toHaveLength(0);
  });

  it("prefers the Change-Id footer over the cherry-pick trailer when both are present", () => {
    const both = commit(
      "bbb000",
      "fix: move fast\n\nChange-Id: Iwin999\n(cherry picked from commit gone000)",
    );

    const result = extract([both], policy());

    const parsed = parsedBySha(result, "bbb000");
    expect(parsed.classification).toBe("change");
    expect(parsed.identitySource).toBe("change-id-footer");
    expect(parsed.change?.id).toBe("Iwin999");
  });

  it("surfaces a conflict for one Change-Id claimed by two unrelated shas and never merges them", () => {
    const a = commit("aaa000", "fix: first body\n\nChange-Id: Idupe111");
    const b = commit("bbb000", "fix: second body\n\nChange-Id: Idupe111");

    const result = extract([a, b], policy());

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.changeId).toBe("Idupe111");
    expect(result.conflicts[0]?.shas).toContain("aaa000");
    expect(result.conflicts[0]?.shas).toContain("bbb000");
    expect(result.conflicts[0]?.shas).toHaveLength(2);

    // Both claimsant commits stay in the output as distinct records (M-05:
    // never silently merged away), each carrying the contested identity.
    const first = parsedBySha(result, "aaa000");
    const second = parsedBySha(result, "bbb000");
    expect(first.sha).not.toBe(second.sha);
    expect(first.classification).toBe("change");
    expect(second.classification).toBe("change");
    expect(first.change?.id).toBe("Idupe111");
    expect(second.change?.id).toBe("Idupe111");
    expect(first.identitySource).toBe("change-id-footer");
    expect(second.identitySource).toBe("change-id-footer");
  });

  it("surfaces a conflict when a cherry-pick's origin sha is absent from the commit set", () => {
    const copy = commit("ccc000", "fix: port the fix\n\n(cherry picked from commit dead000beef)");

    const result = extract([copy], policy());

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.changeId).toBe("dead000beef");
    expect(result.conflicts[0]?.shas).toContain("ccc000");

    const parsed = parsedBySha(result, "ccc000");
    expect(parsed.classification).toBe("change");
    expect(parsed.identitySource).toBe("cherry-pick-origin");
    expect(parsed.change?.id).toBe("dead000beef");
  });

  it("treats a lowercase namespace line as an ordinary change — namespace matching is exact-case", () => {
    const ordinary = commit("eee000", "release-craft: add widget");

    const result = extract([ordinary], policy());

    const parsed = parsedBySha(result, "eee000");
    expect(parsed.classification).toBe("change");
    expect(parsed.identitySource).toBe("commit-sha");
    expect(parsed.change).toBeDefined();
    expect(result.excluded).toHaveLength(0);
  });

  it("classifies a namespace line with an empty value as a malformed marker", () => {
    const empty = commit("fff000", "Release-Craft:");

    const result = extract([empty], policy());

    const parsed = parsedBySha(result, "fff000");
    expect(parsed.classification).toBe("malformed-marker");
    expect(parsed.change).toBeUndefined();
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]?.sha).toBe("fff000");
    expect(result.excluded[0]?.rule).toBe("malformed-marker");
  });

  it("excludes a well-formed self-reference before classification", () => {
    const self = commit("sss000", "Release-Craft: release 1.2.3");

    const result = extract([self], policy());

    const parsed = parsedBySha(result, "sss000");
    expect(parsed.classification).toBe("self-reference");
    expect(parsed.change).toBeUndefined();
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]?.sha).toBe("sss000");
    expect(result.excluded[0]?.rule).toBe("self-reference");
  });

  it("classifies an empty message as unparseable", () => {
    const empty = commit("uuu000", "");

    const result = extract([empty], policy());

    const parsed = parsedBySha(result, "uuu000");
    expect(parsed.classification).toBe("unparseable");
    expect(parsed.change).toBeUndefined();
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]?.sha).toBe("uuu000");
    expect(result.excluded[0]?.rule).toBe("unparseable");
  });

  it("classifies a merge commit as unparseable with a merge-commit detail", () => {
    const merge = commit("mmm000", "fix: merge the mainline", {
      parents: ["ppp000", "qqq000"],
    });

    const result = extract([merge], policy());

    const parsed = parsedBySha(result, "mmm000");
    expect(parsed.classification).toBe("unparseable");
    expect(parsed.change).toBeUndefined();
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]?.sha).toBe("mmm000");
    expect(result.excluded[0]?.rule).toBe("unparseable");
    expect(result.excluded[0]?.detail).toMatch(/merge commit/i);
  });

  it("marks a commit breaking when both the header '!' and a BREAKING CHANGE footer are present", () => {
    const breaking = commit(
      "kkk000",
      "feat(api)!: drop the v1 endpoint\n\nBREAKING CHANGE: the v1 endpoint is gone",
    );

    const result = extract([breaking], policy());

    const parsed = parsedBySha(result, "kkk000");
    expect(parsed.classification).toBe("change");
    expect(parsed.breaking).toBe(true);
    expect(parsed.type).toBe("feat");
    expect(parsed.scope).toBe("api");
    expect(parsed.identitySource).toBe("commit-sha");
    expect(parsed.change).toBeDefined();
  });

  it("is deterministic: identical observations produce deep-equal extraction results", () => {
    const commits = [
      commit("ddd000", "fix: shared work\n\nChange-Id: Ione222"),
      commit("ddd001", "fix: shared work\n\n(cherry picked from commit ddd000)", {
        parents: ["ddd000"],
      }),
      commit("ddd002", "Release-Craft: release 1.0.0", { parents: ["ddd001"] }),
    ];

    const first = extract(commits, policy());
    const second = extract(commits, policy());

    expect(second).toEqual(first);
  });
});
