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
 * unchanged: identity only, no binding-added validation.
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
