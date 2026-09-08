/**
 * ADR-0012 decisions 3–4 — the `channel-transition` ledger record's
 * durability, over both ledger bindings (phase 5's memory ledger, phase
 * 8's git ledger):
 *
 * - routing: the record's attemptId lives on its payload, like a step
 *   record's — every reader that partitions the tail by attempt routes it
 *   correctly;
 * - immutability: the payload freezes on append — the guard list, the
 *   attribution, and both targets (a non-null target is recorded data; a
 *   `null` target is PR-04's hidden channel, equally a recorded value);
 * - classification: `classifyResume` skips the record (it is not a step
 *   record) — present or absent, the classification is identical, and its
 *   presence never escalates;
 * - persistence: the git ledger appends it as one compare-and-swap commit
 *   in the attempt's canonical form, and a fresh binding reloads it
 *   byte-exact — double-run determinism over the reloaded tail.
 *
 * Every record names `contentFingerprint` — the idempotency key is
 * required on the type (ADR-0012 decision 4), so a reloaded record always
 * carries the key its replay door compares against.
 */
import { describe, expect, it } from "vitest";

import {
  classifyResume,
  MemoryAttemptRegister,
  MemoryLedger,
  openAttempt,
  start,
  type Attribution,
  type ChannelTransitionRecord,
  type LedgerRecord,
  type ReleaseAttempt,
} from "../../src/index.js";
import { GitLedger } from "../../src/adapters/git/index.js";
import { withTempRepo } from "../adapters/git/temp-repo.js";

const actor = (attemptId: string, who: Attribution["actor"]): Attribution => ({
  attemptId,
  actor: who,
});

/** A completed channel transition — the durable unit ADR-0012 decision 4
 * records after the application applies a move under its held claim. */
const transition = (
  attemptId: string,
  overrides: Partial<ChannelTransitionRecord> = {},
): LedgerRecord => ({
  kind: "channel-transition",
  record: {
    attemptId,
    stepKey: "channel-transition",
    channelId: "stable",
    from: { line: "1.x", version: "1.1.0" },
    to: { line: "1.x", version: "1.2.0" },
    attribution: actor(attemptId, "automation"),
    guards: [{ guard: "claim-held", passed: true }],
    claim: "claim_sha256:alpha",
    contentFingerprint: "content_sha256:stable-at-1.1.0",
    ...overrides,
  },
});

/** The tail's write-ahead shape classifyResume demands: the plan record,
 * the tag stage's started record, its completed record. */
function tailThroughTag(ledger: MemoryLedger | GitLedger, a: ReleaseAttempt): void {
  ledger.appendStart(a, "plan", actor(a.attemptId, "automation"), "content_sha256:plan-input");
  ledger.appendStart(a, "tag", actor(a.attemptId, "automation"));
  ledger.append({
    kind: "step",
    record: {
      attemptId: a.attemptId,
      stepKey: "tag",
      from: "started",
      to: "completed",
      guards: [],
      attribution: actor(a.attemptId, "automation"),
    },
  });
}

describe("the channel-transition record — in-memory ledger (ADR-0012 decisions 3–4)", () => {
  it("routes by its payload's attemptId — the tail partitions it with the attempt", () => {
    const ledger = new MemoryLedger();
    const a = start(
      openAttempt(new MemoryAttemptRegister(), {
        planId: "plan-alpha",
        planFingerprint: "plan_sha256:alpha",
      }),
    );
    ledger.appendStart(a, "plan", actor(a.attemptId, "automation"));
    const stored = ledger.append(transition(a.attemptId));

    expect(stored.kind).toBe("channel-transition");
    expect(ledger.tail(a.attemptId).at(-1)).toBe(stored);
    // The plan appendStart's pair (plan record + write-ahead) plus the
    // transition's durable unit.
    expect(ledger.tail(a.attemptId)).toHaveLength(3);
    expect(ledger.tail("attempt_sha256:not-the-same-attempt")).toEqual([]);
  });

  it("deep-freezes the payload — guards, attribution, and both targets", () => {
    const ledger = new MemoryLedger();
    const stored = ledger.append(transition("attempt_sha256:a"));

    if (stored.kind !== "channel-transition") {
      throw new Error("fixture broken: the stored record is not a channel transition");
    }
    const payload = stored.record;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.guards)).toBe(true);
    expect(Object.isFrozen(payload.guards[0])).toBe(true);
    expect(Object.isFrozen(payload.attribution)).toBe(true);
    expect(Object.isFrozen(payload.from)).toBe(true);
    expect(Object.isFrozen(payload.to)).toBe(true);
  });

  it("records a hidden channel's null target without losing the freeze (PR-04 rollback)", () => {
    const ledger = new MemoryLedger();
    const stored = ledger.append(
      transition("attempt_sha256:a", {
        to: null,
        contentFingerprint: "content_sha256:stable-at-1.2.0",
      }),
    );

    if (stored.kind !== "channel-transition") {
      throw new Error("fixture broken: the stored record is not a channel transition");
    }
    expect(stored.record.to).toBeNull();
    expect(Object.isFrozen(stored.record.from)).toBe(true);
  });

  it("is invisible to classifyResume — skipped, never escalated, classification unchanged", () => {
    const build = (records: readonly LedgerRecord[]): MemoryLedger => {
      const ledger = new MemoryLedger();
      const a = start(
        openAttempt(new MemoryAttemptRegister(), {
          planId: "plan-alpha",
          planFingerprint: "plan_sha256:alpha",
        }),
      );
      tailThroughTag(ledger, a);
      for (const record of records) {
        ledger.append(record);
      }
      return ledger;
    };
    const withTransition = build([transition("attempt_sha256:a")]);
    const without = build([]);

    const a = start(
      openAttempt(new MemoryAttemptRegister(), {
        planId: "plan-alpha",
        planFingerprint: "plan_sha256:alpha",
      }),
    );
    const classified = classifyResume(a, withTransition);
    expect(classifyResume(a, without)).toEqual(classified);
    expect(classified.kind).not.toBe("escalate");
  });
});

describe("the channel-transition record — git ledger (ADR-0012 decisions 3–4)", () => {
  const gitAttempt = (): ReleaseAttempt => ({
    attemptId: "attempt_sha256:alpha-a",
    planId: "plan-alpha",
    planFingerprint: "plan_sha256:alpha",
    state: "executing",
  });

  it("appends as one canonical commit and reloads byte-exact into a fresh binding", () => {
    withTempRepo("channel-transition-record", (_repo, git) => {
      const writer = new GitLedger(git);
      const a = gitAttempt();
      writer.appendStart(a, "plan", actor(a.attemptId, "automation"), "content_sha256:plan-input");
      const stored = writer.append(transition(a.attemptId));

      const reloaded = new GitLedger(git).tail(a.attemptId);
      // The plan appendStart's pair, then the transition's durable unit.
      expect(reloaded).toHaveLength(3);
      expect(reloaded[2]).toEqual(stored);
      expect(reloaded[2]).toEqual(transition(a.attemptId));
    });
  });

  it("classifies identically over the reloaded tail (double-run determinism)", () => {
    withTempRepo("channel-transition-classify", (_repo, git) => {
      const writer = new GitLedger(git);
      const a = gitAttempt();
      tailThroughTag(writer, a);
      writer.append(transition(a.attemptId));

      const original = classifyResume(a, writer);
      expect(classifyResume(a, new GitLedger(git))).toEqual(original);
    });
  });
});
