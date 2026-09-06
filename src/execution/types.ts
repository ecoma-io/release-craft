/**
 * The Phase 4 execution kernel's frozen vocabulary (contract §2,
 * docs/design/phase4-execution-contract.md; ADR-0005). Every name here is
 * locked: state names are quoted from the scenario matrix verbatim (E-01,
 * E-03, E-07, E-08, E-09), scopes and outcomes are closed unions, and the
 * two ports (attempt register, claim store) are the seams Phases 5–9 bind.
 * Nothing here names a provider, a ledger implementation, or an
 * infrastructure read (invariant 15; §2.11) — refs and evidence are opaque
 * caller-supplied strings, timestamps are caller-supplied metadata (§2.10).
 *
 * Negative outcomes are records, never exceptions (§1, the planner's split):
 * contract violations — impossible edges, terminal attempts on the throwing
 * path, out-of-sequence stages — throw from the doors that demand
 * advancement; everything a race or the world can cause classifies as a
 * value here.
 */

// ---------------------------------------------------------------------------
// §2.1 — attempt identity and the attempt register port (E-05)
// ---------------------------------------------------------------------------

/** The attempt register port (§2.1): allocates an attempt's 1-based ordinal
 * in its plan's attempt sequence, atomically. A retry is a new attempt over
 * the same plan id — "one plan, two attempts" is E-05's recorded shape. The
 * reference implementation is an in-memory value with explicit initial
 * state (attempt-register-memory.ts); the durable register is Phase 5's. */
export interface AttemptRegister {
  nextOrdinal(planId: string): number;
}

/** A release attempt (§2.2): one execution of one plan. `planFingerprint`
 * is carried, never recomputed (invariant 3's execution mirror) — the
 * ledger's equality proof (E-05) compares recorded values. `blockedCause`
 * is recorded verbatim when `state` is `blocked`; `terminalReason` records
 * why the attempt ended (`unknown` for the unclassified crash, E-01;
 * `follower-of:<attemptId>` for the race loser, E-07; the abort reason,
 * E-09). Frozen: an attempt value never mutates — transitions build the
 * successor. */
export interface ReleaseAttempt {
  readonly attemptId: string;
  readonly planId: string;
  readonly planFingerprint: string;
  readonly state: AttemptState;
  readonly blockedCause?: string;
  readonly terminalReason?: string;
}

// ---------------------------------------------------------------------------
// §2.2 — the attempt state machine (E-01, E-03, E-07, E-09)
// ---------------------------------------------------------------------------

/** The attempt's state. The five terminal states are ADR-0002 decision 1's
 * list plus the matrix's own `satisfied-externally` completion (E-03), the
 * name taken verbatim — no abbreviated `satisfied` is invented. `blocked`
 * is suspended, not failed (E-04, E-06, PR-03). */
export type AttemptState =
  | "planned"
  | "executing"
  | "blocked"
  | "published"
  | "satisfied-externally"
  | "failed"
  | "superseded"
  | "abandoned";

/** The terminal states, exactly (§2.2). Terminal is terminal: no transition
 * out exists, and `resume` on a terminal attempt throws. */
export const TERMINAL_ATTEMPT_STATES: readonly AttemptState[] = [
  "published",
  "satisfied-externally",
  "failed",
  "superseded",
  "abandoned",
];

/** True when the state is terminal. */
export const isTerminalAttempt = (state: AttemptState): boolean =>
  TERMINAL_ATTEMPT_STATES.includes(state);

// ---------------------------------------------------------------------------
// §2.3 — claim scopes, tokens, and the claim store port (E-07, E-08)
// ---------------------------------------------------------------------------

/** An opaque, store-allocated, per-scope monotonic claim token (E-07:
 * "attempts carry their claim token"). Opaque to holders; its allocation
 * and meaning are the store's. */
export type ClaimToken = string;

/** The closed set of claim scopes (ADR-0005 decision 5), each atomic to one
 * attempt. Line ids, versions, targets, and stream ids are caller-supplied
 * projections of the frozen plan — provider-neutral strings (§2.11). */
export type ClaimScope =
  | {
      /** The right to mint that release version on that line (E-07). */
      readonly kind: "stable-version";
      readonly lineId: string;
      readonly version: string;
    }
  | {
      /** The right to mint the next ordinal of that stream (E-08). */
      readonly kind: "prerelease-sequence";
      readonly lineId: string;
      readonly target: string;
      readonly streamId: string;
      readonly sequence: number;
    }
  | {
      /** Exclusive execution rights over the whole line — declared policy
       * data, never implied (§2.3). */
      readonly kind: "release-line";
      readonly lineId: string;
    };

/** A held claim: one scope, one token, one holder. */
export interface Claim {
  /** Discriminant — a held claim. */
  readonly kind: "claim";
  readonly scope: ClaimScope;
  readonly token: ClaimToken;
  /** The holder's attempt id. */
  readonly holder: string;
}

/** A denial (§2.4): the store's accepted claim wins, and the denial names
 * the holder — the loser detects the winner and exits without corrupting
 * anything (E-07). For a denied `prerelease-sequence` scope the denial
 * carries the winner's recorded sequence, the retry base (E-08). */
export interface ClaimDenied {
  /** Discriminant — an acquisition denial. */
  readonly kind: "denied";
  readonly scope: ClaimScope;
  /** The winning attempt id. */
  readonly holder: string;
  /** The winner's recorded sequence, when the denied scope is a
   * `prerelease-sequence`. Omitted otherwise. */
  readonly holderSequence?: number;
}

/** `verify`'s outcome (§2.3): held — with the claim — or lost. A lost
 * verification is `claim-lost`, the loser path (§2.4, §2.7). */
export type ClaimVerification =
  { readonly kind: "held"; readonly claim: Claim } | { readonly kind: "lost" };

/** The claim store port (§2.3) — the ownership truth. Acquire is atomic
 * (the accept IS the collision adjudication, §2.4); same-holder
 * re-acquisition is idempotent; `release-line` excludes every other claim
 * on its line while held. The reference implementation is an in-memory
 * value (claim-store-memory.ts); the physical primitive (the tag-push CAS)
 * is the Phase 8 adapter's binding — fork 13's unresolved half. */
export interface ClaimStore {
  acquire(scope: ClaimScope, attemptId: string): Claim | ClaimDenied;
  verify(token: ClaimToken): ClaimVerification;
  release(token: ClaimToken): void;
}

/** The claim view `requestStep` consumes (§2.7): the attempt's held claim
 * plus the store's current-state verification — the guard re-checks the
 * token before every write (E-07's discipline). Injected; never ambient. */
export interface ClaimView {
  /** The attempt's held claim, when one is held. */
  readonly held: Claim | null;
  /** Re-verifies a token against the store's current state. */
  readonly verify: (token: ClaimToken) => boolean;
}

// ---------------------------------------------------------------------------
// §2.5 — step identity and the canonical stage sequence (invariant 12)
// ---------------------------------------------------------------------------

/** The canonical eight stages (§2.5) — the model-b salvage ADR-0002
 * recorded as the default step sequence of an attempt. Closed in Phase 4:
 * hooks (Phase 6) and artifact steps (Phase 7) extend it through their own
 * ADRs, which must name their insertion rules. */
export const CANONICAL_STAGES: readonly [
  "plan",
  "claim",
  "prepare",
  "validate",
  "commit",
  "tag",
  "publish",
  "verify",
] = ["plan", "claim", "prepare", "validate", "commit", "tag", "publish", "verify"];

/** A step key in Phase 4 — one of the canonical eight (§2.5). */
export type StepKey = (typeof CANONICAL_STAGES)[number];

/** A step's state (§2.6) — E-02's ledger fields verbatim ("npm —
 * completed; GitHub Release — started; channels — pending"). */
export type StepState = "pending" | "started" | "completed" | "failed";

// ---------------------------------------------------------------------------
// §2.6 — transition records (E-02)
// ---------------------------------------------------------------------------

/** Who performed a recorded action (§2.6): the attempt plus an opaque
 * non-empty actor — `"automation"` or a human identity. Human actions are
 * attributed events with precedence over automation (E-09). */
export interface Attribution {
  readonly attemptId: string;
  readonly actor: string;
}

/** What a guard checked, with its result (§2.6). */
export interface GuardResult {
  readonly guard: string;
  readonly passed: boolean;
  readonly detail?: string;
}

/** An opaque evidence reference (§2.6): content is Phase 5+; execution
 * carries only the caller-supplied string (invariant 15). */
export type EvidenceRef = string;

/** The durable unit (§2.6): append-only; nothing edits one — the ledger's
 * discipline arrives in Phase 5, Phase 4 fixes the shape and its
 * immutability. `recordedAt` is caller-supplied metadata, never ordering
 * (§2.10). `contentFingerprint` is §2.7's field-presence mandate: the
 * (attempt, step) idempotency key plus the input digest recorded at
 * `started`, whose canonicalization mechanics are the ledger's (Phase 5)
 * to fill. */
export interface TransitionRecord {
  readonly attemptId: string;
  readonly stepKey: StepKey;
  readonly from: StepState;
  readonly to: StepState;
  /** What was checked, with results. */
  readonly guards: readonly GuardResult[];
  /** The ownership this transition ran under, when it mutated. */
  readonly claim?: ClaimToken;
  /** Who: attempt + actor. */
  readonly attribution: Attribution;
  /** Opaque reference; content is Phase 5+. */
  readonly evidence?: EvidenceRef;
  /** Caller-supplied timestamp: metadata, never ordering. */
  readonly recordedAt?: string;
  /** The input digest recorded at `started` (§2.7); Phase 5 fills it. */
  readonly contentFingerprint?: string;
}

// ---------------------------------------------------------------------------
// §2.7 — the replay views and the seven outcomes (E-02, E-03, E-07)
// ---------------------------------------------------------------------------

/** The step record view `requestStep` consumes: a read-only projection of
 * the append-only record store. Injected; never ambient. */
export interface StepRecordsView {
  /** The attempt's recorded step transitions, in append order. */
  readonly records: (attemptId: string) => readonly TransitionRecord[];
  /** The step's completion record, when the step completed. */
  readonly completed: (attemptId: string, stepKey: StepKey) => TransitionRecord | null;
  /** The step's current state — the last recorded `to`, else `pending`. */
  readonly state: (attemptId: string, stepKey: StepKey) => StepState;
  /** The step's externally observed satisfaction (E-03): the intended state
   * already exists, attributable, with evidence. Phase 4 consumes the
   * observation as a value; verifying the evidence is the ledger's (Phase
   * 5). Null when nothing external was observed. */
  readonly external: (attemptId: string, stepKey: StepKey) => ExternalSatisfaction | null;
}

/** An externally observed step satisfaction (E-03): attributable, evidenced
 * — ledger-first done-ness. `contentFingerprint` rides the observation when
 * the observer recorded one; consistency is judged over it. */
export interface ExternalSatisfaction {
  readonly attribution: Attribution;
  readonly evidence: EvidenceRef;
  readonly contentFingerprint?: string;
}

/** One precondition observation (E-04, E-06): the executing side re-proved
 * a plan precondition and records what it saw. `holds: false` suspends the
 * attempt — `blocked(cause)` — with the cause recorded verbatim (E-04's
 * `precondition-delta`, E-06's `unattributed-state`, PR-03's `validation`). */
export interface PreconditionObservation {
  /** What was re-proved — the plan's own precondition, verbatim. */
  readonly precondition: string;
  readonly holds: boolean;
  /** The recorded cause when `holds` is false; defaults to E-04's
   * `precondition-delta`. */
  readonly cause?: string;
}

/** A step request (§2.7): the requested stage, who requests it, and the
 * guard inputs the door consumes. All fields are caller-supplied values —
 * no clock, no environment (§2.10). */
export interface StepRequest {
  readonly stepKey: StepKey;
  readonly attribution: Attribution;
  /** The input digest recorded at `started` (§2.7); Phase 5's ledger fills
   * the durable mechanics. Presence here drives `noop` vs `conflict`. */
  readonly contentFingerprint?: string;
  /** Precondition re-proofs — `validate`'s guard input (E-04, E-06). */
  readonly preconditions?: readonly PreconditionObservation[];
  readonly evidence?: EvidenceRef;
  readonly recordedAt?: string;
}

/** `requestStep`'s outcome (§2.7) — exactly seven variants. `advance`
 * carries the record to append; every other variant is a record a human
 * can read, never a silent re-plan, retry, or completion (§1). */
export type RequestStepOutcome =
  | {
      /** The transition may run; append the carried record. */
      readonly kind: "advance";
      readonly record: TransitionRecord;
    }
  | {
      /** The step already completed with the same identity and content
       * (invariant 12): replaying reports prior completion as a no-op. */
      readonly kind: "noop";
      readonly stepKey: StepKey;
    }
  | {
      /** The step's intended state already exists, attributable, with
       * consistent evidence — E-03's ledger-first done-ness. */
      readonly kind: "satisfied-externally";
      readonly stepKey: StepKey;
    }
  | {
      /** Same identity, different content, or inconsistent evidence (E-02,
       * E-03): refuse and escalate. Never silently re-planned. */
      readonly kind: "conflict";
      readonly stepKey: StepKey;
      readonly detail: string;
    }
  | {
      /** Ownership verification failed — the loser path (§2.4). */
      readonly kind: "claim-lost";
      readonly stepKey: StepKey;
      readonly detail: string;
    }
  | {
      /** A guard failed on world-state: suspended, resumable (§2.2). */
      readonly kind: "blocked";
      readonly stepKey: StepKey;
      readonly cause: string;
    }
  | {
      /** A protocol violation that is not a programming error (§2.7,
       * §2.9): recorded, testable, never silently executed. */
      readonly kind: "refused";
      readonly stepKey: StepKey;
      readonly detail: string;
    };

// ---------------------------------------------------------------------------
// §2.4 — bounded sequence retry policy (E-08)
// ---------------------------------------------------------------------------

/** Declared retry policy (E-08): a denied `prerelease-sequence` acquire
 * recomputes from the winner's recorded sequence and retries, bounded by
 * `maxRetries`, after which the run exits with an explicit conflict. */
export interface SequenceRetryPolicy {
  readonly maxRetries: number;
}

/** The retry decision (§2.4.5): retry at the winner's `sequence + 1`, or
 * the explicit conflict record. */
export type SequenceRetryDecision =
  | { readonly kind: "retry"; readonly sequence: number }
  | { readonly kind: "conflict"; readonly detail: string };
