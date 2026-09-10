/**
 * The surviving process-local doors (issue #194's amendment): the durable
 * plan-keyed lookup serves `resume` only — `resolve` and `abort` still
 * require the process-local attempts map, so a fresh process naming a
 * MID-FLIGHT attempt (a durable claim whose holder died, no terminal
 * record anywhere) receives the boundary's own refused(unknown attempt)
 * at exit 10 through both doors. Pins today's true envelope; the value
 * moves only when a slice widens those doors (phase 11 §4 question 6's
 * residual).
 */
import { describe, expect, it } from "vitest";

import type { ClaimScope, RunOutcome } from "../../src/index.js";
import { attemptIdentity } from "../../src/index.js";
import { rawGitClaims, runBin, withSeededRepo } from "../certification/drive.js";

/** The child's rendered outcome. */
const rendered = (child: { stdout: string }): RunOutcome => JSON.parse(child.stdout) as RunOutcome;

describe("the surviving process-local doors (issue #194's amendment)", () => {
  it(
    "resolve and abort from a fresh process refuse a mid-flight attempt — unknown attempt at exit 10",
    { timeout: 45_000 },
    () => {
      withSeededRepo("x-residual-doors", (repo) => {
        // The mid-flight attempt: a holder acquired the line's
        // stable-scope claim and died before any terminal record — the
        // durable claim is the only survivor (no release door exists to
        // clear it), and the fresh process's map carries nothing. The
        // attempt id is the protocol's own derivation for the plan's
        // first ordinal.
        const planId = "plan-residual-doors";
        const attemptId = attemptIdentity(planId, 1);
        const scope: ClaimScope = {
          kind: "stable-version",
          lineId: "main",
          version: "5.0.0",
        };
        const seeded = rawGitClaims(repo).acquire(scope, attemptId);
        if (seeded.kind !== "claim") {
          throw new Error(`fixture broken: the seed claim did not land (${seeded.kind})`);
        }

        // The fresh process's abort: the door requires the carried entry,
        // the map has none, and the durable record does not answer here —
        // refused(unknown attempt) at exit 10, stdout carrying the JSON,
        // stderr empty.
        const aborted = runBin(
          [
            "abort",
            "--assembly",
            "git",
            "--repo",
            repo,
            "--tag-namespace",
            "",
            "--actor",
            "automation",
            "--plan",
            planId,
            "--attempt",
            attemptId,
            "--reason",
            "reason:stranger-process",
            "--json",
          ],
          {},
        );
        expect(aborted.status).toBe(10);
        expect(aborted.stderr).toBe("");
        const abortOutcome = rendered(aborted);
        expect(abortOutcome.kind).toBe("refused");
        if (abortOutcome.kind !== "refused") {
          throw new Error("expected a refused outcome");
        }
        expect(abortOutcome.detail).toContain("unknown attempt");

        // The fresh process's resolve: the same posture — the durable
        // lookup is resume's alone.
        const resolved = runBin(
          [
            "resolve",
            "--assembly",
            "git",
            "--repo",
            repo,
            "--tag-namespace",
            "",
            "--actor",
            "automation",
            "--plan",
            planId,
            "--attempt",
            attemptId,
            "--step",
            "validate",
            "--resolution",
            "human",
            "--note",
            "the guard is fine",
            "--json",
          ],
          {},
        );
        expect(resolved.status).toBe(10);
        expect(resolved.stderr).toBe("");
        const resolveOutcome = rendered(resolved);
        expect(resolveOutcome.kind).toBe("refused");
        if (resolveOutcome.kind !== "refused") {
          throw new Error("expected a refused outcome");
        }
        expect(resolveOutcome.detail).toContain("unknown attempt");
      });
    },
  );
});
