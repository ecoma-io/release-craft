import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  openGitBinding,
  type GitBinding,
  type GitRun,
  type GitTagNaming,
} from "../../../src/adapters/git/index.js";
import type { Claim, ClaimDenied, ClaimScope } from "../../../src/index.js";
import { withTempRepo } from "./temp-repo.js";

/**
 * The binding's read seam over real repositories (the Phase 9 contract
 * §2.7; D26): the enumeration sees the claim refs and the
 * declared-namespace tags with the objects they name, sees nothing of
 * undeclared namespaces or the working tree, and moves nothing — the
 * mint door's discipline on the read side.
 */

/** The declared tag naming the fixtures open the binding with: stable
 * versions derive into the `v` namespace; every other scope maps outside
 * it. */
const naming: GitTagNaming = {
  namespaces: ["v"],
  tagFor: (scope: ClaimScope): string | null => {
    if (scope.kind !== "stable-version") {
      return null;
    }
    return `v${scope.version}`;
  },
};

const asClaim = (outcome: Claim | ClaimDenied): Claim => {
  if (outcome.kind !== "claim") {
    throw new Error(`expected a claim, got a denial by ${String(outcome.holder)}`);
  }
  return outcome;
};

/** The object a ref names, as git itself reports it — the authority the
 *  enumeration's targets are checked against. */
const refObject = (git: GitRun, ref: string): string => {
  return git(["rev-parse", ref]).trim();
};

/** Records the fixture's recorded state through the binding's own doors —
 *  one acquired claim and its minted tag at the repository's root commit
 *  — and returns that commit. */
const recordClaimAndTag = (binding: GitBinding, git: GitRun): string => {
  const claim = asClaim(
    binding.claims.acquire(
      { kind: "stable-version", lineId: "line-main", version: "1.2.3" },
      "attempt_read",
    ),
  );
  const target = git(["rev-parse", "HEAD"]).trim();
  const minted = binding.mintTag({
    attemptId: "attempt_read",
    token: claim.token,
    tag: "v1.2.3",
    target,
  });
  if (minted.kind !== "minted") {
    throw new Error(`expected the mint to land, got ${minted.kind}`);
  }
  return target;
};

describe("the binding's read seam — recorded refs, read-only (§2.7)", () => {
  it("reads an empty repository as empty, on its own repository path", () => {
    withTempRepo("refs-read-empty", (repo) => {
      const binding = openGitBinding({ repo, tagNaming: naming });
      expect(binding.repo).toBe(repo);
      expect(binding.refs.claims()).toEqual([]);
      expect(binding.refs.tags()).toEqual([]);
    });
  });

  it("enumerates the recorded claim ref and the minted tag with their objects", () => {
    withTempRepo("refs-read-recorded", (repo, git) => {
      const binding = openGitBinding({ repo, tagNaming: naming });
      const target = recordClaimAndTag(binding, git);

      const claims = binding.refs.claims();
      expect(claims).toHaveLength(1);
      const claimRef = claims[0]?.ref ?? "";
      expect(claimRef.startsWith("refs/release-craft/claims/")).toBe(true);
      // A claim ref names the register blob (the per-line claim register
      // of ADR-0011) — the enumeration reports the object git holds, not
      // a commit.
      expect(claims[0]).toEqual({
        ref: claimRef,
        target: refObject(git, claimRef),
        kind: "claim",
      });

      expect(binding.refs.tags()).toEqual([{ ref: "refs/tags/v1.2.3", target, kind: "tag" }]);
    });
  });

  it("sees only the declared namespaces' tags — the mint door's prefix rule", () => {
    withTempRepo("refs-read-namespaces", (repo, git) => {
      const binding = openGitBinding({ repo, tagNaming: naming });
      const target = recordClaimAndTag(binding, git);
      git(["tag", "other-1.0", target]);
      git(["tag", "v9.9.9", target]);

      expect(binding.refs.tags().map((entry) => entry.ref)).toEqual([
        "refs/tags/v1.2.3",
        "refs/tags/v9.9.9",
      ]);
    });
  });

  it("peels an annotated tag to the commit it names", () => {
    withTempRepo("refs-read-annotated", (repo, git) => {
      const binding = openGitBinding({ repo, tagNaming: naming });
      const target = recordClaimAndTag(binding, git);
      git(["tag", "-a", "v-annotated", "-m", "the release record", target]);

      const tagObject = refObject(git, "refs/tags/v-annotated");
      expect(tagObject).not.toBe(target);
      expect(binding.refs.tags()).toEqual([
        { ref: "refs/tags/v-annotated", target, kind: "tag" },
        { ref: "refs/tags/v1.2.3", target, kind: "tag" },
      ]);
    });
  });

  it("moves nothing and sees nothing of the working tree", () => {
    withTempRepo("refs-read-readonly", (repo, git) => {
      const binding = openGitBinding({ repo, tagNaming: naming });
      recordClaimAndTag(binding, git);
      const before = git(["for-each-ref", "--format=%(refname) %(objectname)"]);

      binding.refs.claims();
      binding.refs.tags();
      writeFileSync(join(repo, "untracked.txt"), "not recorded content\n");

      expect(git(["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(before);
      expect(binding.refs.claims()).toHaveLength(1);
      expect(binding.refs.tags()).toHaveLength(1);
    });
  });
});
