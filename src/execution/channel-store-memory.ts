/**
 * The in-memory channel store (ADR-0012 decision 6's reference
 * implementation). An atomic, deterministic value: the move's read, decide
 * and land are one step under single-threaded execution, and the outcomes
 * the world could otherwise cause are seeded explicitly — held channels
 * through the constructor, and the undeterminable write (the `ambiguous`
 * outcome, ADR-0012 decision 7) through an injectable fault — so a test
 * pins every row of the CAS semantics table without interleaving or
 * transport chaos. The physical primitive it abstracts (the recorded
 * compare-and-set under `refs/release-craft/channels/`) is the Phase 8 adapter's
 * git channel store.
 */

import { channelStateFingerprint } from "./identity.js";
import type { ChannelApplyOutcome, ChannelMove, ChannelState, ChannelStore } from "./types.js";

/** Explicit initial state: the channels the store holds records of, and —
 * for the next `applyTransition` only — the injected undeterminable write
 * whose outcome is `ambiguous` (ADR-0012 decision 7's fail-closed path,
 * pinnable without a failing transport). Omitted fields start empty. */
export interface MemoryChannelStoreSeed {
  readonly channels?: readonly ChannelState[];
  /** When set, the next `applyTransition` (and only that one) returns
   *  `ambiguous` carrying this detail, moving no state. */
  readonly ambiguousNext?: string;
}

/** The fingerprint over an observed channel state is
 * `channelStateFingerprint` (identity.ts) — shared with the git store, so
 * both implementations fingerprint identically. */

export class MemoryChannelStore implements ChannelStore {
  readonly #held: Map<string, ChannelState>;
  #ambiguousNext: string | undefined;

  constructor(seed: MemoryChannelStoreSeed = {}) {
    this.#held = new Map((seed.channels ?? []).map((channel) => [channel.id, channel]));
    this.#ambiguousNext = seed.ambiguousNext;
  }

  read(channelId: string): ChannelState {
    // Total read: a channel with no record reads as the hidden channel
    // (S-02) — the store answers from its own state, never from a plan.
    return this.#held.get(channelId) ?? { id: channelId, target: null };
  }

  list(): readonly ChannelState[] {
    return [...this.#held.values()];
  }

  applyTransition(move: ChannelMove): ChannelApplyOutcome {
    // The injected fault fires before anything else: the store cannot
    // determine whether the move landed, so it reports `ambiguous` and
    // moves nothing (ADR-0012 decision 7 — fail closed).
    if (this.#ambiguousNext !== undefined) {
      const detail = this.#ambiguousNext;
      this.#ambiguousNext = undefined;
      return { kind: "ambiguous", detail };
    }
    const observed = this.read(move.channelId);
    const fingerprint = channelStateFingerprint(observed);
    if (statesEqual(observed.target, move.to)) {
      // The move already stands — the replay outcome (ADR-0012 decision 4:
      // a replay of an already-applied move is `noop`, never a second move).
      return { kind: "noop", contentFingerprint: fingerprint };
    }
    if (!statesEqual(observed.target, move.from)) {
      return { kind: "conflict", contentFingerprint: fingerprint, observed: observed.target };
    }
    const landed: ChannelState = {
      id: move.channelId,
      target: move.to === null ? null : { ...move.to },
    };
    this.#held.set(move.channelId, landed);
    return { kind: "applied", contentFingerprint: fingerprint };
  }
}

/** Target equality by value — line string equality plus the canonical
 * version string. `null` equals `null` only: the hidden state is one
 * state, and a channel the store never recorded is that same state. */
const statesEqual = (left: ChannelState["target"], right: ChannelState["target"]): boolean => {
  if (left === null || right === null) {
    return left === null && right === null;
  }
  return left.line === right.line && left.version === right.version;
};
