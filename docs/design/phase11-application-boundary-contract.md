# Phase 11 contract — the application boundary

Owner: [#97](https://github.com/ecoma-io/release-craft/issues/97). The
numbering is proposed — the phase after the vertical matrix — and the
maintainer confirms or renumbers it in review ([§4](#4-open-questions-for-the-maintainer),
question 1). This document is the boundary's design slice: it decides the
composition and the surface, changes no behavior, and binds no
implementation — the boundary lands as its own reviewed PR against this
contract, and the surfaces above it (the CLI, the GitHub Action) land as
their own slices, never here.

Every landed layer constructs separately: the planner's one pure door
([ADR-0003](../adr/0003-deterministic-release-planner.md)), the execution
kernel's constructor doors (`openAttempt` over the register, `start`) and
its classification surface ([ADR-0005](../adr/0005-execution-kernel.md)),
the ledger ([ADR-0006](../adr/0006-execution-ledger.md)), the hooks and
artifact schedulers ([ADR-0007](../adr/0007-hooks-as-steps.md),
[ADR-0008](../adr/0008-artifact-graph.md)), the git binding's port bundle
(`openGitBinding`, [ADR-0009](../adr/0009-git-binding.md)), and the
GitHub adapter's ([ADR-0010](../adr/0010-github-adapter.md)). ADR-0008's
seams and ADR-0005's kernel constructor are the wiring points, and the
binding's own header names the consumer that is supposed to exist: "the
assembly wires them in" — but no assembly ships. The only composition
that exists today is the vertical fixtures' drivers
(`test/vertical/matrix.ts`, `matrix-ledger.ts`, `matrix-git.ts`), which
perform the whole walk by hand — the closed planning input from observed
state, the attempt over the register, the claim view derived from the
store, the write-ahead starts, the extension schedulers at their anchors,
the mint target, the terminal transition. They are the de-facto
application layer, and they are not a surface: no host can run an engine
through a public door, and each future surface would improvise its own
composition — the exact drift the per-layer contracts cannot see, because
they stop at their own layer's edge. One duty is already assigned to the
missing layer by name: ADR-0012 decision 6 — "the application layer wires
the `channel-transition` stage to the channel store" — and there is no
application layer to receive it.

This contract gives the composition a public name: one assembly per
binding, one engine value, four doors, and a strict statement of what a
caller never receives.

## 1. Scope and non-goals

In scope: an application layer (proposed home `src/app/`;
[§4](#4-open-questions-for-the-maintainer) question 3) that assembles the
ports into a runnable engine — one factory per port bundle returning the
same engine value; the application API surface (plan-only runs, executed
runs, resume, resolution, abort, observation reads); the
`channel-transition` wiring point (ADR-0012 decisions 3 and 6, spelled
out in [§2.4](#24-the-channel-transition-wiring-point)); the
outcome-and-throw discipline at the boundary; and the boundary's own
contract tests.

Non-goals:

- **No provider semantics in the boundary** (invariant 2.11; release-model.md
  §4's invariant 15): no GitHub concept, no registry, no credential, no
  remote vocabulary in any boundary shape or module — GitHub semantics
  stay adapter-local ([ADR-0010](../adr/0010-github-adapter.md)); the
  boundary composes port bundles and knows nothing about what backs them.
- **No new locking** (invariant 2.7): the claim store is the concurrency
  control ([ADR-0005](../adr/0005-execution-kernel.md) decision 4;
  [ADR-0011](../adr/0011-claim-line-register.md)); the boundary adds no
  mutex, no single-writer queue, no lease, no in-process arbitration.
- **No artifact mutation** (invariant 2.9): generations are immutable, one
  per attempt ([ADR-0008](../adr/0008-artifact-graph.md) decision 5); a
  rebuild is a new attempt and a new generation, and the boundary has no
  door that amends a record.
- **No re-decided layer.** The kernel constructor, the ledger, register,
  claim, producer, tag door, and the adapters are consumed, never
  re-owned; a port widened for the boundary is its own reviewed change,
  not a drive-by (the phase 8 §1 posture).
- **The CLI and the GitHub Action live above the boundary** (invariant
  2.10) — thin surfaces that call it and compose nothing of their own;
  their slices do not open here.
- **No invented effect executors.** The walk records what the landed
  doors record; a publish-stage remote effect is adapter territory
  ([ADR-0007](../adr/0007-hooks-as-steps.md) decision 12,
  [ADR-0008](../adr/0008-artifact-graph.md) decision 12) and stays with
  the publishing slice's own design.
- **Ecoma appears nowhere** (invariant 2.12;
  [product-boundary.md](product-boundary.md)) — the boundary serves any
  software project; the maintainer's own product is a consumer of it.

## 2. Shapes

### 2.1 The layer

```text
src/app/
  index.ts                 // barrel; the tests' and the surfaces' only entry
  <the assembly modules>   // one factory per port bundle, the engine value,
                           // the outcome vocabulary
```

- Layering: the boundary consumes the layers through their barrels —
  `src/index.ts` for the planner and the kernel,
  `src/adapters/git/index.js` and `src/adapters/github/index.js` for the
  port bundles — never an internal module. Nothing beneath the boundary
  imports it: the boundary is the top of the package's own DAG, the one
  layer that may name all the others.
- The isolation gate extends to the layer: the engine's suite runs green
  with the boundary absent, and no boundary module names a provider
  concept. The package gains no runtime dependency (the house rule).
- The layers' own public surface stands unchanged ([ADR-0005
  decision 13](../adr/0005-execution-kernel.md); phase 4 §2.12): this
  contract adds the application door, it does not retract the barrels.
  The distinction is the audience — the package barrel is the layers'
  surface (the boundary's and the tests'); the engine value below is the
  surface a host consumes.

### 2.2 The assembly — one factory per port bundle

One factory per binding, each returning the same engine value — the exact
generalization of what the vertical fixtures do by hand
([§2.5](#25-the-walk-the-generalized-fixture-drive)):

```text
assembleGitBinding(binding: GitBinding, config: AssemblyConfig) → Engine
assembleMemoryStores(stores: MemoryStores, config: AssemblyConfig) → Engine

AssemblyConfig
  maxRetries: number   // E-08's bounded sequence retry bound — declared,
                       // never implied (ADR-0005 decision 4)
  // and nothing else: no clock, no environment, no HEAD, no token, no path
```

- The memory factory is not a test seam smuggled into the surface: the
  memory stores are the engine's own reference implementations
  ([ADR-0005](../adr/0005-execution-kernel.md) decisions 4–5;
  [ADR-0006](../adr/0006-execution-ledger.md) decision 1), and a
  zero-persistence engine is a legitimate assembly for embedders and the
  boundary's own contract tests ([§5](#5-test-obligations)).
- `openGitBinding` stays the binding's own factory (phase 8 §2.6); the
  assembly consumes an already-opened binding, exactly as
  `openGitHubAdapter` does ([ADR-0010](../adr/0010-github-adapter.md)
  decision 2). The assembly never re-opens, never shares a binding
  between engines, never re-owns a port.
- Assembly is inert: opening an engine writes nothing, reads nothing,
  allocates no claim, appends no record. Two engines over one repository
  are two compositions over one recorded truth — the claims arbitrate
  between them, not the assemblies (the verticals' zero-config law, V11).

### 2.3 The wiring — the port inventory

| The engine needs                   | Wired from                                                             | Owner of the seam                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| The kernel constructor             | `openAttempt` over the binding's `register`, then `start`              | [ADR-0005](../adr/0005-execution-kernel.md) decisions 2, 4–5                                               |
| The durable evidence               | the binding's `ledger` (`ExecutionLedger`)                             | [ADR-0006](../adr/0006-execution-ledger.md); phase 8 §2                                                    |
| The ownership truth                | the binding's `claims` (`ClaimStore`)                                  | [ADR-0005](../adr/0005-execution-kernel.md) decision 4; [ADR-0011](../adr/0011-claim-line-register.md)     |
| The claim view                     | derived by the boundary from the claim store                           | phase 4 §2.7 — the derivation the fixtures hand-roll, named once here                                      |
| The channel-transition executor    | the binding's `channels` port                                          | [ADR-0012](../adr/0012-channel-transition.md) decision 6 — [§2.4](#24-the-channel-transition-wiring-point) |
| The artifact producer              | the binding's `producer` (`ArtifactProducer`)                          | [ADR-0008](../adr/0008-artifact-graph.md) decision 2; phase 8 §2.5                                         |
| The tag door                       | the binding's `mintTag`, called only by the walk, target from the plan | [ADR-0009](../adr/0009-git-binding.md) decision 4; phase 8 §2.3                                            |
| Hook and artifact effects          | the run request's declared bundles, injected per run                   | [ADR-0007](../adr/0007-hooks-as-steps.md) decision 2; [ADR-0008](../adr/0008-artifact-graph.md) decision 2 |
| The read seams (`refs`, `content`) | not wired — they stay the binding's surface                            | phase 9 §2.7–§2.8 (their consumer is the adapter, not the boundary)                                        |

Two hand-rolled derivations move behind the boundary:

- **The claim view** (`matrix-git.ts`'s `claimView`): the attempt's held
  claim plus the store's current-state token re-verification, consumed by
  `requestStep`/`ledgerRequestStep` and both schedulers. The boundary
  derives it from the wired store; no caller ever sees a `ClaimView`.
- **The claim scope a plan line demands** (`ClaimScope` from a
  `PlanLine`). The fixtures derive the same plan's scope two different
  ways — `matrix.ts`'s `scopeFor` names the stream's `pointerBase`;
  `matrix-git.ts`'s `claimScopeFor` names the rendered version's base, so
  the mint door's naming derivation reproduces the plan's own tag. The
  divergence is evidence, not precedent: the boundary owns one
  derivation, constrained by the opened binding's declared naming
  ([ADR-0009](../adr/0009-git-binding.md) decision 5), and a scope whose
  derived tag the naming refuses surfaces exactly as the store's
  namespace door returns it — `ClaimDenied { refusal: "namespace" }`,
  holder absent, a returned outcome the walk stops on. The boundary never
  repairs a denial with a second derivation.

### 2.4 The channel-transition wiring point

ADR-0012 decision 6 assigns the wiring, and nothing owns it yet: the
stage landed with its stage key, record kind, and held-claim guard, while
its store port and the planner's channel content land through
ADR-0012's own slices. The wiring point is the stage executor the
boundary supplies at exactly one place in the walk — at the
`channel-transition` stage, between the ledger's write-ahead `started`
record and the advancing completion, in ADR-0012 decision 3's order:

```text
the walk, at the channel-transition stage:
  ledger.appendStart(attempt, "channel-transition", attribution, …)  // durable first
  ledgerRequestStep(attempt, request, claimView, ledger) → advance   // the claim guard — only a
                                                                     // rule-6-verified advance
                                                                     // proceeds to the store; a
                                                                     // claim-lost (E-07) or any
                                                                     // other verdict stops the walk
                                                                     // before a store CAS runs
  for each planned move: channels.applyTransition(move)              // the wired store's CAS, on
                                                                     // that verified advance — each
                                                                     // move record carries the claim
                                                                     // verdict a check actually
                                                                     // performed; the completion
                                                                     // record appends after every
                                                                     // move (started < moves <
                                                                     // completed)
```

- The kernel names the step; the boundary executes it. The kernel
  consumes no store (invariant 2.1), the binding never walks, and no
  other module reaches the channel store — one explicit door (invariant
  2.8) with one executor behind it.
- **A plan whose channel content cannot be applied refuses before the
  walk starts.** A plan declaring channel moves over an assembly that
  wired no store is `refused(detail)` — returned, naming the stage and
  the missing port — never a run that records starts and completions
  while no pointer moves. The ninth stage is never again walked as a
  quiet no-op.
- **Ambiguity fails closed** (invariant 2.6;
  [ADR-0012](../adr/0012-channel-transition.md) decision 7): a store that
  cannot determine whether a move landed yields `ambiguous`, never
  `completed` — the walk stops, the promotion does not race forward on
  uncertainty, and the resume re-judges from the recorded started record.
- **A COMPLETED channel stage is not re-executed on re-entry.** Its replay
  verdict is `noop` and the walk proceeds past it — later stages and their
  anchors still run — but no store CAS runs: every planned move was already
  decided and recorded in the run that completed the stage (the completion
  appends after every move), and re-applying them would mutate the store
  and write a second generation of move records over a verdict no check
  performed (the silent second move the replay ladder forbids). Only the
  crash-window path re-applies: a `started` stage whose write-ahead start
  stands replays the verified advance, and each already-landed move answers
  `noop` (an advancing stage's own replay case).
- A landed move's replay classifies `noop` and a divergent prior target
  conflicts exactly as ADR-0012 decisions 3–4 key them — per-move rows of
  the store's CAS, reached only through the verified advance above — and
  the boundary drives the ledger's replay doors; it re-implements neither.

### 2.5 The walk — the generalized fixture drive

One run is the fixtures' drive, named once. Per executed line, in
canonical order ([ADR-0005](../adr/0005-execution-kernel.md) decision 6):

1. **Plan** — the planner's pure door over the caller's closed input. A
   planning refusal IS the run outcome: returned, nothing executed, no
   store touched ([ADR-0003](../adr/0003-deterministic-release-planner.md);
   phase 2 §2.9's negative outcomes are records).
2. **Attempt** — `openAttempt(register, { planId, planFingerprint },
hooks, artifacts)` then `start`; a plan already carried by the
   assembly's attempt store continues its existing attempt
   ([§2.7](#27-the-attempt-store-bookkeeping-never-authority)), a new
   plan allocates fresh.
3. **Claim** — the scope [§2.3](#23-the-wiring-the-port-inventory)'s
   derivation names, acquired before any mutation (release-model.md §4's
   invariant 11). A denial is a returned outcome naming the winner
   (E-07); E-08's bounded retry — a denied `prerelease-sequence`
   re-acquiring at the winner's `sequence + 1` under the declared
   `maxRetries`, an explicit conflict past the bound — is the kernel's
   own clause driven, never a new retry invented at the boundary.
4. **Walk** — per stage: extension steps at their anchors before and
   after the stage (`scheduleHooks`, `scheduleArtifacts`,
   [ADR-0007](../adr/0007-hooks-as-steps.md) decision 9,
   [ADR-0008](../adr/0008-artifact-graph.md) decision 10); the write-ahead
   start (`appendStart`, [ADR-0006](../adr/0006-execution-ledger.md)
   decision 2); `ledgerRequestStep` over the derived claim view (phase 5
   §2.8's record-path replay door); the advancing record appended. Any
   non-advance stops the walk in order — the outcomes of
   [§2.8](#28-how-outcomes-cross-the-boundary) — and a stop is recorded,
   never unwound: the tail stays classifiable.
5. **Mint** — the tag door, once, under the held claim:
   `mintTag({ attemptId, token, tag, target })` with the target resolved
   from the plan's own recorded head — a plan value, never ambient `HEAD`
   ([ADR-0009](../adr/0009-git-binding.md) decision 4; phase 8 §2.3).
   A minted `refused`/`conflict` is a returned outcome; nothing the door
   refused left state behind.
6. **Terminal** — `transition(attempt, "published")` when the walk
   completed. Nothing else terminalizes; `satisfied-externally` follows
   the recorded steps exactly as `classifyResume` reads them (phase 5
   §2.3).

The boundary invents no step, no order, no retry, no clock: every move
above cites the kernel or a landed phase contract. A walk that mutates
before its claim, or appends a completion before its start, is wrong
regardless of its assertions — the laws the layers already enforce stay
enforced at the boundary, by the same mechanisms.

### 2.6 The application API surface

```text
Engine
  .plan(input: PlanningInput): PlanningOutcome
      // plan-only: the planner's own door re-exposed; no store is touched
  .run(request: RunRequest): RunOutcome
      // plan + execute: the walk above, to its terminal or its stop
  .resume(handle: AttemptHandle, request: RunRequest): RunOutcome
      // continue from the recorded tail — classifyResume first, never re-plan
  .resolve(handle: AttemptHandle, stepKey: StepKey, resolution: BlockedResolution): RunOutcome
      // the blocked loop's recorded resolution (phase 5 §2.7), through the boundary
  .abort(handle: AttemptHandle, actor: string, reason: string): RunOutcome
      // human abort — terminal is terminal, E-09
  .observe(query: ObservationQuery): Observation
      // recorded evidence read back: tails, per-step outcomes, claims,
      // minted tags, channel reads — read doors only

RunRequest
  lineIds          // which of the plan's lines the run executes (M-02's posture)
  intents          // the operator's prerelease/release-as demands
  actor            // the attribution string — human precedence (E-09)
  declarations     // hooks, artifact steps, and their caller-injected effects,
                   // declared per run, never stored by the boundary
```

- **Plan-only runs** touch no store: the planner's purity (invariant 2.2)
  carries to the boundary, and a plan-only run over an unchanged world is
  identical on double-run (phase 2 §2.14's law, inherited).
- **Executed runs** consume the recorded plan (invariant 2.3): the walk
  never calls the planner again mid-run; a changed world is a new plan, a
  new `planId`, a new attempt — supersession a recorded relation, never an
  edit (PL-08, E-11).
- **Resume** classifies first (`classifyResume`, phase 5 §2.3):
  `resume(from)` continues at the first uncompleted step — extension
  steps included (the schedulers' anchors); `complete` returns the
  recorded terminal; `stale` and `escalate` surface as outcomes a human
  reads — never swallowed, never auto-recovered (E-09).
- **Resolution and abort** are the boundary's doors over the kernel's
  recorded ones: `resolve` lands the resolution record through the ledger
  (phase 5 §2.7 — the only door that re-arms a blocked attempt); `abort`
  moves a non-terminal attempt to `abandoned` with the actor recorded and
  appends the durable abandonment record — reason verbatim plus the
  abort's attribution, the record's only writer (ADR-0013 decision 2) —
  and no later run, resume, or resolve revives it (phase 4 §2.8): a tail
  carrying the record is terminal from the ledger alone (ADR-0013
  decision 3), and a fresh `.run` over the plan refuses quoting it
  instead of re-executing (ADR-0013 decision 4).
- **Observation reads** return recorded values — the attempt's tail, the
  walk's per-step outcomes, the line's held claims, the tags the engine
  minted, the channels' recorded targets — through read doors only. No
  observation mutates; an observation that cannot read is an outcome
  (a listing discipline's twin: phase 9 §2.2's posture), never a partial
  answer read as clean.

### 2.7 The attempt store — bookkeeping, never authority

The fixtures carry attempt values in a process map keyed by `planId`; the
boundary inherits the posture under a name and a rule. The assembly owns
an attempt store (process-local today), `resume` continues the SAME
attempt from it, and a carried-attempt door naming a plan the process
does not carry is a returned refusal (`unknown attempt`, naming the
handle) — never a fresh ordinal silently allocated over someone else's
recorded tail. All four carried-attempt doors refuse this way —
`resume`, `resolve`, `abort`, and the attempt observation (verified:
`carriedEntry` in `src/app/engine.ts`) — so on today's main a mid-flight
attempt is untouchable from any process but the one that opened it: the
recovery support envelope is the process. (Pinned as the certification
fixture's `x-01`, phase 14 §3.5.)

The store is bookkeeping, not authority: the recorded tail and the claim
store are the truth, a stale carried attempt reconciles through
classification (`stale`/`escalate`) and the claim protocol. Two claimants
for one scope are arbitrated by the claim store's CAS (invariant 2.7) —
and never two resumers of one attempt: resuming is the same holder
re-acquiring, and the store's idempotent same-holder adjudication returns
the held claim with no arbitration at all.

Across processes the map is exactly what gates: a fresh engine carries no
entry, every carried-attempt door refuses before any claim is read, and
the claims never arbitrate a cross-process resume. The one cross-process
arbitration today is a fresh `.run`'s fresh ordinal meeting a recorded
claim — the split the two residuals below name.

The refusal is the envelope's soft edge; the fresh allocation is the hard
one. A restarted process re-entering the same plan is a fresh `.run`: the
git register's ordinal counter is durable
(`refs/release-craft/register/<planId>`), so the restart mints a NEW
attempt id (`attempt_sha256` over plan id and ordinal) and meets the dead
holder's still-recorded claim as a non-holder. The two scope kinds then
diverge, and both divergences are accepted residuals:

- **The stable-scope dead lock (E-07).** A stable-version claim is a
  record, not a lease: releasing its token is a no-op, no engine code path
  calls `claims.release` (the binding's passthrough is the port's only
  caller in `src/`), and the token itself is engine-unreachable after
  process death. The restart's denial names the dead holder and repeats
  forever — the plan can never complete.
- **The prerelease E-08 retry at holderSequence+1 stranding the tail.**
  A prerelease-sequence denial carries the winner's sequence, and where
  the declared retry bound allows it, the E-08 retry at
  `holderSequence+1` succeeds past the dead lease: the restart completes
  the plan at the next sequence, stranding the dead attempt's unrecorded
  tail work and consuming the sequence. (The CLI's default
  `--max-retries 0` exhausts the bound first, landing the explicit
  conflict — the stranding is the declared bound's own choice.)

(The memory assembly never sees this divergence — its register restarts
the counter per engine instance, so a restarted memory engine re-mints
the same attempt id; only the durable git register produces it.)

Whether the attempt store becomes a durable port — the plan-keyed lookup
door the ledger port does not name today — is
[§4](#4-open-questions-for-the-maintainer) question 6, and a port
widening is its own reviewed change, not a drive-by: tracked as #227,
which owns the durable lookup, the holder policy for a dead holder's
claim, and the fingerprint pinning. Until it lands, cross-process
recovery is unsupported — the envelope is the process, and the two
residuals above are its recorded cost.

### 2.8 How outcomes cross the boundary

The engine's split carries unchanged (phase 4 §1;
[ADR-0005](../adr/0005-execution-kernel.md) decision 8): **contract
violations throw; runtime classifications are records.** Every outcome
below is a returned value; the throws are the kernel's own, named — an
impossible state-machine edge, a terminal attempt through the throwing
path, a malformed declaration — programming errors carrying the contract
in the message (phase 4 §2.2, §2.7).

| Outcome                      | Meaning                                                                               | Caller action                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `published`                  | the walk completed, the tag minted, the terminal recorded                             | proceed                                                                                                                                                                                                                                                                                                                                                                        |
| `satisfied-externally`       | ledger-first done-ness, provenance recorded (E-03)                                    | proceed; the evidence reads back through `observe`                                                                                                                                                                                                                                                                                                                             |
| `refused(detail)`            | a planning refusal, a namespace denial, a store-less channel plan, a protocol refusal | read the detail; it names the owner and the refused door                                                                                                                                                                                                                                                                                                                       |
| `denied(holder)`             | a claim denial naming the winner (E-07); E-08's retry exhausted lands `conflict`      | another attempt owns the scope; the loser path is recorded                                                                                                                                                                                                                                                                                                                     |
| `blocked(cause)`             | a guard failed on world state (E-04, PR-03, a hook's or artifact's validation)        | resolve through `.resolve`, then `.resume`                                                                                                                                                                                                                                                                                                                                     |
| `failed(cause)`              | a recorded failure stopped the walk — a record, never a throw                         | inspect the tail; a later `.resume` re-judges                                                                                                                                                                                                                                                                                                                                  |
| `conflict(detail)`           | same identity, different content or inconsistent evidence (E-02)                      | a human judges; nothing auto-re-plans, nothing auto-retries                                                                                                                                                                                                                                                                                                                    |
| `ambiguous(detail)`          | a store could not determine whether its effect landed (invariant 2.6)                 | never success — verify through a read, then `.resume`                                                                                                                                                                                                                                                                                                                          |
| `stale` / `escalate(detail)` | the resume verdicts surfaced verbatim (phase 5 §2.3)                                  | re-plan through the planner's door / a human judges the tail                                                                                                                                                                                                                                                                                                                   |
| `resolved`                   | the recorded re-arm: `.resolve` closed a blocked loop over the plan's own fingerprint | `.resume` continues the walk from the recorded tail                                                                                                                                                                                                                                                                                                                            |
| `abandoned`                  | the recorded human abort: `.abort` closed the attempt                                 | the attempt never runs again: where the engine still carries it, a later `.resume` throws and the step replay door refuses — both quoting the recorded evidence, terminal from the ledger alone (ADR-0013 decision 3's one law); in a restarted process the doors refuse the unknown handle; and a fresh `.run` over the plan refuses quoting the recorded evidence (ADR-0013) |

- No exception crosses the boundary for anything the engine classifies —
  the adapters' law carried up one layer (phase 9 §2.3: failures are
  values; no exception crosses the public surface).
- **Ambiguity never reads as success** (invariant 2.6): an `ambiguous`
  outcome is a stop, recorded, and every door that could confirm the
  landing is a read. A caller that proceeds over `ambiguous` has left the
  contract, and the recorded evidence says so.
- The walk's per-step outcomes ride the run outcome verbatim (the
  fixtures' `drives` list, promoted to surface): a caller can read which
  step stopped the run and what it returned, without ever holding a
  primitive.

### 2.9 What the surface never exposes

- **No raw kernel mutation primitives.** `requestStep`, `ledgerRequestStep`,
  `appendStart`, `append`, `transition`, `adopt`, the schedulers, the tag
  door, the mint — none is on the engine value. The walk is the only
  writer; `.resolve` and `.abort` are the boundary's own doors over the
  kernel's recorded ones, not the primitives.
- **No store internals.** The ports ride inside the assembly: the engine
  value exposes outcomes and reads, never `ClaimStore.acquire`, never
  `AttemptRegister.nextOrdinal`, never a `MemoryLedger` or a `GitLedger`,
  never the binding's `refs`/`content` seams (their consumers — the
  adapter, the tests — take them from the binding, per phase 9 §2.7–§2.8).
- **No door around the claim.** A caller cannot mint a tag, append a
  record, or apply a channel move except by running the walk — every
  mutation is claimed first (release-model.md §4's invariant 11), and the
  guard table stays the enforcement while the boundary stays the only
  caller.
- **Reaching past the surface is not a shortcut.** A host that keeps the
  binding value and calls its ports directly has left the boundary's
  contract; what it gets is what the layers already enforce — the
  guard table's `refused(mutation-without-claim)`, the ledger's
  forward-only refusals, the mint door's `unclaimed`/`foreign-token` —
  loudly, as recorded decisions, never silently (the boundary adds no
  protection that would make the layers' own doors softer).

## 3. Laws

- **One assembly, many surfaces.** The CLI and the Action compose
  nothing: they call the engine value. A surface that re-derives a claim
  view, re-orders the walk, or re-owns a port is wrong regardless of its
  tests.
- **Outcomes, not exceptions.** Everything the engine classifies is
  returned; the only throws are the kernel's contract violations,
  rethrown or named, never translated into refusals and never swallowed
  (phase 9 §2.3's law, carried up).
- **Fail closed on ambiguity** (invariant 2.6): `ambiguous` is never
  success; a walk that cannot determine a store's landing stops, records,
  and waits for a read.
- **Claims are the concurrency control** (invariant 2.7): no mutex, no
  queue, no lease, no single-writer assumption enters at the boundary;
  the claim store's CAS is the arbitration, and within the process the
  attempt store gates nobody — across processes its refusals are the
  envelope ([§2.7](#27-the-attempt-store-bookkeeping-never-authority)),
  never a lock.
- **One channel door** (invariant 2.8): every channel move flows through
  the wired stage executor at [§2.4](#24-the-channel-transition-wiring-point)'s
  point; a boundary that moves a channel anywhere else is wrong by
  construction.
- **No ambient value** (E-05/E-10; the verticals' V11): no clock, no
  randomness, no environment, no `HEAD`, no credential at the composition
  root — everything ambient enters as declared configuration, and the
  assembly's config is the closed set [§2.2](#22-the-assembly-one-factory-per-port-bundle)
  names.
- **No artifact mutation** (invariant 2.9): generations are immutable; a
  rebuild is a new attempt ([ADR-0008](../adr/0008-artifact-graph.md)
  decision 5), and the boundary offers no amendment door.
- **Provider-blind** (invariant 2.11; release-model.md §4's invariant 15):
  no boundary shape names a provider; a provider concept that reaches the
  boundary is a layering violation, not a feature.
- **Ecoma is a consumer** (invariant 2.12;
  [product-boundary.md](product-boundary.md)): no Ecoma term, no
  maintainer-specific assumption in any boundary shape.
- **The barrels are the doors.** Tests import through the package barrel
  and the boundary's barrel only ([ADR-0001](../adr/0001-domain-kernel-and-semantic-version.md)
  decision 9's shape, extended); the isolation gate gains the boundary as
  its new top layer.

## 4. Open questions for the maintainer

The contract decides the shape and the discipline; these are deliberately
left open, each with its proposed default:

1. **The phase number.** "Phase 11" is proposed — the phase after the
   vertical matrix — and this document's name follows it; renumbering is
   a rename, not a redesign.
2. **An ADR of its own?** The repo's convention is that a mechanism gets
   an ADR ([ADR-0005](../adr/0005-execution-kernel.md) through
   [ADR-0012](../adr/0012-channel-transition.md)); the boundary is
   composition, not mechanism, and this contract carries its decisions —
   but if the maintainer wants the layer's decisions in the ADR registry,
   the ADR lands with the implementation PR, extracted from here rather
   than re-decided.
3. **Home and names.** `src/app/` is proposed for the layer,
   `assembleGitBinding`/`assembleMemoryStores` for the factories; the
   maintainer may prefer a different name (`src/assembly/`, `assemble(binding)`
   overloads) — the shape does not move with the name.
4. **Config validation.** The planning input is validated by the
   planner's own door (`normalize`, its refusals and throws as landed);
   the proposal is that the boundary re-validates nothing and its own
   config is checked structurally at assembly (`maxRetries` a
   non-negative integer, else the assembly throws the named contract
   violation). Whether the boundary owes a declared-config refusal
   vocabulary of its own is open.
5. **Where the boundary's contract tests live.** `test/app/` is proposed
   (the planner's and kernel's suites' sibling), driving the boundary
   through the package barrel; whether they reuse the vertical matrix's
   fixture data is the next slice's call.
6. **The attempt store's future.** Process-local bookkeeping now
   ([§2.7](#27-the-attempt-store-bookkeeping-never-authority)) —
   cross-process recovery is unsupported on main, and §2.7's two
   residuals are its recorded cost. The durable plan-keyed attempt
   lookup (a ledger port widening or a register read door), the holder
   policy that decides what may supersede a dead holder's claim, and the
   fingerprint pinning a durable resume needs are one reviewed change —
   tracked as #227; the maintainer decides when.
7. **Multi-line runs.** The fixtures run one line per run (M-02's
   posture) and the proposal keeps `lineIds` per run; a whole-plan pass
   needs a cross-line claim-ordering decision and is deferred until a
   slice needs it.

## 5. Test obligations

All boundary tests import through `../src/index.ts` and the boundary's
barrel only. The phase's named fixtures:

1. **Generalization** — the boundary over the memory stores drives the
   vertical matrix's runs and lands the fixtures' goldens: the boundary
   is the drive the fixtures hand-roll, proven equal outcome by outcome,
   not asserted equal by a second hand-walk.
2. **Surface-negative** — the engine value's exported surface names no
   mutation primitive and no store: the negative inventory of
   [§2.9](#29-what-the-surface-never-exposes) is executable, so a
   drive-by door fails the suite that names the inventory.
3. **The outcome table** — every [§2.8](#28-how-outcomes-cross-the-boundary)
   row is pinned by a fixture that produces it through public doors;
   `ambiguous` is pinned twice: once as a stop, once as a non-success
   read by a caller that tries to proceed.
4. **The channel wiring** — a plan declaring channel content over a
   store-less assembly refuses before the walk; with the store wired, the
   moves land exactly between the started and completed records
   ([§2.4](#24-the-channel-transition-wiring-point)), byte-pinned in the
   tail, and a completed transition replays `noop` (ADR-0012 decisions
   3–4).
5. **Resume and the blocked loop** — kill-anywhere through the boundary:
   every interruption window classifies and resumes through `.resume`,
   the blocked loop closes through `.resolve`, and the resumed run's
   outcome matches the uninterrupted run's (V7 carried up one layer).
6. **Determinism and no ambient** — double-run over the same declared
   inputs produces identical outcomes; the isolation probe extends to the
   boundary's modules (no `Date`, `Math.random`, `process.env`), and the
   assembly's inertness is asserted (opening an engine writes nothing).
7. **Isolation** — the engine's suite runs green with the boundary
   absent; no layer imports the boundary; no boundary module names a
   provider concept; no boundary test reaches a binding's internal
   modules.

## 6. Out of scope (and where it stays)

- The CLI and the GitHub Action — thin surfaces above the boundary
  (invariant 2.10), their own slices and their own designs; nothing here
  names a flag, a format, or an action input.
- The channel store port and the planner's channel content —
  [ADR-0012](../adr/0012-channel-transition.md)'s own slices; the wiring
  point here is decided, the port is not.
- A durable attempt lookup — [§4](#4-open-questions-for-the-maintainer)
  question 6's own reviewed change, tracked as #227.
- Remote effect executors for the publish stage — adapter and publishing
  slice territory ([ADR-0007](../adr/0007-hooks-as-steps.md) decision 12;
  [ADR-0008](../adr/0008-artifact-graph.md) decision 12;
  [ADR-0010](../adr/0010-github-adapter.md)).
- The supersede door at the boundary — supersession is a recorded
  relation applied at step boundaries ([ADR-0005](../adr/0005-execution-kernel.md)
  decision 10); the boundary consumes it in classification, and its own
  door lands with the slice that needs it (E-11, PL-08).
- Decision-record persistence — phase 8 §2.6's posture stands: the
  discipline is fixed, the door arrives with its first consumer.
- release-please compatibility — the baseline's boundary
  ([release-model.md](release-model.md) §18) is unchanged.
