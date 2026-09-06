/**
 * The in-memory attempt register (contract §2.1's reference implementation;
 * ADR-0005 decision 2). Allocates each plan's attempt ordinals atomically —
 * single-threaded execution makes `nextOrdinal` atomic — with explicit
 * initial state so the suite pins ordinals deterministically. The durable
 * register is Phase 5's ledger; this value is the seam's reference shape.
 */
import type { AttemptRegister } from "./types.js";

/** Explicit initial state: plan id → the highest allocated ordinal. */
export interface MemoryAttemptRegisterSeed {
  readonly ordinals?: Readonly<Record<string, number>>;
}

export class MemoryAttemptRegister implements AttemptRegister {
  readonly #ordinals: Map<string, number>;

  constructor(seed: MemoryAttemptRegisterSeed = {}) {
    this.#ordinals = new Map(Object.entries(seed.ordinals ?? {}));
  }

  /** The plan's next 1-based attempt ordinal, allocated atomically. */
  nextOrdinal(planId: string): number {
    const next = (this.#ordinals.get(planId) ?? 0) + 1;
    this.#ordinals.set(planId, next);
    return next;
  }
}
