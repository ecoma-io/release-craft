---
id: "0005"
title: "The execution kernel — attempts, claims, and guarded transitions"
status: Accepted
implements: "https://github.com/ecoma-io/release-craft/issues/27"
created: 2026-09-06
updated: 2026-09-06
---

# ADR-0005: The execution kernel — attempts, claims, and guarded transitions

## Context

ADR-0002 locked the release model's vocabulary and the shape of its
concurrency ("`Release` is the unit of concurrency; claims and attempts are
the coordination vocabulary"), but left the fork about the claim mechanism
open (release-model.md §6, q1), and the execution invariants 11–13 of the
task list were marked "first provable: later". Phases 2–3 landed the planner
(ADR-0003, ADR-0004): the artifact that _decides_. Nothing yet _performs_ —
a release attempt, its claim on the next version, its transition records, and
its abort semantics do not exist. Phase 4
([#27](https://github.com/ecoma-io/release-craft/issues/27),
[contract](../design/phase4-execution-contract.md)) lands the execution
kernel: the pure semantics that later phases (ledger, hooks, artifacts, Git,
providers) consume.

This ADR exists because the execution domain introduces names — and resolves
a fork — and vocabulary is contract (ADR-0002): every new term enters here,
loudly, with its scenario anchors, or it must not enter code at all. Terms
already canonical (release attempt, execution ledger, claim, artifact
generation, evidence, promotion — ADR-0002 §4 and companion terms) are used
verbatim and are not re-decided; state names appearing in scenario bodies
(`published`, `failed(unknown)`, `superseded`, `abandoned-by-human`,
`abandoned(follower of …)`, `blocked(…)`, `satisfied-externally`) are quoted
into the state machine as data, not invented here.

## Decision

1. **Execution lives in `src/execution/` — the package layer, the planner's
   sibling consumer.** ADR-0002 decision 2 already placed execution as a
   separate consumer of plans; this ADR does not move it into `core/domain/`.
   The kernel keeps value semantics only (D5's posture); no new Moon project
   or boundary row is created — the package tag already covers `src/**`, and
   `core/domain/**` remains import-free (ADR-0001's purity row, unchanged).
2. **Attempt identity is content-anchored and register-allocated.**
   `attemptId = attempt_sha256:<hex>` over canonical JSON
   `{ planId, ordinal }`, where `ordinal` is allocated atomically by an
   **attempt register** port (reference implementation: an in-memory value
   with explicit initial state). A retry is a new attempt over the same
   `planId` — "one plan, two attempts" is E-05's recorded shape. The attempt
   carries `planFingerprint` and never recomputes the plan (invariant 3's
   execution mirror).
3. **The attempt state machine is exactly:**
   `planned → executing → { published | satisfied-externally | failed |
superseded | abandoned }`, with `executing ⇄ blocked(cause)` suspension.
   Terminal is terminal: `resume`/`requestStep` on a terminal attempt is
   a thrown contract violation, never a revival.
   `failed(unknown)` exists as the unclassified-crash state (E-01);
   classification into recovery paths is
   Phase 5's. The loser of a claim race records
   `abandoned(follower-of:<winnerAttemptId>)` (E-07 verbatim). No edge out of
   `abandoned` or `superseded` exists — human aborts never auto-recover
   (E-09).
4. **Fork 13 (release-model.md §6 q1 — the claim mechanism) is resolved at
   the domain level: claim–verify–write over a claim store port.** The
   protocol is: acquire before any mutation (invariant 11); re-verify
   ownership before every write (E-07's discipline); the store's atomic
   accept is the deterministic collision adjudication — no wall-clock, no
   arrival-order assumption; same-holder re-acquisition is idempotent; a
   denied prerelease-sequence acquire retries at the winner's
   `sequence + 1` under declared `maxRetries` policy, then exits with an
   explicit conflict record (E-08). The _physical_ primitive that backs the
   port in a real repository (the tag-push CAS) is deliberately **not**
   chosen here: it is the Phase 8 adapter's binding. This ADR resolves the
   domain half of the fork and leaves the primitive half open, recorded in
   the decision log as D20 and annotated on the fork itself.
5. **Claim scopes are a closed set of three**, each atomic to one attempt:
   `stable-version { lineId, version }` (E-07's "(line, next version,
   attempt id)"), `prerelease-sequence { lineId, target, streamId,
sequence }` (E-08's "(line, target, stream)"), and `release-line
{ lineId }` — exclusive whole-line execution, held only where declared
   policy asks for it, never implied. A claim carries a store-allocated
   opaque **claim token** (E-07: "attempts carry their claim token"). Two
   claims on one scope cannot coexist; `stable-version` and
   `prerelease-sequence` on one line coexist; `release-line` excludes every
   other claim on the line.
6. **Steps are `(attemptId, stepKey)` over the canonical nine stages:**
   `plan → claim → prepare → validate → commit → tag → channel-transition
→ publish → verify` (the model-b salvage ADR-0002 recorded as the
   default step sequence; `channel-transition` inserted by ADR-0012, the
   one explicit door for moving channel pointers between `tag` and
   `publish`). The sequence is **closed in Phase 4**: hooks (Phase 6),
   artifact steps (Phase 7), and the channel-transition stage (ADR-0012)
   extend it through their own ADRs, which must name their insertion
   rules; no extension syntax is invented here. `tag` is the
   **no-return boundary** (E-01): once `tag` completes, supersession can no
   longer void the attempt — it is recorded, and reconciliation
   (delete-tag vs complete-in-place) is a Phase 5 human/policy decision,
   never an automatic undo.
7. **Step states are `pending | started | completed | failed`** — E-02's
   ledger fields verbatim — and every state change is a **transition
   record**: append-only, carrying guard results, the claim token it ran
   under, `{ attemptId, actor }` attribution (actor is an opaque non-empty
   string; human actions are attributed and take precedence over automation,
   E-09), an optional opaque evidence reference, and a caller-supplied
   `recordedAt` timestamp that is metadata, never ordering truth (E-10:
   ordering is structural).
8. **Replay classification is a pure function with exactly seven outcomes:**
   `advance`, `noop` (prior completion, same identity and content),
   `satisfied-externally` (E-03's ledger-first done-ness, provenance
   recorded), `conflict` (same identity, different content or inconsistent
   evidence — refuse and escalate, never silently re-plan), `claim-lost`,
   `blocked(cause)`, `refused(detail)` for protocol violations that are not
   programming errors. Contract violations (impossible edges, terminal
   attempts on the throwing path) throw; runtime races classify as records —
   the planner's split, carried over. The content fingerprint that
   distinguishes `noop` from `conflict` is _present as a field_ in Phase 4;
   its canonicalization mechanics are Phase 5's (the ledger fills it).
9. **No mutation before claim is enforced by the guard table, not by
   convention.** Every mutating stage (`prepare`, `commit`, `tag`,
   `channel-transition`, `publish`) carries a held-claim guard whose
   failure yields
   `refused(mutation-without-claim)` — a record, executable by test. This
   is invariant 11's executable home; E-07, E-08 and M-11 are its stress
   set.
10. **Supersede is a recorded relation, applied at step boundaries.**
    Superseding a plan moves its non-terminal attempts to `superseded` at
    the next step boundary; completions already recorded stand; nothing is
    deleted, rewritten, or re-tagged; orphaned external state is recorded
    for the disposition registry Phase 5 owns (E-09). The `tag` boundary
    (decision 6) is the sole exception to voiding.
11. **Time discipline holds: no clock, randomness, environment, filesystem,
    or network reads in `src/execution/`.** Timestamps enter as
    caller-supplied values; ordering derives from structure. This is stated
    here because it is a contract on every future execution-phase module,
    enforced by the isolation gate below.
12. **The execution-isolation gate is executable from day one.**
    `test/execution/isolation.test.ts` mirrors the planner's
    (`test/planner/isolation.test.ts`): no infrastructure import reaches
    `src/execution/**`; `node:crypto` is permitted only in the identity
    module (fingerprints); no ambient global reads (`Date`, `Math.random`,
    `process.env`). The suite proves the gate bites before anything else
    ships.
13. **The public surface is the barrel.** `src/execution/index.ts` exports
    the layer; `src/index.ts` re-exports it next to the planner's; the
    domain stays reachable only via `@ecoma-io/release-craft/domain`
    (ADR-0001's import rule, unchanged). Tests import through
    `../src/index.ts` only — the external-consumer rule ADR-0001 decision 9
    set, now applied to execution.

### Amendments this ADR makes (loud, in this PR)

- release-model.md §6 q1 (fork 13): annotated **resolved at the domain level
  by this ADR (decision 4)**; the physical primitive remains open for the
  Phase 8 adapter ADR.
- release-model.md §4 invariant 10's final clause is tightened — "never
  publishes _unrecorded_ new bytes under an existing version identity" —
  discharging D9's carried obligation (decision 8's record discipline makes
  the clause contract from Phase 4 on; the promotion machinery that proves it
  is Phase 7).
- [matrix-coverage.md](../design/matrix-coverage.md): the execution rows gain
  their Phase 4 owners (E-03 classification, E-05 attempt half, E-07, E-08,
  E-09 full; E-01/E-04/E-06/E-10 state shapes) alongside the Phase 5 owners
  that remain.
- [decision-log.md](../design/decision-log.md): D20 records the decision
  set above.

## Consequences

- The execution invariants 11–13 become executable in their Phase 4 scope:
  11 fully (claim-before-mutation), 12 as (attempt, step) identity plus
  replay classification, 13 as state/attribution groundwork awaiting the
  ledger.
- Phase 5–9 each inherit a closed vocabulary and a port seam: the ledger
  persists the shapes defined here; the Git adapter binds the claim store
  port to tag CAS without touching the protocol; hooks and artifacts extend
  the step sequence by ADR, not by silent insertion.
- The planner's refusal-style carries over: nothing in execution silently
  re-plans, silently retries, or silently completes. Every non-advance is a
  record a human can read.
- No runtime exists yet in Phase 4: the kernel's functions are pure over
  injected store/ledger views, so the whole suite runs without effects,
  clock, or I/O — determinism is testable by double-run.

## Limitations

- The claim store's reference implementation is an in-memory value: real
  concurrency semantics (process crashes, cross-process races) are the
  Phase 8 binding's problem, and nothing here claims to survive a process
  boundary.
- `noop` vs `conflict` classification is contract-complete but
  fingerprint-incomplete until Phase 5 defines content canonicalization;
  Phase 4's tests pin the classification behavior over explicit fingerprint
  values, not over hashing.
- The state machine's `blocked` resumption requires a _recorded_ resolution;
  what constitutes a resolution record is Phase 5's (ledger) and Phase 6's
  (hooks) to produce. Phase 4 consumes such records as values.
