import { describe, expect, it } from "vitest";

import {
  CANONICAL_STAGES,
  canonicalJson,
  classifyResume,
  type Attribution,
  type ExternalSatisfaction,
  type LedgerRecord,
  type ReleaseAttempt,
  type ResumeOutcome,
  type StepKey,
} from "../../../src/index.js";
import {
  commitRecord,
  firstParentHistory,
  GitFaultError,
  readRef,
  type GitRun,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import {
  GitAttemptRegister,
  GitLedger,
  ledgerRef,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import { withTempRepo } from "./temp-repo.js";

/**
 * Contract fixtures 1–2 over real repositories (phase 8 contract §4;
 * ADR-0009 decision 8): the ledger tail and the register ordinal reload
 * byte-exact into fresh bindings opened on the same repository, resume
 * classification over a reloaded tail equals classification over the
 * original (double-run determinism), and an append that would rewrite the
 * recorded history fails closed with nothing of the refused door on disk.
 * The second describe below is not contract fixtures: it pins the walked-
 * tail cache's two invalidation rules (issue #136) against their mutants.
 */

const attemptId = "attempt_sha256:alpha-a";
const planId = "plan-alpha";

const attempt = (): ReleaseAttempt => ({
  attemptId,
  planId,
  planFingerprint: "plan_sha256:alpha",
  state: "executing",
});

const actor = (who: Attribution["actor"]): Attribution => ({ attemptId, actor: who });

/** A completed step record — the shape a scheduler appends after the
 * write-ahead `started` record lands (the kernel's `advance` outcome). */
const completedRecord = (stepKey: StepKey, attribution: Attribution): LedgerRecord => ({
  kind: "step",
  record: {
    attemptId,
    stepKey,
    from: "started",
    to: "completed",
    guards: [],
    attribution,
  },
});

interface FirstRun {
  readonly outcome: ResumeOutcome;
  readonly bytes: readonly string[];
  readonly ordinal: number;
}

describe("the git-backed ledger and register (phase 8 contract §4, fixtures 1–2)", () => {
  it("fixture 1 — the ledger tail and the ordinal counter reload byte-exact into fresh bindings", () => {
    withTempRepo("persist-reload", (_repo, git) => {
      const ledger = new GitLedger(git);
      const register = new GitAttemptRegister(git);
      const a = attempt();

      // Write-ahead start: the plan record first, then the step's started
      // record — and the plan record is written once across two appendStart
      // calls (the reference ledger's plan-first discipline).
      const started = ledger.appendStart(
        a,
        "plan",
        actor("automation"),
        "content_sha256:plan-input",
      );
      expect(started.to).toBe("started");
      const tailAfterStart = ledger.tail(attemptId);
      expect(tailAfterStart[0]?.kind).toBe("plan");
      expect(tailAfterStart).toHaveLength(2);
      ledger.appendStart(a, "claim", actor("automation"));
      expect(ledger.tail(attemptId).filter((record) => record.kind === "plan")).toHaveLength(1);

      expect(Object.isFrozen(ledger.append(completedRecord("plan", actor("automation"))))).toBe(
        true,
      );
      expect(register.nextOrdinal(planId)).toBe(1);
      expect(register.nextOrdinal(planId)).toBe(2);

      // The counter's bytes are the canonical form, exactly as written.
      const counterRef = `refs/release-craft/register/${planId}`;
      const tip = readRef(git, counterRef);
      if (tip === null) {
        throw new Error("expected the ordinal counter ref to exist");
      }
      expect(commitRecord(git, tip)).toBe(canonicalJson({ nextOrdinal: 2 }));

      // Fresh bindings over the same repository: byte-exact reload.
      const originalTail = ledger.tail(attemptId);
      const reloaded = new GitLedger(git);
      const reloadedRegister = new GitAttemptRegister(git);
      const reloadedTail = reloaded.tail(attemptId);
      expect(reloadedTail).toStrictEqual(originalTail);
      expect(reloadedTail.map((record) => canonicalJson(record))).toEqual(
        originalTail.map((record) => canonicalJson(record)),
      );
      expect(Object.isFrozen(reloadedTail[0])).toBe(true);
      expect(reloaded.planFingerprint(attemptId)).toBe("plan_sha256:alpha");
      expect(reloaded.step(attemptId, "plan")).toBe("completed");
      expect(reloaded.step(attemptId, "claim")).toBe("started");
      expect(classifyResume(a, reloaded)).toEqual(classifyResume(a, ledger));
      expect(reloadedRegister.nextOrdinal(planId)).toBe(3);
    });
  });

  it("fixture 1 — classifyResume over the reloaded tail equals the original (resume-from)", () => {
    withTempRepo("resume-equivalence", (_repo, git) => {
      const ledger = new GitLedger(git);
      const a = attempt();
      ledger.appendStart(a, "plan", actor("automation"));
      ledger.append(completedRecord("plan", actor("automation")));
      ledger.appendStart(a, "claim", actor("automation"));
      const outcome = classifyResume(a, ledger);
      expect(outcome).toEqual({ kind: "resume", from: "claim" });

      const reloaded = new GitLedger(git);
      expect(reloaded.tail(attemptId)).toStrictEqual(ledger.tail(attemptId));
      expect(classifyResume(a, reloaded)).toEqual(outcome);
    });
  });

  it("fixture 1 — classifyResume over the reloaded tail equals the original (satisfied-externally)", () => {
    withTempRepo("external-equivalence", (_repo, git) => {
      const ledger = new GitLedger(git);
      const a = attempt();
      for (const stage of CANONICAL_STAGES) {
        ledger.appendStart(a, stage, actor("automation"));
        ledger.append(completedRecord(stage, actor("automation")));
      }
      // An externally observed satisfaction (E-03) — recorded, persisted,
      // and reloaded through the step view, since the complete-attempt
      // verdict reads it (resume.ts: `satisfied-externally`).
      const satisfaction: ExternalSatisfaction = {
        attribution: actor("automation"),
        evidence: "ext:release-tag",
        contentFingerprint: "content_sha256:observed",
      };
      ledger.noteExternal({ attemptId, stepKey: "publish", satisfaction });
      const outcome = classifyResume(a, ledger);
      expect(outcome).toEqual({ kind: "complete", outcome: "satisfied-externally" });

      const reloaded = new GitLedger(git);
      expect(classifyResume(a, reloaded)).toEqual(outcome);
      expect(reloaded.stepView().external(attemptId, "publish")).toStrictEqual(satisfaction);
    });
  });

  it("fixture 1 — a double run over fresh repositories classifies identically", () => {
    const run = (git: GitRun): FirstRun => {
      const ledger = new GitLedger(git);
      const register = new GitAttemptRegister(git);
      const a = attempt();
      ledger.appendStart(a, "plan", actor("automation"));
      ledger.append(completedRecord("plan", actor("automation")));
      ledger.appendStart(a, "claim", actor("automation"));
      return {
        outcome: classifyResume(a, ledger),
        bytes: ledger.tail(attemptId).map((record) => canonicalJson(record)),
        ordinal: register.nextOrdinal(planId),
      };
    };
    let first: FirstRun | undefined;
    let second: FirstRun | undefined;
    withTempRepo("double-run-first", (_repo, git) => {
      first = run(git);
    });
    withTempRepo("double-run-second", (_repo, git) => {
      second = run(git);
    });
    expect(second).toBeDefined();
    expect(second).toEqual(first);
  });

  it("fixture 2 — an append that would rewrite the recorded history fails closed", () => {
    withTempRepo("forward-only", (_repo, git) => {
      const ledger = new GitLedger(git);
      const a = attempt();
      ledger.appendStart(a, "plan", actor("automation"));
      const before = ledger.tail(attemptId);

      // A concurrent writer keeps winning the scope's ref: every
      // compare-and-swap the racing ledger attempts finds the tip moved, so
      // its append is no longer an extension of the recorded history. The
      // wrapper diverges the ref under the loser's update exactly as a
      // concurrent winner would — deterministically, one move per attempt.
      const ref = ledgerRef(attemptId);
      const hostileRecord: LedgerRecord = {
        kind: "step",
        record: {
          attemptId,
          stepKey: "claim",
          from: "pending",
          to: "started",
          guards: [],
          attribution: actor("conflict"),
        },
      };
      const diverge = (): void => {
        const current = git(["rev-parse", ref]).trim();
        const blob = git(["hash-object", "-w", "--stdin"], canonicalJson(hostileRecord)).trim();
        const tree = git(["mktree"], `100644 blob ${blob}\trecord\n`).trim();
        const commit = git([
          "commit-tree",
          tree,
          "-p",
          current,
          "-m",
          "release-craft: append",
        ]).trim();
        git(["update-ref", ref, commit]);
      };
      const hostile: GitRun = (args, input) => {
        if (args[0] === "update-ref" && args[1] === ref) {
          diverge();
        }
        return git(args, input);
      };

      const refused: LedgerRecord = completedRecord("claim", actor("automation"));
      const racing = new GitLedger(hostile);
      expect(() => racing.append(refused)).toThrow(GitFaultError);

      // Nothing the refused door wrote is on the ref: the history is
      // exactly the recorded prefix plus the concurrent writer's own
      // records — readable, byte-identical where it was written before,
      // and still classifiable.
      const history = firstParentHistory(git, ref);
      const onRef = history.map((commit) => commitRecord(git, commit));
      expect(onRef).not.toContain(canonicalJson(refused));
      expect(onRef).toContain(canonicalJson(hostileRecord));
      expect(onRef).toHaveLength(before.length + 3);
      expect(ledger.tail(attemptId).slice(0, before.length)).toStrictEqual(before);
      expect(classifyResume(a, ledger)).toEqual({ kind: "resume", from: "plan" });
    });
  });
});

/**
 * The walked-tail cache's two invalidation rules (issue #136), each pinned
 * against the mutant that removes it: a ledger whose tail is cached must
 * still see a peer's commit, whether the peer lands between the ledger's
 * own writes (the extension rule) or between its reads (the probe rule).
 * Both scenarios are deterministic and in-process — the peer is a second
 * `GitLedger` opened on the same repository, its append a plain winning
 * compare-and-swap, no clocks, no sleeps.
 */
describe("the git ledger's walked-tail cache invalidation (issue #136)", () => {
  it("extension — a winning append built past a walked tail drops it, and the peer's record stays readable", () => {
    withTempRepo("cache-extension-exact-base", (_repo, git) => {
      const ledger = new GitLedger(git);
      const a = attempt();
      ledger.appendStart(a, "plan", actor("automation"));
      // appendStart's stored-record read walks the tail: the cache now
      // holds the history up to this tip.
      const before = ledger.tail(attemptId);

      // A peer appends on the same stream — the ref moves off the tip the
      // walked tail holds.
      const peer = new GitLedger(git);
      peer.append(completedRecord("claim", actor("peer")));

      // The walking ledger appends again, and its compare-and-swap wins
      // from the peer's tip, not from the tip it holds. The extension
      // rule — the cache extends only from the exact base the append was
      // classified against, drops otherwise — is what keeps the peer's
      // record readable here: extend unconditionally and this ledger
      // serves a tail whose history never held the peer's commit.
      ledger.append(completedRecord("publish", actor("automation")));

      const actors = ledger
        .tail(attemptId)
        .flatMap((record) => (record.kind === "step" ? [record.record.attribution.actor] : []));
      expect(actors).toEqual(["automation", "peer", "automation"]);
      expect(ledger.tail(attemptId).slice(0, before.length)).toStrictEqual(before);
    });
  });

  it("probe — a walked tail is re-walked when the ref moves under it", () => {
    withTempRepo("cache-probe-reads-the-ref", (_repo, git) => {
      const ledger = new GitLedger(git);
      const a = attempt();
      ledger.appendStart(a, "plan", actor("automation"));
      const before = ledger.tail(attemptId);

      // A peer appends on the same stream, and the walking ledger reads
      // with no write of its own in between. The probe rule — the ref is
      // read before any cached history answers — is what turns the peer's
      // commit into a cache miss: serve the walked tail unconditionally
      // and this read reports the attempt's stream without the peer's
      // record on it.
      const peer = new GitLedger(git);
      peer.append(completedRecord("claim", actor("peer")));

      const actors = ledger
        .tail(attemptId)
        .flatMap((record) => (record.kind === "step" ? [record.record.attribution.actor] : []));
      expect(actors).toEqual(["automation", "peer"]);
      expect(ledger.tail(attemptId).slice(0, before.length)).toStrictEqual(before);
    });
  });
});
