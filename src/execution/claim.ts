/**
 * The bounded sequence retry (contract §2.4 item 5; E-08; ADR-0005 decision
 * 4). A denied `prerelease-sequence` acquire may recompute from the winner's
 * recorded sequence — `sequence + 1` from the denial's recorded holder state
 * — and retry, bounded by declared policy (`maxRetries`), after which the
 * run exits with an explicit conflict record ("or an explicit conflict for
 * the second if policy serializes rc runs" — E-08's own alternative,
 * declared-policy-selectable). The naive read-max-then-write is refused by
 * construction: allocation is claim-verify-write, never read-compute-write —
 * the only sequence this door produces comes from a denial's recorded
 * holder state.
 */
import type {
  Claim,
  ClaimDenied,
  ClaimScope,
  SequenceRetryDecision,
  SequenceRetryPolicy,
} from "./types.js";

/**
 * The retry decision (§2.4.5): retry at the winner's `sequence + 1` while
 * the bound holds, else the explicit conflict. A denial without a recorded
 * holder sequence conflicts immediately — there is nothing to recompute
 * from, and inventing a sequence would be the read-compute-write the
 * protocol refuses.
 */
export const retrySequence = (
  denial: ClaimDenied,
  priorRetries: number,
  policy: SequenceRetryPolicy,
): SequenceRetryDecision => {
  if (denial.holderSequence === undefined) {
    return {
      kind: "conflict",
      detail: "denial carries no recorded holder sequence to recompute from",
    };
  }
  if (priorRetries >= policy.maxRetries) {
    return {
      kind: "conflict",
      detail: `sequence retry bound exhausted (${String(priorRetries)} of ${String(policy.maxRetries)}) — explicit conflict per E-08`,
    };
  }
  return { kind: "retry", sequence: denial.holderSequence + 1 };
};

/**
 * The takeover fence's pure clause (§2.4 item 6; ADR-0011 decision 9): the
 * held claims a `prerelease-sequence` acquisition PASSES — another holder's
 * strictly-smaller lease on the same `(lineId, target, streamId)`. The same
 * stream keeps the passed lease inside the family the takeover supersedes;
 * other streams, targets and lines are different allocations a landing
 * never touches; a stable-version claim is a record, not a lease, and no
 * takeover arm applies to it; and a holder never takes over its own lease.
 * The caller records one supersession per passed lease in the same atomic
 * mutation that accepts the new claim.
 */
export const supersededLeases = (
  requested: ClaimScope,
  held: readonly Claim[],
  attemptId: string,
): readonly Claim[] => {
  if (requested.kind !== "prerelease-sequence") return [];
  return held.filter(
    (claim) =>
      claim.holder !== attemptId &&
      claim.scope.kind === "prerelease-sequence" &&
      claim.scope.lineId === requested.lineId &&
      claim.scope.target === requested.target &&
      claim.scope.streamId === requested.streamId &&
      claim.scope.sequence < requested.sequence,
  );
};
