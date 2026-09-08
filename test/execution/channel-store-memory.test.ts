import { describe, expect, it } from "vitest";

import {
  type ChannelApplyOutcome,
  type ChannelMove,
  type ChannelState,
  MemoryChannelStore,
  channelStateFingerprint,
} from "../../src/index.js";

/**
 * The in-memory channel store (ADR-0012 decision 6's reference
 * implementation): the CAS semantics table the port promises — applied,
 * noop, conflict, ambiguous — with the fingerprints over the observed
 * prior state, the total read (an unrecorded channel is the hidden
 * channel, S-02), and the one-shot injected fault that pins decision 7's
 * fail-closed law deterministically.
 */

const pointed = (version: string, line = "1.x"): ChannelState["target"] => ({
  line,
  version,
});

const move = (from: ChannelState["target"], to: ChannelState["target"]): ChannelMove => ({
  channelId: "stable",
  from,
  to,
});

const asOutcome = (outcome: ChannelApplyOutcome, kind: ChannelApplyOutcome["kind"]) => {
  expect(outcome.kind).toBe(kind);
  return outcome;
};

describe("the in-memory channel store (ADR-0012 decision 6)", () => {
  it("a channel the store holds no record of reads as the hidden channel", () => {
    const store = new MemoryChannelStore();
    expect(store.read("stable")).toEqual({ id: "stable", target: null });
    expect(store.list()).toEqual([]);
  });

  it("list enumerates exactly the seeded channels, in seed order", () => {
    const store = new MemoryChannelStore({
      channels: [
        { id: "stable", target: pointed("1.2.0") },
        { id: "next", target: null },
      ],
    });
    expect(store.list().map((channel) => channel.id)).toEqual(["stable", "next"]);
  });

  it("a move out of the hidden state applies and the pointer stands", () => {
    const store = new MemoryChannelStore();
    const outcome = store.applyTransition(move(null, pointed("1.2.0")));
    expect(outcome.kind).toBe("applied");
    expect(store.read("stable").target).toEqual(pointed("1.2.0"));
  });

  it("a move whose observed prior matches applies, and the fingerprint is over that prior", () => {
    const prior: ChannelState = { id: "stable", target: pointed("1.1.0") };
    const store = new MemoryChannelStore({ channels: [prior] });
    const outcome = store.applyTransition(move(prior.target, pointed("1.2.0")));
    expect(outcome).toEqual({
      kind: "applied",
      contentFingerprint: channelStateFingerprint(prior),
    });
    expect(store.read("stable").target).toEqual(pointed("1.2.0"));
  });

  it("a replay of a landed move is noop, never a second move", () => {
    const store = new MemoryChannelStore();
    store.applyTransition(move(null, pointed("1.2.0")));
    const standing: ChannelState = { id: "stable", target: pointed("1.2.0") };
    expect(store.applyTransition(move(null, pointed("1.2.0")))).toEqual({
      kind: "noop",
      contentFingerprint: channelStateFingerprint(standing),
    });
    expect(store.read("stable").target).toEqual(pointed("1.2.0"));
  });

  it("a move whose observed prior diverged conflicts, naming the observed target", () => {
    const observed: ChannelState = { id: "stable", target: pointed("2.0.0") };
    const store = new MemoryChannelStore({ channels: [observed] });
    expect(store.applyTransition(move(pointed("1.1.0"), pointed("1.2.0")))).toEqual({
      kind: "conflict",
      contentFingerprint: channelStateFingerprint(observed),
      observed: pointed("2.0.0"),
    });
    // The diverged pointer stands untouched.
    expect(store.read("stable").target).toEqual(pointed("2.0.0"));
  });

  it("hiding is to:null, and a rollback out of the hidden state is the same move shape", () => {
    const store = new MemoryChannelStore({
      channels: [{ id: "stable", target: pointed("1.2.0") }],
    });
    expect(store.applyTransition(move(pointed("1.2.0"), null)).kind).toBe("applied");
    expect(store.read("stable").target).toBeNull();
    // A rollback re-lands the prior target through `from: null` — the same
    // first-class hidden state a channel starts in (PR-05).
    expect(store.applyTransition(move(null, pointed("1.2.0"))).kind).toBe("applied");
    expect(store.read("stable").target).toEqual(pointed("1.2.0"));
  });

  it("the injected fault reports ambiguous, moves nothing, and fires once", () => {
    const store = new MemoryChannelStore({ ambiguousNext: "transport lost mid-write" });
    const outcome = store.applyTransition(move(null, pointed("1.2.0")));
    expect(outcome).toEqual({ kind: "ambiguous", detail: "transport lost mid-write" });
    // The store did not claim the move: nothing landed, and the same move
    // applies cleanly afterwards — the resume converging (ADR-0012
    // decision 7's fail-closed law, then the clean retry).
    expect(store.read("stable").target).toBeNull();
    asOutcome(store.applyTransition(move(null, pointed("1.2.0"))), "applied");
    expect(store.read("stable").target).toEqual(pointed("1.2.0"));
  });

  it("equal observed states fingerprint identically; the hidden sentinel differs from a pointed one", () => {
    const hidden = channelStateFingerprint({ id: "stable", target: null });
    const at = channelStateFingerprint({ id: "stable", target: pointed("1.2.0") });
    expect(hidden).not.toBe(at);
    expect(channelStateFingerprint({ id: "stable", target: null })).toBe(hidden);
    expect(channelStateFingerprint({ id: "other", target: null })).not.toBe(hidden);
  });
});
