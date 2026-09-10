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
import { beta, freshAssembly, runRequest } from "./harness.js";
import { hookEffects, liveWorld, matrixHooks, runRelease } from "../vertical/matrix.js";

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

  it("a fresh process refuses to resume a mid-flight attempt whose recorded hook the request does not re-declare", () => {
    // Process A: declares the announce hook at publish:after, its
    // write-ahead start lands, then the process dies before the hook's
    // effect runs — the E-01 crash window (the driver appends the start
    // exactly as the scheduler would have, and dies there). The ledger's
    // started record is the only survivor.
    const world = liveWorld();
    const hooks = matrixHooks();
    const crashed = runRelease({
      world,
      lineId: "main",
      intents: [beta],
      hooks: [hooks.publishHook],
      hookEffects: hookEffects({ announce: { evidence: "evidence:announce" } }),
      crashAfterStartOfExtension: {
        stepKey: "hook:announce",
        stage: "publish",
        position: "after",
      },
    });
    expect(crashed.stoppedAt).toBe("publish");
    expect(crashed.stores.ledger.step(crashed.attempt.attemptId, "hook:announce")).toBe("started");

    // Process B: a fresh engine over the SAME durable stores, its own
    // process-local map. The resume request carries no declarations —
    // the CLI's resume door never does. Pre-fix: the reconstruction's
    // empty declarations derive an effective list without hook:announce,
    // so the walk silently resumes past the recorded step and publishes
    // green. Post-fix: the durable fallback refuses the takeover, naming
    // the recorded work the request does not explain.
    const restarted = freshAssembly({
      register: crashed.stores.register,
      ledger: crashed.stores.ledger,
      claims: crashed.stores.claims,
    });
    const handle = crashedHandle(crashed.assembled.planId, crashed.attempt.attemptId);
    const outcome = restarted.engine.resume(handle, runRequest(world, "main", [beta]));
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") {
      throw new Error("expected the durable takeover to refuse");
    }
    expect(outcome.detail).toContain("hook:announce");
    expect(outcome.detail).toContain("started");
  });

  it("a fresh process resuming with the matching declaration completes the started hook", () => {
    const world = liveWorld();
    const hooks = matrixHooks();
    const crashed = runRelease({
      world,
      lineId: "main",
      intents: [beta],
      hooks: [hooks.publishHook],
      hookEffects: hookEffects({ announce: { evidence: "evidence:announce" } }),
      crashAfterStartOfExtension: {
        stepKey: "hook:announce",
        stage: "publish",
        position: "after",
      },
    });
    expect(crashed.stores.ledger.step(crashed.attempt.attemptId, "hook:announce")).toBe("started");

    const restarted = freshAssembly({
      register: crashed.stores.register,
      ledger: crashed.stores.ledger,
      claims: crashed.stores.claims,
    });
    const handle = crashedHandle(crashed.assembled.planId, crashed.attempt.attemptId);
    const outcome = restarted.engine.resume(
      handle,
      runRequest(world, "main", [beta], {
        hooks: [hooks.publishHook],
        hookEffects: hookEffects({ announce: { evidence: "evidence:announce" } }),
      }),
    );
    expect(outcome.kind).toBe("published");
    // The resumed walk re-entered at the recorded started step and drove
    // the hook to completion — the durable record now reads completed.
    expect(crashed.stores.ledger.step(crashed.attempt.attemptId, "hook:announce")).toBe(
      "completed",
    );
  });
});
