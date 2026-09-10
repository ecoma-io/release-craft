/**
 * The cross-process resume regression (issue #194): a fresh process can
 * resume an attempt a dead holder left behind — the durable plan-keyed
 * lookup reconstructs the entry from the ledger when the process-local map
 * carries none, and the idempotent claim re-acquire returns the durably
 * stored token. Fails pre-fix (the resume refuses "unknown attempt"),
 * passes post-fix.
 */
import { describe, expect, it } from "vitest";

import {
  crashedHandle,
  docBytes,
  gitAssembly,
  gitBetaDocument,
  gitDoc,
  gitRunArgs,
  ledgerAttemptIds,
  ledgerPlanId,
  runBin,
  seededHead,
  withSeededRepo,
} from "../certification/drive.js";
import type { RunOutcome } from "../../src/index.js";
import { beta, runRequest } from "./harness.js";
import { liveWorld } from "../vertical/matrix.js";

/** The child's rendered outcome. */
const rendered = (child: { stdout: string }): RunOutcome => JSON.parse(child.stdout) as RunOutcome;

describe("the cross-process resume regression (issue #194)", () => {
  it(
    "a fresh process resumes an attempt the first process completed — published, not refused(unknown attempt)",
    { timeout: 45_000 },
    () => {
      withSeededRepo("x-resume-takeover", (repo, _git, heads) => {
        // The first process runs to completion — the attempt's claim stays
        // held (no release door was called), the tag minted. The holder
        // process then dies: nothing releases the claim, nothing carries
        // the attempt in a live map.
        const first = runBin(gitRunArgs(repo, "main"), {
          input: docBytes(gitBetaDocument(heads)),
        });
        expect(first.status).toBe(0);

        // The ids the second process will name — read from the repository
        // itself (the only survivor of the dead process).
        const attemptId = ledgerAttemptIds(repo)[0];
        if (attemptId === undefined) {
          throw new Error("fixture broken: the first run left no ledger ref");
        }
        const planId = ledgerPlanId(repo, attemptId);

        // The second process resumes through the same door. Pre-fix: the
        // process-local map carries no entry for this plan, so the resume
        // refuses "unknown attempt" at exit 10. Post-fix: the durable
        // lookup reconstructs the entry, the claim re-acquires
        // idempotently, and the completed attempt's mint is the idempotent
        // re-mint.
        const resumed = runBin(
          [
            "resume",
            "--assembly",
            "git",
            "--repo",
            repo,
            "--tag-namespace",
            "",
            "--max-retries",
            "0",
            "--world",
            "-",
            "--actor",
            "automation",
            "--plan",
            planId,
            "--attempt",
            attemptId,
            "--line",
            "main",
            "--json",
          ],
          { input: docBytes(gitBetaDocument(heads)) },
        );
        expect(resumed.status).toBe(0);
        expect(resumed.stderr).toBe("");
        const outcome = rendered(resumed);
        expect(outcome.kind).toBe("published");

        // The pass-through pin, equality not verdict: the fresh process's
        // resume answer is what a fresh ENGINE returns for the same
        // handle — the durable lookup moves the value, not the cell. The
        // direct request carries the recorded target (the mint target is
        // a plan-run value, never ambient).
        const doc = gitDoc("main", [beta], heads);
        const direct = gitAssembly(repo).resume(crashedHandle(planId, attemptId), {
          ...runRequest(liveWorld(), "main", [beta]),
          input: doc,
          targets: { main: seededHead(heads, "main") },
        });
        expect(direct.kind).toBe("published");
        expect(JSON.stringify(outcome)).toBe(JSON.stringify(direct));
      });
    },
  );
});
