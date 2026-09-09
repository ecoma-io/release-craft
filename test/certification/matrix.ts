/**
 * The certification fixture's recorded matrix — phase 14 contract §3.1's
 * walks and interruption-window taxonomy as committed data.
 *
 * This module is the fixture's recorded copy of the contract's taxonomy.
 * The census (`manifest.ts`) checks every manifest row's window claims
 * against THIS list and never against a copy of itself, so a window
 * quietly dropped from the recorded twelve-plus-one is a red suite rather
 * than a certified gap shipping as evidence. Every window's `recordedBy`
 * names the contract that records it; a window not on this list is
 * refused by rule R0.
 */

/** A scenario the phase 10 matrix already owns as data, re-walked here. */
export interface Walk {
  readonly id: string;
  /** The run, in the contract's own words. */
  readonly run: string;
  /** The recorded scenario ancestry the walk re-uses. */
  readonly ancestry: string;
}

/** §3.1's five walks. */
export const WALKS: readonly Walk[] = [
  {
    id: "W1",
    run: "the beta ladder run — `main`, intent `prerelease:beta:main`, mints `5.0.0-beta.1`; a second run mints `.2`",
    ancestry: "the ladder's first two rungs (P-06, §3.2)",
  },
  {
    id: "W2",
    run: "the promote walk — `main`: beta.1, rc.1, then the promote intent mints `5.0.0`; the channels `stable` and `next` move, the promoted-from edge records, the rc stream closes",
    ancestry: "the promote door end to end (P-03, V4, ADR-0012)",
  },
  {
    id: "W3",
    run: "the maintenance cut — `4.8.x` mints `4.8.7` from its own tags",
    ancestry: "P-07's shape; M-02's independence",
  },
  {
    id: "W4",
    run: "the plan-only walk — the `plan` door over the declared world, twice",
    ancestry: "the planner's purity (phase 2 §2.14)",
  },
  {
    id: "W5",
    run: "the deny walk — two attempts demand one scope: a stable-version denial, and a prerelease-sequence denial under a declared retry bound",
    ancestry: "E-07's staging; E-08's bounded retry",
  },
];

export type WalkId = (typeof WALKS)[number]["id"];

/** An interruption window of the recorded taxonomy, cited to the contract
 * that records it. */
export interface Window {
  readonly id: string;
  readonly name: string;
  readonly recordedBy: string;
}

/** §3.1's interruption windows — the recorded taxonomy, thirteen windows.
 * The census coverage and disjointness checks run against this array. */
export const TAXONOMY: readonly Window[] = [
  {
    id: "I1",
    name: "mid-claim denial",
    recordedBy:
      "phase 4 §2.4's deterministic collision adjudication (E-07); the denial names the holder",
  },
  {
    id: "I2",
    name: "sequence-retry denial",
    recordedBy:
      "phase 4 §2.4 item 5 (E-08); `retrySequence` — the bound exhausted conflicts explicitly, a denial with no recorded holder sequence conflicts immediately (D31's parity fold)",
  },
  {
    id: "I3",
    name: "write-ahead crash mid-walk",
    recordedBy:
      "ADR-0006 decision 2's write-ahead discipline; E-01's crash doctrine — the started record is durable, the resume re-runs the step exactly once more (V7)",
  },
  {
    id: "I4",
    name: "post-tag crash",
    recordedBy:
      "phase 4 §2.5's no-return boundary; `classifyCrash`'s complete-in-place (E-01) — tag recorded, plan valid",
  },
  {
    id: "I5",
    name: "post-abort restart",
    recordedBy:
      "ADR-0013 decision 4 — the fresh run refuses quoting the recorded abandonment; the refused run burns one ordinal, recorded",
  },
  {
    id: "I6",
    name: "resume after abort",
    recordedBy:
      "ADR-0013 decision 3 — terminal from the ledger alone, and a later resume of the carried attempt throws the named violation; the fresh process refusing `unknown attempt` first is the attempt store's posture (phase 11 §2.7, phase 12 §2.7)",
  },
  {
    id: "I7",
    name: "staleness",
    recordedBy:
      "phase 5 §2.3's `classifyResume` (E-05) — the carried fingerprint disagrees with the recorded one; `stale`, re-plan",
  },
  {
    id: "I8",
    name: "resolution",
    recordedBy:
      "phase 5 §2.7's blocked loop — `blocked`, then the recorded resolution re-arms, then the resumed outcome matches the uninterrupted run's",
  },
  {
    id: "I9",
    name: "channel ambiguity",
    recordedBy:
      "invariant 2.6; ADR-0012 decision 7 — a store that cannot determine whether a move landed records `ambiguous`, never `completed`; pinned twice (the stop, and the non-success read)",
  },
  {
    id: "I10",
    name: "channel transition",
    recordedBy:
      "ADR-0012 decisions 3–4 — the moves land exactly between the started and completed records; a completed move replays `noop`; a divergent prior target conflicts",
  },
  {
    id: "I11",
    name: "the declared lie",
    recordedBy:
      "phase 12 §2.5 — an unobserved feedRef faults at the planner's range classification (exit 70, nothing executed); phase 12 §2.4 — an unobserved ref head faults at the mint (exit 70, records standing)",
  },
  {
    id: "I12",
    name: "the pre-walk refusal",
    recordedBy:
      "phase 11 §2.5 — the engine's own target refusal on the hand-built-request path (a minting line with no recorded target), `handle: null`, `drives: []`",
  },
  {
    id: "I3ext",
    name: "extension-step crash",
    recordedBy:
      "phase 10 §3.5's resumed hook — the declared hook's effect faults mid-window; the start is durable; the resume runs the effect exactly once more (ADR-0007 decision 6)",
  },
];

export type WindowId = (typeof TAXONOMY)[number]["id"];
