/**
 * ADR-0013 decisions 1–3 — the `abandonment` ledger record's durability,
 * over both ledger bindings (phase 5's memory ledger, phase 8's git
 * ledger):
 *
 * - routing: the record's attemptId lives at the top level, like a
 *   resolution's — every reader that partitions the tail by attempt routes
 *   it correctly, with no ledger implementation change;
 * - immutability: the record freezes on append — the reason verbatim and
 *   the abort's attribution are recorded data, never mutable cells;
 * - classification: `classifyResume` reads the record FIRST — a tail
 *   carrying an abandonment is terminal from the ledger alone (E-09), so
 *   the resume is refused as a thrown protocol violation even when a
 *   process-local attempt value claims the attempt is still open; the same
 *   tail without the record classifies normally.
 *
 * The boundary-level consequence — a fresh assembly refusing the abandoned
 * plan instead of re-executing it — is pinned in
 * `test/app/outcomes.test.ts` ("the durable abandonment — restart
 * visibility").
 */
import { describe, expect, it } from "vitest";

import {
  InvalidExecutionTransitionError,
  MemoryLedger,
  attemptIdentity,
  classifyResume,
  type LedgerRecord,
  type ReleaseAttempt,
} from "../../src/index.js";
import { GitLedger } from "../../src/adapters/git/index.js";
import { withTempRepo } from "../adapters/git/temp-repo.js";

const attemptId = attemptIdentity("plan-alpha", 1);

/** An attempt value that is NOT terminal — the process-local half the
 * classification must not trust over a recorded abandonment (ADR-0013
 * decision 3): a restarted host can hold any stale value; the tail
 * outranks it. */
const executing: ReleaseAttempt = {
  attemptId,
  planId: "plan-alpha",
  planFingerprint: "plan_sha256:alpha",
  state: "executing",
};

/** The recorded human abort — the attribution `.abort` used to drop, and
 * the reason verbatim (ADR-0013 decisions 1–2). */
const abandonment = (
  overrides: Partial<Extract<LedgerRecord, { kind: "abandonment" }>> = {},
): LedgerRecord => ({
  kind: "abandonment",
  attemptId,
  reason: "the release was withdrawn",
  attribution: { attemptId, actor: "human:maintainer" },
  ...overrides,
});

/** `classifyResume`'s verdict on the attempt, as one string: the thrown
 * protocol violation's message when the tail refuses, else the returned
 * outcome's own detail — both human-readable, both comparable. */
const classificationOf = (
  ledger: { tail: (id: string) => readonly LedgerRecord[] },
  attempt: ReleaseAttempt = executing,
): string => {
  try {
    const outcome = classifyResume(attempt, ledger as Parameters<typeof classifyResume>[1]);
    return outcome.kind === "escalate" ? outcome.detail : `no throw (${outcome.kind})`;
  } catch (error) {
    if (!(error instanceof InvalidExecutionTransitionError)) {
      throw error;
    }
    return error.message;
  }
};

describe("the abandonment record — in-memory ledger (ADR-0013 decisions 1–3)", () => {
  it("routes by its top-level attemptId — the tail partitions it with the attempt", () => {
    const ledger = new MemoryLedger();
    const stored = ledger.append(abandonment());

    expect(stored.kind).toBe("abandonment");
    expect(ledger.tail(attemptId)).toEqual([stored]);
    expect(ledger.tail(attemptIdentity("plan-alpha", 2))).toEqual([]);
  });

  it("deep-freezes the record — the reason and the attribution are recorded data", () => {
    const ledger = new MemoryLedger();
    const stored = ledger.append(abandonment());

    if (stored.kind !== "abandonment") {
      throw new Error("fixture broken: the stored record is not an abandonment");
    }
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.attribution)).toBe(true);
    expect(stored.reason).toBe("the release was withdrawn");
    expect(stored.attribution.actor).toBe("human:maintainer");
  });

  it("makes the resume a thrown violation from the tail alone — the open attempt value is outranked", () => {
    const ledger = new MemoryLedger();
    ledger.append(abandonment());

    const message = classificationOf(ledger);
    expect(message).toContain("abandonment");
    expect(message).toContain("human:maintainer");
    expect(message).toContain("the release was withdrawn");
    // Double-run: identical tails classify identically (§2.3) — the same
    // refusal, twice.
    expect(classificationOf(ledger)).toBe(message);
    // The record outranks the process-local value: a terminal value over
    // the same tail refuses with the abandonment's message, not the state
    // machine's — the recorded evidence is what the classification reads.
    const terminal = { ...executing, state: "abandoned" as const, terminalReason: "withdrawn" };
    expect(classificationOf(ledger, terminal)).toBe(message);
  });

  it("is what moves the verdict — the same tail without the record classifies normally", () => {
    const withRecord = new MemoryLedger();
    withRecord.append(abandonment());
    const without = new MemoryLedger();

    expect(classificationOf(withRecord)).toContain("terminal from the ledger alone");
    expect(classificationOf(without)).toContain("no recorded plan fingerprint");
  });
});

describe("the abandonment record — git ledger (ADR-0013 decisions 1–3)", () => {
  it("appends as one canonical commit and reloads byte-exact into a fresh binding", () => {
    withTempRepo("abandonment-record", (_repo, git) => {
      const writer = new GitLedger(git);
      const stored = writer.append(abandonment());

      const reloaded = new GitLedger(git).tail(attemptId);
      expect(reloaded).toEqual([stored]);
      expect(reloaded).toEqual([abandonment()]);
    });
  });

  it("classifies identically over the reloaded tail (double-run determinism)", () => {
    withTempRepo("abandonment-record-classify", (_repo, git) => {
      const writer = new GitLedger(git);
      writer.append(abandonment());

      const original = classificationOf(writer);
      expect(original).toContain("the release was withdrawn");
      expect(classificationOf(new GitLedger(git))).toBe(original);
    });
  });
});
