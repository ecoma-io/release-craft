/**
 * The in-memory ledger (phase 5 contract §2.1; ADR-0006 decisions 1–2) —
 * the reference `ExecutionLedger`: records keyed by `(attemptId, stepKey)`,
 * append-only, deep-frozen on append, ordered by append position. A step's
 * `started` record is durable before its effect may run (write-ahead,
 * E-02/AR-05); the attempt's plan record is its first (§2.2). The read
 * paths are pure projections — including the `StepRecordsView` the
 * kernel's `requestStep` consumes, so resume replays the tail through the
 * kernel's own classification. Fork 16 stays open: durability across
 * process boundaries is the Phase 8 binding's problem.
 */
import {
  type Attribution,
  type ExternalSatisfaction,
  type LedgerRecord,
  type LedgerStepState,
  type ReleaseAttempt,
  type StepKey,
  type StepRecordsView,
  type StepState,
  type TransitionRecord,
} from "./types.js";

/** An externally observed step satisfaction keyed to its (attempt, step) —
 * recorded by the caller; the ledger consumes and verifies it (E-03). */
export interface KeyedObservation {
  readonly attemptId: string;
  readonly stepKey: StepKey;
  readonly satisfaction: ExternalSatisfaction;
}

export class MemoryLedger {
  readonly #records: LedgerRecord[] = [];
  readonly #external: Map<string, ExternalSatisfaction> = new Map();

  appendStart(
    attempt: ReleaseAttempt,
    stepKey: StepKey,
    attribution: Attribution,
    contentFingerprint?: string,
  ): TransitionRecord {
    if (this.planFingerprint(attempt.attemptId) === null) {
      this.append({
        kind: "plan",
        attemptId: attempt.attemptId,
        planFingerprint: attempt.planFingerprint,
        attribution,
      });
    }
    const record: TransitionRecord = {
      attemptId: attempt.attemptId,
      stepKey,
      from: "pending",
      to: "started",
      guards: [],
      attribution,
      ...(contentFingerprint === undefined ? {} : { contentFingerprint }),
    };
    this.append({ kind: "step", record });
    const stored = this.tail(attempt.attemptId).at(-1);
    if (stored?.kind !== "step") {
      throw new Error("the ledger lost the step record it just appended");
    }
    return stored.record;
  }

  /** The only other write: append, deep-freeze, keep order. Returns the
   * frozen record that is now part of the ledger. */
  append(record: LedgerRecord): LedgerRecord {
    const frozen = deepFreezeRecord(record);
    this.#records.push(frozen);
    return frozen;
  }

  /** All of the attempt's records, append order. */
  tail(attemptId: string): readonly LedgerRecord[] {
    return this.#records.filter((record) => tailAttemptId(record) === attemptId);
  }

  /** The step's recorded state, `none` when nothing is recorded (§2.1). */
  step(attemptId: string, stepKey: StepKey): LedgerStepState {
    const record = this.#stepRecords(attemptId)
      .filter((item) => item.stepKey === stepKey)
      .at(-1);
    return record === undefined ? "none" : record.to === "pending" ? "started" : record.to;
  }

  /** The recorded plan fingerprint (§2.2), or null before the first record. */
  planFingerprint(attemptId: string): string | null {
    const plan = this.#records.find(
      (record) => record.kind === "plan" && record.attemptId === attemptId,
    );
    return plan?.kind === "plan" ? plan.planFingerprint : null;
  }

  /** Records an externally observed step satisfaction (E-03). Callers
   * observe; the ledger judges (§2.6). */
  noteExternal(observation: KeyedObservation): void {
    this.#external.set(
      `${observation.attemptId}\u0000${observation.stepKey}`,
      observation.satisfaction,
    );
  }

  /** The step record view the kernel's `requestStep` consumes (§2.3) — the
   * projection resume replays through. */
  stepView(): StepRecordsView {
    const records = this.#records;
    const external = this.#external;
    const steps = (attemptId: string): readonly TransitionRecord[] =>
      records
        .flatMap((record) => (record.kind === "step" ? [record.record] : []))
        .filter((item) => item.attemptId === attemptId);
    return {
      records: (attemptId) => steps(attemptId),
      completed: (attemptId, stepKey) =>
        [...steps(attemptId)]
          .reverse()
          .find(
            (item) =>
              item.attemptId === attemptId && item.stepKey === stepKey && item.to === "completed",
          ) ?? null,
      state: (attemptId, stepKey): StepState =>
        [...steps(attemptId)]
          .reverse()
          .find((item) => item.attemptId === attemptId && item.stepKey === stepKey)?.to ??
        "pending",
      external: (attemptId, stepKey) => external.get(`${attemptId}\u0000${stepKey}`) ?? null,
    };
  }

  #stepRecords(attemptId: string): readonly TransitionRecord[] {
    return this.#records.flatMap((record) =>
      record.kind === "step" && record.record.attemptId === attemptId ? [record.record] : [],
    );
  }
}

const tailAttemptId = (record: LedgerRecord): string =>
  record.kind === "step" ? record.record.attemptId : record.attemptId;

const deepFreezeRecord = (record: LedgerRecord): LedgerRecord => {
  if (record.kind === "step") {
    return Object.freeze({
      ...record,
      record: Object.freeze({
        ...record.record,
        guards: Object.freeze(record.record.guards.map((guard) => Object.freeze({ ...guard }))),
        attribution: Object.freeze({ ...record.record.attribution }),
      }),
    });
  }
  return Object.freeze({
    ...record,
    attribution: Object.freeze({ ...record.attribution }),
    ...(record.kind === "resolution"
      ? { resolution: Object.freeze({ ...record.resolution }) }
      : {}),
  });
};
