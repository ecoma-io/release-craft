/**
 * The remote synchronization over real repositories and a real bare
 * remote (the Phase 9 contract §2.2, rows 1–3 and 7–9): a fresh origin is
 * brought up to the binding's recorded state, a retry is a no-op, a
 * diverged remote is refused — and the refusal classes arrive as report
 * rows, never exceptions.
 *
 * Since #177 (§2.9; D55) the origin the fixture configures is the
 * credentials' own repository URL — the identity agreement the factory
 * now refuses to open without — and the bare repository the sync
 * transports against stands behind that URL through the origin shim
 * (`origin-shim.ts`, the house `git` shim pattern: every argv delegates
 * to the real git except `ls-remote`/`push` of the mapped URL, which the
 * shim re-points with an environment `insteadOf` rule). Every test here
 * therefore pins the same-identity path end to end: the composed adapter
 * opens, the sync door transports git-level, and the injected transport
 * is never reached.
 */

// The origin shim must sit on PATH before the github barrel evaluates
// (the adapter's transport git freezes its child environment at barrel
// load) — the shim helper is this file's first import, plain ESM order.
import { mapOriginTo, ORIGIN_URL } from "./origin-shim.js";

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  openGitHubAdapter,
  type GitHubTransport,
  type SyncReport,
} from "@ecoma-io/release-craft/__internal__/adapters/github/index.js";
import {
  GitFaultError,
  hermeticGitEnv,
  openGitBinding,
  openGitRun,
  type RecordedRef,
  type GitBinding,
  type GitRun,
  type GitTagNaming,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import type { Claim, ClaimDenied, ClaimScope } from "../../../src/index.js";

// --- the fixture ---------------------------------------------------------

/**
 * The fixture is self-contained (the binding's test tree stays the
 * sibling as its `origin` — the configured remote the sync transports
 * against. The repository carries one empty root commit at the fixed
 * clock (hermeticGitEnv), so every object id a test observes is a pure
 * function of the test's own writes.
 */
const GIT_ENV: NodeJS.ProcessEnv = hermeticGitEnv();

const spawnGit = (args: readonly string[]): string => {
  const result = spawnSync("git", [...args], { env: GIT_ENV, encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${String(result.status ?? "unknown")}): ${result.stderr}`,
    );
  }
  return result.stdout;
};

/** The composed adapter needs a transport at open; the sync's door is
 *  git-level, so its transport's only behaviour is failing loudly if a
 *  sync ever reached for it. */
const syncTransport: GitHubTransport = {
  request() {
    throw new Error("the remote synchronization never reaches the HTTP transport");
  },
};

/** The declared tag naming the fixture opens the binding with: stable
 * versions derive into the `v` namespace. */
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

/** What the remote holds for one ref, peeled (`^{}` resolves an annotated
 *  tag to its commit; a lightweight tag or blob ref names itself). */
const remoteObject = (mirror: string, ref: string): string => {
  return spawnGit(["--git-dir", mirror, "rev-parse", `${ref}^{}`]).trim();
};

interface SyncRepo {
  readonly repo: string;
  /** The URL `origin` is configured under — the identity the adapter's
   *  open-time agreement reads (§2.9); it names the credentials'
   *  repository. */
  readonly originUrl: string;
  /** The bare repository standing behind the URL — the shim's mirror. */
  readonly mirror: string;
  readonly git: GitRun;
  binding(): GitBinding;
  sync(): SyncReport;
}

/** Creates the fixture, runs `fn`, removes the tree whether the body
 *  passes or fails. */
const withSyncRepo = (name: string, fn: (fixture: SyncRepo) => void): void => {
  const root = mkdtempSync(join(tmpdir(), `release-craft-github-sync-${name}-`));
  const repo = join(root, "repo");
  const mirror = join(root, "origin.git");
  try {
    spawnGit(["init", "--quiet", repo]);
    spawnGit(["init", "--bare", "--quiet", mirror]);
    spawnGit(["-C", repo, "config", "user.name", "release-craft"]);
    spawnGit(["-C", repo, "config", "user.email", "adapter@release-craft.local"]);
    spawnGit(["-C", repo, "config", "commit.gpgsign", "false"]);
    spawnGit(["-C", repo, "commit", "--allow-empty", "-m", "release-craft: root"]);
    spawnGit(["-C", repo, "remote", "add", "origin", ORIGIN_URL]);
    mapOriginTo(mirror);
    const git = openGitRun(repo);
    let opened: GitBinding | undefined;
    fn({
      repo,
      originUrl: ORIGIN_URL,
      mirror,
      git,
      binding() {
        opened ??= openGitBinding({ repo, tagNaming: naming });
        return opened;
      },
      sync(): SyncReport {
        // The sync's door is git-level: the composed adapter's only
        // HTTP access is this transport, and it fails the test loudly
        // if a sync ever reached for it.
        return openGitHubAdapter(
          this.binding(),
          {
            owner: "ecoma-io",
            repo: "release-craft",
            token: "t0k3n",
          },
          syncTransport,
        ).syncRemote();
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

/** Records one claim and its minted tag at the root commit; returns the
 *  recorded rows and the minted tag's target. */
const recordOne = (
  fixture: SyncRepo,
): { readonly rows: readonly RecordedRef[]; readonly target: string } => {
  const binding = fixture.binding();
  const claim = asClaim(
    binding.claims.acquire(
      { kind: "stable-version", lineId: "line-main", version: "1.2.3" },
      "attempt_sync",
    ),
  );
  const target = fixture.git(["rev-parse", "HEAD"]).trim();
  const minted = binding.mintTag({
    attemptId: "attempt_sync",
    token: claim.token,
    tag: "v1.2.3",
    target,
  });
  if (minted.kind !== "minted") {
    throw new Error(`expected the mint to land, got ${minted.kind}`);
  }
  return { rows: [...binding.refs.claims(), ...binding.refs.tags()], target };
};

describe("the remote synchronization (§2.2 rows 1–3, 7–9)", () => {
  it("pushes the recorded refs to a fresh origin at their recorded targets (R-01)", () => {
    withSyncRepo("push", (fixture) => {
      const { rows, target } = recordOne(fixture);
      expect(rows).toHaveLength(2);

      const report = fixture.sync();

      expect(report.refs).toEqual([
        { ...rows[0], outcome: { state: "pushed" } },
        { ...rows[1], outcome: { state: "pushed" } },
      ]);
      // The remote holds what the binding recorded: the claim ref at the
      // record's blob, the tag at its commit (peeled).
      expect(remoteObject(fixture.mirror, rows[0]?.ref ?? "")).toBe(rows[0]?.target);
      expect(remoteObject(fixture.mirror, rows[1]?.ref ?? "")).toBe(target);
    });
  });

  it("reports a second sync as skipped and moves nothing (R-02)", () => {
    withSyncRepo("idempotent", (fixture) => {
      const { rows } = recordOne(fixture);
      fixture.sync();
      const before = remoteObject(fixture.mirror, rows[1]?.ref ?? "");

      const report = fixture.sync();

      expect(report.refs).toEqual(rows.map((row) => ({ ...row, outcome: { state: "skipped" } })));
      expect(remoteObject(fixture.mirror, rows[1]?.ref ?? "")).toBe(before);
    });
  });

  it("refuses a tag the remote already holds at another target (R-03)", () => {
    withSyncRepo("diverged", (fixture) => {
      // The remote's tag predates this attempt: another commit, pushed by
      // whoever held the tag first. The binding's own recorded tag is at
      // the fixture's root.
      const other = fixture.git(["commit-tree", "HEAD^{tree}"], "other history").trim();
      spawnGit([
        "-C",
        fixture.repo,
        "push",
        "--quiet",
        fixture.mirror,
        `${other}:refs/tags/v1.2.3`,
      ]);
      const { rows } = recordOne(fixture);

      const report = fixture.sync();

      const claimRow = report.refs.find((row) => row.kind === "claim");
      const tagRow = report.refs.find((row) => row.kind === "tag");
      expect(claimRow?.outcome).toEqual({ state: "pushed" });
      expect(tagRow?.outcome).toEqual({
        state: "refused",
        reason: "already-pushed-different-target",
      });
      // The refusal is a report, not a write: the remote keeps its tag.
      expect(remoteObject(fixture.mirror, rows[1]?.ref ?? "")).toBe(other.trim());
    });
  });

  it("reports every ref transport-failed when the origin is unreachable (R-07)", () => {
    withSyncRepo("unreachable", (fixture) => {
      const { rows } = recordOne(fixture);
      // The mirror the URL points at vanishes: the listing fails with
      // git's own stderr for a remote that cannot be read, hermetically.
      mapOriginTo(join(fixture.repo, "vanish.git"));

      const report = fixture.sync();

      expect(report.refs).toEqual(
        rows.map((row) => ({ ...row, outcome: { state: "transport-failure" } })),
      );
    });
  });

  it("throws the environmental fault for a repository with no origin", () => {
    withSyncRepo("no-origin", (fixture) => {
      recordOne(fixture);
      spawnGit(["-C", fixture.repo, "remote", "remove", "origin"]);

      expect(() => fixture.sync()).toThrow(GitFaultError);
    });
  });
});
