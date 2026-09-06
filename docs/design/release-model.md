# The release model — Phase 0 synthesis

> **Status: Phase 0 design asset (tasks 0F+0G, orchestrated run for
> [#13](https://github.com/ecoma-io/release-craft/issues/13)).** This document
> records the Phase 0 release-model decision
> ([decision-log](decision-log.md) D4): what a release **is** in release-craft,
> the vocabulary that names it, the invariants that govern it, and the
> complexity contract that keeps simple repositories simple. It decides; it does
> not implement — Phase 0 ships design documents only (D0), and the only domain
> object in the tree today is the `Version` value
> ([ADR-0001](../adr/0001-domain-kernel-and-semantic-version.md)). The decision
> record for this document is
> [ADR-0002](../adr/0002-release-model-and-domain-vocabulary.md). Companion
> evidence, all read for this synthesis: the scenario matrix
> ([release-scenarios.md](release-scenarios.md)), the three model evaluations
> ([model-a](_proposals/model-a.md), [model-b](_proposals/model-b.md),
> [model-c](_proposals/model-c.md)), the process taxonomy
> ([release-taxonomy.md](release-taxonomy.md)), the release-please behavioral
> baseline ([release-please-baseline.md](release-please-baseline.md)), and the
> repository audit ([phase0-repository-audit.md](phase0-repository-audit.md)).

## Evidence labels

As in the companion Phase 0 documents: **OBSERVED** — taken directly from a
cited document (by section or scenario id); **INFERENCE** — reasoned from
observed facts; **RECOMMENDATION** — release-craft's position, argued, not
observed. Throughout, "the matrix" is
[release-scenarios.md](release-scenarios.md) (53 scenarios; its
[canonical vocabulary](release-scenarios.md#canonical-vocabulary) and
[stress analysis](release-scenarios.md#stress-analysis) are load-bearing here),
"model-a/b/c" are the three evaluations in
[`_proposals/`](_proposals/model-c.md), and "the baseline" is
[release-please-baseline.md](release-please-baseline.md).

## The models compared

**Model A — a release is the pair (branch, version).** One configured branch
computes the next version from the last tag reachable from its head, opens a
release PR, and tags and publishes on merge; channels do not exist, prerelease
is a per-branch flag, promotion is a merge or a flag flip, and artifacts are
keyed by version string (OBSERVED: model-a
["The model under evaluation"](_proposals/model-a.md#the-model-under-evaluation)).
**Verdict: REJECTED** (OBSERVED: model-a
[Part 4](_proposals/model-a.md#part-4-verdict)). Its own
[tally](_proposals/model-a.md#tally) grades 25 of the matrix's 53 scenarios
FAILS, and the failures are structural, not incidental: the entire PROMOTION
class (PR-01, PR-02, PR-03, PR-04, PR-05 — no channels, no generations, no
evidence, no history), execution state (E-01, E-02, E-03, E-06, plus AR-05,
with E-09 in the tally — tag existence misread as completion, resume-by-inference
as default), artifact identity (AR-01 through AR-06 — version-string-keyed
outputs with no digest or per-artifact state), stream identity (P-02, P-05,
P-06 — prerelease as boolean plus string parsing), identity substrates (M-03,
M-10, M-11 — change identity and line identity have no storage; the verdict
names M-11 for the identity demand although the per-scenario tally grades it
NEEDS-RULE), and the package axis (PL-01, PL-02, PL-03, PL-07 — the identity
axis cannot admit a package dimension without changing what a release is). It
is not rejected for convenience: amending Model A to competency requires
exactly the six concepts the taxonomy locks (OBSERVED: model-a Part 4), so the
amendment _is_ the successor — "amended to competency it is no longer Model A."
Five properties survive rejection and are inherited below as design
constraints: tag-derived recomputed state (S-03, PL-06, E-04, E-10, E-11);
compute at the last responsible moment (PL-08, E-11); tag-push CAS as the
allocation primitive (E-07, E-08); per-line grain; and a zero-concept path for
the simple-repository majority.

**Model B — a release is one run of a linear pipeline.** Collect changes,
compute bump, changelog, release PR, tag, build, publish, announce; progress is
stage position (P1), retries discover prior work by observing the world (P2),
the line is a config entry naming a branch (P3), channels are publish targets
(P4), promotion is a re-run from a later stage (P5) (OBSERVED: model-b
["The model under test"](_proposals/model-b.md#0-the-model-under-test)).
**Verdict: REJECTED** (OBSERVED: model-b
[§5](_proposals/model-b.md#5-verdict)). Its
[score](_proposals/model-b.md#38-score-and-pattern) grades 15 scenarios fails —
E-02, E-03, E-05, E-06, E-09; P-02, P-03, P-06; M-03, M-10; AR-05, AR-06;
PR-01, PR-04, PR-05 — "precisely where the matrix says naive models fail most
often." The worst single outcome is E-09: completing a release a human
explicitly aborted is P2's _default behavior_, not an edge case. The rejection
rule is the evaluator's own: a model survives with amendments when they extend
it; it is rejected when they delete its defining properties — and the required
amendments (its items 11, 12, 14, 15, 17, 18) each delete P1 or P2, leaving "a
thin skin over the plan/attempt/ledger model, retained only as vocabulary."
What survives is the salvage list: the eight-stage pipeline as the default step
sequence of an attempt, the tag push as claim primitive, the release PR as a
plan carrier, the tag cursor as default range policy, and ambient state demoted
from record of done-ness to evidence to be attributed and verified.

**Model C — a release is the stateful execution of a release plan.** Planning
is a pure, deterministic, side-effect-free function from enumerated inputs to
an explicit plan; execution is a separate stateful process giving each attempt
identity, durable transitions, and idempotent resumability; releases are
entities distinct from version strings; release lines are ordered version
streams configured independently of branches; channels are mutable pointers
managed as transitions; prerelease progression is line/channel policy over the
kernel's `Version` (OBSERVED: model-c
["The model under test"](_proposals/model-c.md#the-model-under-test)).
**Verdict: SURVIVES-WITH-AMENDMENTS** (OBSERVED: model-c
[verdict](_proposals/model-c.md#verdict-survives-with-amendments)): its
[tally](_proposals/model-c.md#tally) is clean 20, needs-amendment 33, fail 0 —
no scenario is unrepresentable, and two of the matrix's hardest stress
families (attempt + ledger + claims; plan as a first-class invalidatable
object — ranked 8 and 6 scenarios in the
[stress analysis](release-scenarios.md#stress-analysis), whose top family,
release line as the scoping unit, is native to all C-family structures) land
on native structure. Seven amendments are required, none touching the
planning/execution split: A1 decision records as a second planning output;
A2 change identity and provenance; A3 a claim protocol in execution; A4
artifact, generation, and evidence schema in the ledger; A5 stable line
identity with an explicit feed mapping; A6 plan supersession machinery; A7
attribution and foreign-state discipline.

**Evaluator-proposed alternatives.** Model A's evaluator proposed the taxonomy's
locked vocabulary made executable, keeping A's surviving properties as
constraints (OBSERVED: model-a
[Part 5](_proposals/model-a.md#part-5-proposed-alternative)); model B's
evaluator proposed "Model C: claim-guarded line transitions" (OBSERVED:
model-b
[§6](_proposals/model-b.md#6-proposed-alternative-model-c-claim-guarded-line-transitions));
model C's evaluator proposed no superior model, offering Model C′ instead
(OBSERVED: model-c
["Proposed alternative: none"](_proposals/model-c.md#proposed-alternative-none-model-c-instead)).
The two losing evaluators' own alternatives independently converge on C's
skeleton — the triangulation D4 records. No evaluator proposed a model outside
the A/B/C comparison set.

## The chosen model

**Model C′ = Model C + amendments A1–A7** (RECOMMENDATION, decided as D4). Its
twelve defining properties are C's five structural commitments plus the seven
amendments (OBSERVED: model-c verdict). In full:

**What a release is.** A release is an _entity with its own identity_, minted
on a release line when a plan's target is attempted — not a version string, not a
publication event, not a branch state. Publication is one lifecycle state it may
reach, never its birth; an attempt that voids (E-01) leaves a minted release
that was abandoned, not a release that never existed. Its identity is its own
(line + sequence or an opaque id); it carries a `Version`, a change set, a
source lineage, artifact generations, a lifecycle state, and channel
memberships. Version equality is never release identity: the same number can
name two events on two lines (M-11), and the same target can carry different
content (E-11).

**What planning is.** A pure, deterministic, side-effect-free function:

```text
(repository observations, parsed changes, release history,
 line configuration, component metadata)        →  ReleasePlan | DecisionRecord
```

Inputs are enumerated and frozen — time and policy digests arrive as input
values, never as environment reads (E-05). A `ReleasePlan` is an explicit,
inspectable, serializable, content-fingerprinted artifact recording what should
release, on which lines, at which versions, from which source state, carrying
which changes, with which dependency propagation, which artifacts are declared,
and which future transitions are required. A `DecisionRecord` is the second,
equally first-class output: a recorded no-op, refusal, block, or withholding
with its cause, evaluated range, and the policy version that produced it (A1) —
a negative decision is still a decision (S-01, PL-06).

**What execution is.** A separate, stateful domain that _consumes_ plans and
never recomputes them. Each execution of a plan is a _release attempt_ with its
own identity; before any mutation the attempt acquires a _claim_ — atomic
ownership of the next version, scoped to the line for releases and to (line,
target, stream) for prerelease sequences (A3, E-07, E-08); every step is
recorded in a write-ahead _execution ledger_ keyed by (attempt, step), with
each step idempotent and attributed (A7); terminal states include published,
failed, superseded, and abandoned-by-human (E-09). Resume is ledger
classification, never recomputation (E-01, E-02); adoption of externally
visible state requires attribution, never bare existence (E-06, AR-05).

**The guarantees, as testable sentences.**

- Same inputs, same plan fingerprint, on every invocation (E-05, E-10).
- Planning mutates nothing outside its return value (E-05, PL-08).
- Every negative outcome is a returned record with cause and policy version
  (S-01, PL-06, PL-07).
- Next-version truth is the line's own tag history; the manifest is a
  projection (S-03, S-05, M-07).
- Plan identity is the content fingerprint; version equality implies nothing
  (PL-08, E-11).
- No mutation happens without a held claim; claim loss is detectable after
  every step (E-07, E-08, M-11).
- Completed steps replay as no-ops reporting prior completion; completion with
  different content is a conflict (E-02, E-03).
- Half-executed attempts are resumable from their ledger (E-01, E-02).
- External state is adopted only when attributable to the attempt (E-06,
  E-09, AR-05, AR-06).
- Channels move only as recorded, CAS-guarded events; rollback hides, never
  erases (PR-04, PR-05).
- Promotion re-points or reclassifies; it never fabricates content (P-03,
  PR-01, PR-02).
- A one-branch repository releases end to end with zero declared lines,
  channels, or plans (S-01, S-03, S-04, S-05).

Section 4 makes these enforceable as numbered invariants with stressing
scenarios and the phase that can first prove each executable.

**Layering.** Where the concepts live follows the settled decisions: the kernel
(`core/domain/`) keeps only value semantics and gains exactly the vocabulary's
kernel-value kinds in Phase 1; the planning engine lives in the package layer
`src/`, consuming kernel values (D5 — the audit's route 1, zero structural
cost); execution is a later, separate consumer. ADR-0001's consequence that
release _policy_ (lines, channels, transitions) "stays outside `core/domain/`"
governs the policy _resolution_ — ladders, stream advancement rules, bump
mapping — which is planning-side data and code; the pure value shapes those
policies judge (a line's identity and stream state, a channel pointer, an
artifact digest record) are kernel values and land in Phase 1 as such. The
kernel entrypoint becomes a barrel at the second primitive, amending ADR-0001
decision 8 in the same PR (D6). Prerelease progression stays line/channel
policy over the kernel's `Version`, exactly as ADR-0001 decision 7 deferred it.

**Drift audit.** The model commits none of the failure patterns this phase
exists to prevent: no branch is a release identity (M-10, S-03); no `Version`
owns a channel (ADR-0001 decisions 2 and 7); a release is not a publication
event (E-01, S-01); prerelease is not a boolean (P-02, P-04); hooks never
enter planning (model-c question c); no GitHub or registry concept enters the
domain (baseline §18.2-2); planning has no side effects (E-05); no state hides
implicitly in PRs or tags (PL-08, baseline §11.5); the trivial path carries no
complexity tax (§5 below); every concept is locked here or explicitly deferred
(§3); release-please is a baseline to preserve or break with, never an
architecture to depend on (§7, R1); and beyond the enumerated terminal states,
lifecycle vocabularies stay per-workflow policy data, not hard-coded engine
states (taxonomy §1.14).

## Domain vocabulary

### The locked vocabulary

The eleven terms the synthesis was asked to judge, with the matrix's canonical
meanings (OBSERVED:
[canonical vocabulary](release-scenarios.md#canonical-vocabulary)) and the
taxonomy's relationship locks R1–R6 (OBSERVED:
[release-taxonomy.md §2](release-taxonomy.md#2-relationships-the-vocabulary-lock)).
"Kind" places the term in the layering above; it also settles decision-log U4 —
Phase 1 takes exactly the kernel-value kinds.

| Term        | Definition (one sentence)                                                                                                                                                                                                                                                                                     | Kind              | Relationships                                                                                                                                                         | Disposition         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Version     | A strict SemVer 2.0.0 value as parsed by the kernel: bare, bounded to safe integers, with structural equality distinct from precedence (ADR-0001).                                                                                                                                                            | kernel value      | The ordering and identity primitive every other term judges; exists today.                                                                                            | **LOCK**            |
| Change      | The atomic unit of work, carrying an identity stable across lines and cherry-picks plus its lineage and provenance (A2).                                                                                                                                                                                      | kernel value      | Member of change sets; releasedness is per (line, change).                                                                                                            | **LOCK**            |
| ChangeSet   | The enumerated group of changes a release instantiates, with the bump it implies (R4).                                                                                                                                                                                                                        | kernel value      | Carried by a plan; instantiated by a release; may be empty and inherited (PL-06, P-03).                                                                               | **LOCK**            |
| ReleaseLine | A durable, ordered stream of versions with a stable id, a head derived from its own tags, and a lifecycle — the policy that governs what it releases is planning-side data, not a field of the value (A5).                                                                                                    | kernel value      | Orders versions; holds channel pointers; fed by branches through recorded feed mappings; carries stream state.                                                        | **LOCK**            |
| Channel     | A named, mutable deliverability pointer a consumer reads; its moves are recorded events (R1).                                                                                                                                                                                                                 | kernel value      | Points at a release or artifact on a line; backend bindings (npm dist-tag, container tag) are adapters.                                                               | **LOCK**            |
| ReleasePlan | A persisted, inspectable, content-fingerprinted projection of what should release — target versions, change set, base bindings, preconditions, policy digest (A6).                                                                                                                                            | planning concept  | Produced by the planner; consumed by attempts; superseded by later plans or closed by a decision record (mixed-kind endpoints, PL-06/PL-08 — ADR-0003), never edited. | **LOCK**            |
| Release     | The entity minted when a plan's target is attempted on a line — publication is a lifecycle state, not its birth: identity distinct from its version, carrying change set, lineage, artifacts, lifecycle, channel memberships (R2, E-01).                                                                      | execution concept | Has one version and one change set per generation; joins channels; is targeted by plans.                                                                              | **LOCK**            |
| Promotion   | A user-visible state change of an existing release without new content: a channel pointer move (channel mutation) or a maturity reclassification such as rc → stable (release event, `promoted-from` edge) (R5).                                                                                              | execution concept | A transition kind; binds identity onto verified digests (PR-01) or records a new generation (PR-02).                                                                  | **LOCK**            |
| Artifact    | One publishable output as a record of (kind, coordinates, content digest) (A4, R6).                                                                                                                                                                                                                           | kernel value      | Belongs to a release's immutable generation; digest is content identity, coordinates are labels (AR-03).                                                              | **LOCK**            |
| Transition  | A guarded, attributed lifecycle state change on a release, channel, or attempt; the guard/attribution/record machinery is domain-shaped and execution-side — never `core/domain/` — and the specific state vocabularies are per-workflow policy data (taxonomy §1.14; ADR-0001's consequence on transitions). | execution concept | The unit of durable state change; channels move only as transitions (PR-04).                                                                                          | **LOCK**            |
| Hook        | User code attached as a step in an attempt's step list, with declared pre- and postconditions; it can never mutate a plan (model-c question c).                                                                                                                                                               | adapter           | Execution-side only; planning purity forbids it upstream.                                                                                                             | **LOCK** (ADR-0007) |

### Disposition notes

- **No term is rejected outright.** The rejections this vocabulary performs are
  the collapses refused below — each of the eleven names a concept the matrix
  stresses in its own right, and rejecting any one would orphan its scenarios
  (OBSERVED: the matrix's
  [stress analysis](release-scenarios.md#stress-analysis) rows each map to at
  least one locked term).
- **Hook is locked (ADR-0007).** The taxonomy's adapter classification held
  ("user code must never enter the pure kernel"), and the direction held — an
  execution-side step, never a planning participant; the hooks runtime stays
  out of the engine per [#13](https://github.com/ecoma-io/release-craft/issues/13).
  The trigger fired when the execution phases designed the attempt step list,
  and ADR-0007 locks the seam: hooks as steps with declared pre/postconditions
  attached at the execution side (never in a plan), plan-mutating hooks
  refused by construction, the scheduler classification-driven, and the
  runtime itself left to the adapter phases.
- **Kernel values versus policy.** Locking `ReleaseLine` and `Channel` as
  kernel values does not move policy into the kernel: the values carry
  identity, stream state, and pointers as pure data; what a line releases, its
  ladders, and its bump mapping are planning-side policy data the planner
  reads (D5; ADR-0001 consequence on release policy).

The matrix's remaining canonical terms are locked with it, by reference
(OBSERVED:
[canonical vocabulary](release-scenarios.md#canonical-vocabulary)): **range**
and **prerelease stream** and **released-version pointer** and **decision
record** are planning concepts (inputs and the planner's second output);
**release attempt**, **execution ledger**, **claim**, **artifact generation**,
and **evidence** are execution concepts. No term outside this vocabulary may
enter a Phase 1 or Phase 2 contract silently — that is the vocabulary-drift
risk the decision log carries, and the reason this table exists.

### Identity separations

Six collapses are refused explicitly; each is one sentence grounded in the
matrix.

1. **Branch ≠ ReleaseLine.** Line 1.x is fed by both `main` and `release/1.9`
   at once, and survives a feed branch's rename as the same line with the same
   history — a ref cannot be that identity (S-03, M-10, S-05).
2. **Version ≠ Release.** The same number `1.9.1` legitimately names an event
   on line 1.9 while a stale plan proposes it on `main` — the engine must keep
   both facts apart, which version equality cannot express (M-11, E-11).
3. **Channel ≠ Branch.** A rollback re-points `stable` from `1.2.0` to `1.1.9`
   as a recorded, CAS-guarded event with no branch operation anywhere in it —
   deliverability and source scoping never share an identity (PR-04; taxonomy
   R1's npm dist-tag evidence).
4. **Prerelease ≠ version flag.** A `feat` landing mid-RC must bump the rc
   sequence (`rc.1` → `rc.2`), which no boolean on any version or line can
   compute — the flag is a value property; the stream is line policy (P-04,
   P-02, P-06; ADR-0001 decision 7).
5. **ReleasePlan ≠ execution.** A retried workflow must execute the same
   frozen plan rather than recompute it, and a superseded plan closes without
   any attempt existing — the plan is an object consumed by execution, not the
   execution itself (E-05, PL-08).
6. **Artifact ≠ Release.** One release carries three artifacts with
   independent per-artifact states, and a deliberate rebuild under one version
   name is a second _generation_, not a second release — content identity is
   the digest, and the release is the entity that owns generations (AR-01,
   AR-03, PR-02).

## Architectural invariants

Fifteen invariants; each is one testable sentence, the scenario ids that stress
it, and the first phase that can prove it executable (Phase 1 = kernel values;
Phase 2 = the planner in `src/`; later = the execution phase). Phases 1 and 2
are per [#13](https://github.com/ecoma-io/release-craft/issues/13); every
"later" invariant is a design commitment now and becomes executable when
execution is scheduled.

1. **Trivial-path zero declaration.** A repository with one branch, no release
   configuration, and conventional commits releases end to end — version
   computed, plan or decision record produced, attempt executed, tag placed —
   without the user declaring a line, a channel, or a plan.
   _Stress: S-01, S-03, S-04, S-05. First provable: Phase 2 for the planning
   half (computed version, plan or decision record, zero declarations); the
   attempt-and-tag half is execution and proves out when execution is
   scheduled._
2. **Deterministic planning.** Given identical planning inputs — time and all
   policy digests included as input values — the planner returns a plan with an
   identical content fingerprint on every invocation, and never orders anything
   by wall-clock time. _Stress: E-05, E-10. First provable: Phase 2._
3. **Planning without side effects.** The planner mutates nothing outside its
   return value — no file, ref, pull request, registry, or network — so running
   it twice over the same inputs leaves the world exactly as it was.
   _Stress: E-05, PL-04 (the planner's own outputs are not foreign input; identified by the reserved `Release-Craft:` namespace and excluded before classification, surfaced — never invisible, D11),
   PL-08 (plans are consumed, never mutated). First provable: Phase 2._
4. **Negative decisions are records.** Every no-op, refusal, block, and
   withholding is returned as a decision record carrying its cause, evaluated
   range, and the policy version that produced it — never silence, an
   exception, or a silently dropped change; a refusal crosses the planning
   boundary as the record's own `blocked`/`refused` outcome (PL-05a), and
   PL-01's "unmapped commits are an error" names that record, not a thrown
   exception. _Stress: S-01, S-02, M-01, M-08, PL-01,
   PL-06, PL-07. First provable: Phase 2._
5. **Plan identity is its fingerprint.** Two plans with the same target version
   but different change sets, base bindings, or policy digests are distinct
   objects, and one supersedes the other — or an open plan is closed by a
   decision record — through a recorded relation rather than being edited in
   place. _Stress: PL-08, P-05, E-04, E-11. First
   provable: Phase 2 (execution's re-verification of the fingerprint is
   invariant 13's half)._
6. **Line-scoped version truth.** The next version on a line is derived from
   that line's own tag history — the manifest is a projection a plan may
   repair, never a source of truth — and no global _latest-version_ pointer
   participates in any computation. The global _tag namespace_ is a different
   structure and does participate: a plan verifies its target tag exists
   nowhere before execution (M-11), and regeneration detects the published
   version to re-target (PL-08). _Stress: S-03, S-05, M-02, M-07, M-08, M-09,
   P-02, P-07. First provable: Phase 2._
7. **Line and channel identity is not a ref name.** A release line and a
   channel are identified by stable ids, so renaming a feed branch or
   re-pointing a channel changes feed and binding data while every recorded
   identity, history, and membership survives unchanged. _Stress: M-10, S-03,
   S-05, PR-04. First provable: Phase 1 — identity equality across a feed
   rename is pure value behavior._
8. **Prereleases are streams, not flags.** Prerelease identity is the triple
   (line, target version, stream identifier) with per-stream numeric sequences
   ordered by SemVer precedence — a `feat` mid-RC bumps the sequence, never a
   boolean, never a string parse. _Stress: P-01, P-02, P-04, P-06, P-07. First
   provable: Phase 1 — stream-key and ordering value semantics over the
   kernel's `compare`. The stream state is kernel data carried by the
   `ReleaseLine` value; "prerelease stream" as a planning concept names the
   planner's view over that state, not a second home._
9. **Change identity survives transport.** A change's identity is stable across
   cherry-picks, reformatting, and content divergence — one logical fix on
   three lines is one change with three per-line release states — and identity
   is never derived from content hashes or fuzzy matching. _Stress: M-03, M-04,
   M-05, M-06, M-09, PL-04. First provable: Phase 1 — identity matching over
   recorded provenance is pure value behavior (the marker convention is
   adapter-side, open fork 8)._
10. **Promotion never fabricates content.** A promotion either re-points a
    channel or records a maturity reclassification with a `promoted-from` edge
    over unchanged content, and any rebuild is recorded as a new artifact
    generation — promoting never publishes _unrecorded_ new bytes under an
    existing version identity (final clause tightened at the execution
    contract, discharging D9's carried obligation —
    [ADR-0005](../adr/0005-execution-kernel.md); PR-02's deliberate rebuild as
    a new generation is the sanctioned escape). _Stress: P-03, PR-01, PR-02,
    PR-03. First provable: Phase 4 locks the clause contract-side; the digest
    records it compares are Phase 1 values, the promotion machinery is the
    artifact phase (7)._
11. **Claim before mutation.** Every mutating step of an attempt is preceded by
    an acquired claim scoped to the line (releases) or to (line, target,
    stream) (prerelease sequences), ownership is re-verified before each write,
    and the loser of a claim exits recorded, never silently. _Stress: E-07,
    E-08, M-11. First provable: later._
12. **Attempts are the idempotency key.** Every externally visible step is
    keyed by (attempt, step): replaying a completed step reports prior
    completion as a no-op, and completion with different content is classified
    as a conflict, not as success. _Stress: E-02, E-03, AR-01. First provable:
    later._
13. **Partial failure is ledger-recoverable, and attribution gates adoption.**
    A crashed or half-executed attempt is resumable by classifying its ledger —
    resume, void, or escalate is decided from recorded, attributed state — and
    externally visible state (a tag, a published artifact, a draft) is adopted
    as completed work only when it is attributable to the attempt, otherwise it
    blocks into a disposition registry. _Stress: E-01, E-02, E-06, E-09, AR-05,
    AR-06. First provable: later._
14. **Dependency propagation is declared and provable in the negative.** When a
    release changes a package that has dependents, the plan records the
    propagation edges and their topological order as declared content, and can
    state which packages did not move and why. _Stress: PL-02, PL-03, PL-05.
    First provable: Phase 2, gated on the package axis being scheduled (the
    matrix stamps the monorepo scenarios hypothetical-future)._
15. **Provider isolation.** Neither the kernel's values nor the planner's
    outputs name provider _state_ — branches, pull requests, GitHub Releases,
    dist-tag moves, registry contents, or runners; providers appear only as
    adapters that feed observations in and execute bindings out. Coordinates
    and channel bindings are opaque declared configuration labels (AR-03's
    registry coordinates included), never references a value or plan could
    dereference or mutate. _Stress: M-10, E-06, PR-04, AR-03. First provable:
    Phase 2 for the planner's output schema; the kernel half holds by
    inspection of `Version` today and must be asserted by Phase 1's tests for
    every new value — ADR-0001's import ban polices imports, not field
    naming._

## Complexity budget

### The trivial path

The contract: a repository with one branch and ordinary conventional commits
must be able to go from `main` to a released, tagged version **without
declaring a line, a channel, or a plan**. The conceptual path, traced with the
matrix's own scenarios:

- **Input end — `main` with nothing due.** The repository declares nothing; the
  engine derives the default line (fed by the default branch) and computes over
  it; a chore-only runway yields a recorded no-op decision, not an error
  (S-01).
- **The one decision the trivial path still asks.** The first-ever release is
  the single exception to zero-decision: S-02 demands an explicit recorded
  choice of `1.0.0` or `0.1.0` — silently deriving one is not valid — so the
  bootstrap release carries one recorded operator decision, still zero
  declarations.
- **Version truth without configuration.** The next version comes from the
  line's tag history even when the manifest has drifted and a second feed
  branch exists — no line registry was declared by the user (S-03).
- **The release.** A plain `fix` merge produces a patch plan, a changelog
  section, and a tag (S-04 — its scope-exclusion knob is policy, not a
  line/channel/plan declaration).
- **Even the second line is free.** A breaking change on `main` creates line
  2.x by policy default while line 1.x stays releasable — no declaration
  either side of the cut (S-05).
- **Tag end.** The attempt claims, tags, and records; the tag is the visible
  residue of a claim the trivial user never sees (S-04's expected artifacts;
  E-07's claim exists by construction, not by opt-in).

Both ends are named by the matrix: S-01 proves the degenerate input end
(nothing to release, zero configuration, still a recorded decision) and S-04
proves the release end (bare `main` to tag `1.0.5`). The safety machinery —
attempt identity, claims, ledger, fingerprints — is present on this path by
construction and invisible on it; the trivial user's concept count stays at
zero (OBSERVED: model-a's inherited property 5; model-c question d).

### The mechanism: defaults as data

The trivial path stays trivial through **defaults expressed as data, not
special cases**: the default configuration is a value in the same schema as any
declared configuration — one line with a default id fed by the default branch,
one default channel, the tag cursor as range policy, the Conventional Commits
bump mapping — and the planner consumes it through exactly the same function it
applies to a fully declared repository. There is no code path keyed on "single
line," no boolean for "simple mode," and no concept that materializes only when
named: additional concepts appear when _declared_ or when policy demands them
(S-05's line 2.x), never as a mode switch. This is testable precisely because
planning is deterministic (invariant 2): the default configuration is an input
like any other, so the trivial path cannot drift from the general one.

### What a complex repository may explicitly declare

Everything beyond the defaults is additive declaration in the same schema
(OBSERVED: the classes the matrix stresses):

- multiple release lines with feed mappings, lifecycles, and retirement (S-05,
  M-02, M-10);
- per-line policy, including prerelease forbidden on one line while required on
  another (M-08, P-07);
- prerelease streams and ladders per line and target (P-02, P-06);
- channels, their rollback posture, and promotion policies (PR-04, PR-05,
  P-03);
- dependency propagation policy over compatible ranges (PL-02, open fork 12);
- artifact sets and generations (AR-01, PR-02 — owned since the artifact
  phase, ADR-0008), with evidence freshness rules (PR-03) still carried;

### The honest cost

The bookkeeping floor is strictly heavier than release-please's two JSON files
plus PR labels (OBSERVED: baseline §5, §11.5; INFERENCE: model-c question d): a
plan artifact with an identity, a decision record on every no-op, per-step
ledger writes on multi-artifact releases. That is the price of E-01/E-02/E-07
class safety existing by construction instead of being bolted on after the
first half-published release. The budget's rule for paying it: the tax lands in
engine write volume, never in new user duties — the ledger stays append-only
and derivable-where-possible, with tags as the authoritative record (P-01's
state requirements; RECOMMENDATION: model-c question d). Where decision records
and ledgers persist is fixed by the git binding (fork 16's contract half,
ADR-0009): git-native, forward-only, byte-exact on reload — outside
`core/domain/` in any case; the reference mapping pins with the
implementation PR.

## Unresolved questions

Carried forward explicitly; each names what would resolve it. The matrix's
[seventeen open forks](release-scenarios.md#open-forks-this-matrix-deliberately-retains)
are the master list — these are the ones the chosen model leaves genuinely
open, with owners in phase terms. (Decision-log U4 and U6 are settled by this
document: U4 by the kind column above, U6 by the boundary table below.)

1. **Claim mechanism parameters** (fork 13). Tag-push CAS, lease with fencing
   tokens, or a lock service — and what re-verifies ownership after steps a tag
   cannot see. Resolved by: the execution phase's claim design, replayed
   against E-07/E-08. **Update (Phase 4, [ADR-0005](../adr/0005-execution-kernel.md)):
   the domain half is resolved — the claim–verify–write protocol over a claim
   store port, with the store's atomic accept as the deterministic collision
   adjudication and bounded sequence retry; the physical primitive (the
   tag-push CAS) stays deliberately open for the Phase 8 adapter ADR.**
   **Update (Phase 8 contract, [ADR-0009](../adr/0009-git-binding.md)):
   the physical half is resolved — the accept is the claim ref's
   check-and-set creation and the tag is minted at the binding's door
   under the held claim (ADR-0009 §2.3); fixtures pin with the
   implementation PR.**
2. **Ledger and decision-record storage; persistence versus recomputation**
   (fork 16). Resolved by: Phase 2's decision records needing a home — the
   constraint that it stays outside `core/domain/` (ADR-0001) is already
   fixed. **Update (Phase 8 contract, [ADR-0009](../adr/0009-git-binding.md)):
   the contract half is resolved — persistence is the git binding
   (ADR-0009 §2.2): canonical form, forward-only history, byte-exact
   reload, one discipline for ledger, register, and decision records,
   outside `core/domain/`; the reference mapping pins with the
   implementation PR.**
3. **Half-published recovery doctrine** (fork 5). Complete-in-place versus
   void-and-skip, and which failures force which. Resolved by: the execution
   phase against E-01, E-02, AR-05.
4. **Change-id marker convention** (fork 8). The cherry-pick trailer, a footer
   change-id, or both. Resolved by: the Change value's provenance parsing in
   Phase 1's adapter work — under the invariant that no fuzzy matching is ever
   admitted (M-05).
5. **Bootstrap default and its record** (fork 2). `1.0.0` or `0.1.0`, and
   where the choice is recorded. Resolved by: default-policy design in Phase 2
   — S-02's demand for an explicit recorded decision is not negotiable away.
   Fork 1 (chore-only history: recorded no-op versus a chore-triggered
   release) is carried by the same Phase 2 default-policy design and is
   stressed by S-01 and PL-06.
   Fork 6 (rollback posture — channel move only, or a first-class re-release)
   is resolved to its default here — rollback is a recorded channel move that
   hides, never erases (PR-04); a first-class re-release, if ever wanted, is a
   new release through the same planner. Fork 14 (one stale-plan policy or
   several) is resolved to invariant 5's single rule: supersession is one
   recorded relation, whatever invalidated the predecessor.
6. **Stream restart on target move; fixed ladder or open identifiers** (forks
   3, 4). Resolved by: the line-policy schema in Phase 2 (P-05, P-02, M-08).
7. **Nightly as line-release or artifact class** (fork 15). Resolved by: the
   scheduling of channels and artifacts (AR-04, E-10).
8. **The package axis and per-package tag naming** (fork 11). The matrix stamps
   the monorepo scenarios hypothetical-future. Resolved by: the scheduling
   decision that activates PL-01..PL-05 and M-11's tag-namespace rule.
9. **Breaking-on-non-releasing-type; dependent bumps on compatible ranges**
   (forks 10, 12). Resolved by: planning policy in Phase 2 (PL-05b, PL-02).
10. **Range-cursor discard protocol** (fork 9). The cursor invariant is
    confirmed; who may explicitly drop a withheld change is open. Resolved by:
    Phase 2's withholding records (PL-07, M-10).
11. **Evidence TTL ownership** (fork 7). Resolved by: the evidence-bundle
    design in the execution phase (PR-03).

## release-please compatibility boundary

Distilled from the baseline's own boundary and classification
(OBSERVED: [baseline §18](release-please-baseline.md#18-compatibility-boundary),
[§17](release-please-baseline.md#17-classification-table-release-craft-implications));
this table settles decision-log U6. "Preserve" and "adapt" name observable
behaviors release-craft commits to keeping conceptually; "break" is an explicit
departure. The rule behind the table: release-please is a behavioral baseline
to preserve or break with by decision — never an architecture to depend on
(decision-log R1).

| #   | release-please observable                                                               | Boundary | release-craft's commitment                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Conventional Commits signal: `feat` → minor, `fix` → patch, `!`/BREAKING CHANGE → major | Preserve | Default change classification in planning; same observable rules (baseline §17 KEEP).                                                                                                                                       |
| 2   | `Release-As` footer forces an exact version                                             | Preserve | Plan-input override with the same footer semantics.                                                                                                                                                                         |
| 3   | Pre-1.0 dampening (breaking bumps minor before 1.0.0)                                   | Preserve | Line-policy default with the same config knobs.                                                                                                                                                                             |
| 4   | CHANGELOG in conventionalcommits preset format                                          | Adapt    | Same output format, internally owned template — no external preset dependency (baseline §17 ADAPT).                                                                                                                         |
| 5   | Release PR lifecycle `autorelease: pending` → merge → tag → tagged                      | Adapt    | The PR becomes one carrier of a `ReleasePlan`; non-PR flows exist; plan fingerprints and supersession replace label state (PL-08, model-b salvage).                                                                         |
| 6   | Monorepo grouped or separate releases, per-package tags                                 | Preserve | Package axis in planning, grouped and per-package both expressible — grouping rules generalize beyond path-based per baseline §17's ADAPT on grouped releases (hypothetical-future stamp governs scheduling; PL-01, PL-02). |
| 7   | Tag format knobs (`<component>-v<version>`, `include-v`, separators)                    | Preserve | Adapter-level formatting; the kernel parses the bare version component (open fork 11).                                                                                                                                      |
| 8   | Version state in a source-controlled file that survives runs                            | Adapt    | Same concept — durable per-line released state — as line registry and decision records; line tag history outranks any manifest projection (S-03).                                                                           |
| 9   | Extra-file version updates (jsonpath/xpath/annotations)                                 | Preserve | Declared file operations in the plan.                                                                                                                                                                                       |
| 10  | Dependency-aware bumping (workspace plugins)                                            | Adapt    | Generic propagation over a declared dependency graph, not tied to npm or cargo (PL-02; baseline §17 ADAPT rows).                                                                                                            |
| 11  | Two-JSON-file manifest + config state model                                             | Break    | release-craft's own state shapes: line registry, decision records, ledger — the two-file model is release-please-specific (baseline §18.2-1).                                                                               |
| 12  | GitHub-coupled lifecycle (PR + GitHub Release as the path)                              | Break    | Providers are adapters; plans and attempts name no GitHub concept (invariant 15; baseline §18.2-2).                                                                                                                         |
| 13  | Language-specific versioning strategies (node/python/rust/maven)                        | Break    | Generic strategy model with pluggable file updaters (baseline §18.2-4); snapshot/service-pack out of scope (§18.2-5).                                                                                                       |
| 14  | Prerelease asymmetry: minor/major bump drops the prerelease suffix                      | Break    | Streams compute the next prerelease per (line, target, stream) — the asymmetry is corrected by construction (invariant 8; baseline §18.2-6; P-04).                                                                          |
| 15  | `autorelease:` label as in-progress state                                               | Break    | Attempt + ledger state instead — the stuck-label failure mode is the thing being replaced (baseline §11.5, §18.2-8; E-01, E-02).                                                                                            |
| 16  | Fork-mode PR creation                                                                   | Break    | CI orchestration concern, out of the domain (baseline §18.2-7).                                                                                                                                                             |
| 17  | Idempotent re-run after failure                                                         | Adapt    | Strengthened: idempotency keyed by (attempt, step) with verified done-ness, not ambient inference (invariants 12, 13; baseline §11.1).                                                                                      |
| 18  | Compute-at-merge (no stored plan)                                                       | Adapt    | Plans are stored, fingerprinted, and re-verified — execution re-verifies rather than recomputing (invariants 5, 13; PL-08, E-05).                                                                                           |

Rows 1–18 track the baseline's §18 boundary items; the baseline's §17
classification table is wider, and every §17 row not named above **inherits
its baseline classification** (KEEP → preserve, ADAPT → adapt, OUT OF SCOPE →
break) until a later decision explicitly breaks it — draft-PR support, PR
title patterns, per-package config overrides, `initial-version`,
`bootstrap-sha`/`last-release-sha`, `linked-versions`, the `always-bump-*`
family, `force-tag-creation`, the `skip-*` toggles, `separate-pull-requests`,
`always-update`, `sequential-calls`, `BEGIN_COMMIT_OVERRIDE`,
`group-pull-request-title-pattern`, `sentence-case`, `changelog-sections`,
the revert filter, search depths, and GitHub Action wiring included. No row
is silently dropped: a Phase 2 implementer finds a disposition for every §17
capability here or in §17 itself.
