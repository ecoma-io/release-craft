# Phase 7 contract — the artifact graph

Phase 7 lands the artifact graph: the artifact steps the closed step
sequence anticipated, now on the seam Phase 6 built (ADR-0008;
[release-model.md](release-model.md), the taxonomy's LOCKED Artifact row).
Scope: the declared artifact step, the `artifact:<id>` key space, the
generation records, the declared dependency DAG and its verify
precondition, the publish gate, and reconciliation. Everything here
extends Phase 4's kernel, Phase 5's ledger, and Phase 6's scheduler
machinery — nothing re-decides them.

## 1. Scope and non-goals

In scope: artifact-step declarations (pure data), `artifact:<id>` step
keys, generation records on the ledger, the dependency DAG's protocol
validation, the verify precondition, the publish gate on a completed
generation, fail-closed reconciliation.

Non-goals: real digest computation or registry/filesystem interaction (the
producer is caller-injected — Phase 8/9 adapter territory, ADR-0008
decision 12); evidence freshness rules (PR-03 — carried); persistence
beyond the in-memory ledger (fork 16, Phase 8's binding); channels and
promotion (PR-04's transitions remain the only channel door); the
Release value's joins (lifecycle state, channel memberships — later
integration, not a drive-by).

## 2. Shapes

### 2.1 The artifact-step declaration and the widened key space

```text
ArtifactStep {
  id: string                                   // non-empty, unique per attempt
  anchor: { stage: StageKey; position: "before" | "after" }
  guard: string                                // one declared guard name, recorded verbatim
  kind: string                                 // opaque declared label, recorded verbatim
  coordinates: string                          // opaque declared label, never dereferenced
  dependsOn: readonly string[]                 // sibling artifact-step ids, may be empty
  postconditions: readonly PostconditionKind[] // recorded proofs required
}
PostconditionKind = "content-fingerprint-present" | "evidence-present"
// re-used verbatim from the hook's recorded-proof kinds (ADR-0007 §2.1)
```

```text
StepKey        = StageKey | HookStepKey | ArtifactStepKey   // the closed three
StageKey       = "plan" | "claim" | "prepare" | "validate"
               | "commit" | "tag" | "publish" | "verify"
HookStepKey    = `hook:${string}`                // phase 6, unchanged
ArtifactStepKey = `artifact:${string}`           // the ledger key is artifact:<id>
```

Insertion rules (ADR-0008 decision 3): the declaration anchors at exactly
one canonical stage, before or after it; declaration order breaks
same-anchor ties among extension steps (hooks and artifact steps sharing
an anchor interleave in declaration order, extension kind ignored). The
effective step list stays the single ordering the scheduler and resume
walk; the ledger stays keyed by `(attemptId, stepKey)`.

Protocol validation at the `openAttempt` door (ADR-0008 decision 7),
deterministic, no graph inference: `kind` and `coordinates` are opaque,
non-empty, unpadded (the domain artifact door's rule, quoted not
imported — the recorded triple is the domain `Artifact` value);
`dependsOn` names only sibling artifact-step ids on the same attempt; the
dependency graph is acyclic (declaration-order walk detects back-edges).
A violation is the door's rejection, not a runtime later.

Declarations travel on the attempt exactly as hooks do: `openAttempt`
gains the optional declared artifact list; the attempt carries it as
execution-side data — never part of `attemptIdentity`, never part of the
plan fingerprint, never compared against the plan value (the attempt
carries no plan body; §2.16 keeps coordinates opaque and planning-side).

Implementation migration (the Phase 7 PR, enumerated): `ReleaseAttempt`
gains the optional frozen `artifacts` field (declared `ArtifactStep`
values, defaulting to empty; excluded from `attemptIdentity`); `StepKey`
widens with `ArtifactStepKey`; the scheduler gains the artifact walk
(§2.2); the resume classification's first-uncompleted walk already reads
`StepKey` — no widening needed there.

### 2.2 The producer and the scheduler's artifact walk

```text
ArtifactProducer = (input: {
  attemptId: string
  artifactId: string
  kind: string
  coordinates: string
  stage: StageKey
}) => ArtifactObservation

ArtifactObservation {
  attribution: Attribution            // who produced the observation
  digest: string                      // the content identity — supplied, never computed
  evidence?: string                   // required by an evidence-present postcondition
  recordedAt?: string                 // caller-supplied metadata only
}
```

The producer is the hook effect's sibling: caller-injected, synchronous,
never stored or invented by the engine, invoked at the seam only after
the step's start is durable (write-ahead). The engine computes no digest —
the observation's `digest` is the producer's recorded claim about content
it observed (ADR-0008 decision 2); the engine's job is to record it.

```text
scheduleArtifacts(
  attempt, attribution, ledger, claims, producers,
): { attempt: ReleaseAttempt; outcomes: readonly ArtifactOutcome[] }
```

The walk follows the scheduler's established shape (ADR-0007 decisions
9–10): effective-list order; the ledger projection answers replay before
anything is invoked; at an artifact step —

1. the guard rule runs exactly as a hook's (one aggregate check, the
   declared guard name recorded verbatim on the start record's one
   `GuardResult`),
2. the start appends — durable before the producer may run,
3. the producer invokes at the seam,
4. the verify precondition checks the generation (§2.4),
5. the completion records with its proof (§2.3), or the failure (§2.5).

The walk never mutates the attempt in place; the returned `attempt` is
the successor (blocked after a §2.5 escalation, otherwise unchanged), and
the walk stops at the first refusal or escalation. A completed artifact
step is never re-executed: replay is the ledger projection's business as
usual, and `classifyResume` continues at a recorded next step, artifact
or otherwise (ADR-0008 decision 10).

### 2.3 Generation records

```text
// ledger records for artifact steps carry, on completion:
{ kind: "step", stepKey: "artifact:<id>", state: "completed",
  artifact: { kind, coordinates, digest },       // the domain triple, verbatim
  dependsOn: readonly { artifactId, digest }[],  // the dependency digests, recorded first
  proof: { evidence?: string; fingerprint?: string } }
```

The generation is the attempt's recorded artifact set: one per attempt,
identified by the attempt's identity, immutable — records append, nothing
amends (ADR-0008 decision 5). The generation is **complete** when every
declared artifact step has recorded its completion proof. A deliberate
rebuild under one version identity is a new attempt, therefore a new
generation; the old generation's records stay readable beside it — the
sanctioned escape is a recorded pair, never an overwrite (PR-02; D9's
obligation 6 machinery). Identity within a generation is the digest
(ADR-0008 decision 6): a second completion record for the same
`artifact:<id>` whose recorded digest differs from the first is a
`conflict` (E-02's done-vs-conflict) — same digest replays as
`completed` carrying the recorded proof.

### 2.4 The dependency DAG and its verify precondition

The DAG is the declared `dependsOn` edges — closed input, validated at
the door (§2.1), never inferred. The verify precondition (AR-02's
fragment, D19(6) closed): an artifact step's completion requires each
declared dependency's completion proof to exist in the same generation,
and the record carries the dependency digests it verified against
(ADR-0008 decision 8). A dependency whose proof is missing is the
kernel's recorded refusal — no record appends, the walk stops — the same
shape an unheld claim takes. A dependency whose proof exists is never
re-verified: recorded digests are the generation's content identity, and
producers never re-run to feed a check (the scheduler-driven replay rule,
artifact-side).

### 2.5 Reconciliation and the publish gate

- A failed precondition (guard unheld, dependency unrecorded) is the
  kernel's recorded refusal. Nothing artifact-specific is invented.
- A failed or missing postcondition proof lands the artifact step's
  record as `failed` and blocks the attempt:
  `blocked(validation:artifact:<id>:<cause>)` — the cause naming the id
  and the failed proof — closed only by Phase 5's resolution loop. The
  failed record classifies against the attempt's blocked state exactly
  as a hook's does (ADR-0007 decision 8's classification, unchanged).
- **The publish gate** (ADR-0008 decision 9): the `publish` stage's
  completion requires the generation to be complete. Over an incomplete
  generation, publish takes the kernel's recorded refusal — a version
  identity is never minted with artifacts missing (S-04, AR-01). The
  gate is a precondition of the existing publish step; it is not a new
  stage, and it moves no channel — PR-04's transitions remain the only
  channel door.
- No new attempt state, no new ledger record kind, no silent pass.

## 3. Laws

- No clock, randomness, environment, filesystem, or network reads in the
  artifact modules (the isolation gate extends in the implementation PR);
  the producer is caller-injected and returns what it observed — the
  engine computes no digest.
- Determinism: identical declarations, ledgers, claims, and producers
  classify identically — provable by double-run.
- Records deep-freeze on append (the ledger's discipline, unchanged);
  artifact observations are recorded values, frozen when they land.
- Coordinates are labels: no parse, compare, order, or dereference of a
  coordinate anywhere in the artifact modules (AR-03, invariant 15).
- Tests import through `../src/index.ts` only; the public surface is the
  barrel (ADR-0001 decision 9's shape, unchanged).
- No runtime dependencies; the kernel's purity layering is untouched.

## 4. Test obligations

All tests import through `../src/index.ts` only. The phase's named
fixtures:

1. **Attachment and ordering** — artifact steps interleave at their
   anchors with hooks (declaration order breaks same-anchor ties across
   both extension kinds); the effective step list is stable; the plan
   fingerprint and `attemptIdentity` never move when artifact steps
   attach.
2. **Generation immutability under rebuild** — a completed attempt's
   generation is readable forever; a rebuild attempt under the same
   version identity records a new generation beside the old; no record
   of the old generation changes; the recorded pair carries both
   digests.
3. **DAG refusal and dependency order** — a `dependsOn` naming an
   undeclared sibling, and a declared cycle, refuse at the door with
   deterministic causes; a step whose dependency lacks its proof is the
   recorded refusal (no record, walk stopped); the satisfied dependency's
   digests ride the completion record verbatim.
4. **Digest reconciliation on replay/resume** — the producer never
   re-runs to answer replay; same digest replays `completed`, a
   differing digest on the same `artifact:<id>` is a `conflict`;
   kill-anywhere holds at artifact boundaries (truncation classifies
   identically under double-run; resume continues at the recorded next
   step).
5. **The publish gate and fail-closed proofs** — publish over an
   incomplete generation is the recorded refusal; missing postcondition
   proof → `failed` record + `blocked(validation:artifact:...)` naming
   id and cause; the resolution loop closes it; determinism (double-run
   deep-equal) and no `Date`, `Math.random`, or environment reads in the
   artifact modules.
