# Phase 5 contract — the execution ledger

Status: locked by [ADR-0006](../adr/0006-execution-ledger.md) (issue #30).
Implements the deferred obligations of
[ADR-0005](../adr/0005-execution-kernel.md) and the phase 4 contract's
§2.6–§2.8, §2.10.

## 1. Scope

Phase 5 lands the ledger's port, its in-memory reference store, and the
pure semantics that consume it: resume classification, the plan-equality
proof, crash classification, attribution-gated adoption, the disposition
registry, evidence verification, fingerprint canonicalization, and the
revalidation record. It ships **no** persistence binding (fork 16 stays
open; the physical primitive is Phase 8's), **no** effect execution (no
runtime performs side effects), **no** hooks (Phase 6), **no** artifact
state machines (Phase 7), **no** Git or provider mechanics (Phase 8/9).
Every later phase consumes the identities, records, and classifications
defined here; none may be anticipated by a drive-by field or knob.

## 2. Shapes

### 2.1 The ledger port

```text
ExecutionLedger
  appendStart(attempt, stepKey, attribution, fingerprint): StartRecord
    // write-ahead: durable before the step's effect may run (§1)
  append(record: LedgerRecord): LedgerRecord   // the only other write
  tail(attemptId): readonly LedgerRecord       // append order
  step(attemptId, stepKey): LedgerStepView     // started/completed/failed/none
  planFingerprint(attemptId): string | null    // decision 4's recorded half
```

Records are append-only and deep-frozen on append — the discipline Phase 4
fixed for transition records (§2.6 there) carried to the durable store.
Nothing edits, reorders, or deletes; the projections are pure functions of
the append order. The reference implementation is `MemoryLedger`; the port
is all later phases see.

### 2.2 The plan fingerprint record

The attempt's first ledger record carries `planFingerprint` (the value the
attempt already holds — carried, never recomputed, E-05). It is the
recorded half of the equality proof; resume refuses without it.

### 2.3 Resume classification

`resume(attempt, ledger, claims, steps)` returns exactly one of:

- `resume(from: stepKey)` — the recorded tail classifies clean; continue
  at the first stage not completed.
- `complete` — every stage completed; the attempt's terminal outcome
  follows the recorded steps (`published` or `satisfied-externally`).
- `stale` — the attempt's carried `planFingerprint` differs from the
  recorded one (decision 4): refuse, record, re-plan through the planner's
  door (PL-08, E-11); never continue.
- `escalate(detail)` — the tail is contradictory (a completed stage with
  no start, a failed stage under a held claim whose token no longer
  verifies, a terminal record after a non-terminal one): recorded state
  a human must judge; nothing auto-recovers.

Classification is pure: identical tails classify identically (the
kill-anywhere suite proves it by double-run).

### 2.4 Crash classification (E-01)

A `failed(unknown)` attempt classifies from its recorded tail plus the
caller-supplied external observations (`noteExternal` values, §2.7 of the
phase 4 contract):

- tag recorded + plan valid → `complete-in-place` (resume semantics with
  the tag stage already satisfied; the remaining stages finish).
- tag recorded + plan invalid → `escalate` — a human decides delete-tag
  vs repair; the decision enters as a recorded resolution consumed as a
  value.
- no tag recorded → `resume` or `void-and-skip` per the tail.

`void-and-skip` is a recorded fallback: the attempt ends `abandoned`, the
observation (if any) lands in the disposition registry, and the line's
next version computes normally. Nothing is deleted by classification.

### 2.5 Adoption and the disposition registry (E-06, E-09, AR-05, AR-06)

`adopt(intoAttempt, observation)` appends an absorption record
(`adopted-from:<sourceAttemptId>`) only when `verifyEvidence` returns
`verified` over the observation's attribution evidence. Otherwise the
observation becomes a disposition-registry entry and the path escalates —
adoption never runs on `unverified` or `conflict`, and bare existence is
never evidence. Registry entries record: what, where, the evidence
reference, who observed, when (metadata). Disposition (adopt, delete-tag,
void) is a recorded human or policy decision; the registry never
auto-resolves.

### 2.6 Evidence verification and fingerprint canonicalization (E-03)

`verifyEvidence(recorded, observed)` is pure: both present and equal →
`verified`; both present and different → `conflict`; one-sided where the
pair is required → `conflict` (fail-closed); absent on both sides →
`unverified`. The content fingerprint is `content_sha256:<hex>` over the
canonical JSON of the step's declared content inputs — the same
`canonicalJson` mechanics as `attemptIdentity`, no clock, no environment.
The ledger fills the field Phase 4 carried as presence-only (ADR-0005
decision 8).

### 2.7 The revalidation record (E-04)

`resolveBlocked(attempt, blockedStep, resolution)` appends a resolution
record and is the only door that re-arms a `blocked(cause)` attempt for
resume. A resolution is either a revalidation (the plan fingerprint
re-proven under the stored plan, actor attributed) or a human resolution
(for `unattributed-state`, naming the adopted attribution). Phase 4's
state machine consumed such records as values; Phase 5 produces them.

### 2.8 The record-path replay door

A step request against a terminal attempt, arriving through the ledger's
classification surface, yields a recorded `refused("terminal")` — the
phase 4 contract §2.7's record-path promise. The kernel's throwing path
(§2.2 there) remains the programming-error door; this one is the durable
replay door Phase 6+ consumes.

## 3. The no-silent-failure law (carried)

Nothing in the ledger silently re-plans, silently retries, silently
adopts, or silently completes. `stale`, `escalate`, `conflict`,
`unverified`, and every disposition entry are recorded, surfaced state a
human can read. The planner's split (contract violations throw; runtime
races classify as records) holds unchanged.

## 4. Test obligations

All tests import through `../src/index.ts` only. The phase's named
fixtures:

1. **Kill-anywhere** — for each stage boundary, a ledger truncated there
   (the crash window) classifies identically under double-run; resume
   completes the attempt; nothing recomputes (E-01, E-02).
2. **Amputated publication** — attempt A's ledger ends mid-sequence; a
   retry B's ledger resumes and the release completes; per-step
   done-vs-conflict over fingerprints holds (E-02).
3. **Stale plan** — the carried fingerprint differs from the recorded one:
   `stale`, recorded; no continuation (E-05, PL-08).
4. **Foreign state** — attributed observation → absorption record; absent,
   partial, or ambiguous evidence → registry entry + escalate; bare
   existence never adopts (E-06, AR-05).
5. **Stale draft overwrite** — the registry preserves pre-overwrite
   observation content; every mutation attributed (AR-06).
6. **Blocked loop** — `resolveBlocked` with a revalidation re-arms the
   attempt; resume proceeds; without a resolution the attempt stays
   blocked (E-04).
7. **Replay door** — a step request against a terminal attempt through
   the ledger surface yields the recorded refusal (§2.8).
8. **Determinism** — identical inputs produce identical classifications;
   double-run deep-equal; no `Date`, `Math.random`, or environment reads
   in the ledger's modules (the isolation gate extends).
