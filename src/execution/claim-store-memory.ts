/**
 * The in-memory claim store (contract §2.3's reference implementation;
 * ADR-0005 decision 5). An atomic, deterministic value: acquire is atomic
 * under single-threaded execution and resolves same-tick contentions by
 * explicit initial state — the constructor seeds held claims and the token
 * counter, so a test pins the winner without depending on interleaving.
 * The physical primitive it abstracts (the tag-push CAS) is the Phase 8
 * adapter's binding; this class is the ownership truth the kernel and the
 * suite consume. The takeover fence (§2.4 item 6; ADR-0011 decision 9)
 * rides the same atomic accept: an acquisition past a standing prerelease
 * lease records one supersession naming both sides, and every verdict
 * consults the records — the fence is the record, never a liveness guess.
 */
import { canonicalJson } from "@ecoma-io/release-craft/planner";
import { supersededLeases } from "./claim.js";
import {
  type Claim,
  type ClaimDenied,
  type ClaimScope,
  type ClaimStore,
  type ClaimToken,
  type ClaimVerification,
  type ClaimView,
  type SupersessionRecord,
} from "./types.js";

/** Explicit initial state (§2.4: "resolves same-tick contentions by
 * explicit initial state"): held claims to seed, the first token number
 * to allocate, and recorded supersessions to seed. Omitted fields start
 * empty at `claim:1`. */
export interface MemoryClaimStoreSeed {
  readonly tokenCounter?: number;
  readonly claims?: readonly Claim[];
  readonly supersessions?: readonly SupersessionRecord[];
}

export class MemoryClaimStore implements ClaimStore {
  readonly #held: Map<string, Claim>;
  readonly #supersessions: Map<string, SupersessionRecord>;
  #nextToken: number;

  constructor(seed: MemoryClaimStoreSeed = {}) {
    this.#held = new Map((seed.claims ?? []).map((claim) => [canonicalJson(claim.scope), claim]));
    this.#supersessions = new Map(
      (seed.supersessions ?? []).map((record) => [canonicalJson(record.superseded.scope), record]),
    );
    this.#nextToken = seed.tokenCounter ?? 1;
  }

  acquire(scope: ClaimScope, attemptId: string): Claim | ClaimDenied {
    // The scope's map key is the canonical JSON of the scope — recursively
    // key-sorted, so `{ lineId, kind, version }` and `{ kind, lineId,
    // version }` are one key.
    const key = canonicalJson(scope);
    const existing = this.#held.get(key);
    if (existing !== undefined) {
      // Same scope, same holder: idempotent re-acquisition (§2.4) — unless
      // a takeover has passed this holder's lease (§2.4 item 6): the
      // record stands, the store never re-arms a passed lease, and the
      // re-acquisition denies naming the taker with the closed refusal
      // marker. A refusal carries no holderSequence — a refused holder
      // does not re-enter the race its taker won.
      if (existing.holder === attemptId) {
        const passed = this.#supersessions.get(key);
        if (passed !== undefined) {
          return {
            kind: "denied",
            holder: passed.supersededBy.holder,
            scope,
            refusal: "superseded",
          };
        }
        return existing;
      }
      // Same scope, different holder: the accepted claim wins; the denial
      // names the holder (E-07) and carries the winner's sequence for a
      // prerelease-sequence scope — the retry base (E-08).
      const holderSequence =
        existing.scope.kind === "prerelease-sequence" ? existing.scope.sequence : undefined;
      const denial: ClaimDenied = { kind: "denied", holder: existing.holder, scope };
      return holderSequence === undefined ? denial : { ...denial, holderSequence };
    }
    // release-line excludes every other claim on its line (§2.3); the
    // narrower scopes yield to a held release-line on the same line.
    for (const held of this.#held.values()) {
      if (MemoryClaimStore.#excludedBy(scope, held.scope)) {
        return { kind: "denied", holder: held.holder, scope };
      }
    }
    const claim: Claim = {
      kind: "claim",
      scope,
      token: this.#allocateToken(),
      holder: attemptId,
    };
    // One atomic accept: the claim and every supersession its landing
    // performs (§2.4 item 6) — the pure clause picks the passed leases,
    // and the store records each beside the claim it grants. A later
    // takeover re-lands the record naming the latest taker.
    const passedLeases = supersededLeases(scope, [...this.#held.values()], attemptId);
    this.#held.set(key, claim);
    for (const lease of passedLeases) {
      this.#supersessions.set(canonicalJson(lease.scope), {
        superseded: lease,
        supersededBy: claim,
      });
    }
    return claim;
  }

  verify(token: ClaimToken): ClaimVerification {
    for (const [key, claim] of this.#held) {
      if (claim.token === token) {
        // The store consults its supersession records in every verdict:
        // a token whose lease a takeover has passed verifies superseded,
        // naming the taker (§2.4 item 6) — never held.
        const passed = this.#supersessions.get(key);
        if (passed !== undefined) {
          return { kind: "superseded", supersededBy: passed.supersededBy };
        }
        return { kind: "held", claim };
      }
    }
    // Evidence survives release: a released lease's claim left the held
    // set, but its supersession record stands.
    for (const record of this.#supersessions.values()) {
      if (record.superseded.token === token) {
        return { kind: "superseded", supersededBy: record.supersededBy };
      }
    }
    return { kind: "lost" };
  }

  release(token: ClaimToken): void {
    // A stable-version claim is a record, not a lease (ADR-0009 decision 4,
    // the Phase 8 contract §2.3's rule for the port — D33): releasing its
    // token is a no-op and a later verify still reads held — the release
    // record stands. The non-tag claims are leases: the held value leaves.
    for (const [key, claim] of this.#held) {
      if (claim.token === token && claim.scope.kind !== "stable-version") {
        this.#held.delete(key);
      }
    }
  }

  /** The exclusion law (§2.3): a `release-line` claim excludes every other
   * claim on its line — including another `release-line` on it; a narrower
   * scope is excluded by a held `release-line` on the same line and coexists
   * with every other narrower scope (stable-version and prerelease-sequence
   * are disjoint keys and declared coexistent). */
  static #excludedBy(requested: ClaimScope, held: ClaimScope): boolean {
    if (held.kind === "release-line" || requested.kind === "release-line") {
      return requested.lineId === held.lineId;
    }
    return false;
  }

  #allocateToken(): ClaimToken {
    const token = `claim:${String(this.#nextToken)}`;
    this.#nextToken += 1;
    return token;
  }

  /** The claim view an attempt's `requestStep` calls consume (§2.7): the
   * attempt's held claim plus the store's current-state verification — the
   * guard re-checks the token before every write (E-07). A superseded
   * verification is not held, so the kernel's boolean view reports the
   * loss and the boundary classifies it (phase 11 §2.7). */
  viewFor(attemptId: string): ClaimView {
    const held = [...this.#held.values()].find((claim) => claim.holder === attemptId) ?? null;
    return {
      held,
      verify: (token: ClaimToken): boolean => {
        const verification = this.verify(token);
        return verification.kind === "held" && verification.claim.holder === attemptId;
      },
    };
  }
}
