/**
 * The self-dogfood's world closure (#139), exercised through the planner's
 * own door. The closure script is caller-side tooling (phase 12 §2.4: the
 * caller closes the world) and imports nothing from the package; this suite
 * is the one standing check on the bytes a real `workflow_dispatch` will
 * feed the Action — that the script runs over the checkout, that the world
 * it prints survives the closed-input law (every ref head points into the
 * observed commit universe — the exact defect a naive closure hits), and
 * that the planner's own door normalizes and plans over it without a
 * caller-contract fault. The dispatch itself never runs in CI; the run's
 * judgment is phase 14 §7's four classes, read against the run's log.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { plan, type PlanningInput, type PlanningOutcome } from "../../src/index.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const CLOSURE_SCRIPT = join(REPO_ROOT, "scripts", "dogfood", "close-world.mjs");

describe("the self-dogfood's world closure", () => {
  it("closes a world the planner's own door accepts", () => {
    const child = spawnSync(process.execPath, [CLOSURE_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);

    const world = JSON.parse(child.stdout) as PlanningInput;

    // The line the dogfood runs is declared, and the recorded bootstrap
    // decision (S-02) rides with it — its absence would be a `blocked`
    // record at the planning boundary, not a release.
    expect(world.lines.map((line) => line.id)).toContain("main");
    expect(world.bootstrap).toBeDefined();

    // The closed-input law, asserted over the emitted bytes: every ref head
    // and every parent points into the observed commit universe.
    const shas = new Set(world.repository.commits.map((commit) => commit.sha));
    for (const ref of world.repository.refs) {
      expect(shas.has(ref.head)).toBe(true);
    }
    for (const commit of world.repository.commits) {
      for (const parent of commit.parents) {
        expect(shas.has(parent)).toBe(true);
      }
    }

    // The planner's own door: a world it normalizes and plans over — the
    // outcome is a record either way, never a thrown caller-contract fault.
    const outcome: PlanningOutcome = plan(world);
    expect(["planned", "refused"]).toContain(outcome.kind);
  });
});
