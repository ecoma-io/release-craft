/**
 * The git-backed artifact producer (ADR-0009 decision 6; contract §2.5):
 * content identity computed from recorded content. The producer the
 * binding injects at ADR-0008's seam observes the repository's recorded
 * tree — never working-tree state — and returns a digest of that content
 * as the artifact's digest, stable across identical content and different
 * under any content change. The digest stays opaque to the engine exactly
 * as ADR-0008 decision 2 fixed: it arrives, it is never computed inside
 * the engine; the binding merely makes it a real digest of real content —
 * `git-tree:<tree-oid-of-HEAD>`.
 */

import type {
  ArtifactObservation,
  ArtifactProducer,
  ArtifactProducerInput,
} from "@ecoma-io/release-craft/execution";

import { openGitRun } from "./git-run.js";

/**
 * Opens the producer on `repo`. Synchronous — the seam is (ADR-0008
 * decision 2) — and pure over the recorded content: every invocation
 * resolves `HEAD`'s tree through the runner opened on the repository, so
 * identical recorded content digests identically and any content change
 * digests differently, while untracked, unstaged, or staged-but-uncommitted
 * working-tree state is invisible to it. Untracked or uncommitted state is
 * not recorded content; a commit is what records it.
 *
 * A repository without any recorded commit has no content identity to
 * name: the `rev-parse` fails and the runner's GitFaultError stands — an
 * environmental fault (there is nothing recorded), not domain vocabulary.
 * The producer adds no input gate of its own: the input is identity only
 * (ADR-0008 decision 7), read for attribution and nothing else — no input
 * value shapes the digest.
 */
export function GitArtifactProducer(repo: string): ArtifactProducer {
  const git = openGitRun(repo);
  return (input: ArtifactProducerInput): ArtifactObservation => ({
    attribution: { attemptId: input.attemptId, actor: "automation" },
    digest: `git-tree:${git(["rev-parse", "HEAD^{tree}"]).trim()}`,
  });
}
