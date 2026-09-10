---
id: 0006-execution-ledger
status: proposed
created: 2026-09-06
updated: 2026-09-06
---

# ADR-0006: The execution ledger — durable records, resume as classification, and adoption

## Context

ADR-0005 landed the execution kernel's pure semantics — attempts, claims,
transitions, and the seven-outcome replay classification — and named what it
deliberately did not build: the durable ledger that resumes them (E-02), the
crash classification (E-01), evidence verification (E-03), revalidation
recording (E-04), the plan-equality proof at resume (E-05), adoption
mechanics (E-06), and the disposition registry for orphaned external state
(E-09). Phase 4's contract deferred each by name
([contract](../design/phase4-execution-contract.md) §2.6–§2.8, §2.10;
ADR-0005 Limitations). Phase 5
([#30](https://github.com/ecoma-io/release-craft/issues/30),
[contract](../design/phase5-ledger-contract.md)) lands that durable half.

This ADR exists because the ledger introduces names and a fork resolution —
vocabulary is contract (ADR-0002): every new term enters here, loudly, or it
must not enter code at all. Terms already canonical (execution ledger, claim,
evidence, adoption, attribution — ADR-0002 §4) are used verbatim and are not
re-decided.

## Decision

1. **The ledger lives in `src/execution/` — no new layer.** The ledger is
   execution's durability concept (ADR-0002 §4's vocabulary); a separate
   `src/ledger/` would re-own attempt/step identities the kernel already
   locks. Phase 5 ships an `ExecutionLedger` port plus a reference
   implementation (`MemoryLedger`), mirroring Phase 4's store posture: keyed
   by `(attemptId, stepKey)`, append-only, deep-frozen records, pure
   projections the kernel's `requestStep` already consumes. Fork 16 (where
   ledgers persist) stays open; the persistence binding is the Phase 8
   adapter's, deliberately not chosen here.
2. **The ledger is write-ahead at step granularity.** A step's `started`
   record is durable (appended) before the step's effect may run (E-02,
   AR-05's state requirement): "lost" ledgers shrink to the crash window
   between record and effect, never the reverse. Phase 5 owns the
   discipline as a port contract; the effect runtime that obeys it arrives
   with the adapters.
3. **Resume is classification over the ledger tail, never recomputation**
   (E-01, E-02). `resume(attempt, ledger, claims, steps)` replays the
   recorded tail through the kernel's `requestStep` classification and
   returns one of exactly four outcomes: `resume(from: stepKey)` (continue
   at the first non-completed stage), `complete` (every stage completed —
   the attempt is done), `stale` (the equality proof of decision 4
   failed), or `escalate(detail)` (recorded state is contradictory or
   unjudgeable — a human decides). Classification is a pure function of
   recorded values: identical ledger tails classify identically, provable
   by double-run.
4. **The plan-equality proof (E-05) compares recorded fingerprints.** The
   attempt's first ledger record carries the plan's fingerprint; resume
   compares the attempt's carried `planFingerprint` against the recorded
   one and returns `stale` on mismatch — a stale continuation is refused,
   never silently re-planned or re-executed (PL-08's execution mirror).
   Re-planning is the planner's door (P2 regeneration, E-11); the ledger
   only refuses and records.
5. **Crash classification follows E-01's doctrine, with the human decision
   as a recorded value.** A `failed(unknown)` attempt classifies from its
   recorded tail plus external observations: tag recorded + plan valid →
   `complete-in-place` (finish the remaining stages); tag recorded + plan
   invalid → `escalate` (a human decides delete-tag vs repair — the
   decision enters as a recorded resolution, never inferred); no tag →
   `resume` or `void-and-skip` per the recorded tail. The void-and-skip
   fallback is recorded (the release stays abandoned; the next version
   computes normally); the tag's disposition lands in the registry
   (decision 7).
6. **Adoption is attribution-gated (E-06, AR-05, AR-06); attribution beats
   observation everywhere.** Externally observed state is adopted as
   completed work only when evidence attributes it to an attempt: adoption
   appends an absorption record (`adopted-from:<attemptId>`) into the
   adopting attempt's ledger and never re-executes the step. Evidence that
   is absent, partial, or ambiguous → no adoption: the observation lands in
   the disposition registry and the path escalates. Bare-existence adoption
   is contract-forbidden.
7. **The disposition registry owns orphaned external state (E-09)** as an
   append-only, surfaced collection of recorded observations (what, where,
   the evidence, who observed, when-as-metadata). Nothing in the registry
   auto-resolves: disposition (adopt, delete-tag, void) is a recorded human
   or policy decision, consumed as a value.
8. **Evidence verification is a pure predicate over recorded values**
   (E-03). `verifyEvidence` judges the pair (recorded fingerprint,
   observed fingerprint): both present and equal → `verified`; both
   present and different, or one-sided where both are required →
   `conflict` (fail-closed); absent on both sides → `unverified` (adopted
   nowhere, escalated to the registry). The content-fingerprint
   canonicalization ADR-0005 decision 8 deferred lands here:
   `content_sha256:<hex>` over the canonical JSON of the step's declared
   content inputs — deterministic, no clock or environment reads, the same
   mechanics as `attemptIdentity`.
9. **The blocked loop closes with a revalidation record (E-04).** A
   `blocked(cause)` attempt resumes only over a recorded resolution: a
   revalidation record naming the plan fingerprint re-proven (validate
   re-run under the stored plan), or a human resolution for
   `unattributed-state`. Phase 4 consumed such records as values; Phase 5
   produces the record type and the `resolveBlocked` door that appends it.
10. **The ledger owns the record-path replay door.** A step request
    against a terminal attempt, arriving through the ledger's
    classification surface, yields a recorded `refused` — §2.7's
    record-path promise, in contrast to the kernel's throwing path (§2.2,
    ADR-0005 decision 3). The throw remains the programming-error door;
    the record is the durable replay door Phase 6+ consumes.
11. **The kernel's time and isolation discipline carries.** No clock,
    randomness, environment, filesystem, or network reads in the ledger's
    modules; timestamps enter as caller-supplied metadata; ordering is
    structural. The isolation gate extends to the ledger's files in the
    implementation PR.
12. **The public surface is the barrel.** The ledger exports through
    `src/execution/index.ts`; tests import through `../src/index.ts` only
    (ADR-0001 decision 9's shape, unchanged).

### Amendments this ADR makes (loud, in this PR)

- [matrix-coverage.md](../design/matrix-coverage.md): E-01 (recovery
  doctrine), E-02 (durable resume), E-03 (evidence verification and
  fingerprint mechanics), E-04 (revalidation recording), E-05 (equality
  proof), E-06 (adoption mechanics), E-09 (disposition registry) gain
  their Phase 5 owners.
- [decision-log.md](../design/decision-log.md): D21 records the decision
  set above.

## Consequences

- Invariant 13 ("partial failure is ledger-recoverable, and attribution
  gates adoption") becomes fully executable in Phase 5's scope; invariants
  10 and 12 gain their durable halves (absorption records, fingerprint
  mechanics).
- Phase 6 (hooks), Phase 7 (artifacts), and Phase 9 (GitHub) inherit a
  ledger seam: hooks extend the step sequence and consume the replay door;
  artifacts absorb per-artifact records into per-attempt ledgers; the
  GitHub adapter binds persistence and external observation to the port
  without touching the classification.
- Every non-advance classification remains a record a human can read; the
  ledger adds no silent path — `stale`, `escalate`, `conflict`, and
  `unverified` all end in recorded, surfaced state.
- No runtime exists yet in Phase 5: the ledger's functions are pure over
  injected records and observations, so the suite runs without effects,
  clock, or I/O — determinism is testable by double-run. Real crash
  survival is the Phase 8 binding's problem; nothing here claims to
  survive a process boundary.

## Limitations

- The reference ledger is an in-memory value: durability against process
  death, cross-process races, and partial writes are the Phase 8 binding's
  problems; Phase 5 pins the discipline (write-ahead, append-only,
  classification) that the binding must keep.
- External observations enter as caller-supplied values (the same posture
  as Phase 4's `noteExternal`); who probes the outside world and how is
  the adapters' (Phase 8/9).
- Disposition decisions are recorded values here; the policy machinery
  that proposes them is future work and deliberately out of scope.
