# Phase 4 contract — the execution kernel

> **Status: Phase 4 design asset ([#27](https://github.com/ecoma-io/release-craft/issues/27),
> [Phase 4–9 program](https://github.com/ecoma-io/release-craft/issues/13)).**
> This document is the contract the Phase 4 implementation and its suite are
> reviewed against, the role [phase1-contracts.md](phase1-contracts.md) played
> for the kernel and [phase2-planner-contract.md](phase2-planner-contract.md)
> for the planner. It implements the execution half of
> [ADR-0002](../adr/0002-release-model-and-domain-vocabulary.md)'s Model C′
> exactly — attempts, claims, transitions — as the planner's separate consumer
> (ADR-0002 decision 2). Nothing here may add a term outside the locked
> vocabulary and this contract's loudly-declared names
> ([ADR-0005](../adr/0005-execution-kernel.md)), a provider concept, or an
> infrastructure read; each section cites the invariants and scenarios it
> serves. Decisions survive into [ADR-0005](../adr/0005-execution-kernel.md);
> the decision trail lands in the [decision log](decision-log.md) as D20.

## 1. Scope boundaries

Execution consumes plans and never recomputes them (invariant 3's
execution mirror; E-05). Phase 4 ships the execution **domain model and its
pure semantics**: attempt identity and states, claim scopes and the claim
protocol, step identity, the guarded transition contract, outcome
classification, and abort/supersede semantics. It ships **no** persistence
provider (the ledger is Phase 5), **no** effect execution (a runtime that
performs side effects is Phase 5), **no** hook runtime (Phase 6), **no**
artifact graph (Phase 7), **no** Git mechanics (Phase 8), **no** provider
integration (Phase 9). Every one of those phases consumes the identities and
contracts defined here; none may be anticipated by a drive-by field or knob.

Negative outcomes at the execution boundary follow the planner's split:
**contract violations throw** (an invalid transition is a programming error,
like the kernel's `InvalidVersionError`), **runtime classifications are
records** (a lost claim, a conflict, an external satisfaction — E-03/E-07's
outcomes are values, never exceptions).

## 2. The contract items

### 2.1 Attempt identity and the attempt register (E-05)

One execution of one plan is a **release attempt** (canonical vocabulary).
`attemptId` is `attempt_sha256:<hex>` — canonical JSON (recursively
key-sorted) of `{ planId, ordinal }` → SHA-256 — where `ordinal` is the
attempt's 1-based position in the plan's attempt sequence, allocated
atomically by an **attempt register** port (`nextOrdinal(planId)`). The
register is the same class of boundary as the planner's inputs: a store whose
state is explicit, whose allocation is atomic, and whose reference
implementation is an in-memory value. A retry produces a **new** attempt with
a new ordinal over the **same** plan id — "one plan, two attempts" is the
recorded shape (E-05's expected transitions) — and an attempt carries its
`planId` and the plan's fingerprint so the ledger's equality proof
(E-05: "the ledger's plan hash at T2 equals the one at T0") is a comparison
of recorded values, never a recomputation.

### 2.2 The attempt state machine (E-01, E-03, E-07, E-09)

`ReleaseAttempt` carries `{ attemptId, planId, planFingerprint, state,
blockedCause?, terminalReason? }` and moves only through:

```text
planned ──► executing ──► published
                │    └──► satisfied        (satisfied-externally, E-03)
                ├──► failed                (failed, with cause)
                ├──► superseded            (the plan lost to a successor)
                └──► abandoned             (abandoned-by-human, E-09)
executing ──► blocked(cause) ──► executing   (resumed by a recorded resolution)
```

- **Terminal states are exactly** `published`, `satisfied`, `failed`,
  `superseded`, `abandoned` — ADR-0002 decision 1's list ("published, failed,
  superseded, and abandoned-by-human") plus the matrix's own
  `satisfied-externally` completion (E-03: "P: planned →
  completed(external, evidence)"; `satisfied` is that completion as an
  attempt state, carrying its external provenance). Terminal is terminal: no
  transition out exists, and `resume` on a terminal attempt is a contract
  violation (thrown), never a silent revival.
- **`blocked` is suspended, not failed** (E-04's
  `blocked(precondition-delta)`, E-06's `blocked(unattributed-state)`,
  PR-03's `blocked(validation)`): the cause is recorded, nothing is consumed,
  and only a recorded resolution (human attribution for E-06; a closed gap
  for E-04/PR-03) returns the attempt to `executing`. An attempt that dies
  mid-execution without a recorded classification is `failed` with cause
  `unknown` (E-01: "`failed(unknown)`") — classification into recovery paths
  is the ledger's work (Phase 5), and Phase 4 fixes only that the unclassified
  crash state exists as data.
- **Concurrency states are recorded on the attempt** (E-07): the winner
  proceeds `claim → execute → published`; the loser records
  `abandoned` with reason `follower-of:<winnerAttemptId>` — E-07's
  "`abandoned(follower of R1)`" verbatim. The loser's abandonment is
  attributed, never silent.
- `abandoned` and `superseded` never auto-recover (the task list's invariant
  8; E-09: "the abort is honored as authoritative"). An engine that resumes
  either is wrong by construction; the state machine has no such edge.

### 2.3 Claim scopes and the claim store port (E-07, E-08)

A **claim** is atomic ownership, held by exactly one attempt, over one scope:

- `stable-version` — `{ lineId, version }`: the right to mint that release
  version on that line (E-07: "the claim binds (line, next version, attempt
  id)").
- `prerelease-sequence` — `{ lineId, target, streamId, sequence }`: the right
  to mint the next ordinal of that stream (E-08: "atomic per (line, target,
  stream)").
- `release-line` — `{ lineId }`: exclusive execution rights over the whole
  line, for flows that must serialize the line beyond a single version
  (declared policy data; never implied).

A claim carries its **claim token** (E-07: "attempts carry their claim
token") — an opaque, store-allocated, per-scope monotonic value — and its
holder. The **claim store port** is the ownership truth:
`acquire(scope, attemptId) → Claim | ClaimDenied`, `verify(token) → held |
lost`, `release(token)`. The port's reference implementation is an in-memory
value with explicit initial state; the physical primitive that backs it in a
real repository (the tag-push CAS of E-07/E-08) is the Phase 8 adapter's
binding — the fork-13 resolution is the protocol here, the primitive there
([ADR-0005](../adr/0005-execution-kernel.md) decision 4).

Scopes do not overlap silently: `stable-version` and `prerelease-sequence`
claims on one line coexist (a release and an rc stream are different
allocations — E-08's "two prerelease publications" beside a stable run);
`release-line` excludes every other claim on that line while held. Two claims
on the same scope cannot coexist — that sentence is the store's contract, and
its violation is a store bug the tests make unrepresentable.

### 2.4 The claim protocol (E-07, E-08, invariant 11)

1. **Acquire before any mutation** (invariant 11). The first mutating step of
   an attempt (`claim` in the canonical sequence) is the acquisition; a
   mutating step attempted without a held claim is refused as a record, never
   executed (§2.9).
2. **Ownership re-verification before every write** (E-07: "re-verify
   ownership before each write"). Each mutating step's guard re-checks the
   claim token against the store's current state; a lost verification is
   `claim-lost`, the step does not run, and the attempt classifies per
   §2.7 (the loser path).
3. **Deterministic collision adjudication.** An `acquire` on an occupied
   scope is `ClaimDenied` naming the holder — the store's accepted claim
   wins, and the denial is a value carrying the winner's attempt id (E-07:
   "the loser detects the winner and exits without corrupting anything").
   There is no wall-clock tie-break, no arrival-order assumption in the
   domain: the store's atomic accept IS the adjudication, and its reference
   implementation resolves same-tick contentions by explicit initial state,
   so tests are deterministic by construction.
4. **Idempotent re-acquisition.** The same attempt re-acquiring its own held
   scope receives the same claim (a no-op, not a denial, not a second token).
5. **Bounded retry on sequence loss** (E-08). A denied
   `prerelease-sequence` acquire may recompute from the winner's recorded
   sequence (`sequence + 1` from the denial's recorded holder state) and
   retry — bounded by declared policy (`maxRetries`), after which the second
   run exits with an explicit conflict record, "or an explicit conflict for
   the second if policy serializes rc runs" (E-08's own alternative,
   declared-policy-selectable). The naive read-max-then-write is refused by
   construction: allocation is claim-verify-write, never read-compute-write.

### 2.5 Step identity and the canonical stage sequence (invariant 12)

A **step** is identified by `(attemptId, stepKey)`. `stepKey` in Phase 4 is
one of the canonical eight stages — the model-b salvage ADR-0002 already
recorded ("the eight-stage pipeline as the default step sequence of an
attempt"):

```text
plan → claim → prepare → validate → commit → tag → publish → verify
```

`plan` binds the frozen plan (fingerprint recorded, E-05); `claim` acquires
ownership (§2.4); `prepare` and `commit` are workspace-mutating;
`validate` re-proves preconditions (E-04's guard home); `tag` is the
**no-return boundary** (E-01: "the tag-push as the no-return boundary" —
once `tag` completes, supersede can no longer void the attempt, only record
it for reconciliation); `publish` and `verify` are post-tag. The sequence is
closed in Phase 4: hooks (Phase 6) and artifact steps (Phase 7) extend it
through their own ADRs, which must name their insertion rules over this
sequence — no extension syntax is invented here.

### 2.6 Step states and transition records (E-02)

A step moves through `pending → started → completed | failed` — E-02's ledger
fields verbatim ("npm — completed; GitHub Release — started; channels —
pending"). A **transition record** is the durable unit:

```ts
interface TransitionRecord {
  attemptId: string;
  stepKey: string;
  from: StepState;
  to: StepState;
  guards: readonly GuardResult; // what was checked, with results
  claim?: ClaimToken; // the ownership this transition ran under
  attribution: Attribution; // who: attempt + actor (human | automation)
  evidence?: EvidenceRef; // opaque reference; content is Phase 5+
  recordedAt?: string; // caller-supplied timestamp: metadata, never ordering
}
```

Records are append-only; nothing edits one (the ledger's discipline arrives
in Phase 5; Phase 4 fixes the shape and its immutability). `Attribution` is
`{ attemptId, actor }` where `actor` is an opaque non-empty string —
`"automation"` or a human identity — because human actions are attributed
events with precedence over automation (E-09's identity requirements).

### 2.7 Outcomes and classifications (E-02, E-03, E-07)

`requestStep` (the pure transition planner: inputs are the attempt state, the
claim view, the step record view, the requested step) returns one of:

- `advance` — the transition may run; carries the `TransitionRecord` to append.
- `noop` — the step already `completed` with the same identity and content;
  replaying reports prior completion (invariant 12: "replaying a completed
  step reports prior completion as a no-op").
- `satisfied-externally` — the step's intended state already exists,
  attributable, with consistent evidence; the attempt may complete with
  external provenance recorded (E-03: "satisfied-externally: P completes as a
  no-op with external provenance recorded — ledger-first done-ness").
- `conflict` — same identity, different content, or inconsistent evidence
  (E-02: "a conflicting done is distinguishable from a matching done";
  E-03: "tag at a different commit, or partial/inconsistent evidence →
  conflict: refuse and escalate"). Never silently re-planned, never silently
  proceeded.
- `claim-lost` — ownership verification failed; the loser path (§2.4).
- `blocked(cause)` — a guard failed on world-state (precondition delta,
  unattributed external state, stale evidence): suspended, resumable
  (§2.2).
- `refused(detail)` — a protocol violation that is _not_ a programming error
  (mutation without claim, a step on a terminal attempt via the record path).

Content equality for `noop` vs `conflict` is judged over the step's recorded
content fingerprint — the (attempt, step) idempotency key plus the input
digest recorded at `started`. Phase 4 fixes the classification contract and
the fingerprint field's presence; the durable fingerprint mechanics (what
hashes, what canonicalization) are the ledger's (Phase 5), which fills this
field.

### 2.8 Abort and supersede (E-09, E-01, PL-08)

- **Abort** (`abort(attempt, actor, reason)`) moves a non-terminal attempt to
  `abandoned` with the actor recorded. Human is authoritative: no later
  transition, retry, or resume may complete an aborted attempt (E-09's worst
  outcome is unrepresentable — the state machine has no edge out of
  `abandoned`).
- **Supersede** (`supersedePlan(oldPlanId, newPlanId)`) is the execution-side
  half of invariant 5's single recorded relation: every non-terminal attempt
  of the old plan moves to `superseded` **at the next step boundary** —
  in-flight step completions already recorded stand, nothing new starts. The
  `tag` boundary rule (§2.5) is the one exception: an attempt past `tag` does
  not void on supersession — it records the supersession and continues to a
  terminal state, because the externally visible step already happened and
  reconciliation (delete-tag vs complete-in-place) is a recorded human or
  policy decision (E-01's recovery doctrine, Phase 5), never an automatic
  undo. Superseding never deletes, rewrites, or re-tags anything — orphaned
  external state is recorded for the disposition registry Phase 5 owns
  (E-09: "the orphan tag is recorded and surfaced").

### 2.9 No mutation before claim (invariant 11 executable)

The guard table encodes it: every mutating stage (`prepare`, `commit`, `tag`,
`publish`) requires a held, verified claim in its guard list, and `verify`
(the stage that re-proves external state) requires the attempt to have passed
`tag` or `publish`. The refusal is `refused(mutation-without-claim)` — a
record, testable, never a silent execution. This item is invariant 11's
executable home; its stress list (E-07, E-08, M-11) is the test set.

### 2.10 Time discipline (E-05, E-10)

`src/execution/` contains no clock, randomness, environment, filesystem, or
network access. `recordedAt` fields are caller-supplied input values;
ordering derives from structure (step sequence, transition order, store
sequence), never from timestamps ("timestamps are labels allocated at a
defined moment and frozen" — E-10's identity requirements). The isolation
gate (§2.12) enforces the imports; this item is its contract statement.

### 2.11 Layering (ADR-0002 decision 2, invariant 15)

Execution lives in `src/execution/` — the package layer, the planner's
sibling consumer. It imports the kernel only through
`@ecoma-io/release-craft/domain` and the planner only through its public
surface (`../planner/index.js`); it imports no infrastructure. No shape names
provider state: claims scope to line ids, versions, streams; attempts bind to
plan fingerprints; refs, registries, and PRs appear only as opaque evidence
strings supplied by callers (invariant 15's execution half — same posture as
§2.16 of the planner contract). The module boundary rows are unchanged: the
package tag already covers `src/**`, and the kernel stays import-free.

### 2.12 Public surface and the isolation gate

`src/execution/index.ts` is the barrel; `src/index.ts` re-exports it next to
the planner's. The suite grows `test/execution/` with the planner's
three-tier shape: per-mechanism pins (attempt, claim, step, transition,
outcome), the scenario fixtures (§4), and `isolation.test.ts` — the
execution-isolation gate modeled on `test/planner/isolation.test.ts`: no
infrastructure import reaches `src/execution/**`, `node:crypto` allowed only
in the identity module, no ambient global reads. The exit scenarios of the
phase (concurrent attempts, conflicting claims, human abort, superseded plan,
invalid transition, no-mutation-before-claim) are named fixtures with
assertions on records and states, not on internal wiring.

## 3. Invariants made executable

| Invariant (release-model.md §4)                                                | Phase 4 mechanism                                                    |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 1 — trivial path, attempt-and-tag half                                         | the default sequence runs with zero declared lines/channels (§2.5)   |
| 3 — planning without side effects (execution mirror: consume, never recompute) | attempt carries planId + fingerprint; no planner call exists (§2.1)  |
| 5 — plan identity is its fingerprint (execution half)                          | supersede as a recorded relation (§2.8)                              |
| 10 — promotion never fabricates content (record-only groundwork)               | outcome records carry evidence refs; no content is produced (§2.7)   |
| 11 — claim before mutation                                                     | §2.3–§2.4, §2.9 — the phase's core                                   |
| 12 — attempts are the idempotency key                                          | (attempt, step) identity + replay classification (§2.5, §2.7)        |
| 13 — partial failure ledger-recoverable (shape groundwork)                     | `failed(unknown)`, `blocked(cause)`, attribution fields (§2.2, §2.6) |
| 15 — provider isolation                                                        | no provider state in any shape (§2.11)                               |

Invariants 10 and 13 become _fully_ executable in Phases 7 and 5
respectively; Phase 4 makes their identity/attribution skeletons executable.

## 4. Scenario ownership (Phase 4's slice of the matrix)

| Scenario               | Phase 4 owns                                                                         | Remains for later                            |
| ---------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| E-07                   | claim acquisition, deterministic winner/loser, `abandoned(follower-of:…)`            | the physical tag CAS (Phase 8)               |
| E-08                   | sequence-scope claims, claim-verify-write, bounded retry, explicit conflict          | tag-namespace enforcement (Phase 8)          |
| E-09                   | `abandoned` terminal, human attribution, no auto-recovery, supersede at boundary     | orphan registry (Phase 5)                    |
| E-03                   | replay classification: `noop` / `satisfied-externally` / `conflict`                  | evidence verification (Phase 5)              |
| E-05                   | attempt identity per plan ordinal; fingerprint carried, never recomputed             | ledger equality proof (Phase 5)              |
| E-01                   | `failed(unknown)` state; `tag` as no-return boundary in the guard table              | recovery doctrine + classification (Phase 5) |
| E-04                   | `validate` guard shape; `blocked(precondition-delta)` classification                 | revalidation recording (Phase 5)             |
| E-06                   | `blocked(unattributed-state)` + human resolution path (the state machine edges)      | adoption mechanics (Phase 5)                 |
| E-10                   | timestamps as caller-supplied metadata; structural ordering (§2.10)                  | nightly stamps (Phase 7)                     |
| E-11                   | — (planner-owned re-derivation; execution consumes the superseded relation per §2.8) | —                                            |
| AR-01/05/06, PR-01..05 | state shapes consumed (attribution, evidence refs, terminal semantics)               | their phases (7, and 5 for ledgers)          |

`matrix-coverage.md` is updated with the same owners in the contract PR.

## 5. Test obligations

All tests import through `../src/index.ts` only (the external-consumer rule,
ADR-0001 decision 9's shape). The phase's named fixtures:

1. **Concurrent attempts** — two attempts, one scope, one store: exactly one
   grant; the loser records `abandoned(follower-of:winner)`; the winner's
   path completes; nothing else mutated.
2. **Conflicting claims** — same scope re-acquire by a different attempt
   denies naming the holder; coexisting scopes (stable-version + sequence on
   one line) both grant; `release-line` excludes both.
3. **Human abort** — abort by a human actor moves to `abandoned`; every later
   `requestStep` returns `refused`; a retry attempt over the same plan gets a
   fresh ordinal and proceeds (the abort never leaks into the new attempt).
4. **Superseded plan** — supersede moves non-terminal attempts to
   `superseded` at the boundary; an attempt past `tag` records the
   supersession and does not void; nothing is deleted.
5. **Invalid transition** — a step out of sequence (`tag` before `claim`),
   a step on a terminal attempt via the throwing path, a state-machine edge
   that does not exist: each throws the dedicated error naming the contract.
6. **No mutation before claim** — `prepare`/`commit`/`tag` without a held
   claim: `refused(mutation-without-claim)` records; with a lost
   verification: `claim-lost`; the ledger view shows zero mutating records.
7. **Determinism** — identical inputs (attempt states, claim views, step
   views) produce identical decisions; double-run deep-equal; no `Date` in
   the layer (the isolation gate plus a variance probe).
8. **Idempotent re-acquisition and bounded retry** — own-scope re-acquire
   returns the same token; sequence loss retries to `sequence + 1` under
   policy, refuses past the bound with a conflict record.

## 6. Out of scope (and where it stays)

- The durable ledger, fingerprints' canonicalization, resume, adoption,
  recovery doctrine (fork 5), orphan registry — **Phase 5**.
- Hooks, the lifecycle graph, hook scheduling and reconciliation — **Phase 6**.
- Artifact generations' execution semantics, publish recovery, promotion —
  **Phase 7**.
- Git mechanics and the tag-CAS binding of the claim store — **Phase 8**.
- Provider integration and the release-PR carrier — **Phase 9**.
- Any persistence of decision records or ledgers — stays adjacent to the
  execution layer, outside `core/domain/` (fork 16's fixed constraint),
  landing with Phase 5's writer.
