/**
 * The content read seam over a real repository (the Phase 9 contract
 * §2.8; D27): the claim records a register ref holds, the declared
 * naming's derivation, the attempt's recorded stream, and one file out
 * of the recorded tree a digest names — each resolved from recorded
 * state only, and each absent path a null rather than a fault. The null
 * rides only git's own absence spelling (#108; D40): both byte-exact
 * messages an absent path produces — plain, and with git's "exists on
 * disk" aside when a same-named file sits in the working tree the
 * binding never reads — while a broken object store behind a live tree
 * entry propagates as the GitFaultError it is.
 */

import { chmodSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GitFaultError,
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
  it("reads the claim records a register ref holds, the empty set when unrecorded", () => {
    withTempRepo("claim", (repo, _git) => {
      const binding = bindingOn(repo);
      const claim = asClaim(binding.claims.acquire(scope("1.2.3"), ATTEMPT));
      const row = binding.refs.claims()[0];
      if (row === undefined) {
        throw new Error("expected the claim ref to be recorded");
      }
      const records = binding.content.claims(row.ref);
      expect(records).toHaveLength(1);
      expect(records[0]?.scope).toEqual(claim.scope);
      expect(records[0]?.token).toBe(claim.token);
      expect(records[0]?.holder).toBe(ATTEMPT);
      expect(binding.content.claims("refs/release-craft/claims/unrecorded")).toEqual([]);
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

  it("reads the on-disk absence spelling as a null too — the working tree is not the recorded tree (#108)", () => {
    withTempRepo("file-on-disk-absence", (_repo, git) => {
      const binding = bindingOn(_repo);
      // The recorded tree holds only the README; a file of the asked-for
      // name sits in the repository's working tree, untracked. git spells
      // this absence with
      // its second message (`exists on disk, but not in`) — the same
      // null, since the binding reads recorded objects, never the
      // working tree (ADR-0009 decision 4).
      writeFileSync(join(_repo, "CHANGELOG.md"), "# unrecorded\n");
      writeFileSync(join(_repo, "README.md"), "fixture\n");
      git(["add", "README.md"]);
      git(["commit", "-m", "fixture: a tree without the changelog"]);
      const digest = `git-tree:${git(["rev-parse", "HEAD^{tree}"]).trim()}`;
      expect(binding.content.file(digest, "CHANGELOG.md")).toBeNull();
    });
  });

  it("faults a broken object store instead of reading it as an absent path (#108)", () => {
    withTempRepo("file-corrupt-store", (_repo, git) => {
      const binding = bindingOn(_repo);
      writeFileSync(join(_repo, "CHANGELOG.md"), "# v1.2.3\n\n- recorded\n");
      git(["add", "CHANGELOG.md"]);
      git(["commit", "-m", "fixture: the recorded content"]);
      const digest = `git-tree:${git(["rev-parse", "HEAD^{tree}"]).trim()}`;
      // The blob the recorded tree holds at the path is truncated on
      // disk (git writes loose objects read-only): git exits 128 with
      // `loose object <oid> … is corrupt` — the object store is broken,
      // never the tree silent about the path, so the read throws.
      const blob = git(["rev-parse", "HEAD:CHANGELOG.md"]).trim();
      const object = join(_repo, ".git", "objects", blob.slice(0, 2), blob.slice(2));
      chmodSync(object, 0o644);
      truncateSync(object, 4);
      expect(() => binding.content.file(digest, "CHANGELOG.md")).toThrow(GitFaultError);
      expect(() => binding.content.file(digest, "CHANGELOG.md")).toThrow(/is corrupt/);
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
