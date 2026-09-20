/**
 * Fixture — the git changelog artifact producer (issue #381; contract
 * §2.5): the release body's own seam. The producer's digest names a tree
 * holding exactly the supplied rendered bytes at the changelog path — the
 * same path publication's changelog projection reads — so
 * `recordedChangelog` resolves the planned changelog, never a committed
 * file. These tests pin the digest's resolvability over the real
 * binding's file seam, the byte-level context seal (issue #294), the
 * digest's determinism and byte-sensitivity, the supplied path's
 * independence from any fixed name, and the digest's opaque shape.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  openGitBinding,
  type GitTagNaming,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import { GitChangelogProducer } from "@ecoma-io/release-craft/__internal__/adapters/git/producer-changelog.js";
import type { ArtifactProducerInput } from "../../../src/index.js";
import { withTempRepo } from "./temp-repo.js";

/** The binding's file seam never consults the naming — the stub carries
 * the minimal shape the seam's door requires. */
const TAGGING: GitTagNaming = { namespaces: [""], tagFor: () => null };

/** A seam input — identity and the declared labels only (types.ts §2.5c),
 * the production declaration's own values. */
const producerInput = (over: Partial<ArtifactProducerInput> = {}): ArtifactProducerInput => ({
  attemptId: "attempt-1",
  artifactId: "changelog",
  kind: "changelog",
  coordinates: "CHANGELOG.md",
  stage: "tag",
  ...over,
});

describe("the git changelog artifact producer", () => {
  it("digests the tree holding exactly the supplied bytes at the changelog path", () => {
    withTempRepo("producer-changelog", (repo) => {
      const observation = GitChangelogProducer(repo, "B1")(producerInput());
      const binding = openGitBinding({ repo, tagNaming: TAGGING });
      expect(binding.content.file(observation.digest, "CHANGELOG.md")).toBe("B1");
      expect(binding.content.file(observation.digest, "OTHER.md")).toBeNull();
    });
  });

  it("seals the context: contentSha256 is the bytes' own sha256", () => {
    withTempRepo("producer-changelog-seal", (repo) => {
      const observation = GitChangelogProducer(repo, "B1")(producerInput());
      expect(observation.contentSha256).toBe(
        `content_sha256:${createHash("sha256").update("B1").digest("hex")}`,
      );
    });
  });

  it("digests identically for identical bytes, differently for changed bytes", () => {
    withTempRepo("producer-changelog-change", (repo) => {
      const produce = GitChangelogProducer(repo, "B1");
      const first = produce(producerInput());
      expect(produce(producerInput())).toStrictEqual(first);
      expect(GitChangelogProducer(repo, "B2")(producerInput()).digest).not.toBe(first.digest);
    });
  });

  it("names the supplied path, never a fixed one", () => {
    withTempRepo("producer-changelog-path", (repo) => {
      const observation = GitChangelogProducer(repo, "B1", "NOTES.md")(producerInput());
      const binding = openGitBinding({ repo, tagNaming: TAGGING });
      expect(binding.content.file(observation.digest, "NOTES.md")).toBe("B1");
      expect(binding.content.file(observation.digest, "CHANGELOG.md")).toBeNull();
    });
  });

  it("returns an opaque, non-empty, unpadded digest", () => {
    withTempRepo("producer-changelog-opaque", (repo) => {
      const { digest } = GitChangelogProducer(repo, "B1")(producerInput());
      expect(digest.startsWith("git-tree:")).toBe(true);
      expect(digest).toMatch(/^git-tree:[0-9a-f]{40}$/);
      expect(digest).toBe(digest.trim());
    });
  });
});
