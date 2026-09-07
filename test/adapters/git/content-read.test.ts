/**
 * The content read seam over a real repository (the Phase 9 contract
 * §2.8; D27): the canonical claim record a ref pins, the declared
 * naming's derivation, the attempt's recorded stream, and one file out
 * of the recorded tree a digest names — each resolved from recorded
 * state only, and each absent path a null rather than a fault.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  openGitBinding,
  type GitBinding,
  type GitTagNaming,
} from "../../../src/adapters/git/index.js";
import type { Claim, ClaimDenied, ClaimScope } from "../../../src/index.js";
import { withTempRepo } from "./temp-repo.js";

/** The declared tag naming the fixture opens the binding with: stable
 *  versions derive into the `v` namespace (the sync fixture's own
 *  naming, so both projections read the same repository shape). */
const naming: GitTagNaming = {
  namespaces: ["v"],
  tagFor: (scope: ClaimScope): string | null => {
    if (scope.kind !== "stable-version") {
      return null;
    }
    return `v${scope.version}`;
  },
};

const ATTEMPT = "attempt_sha256:read-a";
const scope = (version: string): ClaimScope => ({
  kind: "stable-version",
  lineId: "line-main",
  version,
});

const asClaim = (outcome: Claim | ClaimDenied): Claim => {
  if (outcome.kind !== "claim") {
    throw new Error(`expected a claim, got a denial by ${String(outcome.holder)}`);
  }
  return outcome;
};

const bindingOn = (repo: string): GitBinding => openGitBinding({ repo, tagNaming: naming });

describe("the content read seam (§2.8; D27)", () => {
  it("reads the canonical claim record a ref pins, null when unrecorded", () => {
    withTempRepo("claim", (_repo, _git) => {
      const binding = bindingOn(_repo);
      const claim = asClaim(binding.claims.acquire(scope("1.2.3"), ATTEMPT));
      const row = binding.refs.claims()[0];
      if (row === undefined) {
        throw new Error("expected the claim ref to be recorded");
      }
      const record = binding.content.claim(row.ref);
      expect(record?.scope).toEqual(claim.scope);
      expect(record?.token).toBe(claim.token);
      expect(record?.holder).toBe(ATTEMPT);
      expect(binding.content.claim("refs/ecoma/claims/unrecorded")).toBeNull();
    });
  });

  it("exposes the declared naming's derivation as a pure read", () => {
    withTempRepo("tagFor", (_repo, _git) => {
      const binding = bindingOn(_repo);
      expect(binding.content.tagFor(scope("1.2.3"))).toBe("v1.2.3");
      expect(
        binding.content.tagFor({
          kind: "prerelease-sequence",
          lineId: "l",
          target: "1.2.3",
          streamId: "nightly",
          sequence: 0,
        }),
      ).toBeNull();
    });
  });

  it("exposes the attempt's recorded stream without the ledger's writes", () => {
    withTempRepo("tail", (_repo, _git) => {
      const binding = bindingOn(_repo);
      const started = binding.ledger.appendStart(
        {
          attemptId: ATTEMPT,
          planId: "plan-read",
          planFingerprint: "plan_sha256:read",
          state: "executing",
        },
        "artifact:changelog",
        { attemptId: ATTEMPT, actor: "fixture" },
        "git-tree:0000000000000000000000000000000000000000",
      );
      expect(binding.content.tail(ATTEMPT)).toHaveLength(2);
      expect(binding.content.tail("attempt_sha256:other")).toHaveLength(0);
      const recorded = binding.content.tail(ATTEMPT);
      expect(recorded[0]?.kind).toBe("plan");
      expect(recorded[1]).toEqual({ kind: "step", record: started });
    });
  });

  it("reads one file out of the recorded tree, null for a path it does not hold", () => {
    withTempRepo("file", (_repo, git) => {
      const binding = bindingOn(_repo);
      writeFileSync(join(_repo, "CHANGELOG.md"), "# v1.2.3\n\n- recorded\n");
      git(["add", "CHANGELOG.md"]);
      git(["commit", "-m", "fixture: the recorded content"]);
      const digest = `git-tree:${git(["rev-parse", "HEAD^{tree}"]).trim()}`;
      expect(binding.content.file(digest, "CHANGELOG.md")).toBe("# v1.2.3\n\n- recorded\n");
      expect(binding.content.file(digest, "no-such-file.md")).toBeNull();
    });
  });

  it("faults a digest that is not a recorded tree digest, and one that names a commit", () => {
    withTempRepo("fault", (_repo, git) => {
      const binding = bindingOn(_repo);
      expect(() => binding.content.file("sha256:deadbeef", "CHANGELOG.md")).toThrow(TypeError);
      git(["commit", "--allow-empty", "-m", "fixture: not a tree"]);
      const commit = git(["rev-parse", "HEAD"]).trim();
      expect(() => binding.content.file(`git-tree:${commit}`, "CHANGELOG.md")).toThrow(TypeError);
    });
  });
});
