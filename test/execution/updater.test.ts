import { describe, expect, it } from "vitest";

import {
  MemoryAttemptRegister,
  MemoryLedger,
  block,
  classifyResume,
  contentFingerprint,
  effectiveSteps,
  hookStepKey,
  openAttempt,
  resolveBlocked,
  scheduleMutations,
  start,
  updaterStepKey,
  type Attribution,
  type Claim,
  type ClaimView,
  type DeclaredMutation,
  type HookStep,
  type MutationIntent,
  type MutationOutcome,
  type PostconditionKind,
  type ReleaseAttempt,
  type StageKey,
  type UpdaterFs,
} from "../../src/index.js";

const PLAN = { planId: "plan-alpha", planFingerprint: "plan_sha256:alpha" };

const planned = (mutations?: readonly DeclaredMutation[]): ReleaseAttempt =>
  openAttempt(new MemoryAttemptRegister(), PLAN, undefined, undefined, mutations);

const executing = (mutations?: readonly DeclaredMutation[]): ReleaseAttempt =>
  start(planned(mutations));

const actor = (attempt: ReleaseAttempt, who = "automation"): Attribution => ({
  attemptId: attempt.attemptId,
  actor: who,
});

const heldClaim = (attempt: ReleaseAttempt): ClaimView => {
  const claim: Claim = {
    kind: "claim",
    scope: { kind: "release-line", lineId: "line-1" },
    token: "token-1",
    holder: attempt.attemptId,
  };
  return { held: claim, verify: () => true };
};

const noClaims: ClaimView = { held: null, verify: () => false };

const mutationDecl = (
  id: string,
  stage: StageKey,
  position: "before" | "after",
  postconditions: readonly PostconditionKind[] = [],
): DeclaredMutation => ({
  id,
  anchor: { stage, position },
  guard: "release-line",
  postconditions,
});

/** A tracking FS adapter that records every write and can be pre-seeded. */
const trackingFs = (
  initial?: Record<string, string>,
): UpdaterFs & { writes: readonly string[]; content: Record<string, string> } => {
  const content: Record<string, string> = { ...(initial ?? {}) };
  const writes: string[] = [];
  const fs: UpdaterFs & { writes: readonly string[]; content: Record<string, string> } = {
    read: (path: string) => content[path] ?? undefined,
    write: (path: string, value: string) => {
      writes.push(path);
      content[path] = value;
    },
    writes,
    content,
  };
  return fs;
};

const intentFor = (
  _id: string,
  path: string,
  content: string,
  expectedDigest = `digest:${String(content.length)}`,
): MutationIntent => ({
  produce: () => content,
  path,
  expectedDigest,
});

/** The walk's one-and-only outcome so far — demands exactly one record
 * before any assertion narrows into it. */
const soleOutcome = (outcomes: readonly MutationOutcome[]): MutationOutcome => {
  const [only] = outcomes;
  if (outcomes.length !== 1 || only === undefined) {
    throw new Error("expected exactly one mutation outcome");
  }
  return only;
};

const completedOutcome = (
  outcomes: readonly MutationOutcome[],
): Extract<MutationOutcome, { readonly kind: "completed" }> => {
  const completed = outcomes.find((o) => o.kind === "completed");
  if (completed === undefined) {
    throw new Error("expected a completed mutation outcome");
  }
  return completed;
};

const refusedOutcome = (
  outcomes: readonly MutationOutcome[],
): Extract<MutationOutcome, { readonly kind: "refused" }> => {
  const refused = outcomes.find((o) => o.kind === "refused");
  if (refused === undefined) {
    throw new Error("expected a refused mutation outcome");
  }
  return refused;
};

const failedOutcome = (
  outcomes: readonly MutationOutcome[],
): Extract<MutationOutcome, { readonly kind: "failed" }> => {
  const failed = outcomes.find((o) => o.kind === "failed");
  if (failed === undefined) {
    throw new Error("expected a failed mutation outcome");
  }
  return failed;
};

/** Records the updater step's start only (no completion) — a crash
 * between write-ahead and effect. */
const recordStartOnly = (ledger: MemoryLedger, attempt: ReleaseAttempt, id: string): void => {
  const stepKey = updaterStepKey(id);
  ledger.appendStart(attempt, stepKey, actor(attempt), undefined, "release-line");
};

describe("scheduleMutations", () => {
  it("records the start before the write — the ledger is the write-ahead gate (issue #203)", () => {
    const attempt = executing([mutationDecl("mut-1", "commit", "after")]);
    const ledger = new MemoryLedger();
    const fs = trackingFs();
    let ledgerHasStart = false;

    // Override the fs.write to assert ledger state at write time.
    const originalWrite = fs.write.bind(fs);
    fs.write = (path: string, value: string) => {
      ledgerHasStart = ledger.step(attempt.attemptId, updaterStepKey("mut-1")) === "started";
      originalWrite(path, value);
    };

    const intents = new Map([["mut-1", intentFor("mut-1", "pkg.json", "{}")]]);
    scheduleMutations(attempt, actor(attempt), ledger, heldClaim(attempt), intents, fs);

    expect(ledgerHasStart).toBe(true);
    expect(fs.content["pkg.json"]).toBe("{}");
  });

  it("produces deterministic bytes and writes them — the seam never invents (issue #203)", () => {
    const attempt = executing([mutationDecl("mut-1", "commit", "after")]);
    const ledger = new MemoryLedger();
    const fs = trackingFs();
    const intents = new Map([["mut-1", intentFor("mut-1", "CHANGELOG.md", "# v1.0.0\n")]]);

    const result = scheduleMutations(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      intents,
      fs,
    );

    const outcome = completedOutcome(result.outcomes);
    expect(outcome.mutationId).toBe("mut-1");
    expect(fs.content["CHANGELOG.md"]).toBe("# v1.0.0\n");
    // The completion record's fingerprint is the canonical derivation
    // over the produced bytes — never the caller's declared digest.
    expect(outcome.record.contentFingerprint).toBe(
      contentFingerprint({ "CHANGELOG.md": "# v1.0.0\n" }),
    );
  });

  it("never records a caller's bogus expectedDigest — the fingerprint is derived from the produced bytes (issue #203)", () => {
    const attempt = executing([mutationDecl("mut-1", "commit", "after")]);
    const ledger = new MemoryLedger();
    const fs = trackingFs();
    // A caller-declared digest that has nothing to do with the produced
    // bytes must not land as recorded evidence.
    const intents = new Map([
      ["mut-1", intentFor("mut-1", "release.json", '{"version":"1.0.0"}', "sha256:abcdef")],
    ]);

    const result = scheduleMutations(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      intents,
      fs,
    );

    const outcome = completedOutcome(result.outcomes);
    expect(outcome.record.contentFingerprint).toBe(
      contentFingerprint({ "release.json": '{"version":"1.0.0"}' }),
    );
    expect(outcome.record.contentFingerprint).not.toBe("sha256:abcdef");
  });

  it("records the derived fingerprint even when the caller declares no expectedDigest (issue #203)", () => {
    const attempt = executing([mutationDecl("mut-1", "commit", "after")]);
    const ledger = new MemoryLedger();
    const fs = trackingFs();
    const intents = new Map([["mut-1", intentFor("mut-1", "pkg.json", "{}", "")]]);

    const result = scheduleMutations(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      intents,
      fs,
    );

    const outcome = completedOutcome(result.outcomes);
    expect(outcome.record.contentFingerprint).toBe(contentFingerprint({ "pkg.json": "{}" }));
  });

  it("names the target path on the completion record — the ledger answers which file moved (issue #287)", () => {
    const attempt = executing([mutationDecl("mut-1", "commit", "after")]);
    const ledger = new MemoryLedger();
    const fs = trackingFs();
    const intents = new Map([["mut-1", intentFor("mut-1", "CHANGELOG.md", "# v1.0.0\n")]]);

    const result = scheduleMutations(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      intents,
      fs,
    );

    // The completion record states the file coordinate it mutated — a
    // ledger-only consumer answers "which file did `updater:mut-1` move"
    // without re-deriving the updater's HOW (the issue's law: the planner
    // decides WHAT, the updater decides HOW, execution decides WHEN, the
    // ledger records WHETHER). The record states the path; it does not
    // verify the write.
    const outcome = completedOutcome(result.outcomes);
    expect(outcome.record.targetPath).toBe("CHANGELOG.md");
  });
});

describe("deterministic replay", () => {
  it("answers from the ledger on the second pass — no re-write, no producer re-run (issue #203)", () => {
    const attempt = executing([mutationDecl("mut-1", "commit", "after")]);
    const ledger = new MemoryLedger();
    const fs = trackingFs();
    const intents = new Map([["mut-1", intentFor("mut-1", "pkg.json", "{}")]]);

    // First pass: writes, records.
    const first = scheduleMutations(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      intents,
      fs,
    );
    expect(first.outcomes).toHaveLength(1);
    expect(soleOutcome(first.outcomes).kind).toBe("completed");
    expect(fs.writes).toEqual(["pkg.json"]);

    // Second pass: replays from the ledger.
    const second = scheduleMutations(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      intents,
      fs,
    );
    expect(second.outcomes).toHaveLength(1);
    expect(soleOutcome(second.outcomes).kind).toBe("completed");
    // No new write happened.
    expect(fs.writes).toEqual(["pkg.json"]);
    // The completed outcome carries the stored proof (recorded in the ledger).
    const secondOutcome = completedOutcome(second.outcomes);
    expect(secondOutcome.mutationId).toBe("mut-1");
  });

  it("replays without a matching intent entry — completed steps answer from the ledger alone (decision 6)", () => {
    const attempt = executing([mutationDecl("mut-1", "commit", "after")]);
    const ledger = new MemoryLedger();
    const fs = trackingFs();
    const intents = new Map([["mut-1", intentFor("mut-1", "pkg.json", "{}")]]);

    // First pass writes.
    scheduleMutations(attempt, actor(attempt), ledger, heldClaim(attempt), intents, fs);

    // Second pass with an EMPTY intents map — replays because the ledger
    // already has the completed record.
    const second = scheduleMutations(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      new Map(),
      fs,
    );
    expect(soleOutcome(second.outcomes).kind).toBe("completed");
    expect(fs.writes).toEqual(["pkg.json"]); // still just the one write
  });
});

describe("recorded-vs-recorded reconciliation", () => {
  it("refuses a tail whose completion records disagree — never a silent replay of whichever record reads last (issue #203)", () => {
    const attempt = executing([mutationDecl("mut-1", "commit", "after")]);
    const ledger = new MemoryLedger();
    const fs = trackingFs();
    const stepKey = updaterStepKey("mut-1");
    const intents = new Map([["mut-1", intentFor("mut-1", "pkg.json", "{}")]]);

    // First pass: a completed mutation with its derived fingerprint.
    const first = scheduleMutations(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      intents,
      fs,
    );
    expect(soleOutcome(first.outcomes).kind).toBe("completed");
    const writesAfterFirst = fs.writes.length;

    // A second completion for the same step, recorded with DIFFERENT
    // content — as if a diverged run completed over the same key. The
    // tail now carries two disagreeing recorded proofs.
    ledger.appendStart(attempt, stepKey, actor(attempt), undefined, "release-line");
    ledger.append({
      kind: "step",
      record: {
        attemptId: attempt.attemptId,
        stepKey,
        from: "started",
        to: "completed",
        guards: [{ guard: "release-line", passed: true }],
        attribution: actor(attempt),
        contentFingerprint: contentFingerprint({ "pkg.json": '{"version":"2.0.0"}' }),
      },
    });

    // Replay: the disagreement is refused, never silently answered.
    const second = scheduleMutations(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      intents,
      fs,
    );
    expect(second.outcomes).toHaveLength(1);
    const outcome = refusedOutcome(second.outcomes);
    expect(outcome.mutationId).toBe("mut-1");
    expect(outcome.detail).toContain("fingerprint-conflict");
    // No silent replay, no new write; the attempt stays for the engine to block.
    expect(fs.writes).toHaveLength(writesAfterFirst);
    expect(second.attempt.state).toBe("executing");
  });
});

describe("crash reconciliation", () => {
  it("resumes (records completion) when the FS already has the expected content (issue #203)", () => {
    const attempt = executing([mutationDecl("mut-1", "commit", "after")]);
    const ledger = new MemoryLedger();
    // The FS already has the correct content — as if the write succeeded
    // but the completion record was lost.
    const fs = trackingFs({ "pkg.json": "{}" });

    // Simulate the crash: only appendStart, no completion.
    recordStartOnly(ledger, attempt, "mut-1");

    const intents = new Map([["mut-1", intentFor("mut-1", "pkg.json", "{}")]]);
    const result = scheduleMutations(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      intents,
      fs,
    );

    // Resume: completion recorded, no re-write.
    const outcome = completedOutcome(result.outcomes);
    expect(outcome.mutationId).toBe("mut-1");
    // The write was never called (the adapter's writes list is empty).
    expect(fs.writes).toEqual([]);
  });

  it("refuses when the FS differs from the re-derived content — external modification (issue #203)", () => {
    const attempt = executing([mutationDecl("mut-1", "commit", "after")]);
    const ledger = new MemoryLedger();
    // The FS was externally modified: different content than the producer returns.
    const fs = trackingFs({ "pkg.json": '{"modified":"externally"}' });

    // Simulate the crash.
    recordStartOnly(ledger, attempt, "mut-1");

    const intents = new Map([["mut-1", intentFor("mut-1", "pkg.json", "{}")]]);
    const result = scheduleMutations(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      intents,
      fs,
    );

    const outcome = refusedOutcome(result.outcomes);
    expect(outcome.mutationId).toBe("mut-1");
    expect(outcome.detail).toContain("external modification");
    // No completion recorded.
    expect(ledger.step(attempt.attemptId, updaterStepKey("mut-1"))).toBe("started");
  });

  it("escalates when a durable start has no injected intent — cannot re-derive (issue #203)", () => {
    const attempt = executing([mutationDecl("mut-1", "commit", "after")]);
    const ledger = new MemoryLedger();
    const fs = trackingFs();

    recordStartOnly(ledger, attempt, "mut-1");

    // No intent for mut-1.
    const result = scheduleMutations(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      new Map(),
      fs,
    );

    const outcome = failedOutcome(result.outcomes);
    expect(outcome.mutationId).toBe("mut-1");
    expect(outcome.detail).toContain("no intent injected");
    expect(attempt.state).toBe("executing");
    // The attempt was blocked by the escalation.
    expect(result.attempt.state).toBe("blocked");
  });

  it("derives the content fingerprint on a crash-reconciled completion from the resumed bytes (issue #203)", () => {
    const attempt = executing([mutationDecl("mut-1", "commit", "after")]);
    const ledger = new MemoryLedger();
    const fs = trackingFs({ "pkg.json": "{}" });
    recordStartOnly(ledger, attempt, "mut-1");

    // A bogus declared digest must not land on a resumed completion
    // either — the recorded proof is derived from the bytes on disk.
    const intents = new Map([["mut-1", intentFor("mut-1", "pkg.json", "{}", "sha256:resumed")]]);
    const result = scheduleMutations(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      intents,
      fs,
    );

    const outcome = completedOutcome(result.outcomes);
    expect(outcome.record.contentFingerprint).toBe(contentFingerprint({ "pkg.json": "{}" }));
    expect(outcome.record.contentFingerprint).not.toBe("sha256:resumed");
  });

  it("names the resumed completion's target path too — the resumed proof carries the same coordinates (issue #287)", () => {
    const attempt = executing([mutationDecl("mut-1", "commit", "after")]);
    const ledger = new MemoryLedger();
    const fs = trackingFs({ "pkg.json": "{}" });
    recordStartOnly(ledger, attempt, "mut-1");

    const intents = new Map([["mut-1", intentFor("mut-1", "pkg.json", "{}")]]);
    const result = scheduleMutations(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      intents,
      fs,
    );

    // A resumed completion is a completion: it names what it resumes over.
    const outcome = completedOutcome(result.outcomes);
    expect(outcome.record.targetPath).toBe("pkg.json");
  });

  it("fails a crash-reconciled completion whose declared postconditions are unmet (issue #203)", () => {
    const mutations = [mutationDecl("mut-1", "commit", "after", ["content-fingerprint-present"])];
    const attempt = executing(mutations);
    const ledger = new MemoryLedger();
    const fs = trackingFs({ "pkg.json": "{}" });
    recordStartOnly(ledger, attempt, "mut-1");

    // The producer's bytes match the FS, but the intent declares no
    // digest — the same proof a fresh run would demand, demanded here.
    const intents = new Map([["mut-1", intentFor("mut-1", "pkg.json", "{}", "")]]);
    const result = scheduleMutations(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      intents,
      fs,
    );

    const outcome = failedOutcome(result.outcomes);
    expect(outcome.detail).toContain("content-fingerprint-present");
    expect(result.attempt.state).toBe("blocked");
    expect(result.attempt.blockedCause).toBe(
      "validation:updater:mut-1:content-fingerprint-present",
    );
    // The failure was recorded; the step never completed.
    expect(ledger.step(attempt.attemptId, updaterStepKey("mut-1"))).toBe("failed");
  });
});

describe("claim gate", () => {
  it("refuses when no claim is held — no record, the caller retries (§2.5)", () => {
    const attempt = executing([mutationDecl("mut-1", "commit", "after")]);
    const ledger = new MemoryLedger();
    const fs = trackingFs();
    const intents = new Map([["mut-1", intentFor("mut-1", "pkg.json", "{}")]]);

    const result = scheduleMutations(attempt, actor(attempt), ledger, noClaims, intents, fs);

    const outcome = refusedOutcome(result.outcomes);
    expect(outcome.detail).toBe("mutation-without-claim");
    // No start or completion recorded.
    expect(ledger.step(attempt.attemptId, updaterStepKey("mut-1"))).toBe("none");
  });
});

describe("ordered execution", () => {
  it("stops at the first refused mutation — ordered execution (issue #203)", () => {
    const mutations = [
      mutationDecl("mut-1", "commit", "after"),
      mutationDecl("mut-2", "commit", "after"),
    ];
    const attempt = executing(mutations);
    const ledger = new MemoryLedger();
    const fs = trackingFs();
    const intents = new Map([
      ["mut-1", intentFor("mut-1", "a.txt", "a")],
      ["mut-2", intentFor("mut-2", "b.txt", "b")],
    ]);

    // No claim held: mut-1's aggregate guard refuses, and the walk stops —
    // mut-2 is never reached (ordered execution).
    const result = scheduleMutations(attempt, actor(attempt), ledger, noClaims, intents, fs);

    expect(result.outcomes).toHaveLength(1);
    expect(soleOutcome(result.outcomes).kind).toBe("refused");
    expect(soleOutcome(result.outcomes).mutationId).toBe("mut-1");
    // Neither step was started; mut-2's file was never touched.
    expect(ledger.step(attempt.attemptId, updaterStepKey("mut-1"))).toBe("none");
    expect(ledger.step(attempt.attemptId, updaterStepKey("mut-2"))).toBe("none");
    expect(fs.content["b.txt"]).toBeUndefined();
  });

  it("throws on a fresh declared mutation without an injected intent — the engine never invents user code (ADR-0007 decision 2)", () => {
    const attempt = executing([
      mutationDecl("mut-1", "commit", "after"),
      mutationDecl("mut-2", "commit", "after"),
    ]);
    const ledger = new MemoryLedger();
    const fs = trackingFs();

    // mut-1 completes; mut-2 has no intent — the kernel-level violation
    // hooks and artifacts throw for, thrown the same way.
    const intents = new Map([["mut-1", intentFor("mut-1", "a.txt", "a")]]);
    expect(() =>
      scheduleMutations(attempt, actor(attempt), ledger, heldClaim(attempt), intents, fs),
    ).toThrow(/no intent injected for the declared mutation "mut-2"/);
  });

  it("drives out-of-declaration-order anchors in effective order — one path, the later writer wins (issue #203)", () => {
    // Declared in REVERSE effective order: the tag:after mutation first,
    // the plan:before mutation second. Effective order is anchor-driven:
    // plan:before runs before tag:after.
    const mutations = [
      mutationDecl("mut-tag", "tag", "after"),
      mutationDecl("mut-plan", "plan", "before"),
    ];
    const attempt = executing(mutations);
    const ledger = new MemoryLedger();
    const fs = trackingFs();
    const intents = new Map([
      ["mut-tag", intentFor("mut-tag", "version.txt", "tag-wins")],
      ["mut-plan", intentFor("mut-plan", "version.txt", "plan-first")],
    ]);

    const result = scheduleMutations(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      intents,
      fs,
    );

    // Effective order: mut-plan first, mut-tag second — the later
    // writer's bytes win on the shared path.
    const completedIds = result.outcomes
      .filter(
        (outcome): outcome is Extract<MutationOutcome, { readonly kind: "completed" }> =>
          outcome.kind === "completed",
      )
      .map((outcome) => outcome.mutationId);
    expect(completedIds).toEqual(["mut-plan", "mut-tag"]);
    expect(fs.content["version.txt"]).toBe("tag-wins");
  });
});

describe("write-verify gate", () => {
  it("escalates when the adapter writes different bytes than the producer returned (issue #203)", () => {
    const attempt = executing([mutationDecl("mut-1", "commit", "after")]);
    const ledger = new MemoryLedger();
    const fs = trackingFs();

    // Adapter returns different content on read-back than what was written.
    const buggyFs: UpdaterFs = {
      write: (path: string, _value: string) => {
        fs.write(path, "buggy-content");
      },
      read: (path: string) => fs.read(path),
    };

    const intents = new Map([["mut-1", intentFor("mut-1", "pkg.json", "{}")]]);
    const result = scheduleMutations(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      intents,
      buggyFs,
    );

    const outcome = failedOutcome(result.outcomes);
    expect(outcome.detail).toContain("write-verify mismatch");
    expect(result.attempt.state).toBe("blocked");
  });
});

describe("effectiveSteps inclusion", () => {
  it("includes updater mutation steps in the effective list — resume classification sees them (issue #203)", () => {
    const mutations = [mutationDecl("mut-1", "commit", "after")];
    const attempt = executing(mutations);
    const steps = effectiveSteps(attempt);

    const mut1Key = updaterStepKey("mut-1");
    expect(steps).toContain(mut1Key);
    // Should come after the 'commit' stage since it's anchored after.
    const commitIdx = steps.indexOf("commit");
    const mut1Idx = steps.indexOf(mut1Key);
    expect(mut1Idx).toBeGreaterThan(commitIdx);
  });

  it("places mutation steps between artifacts and the next stage at the same anchor (issue #203)", () => {
    // Mutation anchored after 'validate' — should appear after 'validate'
    // and before 'version' in the effective list.
    const mutations = [mutationDecl("mut-1", "validate", "after")];
    const hooks: HookStep[] = [
      {
        id: "hook-1",
        anchor: { stage: "validate", position: "after" },
        guard: "release-line",
        postconditions: [],
      },
    ];
    // openAttempt signature: (register, plan, hooks?, artifacts?, mutations?)
    const attempt = openAttempt(new MemoryAttemptRegister(), PLAN, hooks, undefined, mutations);
    const steps = effectiveSteps(start(attempt));

    const validateIdx = steps.indexOf("validate");
    const hookIdx = steps.indexOf(hookStepKey("hook-1"));
    const mutIdx = steps.indexOf(updaterStepKey("mut-1"));

    // After position: the stage, then the hook, then the mutation (the
    // cross-kind tie rule: hooks precede mutations), then the next stage.
    const commitIdx = steps.indexOf("commit");
    expect(validateIdx).toBeLessThan(hookIdx);
    expect(hookIdx).toBeLessThan(mutIdx);
    expect(mutIdx).toBeLessThan(commitIdx);
  });
});

describe("classifyResume — updater records (issue #203)", () => {
  it("classifies a failed updater record as an extension step — not crash territory (issue #203)", () => {
    const attempt = executing([mutationDecl("mut-1", "commit", "after")]);
    const ledger = new MemoryLedger();
    const stepKey = updaterStepKey("mut-1");

    // A failed updater record on a blocked attempt: §2.7's loop answers it
    // — resolveBlocked appends the closing resolution, and classification
    // continues at the first uncompleted step, never crash classification.
    const blocked = block(attempt, "validation:updater:mut-1:write-verify");
    ledger.appendStart(blocked, stepKey, actor(blocked), undefined, "release-line");
    ledger.append({
      kind: "step",
      record: {
        attemptId: blocked.attemptId,
        stepKey,
        from: "started",
        to: "failed",
        guards: [{ guard: "release-line", passed: false }],
        attribution: actor(blocked),
      },
    });
    resolveBlocked(
      blocked,
      stepKey,
      { kind: "revalidation", planFingerprint: PLAN.planFingerprint },
      ledger,
      actor(blocked, "human"),
    );

    const verdict = classifyResume(blocked, ledger);
    expect(verdict.kind).toBe("resume");
    if (verdict.kind !== "resume") throw new Error("expected a resume verdict");
    expect(verdict.from).toBe("plan");
  });

  it("escalates a failed updater record without a blocked attempt — tail contradiction (issue #203)", () => {
    const attempt = executing([mutationDecl("mut-1", "commit", "after")]);
    const ledger = new MemoryLedger();

    // Record a failed updater step on an unblocked attempt — structurally
    // inconsistent; resume cannot trust this tail.
    const stepKey = updaterStepKey("mut-1");
    ledger.appendStart(attempt, stepKey, actor(attempt), undefined, "release-line");
    ledger.append({
      kind: "step",
      record: {
        attemptId: attempt.attemptId,
        stepKey,
        from: "started",
        to: "failed",
        guards: [{ guard: "release-line", passed: false }],
        attribution: actor(attempt),
      },
    });

    const outcome = classifyResume(attempt, ledger);
    expect(outcome.kind).toBe("escalate");
    if (outcome.kind !== "escalate") {
      throw new Error("expected an escalation");
    }
    expect(outcome.detail).toContain("without a blocked attempt");
  });
});

describe("openAttempt — mutation validation", () => {
  it("rejects duplicate mutation ids — ledger keys are unique per attempt (issue #203)", () => {
    const mutations = [
      mutationDecl("mut-1", "commit", "after"),
      mutationDecl("mut-1", "tag", "after"),
    ];
    expect(() =>
      openAttempt(new MemoryAttemptRegister(), PLAN, undefined, undefined, mutations),
    ).toThrow(/duplicate mutation id "mut-1"/);
  });

  it("rejects blank mutation ids — the ledger key is updater:<id> (issue #203)", () => {
    const mutations = [mutationDecl("", "commit", "after")];
    expect(() =>
      openAttempt(new MemoryAttemptRegister(), PLAN, undefined, undefined, mutations),
    ).toThrow(/non-empty recorded value/);
  });

  it("rejects unknown anchor stages — contract §2.1 (issue #203)", () => {
    const mutations: DeclaredMutation[] = [
      {
        id: "mut-1",
        anchor: { stage: "nonexistent" as StageKey, position: "after" },
        guard: "release-line",
        postconditions: [],
      },
    ];
    expect(() =>
      openAttempt(new MemoryAttemptRegister(), PLAN, undefined, undefined, mutations),
    ).toThrow(/not one of the canonical stages/);
  });

  it("rejects blank guard names — contract §2.2 (issue #203)", () => {
    const mutations: DeclaredMutation[] = [
      {
        id: "mut-1",
        anchor: { stage: "commit", position: "after" },
        guard: "",
        postconditions: [],
      },
    ];
    expect(() =>
      openAttempt(new MemoryAttemptRegister(), PLAN, undefined, undefined, mutations),
    ).toThrow(/blank guard name/);
  });

  it("rejects unknown postcondition kinds — contract §2.4 (issue #203)", () => {
    const mutations: DeclaredMutation[] = [
      {
        id: "mut-1",
        anchor: { stage: "commit", position: "after" },
        guard: "release-line",
        postconditions: ["unknown-kind" as PostconditionKind],
      },
    ];
    expect(() =>
      openAttempt(new MemoryAttemptRegister(), PLAN, undefined, undefined, mutations),
    ).toThrow(/unknown postcondition/);
  });
});

describe("postconditions", () => {
  it("refuses evidence-present — the updater seam returns no evidence ref (issue #203)", () => {
    const mutations = [mutationDecl("mut-1", "commit", "after", ["evidence-present"])];
    const attempt = executing(mutations);
    const ledger = new MemoryLedger();
    const fs = trackingFs();
    const intents = new Map([["mut-1", intentFor("mut-1", "pkg.json", "{}")]]);

    const result = scheduleMutations(
      attempt,
      actor(attempt),
      ledger,
      heldClaim(attempt),
      intents,
      fs,
    );

    const outcome = failedOutcome(result.outcomes);
    expect(outcome.detail).toContain('postcondition "evidence-present" unmet');
  });
});
