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
  /** The declared hook steps (phase 6 contract §2.1): execution-side data
   * read by the scheduler and the resume classification — never part of
   * `attemptIdentity` (`attempt_sha256` over `{planId, ordinal}`) and
   * never part of the plan fingerprint. Frozen with the attempt. */
  readonly hooks?: readonly HookStep[];
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

/** One of the canonical eight stages (§2.5) — the closed order's members.
 * Every port that means "one of the canonical stages" names this type. */
export type StageKey = (typeof CANONICAL_STAGES)[number];

/** A hook step's ledger key space (phase 6 contract §2.1; ADR-0007
 * decision 3): `hook:<id>`, unique per attempt, never colliding with a
 * stage key. */
export type HookStepKey = `hook:${string}`;

/** A step key — a canonical stage or a hook step (ADR-0007 decision 3's
 * named extension of the closed eight; phase 7's artifact steps extend the
 * same seam through their own ADR). */
export type StepKey = StageKey | HookStepKey;

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
// §2.5b — hooks as steps (phase 6 contract §2; ADR-0007)
// ---------------------------------------------------------------------------

/** Where a hook sits relative to its anchored stage (§2.1). */
export type HookAnchorPosition = "before" | "after";

/** The proof kinds a hook's completion can be required to carry (§2.4). */
export type PostconditionKind = "content-fingerprint-present" | "evidence-present";

/** A declared hook step (§2.1): pure data — the engine never stores or
 * invents the effect (ADR-0007 decision 2). The `guard` name is recorded
 * verbatim; the postconditions name the recorded proofs the completion
 * must carry before the hook counts as done. */
export interface HookStep {
  /** Non-empty, unique per attempt — the ledger key is `hook:<id>`. */
  readonly id: string;
  /** The anchor: exactly one canonical stage, before or after it. */
  readonly anchor: {
    readonly stage: StageKey;
    readonly position: HookAnchorPosition;
  };
  /** The declared precondition guard name (ADR-0007 decision 4): the
   * kernel's one aggregate held-and-verified check produces its
   * `GuardResult`, recorded verbatim on the start record. */
  readonly guard: string;
  /** The recorded proofs the completion must carry (§2.4). */
  readonly postconditions: readonly PostconditionKind[];
}

/** What a caller-injected effect observed at the seam (§2.3): attribution
 * plus the recorded proofs. There is no plan-shaped field and no mutation
 * port — the refusal is structural (ADR-0007 decision 7). */
export interface HookObservation {
  /** Who produced the observation (§2.6). */
  readonly attribution: Attribution;
  /** The evidence reference, required by an evidence-present postcondition. */
  readonly evidence?: EvidenceRef;
  /** The content fingerprint, required by a fingerprint postcondition. */
  readonly contentFingerprint?: string;
  /** Caller-supplied timestamp: metadata, never ordering (§2.10). */
  readonly recordedAt?: string;
}

/** The seam input (§2.2): identity only — the effect never sees the plan,
 * the attempt value, or the ledger (ADR-0007 decisions 2 and 7). */
export interface HookEffectInput {
  readonly attemptId: string;
  readonly hookId: string;
  /** The anchored stage the hook rides (§2.1). */
  readonly stage: StageKey;
}

/** The caller-injected effect: synchronous, returned to the engine at the
 * seam. The engine invokes it and records what it returns — nothing else
 * (ADR-0007 decision 2). */
export type HookEffect = (input: HookEffectInput) => HookObservation;

/** One hook step's recorded outcome (§2.2): `completed` carries the
 * completion record (the proof lives there); `refused` is the kernel's
 * recorded precondition refusal — no record, exactly a mutating stage's
 * shape; `failed` is the §2.5 escalation — the failed record appended, the
 * attempt blocked. */
export type HookOutcome =
  | {
      readonly kind: "completed";
      readonly stepKey: HookStepKey;
      readonly hookId: string;
      readonly record: TransitionRecord;
      readonly recordedAt?: string;
    }
  | {
      readonly kind: "refused";
      readonly stepKey: HookStepKey;
      readonly hookId: string;
      readonly detail: string;
    }
  | {
      readonly kind: "failed";
      readonly stepKey: HookStepKey;
      readonly hookId: string;
      readonly detail: string;
      readonly record: TransitionRecord;
    };

/** `scheduleHooks`' result: the successor attempt (blocked after a §2.5
 * escalation, otherwise the input) and the outcomes recorded so far — the
 * walk stops at the first refusal or escalation. */
export interface HooksRun {
  readonly attempt: ReleaseAttempt;
  readonly outcomes: readonly HookOutcome[];
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
  readonly stepKey: StageKey;
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

// ---------------------------------------------------------------------------
// §2.1–§2.8 (phase 5 contract) — the ledger's vocabulary (E-01..E-06, E-09)
// ---------------------------------------------------------------------------

/** A step's state as the ledger reports it (§2.1): `none` when nothing is
 * recorded — the plain states are E-02's fields verbatim. */
export type LedgerStepState = "none" | "started" | "completed" | "failed";

/** Why a blocked attempt may resume (§2.7, E-04): a revalidation names the
 * plan fingerprint re-proven under the stored plan; a human resolution
 * records the attributed decision (E-06's `unattributed-state` path). */
export type BlockedResolution =
  | { readonly kind: "revalidation"; readonly planFingerprint: string }
  | { readonly kind: "human"; readonly note: string };

/** The ledger's durable unit (§2.1, §2.2, §2.5, §2.7): append-only,
 * deep-frozen on append, ordered by append position — never by a clock.
 * The plan record is the attempt's first (§2.2's recorded half of the
 * equality proof); step records wrap the kernel's transition record
 * verbatim; absorption records adopt attributed external work
 * (`adopted-from:<sourceAttemptId>`); resolution records close the
 * blocked loop. */
export type LedgerRecord =
  | {
      readonly kind: "plan";
      readonly attemptId: string;
      readonly planFingerprint: string;
      readonly attribution: Attribution;
      readonly recordedAt?: string;
    }
  | { readonly kind: "step"; readonly record: TransitionRecord }
  | {
      readonly kind: "absorption";
      readonly attemptId: string;
      readonly stepKey: StepKey;
      /** The attempt whose recorded work is absorbed, verbatim. */
      readonly adoptedFrom: string;
      readonly evidence: EvidenceRef;
      readonly attribution: Attribution;
      readonly recordedAt?: string;
    }
  | {
      readonly kind: "resolution";
      readonly attemptId: string;
      readonly stepKey: StepKey;
      readonly resolution: BlockedResolution;
      readonly attribution: Attribution;
      readonly recordedAt?: string;
    };

/** The ledger port (§2.1): the durability seam Phases 6–9 bind. Write-ahead
 * at step granularity — a step's start is durable before its effect may
 * run. The persistence binding is the Phase 8 adapter's (fork 16 open). */
export interface ExecutionLedger {
  /** Appends the attempt's plan record (first call) and the step's
   * `started` record — write-ahead (E-02, AR-05). Returns the started
   * transition record. */
  appendStart(
    attempt: ReleaseAttempt,
    stepKey: StepKey,
    attribution: Attribution,
    contentFingerprint?: string,
    /** The hook's declared guard name (phase 6 contract §2.2): recorded
     * verbatim as the one `GuardResult` the aggregate held-and-verified
     * check produced — the check ran before this write-ahead call. */
    guard?: string,
  ): TransitionRecord;
  /** The only other write: append, deep-freeze, keep order. */
  append(record: LedgerRecord): LedgerRecord;
  /** The attempt's records, append order. */
  tail(attemptId: string): readonly LedgerRecord[];
  /** The step-record view the kernel's `requestStep` consumes — the
   * replay projection (§2.3, §2.8). */
  stepView(): StepRecordsView;
  /** The step's recorded state, `none` when nothing is recorded. */
  step(attemptId: string, stepKey: StepKey): LedgerStepState;
  /** The recorded plan fingerprint (§2.2), or null when the attempt has no
   * plan record — a resume refuses without it. */
  planFingerprint(attemptId: string): string | null;
}

/** `verifyEvidence`'s verdict (§2.6, E-03): pure over the recorded and
 * observed fingerprints — both present and equal → verified; different or
 * one-sided where the pair is required → conflict (fail-closed); absent on
 * both sides → unverified. Adoption never runs on conflict or unverified. */
export type EvidenceVerdict =
  | { readonly kind: "verified" }
  | { readonly kind: "conflict"; readonly detail: string }
  | { readonly kind: "unverified" };

/** An adoption decision (§2.5, E-06, AR-05): absorption appends the
 * `adopted-from` record into the adopting ledger; escalation records the
 * observation in the disposition registry and names why. Bare-existence
 * adoption is contract-forbidden — evidence decides, never observation. */
export type AdoptionOutcome =
  | { readonly kind: "adopted"; readonly record: LedgerRecord }
  | { readonly kind: "escalated"; readonly detail: string };

/** A disposition-registry entry (§2.5, E-09): recorded, surfaced, never
 * auto-resolved. What, where, the evidence, who observed; when-as-metadata. */
export interface DispositionEntry {
  /** What was observed — e.g. `orphan-tag`, `stale-draft` (AR-05, AR-06). */
  readonly kind: string;
  /** Where — the external coordinates, opaque and provider-neutral. */
  readonly where: string;
  readonly evidence: EvidenceRef;
  readonly attribution: Attribution;
  readonly recordedAt?: string;
}

/** `resume`'s outcome (§2.3, E-01, E-02, E-05): classification over the
 * recorded tail, never recomputation. */
export type ResumeOutcome =
  | { readonly kind: "resume"; readonly from: StepKey }
  | { readonly kind: "complete"; readonly outcome: "published" | "satisfied-externally" }
  | { readonly kind: "stale"; readonly detail: string }
  | { readonly kind: "escalate"; readonly detail: string };

/** `classifyCrash`'s verdict (§2.4, E-01): the doctrine over the recorded
 * tail plus caller-supplied external observations. The human decision
 * (delete-tag vs repair) enters as a recorded value, never an inference. */
export type CrashVerdict =
  | { readonly kind: "complete-in-place"; readonly from: StepKey }
  | { readonly kind: "resume"; readonly from: StepKey }
  | { readonly kind: "void-and-skip" }
  | { readonly kind: "escalate"; readonly detail: string };
