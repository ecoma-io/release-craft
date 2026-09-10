/**
 * The self-dogfood's world closure (#139), exercised through the planner's
 * own door over a SEEDED repository — never over whatever checkout the
 * suite happens to stand in. The checkout under a pull request is a
 * detached merge ref holding no `refs/heads/main`, so a closure that read
 * the ambient repository would green over the wrong tree (and fault in CI,
 * which is exactly what the first form of this suite did). The fixture is
 * the binding's own `withTempRepo` pattern: a real temporary repository at
 * the fixed clock, seeded with the manifest the component declares and a
 * release-worthy commit, so the closure's observed half and the planner's
 * plan over it are both deterministic. The script is driven through its
 * declared `--repo` argument — the same door the workflow uses with its
 * default.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { hermeticGitEnv } from "../../src/adapters/git/index.js";
import { plan, type PlanningInput, type PlanningOutcome } from "../../src/index.js";
import { withTempRepo } from "../adapters/git/temp-repo.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const CLOSURE_SCRIPT = join(REPO_ROOT, "scripts", "dogfood", "close-world.mjs");

/** Seeds the fixture the closure observes: the feed ref the line names, the
 * component's manifest (the projection the closure reads), and one
 * release-worthy commit over the fixture's fixed root. */
const seedFixture = (repo: string, git: (args: readonly string[]) => string): void => {
  // The hermetic env leaves `git init` on its default branch name; the rename
  // keeps the fixture at exactly one ref — the line's feed ref — so a stale
  // default-branch tip at the root commit cannot ride into the declared refs.
  git(["branch", "-m", "main"]);
  writeFileSync(
    join(repo, "package.json"),
    `${JSON.stringify({ name: "the-dogfood-fixture", version: "0.1.0" }, null, 2)}\n`,
  );
  git(["add", "package.json"]);
  git(["commit", "-m", "feat: seed the component's manifest and one release-worthy change"]);
};

describe("the self-dogfood's world closure", () => {
  it("closes the seeded repository into a world the planner's own door accepts", () => {
    withTempRepo("dogfood-world", (repo, git) => {
      seedFixture(repo, git);
      // The closure script spawns `git` subprocesses against the fixture
      // repo; the env is the binding's own hermetic floor so an ambient
      // GIT_* leak or a translated locale cannot reword a fault line the
      // suite (or the planner) discriminates on — exactly what every other
      // git fixture in this repo runs on.
      const child = spawnSync(process.execPath, [CLOSURE_SCRIPT, "--repo", repo], {
        encoding: "utf8",
        env: hermeticGitEnv(),
        maxBuffer: 64 * 1024 * 1024,
      });
      expect(child.error, `closure failed to spawn: ${String(child.error)}`).toBeUndefined();
      expect(
        child.status,
        `closure exited ${String(child.status)} — its stderr:\n${child.stderr}`,
      ).toBe(0);

      const world = JSON.parse(child.stdout) as PlanningInput;

      // The declared half, pinned: the policy block the planner normalizes,
      // the single line, the recorded bootstrap (S-02), the one component.
      expect(world.policy.digest).toBe("release-craft-self-dogfood-policy-1");
      expect(world.policy.tagFormats).toStrictEqual({});
      expect(world.lines).toStrictEqual([
        { id: "main", feedRef: "refs/heads/main", lifecycle: "active", declared: true },
      ]);
      expect(world.bootstrap).toStrictEqual({
        version: "0.1.0",
        who: "John Martin <john.itvn@gmail.com>",
        when: "2026-09-05T11:13:25+07:00",
      });
      expect(world.components).toStrictEqual([
        {
          name: "@ecoma-io/release-craft",
          manifestVersion: "0.1.0",
          paths: ["package.json"],
        },
      ]);
      expect(world.history.tags).toStrictEqual([]);

      // The observed half over the controlled tree: exactly the seeded
      // commits, the fixture's root first-born, newest at the front.
      expect(world.repository.commits).toHaveLength(2);
      const subjects = world.repository.commits.map((commit) => commit.message.split("\n")[0]);
      expect(subjects[0]).toContain("feat: seed the component's manifest");
      expect(subjects.at(-1)).toBe("ecoma: root");

      // The closed-input law: every ref head and every parent points into
      // the observed commit universe — the defect a naive closure hits.
      const shas = new Set(world.repository.commits.map((commit) => commit.sha));
      expect(world.repository.refs).toHaveLength(1);
      for (const ref of world.repository.refs) {
        expect(ref.name).toBe("refs/heads/main");
        expect(shas.has(ref.head)).toBe(true);
      }
      for (const commit of world.repository.commits) {
        expect(commit.containingRefs).toStrictEqual(["refs/heads/main"]);
        for (const parent of commit.parents) {
          expect(shas.has(parent)).toBe(true);
        }
      }

      // The planner's own door: the birth target is the recorded bootstrap
      // version verbatim (D17(1)) — a release planned, never a thrown
      // caller-contract fault.
      const outcome: PlanningOutcome = plan(world);
      expect(outcome.kind).toBe("planned");
      if (outcome.kind !== "planned") {
        throw new Error(`unreachable: expected a planned outcome, got ${outcome.kind}`);
      }
      expect(outcome.plan.lines).toHaveLength(1);
      expect(outcome.plan.lines[0]?.stable).toStrictEqual({ version: "0.1.0", tag: "0.1.0" });
    });
  });
});
