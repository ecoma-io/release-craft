/**
 * The certification fixture's A-cross-process posture cells (phase 14
 * contract §3.5, `x-01` … `x-04`). The assembly's subject is the seam
 * between two processes over one repository: what a fresh process answers
 * from the durable record alone, and how its answer relates to what a
 * fresh ENGINE answers — the pass-through equality (phase 12 §6.7's pin,
 * cell-ized), never a verdict of its own.
 */

import { describe, expect, it } from "vitest";

import type { RunOutcome } from "../../src/index.js";
import { GitChannelStore } from "../../src/adapters/git/index.js";
import { beta, runRequest } from "../app/harness.js";
import { liveWorld } from "../vertical/matrix.js";
import { naming, recordedTags } from "../vertical/matrix-git.js";
import {
  attestDeclaration,
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
} from "./drive.js";

/** The child's rendered outcome. */
const rendered = (child: { stdout: string }): RunOutcome => JSON.parse(child.stdout) as RunOutcome;

describe("the certification fixture · A-cross-process", () => {
  it(
    "x-01 · the carried-attempt doors from a fresh process — refused(unknown attempt) at exit 10, pinned as pass-through equality with a fresh engine's value",
    { timeout: 45_000 },
    () => {
      withSeededRepo("cert-x-01", (repo, _git, heads) => {
        // A real run in the first process: the ids the refusal will name.
        const first = runBin(gitRunArgs(repo, "main"), {
          input: docBytes(gitBetaDocument(heads)),
        });
        expect(first.status).toBe(0);
        const attemptId = ledgerAttemptIds(repo)[0];
        if (attemptId === undefined) {
          throw new Error("fixture broken: the first run left no ledger ref");
        }
        const planId = ledgerPlanId(repo, attemptId);

        // The fresh process's carried-attempt doors: resume, abort,
        // resolve, show attempt — each refuses with the recorded
        // unknown-attempt shape, stdout carrying the JSON, stderr empty.
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
            "--json",
          ],
          { input: docBytes(gitBetaDocument(heads)) },
        );
        expect(resumed.status).toBe(10);
        expect(resumed.stderr).toBe("");
        const resumeOutcome = rendered(resumed);
        expect(resumeOutcome.kind).toBe("refused");
        if (resumeOutcome.kind !== "refused") {
          throw new Error("expected a refused outcome");
        }
        expect(resumeOutcome.detail).toContain("unknown attempt");

        const aborted = runBin([
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
        ]);
        expect(aborted.status).toBe(10);
        expect(rendered(aborted).kind).toBe("refused");

        const resolved = runBin([
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
        ]);
        expect(resolved.status).toBe(10);
        expect(rendered(resolved).kind).toBe("refused");

        const shown = runBin([
          "show",
          "attempt",
          "--assembly",
          "git",
          "--repo",
          repo,
          "--tag-namespace",
          "",
          "--plan",
          planId,
          "--attempt",
          attemptId,
          "--actor",
          "automation",
          "--json",
        ]);
        expect(shown.status).toBe(10);
        expect(rendered(shown).kind).toBe("refused");

        // The pass-through pin, equality not verdict: the fresh process's
        // resume answer is what a fresh ENGINE returns for the same
        // handle — the durable lookup moves the value, not the cell.
        const direct = gitAssembly(repo).resume(crashedHandle(planId, attemptId), {
          ...runRequest(liveWorld(), "main", [beta]),
          input: gitDoc("main", [beta], heads),
        });
        expect(direct.kind).toBe("refused");
        if (direct.kind !== "refused") {
          throw new Error("expected a refused outcome");
        }
        expect(JSON.stringify(resumeOutcome)).toBe(JSON.stringify(direct));
      });
    },
  );

  it(
    "x-02 · the one observation that works cross-process — `show channels` reads the wired store's recorded states, exit 0, the recorded targets",
    { timeout: 45_000 },
    () => {
      withSeededRepo("cert-x-02", (repo) => {
        // The standing states are the store's own: the child's rendered
        // channels carry the store's recorded targets — equality with the
        // store, never a verdict about them.
        const recorded = new GitChannelStore(repo).list();
        expect(recorded.length).toBeGreaterThan(0);
        const child = runBin([
          "show",
          "channels",
          "--assembly",
          "git",
          "--repo",
          repo,
          "--tag-namespace",
          "",
          "--json",
        ]);
        expect(child.status).toBe(0);
        expect(child.stderr).toBe("");
        const outcome = rendered(child) as { kind: string; channels?: unknown };
        expect(outcome.kind).toBe("channels");
        expect(JSON.stringify(outcome)).toBe(
          JSON.stringify({ kind: "channels", channels: recorded }),
        );
      });
    },
  );

  it(
    "x-03 · I5 · the abandonment refusal read by a stranger process — exit 10 quoting the recorded actor, reason, and attempt id",
    { timeout: 45_000 },
    () => {
      withSeededRepo("cert-x-03", (repo, _git, heads) => {
        // The abort is seated in the seeding process, over the SAME closed
        // document the stranger process carries — the plan id both compute
        // is one plan's.
        const engine = gitAssembly(repo);
        const stopped = engine.run({
          input: gitDoc("main", [beta], heads),
          lineIds: ["main"],
          intents: [beta],
          actor: "automation",
          targets: { main: seededHead(heads, "main") },
          declarations: attestDeclaration(),
        });
        expect(stopped.kind).toBe("blocked");
        if (stopped.kind !== "blocked" || stopped.handle === null || stopped.planId === null) {
          throw new Error("expected a blocked attempt");
        }
        const abandoned = engine.abort(
          stopped.handle,
          "human:maintainer",
          "reason:aborted-by-the-fixture",
        );
        expect(abandoned.kind).toBe("abandoned");

        // The stranger process re-running the aborted plan refuses,
        // quoting the record — the derived-ordinal scan reads the ledger
        // alone, so the process-local store's absence does not mute it.
        const child = runBin(gitRunArgs(repo, "main"), {
          input: docBytes(gitDoc("main", [beta], heads)),
        });
        expect(child.status).toBe(10);
        expect(child.stderr).toBe("");
        const outcome = rendered(child);
        expect(outcome.kind).toBe("refused");
        if (outcome.kind !== "refused") {
          throw new Error("expected a refused outcome");
        }
        expect(outcome.detail).toContain("human:maintainer");
        expect(outcome.detail).toContain("reason:aborted-by-the-fixture");
        expect(outcome.detail).toContain(stopped.handle.attemptId);
        expect(outcome.drives).toStrictEqual([]);
      });
    },
  );

  it(
    "x-04 · the recorded replay — a double run over unchanged recorded state does not re-execute, and the second process's outcome is the hand-derived conflict",
    { timeout: 45_000 },
    () => {
      withSeededRepo("cert-x-04", (repo, git, heads) => {
        // Hand-derived before the first run (the goldens discipline): the
        // second identical process finds the stream's prerelease lease
        // recorded, its own bound is the fail-closed 0, so the outcome is
        // the explicit conflict (0 of 0) at exit 14 — drives empty, and
        // exactly one minted tag, because the walk never ran twice.
        const first = runBin(gitRunArgs(repo, "main"), {
          input: docBytes(gitBetaDocument(heads)),
        });
        expect(first.status).toBe(0);
        expect(recordedTags(git, naming.namespaces)).toStrictEqual(["5.0.0-beta.1"]);

        const second = runBin(gitRunArgs(repo, "main"), {
          input: docBytes(gitBetaDocument(heads)),
        });
        expect(second.status).toBe(14);
        expect(second.stderr).toBe("");
        const outcome = rendered(second);
        expect(outcome.kind).toBe("conflict");
        if (outcome.kind !== "conflict") {
          throw new Error("expected a conflict outcome");
        }
        expect(outcome.detail).toContain("0 of 0");
        expect(outcome.drives).toStrictEqual([]);
        // The recorded state is unchanged: still exactly one minted tag.
        expect(recordedTags(git, naming.namespaces)).toStrictEqual(["5.0.0-beta.1"]);
      });
    },
  );
});
