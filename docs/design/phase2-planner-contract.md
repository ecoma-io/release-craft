# Phase 2 contract — the deterministic release planner

> **Status: Phase 2 design asset (task P2-01 of
> [#16](https://github.com/ecoma-io/release-craft/issues/16), part of
> [#13](https://github.com/ecoma-io/release-craft/issues/13)).** This document
> is the contract the Phase 2 implementation and its suite are reviewed
> against, the same role [phase1-contracts.md](phase1-contracts.md) played for
> the kernel. It implements the planning half of
> [ADR-0002](../adr/0002-release-model-and-domain-vocabulary.md)'s Model C′
> exactly: a pure, deterministic, side-effect-free function
>
> ```text
> (repository observations, parsed changes, release history,
>  line configuration, component metadata)   →  ReleasePlan | DecisionRecord
> ```
>
> living in the package layer `src/` (decision-log D5). Nothing here may add a
> term outside the locked vocabulary, a provider concept, or an execution
> responsibility; each section cites the invariants and scenarios it serves.

## 1. Scope boundaries

The planner decides; it never performs. It commits nothing, tags nothing,
publishes nothing, calls no provider, mutates no state outside its return
value, executes no hook, and never infers completion from side effects
(invariant 3; E-01..E-09 belong to the execution phase). Negative outcomes are
returned as `DecisionRecord`s, never thrown as exceptions (invariant 4).
Construction-level invalidity (a kernel value's `*Error`) and planning-level
refusal (a record) are different failure classes and are separated at the
planning boundary.

## 2. The fourteen contract items

### 2.1 Planner input boundary

`PlanningInput` is the single argument. It is provider-neutral, serializable,
and closed: the planner reads nothing but this value. It carries, as explicit
data — never as environment, clock, filesystem, or network reads (invariant 2;
E-05):

- `policy`: the policy digest plus the named policy decisions this contract
  fixes (bump mapping id, ladder, lifecycle defaults, pre-1.0 dampening,
  self-reference marker namespace, tag-format configuration);
- `repository`: normalized commit and ref observations (§2.2);
- `history`: normalized tag observations (§2.13);
- `lines`: release-line configurations, declared or default-derived — the
  same schema either way (defaults as data; [release-model.md §5
  "The mechanism"](release-model.md#complexity-budget); no code path keyed on
  "simple mode");
- `components`: package metadata (names, manifest versions as projections,
  declared dependency ranges) for the package axis (PL-01..PL-03);
- `bootstrap`: the recorded bootstrap decision when present (S-02);
- operator intents that must be recorded when exercised ("release anyway" →
  an operator-forced record, never a routine release, S-01; `Release-As`
  footer semantics, compatibility boundary row 2).

Repeated execution against an identical `PlanningInput` is deterministic and
produces an identical plan fingerprint (invariant 2; proven by running the
golden matrix twice).

### 2.2 Normalized repository observations

A `CommitObservation` is `{ sha, parents, message, committedAt, containingRefs }`;
a `RefObservation` is `{ name, head }`. Timestamps are input data used never
for ordering (E-10: ordering is topological/ancestral, never wall-clock). The
planner performs zero `git` calls; observations arrive precomputed. The
evaluated **range** of a line is that line's own last admissible release tag
to its feed ref head (invariant 6) — never a global cursor.

### 2.3 Change identity and lineage (fork 8 resolved conservatively)

Extraction maps commit observations to candidate `Change` values
(kernel `Change.of(id, lineage)`; identity is the id, never content —
invariant 9):

- id source, first match wins: the commit's `Change-Id:` footer; else the
  cherry-pick trailer's origin commit (recorded provenance); else the commit's
  own sha (also recorded provenance). No fuzzy matching, no content hashes.
- lineage records the chain (parent id, origin commit, origin line) so
  cherry-picks across lines resolve to one identity (M-03, M-04, M-06, M-09)
  and a conflicting backport — same id, divergent payload descriptors — stays
  one identity whose conflict is surfaced in the plan's explanation data
  (M-05), never silently merged away.
- extraction is deterministic: identical observations produce identical
  changes, in stable order.

### 2.4 Branch/ref attribution (M-01 invariant home)

Attribution of a change to a line is ancestry-based: the change's commit is
reachable from the line's feed ref within the line's range (§2.2). Ancestry is
the default evidence; when attribution is ambiguous (a commit inside two
lines' ranges with no lineage tiebreaker and no policy that decides), the
planner fails closed with a `refusal` record naming the ambiguous commits
(PL-05a; invariant 4). A change may legitimately be pending on several lines —
releasedness is per (line, change) (M-04, M-06); a change released on one line
is never thereby released on another. There is no "latest branch" shortcut and
no branch name is ever a line identity (invariant 7). This section is the
invariant home M-01 lacked (D9 obligation; recorded in the decision log).

### 2.5 Range calculation

Per line, from that line's own release history: the latest admissible tag on
the line (or the line's birth when none) bounds the range's lower end;
divergent maintenance lines compute independent ranges (M-07, S-03). Manifest
versions never bound a range (S-03).

### 2.6 Release-line selection

Lines exist because configuration declares them or the default derivation
creates the single implicit line fed by the default branch — one schema, one
planner path. Line selection for a change is attribution (§2.4); line
selection for a release is the line's own pending change set plus its policy.
Line identity is the stable configured id (invariant 7).

### 2.7 Bump resolution

The commit-type → `Bump` mapping is policy data (never in `Change` or the
kernel). Default policy: `feat` → minor, `fix`/`perf`/`refactor` → patch,
breaking (`!` or `BREAKING CHANGE:` footer, any type) → major;
`chore`/`docs`/`ci`/`test` without a breaking marker are not
release-triggering (S-01, PL-06 — recorded in the no-op cause detail, never
silently dropped). The breaking marker dominates filtering (PL-05). The
line's change-set bump is `Bump.max` over member changes; `ChangeSet.of`
records it. An empty group mints nothing (§2.9). Pre-1.0 dampening (breaking
bumps minor before `1.0.0`) is line-policy default (compatibility row 3).

### 2.8 Prerelease policy resolution (D9 pointer convention decided)

Streams are keyed by (line, target, identifier); sequence arithmetic is the
kernel's `advanceStream`/`streamVersion` (Phase 1 values), seeded `.0` when
the key is absent; a target move is a new key (P-05); two streams on one
target coexist (P-06). Ladder order (alpha → beta → rc) and identifier reset
are line-policy data; opaque identifiers are allowed by declaration.

**Released-pointer convention:** the pointer is the line's highest published
version by precedence — the kernel's `released` reading. A prerelease
publication with higher precedence moves it (M-08); publications the pointer
already exceeds (P-02/P-07 stream publications) leave it standing, and a
stream override that publishes below the pointer is legal only as explicit
declared policy and is recorded in the plan (the D9 ladder-override branch).
The pointer value a plan computed from is recorded in the plan.

### 2.9 No-op, withheld, refused, blocked (negative outcomes are records)

- empty change set → `no-op` record: cause `no-release-worthy-changes`,
  evaluated range, policy digest, ignored-by-policy commits enumerated
  (S-01, PL-06; D9 obligation — never a minted version, never an exception);
- `withheld`: policy-filtered changes (PL-07) are deferred and enumerated in
  the record — filtering is deferral, never deletion (fork 9's discard
  protocol: the record is the home of the withheld set);
- `refused`: fail-closed attribution ambiguity (§2.4), operator-contradiction
  (S-01's "release 1.0.2 now" against a chore-only runway);
- `blocked`: unmet preconditions — bootstrap required without a recorded
  decision (S-02), stale plan detected under a changed world (PL-08, E-04,
  E-11);
- every record carries cause, evaluated range, and the policy digest that
  produced it (invariant 4; amendment A1).

### 2.10 Plan supersession

A plan may name the prior plan it supersedes (`supersedes: planId | null`);
supersession is a recorded relation, never an edit (invariant 5). A
regeneration that lands on emptiness closes the open plan with a **no-op
successor record** carrying `supersedes` — mixed-kind endpoints are legal
(D9 obligation). Executing-side re-verification is out of scope here; the
planner provides the fingerprint comparison data (stale recognition:
differing fingerprint or a target tag that now exists, invariant 6's global
tag-namespace check, PL-08/E-11).

### 2.11 Plan identity and fingerprint

`ReleasePlan.planId` is the plan's content fingerprint: canonical JSON
(recursively key-sorted) of the plan's semantic fields → SHA-256 →
`plan_sha256:<hex>`. Version equality implies nothing about plan equality
(E-11); identical inputs imply identical fingerprints (invariant 2). The plan
records its policy digest and inputs fingerprint so a stored plan can be
re-judged against a changed world (E-04).

### 2.12 Self-reference exclusion (D9 obligation — named rule)

The planner's own bookkeeping commits are identified by the reserved trailer
namespace `Release-Craft:` and are excluded deterministically **before**
classification (PL-04): they never become fresh input, never extend a range's
change set. The excluded set is surfaced in the plan's/record's explanation
data — excluded is not invisible.

### 2.13 Tag-history projection

`TagObservation[]` is the sole release-history truth (invariant 6; S-03, S-05,
M-02, M-07). Normalization: tag names are parsed to `Version` through the
kernel's grammar (no `v` prefixes; per-component tag formats are declared
input configuration — fork 11's naming knob). Admissibility: a tag joins a
line's history only when its normalized version falls in that line's version
namespace per declared line configuration; foreign or unattributable tags are
excluded from history **and surfaced** in the plan's explanation data (E-06
conservatism — adoption without attribution is refused at planning time).
Line state (released pointer, stream states) is rebuilt from tags at plan
time; any manifest-declared version is a projection whose drift is surfaced,
never consumed as truth (S-03).

### 2.14 Plan determinism

All nondeterministic facts are inputs (§2.1–2.2). The planner contains no
clock, randomness, environment, filesystem, or network access; ordering is
ancestral/topological (E-10); output serialization is canonical (§2.11).
Golden fixtures run the planner twice per scenario and require fingerprint
equality.

## 3. D9 carried obligations → owning sections

Populated from the obligation audit in the reconciliation pass of this PR.

## 4. Invariant enforcement map

Populated from the invariant audit in the reconciliation pass of this PR.

## 5. Scenario inventory

Populated from the scenario audit in the reconciliation pass of this PR.

## 6. Open questions

None — items 2.1–2.14 are the phase's closed contract; changes to any of them
update this document and the decision log in the same PR.
