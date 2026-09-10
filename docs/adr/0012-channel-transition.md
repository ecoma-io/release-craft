---
id: 0012-channel-transition
status: proposed
created: 2026-09-08
updated: 2026-09-10
---

# ADR-0012: The channel-transition door — one explicit, durable stage for moving channel pointers

## Context

The release model's vocabulary locks `Channel` as "a named, mutable
deliverability pointer a consumer reads; its moves are recorded events"
(ADR-0002), and `Transition` as "the unit of durable state change;
channels move only as transitions (PR-04)". The model also locks
`Promotion` as "a channel pointer move (channel mutation) or a maturity
reclassification such as rc → stable (release event, `promoted-from`
edge)". Yet no landed phase executes any of it:

- `grep -rn "channel" src/` returns only a named example in a
  `StepState` comment. The execution kernel neither reads nor moves a
  `Channel` value.
- The planner carries no channel data: `src/planner/` has zero channel
  references, and decision-log D19(7) recorded the "promotion/channels
  slice" as "execution-only".
- The git binding persists ledger records, claim registers, and tags,
  but no channel namespace, no channel store, no channel read.
- The GitHub adapter (ADR-0010) explicitly lists "Promotion or channel
  semantics (PR-04's door)" as a non-goal.
- Every landed phase contract disclaims the territory: phase 6 §1,
  phase 7 §1 and §2.5, phase 8 §1, phase 9 §1, ADR-0007, ADR-0008.

Consequence: a release can promote a version while every
consumer-facing channel pointer silently stays where it was — exactly
the quiet-lying class this repository exists to refuse. The Phase 10
vertical matrix (#74) hit this wall first: it cannot assert a channel
target moving, because no door exists to move one. Issue #76 is the
ownership ticket this ADR discharges.

PR-04's discipline fixes the required behavior:

- A channel move is a **recorded event** (`from`, `to`, actor, reason)
  — never a deletion or a rewrite. A rollback hides, never erases.
- Moves are **CAS-guarded**, with the expected prior state part of
  every move command.
- Replays are **replay-protected**: a stale replayed command whose
  expected prior state no longer matches is rejected toward a human,
  never silently re-executed.
- The "served-window" (which version did a channel deliver in
  `[T1, T2)`) is a queryable property over the event log.

PR-01 fixes the promote path: "promotion binds identity onto verified
digests" — the rc stream closes, channels `next`/`stable` move. PR-02
hides rebuild under a new generation. PR-05's membership is a graph
with a timeline (one release, many channels, over time).

## Decision

1. **A channel transition is a canonical execution stage, not a new
   workflow engine.** The kernel's canonical stage sequence (ADR-0005
   decision 6) gains one stage, `channel-transition`, between `tag` and
   `publish`. The step key is `channel-transition` — not `transition` —
   because the exported `transition(attempt, state)` attempt-state
   function (attempt.ts) already claims that name; the stage key avoids
   the collision. A `channel-transition` step is a mutating stage: it
   demands a held, verified release-line claim, exactly like `prepare`,
   `commit`, and `tag`. This is the **one explicit door** (invariant
   2.8): no release may move a channel indirectly — every channel move
   flows through this stage's recorded plan.

2. **The planner declares channel transitions in the plan.** A
   `PlanLine` gains an optional `channels` field: the planned channel
   moves and stream closes for that line's run. On the promote path
   (P-03, `decision.bump === null`), the planner resolves whether the
   run promotes a prerelease to stable and, when it does, plans:
   - the `stable` (and any declared `next`) channel's move to the
     promoted stable version;
   - the promoted-from edge (`<prerelease stream>` → stable);
   - the prerelease stream's close.
     Channel decisions are **deterministic, side-effect-free plan
     content** (invariant 2.2): the planner never mutates a channel, it
     only names the planned moves as part of the immutable recorded plan.

3. **Execution records the transition before it runs.** At the
   `channel-transition` stage, the kernel appends a write-ahead
   `started` record (the same discipline every stage follows) carrying
   the planned channel moves verbatim, then the application layer
   executes each planned move against the channel store, then the kernel
   appends the `completed` record. A crash anywhere between appends is
   classified by the existing replay machinery (E-01): a `started`
   transition with no completion re-executes on resume; a completed
   transition replays `noop`.

4. **The durable evidence is a new `LedgerRecord` kind.** The ledger
   union (ADR-0006) gains `channel-transition`, a record carrying, per
   transition:
   - the channel id;
   - the `from` target (line + version, or `null` when the prior
     target is hidden);
   - the `to` target (line + version, or `null` when hiding);
   - the attribution (attempt + actor);
   - the guard result;
   - a content fingerprint over the observed prior target — the
     idempotency key that makes a replay of an already-applied move a
     `noop` and a divergence (`from` no longer matches) a `conflict`.
     The record is append-only and deep-frozen, exactly as every ledger
     record (ADR-0006 decision 2). The served-window query (PR-04) is the
     ledger tail projected over `channel-transition` records.

5. **Concurrency is arbitrated by the existing claim protocol, not a
   new lock.** The `channel-transition` stage holds the line's
   `release-line` claim, so the same atomic boundary that guards `tag`
   also guards the channel move. No in-memory mutex is introduced
   (invariant 2.7). The channel store is a **persistent port**, so a
   second process attempting a transition without the claim is denied by
   the claim store before it can compute a move.

6. **The channel store is a new port on the binding.** `GitBinding`
   gains a `channels` port: `read(channelId)`, `list()`,
   `applyTransition(transition)` — where `applyTransition` is a
   compare-and-set over the channel's recorded prior target. The
   channel's persisted state is the serialized `Channel` value (id +
   line + version, or a hidden sentinel) under a channel namespace
   (`refs/release-craft/channels/<id>`; revised in #133 to the
   product-neutral family, invariant 2.12 — the mapping's shape is
   unchanged), readable without ambient state, never guessed from the
   plan. The kernel does not consume the channel store directly — it stays
   domain-neutral (invariant 2.1); the application layer wires the
   `channel-transition` stage to the channel store.

7. **Ambiguity fails closed.** If the channel store cannot determine
   whether a move landed (a transport-level failure on the backing
   store), the transition records `ambiguous`, never `completed` — the
   promotion does not race forward on uncertainty (invariant 2.6).

## The promote path, end to end

On a `promote` run (P-03, `decision.bump === null`):

```
planner resolves the promote decision
        ↓
planner names the channel moves + stream close + promoted-from edge
        in the plan's `channels` field        (decision 2)
        ↓
execution walks … commit → tag → channel-transition → publish → verify
        ↓
channel-transition (decision 3, 4):
  append started record (planned moves verbatim)
  application applies each move through the channel store's CAS (6)
  record the completed record; stream close + promoted-from
  recorded the same way
        ↓
replay (decisions 3, 5, 7):
  a completed transition replays noop
  a started-but-uncompleted transition re-applies (or conflicts)
  a divergent prior target conflicts (never a silent second move)
```

The `channel-transition` stage sits **after** `tag` (the version is
recorded)
and **before** `publish` (the channel may not point at a yet-unpublished
version — the ordering #76's failure analysis requires).

## Rejected alternatives

- **Folding channel moves into the publication slice (Phase 10).**
  Refused: #74's contract adds no behavior, and a mechanism invented
  mid-proof would prove nothing. The gap needs its own reviewed
  decision first; this ADR is it.
- **Declaring channel moves permanently out of scope.** Refused: the
  release model's vocabulary promises them, and a release engine whose
  channels never move cannot serve consumers.
- **A generic workflow engine / signal graph to express transitions.**
  Refused: this repository refuses to build a workflow engine for one
  state change; a canonical stage plus a persistent store port is the
  smallest mechanism that closes the actual contract gap.
- **Handling transitions as hooks.** Refused: a hook is user code with
  caller-injected effects; a channel move is a core lifecycle mutation
  that must be deterministic, durable, and claim-guarded. Burying it in
  a hook would bypass the claim protocol and the ledger's record
  vocabulary.
- **Making the execution kernel consume the channel store directly.**
  Refused: that would leak persistence into the pure decision
  machinery. The kernel names the step; the application wires the port
  (invariants 2.1, 2.10).
- **A new dedicated locking primitive for channels.** Refused: the
  release-line claim is already the atomic boundary for a line's
  mutations; a second primitive would be a parallel source of truth
  (invariant 2.7).

## Consequence

- `CANONICAL_STAGES` grows to
  `plan, claim, prepare, validate, commit, tag, channel-transition,
publish, verify`.
- `StepKey` gains `"channel-transition"`; `MUTATING_STAGES` gains it;
  `requiresHeldClaim` covers it.
- `ReleasePlan` / `PlanLine` gain the planned channel content.
- The `LedgerRecord` union gains `channel-transition`.
- `GitBinding` gains the `channels` port.
- The Phase 10 matrix's V4 row is re-proven: the promote run lands the
  promote decision **and** the planned channel moves, stream close, and
  promoted-from edge; the assertion flips from "channels never move" to
  "channels move exactly as planned, durably, replay-safe".
- The phase 6/7/8/9 §1 and §2.5 disclaimers are updated to name this
  ADR as the door that now owns the territory (no longer "unlanded").
