/**
 * The in-memory transition log (contract §2.6; ADR-0005 decision 8) — the
 * reference shape of the append-only discipline: records are frozen on
 * append, the class exposes no edit or delete, and the read paths
 * (`records`, `completed`, `state`, `external`) are pure projections of the
 * ordered store. Phase 5's ledger owns durability and production; Phase 4
 * fixes the shape, the immutability, and the views `requestStep` consumes.
 */
import {
  type Attribution,
  type EvidenceRef,
  type ExternalSatisfaction,
  type StepKey,
  type StepRecordsView,
  type StepState,
  type TransitionRecord,
} from "./types.js";

/** A keyed external satisfaction: the (attempt, step) it satisfies plus the
 * observation (E-03). Recorded by the caller — Phase 5's ledger verifies
 * the evidence; Phase 4 consumes it as a value. */
export interface KeyedExternalSatisfaction {
  readonly attemptId: string;
  readonly stepKey: StepKey;
  readonly attribution: Attribution;
  readonly evidence: EvidenceRef;
  readonly contentFingerprint?: string;
}

export class MemoryTransitionLog {
  readonly #records: TransitionRecord[] = [];
  readonly #external: Map<string, ExternalSatisfaction> = new Map();

  constructor(seed: { readonly external?: readonly KeyedExternalSatisfaction[] } = {}) {
    for (const item of seed.external ?? []) {
      this.noteExternal(item);
    }
  }

  /** The only write: append, freeze, keep order. Returns the frozen record
   * that is now part of the log. */
  append(record: TransitionRecord): TransitionRecord {
    const frozen = Object.freeze({
      ...record,
      guards: Object.freeze(record.guards.map((guard) => Object.freeze({ ...guard }))),
      attribution: Object.freeze({ ...record.attribution }),
    });
    this.#records.push(frozen);
    return frozen;
  }

  /** All records, append order, read-only. */
  records(): readonly TransitionRecord[] {
    return this.#records;
  }

  /** Records the externally observed satisfaction of a step (E-03).
   * Callers record observations; nothing here verifies them (§2.7 —
   * Phase 4 consumes the observation as a value). */
  noteExternal(satisfaction: KeyedExternalSatisfaction): void {
    const entry: ExternalSatisfaction =
      satisfaction.contentFingerprint === undefined
        ? {
            attribution: satisfaction.attribution,
            evidence: satisfaction.evidence,
          }
        : {
            attribution: satisfaction.attribution,
            evidence: satisfaction.evidence,
            contentFingerprint: satisfaction.contentFingerprint,
          };
    this.#external.set(`${satisfaction.attemptId}\u0000${satisfaction.stepKey}`, entry);
  }

  /** The step record view `requestStep` consumes (§2.7): pure projections
   * over the append-only store. */
  stepView(): StepRecordsView {
    const records = this.#records;
    const external = this.#external;
    return {
      records: (attemptId) => records.filter((record) => record.attemptId === attemptId),
      completed: (attemptId, stepKey) =>
        [...records]
          .reverse()
          .find(
            (record) =>
              record.attemptId === attemptId &&
              record.stepKey === stepKey &&
              record.to === "completed",
          ) ?? null,
      state: (attemptId, stepKey): StepState =>
        [...records]
          .reverse()
          .find((record) => record.attemptId === attemptId && record.stepKey === stepKey)?.to ??
        "pending",
      external: (attemptId, stepKey) => external.get(`${attemptId}\u0000${stepKey}`) ?? null,
    };
  }
}
