---
id: 0013-abandonment-record
status: proposed
created: 2026-09-09
updated: 2026-09-10
---

# ADR-0013: The abandonment record — the human abort as durable ledger evidence

## Context

The boundary's `.abort` door (phase 11 contract §2.6) moves a non-terminal
attempt to `abandoned` — terminal is terminal (E-09; phase 4 §2.8), and no
later door revives it. But the evidence lived in exactly one place: the
process-local attempt value the boundary's attempt store carries (§2.7,
bookkeeping, never authority). The kernel's `abort` returns an
`AbortOutcome` whose `attribution` — which actor aborted — the door dropped
on the floor, and no ledger record was appended: phase 4 §2.8 recorded the
state machine's half only — the state machine has no edge out of
`abandoned` — and the ledger union (ADR-0006) named no kind that could
carry the abort's evidence.

The defect (#111) is a restart-visibility hole. A fresh assembly over the
same durable stores sees a plan whose attempt tails carry no abandonment —
the fresh `.run` allocates a new ordinal and silently re-executes the
release the human explicitly withdrew. Mutation-probed on the phase 10
fixtures: with the abort door's durable append disabled, a fresh assembly
runs the aborted plan to `published`. One human decision, recorded nowhere
durable, reversed by the next caller who typed `.run`.

Everything else in the doctrine already points at the answer: the ledger is
the durable memory (ADR-0006), recorded state outranks process-local state
wherever the two can disagree (E-09, §2.3's identical-tails law), and the
boundary never invents vocabulary — a new fact enters as a new record kind
(ADR-0012 decision 4's precedent) through exactly one explicit door
(phase 11 contract §2.9).

## Decision

1. **The durable evidence is a new `LedgerRecord` kind — `abandonment`.**
   The ledger union (ADR-0006) gains a record carrying:
   - the `attemptId` (top level, like a resolution's — the value every
     tail-partitioning reader routes by);
   - the `reason`, verbatim — the same value the attempt's `terminalReason`
     carries in the process that aborted;
   - the abort's `attribution` (`{ attemptId, actor }`) — the kernel's
     `AbortOutcome.attribution`, the value `.abort` used to drop;
   - an optional `recordedAt`, unused until a clock enters the contract
     (§3's law: no ambient time).

   The record is append-only and deep-frozen, exactly as every ledger
   record (ADR-0006 decision 2). No ledger implementation changes: the
   record's top-level `attemptId` rides the existing default branches of
   `tailAttemptId` and the memory ledger's freeze, and the git binding's
   append extracts it the same way — both bindings persist it and reload
   it byte-exact with zero new code.

2. **One explicit door: the boundary's `.abort` appends exactly one.**
   The kernel stays domain-neutral (invariant 2.1): its `abort` names the
   transition and returns the outcome; it appends nothing. The boundary's
   `.abort` door composes the kernel's state door with the durable append —
   and it is the record's only writer (phase 11 contract §2.9). No
   resolution, no run, no resume, no crash classifier synthesizes an
   abandonment; a tail that carries one names a human abort, by
   construction.

3. **A recorded abandonment is terminal from the ledger alone.**
   `classifyResume` (phase 5 §2.3) reads the tail first: a tail carrying an
   abandonment is terminal regardless of the attempt value the caller
   passes — a restarted host can hold any stale value, and the recorded
   evidence outranks it (E-09; §2.3's identical-tails law: the verdict is
   a function of the tail). The refusal is the same thrown
   `InvalidExecutionTransitionError` the terminal-state handling throws
   (types.ts §2.2: terminal is terminal), quoting the recorded actor and
   reason. This is pinned both ways: the same tail without the record
   classifies normally, so the record — not the tail's shape — moves the
   verdict.

   Decision 3 generalizes into #122's **one classification law**, which
   this ADR adopts as an amendment: _the terminality question both
   classification doors answer — "is this attempt over?" — is a function
   of the recorded tail, applied identically at every door._ The tail
   outranks the process-local attempt value in BOTH directions:

   - a recorded abandonment is terminal even over an open-looking value
     (decision 3's original direction), and
   - an attempt value claiming terminal over a tail with no terminal
     record is NOT terminal — the value is §2.7 bookkeeping, never
     authority, so the resume door classifies from the tail's own
     evidence instead of throwing on the state alone.

   Concretely, the two doors — `classifyResume` (phase 5 §2.3) and
   `ledgerRequestStep` (phase 5 §2.8) — call the ONE shared classifier
   (`readTailTerminality`), which reads the tail once, checks for an
   abandonment record, and hands the SAME tail array on for the rest of
   the classification (one live read per door call, no snapshot taken
   across calls; PR #140's walk-tail-once-per-tip discipline). The
   `ledgerRequestStep` door keeps its process-local `isTerminalAttempt`
   gate as the boundary's defense wall — the throwing kernel's terminal
   guard (§2.2 there) must never cross the record path, and the walk
   cannot catch an `InvalidExecutionTransitionError` — but the gate is
   defense, not classification: its refusal carries its own detail,
   distinguishable from the tail-driven refusal. A future direct kernel
   consumer is protected by the same one law: classification over the
   tail is where terminality lives, and the process-local value alone
   never decides it.

4. **A fresh run over an abandoned plan refuses, quoting the record.** The
   attempt sequence of a plan is _derived_, never looked up: attempt
   identity is `attemptIdentity(planId, ordinal)` (phase 4 §2.1), so a
   fresh `.run` scans the ordinals at or below its own fresh ordinal —
   bounded mechanically: the top is the ordinal the run's own allocation
   consumed, captured at the allocation seam (the register has no read
   door), and reaching the top without the identity matching is the named
   divergence of the two derivations, never a longer walk — reads each
   tail through the ledger's existing `tail` door,
   and returns `refused` quoting the recorded attempt id, actor, and
   reason. The refusal is a returned outcome, not a throw (§2.8: no
   exception crosses the boundary for anything the engine classifies — the
   caller of a fresh run may not know the abort happened; the refusal is
   how they learn), and it lands before claim acquisition and before any
   _ledger_ write. Stated precisely: the fresh ordinal itself is already
   allocated when the scan runs — the register has no read door, so the
   scan bounds itself by the ordinal it just burned — and a refused run
   therefore consumes one ordinal (a durable register commit in the git
   binding). N refused runs burn N ordinals, each scan one ordinal longer;
   the plan-keyed attempt lookup that would avoid both is exactly §4
   question 6's deferred door, not something this ADR sneaks in. And a
   refused run leaves no entry in the boundary's attempt store (§2.7):
   the store is bookkeeping, never authority, and a carried phantom would
   decide whether the next run's scan happens at all — every fresh run
   answers the evidence again. The scan also sits after the door's
   operational pre-checks (planning, line resolution, the channel
   pre-check, the scope and mint-target checks), deliberately: an
   operational refusal in that window can mask the abandonment quote for
   that run — the pre-walk refusals' own standing posture (§2.4),
   recorded here rather than hidden.

   Two scope lines, stated plainly. First, this reshapes the _boundary's_
   `.run` only, and deliberately: the kernel's own retry posture stands —
   phase 4 §5 obligation 3's retry attempt still gets a fresh ordinal and
   proceeds when driven through the kernel's doors, and E-08's bounded
   retry still drives through the kernel's clause. The boundary is where a
   human-facing run request enters, and the boundary now answers for the
   plan's recorded abandonments before it re-executes anything; the
   phase 11 contract's amendments record the reshaped row. Second, the
   scan declines to become the plan-keyed attempt index: that lookup was
   deferred on purpose (phase 11 contract §4 question 6, §6) as its own
   reviewed change; until it lands, the derived ordinal scan reads only
   through the port that already exists.

## Rejected alternatives

- **Trusting the attempt state alone (the status quo).** Refused: the
  state is process-local bookkeeping (§2.7); a restart loses it, and the
  abort then leaves no evidence at all — the defect this ADR closes.
- **Reusing an existing record kind — a synthetic `failed` step or a
  resolution.** Refused: a human abort is neither a crash (crash
  classification would offer resume or complete-in-place over the tail) nor
  a blocked-loop resolution (E-06's semantics — a resolution re-arms, an
  abandonment ends). A distinct kind keeps classification honest: the
  record names its own verdict.
- **Making the fresh run throw instead of return.** Refused: §2.8's table —
  every classified stop is a returned value, and the fresh-run caller is
  the party the evidence must reach.
- **Releasing the claim on abort so a retry is possible.** Refused, twice:
  it is claim mechanics answering a doctrine question, and it would
  re-open the silent re-execution this ADR closes. Whether an abandoned
  plan may ever run again is a human's next explicit decision — the
  refusal names the recorded evidence; it does not pretend to know the
  future.
- **A plan-keyed attempt-index port door now.** Refused for this change:
  §4 question 6 deferred it deliberately, and the derived-ordinal scan
  needs no widening beyond the record kind itself.

## Consequence

- `LedgerRecord` gains `abandonment`; both bindings persist and reload it
  with no implementation change (the shape-driven default branches).
- `classifyResume`'s check order is now: abandonment first, then the
  rest of the classification — pinned over both bindings, including
  byte-exact reload and double-run determinism. The tail is read ONCE per
  classification through the shared `readTailTerminality` classifier
  (the same call `ledgerRequestStep` makes), folding the abandonment
  read, the structural pass, and the blocked-attempt resolution into one
  live read (PR #140's discipline); no snapshot is cached across doors.
  The process-local terminal-state guard no longer stands in
  `classifyResume` — the tail's own evidence answers, per the one law.
- The boundary's `.abort` gains exactly one append; the boundary's fresh
  `.run` gains a pre-walk refusal that reads the ledger only — after the
  register's ordinal allocation, whose cost decision 4 states precisely.
- The phase 11 contract's §2.6 (the abort door appends the durable record)
  and §2.8 (the abandoned row's re-run posture) are amended to name it; the
  decision-log row D41 merges as this ADR's ratification.
- The residuals, pinned as words rather than hidden:
  - **The abort door's durable half is not write-ahead.** The door moves
    the attempt first, then appends — the kernel's `abort` offers no
    check-only door, so append-first could record an abandonment for a
    move that then throws (a second abort's named violation), which is
    worse than the window. A ledger fault in that one-commit window
    throws loudly with the attempt terminal in-process and no durable
    record: in-process, every later classification fails closed on the
    terminal state; across a restart, the hole this ADR closes reopens
    for that one abort. Recorded as residual; the kernel-door change
    (a write-ahead abandonment or an `ambiguous` shape for the abort
    outcome) is its own reviewed decision.
  - **The scan's bound is one-writer by construction.** Only ordinals at
    or below the fresh one are scanned, which is sound because the
    boundary's own door is what makes later fresh runs refuse — a foreign
    writer of the public `append` port could place an abandonment above
    the fresh ordinal, where the scan never reads. `append` being public
    is the ledger's own standing fact (recorded state a human must
    judge); the scan does not widen it.
  - **No snapshot across the classification's reads.** As amended by
    #122's one law, `classifyResume` reads the tail ONCE through the
    shared `readTailTerminality` classifier and threads that same array
    through the structural pass and the blocked-attempt resolution — the
    original two-read window (abandonment check, then structural pass)
    is folded into one live read per call. An abort appending between two
    door calls yields two verdicts over their own tails, never one
    verdict over a cached tail; nothing is cached across doors. The first
    re-classification of the resumed walk still fails closed on the
    record.
  - **The scan is O(N) full tail reads per fresh run**, N the plan's
    ordinal count — on the git binding, a walk of the attempt's ref per
    ordinal. The permanent cost of declining the plan-keyed index;
    decision 4 declines it deliberately.
- The honest limit, pinned rather than hidden: the scan keys on the plan
  id alone. A world change that re-plans the line mints a new plan id,
  whose derived attempt identities the aborted plan's tails cannot answer
  for — the fresh run then proceeds, and the claim protocol arbitrates it:
  concretely, E-08's sequence retry admits a new attempt at the abandoned
  attempt's sequence + 1, up to the declared retry bound. The abandonment
  stands over the plan it aborted; a different plan is a different
  decision. Likewise, an attempt allocated but never written (an empty
  tail) contributes nothing — an ordinal the human never reached is not an
  abandonment.
