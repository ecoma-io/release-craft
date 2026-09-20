/**
 * The git-backed changelog artifact producer (issue #381; contract §2.5):
 * content identity over the release plan's own rendered changelog bytes,
 * not over the repository's recorded tree. Where `GitArtifactProducer`
 * digests whatever `HEAD`'s tree holds — identity only — this producer
 * names the digest the release body's read resolves: the tree holding
 * exactly the caller's rendered changelog bytes at the changelog path, so
 * `recordedChangelog` (publication.ts) reads the planned changelog, never
 * a committed file. The bytes arrive as a value — produced by the caller's
 * composition over the plan, never read from the working tree (the seam
 * names no ambient path) — and the digest stays a pure function of them:
 * identical bytes digest identically, any byte change digests differently.
 *
 * The tree is written through the binding's runner (`writeBlob` of the
 * committed content, `mktree` of the one entry), exactly as the
 * version-carrying driver's changelog producer writes its tree
 * (version-mutation-driver.ts): the blob and tree objects land in the
 * repository's object store, the digest resolves through `content.file`,
 * and the content seal (`contentSha256`, issue #294) lets publication
 * compare published content byte-for-byte without dereferencing the tree.
 * The producer stays stateless per call — every invocation re-derives the
 * digest from the same bytes, so repeated or retried attempts seal
 * identically; the value `writeBlob` returns for identical content is the
 * same object id, and `mktree` of an identical tree is the same tree id.
 */

import type {
  ArtifactObservation,
  ArtifactProducer,
  ArtifactProducerInput,
} from "@ecoma-io/release-craft/execution";
import { contentSha256 } from "@ecoma-io/release-craft/execution";

import { openGitRun, type GitRun } from "./git-run.js";
import { writeBlob } from "./git-refs.js";

/** The changelog path publication's projection reads (publication.ts);
 * the CLI's own declaration names the same coordinates. */
const CHANGELOG_PATH = "CHANGELOG.md";

/**
 * Opens the producer on `repo`. Synchronous — the seam is (ADR-0008
 * decision 2) — and pure over the supplied bytes: the digest is the tree
 * of one blob, the blob's content the caller's rendered changelog, at the
 * declared path (default `CHANGELOG.md`, the path publication's
 * changelog projection reads). The content seal rides every observation,
 * so a completed step's record carries the byte-level witness the
 * seam's own compare uses (issue #294).
 */
export function GitChangelogProducer(
  repo: string,
  bytes: string,
  path: string = CHANGELOG_PATH,
): ArtifactProducer {
  const git = openGitRun(repo);
  return (input: ArtifactProducerInput): ArtifactObservation => ({
    attribution: { attemptId: input.attemptId, actor: "automation" },
    digest: changelogTreeDigest(git, bytes, path),
    contentSha256: contentSha256(bytes),
  });
}

/** The tree digest of one entry: the rendered changelog bytes at the
 * changelog path, written through the binding's runner. */
const changelogTreeDigest = (git: GitRun, bytes: string, path: string): string => {
  const blob = writeBlob(git, bytes);
  return `git-tree:${git(["mktree"], `100644 blob ${blob}\t${path}\n`).trim()}`;
};
