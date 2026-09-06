# Phase 6 contract — hooks as steps

Phase 6 lands the hook: the execution seam's extension the taxonomy
deferred with a trigger, now fired (ADR-0007;
[release-model.md](release-model.md) "Hook is deferred, with trigger").
Scope: the declared hook value, the step-key insertion rules, the
scheduler, the by-construction plan-mutation refusal, and reconciliation.
Everything here extends Phase 4's kernel and Phase 5's ledger — nothing
re-decides them.

## 1. Scope and non-goals

In scope: hook declarations (pure data), `hook:<id>` step keys, the
effective step list, the classification-driven scheduler, preconditions as
the kernel's guards, postconditions as recorded proofs, fail-closed
reconciliation.

Non-goals: a hooks runtime (the engine executes nothing but
caller-injected effects at the seam — the runtime is Phase 8/9 adapter
territory, ADR-0007 decision 12); artifact steps (Phase 7 extends the same
seam through its own ADR); persistence of hook declarations (Phase 8's
binding); channels and promotion (PR-04's transitions remain the only
channel door).

## 2. Shapes

### 2.1 The hook declaration and the step-key insertion

```text
HookStep {
  id: string                                   // non-empty, unique per attempt
  anchor: { stage: StageKey; position: "before" | "after" }
  claims: readonly string[]                    // preconditions: claim requirements
  postconditions: readonly PostconditionKind[] // recorded proofs required
}
PostconditionKind = "content-fingerprint-present" | "evidence-present"
```

```text
StepKey   = StageKey | HookStepKey            // the closed eight extend
StageKey  = "plan" | "claim" | "prepare" | "validate"
          | "commit" | "tag" | "publish" | "verify"
HookStepKey = `hook:${string}`                // the ledger key is hook:<id>
```

Insertion rules (ADR-0007 decision 3): a hook anchors at exactly one
canonical stage, before or after it; the attempt's **effective step list**
is the canonical sequence with each hook inserted at its anchor,
declaration order breaking ties at the same anchor. The ledger stays keyed
by `(attemptId, stepKey)` — hook records never collide with stage records.

Declarations travel on the attempt: the `openAttempt` door gains an
optional declared hook list, and the attempt value carries it as
execution-side data — never part of `attemptIdentity` (which stays
`attempt_sha256` over `{planId, ordinal}`) and never part of the plan
fingerprint. The plan value and the plan fingerprint are untouched: hooks
attach at the execution seam, never in a plan. Because the attempt value
carries the declarations, resume's classification sees the effective list
without a second parameter.

Implementation migration (the Phase 6 PR, enumerated): `ReleaseAttempt`
gains the optional frozen `hooks` field (declared `HookStep` values,
defaulting to empty; excluded from `attemptIdentity`); `openAttempt`
accepts the declarations; `StepKey` widens to `StageKey | HookStepKey`
with `StageKey` aliasing the unchanged canonical eight; every port that
means "one of the canonical stages" (`requestStep`'s stage parameter,
`requiresHeldClaim`) narrows to `StageKey`; `ResumeOutcome.from` widens
to `StepKey`.

### 2.2 The scheduler

```text
scheduleHooks(attempt, ledger, claims, effects): readonly HookOutcome[]
```

The scheduler reads the declared hooks off the attempt (§2.1) and walks
the effective step list in order (ADR-0007 decision 9): canonical stages
behave exactly as the kernel and ledger already classify them; at a hook
step it

1. verifies the declared claims through the kernel's guard machinery
   (preconditions are guards, ADR-0007 decision 4) and records them
   verbatim on the start record,
2. appends the hook's start — durable before the effect may run
   (write-ahead, ADR-0006 decision 2),
3. invokes the caller-injected effect at the seam:
   `HookEffect = (input: { attemptId, hookId, stage }) => HookObservation`
   — synchronous, the engine never stores or invents it (decision 2),
4. checks the observation against the declared postconditions and records
   the completion with its proof (§2.4), or the failure (§2.5).

A completed hook is never re-executed: the ledger projection answers the
replay, and `classifyResume` walks the effective step list — a resume may
continue at a hook step (ADR-0007 decision 6). `ResumeOutcome.from`
widens to `StepKey` accordingly; `noop`/`conflict` replay over a hook's
recorded fingerprint behaves exactly as a stage's does (E-02's per-step
done-vs-conflict).

### 2.3 The by-construction refusal (model-c question c)

```text
HookObservation {
  attribution: Attribution            // who produced the observation
  evidence?: string                   // required by an evidence-present postcondition
  contentFingerprint?: string         // required by a fingerprint postcondition
  recordedAt?: string                 // caller-supplied metadata only
}
```

The observation carries no plan-shaped field, and the engine exposes no
port by which an effect could return a modified plan or attempt
(ADR-0007 decision 7). The refusal is structural — the type offers no
path — and pinned by tests asserting the plan value and fingerprint are
unchanged after effects run; deep-freeze stays defence in depth.

### 2.4 Postconditions as recorded proofs

A `content-fingerprint-present` postcondition requires the observation to
carry a `contentFingerprint`, recorded verbatim on the completion record;
an `evidence-present` postcondition requires non-empty `evidence`. The
proof lives on the record: replay and resume re-read it, never re-run the
effect. A hook completion with its proof replays as `noop` over the same
fingerprint and `conflict` over a different one, exactly as a stage's
completion does.

### 2.5 Reconciliation — fail-closed, in the existing vocabulary

- A failed precondition (a declared claim not held or not verified) is the
  kernel's recorded refusal — the same shape a mutating stage without its
  claim takes. Nothing hook-specific is invented.
- A failed or missing postcondition proof lands the hook's step record as
  `failed` and blocks the attempt: `blocked(validation)`, the cause naming
  the hook id and the failed postcondition (ADR-0007 decision 8). The
  attempt stays blocked until Phase 5's resolution loop closes it
  (revalidation under the stored plan, or a human resolution for
  `unattributed-state`).
- No new attempt state, no new ledger record kind, no silent pass.

## 3. Laws

- No clock, randomness, environment, filesystem, or network reads in the
  hook modules (the isolation gate extends in the implementation PR);
  timestamps enter as caller-supplied metadata (`recordedAt`).
- Determinism: identical declarations, ledgers, claims, and effects
  classify identically — provable by double-run.
- Records deep-freeze on append (the ledger's discipline, unchanged);
  hook observations are recorded values, frozen when they land.
- Tests import through `../src/index.ts` only; the public surface is the
  barrel (ADR-0001 decision 9's shape, unchanged).
- No runtime dependencies; the kernel's purity layering is untouched.

## 4. Test obligations

All tests import through `../src/index.ts` only. The phase's named
fixtures:

1. **Attachment and ordering** — hooks interleave at their anchors;
   declaration order breaks same-anchor ties; the effective step list is
   stable, and the plan fingerprint never moves when hooks attach.
2. **Kill-anywhere with hooks** — for every boundary in the effective list
   (hook boundaries included), a ledger truncated there classifies
   identically under double-run; a completed hook is never re-executed;
   resume continues at the recorded next step, hook or stage alike.
3. **Refusal by construction** — after effects run, the plan value and the
   attempt's fingerprints are unchanged; the observation type offers no
   plan-mutation path (pinned by the type surface and runtime probes).
4. **Postcondition failure** — missing or invalid proof → the hook's step
   record lands `failed` and the attempt blocks `blocked(validation)`
   naming the hook id; the resolution loop re-arms it; nothing passes
   silently.
5. **Determinism** — identical inputs produce identical hook outcomes;
   double-run deep-equal; no `Date`, `Math.random`, or environment reads
   in the hook modules (the isolation gate extends).
