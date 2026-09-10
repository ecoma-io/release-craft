import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  commitRecord,
  firstParentHistory,
  GitFaultError,
  hermeticGitEnv,
  openGitRun,
  type GitRun,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import { createTempRepo } from "./temp-repo.js";

/**
 * The substrate the binding opens on (#181, #184; D45–D48). The binding's
 * guarantees — byte-exact reload, the first-parent walk, the compare-and-
 * swap — hold only on a repository whose history git walks to its root, in
 * the object format the binding is certified on, with no replacement of
 * recorded objects. Each disposition is pinned at the boundary it acts on:
 * the runner's first command on a live repository refuses a shallow clone,
 * a grafts file, and a foreign object format as declared faults — ahead of
 * any door work, never mid-walk — and the hermetic floor disarms replace
 * objects so recorded bytes read back as recorded. Every guard bites:
 * removing it turns its test red (each mutation was applied, shown red,
 * and reverted).
 */

const GIT_ENV: NodeJS.ProcessEnv = hermeticGitEnv();

/** A raw spawn for the fixture's own construction work — building a
 *  shallow clone must not go through `openGitRun`, whose guard would
 *  refuse the clone before the test can observe anything. */
const spawnGit = (cwd: string, args: readonly string[]): { status: number; stderr: string } => {
  const result = spawnSync("git", [...args], { cwd, env: GIT_ENV, encoding: "utf8" });
  if (result.error !== undefined) {
    throw new Error(`git ${args.join(" ")} failed to spawn: ${result.error.message}`);
  }
  return { status: result.status ?? -1, stderr: result.stderr };
};

/** Builds a recorded stream of `count` record commits on `ref`, each one
 *  commit holding one record blob — a real ledger-shaped history. Returns
 *  the commits root-first. */
const buildStream = (git: GitRun, ref: string, count: number): readonly string[] => {
  const commits: string[] = [];
  for (let index = 1; index <= count; index++) {
    const blob = git(["hash-object", "-w", "--stdin"], `{"n":${String(index)}}`).trim();
    const tree = git(["mktree"], `100644 blob ${blob}\trecord\n`).trim();
    const parent = commits.at(-1);
    const commit = git(
      parent === undefined
        ? ["commit-tree", tree, "-m", "release-craft: append"]
        : ["commit-tree", tree, "-p", parent, "-m", "release-craft: append"],
    ).trim();
    git(["update-ref", ref, commit, parent ?? "0".repeat(40)]);
    commits.push(commit);
  }
  return commits;
};

/** The work directory a clone fixture lives in, removed either way. */
const withWorkDir = (fn: (work: string) => void): void => {
  const work = mkdtempSync(join(tmpdir(), "release-craft-substrate-"));
  try {
    fn(work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

/** Narrows a caught error to the fault type the runner raises. */
const asFault = (error: unknown): GitFaultError => {
  if (error instanceof GitFaultError) {
    return error;
  }
  throw new Error(`expected a GitFaultError, got ${String(error)}`);
};

/** Asserts the substrate refusal: opening the runner and running its first
 *  command on `repo` raises the declared fault naming its shape, ahead of
 *  whatever `trigger` would otherwise have read. */
const expectSubstrateRefusal = (
  repo: string,
  trigger: (git: GitRun) => void,
  shape: string,
  issue: string,
): GitFaultError => {
  let fault: GitFaultError | undefined;
  try {
    trigger(openGitRun(repo));
  } catch (error) {
    fault = asFault(error);
  }
  if (fault === undefined) {
    throw new Error(`expected ${repo} to refuse the ${shape} substrate`);
  }
  expect(fault.status).toBeNull();
  expect(fault.message).toContain(shape);
  expect(fault.message).toContain(issue);
  return fault;
};

describe("the substrate the binding opens on (#181, #184)", () => {
  it("disarms replace objects on the hermetic floor — recorded bytes read back as recorded (#181; D46)", () => {
    // The floor pin is the leg that bites on every git: the variable is
    // set before any spawn, so no runner can honor a substitution.
    expect(hermeticGitEnv().GIT_NO_REPLACE_OBJECTS).toBe("1");
    // The behavioral leg: a replacement planted over a record commit
    // changes what git reports for that object — without the floor's
    // variable, `commitRecord` reads the replacement's bytes (observed
    // first-hand pre-fix); with it, the recorded bytes.
    const temp = createTempRepo();
    try {
      const ref = "refs/release-craft/ledger/attempt_replace";
      const [first] = buildStream(temp.git, ref, 2);
      if (first === undefined) {
        throw new Error("expected the fixture stream to build");
      }
      const plantedBlob = temp.git(["hash-object", "-w", "--stdin"], '{"n":"HIJACKED"}').trim();
      const plantedTree = temp.git(["mktree"], `100644 blob ${plantedBlob}\trecord\n`).trim();
      const planted = temp.git(["commit-tree", plantedTree, "-m", "release-craft: hijack"]).trim();
      expect(spawnGit(temp.repo, ["replace", "-f", first, planted]).status).toBe(0);
      const runner = openGitRun(temp.repo);
      expect(commitRecord(runner, first)).toBe('{"n":1}');
      // The recorded walk is equally true: the replacement does not move
      // the history the binding walks.
      expect(firstParentHistory(runner, ref)).toHaveLength(2);
    } finally {
      temp.cleanup();
    }
  });

  it("reads the full recorded stream through a replace-grafted mid-commit — the modern graft spelling rides the disarm (D46/D47)", () => {
    const temp = createTempRepo();
    try {
      const ref = "refs/release-craft/ledger/attempt_graft";
      const commits = buildStream(temp.git, ref, 3);
      const middle = commits[1];
      if (middle === undefined) {
        throw new Error("expected the fixture stream to build");
      }
      // `git replace --graft` parents the commit off — the same truncation
      // the legacy grafts file produces, spelled as a replace ref, so the
      // floor's disarm covers it and the walk stays whole.
      expect(spawnGit(temp.repo, ["replace", "--graft", middle]).status).toBe(0);
      const runner = openGitRun(temp.repo);
      expect(firstParentHistory(runner, ref)).toStrictEqual(commits);
    } finally {
      temp.cleanup();
    }
  });

  it("refuses a shallow clone ahead of its first read — the walk would stop at the shallow boundary (#181; D45)", () => {
    withWorkDir((work) => {
      const origin = createTempRepo();
      try {
        const ref = "refs/release-craft/ledger/attempt_shallow";
        buildStream(origin.git, ref, 3);
        // The CI posture: a full clone is a local clone (git ignores
        // --depth there), so the shallow boundary is made by the depth-1
        // fetch of the recorded namespace — exactly what a fetch-depth-1
        // checkout plus a namespace fetch produces.
        const clone = join(work, "shallow");
        expect(spawnGit(work, ["clone", "-q", origin.repo, clone]).status).toBe(0);
        expect(
          spawnGit(clone, ["fetch", "-q", "--depth", "1", "origin", `+${ref}:${ref}`]).status,
        ).toBe(0);
        // The shape is really there: the clone is shallow, and the walk
        // exits 0 over a prefix of the stream — the silent failure the
        // guard exists for (observed pre-fix: 3 records read as 1). The
        // trigger is that very walk: without the guard it returns the
        // prefix and this test goes red only through the refusal.
        expect(spawnGit(clone, ["rev-parse", "--is-shallow-repository"]).status).toBe(0);
        expect(spawnGit(clone, ["rev-list", "--first-parent", ref]).status).toBe(0);
        expectSubstrateRefusal(
          clone,
          (git) => void firstParentHistory(git, ref),
          "shallow",
          "#181",
        );
      } finally {
        origin.cleanup();
      }
    });
  });

  it("refuses a repository carrying a grafts file — nothing disarms the file channel (#181; D47)", () => {
    const temp = createTempRepo();
    try {
      const ref = "refs/release-craft/ledger/attempt_grafts";
      const commits = buildStream(temp.git, ref, 3);
      const middle = commits[1];
      if (middle === undefined) {
        throw new Error("expected the fixture stream to build");
      }
      // The legacy channel: a parentless graft on the middle commit
      // truncates the walk even under GIT_NO_REPLACE_OBJECTS=1 (verified
      // first-hand), so its presence refuses — it cannot be disarmed. The
      // trigger is the walk the graft would silently rewrite.
      mkdirSync(join(temp.repo, ".git", "info"), { recursive: true });
      writeFileSync(join(temp.repo, ".git", "info", "grafts"), `${middle}\n`);
      expect(existsSync(join(temp.repo, ".git", "info", "grafts"))).toBe(true);
      expectSubstrateRefusal(
        temp.repo,
        (git) => void firstParentHistory(git, ref),
        "grafts file",
        "#181",
      );
    } finally {
      temp.cleanup();
    }
  });

  it("refuses a sha256 repository ahead of its first write — the CAS's zero width would mislabel it (#184; D48)", () => {
    withWorkDir((work) => {
      const repo = join(work, "sha256");
      expect(spawnGit(work, ["init", "-q", "--object-format=sha256", repo]).status).toBe(0);
      // Pre-fix, this substrate failed at its first compare-and-swap with
      // git's `not a valid old SHA1` — loud, but mislabeled as a substrate
      // fault (observed first-hand). The refusal moves the fault ahead of
      // any door work and names the format.
      expectSubstrateRefusal(repo, (git) => void git(["rev-parse", "--git-dir"]), "sha256", "#184");
    });
  });

  it("keeps opening spawn-free and bootstrap-spawnable — the guard rides the first command on a live repository (#181)", () => {
    withWorkDir((work) => {
      // A runner on a path that is no repository must open without
      // touching git — the CLI builds bindings on paths a run may never
      // touch (the laziness pin in the CLI suite) — and must let the
      // bootstrap spawn through: `git init` via a fresh runner is how
      // fixtures are born.
      const repo = join(work, "bootstrap");
      mkdirSync(repo);
      const git = openGitRun(repo);
      git(["init", "-q"]);
      // The guard re-arms until it has seen a repository: the first
      // command after the substrate comes to exist is still guarded — here
      // a grafts file planted between the init and the next command (D47).
      mkdirSync(join(repo, ".git", "info"), { recursive: true });
      writeFileSync(join(repo, ".git", "info", "grafts"), "\n");
      expectSubstrateRefusal(
        repo,
        (runner) => void firstParentHistory(runner, "HEAD"),
        "grafts file",
        "#181",
      );
      // The bootstrap really produced a live repository: with the surgery
      // gone, the same runner's next command answers from it.
      rmSync(join(repo, ".git", "info", "grafts"));
      expect(git(["rev-parse", "--is-inside-work-tree"]).trim()).toBe("true");
    });
  });
});
