/**
 * Issue #339's version-carrying driver through the application boundary:
 * the opened binding (a real temp repository — real doors, real
 * subprocesses), the planner's plan read once, and the run's own
 * completion. The rows pinned here:
 *
 * - the completion's commit door lands the version bump's and the
 *   changelog render's bytes as the release's own commit over the
 *   recorded base, and the mint names the committed oid — the tagged
 *   tree carries VERSION and CHANGELOG.md with exactly the produced
 *   bytes plus the base entry untouched, byte-equal (class 1);
 * - the commit message is the release's auditable identity: tag, line,
 *   plan;
 * - the changelog artifact's recorded `git-tree:` digest is the class-3
 *   seam: it resolves through the binding's content read to the SAME
 *   bytes the commit carried — the published body's resolver returns the
 *   committed changelog byte-equal (the created release object itself is
 *   the publication-port suite's proof on the identical assembly and
 *   resolver);
 * - an updater seam that cannot re-read a mutation's own bytes blocks
 *   the attempt at the walk's write-verify gate — before any commit,
 *   the release never names an unmutated base.
 *
 * The publication door's create precondition (issue #338) demands a
 * remote ref no non-syncing fixture holds, so the run refuses at the
 * publication door AFTER the commit and the mint — the completion rows
 * above are exactly the recorded state that refusal leaves behind.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openVersionMutationDriver, renderChangelog, type UpdaterFs } from "../../src/index.js";
import type { GitHubTransport } from "@ecoma-io/release-craft/adapters/github";
import type { GitRun } from "@ecoma-io/release-craft/adapters/git";
import { runInput, liveWorld } from "../vertical/matrix.js";
import {
  credentials,
  openFakeRemote,
  type FakeRemote,
  withGitHubVertical,
} from "../vertical/matrix-github.js";
import { beta, runRequest } from "./harness.js";

/** The web transport whose repository probe (issue #338's discriminator)
 * observes — the fake remote serves no repo route, and the create's
 * precondition must read the 404 against an observable repository to
 * return the determinate `release-tag-missing` instead of a transport
 * failure. */
const observableWeb = (remote: FakeRemote): GitHubTransport => ({
  request(path, init) {
    if (path === `/repos/${credentials.owner}/${credentials.repo}`) {
      return { status: 200, headers: {}, body: "{}" };
    }
    return remote.transport.request(path, init);
  },
});

/** One `ls-tree -r` row: mode, type, oid and the raw path. */
interface TreeRow {
  readonly oid: string;
  readonly path: string;
}

const lsTree = (git: GitRun, oid: string): readonly TreeRow[] =>
  git(["ls-tree", "-r", oid])
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, object] = line.slice(0, tab).split(" ");
      if (mode === undefined || type === undefined || object === undefined) {
        throw new Error(`fixture broken: an ls-tree row lacks fields: ${line}`);
      }
      return { mode, type, oid: object, path: line.slice(tab + 1) };
    });

const blobAt = (git: GitRun, coordinate: string): string => git(["cat-file", "blob", coordinate]);

const commitSubject = (git: GitRun, oid: string): string =>
  git(["log", "-1", "--format=%s", oid]).trim();

describe("the version-carrying driver (issue #339)", () => {
  it(
    "the completion commits the version bump and changelog render, mints the tag onto the commit, and seals the changelog digest",
    { timeout: 120_000 },
    () => {
      withGitHubVertical("app-version-driver", (vertical) => {
        const remote = openFakeRemote();
        const input = runInput(liveWorld(), "main", [beta]);
        const driver = openVersionMutationDriver(
          vertical.state.binding,
          vertical.adapter(observableWeb(remote)),
          input,
          [beta],
          { maxRetries: 2 },
          {
            date: "2026-09-20",
            repository: "https://github.com/ecoma-io/release-craft",
          },
        );
        if (driver === null) {
          throw new Error("fixture broken: the driver refused a planning-valid input");
        }
        const target = vertical.state.lineHeads.main;
        if (target === undefined) {
          throw new Error("fixture broken: no recorded head for main");
        }
        const outcome = driver.engine.run({
          ...runRequest(liveWorld(), "main", [beta], driver.declarations),
          targets: { main: target },
        });
        // The create's precondition (issue #338) reads the remote ref
        // before any write: the non-syncing fixture holds no
        // `5.0.0-beta.1` ref, so the completion refuses AT the
        // publication door — after the commit and the mint, the rows
        // this suite asserts.
        expect(outcome.kind).toBe("refused");
        if (outcome.kind !== "refused") {
          throw new Error(`expected a refused outcome, got ${outcome.kind}`);
        }
        expect(outcome.detail).toContain("origin holds no tag");

        // The mint names the committed oid — the run's target, never the
        // untagged base.
        const tags = vertical.state.binding.refs
          .tags()
          .filter((row) => row.ref === "refs/tags/5.0.0-beta.1");
        expect(tags).toHaveLength(1);
        if (tags[0] === undefined) {
          throw new Error("fixture broken: the mint did not land the tag");
        }
        const committed = tags[0].target;
        expect(committed).not.toBe(target);

        // The commit's tree: the recorded base entry kept byte-equal, the
        // produced files exactly the driver's bytes (class 1).
        const byPath = new Map(
          lsTree(vertical.state.git, committed).map((row) => [row.path, row.oid] as const),
        );
        expect(byPath.get("record")).toBeDefined();
        expect(blobAt(vertical.state.git, `${committed}:record`)).toBe(
          blobAt(vertical.state.git, `${target}:record`),
        );
        expect(blobAt(vertical.state.git, `${committed}:VERSION`)).toBe(`${driver.version}\n`);
        const changelog = renderChangelog(driver.changelog);
        expect(byPath.get("CHANGELOG.md")).toBeDefined();
        expect(blobAt(vertical.state.git, `${committed}:CHANGELOG.md`)).toBe(changelog);

        // The commit is the release's auditable identity: tag, line, plan.
        if (outcome.handle === null) {
          throw new Error("fixture broken: a refused publication keeps its handle");
        }
        expect(commitSubject(vertical.state.git, committed)).toBe(
          `release-craft: release ${driver.tag} for main (${outcome.handle.planId})`,
        );

        // Class 3: the recorded changelog digest resolves to the SAME
        // bytes the commit carried — the body the publication reads is
        // the committed changelog file, byte-equal.
        const observation = driver.engine.observe({ kind: "attempt", handle: outcome.handle });
        if (observation.kind !== "attempt") {
          throw new Error(
            `fixture broken: expected an attempt observation, got ${observation.kind}`,
          );
        }
        const changelogRecord = observation.tail.find(
          (row) =>
            row.kind === "step" &&
            row.record.stepKey === "artifact:changelog" &&
            row.record.to === "completed",
        );
        const digest =
          changelogRecord?.kind === "step" ? changelogRecord.record.artifact?.digest : undefined;
        expect(digest?.startsWith("git-tree:")).toBe(true);
        if (digest === undefined) {
          throw new Error("fixture broken: no completed changelog artifact record");
        }
        expect(vertical.state.binding.content.file(digest, "CHANGELOG.md")).toBe(changelog);
        // The issue #294 content seal rides the completion record: the
        // byte-level witness over the same rendered bytes, opaque and
        // prefix-named, ready for the publication door's compare.
        if (changelogRecord?.kind !== "step") {
          throw new Error("fixture broken: no completed changelog step record");
        }
        expect(changelogRecord.record.contentSha256).toBe(
          `content_sha256:${createHash("sha256").update(changelog).digest("hex")}`,
        );
      });
    },
  );

  it(
    "an updater seam that cannot read a completed mutation's path refuses before any commit",
    { timeout: 120_000 },
    () => {
      withGitHubVertical("app-version-driver-unreadable", (vertical) => {
        const remote = openFakeRemote();
        const input = runInput(liveWorld(), "main", [beta]);
        const driver = openVersionMutationDriver(
          vertical.state.binding,
          vertical.adapter(observableWeb(remote)),
          input,
          [beta],
          { maxRetries: 2 },
          {
            date: "2026-09-20",
            repository: "https://github.com/ecoma-io/release-craft",
          },
        );
        if (driver === null) {
          throw new Error("fixture broken: the driver refused a planning-valid input");
        }
        // The declared seam loses its store: every read comes back
        // empty, and the walk's write-verify gate blocks the attempt
        // before any commit — the release never names an unmutated base.
        (driver.declarations as { updaterFs: UpdaterFs }).updaterFs = {
          read: () => undefined,
          write: () => {},
        };
        const target = vertical.state.lineHeads.main;
        if (target === undefined) {
          throw new Error("fixture broken: no recorded head for main");
        }
        const outcome = driver.engine.run({
          ...runRequest(liveWorld(), "main", [beta], driver.declarations),
          targets: { main: target },
        });
        // The seam cannot re-read a mutation's own bytes: the walk's
        // write-verify gate (issue #203) blocks the attempt with the
        // cause before the completion's commit door can run — the
        // release never names an unmutated base.
        expect(outcome.kind).toBe("blocked");
        if (outcome.kind !== "blocked") {
          throw new Error(`expected a blocked outcome, got ${outcome.kind}`);
        }
        expect(outcome.cause).toContain("write-verify");
        // No commit, no mint: nothing landed over the base.
        expect(vertical.state.binding.refs.tags()).toStrictEqual([]);
        expect(vertical.state.binding.refs.tags()).toStrictEqual([]);
      });
    },
  );
});
