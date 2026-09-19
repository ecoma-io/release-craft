/**
 * The version-carrying self-release's mutation producer (issue #339): the
 * version bump and the changelog render as the engine's declared
 * mutations, their committed bytes the release's own tree, and the
 * rendered changelog's digest the release body's seam. Composed here, in
 * the package shell — `type-package` is the one tag whose boundary row
 * reaches both the app layer and the planner — the driver holds both
 * doors in one call:
 *
 * - the planner's `plan` runs once, over the caller's closed input plus
 *   the operator's intents, exactly as the engine's run will plan it
 *   again (§2.5 step 1): the driver reads the plan's line targets — the
 *   version the bump writes, the tag the run mints — and nothing else.
 *   The plan is looked at, never stored; the engine re-plans at run
 *   time, so an input that would plan differently at the run refuses
 *   there, never here;
 * - the changelog's notes are re-extracted from the input's recorded
 *   commits (the engine's own extraction, `extract`, excluding
 *   self-references) — never from `planLine.changes` (issue #291: the
 *   change set's lineage is the plan's recorded content, and the driver
 *   has no license to consume it early);
 * - the mutations anchor `commit:before`: the version file and the
 *   changelog file land in the committed tree the run's commit door
 *   builds over the recorded base (issue #339 class 1), so the tag the
 *   mint then names points at a tree carrying the release's own bytes;
 * - the changelog artifact producer mints the digest of a tree holding
 *   exactly the rendered changelog at the changelog path — the digest
 *   the release body's read resolves, so the published body is
 *   byte-equal to the committed changelog file (class 3).
 *
 * The updater seam the driver declares is its own memory store: the
 * write-ahead start and the byte re-derivation run against it, and the
 * committed bytes come from the recorded `completed` step records —
 * never from a working tree (the driver names no ambient path).
 */

import type { GitBinding } from "@ecoma-io/release-craft/adapters/git";
import { openGitRun, writeBlob } from "@ecoma-io/release-craft/adapters/git";
import type { GitHubAdapter } from "@ecoma-io/release-craft/adapters/github";
import {
  assemblePublicationBinding,
  type AssemblyConfig,
  type Engine,
  type RunDeclarations,
} from "@ecoma-io/release-craft/app";
import type {
  ArtifactProducer,
  DeclaredMutation,
  MutationIntent,
  UpdaterFs,
} from "@ecoma-io/release-craft/execution";
import {
  extract,
  plan as planRelease,
  renderChangelog,
  type ChangelogEntry,
  type ChangelogInput,
  type ChangelogSection,
  type OperatorIntent,
  type ParsedCommit,
  type PlanningInput,
} from "@ecoma-io/release-craft/planner";

const VERSION_PATH = "VERSION";
const CHANGELOG_PATH = "CHANGELOG.md";

/** The driver's option surface — all optional; the defaults are the
 * self-release's own names and shapes (§1's plan). */
export interface VersionMutationDriverOptions {
  /** The version file's path (default `VERSION`). */
  readonly versionPath?: string;
  /** The changelog file's path (default `CHANGELOG.md`). */
  readonly changelogPath?: string;
  /** The declared changelog section mapping, in render order (default:
   * none — the renderer surfaces each type under its own heading). */
  readonly sections?: readonly ChangelogSection[];
  /** The declared repository base URL for commit links. */
  readonly repository?: string;
  /** The line the declaration drives (default: the input's first line). */
  readonly lineId?: string;
  /** The existing `CHANGELOG.md` bytes the render updates (default:
   * none — the renderer creates the file fresh). */
  readonly existing?: string;
  /** The declared release date, rendered in the version heading
   * (`(YYYY-MM-DD)`) — declared input or omitted, never ambient
   * (issue #206). */
  readonly date?: string;
}

/** What the driver hands the caller: the assembled engine, the
 * declarations the caller hands the engine's run, and the planned
 * release's names. */
export interface VersionMutationDriver {
  /** The assembly over the opened binding and the GitHub adapter's real
   * publication doors — the same composition `openPublicationDriver`
   * builds, with the declaration carriage below. */
  readonly engine: Engine;
  /** The run declarations: the version-bump and changelog-render
   * mutations, their intents, the changelog artifact producer, and the
   * driver's own memory updater seam. */
  readonly declarations: RunDeclarations;
  /** The line the declarations drive. */
  readonly lineId: string;
  /** The planned tag of the driven line — the release's own name. */
  readonly tag: string;
  /** The version the bump writes (the line's stable version, else its
   * stream's). */
  readonly version: string;
  /** The changelog input whose render is the committed changelog bytes
   * and the release body. */
  readonly changelog: ChangelogInput;
}

/** One parsed commit → one changelog note: the recorded words, verbatim. */
const toEntry = (commit: ParsedCommit): ChangelogEntry => ({
  type: commit.type ?? "chore",
  subject: commit.subject,
  ...(commit.scope !== undefined ? { scope: commit.scope } : {}),
  ...(commit.breaking ? { breaking: true } : {}),
  id: commit.sha,
});

/**
 * Opens the version-carrying driver over the opened git binding, the
 * opened GitHub adapter's real release doors, the caller's closed
 * planning input and intents, and the assembly config. Returns null when
 * the planner refuses the input — the driver owns no release to carry —
 * or when the input names no line the plan assembles. Synchronous, like
 * the doors it composes.
 */
export const openVersionMutationDriver = (
  binding: GitBinding,
  github: GitHubAdapter,
  input: PlanningInput,
  intents: readonly OperatorIntent[],
  config: AssemblyConfig,
  options: VersionMutationDriverOptions = {},
): VersionMutationDriver | null => {
  const versionPath = options.versionPath ?? VERSION_PATH;
  const changelogPath = options.changelogPath ?? CHANGELOG_PATH;
  const planning = planRelease({ ...input, intents });
  if (planning.kind === "refused") {
    return null;
  }
  const lineId = options.lineId ?? input.lines[0]?.id;
  if (lineId === undefined) {
    return null;
  }
  const planLine = planning.plan.lines.find((candidate) => candidate.lineId === lineId);
  if (planLine === undefined) {
    return null;
  }
  const tag = planLine.streams[0]?.tag ?? planLine.stable?.tag ?? null;
  if (tag === null) {
    return null;
  }
  const version =
    planLine.stable?.version ??
    (planLine.streams[0] !== undefined ? planLine.streams[0].version.toString() : "");
  // The notes are the extraction's recorded words — self-references
  // already excluded, exactly as the engine's own plan excludes them —
  // re-read from the input's commits, never from the plan's change set
  // (issue #291).
  const extraction = extract(input.repository.commits, input.policy);
  const changelog: ChangelogInput = {
    versions: [
      {
        version,
        ...(options.date !== undefined ? { date: options.date } : {}),
        entries: extraction.commits.map(toEntry),
      },
    ],
    sections: options.sections ?? [],
    ...(options.repository !== undefined ? { repository: options.repository } : {}),
    ...(options.existing !== undefined ? { existing: options.existing } : {}),
  };
  // The declared mutations, anchored before the commit stage: the
  // completion's commit door carries their produced bytes over the
  // recorded base, and the tag that follows names the committed tree.
  const mutations: readonly DeclaredMutation[] = [
    {
      id: "version-bump",
      anchor: { stage: "commit", position: "before" },
      guard: "release-line",
      postconditions: [],
    },
    {
      id: "changelog-render",
      anchor: { stage: "commit", position: "before" },
      guard: "release-line",
      postconditions: [],
    },
  ];
  // The driver's own updater seam: the write-ahead start and byte
  // re-derivation run against this memory store — the committed bytes
  // are the recorded completions, never an ambient file.
  const state = new Map<string, string>();
  const updaterFs: UpdaterFs = {
    read: (path) => state.get(path),
    write: (path, content) => {
      state.set(path, content);
    },
  };
  const mutationIntents: ReadonlyMap<string, MutationIntent> = new Map([
    ["version-bump", { path: versionPath, produce: () => `${version}\n`, expectedDigest: "" }],
    [
      "changelog-render",
      { path: changelogPath, produce: () => renderChangelog(changelog), expectedDigest: "" },
    ],
  ]);
  // The changelog artifact: the digest of a tree holding exactly the
  // rendered changelog at the changelog path — the digest the release
  // body's read resolves, so the published body is byte-equal to the
  // committed changelog file (issue #339 class 3). Written through the
  // binding's runner, exactly as the commit door writes its blobs.
  const git = openGitRun(binding.repo);
  const changelogDigest = (): string => {
    const blob = writeBlob(git, renderChangelog(changelog));
    return `git-tree:${git(["mktree"], `100644 blob ${blob}\t${changelogPath}\n`).trim()}`;
  };
  const producers: ReadonlyMap<string, ArtifactProducer> = new Map([
    [
      "changelog",
      (input) => ({
        attribution: { attemptId: input.attemptId, actor: "automation" },
        digest: changelogDigest(),
      }),
    ],
  ]);
  const declarations: RunDeclarations = {
    artifacts: [
      {
        id: "changelog",
        anchor: { stage: "tag", position: "after" },
        guard: "release-line",
        kind: "changelog",
        coordinates: `changelog-<version>.md`,
        dependsOn: [],
        postconditions: [],
      },
    ],
    mutations,
    mutationIntents,
    producers,
    updaterFs,
  };
  const engine = assemblePublicationBinding(
    binding,
    {
      publishRelease: (releaseTag) => github.publishRelease(releaseTag),
      verifyRelease: (releaseTag) => github.verifyRelease(releaseTag),
    },
    config,
  );
  return { engine, declarations, lineId, tag, version, changelog };
};
