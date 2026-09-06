/**
 * `state.ts` — rebuilds one line's release state from its projected history
 * (§2.13 of docs/design/phase2-planner-contract.md): the released pointer is
 * the line's highest admissible version by kernel precedence — a prerelease
 * may hold it (M-08: main's pointer moves to `2.4.0-rc.1`) — and every
 * stream-composing tag contributes its stream key. The only shape that
 * rebuilds a key is the kernel's own minting shape (`ReleaseLine#streamVersion`
 * composes `${target.toString()}-${identifier}.${sequence}`): a tag
 * `1.2.0-rc.3` is key `(1.2.0, rc)` at sequence 3, the highest sequence per
 * key winning. Invariant 6: state is rebuilt from tags at plan time and never
 * carried across runs; identical histories rebuild identical state (invariant
 * 2 — no clock, environment, randomness, filesystem, or network here).
 */
import { Version } from "@ecoma-io/release-craft/domain";

import type { RebuildLineState, StreamKeyState } from "./types.js";

/** Digits only — the kernel's own test for a numeric prerelease identifier. */
const NUMERIC = /^\d+$/;

/** Per-key accumulator: the bare-core target text, the identifier, and the
 * highest sequence observed for the key so far. Lines carry a handful of
 * streams at most, so lookup stays a scan. */
interface StreamKeyAccumulator {
  readonly core: string;
  readonly identifier: string;
  sequence: number;
}

export const rebuildLineState: RebuildLineState = (history) => {
  let pointer: Version | null = null;
  const keys: StreamKeyAccumulator[] = [];

  for (const tag of history.tags) {
    const version = tag.version;
    // The pointer is monotonic by precedence: strictly-greater replaces, so
    // among precedence-equal versions (build metadata compares as 0) the
    // first in the history's ascending order wins — pinned for determinism.
    if (pointer === null || version.compare(pointer) > 0) {
      pointer = version;
    }
    // A stream key rebuilds only from the kernel's minting shape: the
    // prerelease is exactly [identifier, numeric sequence] (the suffix of
    // `${target.toString()}-${identifier}.${sequence}`). Build identifiers
    // never compose a key of their own and never move the sequence — they
    // compare as 0 — so only the prerelease part is read: `1.2.0-rc.3+build.5`
    // still rebuilds key (1.2.0, rc) at 3. A non-composing suffix (a lone
    // identifier, or a non-numeric tail — e.g. `2.0.0-alpha`) contributes no
    // key either, yet the version
    // still counts for the pointer. KNOWN PHASE-2 LIMIT (reported): such
    // admissible tags surface nowhere else — the frozen LineState carries no
    // foreign field — so their streamlessness is silent at this layer;
    // surfacing them needs a LineState shape revision and is deliberately
    // not fixed here.
    const [identifier, sequenceText] = version.prerelease;
    if (
      version.prerelease.length === 2 &&
      identifier !== undefined &&
      sequenceText !== undefined &&
      NUMERIC.test(sequenceText)
    ) {
      // The key's target is the bare core: composing back through
      // `ReleaseLine#streamVersion` reproduces the observed tag exactly.
      const core = `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
      const known = keys.find(
        (candidate) => candidate.identifier === identifier && candidate.core === core,
      );
      if (known === undefined) {
        keys.push({ core, identifier, sequence: Number(sequenceText) });
      } else {
        // Highest sequence per key wins; the grammar makes equal sequences
        // on one key impossible, so this is deterministic by construction.
        known.sequence = Math.max(known.sequence, Number(sequenceText));
      }
    }
  }

  // Keys sort by target precedence, then identifier ASCII — the order every
  // consumer of LineState may rely on. Identifiers are named, never ordered
  // by precedence (P-06's two streams are siblings under one target), so the
  // tie falls to code-unit order. The bare-core parse cannot throw: the
  // components came from an already-parsed version.
  const streams: StreamKeyState[] = keys.map((accumulated) => ({
    target: Version.parse(accumulated.core),
    identifier: accumulated.identifier,
    sequence: accumulated.sequence,
  }));
  streams.sort((a, b) => {
    const byTarget = a.target.compare(b.target);
    if (byTarget !== 0) {
      return byTarget;
    }
    return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0;
  });
  return { pointer, streams };
};
