import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  GitFaultError,
  openGitRun,
  type GitRun,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import { GitArtifactProducer } from "@ecoma-io/release-craft/__internal__/adapters/git/producer-git.js";
import type { ArtifactProducerInput } from "../../../src/index.js";
import { withTempRepo } from "./temp-repo.js";

/**
 * Fixture 5 — digest-sourced generations over the git-backed producer
 * (contract §4; ADR-0009 decision 6, §2.5). The producer's digest is the
 * recorded tree's content identity: stable across identical content,
 * different under any content change, blind to working-tree noise. The
 * mapping itself is pinned — `git-tree:<tree-oid-of-HEAD>` — and the
 * engine's fail-closed digest rule (opaque, non-empty, unpadded) never
 * trips on what the producer returns. The port's input contract is
 * unchanged: identity only, no binding-added validation. The digest
 * input's source — the tree of the commit HEAD names, never the commit —
 * and the HEAD-stability precondition it carries are pinned too
 * (issue #185; D43).
 */

/** A seam input — identity and the declared labels only (types.ts §2.5c). */
const producerInput = (over: Partial<ArtifactProducerInput> = {}): ArtifactProducerInput => ({
  attemptId: "attempt-1",
  artifactId: "tarball",
  kind: "npm-tarball",
  coordinates: "registry.example.com/ecoma/pkg",
  stage: "tag",
  ...over,
});

/** Records every current working-tree change as content: one commit on
 * the fixture's fixed clock, so the digest a following produce observes
 * is a pure function of the test's writes. */
const commitAll = (git: GitRun, message: string): void => {
  git(["add", "-A"]);
  git(["commit", "-m", message]);
};

describe("the git-backed artifact producer", () => {
  it("digests the recorded tree, stably across identical content", () => {
    withTempRepo("producer-stable", (repo, git) => {
      const produce = GitArtifactProducer(repo);
      const first = produce(producerInput());
      expect(produce(producerInput())).toStrictEqual(first);
      expect(first.attribution).toStrictEqual({
        attemptId: "attempt-1",
        actor: "automation",
      });
      expect(first.digest).toBe(`git-tree:${git(["rev-parse", "HEAD^{tree}"]).trim()}`);
    });
  });

  it("digests differently under a content change", () => {
    withTempRepo("producer-change", (repo, git) => {
      const produce = GitArtifactProducer(repo);
      writeFileSync(join(repo, "artifact.txt"), "recorded content v1\n");
      commitAll(git, "ecoma: record content");
      const first = produce(producerInput()).digest;

      writeFileSync(join(repo, "artifact.txt"), "recorded content v2\n");
      commitAll(git, "ecoma: change content");
      const second = produce(producerInput()).digest;

      expect(second).not.toBe(first);
    });
  });

  it("never observes working-tree state", () => {
    withTempRepo("producer-recorded-only", (repo, git) => {
      writeFileSync(join(repo, "tracked.txt"), "recorded\n");
      commitAll(git, "ecoma: record content");
      const produce = GitArtifactProducer(repo);
      const recorded = produce(producerInput()).digest;

      // Untracked noise and an unstaged edit are not recorded content.
      writeFileSync(join(repo, "untracked.txt"), "noise\n");
      appendFileSync(join(repo, "tracked.txt"), "uncommitted edit\n");
      expect(produce(producerInput()).digest).toBe(recorded);

      // Staging is still not recording: the index is invisible too.
      git(["add", "-A"]);
      expect(produce(producerInput()).digest).toBe(recorded);
    });
  });

  it("digests the tree of the commit HEAD names — never the commit itself", () => {
    withTempRepo("producer-tree-not-commit", (repo, git) => {
      const produce = GitArtifactProducer(repo);
      const recorded = produce(producerInput()).digest;

      // Another commit, the identical tree content: the digest must not
      // move. The input source is the tree of the commit HEAD names —
      // digest the commit oid instead and this pin goes red (issue #185;
      // D43's fixed digest input).
      git(["checkout", "-b", "same-tree"]);
      git(["commit", "--allow-empty", "-m", "release-craft: same tree, another commit"]);
      expect(produce(producerInput()).digest).toBe(recorded);
    });
  });

  it("a HEAD move mid-attempt changes the digest, and checking the attempt's branch back restores it", () => {
    withTempRepo("producer-head-move-drift", (repo, git) => {
      const produce = GitArtifactProducer(repo);
      const recorded = produce(producerInput()).digest;
      const branch = git(["symbolic-ref", "--short", "HEAD"]).trim();

      // The declared precondition's loud face (issue #185; D43): another
      // process checks out another branch mid-attempt and records content
      // there — the drift is not swallowed. The digest changes exactly as
      // any recorded-content change does, and the attempt's own digest
      // returns when HEAD comes back: identical recorded content digests
      // identically, and nothing retains the moved branch's identity.
      git(["checkout", "-b", "drifted"]);
      writeFileSync(join(repo, "drift.txt"), "recorded on the moved branch\n");
      commitAll(git, "ecoma: record content elsewhere");
      expect(produce(producerInput()).digest).not.toBe(recorded);

      git(["checkout", branch]);
      expect(produce(producerInput()).digest).toBe(recorded);
    });
  });

  it("returns an opaque, non-empty, unpadded digest", () => {
    withTempRepo("producer-shape", (repo) => {
      const digest = GitArtifactProducer(repo)(producerInput()).digest;
      expect(digest.length).toBeGreaterThan(0);
      expect(digest).not.toContain("=");
      expect(digest).toBe(digest.trim());
    });
  });

  it("reports an unrecorded repository as an environmental fault", () => {
    const repo = mkdtempSync(join(tmpdir(), "release-craft-git-binding-producer-empty-"));
    try {
      openGitRun(repo)(["init"]);
      const produce = GitArtifactProducer(repo);
      expect(() => produce(producerInput())).toThrow(GitFaultError);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("adds no input gate the port does not have", () => {
    withTempRepo("producer-input-parity", (repo) => {
      const produce = GitArtifactProducer(repo);
      const plain = produce(producerInput()).digest;
      // Identity-only inputs of any shape — an unknown kind, empty
      // coordinates, another attempt — yield the same recorded-content
      // digest: the binding validates nothing the seam never defined.
      const odd = produce(
        producerInput({
          attemptId: "attempt-2",
          artifactId: "container",
          kind: "oci-image",
          coordinates: "",
          stage: "publish",
        }),
      ).digest;
      expect(odd).toBe(plain);
    });
  });
});
