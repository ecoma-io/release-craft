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
 * #122 extends decision 3 to the OTHER classification door: the one
 * terminality law — BOTH doors (`classifyResume` and `ledgerRequestStep`)
 * answer "is this attempt over?" from the recorded tail through the ONE
 * shared classifier, and the tail outranks the process-local value in
 * BOTH directions (a terminal claim the tail cannot confirm is NOT
 * terminal; a recorded abandonment the value denies IS terminal).
 *
 * The boundary-level consequence — a fresh assembly refusing the abandoned
 * plan instead of re-executing it — is pinned in
 * `test/app/outcomes.test.ts` ("the durable abandonment — restart
 * visibility").
 */
import { describe, expect, it } from "vitest";

import {
  CANONICAL_STAGES,
  InvalidExecutionTransitionError,
  MemoryLedger,
  MemoryAttemptRegister,
  attemptIdentity,
  classifyResume,
  ledgerRequestStep,
  openAttempt,
  start,
  transition,
  type ClaimView,
  type LedgerRecord,
  type ReleaseAttempt,
  type StepRequest,
} from "../../src/index.js";
import { GitLedger } from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
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

/**
 * #122's one classification law — BOTH classification doors
 * (`classifyResume` and `ledgerRequestStep`) answer "is this attempt
 * over?" from the recorded tail through the ONE shared classifier
 * (`readTailTerminality`), never from the process-local attempt value
 * alone (ADR-0013 decision 3, extended here to the step replay door):
 *
 * - (a) a tail carrying an abandonment is terminal in both doors — the
 *   step replay door refuses with the SAME recorded evidence the resume
 *   door throws on, same question, same answer;
 * - (b) an attempt value claiming terminal over a tail with no terminal
 *   record is NOT terminal in the resume door — the value is §2.7
 *   bookkeeping, never authority, and the tail outranks it in BOTH
 *   directions;
 * - (c) both doors agree on the clean, completed, and abandoned shapes;
 * - (d) when a TERMINAL value rides a tail that carries an abandonment,
 *   the replay door's refusal quotes the recorded evidence, not the
 *   process-local wall's string — the tail read precedes the wall, so
 *   the two refusal shapes' order is observable and pinned, not
 *   decoration.
 */

const noClaims: ClaimView = { held: null, verify: () => false };

const stepRequestFor = (attempt: ReleaseAttempt, stepKey: StepRequest["stepKey"]): StepRequest => ({
  stepKey,
  attribution: { attemptId: attempt.attemptId, actor: "automation" },
});

describe("the one terminality law — both doors answer from the tail (#122)", () => {
  it("(a) a tail carrying an abandonment refuses BOTH doors — same evidence, same verdict", () => {
    const ledger = new MemoryLedger();
    ledger.append(abandonment());

    // The resume door: thrown protocol violation quoting the record.
    expect(() => classifyResume(executing, ledger)).toThrow(/the release was withdrawn/);

    // The step replay door: a recorded refusal quoting the SAME record —
    // the step door is the throwing kernel's durable twin, so its refusal
    // is a returned outcome carrying the recorded evidence verbatim.
    const outcome = ledgerRequestStep(
      executing,
      stepRequestFor(executing, "plan"),
      noClaims,
      ledger,
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.detail).toContain("human:maintainer");
    expect(outcome.detail).toContain("the release was withdrawn");
    expect(outcome.detail).toContain("terminal from the ledger alone");
  });

  it("(b) a terminal process-local value over a tail with no terminal record is NOT terminal in the resume door", () => {
    // An empty tail: nothing recorded, nothing terminal from the ledger's
    // perspective. A stale value claiming `abandoned` is §2.7 bookkeeping,
    // never authority — the tail outranks it in BOTH directions, so the
    // resume door classifies from the tail's own evidence (here: no
    // recorded plan fingerprint → escalate) and never throws on the
    // state alone.
    const empty = new MemoryLedger();
    const stale: ReleaseAttempt = {
      ...executing,
      state: "abandoned",
      terminalReason: "withdrawn",
    };
    const verdict = classifyResume(stale, empty);
    expect(verdict.kind).toBe("escalate");
    if (verdict.kind !== "escalate") return;
    expect(verdict.detail).toContain("no recorded plan fingerprint");

    // Double-run determinism: identical tails classify identically (§2.3).
    const again = classifyResume(stale, empty);
    expect(again).toStrictEqual(verdict);
  });

  it("(b') the step replay door's refusal over the same hostile shape is the boundary's defense wall, quoted as such", () => {
    // Same hostile shape as (b): a terminal value, a tail with no
    // terminal record. The resume door classified from the tail and did
    // NOT throw. The step replay door refuses on the process-local value
    // — its defense against the throwing kernel's terminal guard (the
    // walk cannot catch an InvalidExecutionTransitionError). The refusal
    // detail names the door, never an inferred classification: the
    // process-local value is what moved this verdict, and a reader can
    // tell it apart from the tail-driven refusal of (a).
    const empty = new MemoryLedger();
    const stale: ReleaseAttempt = {
      ...executing,
      state: "abandoned",
      terminalReason: "withdrawn",
    };
    const outcome = ledgerRequestStep(stale, stepRequestFor(stale, "plan"), noClaims, empty);
    expect(outcome).toStrictEqual({
      kind: "refused",
      stepKey: "plan",
      detail:
        "terminal attempt — recorded refusal (the record-path replay door, phase 5 contract §2.8)",
    });
  });

  it("(d) a TERMINAL value over an abandonment tail: the tail's refusal wins — precedence, not decoration", () => {
    // The two refusal shapes differ ONLY in their detail (see (a)): the
    // tail quotes the recorded actor and reason, the wall names the
    // process-local value. Both existing refusal pins ((a) and (b'))
    // drive open/executing or empty-tail shapes, where either check's
    // position yields the same detail — the wall-vs-tail ORDER was
    // unobserved. This shape makes it observable: the value claims
    // `published` (as terminal as the wall demands) while the tail
    // carries the abandonment, so whichever check runs FIRST names the
    // refusal. ADR-0013 decision 3's one law reads the tail first — the
    // refusal must quote the recorded evidence, never the wall's string.
    const done: ReleaseAttempt = { ...executing, state: "published" };
    const ledger = new MemoryLedger();
    ledger.append(abandonment());
    const outcome = ledgerRequestStep(done, stepRequestFor(done, "plan"), noClaims, ledger);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.detail).toContain("human:maintainer");
    expect(outcome.detail).toContain("the release was withdrawn");
    expect(outcome.detail).toContain("terminal from the ledger alone");
    expect(outcome.detail).not.toBe(
      "terminal attempt — recorded refusal (the record-path replay door, phase 5 contract §2.8)",
    );

    // The resume door's mirror: the same abandonment tail throws the
    // same recorded evidence regardless of the value driving it — the
    // `published` value moves the verdict exactly as much as the
    // `executing` one does (not at all). Identical tails, identical
    // answers (§2.3) — the value is never authority.
    expect(classificationOf(ledger, done)).toBe(classificationOf(ledger, executing));
    expect(classificationOf(ledger, done)).toContain("the release was withdrawn");
  });

  it("(c) both doors agree across the clean, completed, and abandoned shapes", () => {
    // Clean (executing, empty tail): the resume door escalates (no
    // recorded fingerprint), the step door advances — both doors treat
    // the attempt as open, per the tail.
    const clean = new MemoryLedger();
    expect(classifyResume(executing, clean).kind).toBe("escalate");
    const cleanStep = ledgerRequestStep(
      executing,
      stepRequestFor(executing, "plan"),
      noClaims,
      clean,
    );
    expect(cleanStep.kind).toBe("advance");

    // Abandoned (tail carries the record): both doors refuse with the
    // record's evidence — (a) pinned this; the agreement here is that
    // NEITHER door proceeds past it.
    const abandoned = new MemoryLedger();
    abandoned.append(abandonment());
    expect(() => classifyResume(executing, abandoned)).toThrow(InvalidExecutionTransitionError);
    expect(
      ledgerRequestStep(executing, stepRequestFor(executing, "plan"), noClaims, abandoned).kind,
    ).toBe("refused");
  });

  it("(c') a fully-completed tail ends the attempt in BOTH doors — the tail, not the value, names it done", () => {
    // All nine canonical stages recorded completed: the tail itself names
    // the attempt done. The resume door returns `complete` with the
    // ledger-derived outcome; the step replay door refuses with the
    // process-local gate's message (the same `published` value the walk
    // would carry at this point).
    const ledger = new MemoryLedger();
    const attempt1 = openAttempt(new MemoryAttemptRegister(), {
      planId: "plan-alpha",
      planFingerprint: "plan_sha256:alpha",
    });
    const started = start(attempt1);
    for (const stage of CANONICAL_STAGES) {
      ledger.appendStart(started, stage, { attemptId: started.attemptId, actor: "automation" });
      ledger.append({
        kind: "step",
        record: {
          attemptId: started.attemptId,
          stepKey: stage,
          from: "started",
          to: "completed",
          guards: [],
          attribution: { attemptId: started.attemptId, actor: "automation" },
        },
      });
    }
    const published = transition(started, "published");
    expect(classifyResume(published, ledger)).toStrictEqual({
      kind: "complete",
      outcome: "published",
    });
    const outcome = ledgerRequestStep(
      published,
      stepRequestFor(published, "tag"),
      noClaims,
      ledger,
    );
    expect(outcome).toStrictEqual({
      kind: "refused",
      stepKey: "tag",
      detail:
        "terminal attempt — recorded refusal (the record-path replay door, phase 5 contract §2.8)",
    });
  });
});
