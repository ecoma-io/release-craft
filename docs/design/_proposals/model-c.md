# Model C — release as stateful execution of a release plan

> **Status: Phase 0 discovery (task 0E-c, orchestrated run for issue #13).**
> This document evaluates Model C against the reconciled scenario matrix
> (`docs/design/release-scenarios.md`, branch `johnitvn/phase0-reconcile`,
> 53 scenarios) with the process taxonomy (`docs/design/release-taxonomy.md`,
> branch `johnitvn/phase0-taxonomy`) and the release-please behavioral
> baseline (`docs/design/release-please-baseline.md`, branch
> `johnitvn/phase0-rp`) as secondary evidence. It proposes nothing shipped;
> the only domain object in the tree is the `Version` value
> ([ADR-0001](../../adr/0001-domain-kernel-and-semantic-version.md)). The
> README's status section remains the honest one.

## Evidence labels

As in the companion Phase 0 documents: **OBSERVED** — taken directly from a
file or source read this session (cited by document and scenario id);
**INFERENCE** — reasoned from observed facts; **RECOMMENDATION** —
release-craft's position, argued, not observed.

Throughout, "the matrix" is the reconciled scenario master named above; "the
taxonomy" is the process taxonomy; "the baseline" is the release-please
behavioral baseline. All three live on their own Phase 0 branches, so they are
cited by name and branch, not by relative link — `check:docs` refuses links
that do not resolve on this branch.

## The model under test

Stipulated definition (OBSERVED — this is the assigned Model C, restated):

- **Planning** is a pure, deterministic, side-effect-free function:
  (repository observations, parsed changes, release history, release-line
  configuration, component metadata) → a **ReleasePlan** — an explicit,
  inspectable, serializable artifact that records what should release, on
  which lines, at which versions, from which source state, carrying which
  changes, with which dependency propagation, which artifacts are declared,
  and which future transitions are required.
- **Execution** is a separate stateful process that consumes a plan, gives
  each release attempt its own identity, records lifecycle transitions
  durably, and can be resumed/retried idempotently.
- **Releases are entities with identity** distinct from their version
  strings.
- **Release lines** are ordered version streams configured independently of
  branches.
- **Channels** are mutable pointers managed as transitions.
- **Prerelease progression** belongs to line/channel policy (ADR-0001
  decision 7), not to `Version`.

## Steelman — the strongest honest case

1. **It is the industry's implicit shape, made explicit.** (INFERENCE from
   the baseline, OBSERVED facts: §4 release-PR lifecycle
   `autorelease: pending → tagged`, §13 the action's two-step
   `release-pr` / `github-release` wiring.) release-please already separates
   "compute the release" (the PR, reviewable, regenerated on new commits)
   from "perform the release" (tag + GitHub Release after merge). Model C
   does not invent a workflow; it names the two halves users already know.
2. **Planning purity is not a luxury — the matrix demands it.** (OBSERVED:
   E-05 "Retry must reproduce the same plan (time is an input)": the retry
   executes the same plan because the plan enumerated and froze its inputs;
   E-04 requires verdicts to be re-provable against a current policy digest,
   never cached.) A model that starts pure has E-05 by construction; a
   monolithic releaser has to retrofit purity under stress.
3. **The split is exactly where failure lives.** (OBSERVED: the matrix's own
   stress analysis ranks "multi-step transaction: attempt + ledger + claims"
   at 8 scenarios — E-01, E-02, E-07, E-08, AR-01, AR-02, AR-05, AR-06 — and
   "release plan as a first-class, invalidatable object" at 6.) Model C
   carries both of the two hardest abstraction families as native structure:
   plans as artifacts, attempts as identified executions with durable
   transitions.
4. **Identity questions are answered up front.** (OBSERVED: taxonomy R2 —
   release is an entity with its own identity, version equality is not
   release identity; matrix M-11, E-11 both turn on "same version number ≠
   same release".) Model C stipulates release identity distinct from version
   strings, so M-11 and E-11 have somewhere to live instead of something to
   survive.
5. **The line/channel/prerelease stipulations match the locked vocabulary.**
   (OBSERVED: taxonomy R1 — line, channel, branch are three concepts; R3 —
   the prerelease flag is kernel, stream position is line policy; ADR-0001
   decision 7 — next-prerelease is release-line policy.) Model C's
   stipulations restate the reconciled positions; it starts aligned with the
   taxonomy instead of needing to be bent toward it.
6. **The complexity tax on trivial repos is a fixed, small cost.**
   (INFERENCE.) A single-line repo needs: one line, one planning call, one
   attempt with a handful of ledger steps. Attempt ids, claims, and
   supersession machinery are invisible on the happy path — they cost design
   now, not user attention later. The user-facing concept count (line, plan,
   release, channel) is the same as the vocabulary lock requires of any
   compliant model.

Honest limits of the steelman: "zero new concepts" is **not** true of Model C
— plans, attempts, and ledgers are new concepts relative to a tag-and-changes
releaser (OBSERVED: the baseline's release-please state is two JSON files and
PR labels, §5, §11.5). And the model as stipulated is silent on four things
the matrix makes mandatory: negative decisions, change identity, allocation
claims, and artifact generations. Those become the amendment list below.

## The matrix, class by class

Disposition marks: **clean** — the stipulated model represents the scenario
without invention; **needs A-N** — representable only after amendment A-N
(defined in the verdict section); **fail** — not representable. Every one of
the 53 scenarios is dispositioned.

### SIMPLE (S-01 – S-05)

| Scenario | Disposition | Note                                                                                                                                                                                                                     |
| -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S-01     | needs A1    | The chore-only runway's answer is a recorded no-op — not a plan. Planning's single-output signature cannot carry it.                                                                                                     |
| S-02     | needs A1    | Bootstrap's "hard stop with a named decision required" is a decision record, not a plan; the chosen initial version then becomes plan input.                                                                             |
| S-03     | needs A5    | Plan binds base to the line's tag-derived head (`1.9.5`), never the manifest; the manifest is an observation the plan repairs. "Line tag history is the truth" plus the recorded line→branch feed mapping are A5's data. |
| S-04     | clean       | Bump-relevant and note-relevant classifications are per-change plan content; the empty-notes section is plan output.                                                                                                     |
| S-05     | needs A5    | The line registry (both lines, feed branches, heads) is A5's data; once present, per-line independent computation is native and interleaved tags never cross-couple (N1 answered structurally).                          |

The SIMPLE class is Model C's softest test and it still requires A1: the
class's two degenerate shapes (nothing to release; nothing to decide with)
both demand a first-class negative outcome.

### PRERELEASE (P-01 – P-07)

| Scenario | Disposition | Note                                                                                                                                                                                                              |
| -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-01     | clean       | Stream head recomputation is SemVer precedence over `1.2.0-alpha.*` tags (kernel `compare`, ADR-0001 decision 6); "which alpha is next" is line policy feeding the pure planner.                                  |
| P-02     | clean       | Ladder transitions are line policy; the plan records the stream transition and the inherited change set; the refuse-beta-while-rc-live case is a refusal (A1 records it).                                         |
| P-03     | clean       | Promotion-as-release-event: plan targets `1.2.0` with the rc's change set; the `promoted-from` edge and channel membership are execution transitions — exactly what "channels managed as transitions" names.      |
| P-04     | clean       | Sequence bump via line policy; the plan's change set grows; "rebuild rc.1" refusal is recorded (A1).                                                                                                              |
| P-05     | needs A6    | The target moving under the plan is plan supersession; the abandoned `1.2.0-rc.*` stream keeps lifecycle state `orphaned-prerelease`. Supersession must be a durable, causal relation, not an implicit overwrite. |
| P-06     | clean       | Per-stream heads are line state derivable from tags (planning input); the ambiguity error listing live streams is plan-side; the breaking-collapse detection (both streams re-key to 2.0.0) is a planning rule.   |
| P-07     | clean       | Line-scoped computation is native — lines are configured independently of branches; `1.2.4-rc.0` comes from the `release/1.2`-fed line while 2.x is untouched.                                                    |

PRERELEASE is Model C's strongest class: the stipulation pre-assigns
prerelease progression to line policy, which is exactly the seam the matrix's
M-08 names as "ADR-0001's first consumer" (OBSERVED: M-08 expected-behavior
note; ADR-0001 decision 7).

### MULTI-LINE (M-01 – M-11)

| Scenario | Disposition    | Note                                                                                                                                                                                                                        |
| -------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M-01     | clean          | Attribution by ancestry is a planning input rule; `main`'s empty effective change set yields a no-op (A1 records it).                                                                                                       |
| M-02     | clean          | Three independent per-line plans (or one plan with three line-scoped releases); no global next-version pointer exists in the model to misuse.                                                                               |
| M-03     | needs A2       | One logical fix as F/F′/F″ demands change identity distinct from SHA and content hash, with machine-readable provenance. Model C is silent on this.                                                                         |
| M-04     | needs A2       | Releasedness per (line, change) requires the change identity of A2; with it, "F stays pending on main" is representable.                                                                                                    |
| M-05     | needs A2       | Lineage surviving divergent payloads is A2's provenance; the model must refuse fuzzy matching (RECOMMENDATION, from the matrix's identity requirements).                                                                    |
| M-06     | needs A2       | "Released on main, not on 1.9" is A2 plus per-line release history — the plan/execute split contributes nothing here and nothing is missing either.                                                                         |
| M-07     | clean          | Ranges from the line's own tags are planning inputs; `main`-relative diffs never enter the model.                                                                                                                           |
| M-08     | needs A1       | Per-line policy resolution is planning; the refused prerelease request on 1.9 is a recorded refusal, not an exception.                                                                                                      |
| M-09     | needs A2       | `{1.9.1, 2.3.1}` as one change's released-version set is A2's mapping; suppression stays per-line.                                                                                                                          |
| M-10     | needs A5 (+A1) | Line identity independent of ref name is implied by "configured independently of branches" but must be explicit: a stable line id, rename as data, retirement as lifecycle state; the post-retirement fix is withheld (A1). |
| M-11     | clean          | The plan verifies its target tag against the global namespace before mutation — an execution precondition in Model C's structure (the concurrent variant is A3).                                                            |

The MULTI-LINE class exposes the stipulation's biggest genuine hole: Model C
names "parsed changes" as planning input but never says what a change _is_.
The matrix's stress analysis ranks "change identity ≠ SHA ≠ content hash" at
7 scenarios (OBSERVED: M-03, M-04, M-05, M-06, M-09, PL-04, PL-05) — the
model must carry that identity to dispose of the class.

### PLANNING (PL-01 – PL-08)

| Scenario | Disposition    | Note                                                                                                                                                                                                                                                       |
| -------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PL-01    | needs A1       | Scope/path attribution is an explicit, total mapping in the planning inputs; unmapped commits block the plan, and the block is a recorded decision (A1).                                                                                                   |
| PL-02    | clean          | Dependency propagation is a declared plan field; range math reads manifests at plan time; topological order is plan content.                                                                                                                               |
| PL-03    | clean          | Negative evidence ("why nothing else moved") is plan output — the pure function can prove absence of reverse edges.                                                                                                                                        |
| PL-04    | needs A2       | Recognizing the planner's own release commit requires the deterministic bot marker as part of change classification (A2's identity/provenance family).                                                                                                     |
| PL-05    | needs A1 (+A2) | Scope clash blocks the plan with an ambiguity report (A1); breaking-chore and merge dedup are classification rules (A2).                                                                                                                                   |
| PL-06    | needs A1       | The empty change set's first-class no-op is the planner's second output kind; the range-cursor deferral invariant holds because no tag was placed.                                                                                                         |
| PL-07    | needs A1       | Withholding is a durable pending-withheld record keyed (commit, line, rule); it must survive into later planning runs, so the decision store is persistent (fork 9's discard protocol attaches here).                                                      |
| PL-08    | needs A6       | Stale-plan detection, fingerprints (tip + sorted policy-relevant commits + bumps + base + policy digest), and supersession chains are the amendment; Model C's plans-as-artifacts is the right substrate but the invalidation machinery must be specified. |

The PLANNING class is where the pure function's shape shows both faces: it
makes staleness detection (PL-08) and negative evidence (PL-03) natural, but
its `→ ReleasePlan` signature cannot express "the correct output is a
recorded refusal" until the codomain is widened.

### ARTIFACTS (AR-01 – AR-06)

| Scenario | Disposition        | Note                                                                                                                                                                                                  |
| -------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AR-01    | needs A4           | Per-artifact states with a ledger-computed completion predicate need artifact records (kind, coordinates, digest) in the execution schema.                                                            |
| AR-02    | needs A4           | Verify-before-depend is a ledger step bound to the expected digest; the timeout-to-partial handoff is the resume path.                                                                                |
| AR-03    | needs A4           | Digest identity with moving tags as channels: the model has the channel half natively; the digest-recorded artifact half is A4.                                                                       |
| AR-04    | needs A4 (fork 15) | Nightly as a scheduled, non-release artifact class riding a channel — representable once artifacts are ledger records; whether a nightly allocates anything on the line stays the matrix's open fork. |
| AR-05    | needs A7 (+A4)     | The orphan tarball is adopted by evidence into a resumed attempt, or hard-stops on integrity mismatch — attempt identity plus write-ahead ledger discipline plus an adoption record.                  |
| AR-06    | needs A7 (+A4)     | Drafts as attempt-owned intermediate states with per-state attribution; foreign drafts escalate (A7's attribution discipline).                                                                        |

### EXECUTION (E-01 – E-11)

| Scenario | Disposition         | Note                                                                                                                                                                                                                   |
| -------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E-01     | clean (+A3 framing) | Recovery maps tag existence → ledger state → complete-in-place / escalate / void-and-skip; the tag is read as a claim on the version. The classification doctrine itself is fork 5, deliberately open.                 |
| E-02     | clean               | Resume is the ledger query "which steps are verified-done"; adoption verifies digests; conflicting done is distinguishable from matching done.                                                                         |
| E-03     | clean               | Satisfied-externally vs conflict is an execution classification with provenance; the idempotency key (plan id + target) is native to plans-as-artifacts.                                                               |
| E-04     | needs A6            | Policy-flip revalidation re-proves the plan's recorded policy digest at execute time and blocks with the delta — execution re-verifies, re-planning recomputes; the split assigns each half to the right process.      |
| E-05     | clean               | Planning purity with enumerated, frozen inputs (time included) is Model C's defining constraint; the plan-hash equality proof is native.                                                                               |
| E-06     | needs A7 (+A1)      | The foreign `v1.4.2` tag blocks the attempt as unattributed state; adoption/void/abort is a human decision record. Resume-by-inference is structurally unavailable because execution consumes plans, not observations. |
| E-07     | needs A3            | The claim-before-mutation protocol (CAS/lease, fencing, re-verify ownership before each write) is absent from the stipulation; without it both runners tag and publish.                                                |
| E-08     | needs A3            | Sequence allocation claim scoped to (line, target, stream) with bounded retry; injectivity checked at write time.                                                                                                      |
| E-09     | needs A7 (+A1)      | Abandoned-by-human is a terminal attempt state; the orphan tag goes to a disposition registry; the abort outranks automation and is persisted.                                                                         |
| E-10     | clean               | Topology-only ordering and frozen stamp inputs are planning-purity rules; stamps are labels, never sequence numbers.                                                                                                   |
| E-11     | needs A6            | Two-axis staleness (base and tip) re-derived at execution; P1 superseded, P2 re-planned over `1.4.2..xyz789`; version equality never short-circuits plan equality.                                                     |

EXECUTION is Model C's other home class — eight of eleven scenarios land on
native structure — but E-07/E-08 are the sharpest refutation of the
stipulation as written: durable transitions and attempt identity do not
serialize allocators. Concurrency needs its own primitive.

### PROMOTION (PR-01 – PR-05)

| Scenario | Disposition    | Note                                                                                                                                                                                                                                                                                |
| -------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR-01    | needs A4       | Promotion-without-rebuild binds identity onto an existing, digest-verified generation — the ledger must hold recorded digests to compare.                                                                                                                                           |
| PR-02    | needs A4       | Deliberate rebuild with two generations (`gen-1` rc bytes, `gen-2` stable bytes) linked to one release requires a generation table per release.                                                                                                                                     |
| PR-03    | needs A4 (+A1) | Evidence bundles (digest, kind, validated-at) with policy TTLs; the stale → revalidation-required → validation-failed chain stays a blocked-but-resumable state.                                                                                                                    |
| PR-04    | clean          | Backward channel moves are transitions — recorded events with expected-prior-state CAS and rejected stale replays; the served-window query is a query over the transition log. The stipulation's "channels are mutable pointers managed as transitions" is this scenario, verbatim. |
| PR-05    | clean          | Membership-over-time is the (release, channel, from, to, cause) edge list derived from channel transitions; retraction removes future membership, never history.                                                                                                                    |

### Tally

OBSERVED count over the 53 dispositions above: **clean 20, needs-amendment
33, fail 0.** Rows may need more than one amendment (M-10 needs A5+A1; the
ARTIFACTS rows pair A4 with A7), so the per-amendment scenario lists in the
verdict section sum to more than 33. No scenario is unrepresentable; no
amendment touches the planning/execution split itself.

## The six fixed questions

**(a) Where do branch/channel semantics leak into core?**
INFERENCE: structurally nowhere — the stipulation pre-empts all three
classic leaks. Branch-as-line is blocked by "lines configured independently
of branches" (the branch survives only as a feed mapping inside planning
inputs: S-03's line fed by `main` and `release/1.9`, M-10's rename-as-data).
Channel-as-version is blocked by "channels are mutable pointers managed as
transitions" (PR-04, AR-03). Version-becomes-policy is blocked by ADR-0001's
purity rows — the kernel cannot know channels exist (OBSERVED: ADR-0001
decisions 2 and 7). The two real discipline points are (1) the planning
input schema must key observations by line id, never by branch name, or
S-03/M-10 fail re-enter through the back door; (2) line policy (streams,
ladders, channels) must stay declared data the planner reads, never code in
the planner's signature. RECOMMENDATION: enforce (1) by making the
line→branch feed mapping an explicit plan input field.

**(b) Is failure/recovery representable?**
Yes — it is the model's center of gravity. OBSERVED: E-01/E-02/E-05 and
AR-05 all resolve to "ledger + attempt identity + plan artifacts", which is
Model C's native vocabulary; the baseline shows the alternative —
release-please's stuck `autorelease: pending` label (§11.5) — is exactly a
missing attempt state machine, and its §18.8 compatibility break ("a more
robust in-progress release state that does not block on stale labels")
commits release-craft to one. Failure is a legal terminal attempt state;
recovery is classification from recorded state; resumption never recomputes
values (E-05), only re-verifies preconditions (E-04). What the stipulation
misses: recovery under _concurrency_ (E-07/E-08, A3) and recovery from
_foreign_ state (E-06/E-09/AR-05/AR-06, A7). Recovery doctrine choices
(complete-in-place vs void-and-skip, fork 5) remain open but representable.

**(c) Are hooks compositional?**
INFERENCE, with a RECOMMENDATION. In Model C hooks can only be execution-side
steps: planning is pure, so user code with side effects attaches to the
attempt's step list, gains ledger records, idempotency keys, and attribution
for free — more compositional than release-please's plugins, which mutate an
in-memory candidate list mid-pipeline and leave no per-step residue
(OBSERVED: baseline §12.3, plugins "receive the full monorepo context … and
can modify the candidate PR list"). The compositionality constraint is
real though: a hook cannot mutate the plan — plans are immutable artifacts —
so "a hook that wants a different version" must fail toward re-planning
(E-04's discipline), and a hook's effects must land in the ledger or resume
breaks (AR-05's lesson). RECOMMENDATION: name hooks as steps with declared
pre/postconditions; refuse plan-mutating hooks by construction.

**(d) Do simple releases stay simple — what is the complexity tax on a
trivial repo?**
The tax is fixed, mostly invisible, and front-loaded on the engine, not the
user. INFERENCE: a trivial repo's happy path is one line config, one planning
call, one attempt of a handful of steps; attempt ids, claims, supersession,
and generations never surface. The irreducible floor is bookkeeping the
naive model skips: a plan artifact with an identity even when no one reads
it; a decision record on every no-op (S-01 — though whether it persists or
is a reproducible computation is fork 16); per-step ledger writes for
multi-artifact releases. Compared honestly with release-please's floor (two
JSON files + PR labels, OBSERVED baseline §5, §11.5), Model C's floor is
strictly heavier — that is the price of E-01/E-02/E-07 class safety being
present by construction instead of bolted on after the first half-published
release. The user-facing concept count stays at the taxonomy's locked six
(OBSERVED: taxonomy §4 — Version, ReleaseLine, Channel, Change/ChangeSet,
Release, Artifact). RECOMMENDATION: keep the happy-path ledger append-only
and derivable-where-possible (tags as the authoritative record per P-01's
state requirements), so the tax is paid in write volume, not in new user
duties.

**(e) What special cases does it require in total?**
Seven amendments (below), each a data type or protocol — none a code path
keyed on branch names, version strings, or per-branch booleans. That is the
model's core claim: the classic hacks the task names (branch-name-as-channel,
string-parsing promotion, per-branch booleans) have no entry point because
lines, channels, streams, and promotions are named concepts with their own
state. Honest accounting: two of the seven (change identity A2, claims A3)
are demanded by the matrix of _any_ candidate model — they are
problem-shaped, not Model-C-shaped; four (A1, A4, A6, A7) are gaps in this
stipulation that other stipulations might pre-contain; one (A5) makes an
implicit stipulation explicit. Counted as special cases: 10 named mechanisms
(7 amendments + bootstrap input + promotion bind-vs-rebuild distinction +
nightly-as-artifact-class), all additive.

**(f) Can it represent release identity distinct from version string, and can
two concurrent pipeline runs on the same line be distinguished?**
Identity: yes by stipulation — releases are entities (answering taxonomy R2),
so M-11's "same number, two lines" and E-11's "same target, different
content" are representable. Concurrency: attempts are distinguishable from
birth (distinct attempt identities), but their _versions_ are not safe until
A3 exists — without a claim, two runs both compute `1.6.0-rc.1` (OBSERVED:
E-08's naive read-max-then-write failure) and attempt identity merely
documents the collision it could not prevent. With A3, allocation is
claim-ordered (`rc.1` then `rc.2`, or an explicit conflict), injective per
(line, target, stream), and both outcomes are recorded. Answer: yes for
identity natively; yes for concurrent numbering, but only as
SURVIVES-WITH-AMENDMENTS — this is the one question where the stipulated
model, unamended, gives a dangerous no.

## Verdict: SURVIVES-WITH-AMENDMENTS

No scenario kills Model C. The candidates that kill weaker models — S-03
(manifest vs tag history), M-11 (tag collision), PL-08 (plan staleness),
E-07/E-08 (concurrent allocation), PR-04 (channel rollback) — all land inside
its native structure. But the stipulation as written is not implementable
against this matrix: seven precise amendments are required.

**A1 — Decision records as a second planning output.** Widen the planning
codomain from `→ ReleasePlan` to `→ Plan | DecisionRecord`, where a decision
record is a first-class, serializable negative outcome (no-op, refusal,
block, withheld) with cause, evaluated range, and the policy version that
produced it. Scenarios: S-01, S-02, M-08, PL-01, PL-05, PL-06, PL-07, E-06,
E-09, PR-03, PR-04(c). Silently breaks without it: no-ops become
indistinguishable from crashes (S-01's exact trap); withheld changes are
unrecoverably lost once the range advances (PL-07); refusals become
exceptions with no identity. (OBSERVED: the matrix's stress table ranks
"negative decisions are records" at 8 scenarios.)

**A2 — Change identity and provenance in the planning input model.** A change
carries an id stable across cherry-picks (trailer or equivalent — fork 8's
convention), survives content divergence, and maps to per-line
released-version sets; bot-authored release commits are a classified
subtype. Scenarios: M-03, M-04, M-05, M-06, M-09, PL-04, PL-05(c). Silently
breaks without it: fixes triple-count when maintenance branches merge; F″
collapses into F and loses lineage; the planner eats its own release commit.
(OBSERVED: stress table ranks change identity at 7 scenarios, calling M-03
"the purest data-model demand in the matrix".)

**A3 — A claim protocol in execution.** Atomic ownership of the next version
before any mutation — tag CAS, lease with fencing tokens, or a lock service
(fork 13's parameters) — scoped to (line) for releases and (line, target,
stream) for prerelease sequences, with loss detectable after every mutating
step and bounded retry on CAS loss. Scenarios: E-07, E-08; M-11 is its
serial case; E-01 reads the tag as the claim's residue. Silently breaks
without it: two tarballs for `1.5.0` on a permissive registry; two artifacts
claiming `rc.1`; channel moves interleaved by last-writer-wins.

**A4 — Artifact, generation, and evidence schema in the ledger.** Artifact =
(kind, coordinates, content digest) recorded at build time; an append-only
generation table per release (PR-02's gen-1/gen-2); evidence bundles bound
to digests with validated-at and policy TTLs; completion is a ledger
predicate over the declared artifact set. Scenarios: AR-01, AR-02, AR-03,
AR-04, AR-05, AR-06, PR-01, PR-02, PR-03. Silently breaks without it:
untracked rebuilds make `1.2.0` mean different bytes at different times
(PR-02's hazard); stale evidence promotes past a fresh CVE (PR-03); split
visibility (AR-03) is undetectable.

**A5 — Stable line identity with an explicit feed mapping.** A line has an id
independent of any ref name; the line→branch(es) feed mapping is data;
renames are tracked as renames; lifecycle is `active | frozen | retired`.
Scenarios: M-10, S-03, S-05. Silently breaks without it: a branch rename
orphans the line's history and replans it as a bogus new line computing
versions from an empty past (M-10's named failure).

**A6 — Plan supersession machinery.** Plan ids distinct from target versions;
content fingerprints (tip SHA, sorted policy-relevant commit ids with bumps,
base binding, policy digest) re-verified at execution; durable
superseded-by relations; policy-ignored commits must not invalidate.
Scenarios: P-05, PL-08, E-04, E-11 (E-03 consumes the machinery).
Silently breaks without it: execute-the-snapshot ships a `1.5.0` whose
notes miss two commits and assume a dead base (E-11's named failure);
version equality short-circuits plan equality.

**A7 — Attribution and foreign-state discipline in execution.** Every
write-step is attributed to its attempt (write-ahead ledger); existence
probes precede non-repeatable writes; unattributed external state (foreign
tags, foreign drafts, orphaned publishes) blocks the dependent path into a
disposition registry; human actions (abort, force-push) are attributed
events outranking automation. Scenarios: E-06, E-09, AR-05, AR-06, E-03.
Silently breaks without it: resume-by-inference adopts a human's `v1.4.2`
tag as a completed release (E-06's named worst outcome); a "helpful" retry
publishes a release the operator aborted (E-09's).

None of the seven amends the planning/execution split, the release entity,
line independence, channel transitions, or the policy placement of prerelease
progression — the stipulation's five structural commitments all stand.

## Proposed alternative: none — Model C′ instead

RECOMMENDATION: no superior model is proposed. Two reasons. First, applying
A1–A7 to Model C converges on the matrix's own canonical vocabulary —
decision record, change identity, claim, artifact generation, stable line id,
plan fingerprint, attribution — which is evidence that C's skeleton was the
right skeleton, not that a different one is waiting. Second, the only
genuinely different organization this evaluation considered — making a
durable release/event log the primary entity with plans as derived
projections — is a variation inside C's execution half, not a competing
topology; it changes storage, not semantics, and it inherits all seven
amendments unchanged. The reference formulation for the reconciler is
therefore **Model C′ = Model C + A1–A7**, with C's stipulated five
commitments and the seven amendments as its twelve defining properties.

Residual risks inherited by C′ (stated, not resolved — each is a matrix open
fork): claim-mechanism parameters (fork 13); ledger and decision-record
storage (fork 16 — outside `core/domain/` in any case per ADR-0001's purity
boundary); decision-record persistence vs reproducible recomputation
(fork 16 again); recovery doctrine complete-in-place vs void-and-skip
(fork 5); nightly as line-release vs artifact class (fork 15). Model C′ does
not decide these; it is the framing in which deciding them is a parameter
change, not a redesign.
