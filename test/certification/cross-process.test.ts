/**
 * The certification fixture's A-cross-process cells (phase 14 contract
 * §3.5, `x-01` … `x-06`). The assembly's subject is the seam between two
 * processes over one repository: what a fresh process answers from the
 * durable record alone, how its answer relates to what a fresh ENGINE
 * answers — the pass-through equality (phase 12 §6.7's pin, cell-ized),
 * never a verdict of its own — and, live, what a takeover across two
 * running processes fences with (`x-05`) and what a fresh process
 * continues after a SIGKILLed walk (`x-06`, issue #355) — the durable
 * re-entry.
 */
import { describe, expect, it } from "vitest";

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { RunOutcome } from "../../src/index.js";
import { GitChannelStore } from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
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
  rawClaimRegister,
  rawClaimRegisterCommitCount,
  rawLedgerPlanId,
  rawLedgerTailBytes,
  runBin,
  seededHead,
  spawnBin,
  withSeededRepo,
  withSeededRepoAsync,
} from "./drive.js";

/** The child's rendered outcome. */
const rendered = (child: { stdout: string }): RunOutcome => JSON.parse(child.stdout) as RunOutcome;

/** A SIGKILL leaves the dead process's git ref lock behind (git's lock
 * protocol has no timeout), and a leftover lock would exhaust the
 * assembly's ref-write retries — so the operator sweeps the recorded
 * refs' stale `.lock` files before the next process writes. The sweep
 * touches only the locks, never the durable state below them. */
const removeStaleRefLocks = (repo: string): void => {
  const root = join(repo, ".git", "refs", "release-craft");
  if (!existsSync(root)) {
    return;
  }
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith(".lock")) {
        rmSync(path, { force: true });
      }
    }
  };
  walk(root);
};

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
        const planId = rawLedgerPlanId(repo, attemptId);

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

  it(
    "x-05 · I1 · the live takeover fence (#227, phase 4 §2.4 item 6) — a second process acquires past a suspended holder's standing lease, the register records the supersession naming both holders, and the resumed holder's walk answers denied at exit 11 naming the taker",
    { timeout: 45_000 },
    async () => {
      await withSeededRepoAsync("cert-x-05", async (repo, git, heads) => {
        // The holder process: the plain beta walk, spawned live. The freeze
        // below takes it mid-walk — a real second process holding a real
        // lease on an unfinished attempt, the takeover window itself.
        const holder = spawnBin(gitRunArgs(repo, "main"), docBytes(gitBetaDocument(heads)));

        // Poll the register with the raw fixture spellings until the
        // holder's claim lands, then freeze the walk on SIGSTOP. The bound
        // is an iteration count, not a clock — the fixture reads no clock
        // (the isolation probe).
        let register: Awaited<ReturnType<typeof rawClaimRegister>> = null;
        for (let poll = 0; poll < 3000; poll += 1) {
          register = rawClaimRegister(repo, "main");
          if (register !== null && register.claims.length > 0) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (register === null || register.claims.length !== 1) {
          throw new Error(
            `fixture broken: the holder's claim never landed in the register (last read: ${JSON.stringify(register)})`,
          );
        }
        const holderClaim = register.claims[0];
        if (holderClaim === undefined) {
          throw new Error("fixture broken: the holder's claim record is missing");
        }
        if (!holder.child.kill("SIGSTOP")) {
          throw new Error(
            "the holder process finished before the freeze — the leg's live window was missed",
          );
        }

        // The taker process: the same world with the stream's beta.1
        // recorded in its history, so the plan sequences PAST the frozen
        // lease (5.0.0-beta.2, sequence 2) — the acquisition supersedes,
        // and the taker's own walk completes.
        const taker = runBin(gitRunArgs(repo, "main"), {
          input: docBytes(
            gitDoc("main", [beta], heads, [
              { name: "5.0.0-beta.1", commit: seededHead(heads, "main") },
            ]),
          ),
        });
        expect(taker.status).toBe(0);
        expect(taker.stderr).toBe("");
        const takerOutcome = rendered(taker);
        expect(takerOutcome.kind).toBe("published");
        if (takerOutcome.kind !== "published") {
          throw new Error("expected a published outcome");
        }
        expect(takerOutcome.tag).toBe("5.0.0-beta.2");

        // The durable record, read with the raw spellings — never the
        // product reader: both claims stand, the supersession names both
        // holders, and one CAS append carries it over the holder's claim.
        const after = rawClaimRegister(repo, "main");
        if (after === null) {
          throw new Error("fixture broken: the register vanished");
        }
        expect(after.claims).toHaveLength(2);
        const takerClaim = after.claims.find((claim) => claim.scope.sequence === 2);
        if (takerClaim === undefined) {
          throw new Error("fixture broken: the taker's claim record is missing");
        }
        expect(after.claims).toContainEqual(holderClaim);
        expect(after.supersessions).toStrictEqual([
          { kind: "supersession", superseded: holderClaim, supersededBy: takerClaim },
        ]);
        expect(rawClaimRegisterCommitCount(repo, "main")).toBe(2);

        // The resume: the frozen walk continues, its next guard re-read
        // meets the recorded fence, and the refusal is loud — `denied`,
        // exit 11, naming the taker from the durable record.
        holder.child.kill("SIGCONT");
        const holderResult = await holder.done;
        expect(holderResult.status).toBe(11);
        expect(holderResult.stderr).toBe("");
        const holderOutcome = rendered(holderResult);
        expect(holderOutcome.kind).toBe("denied");
        if (holderOutcome.kind !== "denied") {
          throw new Error("expected a denied outcome");
        }
        expect(holderOutcome.holder).toBe(takerClaim.holder);
        expect(holderOutcome.handle?.attemptId).toBe(holderClaim.holder);
        // The resumed walk stops with the kernel's own claim-lost outcome
        // at the first stage it reaches (the freeze lands within the
        // claim's wake — prepare here) — the boundary's classification is
        // what turns it into the denied fence refusal.
        expect(holderOutcome.drives.at(-1)?.outcome.kind).toBe("claim-lost");

        // The end state: exactly the taker's tag minted — the superseded
        // holder never reaches its mint.
        expect(recordedTags(git, naming.namespaces)).toStrictEqual(["5.0.0-beta.2"]);
      });
    },
  );

  it(
    "x-06 · I1 · the SIGKILL continuation (issue #355) — a fresh process resumes a mid-flight walk whose process died at the recorded stop, re-lands the same published tag a clean run mints, and the line-less unknown face stays at exit 10",
    { timeout: 45_000 },
    async () => {
      // The clean run's reference — a separate hermetic repository, the
      // same closed input, the same ladder: the tag the continuation must
      // land, and the tag the continued repo must read as equal. The
      // seeding fixture runs its callback synchronously, and the expects
      // below already pin a published outcome — the capture is a plain
      // widened string, the comparisons that follow are the guard.
      let controlTag = "";
      withSeededRepo("cert-x-06-control", (repo, git, heads) => {
        const control = runBin(gitRunArgs(repo, "main"), {
          input: docBytes(gitBetaDocument(heads)),
        });
        expect(control.status).toBe(0);
        expect(control.stderr).toBe("");
        const controlOutcome = rendered(control);
        expect(controlOutcome.kind).toBe("published");
        if (controlOutcome.kind !== "published") {
          throw new Error("expected a published outcome");
        }
        // `tag` is `string | null` by type (the plan can name no tag); the
        // recorded-tags assertion above already pins the mint, so the
        // capture falls back to a sentinel that the continuation's tag
        // comparison still fails against — the guard is the assertions.
        controlTag = controlOutcome.tag ?? "";
        expect(recordedTags(git, naming.namespaces)).toStrictEqual(["5.0.0-beta.1"]);
      });

      await withSeededRepoAsync("cert-x-06", async (repo, git, heads) => {
        // The killed walk: a live child walks the same beta plan and is
        // SIGKILLed mid-walk — after the walk's plan record is durable
        // (the write-ahead crossing) and before the mint (the last
        // stage), so the durable tail records a walk the process never
        // finished. The bound is an iteration count over the recorded
        // state, not a clock — the SIGKILL window is a real subprocess
        // race, and the only clock the fixture reads is the inline
        // settle the live-style cells already use (x-05's probe).
        const holder = spawnBin(gitRunArgs(repo, "main"), docBytes(gitBetaDocument(heads)));
        let attemptId: string | undefined;
        for (let poll = 0; poll < 3000; poll += 1) {
          attemptId = ledgerAttemptIds(repo)[0];
          if (attemptId !== undefined && rawLedgerTailBytes(repo, attemptId).length >= 1) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        if (attemptId === undefined) {
          throw new Error("fixture broken: the killed walk left no attempt ref");
        }
        if (recordedTags(git, naming.namespaces).length > 0) {
          throw new Error(
            "fixture broken: the walk minted before the kill — the SIGKILL window was missed",
          );
        }
        if (!holder.child.kill("SIGKILL")) {
          throw new Error(
            "fixture broken: the walk ended before the kill — the SIGKILL window was missed",
          );
        }
        const killed = await holder.done;
        expect(killed.status).toBe(-1);
        const planId = rawLedgerPlanId(repo, attemptId);

        // The unknown face, re-asserted on the killed id: a fresh-process
        // resume WITHOUT the attempt's line is the same refused unknown
        // the fresh engine always answered (x-01's law) — the seam's line
        // gate fires before any reconstruction, so even a line-less
        // resume reads but never writes.
        const lineless = runBin(
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
        expect(lineless.status).toBe(10);
        expect(lineless.stderr).toBe("");
        expect(rendered(lineless).kind).toBe("refused");

        // Operator post-kill hygiene: a SIGKILL leaves the dead process's
        // git ref lock behind (git's lock protocol has no timeout), and a
        // leftover lock would exhaust the assembly's ref-write retries —
        // so the operator sweeps the recorded refs' stale `.lock` files
        // before the next process writes. Fixture-side only: the durable
        // state itself is untouched, swept or not.
        removeStaleRefLocks(repo);

        // The fresh process's continuation: the resume names the killed
        // attempt's plan and id and the attempt's line; the engine
        // reconstructs the entry from the ledger tail (the durable
        // re-entry seam) and the walk continues from the recorded stop to
        // the same published ladder tag the clean run minted.
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
        const resumedOutcome = rendered(resumed);
        expect(resumedOutcome.kind).toBe("published");
        if (resumedOutcome.kind !== "published") {
          throw new Error("expected a published outcome");
        }
        expect(resumedOutcome.tag).toBe(controlTag);
        expect(recordedTags(git, naming.namespaces)).toStrictEqual(["5.0.0-beta.1"]);
      });
    },
  );
});
