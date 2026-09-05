---
id: 0002-release-model-and-domain-vocabulary
status: accepted
created: 2026-09-05
updated: 2026-09-05
---

# The release model is Model C′: pure planning, stateful execution, a locked vocabulary

## Status

Accepted, 2026-09-05. This record is the decision of Phase 0's synthesis
(tasks 0F+0G of [#13](https://github.com/ecoma-io/release-craft/issues/13));
[ADR-0001](0001-domain-kernel-and-semantic-version.md) remains the source of
truth for the kernel boundary and the `Version` contract, and this record
governs everything above it: the release model, the domain vocabulary, and the
architectural invariants. Where this record and
[`release-model.md`](../design/release-model.md) overlap, the model document
elaborates and this record decides. Changes to any decision here update this
record in the same PR, in the registry dialect.

## Context

Phase 0 existed because [#13](https://github.com/ecoma-io/release-craft/issues/13)
refuses to invent release concepts ad hoc: prerelease streams, release lines,
hooks, artifacts, and promotions are exactly the concepts a naive releaser
gets silently wrong, and building them without evidence was the rejected
alternative (decision-log R2). The evidence base is the adversarial scenario
matrix — 53 concrete situations a naive model answers wrongly or cannot
represent, each carrying expected behavior and the abstraction it stresses
([`release-scenarios.md`](../design/release-scenarios.md)) — plus three
independent model evaluations run against it
([model-a](../design/_proposals/model-a.md),
[model-b](../design/_proposals/model-b.md),
[model-c](../design/_proposals/model-c.md)), the process taxonomy that locks
the concept relationships
([`release-taxonomy.md`](../design/release-taxonomy.md)), the release-please
behavioral baseline
([`release-please-baseline.md`](../design/release-please-baseline.md)), and
the repository audit ([`phase0-repository-audit.md`](../design/phase0-repository-audit.md)).
The decision below was made by rejection, not convenience: both losing models
are refused with the scenario ids that killed them, and the two losing
evaluators' own proposed alternatives converge on the winner's skeleton
(decision-log D4).

## Decision

### 1. The model: Model C′ = Model C + amendments A1–A7

A **release** is an entity with its own identity, minted on a release line
when a plan is executed — not a version string, not a publication event, not a
branch state. **Planning** is a pure, deterministic, side-effect-free function
from enumerated inputs (repository observations, parsed changes, release
history, line configuration, component metadata — time and policy digests as
input values) to `ReleasePlan | DecisionRecord`: plans are persisted,
inspectable, content-fingerprinted projections; decision records are first-class
negative outcomes (no-op, refusal, block, withheld) with cause, evaluated
range, and policy version. **Execution** is a separate stateful domain that
consumes plans and never recomputes them: each execution is an attempt with
its own identity, a claim on the next version before any mutation, and a
write-ahead ledger of attributed idempotent steps, with terminal states
including published, failed, superseded, and abandoned-by-human. The seven
amendments (model-c's A1–A7: decision records; change identity; claims;
artifact/generation/evidence schema; stable line identity; plan supersession;
attribution and foreign-state discipline) are part of the model. The single-line
trivial repository is the degenerate first-class configuration.

### 2. Layering: values in the kernel, planning in the package, execution later

The kernel (`core/domain/`) keeps value semantics only and gains exactly the
kernel-value kinds of the vocabulary (decision 4) in Phase 1; the planning
engine lives in `src/`, consuming kernel values (decision-log D5); execution
is a later, separate consumer. Policy resolution — ladders, stream advancement,
bump mapping — is planning-side data and code and stays outside `core/domain/`,
consistently with ADR-0001's consequence on release policy; the pure value
shapes policy judges are kernel values. The kernel entrypoint becomes a barrel
at the second Phase 1 primitive, amending ADR-0001 decision 8 in the same PR
(decision-log D6).

### 3. The guarantees are the fifteen invariants

The model's guarantees are recorded as fifteen numbered, testable invariants
with their stressing scenario ids and first-provable phases in
[`release-model.md` §4](../design/release-model.md#architectural-invariants):
trivial-path zero declaration; deterministic planning; planning without side
effects; negative decisions as records; plan identity by fingerprint;
line-scoped version truth; identity is never a ref name; prereleases are
streams; change identity survives transport; promotion never fabricates
content; claim before mutation; attempts as the idempotency key; partial
failure is ledger-recoverable with attribution gating adoption; dependency
propagation declared and provable in the negative; provider isolation. Each
Phase 1 and Phase 2 contract that lands must name the invariants it makes
executable; "later"-phased invariants are design commitments until execution
is scheduled.

### 4. The vocabulary

| Term        | Kind              | Disposition                                                                                                                                         |
| ----------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version     | kernel value      | LOCK — exists today (ADR-0001)                                                                                                                      |
| Change      | kernel value      | LOCK                                                                                                                                                |
| ChangeSet   | kernel value      | LOCK                                                                                                                                                |
| Bump        | kernel value      | LOCK — Phase 1 (decision-log D9): the enum ChangeSet's locked "the bump it implies" is expressed over; named here so it enters loudly, not silently |
| ReleaseLine | kernel value      | LOCK                                                                                                                                                |
| Channel     | kernel value      | LOCK                                                                                                                                                |
| Artifact    | kernel value      | LOCK                                                                                                                                                |
| ReleasePlan | planning concept  | LOCK                                                                                                                                                |
| Release     | execution concept | LOCK                                                                                                                                                |
| Promotion   | execution concept | LOCK                                                                                                                                                |
| Transition  | execution concept | LOCK                                                                                                                                                |
| Hook        | adapter           | DEFER — direction locked (execution-side step, never a planning participant); seam shape waits for the execution phase's step-list design           |

Definitions, relationships, per-term justifications, and the matrix's companion
terms (range, prerelease stream, decision record, release attempt, execution
ledger, claim, artifact generation, evidence, released-version pointer) are in
[`release-model.md` §3](../design/release-model.md#domain-vocabulary). No term
outside this vocabulary may enter a Phase 1 or Phase 2 contract silently.

### 5. Six identity separations are part of the decision

Branch ≠ ReleaseLine (S-03, M-10); Version ≠ Release (M-11, E-11); Channel ≠
Branch (PR-04); Prerelease ≠ version flag (P-04, P-02, P-06); ReleasePlan ≠
execution (E-05, PL-08); Artifact ≠ Release (AR-01, PR-02). One-grounded-sentence
justifications live in
[`release-model.md` §3](../design/release-model.md#identity-separations).

### 6. The complexity contract

A one-branch repository with no release configuration releases end to end —
`main` → release → tag — declaring zero lines, channels, or plans; the
mechanism is defaults expressed as data in the same schema as declared
configuration, never special-case code paths, and the same planner function
consumes both. Everything beyond the defaults (multiple lines, per-line
policies, prerelease streams, channels, promotions, dependency policies,
artifacts, hooks) is additive declaration. The full contract and its proving
scenarios (S-01, S-03, S-04, S-05) are
[`release-model.md` §5](../design/release-model.md#complexity-budget).

### 7. The release-please boundary

release-please is a behavioral baseline to preserve or break with by decision,
never an architecture to depend on. The committed table — preserve
(Conventional Commits signal, `Release-As`, pre-1.0 dampening, monorepo
grouping, tag-format knobs, extra files), adapt (changelog template, release
PR as one plan carrier, durable state file, dependency bumping, idempotent
re-run, compute-at-merge), break (two-JSON manifest, GitHub-coupled lifecycle,
language-specific strategies, prerelease asymmetry, `autorelease:` label state,
fork mode) — is
[`release-model.md` §7](../design/release-model.md#release-please-compatibility-boundary).

## Refused alternatives

- **Model A — a release is (branch, version)** (release-please's own shape).
  Rejected: its evaluation's tally grades 25 of the matrix's 53 scenarios
  FAILS, killed wholesale by the PROMOTION class (PR-01, PR-02, PR-03, PR-04,
  PR-05), execution state (E-01, E-02, E-03, E-06, E-09, plus AR-05), artifact
  identity (AR-01 through AR-06), stream identity (P-02, P-05, P-06), identity
  substrates (M-03, M-10, M-11), and the package axis (PL-01, PL-02, PL-03,
  PL-07). Amending it to competency reinstates the six locked concepts — the
  amendment is the successor, so Model A amended is not Model A. Five
  properties survive as inherited constraints: tag-derived recomputed state,
  compute at the last responsible moment, tag-push CAS as allocation
  primitive, per-line grain, and the zero-concept simple-repository path.
- **Model B — a release is one run of a linear pipeline.** Rejected: 15
  scenario FAILS (E-02, E-03, E-05, E-06, E-09; P-02, P-03, P-06; M-03, M-10;
  AR-05, AR-06; PR-01, PR-04, PR-05), with the worst outcome — completing a
  release a human aborted (E-09) — being its ambient-state idempotency's
  default behavior. The amendments it requires delete its defining properties
  (stage-position progress, ambient-state idempotency), which is the rejection
  rule it fails. Salvaged: the eight-stage pipeline as the default attempt step
  sequence, the tag push as claim primitive, the release PR as plan carrier,
  the tag cursor as default range policy, ambient state demoted to evidence.
- **Evaluator-proposed alternatives.** Model A's evaluator proposed the
  taxonomy's vocabulary made executable; model B's evaluator proposed
  "claim-guarded line transitions"; both converge on Model C's skeleton, which
  is evidence for the skeleton rather than a competing model. Model C's
  evaluator proposed no superior model, offering C′. Adopting release-please's
  internal architecture as the domain model was rejected before evaluation
  (decision-log R1).
- **Refusing the vocabulary lock (deferring all terms).** Rejected: the
  vocabulary-drift risk the decision log carries (High/High) is exactly
  "Phase 1 invents prerelease/branch/hook concepts ad hoc" — the drift this
  phase exists to prevent.

## Limitations, stated honestly

- **Nothing decided here is implemented.** Phase 0 ships design documents only
  (decision-log D0); the tree holds `Version` alone. Every Phase 1/2 statement
  here is intent with a named phase, not a shipped capability; the README's
  status section remains the honest one.
- **Five of the fifteen invariants are unexecutable today and stay so until
  the execution phase is scheduled:** the attempt-and-tag half of invariant 1,
  claim before mutation, attempts as idempotency key, partial-failure recovery,
  and promotion-without-fabrication are design commitments whose proving
  scenarios (S-04, E-01, E-02, E-06, E-07, E-08, E-09, PR-01..PR-03) no
  current code can run. Invariant 1's planning half (zero declarations, plan
  or decision record) is Phase 2 work.
- **The model does not decide its hardest parameters.** Claim mechanism
  (fork 13), ledger and decision-record storage (fork 16), recovery doctrine
  (fork 5), change-id convention (fork 8), bootstrap default (forks 1–2), and
  the package axis's scheduling are open; Model C′ is the framing in which
  deciding them is a parameter change, not a redesign. The carried list with
  resolvers is [`release-model.md` §6](../design/release-model.md#unresolved-questions).
- **The compatibility boundary is conceptual, not drop-in.** "Preserve" means
  the observable behavior survives with release-craft's own mechanisms; a
  release-please configuration does not migrate unattended, and the baseline's
  §17 verification caveats (e.g. revert-filter parity) remain homework for the
  phases that build those behaviors.
- **Counts in this record belong to their artifacts.** Scenario tallies cited
  here are the evaluation documents' own; prose claims no test, line, or
  document counts (decision-log D2).

## Consequences

- **Phase 1 builds the kernel-value kinds — and only them:** `Change`,
  `ChangeSet`, `ReleaseLine`, `Channel`, `Artifact` beside the existing
  `Version`, each under ADR-0001's three-layer purity and three-row law with
  no new configuration. This settles decision-log U4. The Phase 1 PR carries
  ADR-0001 amendments together (D6): the decision-8 barrel amendment, and
  annotations reconciling decision 7's rationale ("the kernel does not know
  channels exist" — the values now do, the progression policy still does not)
  and the consequences' parenthetical on lines, channels, and transitions
  staying outside `core/domain/` — which governs policy resolution, not the
  pure value shapes locked here. Any new source root sweeps `SOURCES` in the
  same PR (D3).
- **Phase 2 builds the planner in `src/`:** the pure function with the
  `ReleasePlan | DecisionRecord` codomain, line-scoped tag-history truth,
  plan fingerprinting and supersession, and the default configuration that
  keeps the trivial path at zero declarations. The planner itself stays pure;
  wherever decision records persist (fork 16), persistence lands as a thin
  package-layer writer around the planner — never inside `core/domain/`.
- **What stays out, per [#13](https://github.com/ecoma-io/release-craft/issues/13):**
  the hooks runtime (deferred vocabulary decision above), artifact publishing,
  GitHub Releases, resumable execution, and prerelease publishing. None of
  these may appear in a drive-by change; each lands through its own issue and
  design, against the invariants that already govern it.
- **Vocabulary is contract.** Every Phase 1 and Phase 2 contract, test, and
  doc must use the locked terms verbatim and with their locked meanings; a
  term redefinition is a change to this record. Any new term enters through
  this record's amendment, never silently.
- **Execution arrives as a separate design** that consumes plans and must
  carry invariants 10–13; until then, this record's execution half is the
  contract any such design is reviewed against.
- **The scenario matrix remains the stress test.** Any future model-level
  change is re-run against the matrix's scenarios, and every new invariant
  must name the scenarios that stress it (decision-log scenario-coverage
  rule).
