import { describe, expect, it } from "vitest";

import { type Claim, type ClaimDenied, MemoryClaimStore, retrySequence } from "../../src/index.js";

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
