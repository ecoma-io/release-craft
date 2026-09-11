import { describe, expect, it } from "vitest";

import {
  type Claim,
  type ClaimDenied,
  MemoryClaimStore,
  retrySequence,
  supersededLeases,
} from "../../src/index.js";

const stableVersion = (version: string, lineId = "line-main") =>
  ({ kind: "stable-version", lineId, version }) as const;
const prerelease = (sequence: number, lineId = "line-main") =>
  ({ kind: "prerelease-sequence", lineId, target: "1.3.0-rc", streamId: "rc", sequence }) as const;
const releaseLine = (lineId = "line-main") => ({ kind: "release-line", lineId }) as const;
const asClaim = (outcome: Claim | ClaimDenied): Claim => {
  if (outcome.kind !== "claim") {
    if (outcome.holder === undefined) {
      throw new Error("expected a claim, got a denial without a holder");
    }
    throw new Error(`expected a claim, got a denial by ${outcome.holder}`);
  }
  return outcome;
};
const asDenied = (outcome: Claim | ClaimDenied): ClaimDenied => {
  if (outcome.kind !== "denied") {
    throw new Error("expected a denial");
  }
  return outcome;
};

describe("the claim store", () => {
  it("grants atomic claims with monotonic tokens (E-07)", () => {
    const store = new MemoryClaimStore();
    const first = store.acquire(stableVersion("1.2.0"), "attempt_sha256:a");
    const second = store.acquire(stableVersion("1.3.0"), "attempt_sha256:b");
    expect(first.kind).toBe("claim");
    expect(second.kind).toBe("claim");
    expect(asClaim(first).token).toBe("claim:1");
    expect(asClaim(second).token).toBe("claim:2");
  });

  it("re-acquisition by the same holder is idempotent", () => {
    const store = new MemoryClaimStore();
    const first = store.acquire(stableVersion("1.2.0"), "attempt_sha256:a");
    const again = store.acquire(stableVersion("1.2.0"), "attempt_sha256:a");
    expect(again).toEqual(first);
  });

  it("denies a second acquirer, naming the holder — with the sequence for prerelease (E-07, E-08)", () => {
    const store = new MemoryClaimStore();
    store.acquire(prerelease(3), "attempt_sha256:winner");
    const denied = store.acquire(prerelease(3), "attempt_sha256:loser");
    expect(denied.kind).toBe("denied");
    expect(asDenied(denied).holder).toBe("attempt_sha256:winner");
    expect(asDenied(denied).holderSequence).toBe(3);
  });

  it("coexists stable-version with prerelease-sequence on the same line (§2.3)", () => {
    const store = new MemoryClaimStore();
    const stable = store.acquire(stableVersion("1.2.0"), "attempt_sha256:a");
    const pre = store.acquire(prerelease(1), "attempt_sha256:b");
    expect(stable.kind).toBe("claim");
    expect(pre.kind).toBe("claim");
  });

  it("release-line excludes every other claim on its line, and yields to held claims (§2.3)", () => {
    const store = new MemoryClaimStore();
    const line = store.acquire(releaseLine(), "attempt_sha256:a");
    expect(line.kind).toBe("claim");
    expect(store.acquire(stableVersion("1.2.0"), "attempt_sha256:b").kind).toBe("denied");
    expect(store.acquire(prerelease(1), "attempt_sha256:c").kind).toBe("denied");
    expect(store.acquire(releaseLine(), "attempt_sha256:d").kind).toBe("denied");

    // Declared policy data, never implied: without a held release-line, the
    // narrower scopes coexist — and a release-line acquire on a line with a
    // held narrow claim is denied.
    const other = new MemoryClaimStore();
    other.acquire(stableVersion("1.2.0"), "attempt_sha256:a");
    expect(other.acquire(releaseLine(), "attempt_sha256:b").kind).toBe("denied");
    expect(other.acquire(stableVersion("1.3.0"), "attempt_sha256:c").kind).toBe("claim");
  });

  it("verifies against current state and loses released claims (§2.3)", () => {
    const store = new MemoryClaimStore();
    const claim = store.acquire(prerelease(1), "attempt_sha256:a");
    expect(claim.kind).toBe("claim");
    const token = asClaim(claim).token;
    expect(store.verify(token)).toEqual({ kind: "held", claim: asClaim(claim) });
    expect(store.verify("claim:999").kind).toBe("lost");
    store.release(token);
    expect(store.verify(token).kind).toBe("lost");
  });

  it("keeps a released stable-version claim as its record — a record, not a lease (ADR-0009 decision 4)", () => {
    const store = new MemoryClaimStore();
    const claim = store.acquire(stableVersion("1.2.0"), "attempt_sha256:a");
    const token = asClaim(claim).token;
    store.release(token);
    expect(store.verify(token)).toEqual({ kind: "held", claim: asClaim(claim) });
  });

  it("pins same-tick contention by explicit initial state", () => {
    const winner: Claim = {
      kind: "claim",
      scope: stableVersion("1.2.0"),
      token: "claim:1",
      holder: "attempt_sha256:winner",
    };
    const store = new MemoryClaimStore({ tokenCounter: 2, claims: [winner] });
    const denied = store.acquire(stableVersion("1.2.0"), "attempt_sha256:loser");
    expect(denied.kind).toBe("denied");
    expect(asDenied(denied).holder).toBe("attempt_sha256:winner");
    const granted = store.acquire(stableVersion("1.3.0"), "attempt_sha256:loser");
    expect(asClaim(granted).token).toBe("claim:2");
  });
});

describe("the bounded sequence retry (E-08)", () => {
  const denial = (holderSequence?: number): ClaimDenied =>
    holderSequence === undefined
      ? { kind: "denied", scope: stableVersion("1.2.0"), holder: "attempt_sha256:winner" }
      : {
          kind: "denied",
          scope: prerelease(3),
          holder: "attempt_sha256:winner",
          holderSequence,
        };

  it("recomputes from the winner's recorded sequence, bounded by policy", () => {
    expect(retrySequence(denial(3), 0, { maxRetries: 2 })).toEqual({
      kind: "retry",
      sequence: 4,
    });
    expect(retrySequence(denial(4), 1, { maxRetries: 2 })).toEqual({
      kind: "retry",
      sequence: 5,
    });
  });

  it("exits with an explicit conflict once the bound is exhausted", () => {
    const decision = retrySequence(denial(3), 2, { maxRetries: 2 });
    expect(decision.kind).toBe("conflict");
  });

  it("never invents a sequence a denial does not carry", () => {
    const decision = retrySequence(denial(undefined), 0, { maxRetries: 5 });
    expect(decision.kind).toBe("conflict");
  });
});

describe("the takeover fence (§2.4 item 6; ADR-0011 decision 9)", () => {
  it("supersededLeases passes only another holder's strictly-smaller same-stream lease", () => {
    const mine = {
      kind: "claim",
      scope: prerelease(1),
      token: "claim:1",
      holder: "attempt_sha256:a",
    } as const satisfies Claim;
    const otherLower = {
      kind: "claim",
      scope: prerelease(2),
      token: "claim:2",
      holder: "attempt_sha256:b",
    } as const satisfies Claim;
    // Same stream, strictly smaller, another holder: both passed.
    expect(supersededLeases(prerelease(3), [mine, otherLower], "attempt_sha256:c")).toEqual([
      mine,
      otherLower,
    ]);
    // Sequence 2 past a strictly-smaller seq 1 is still a takeover; the
    // same recorded sequence is the same-scope denial path's business.
    expect(supersededLeases(prerelease(2), [mine, otherLower], "attempt_sha256:c")).toEqual([mine]);
    // A holder never takes over its own lease.
    expect(supersededLeases(prerelease(3), [mine, otherLower], "attempt_sha256:b")).toEqual([mine]);
    // Other streams, targets, and lines never pass.
    const otherStream = {
      kind: "claim",
      scope: {
        kind: "prerelease-sequence",
        lineId: "line-main",
        target: "1.3.0-rc",
        streamId: "beta",
        sequence: 1,
      },
      token: "claim:3",
      holder: "attempt_sha256:b",
    } as const satisfies Claim;
    expect(supersededLeases(prerelease(3), [otherStream], "attempt_sha256:c")).toEqual([]);
    // A stable-version record is not a lease; a stable request passes nothing.
    const stable = {
      kind: "claim",
      scope: stableVersion("1.2.0"),
      token: "claim:4",
      holder: "attempt_sha256:b",
    } as const satisfies Claim;
    expect(supersededLeases(prerelease(3), [stable], "attempt_sha256:c")).toEqual([]);
    expect(supersededLeases(stableVersion("1.3.0"), [stable], "attempt_sha256:c")).toEqual([]);
  });

  it("an acquisition past a standing lease records the supersession, and the passed token verifies superseded naming the taker", () => {
    const store = new MemoryClaimStore();
    const holderClaim = asClaim(store.acquire(prerelease(1), "attempt_sha256:holder"));
    const takerClaim = asClaim(store.acquire(prerelease(2), "attempt_sha256:taker"));
    // The fence verdict names the taker — never held.
    expect(store.verify(holderClaim.token)).toEqual({
      kind: "superseded",
      supersededBy: takerClaim,
    });
    // The taker's own claim verifies held.
    expect(store.verify(takerClaim.token)).toEqual({ kind: "held", claim: takerClaim });
  });

  it("the superseded holder's re-acquisition denies with the refusal marker, no retry base, the taker named", () => {
    const store = new MemoryClaimStore();
    asClaim(store.acquire(prerelease(1), "attempt_sha256:holder"));
    asClaim(store.acquire(prerelease(2), "attempt_sha256:taker"));
    const reAcquired = store.acquire(prerelease(1), "attempt_sha256:holder");
    expect(reAcquired).toEqual({
      kind: "denied",
      holder: "attempt_sha256:taker",
      scope: prerelease(1),
      refusal: "superseded",
    });
    expect(asDenied(reAcquired).holderSequence).toBeUndefined();
  });

  it("the superseded record stands: a third claim on the exact scope is still denied by it (E-07)", () => {
    const store = new MemoryClaimStore();
    asClaim(store.acquire(prerelease(1), "attempt_sha256:holder"));
    asClaim(store.acquire(prerelease(2), "attempt_sha256:taker"));
    const third = store.acquire(prerelease(1), "attempt_sha256:stranger");
    expect(third).toEqual({
      kind: "denied",
      holder: "attempt_sha256:holder",
      scope: prerelease(1),
      holderSequence: 1,
    });
  });

  it("the fence survives release: a released passed lease still verifies superseded", () => {
    const store = new MemoryClaimStore();
    const holderClaim = asClaim(store.acquire(prerelease(1), "attempt_sha256:holder"));
    const takerClaim = asClaim(store.acquire(prerelease(2), "attempt_sha256:taker"));
    store.release(holderClaim.token);
    expect(store.verify(holderClaim.token)).toEqual({
      kind: "superseded",
      supersededBy: takerClaim,
    });
  });

  it("a later takeover re-lands the record naming the latest taker", () => {
    const store = new MemoryClaimStore();
    const first = asClaim(store.acquire(prerelease(1), "attempt_sha256:first"));
    const second = asClaim(store.acquire(prerelease(2), "attempt_sha256:second"));
    const third = asClaim(store.acquire(prerelease(3), "attempt_sha256:third"));
    expect(store.verify(first.token)).toEqual({ kind: "superseded", supersededBy: third });
    expect(store.verify(second.token)).toEqual({ kind: "superseded", supersededBy: third });
  });

  it("a stable-version record takes no takeover arm — the denial law is unchanged", () => {
    const store = new MemoryClaimStore();
    const stable = asClaim(store.acquire(stableVersion("1.2.0"), "attempt_sha256:holder"));
    const stableAgain = asClaim(store.acquire(stableVersion("1.3.0"), "attempt_sha256:taker"));
    expect(store.verify(stable.token)).toEqual({ kind: "held", claim: stable });
    expect(store.verify(stableAgain.token)).toEqual({ kind: "held", claim: stableAgain });
  });

  it("seeds recorded supersessions with the explicit initial state", () => {
    const superseded: Claim = {
      kind: "claim",
      scope: prerelease(1),
      token: "claim:1",
      holder: "attempt_sha256:holder",
    };
    const supersededBy: Claim = {
      kind: "claim",
      scope: prerelease(2),
      token: "claim:2",
      holder: "attempt_sha256:taker",
    };
    const store = new MemoryClaimStore({
      claims: [superseded, supersededBy],
      supersessions: [{ superseded, supersededBy }],
    });
    expect(store.verify(superseded.token)).toEqual({ kind: "superseded", supersededBy });
    expect(store.acquire(prerelease(1), "attempt_sha256:holder")).toEqual({
      kind: "denied",
      holder: "attempt_sha256:taker",
      scope: prerelease(1),
      refusal: "superseded",
    });
  });
});
