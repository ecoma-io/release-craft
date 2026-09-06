---
id: ADR-0003
title: The Phase 2 deterministic release planner
status: Accepted
created: 2026-09-06
updated: 2026-09-06
---

# ADR-0003: The Phase 2 deterministic release planner

## Status

Accepted. Amends ADR-0002's vocabulary table in four places (see Decision 14)
and carries the amendment set named by the [Phase 2
contract](../design/phase2-planner-contract.md) §3. Implements D5 (planning
engine in the package layer).

## Context

Phase 1 locked the kernel values — `Version`, `Change`, `ChangeSet`,
`ReleaseLine`, `Channel`, `Artifact` behind the barrel — and decision-log D9
recorded what the kernel deliberately does **not** decide: ranges, attribution,
bump policy, prerelease stream policy, supersession, fingerprints, and the
negative-outcome taxonomy all live outside `core/domain/`. The Phase 2
contract ([phase2-planner-contract.md](../design/phase2-planner-contract.md),
items §2.1–§2.16) reconciles three audits — D9's carried obligations, the
invariant-enforcement map, and the 53-scenario inventory — into one
specification. This ADR records the decisions that survive it, per the
decision-log's standing rule that decisions promoted out of design documents
land in an ADR in the same PR.

Three facts constrain everything below:

- The planner is a **pure function** (invariant 3): it mutates nothing, reads
  nothing ambient, orders nothing by wall-clock time (invariant 2).
- The boundary law keeps `core/domain/**` import-free (ADR-0001); every
  mechanism here is therefore package-layer data and functions over kernel
  values, never new kernel semantics.
- Release-please's compatibility boundary stays the committed table
  (D8): where this ADR diverges from release-please's behavior, the matrix's
  scenario wins.

## Decision

1. **The planner is a pure function in `src/planner/` with codomain
   `ReleasePlan | DecisionRecord`.** One entrypoint takes one closed input
   value and returns either an approved plan or one decision record — no-op,
   withheld, refused, or blocked — carrying cause, evaluated range, and the
   policy digest that produced it (contract §2.1, §2.9; invariants 2–4).
   Kernel construction rejections (`InvalidChangeSetError` and kin) surface as
   `refused` records at the planning boundary; the planner never re-throws
   them.
2. **The input boundary is closed and provider-neutral.** The planner consumes
   a `PlanningInput` value: the effective policy digest, normalized repository
   observations (manifest projection, commits, refs, declared lines and
   channels, component metadata, the recorded bootstrap decision, operator
   intents), tag observations, and declared configuration. Refs and branches
   appear only as observations and declared bindings — provider state is
   never named (invariant 15; contract §2.2, §2.16).
3. **Change identity is a three-step lineage, resolved conservatively**
   (contract §2.3; fork 8): the `Change-Id:` trailer wins; else the
   cherry-pick origin annotation; else the commit sha. Lineage is recorded;
   identity conflicts are surfaced, never fuzzy-matched (M-05).
4. **Attribution is ancestry-based and fails closed** (contract §2.4): a
   commit whose owning ref cannot be attributed into a line's evaluated range
   produces a `refused` record demanding explicit review — it is never
   silently dropped, guessed, or attributed by proximity (M-01; invariant 4's
   stress list now names M-01).
5. **Line state is rebuilt from tag history; the manifest is a projection**
   (contract §2.5, §2.13). The loader reconstructs each line's released
   versions, stream sequences, and the channel pointer state from the tag
   observations; manifest disagreement is recorded as an annotation the plan
   may propose repairing, never a computation input (S-03; invariant 6).
   **Channel state is declared configuration** in Phase 2: channels enter
   through the input as declared configuration, and the loader rebuilds line
   and stream state only — there is no tag substrate for channel pointers in
   the planner (channel pointer _events_ are execution-phase mechanics).
6. **Bump policy is declared data, applied with `Bump.max` over an evaluated
   range** (contract §2.7): feat→minor, fix/perf/refactor→patch, a breaking
   marker on any type→major and dominates filtering; chore/docs/ci/test
   without a breaking marker is not release-triggering and yields the recorded
   no-op (S-01); pre-1.0 dampening is a declared default (fork 1).
7. **The first-mint seed is declared line policy — fork 17 resolved without
   touching the matrix** (contract §2.8): a fresh stream key's first sequence
   is `seed: .0` — the kernel default, matching `advanceStream`'s seeding — or
   `seed: .1` by explicit declaration. P-01/P-02/P-05/P-07 fixtures take the
   default; M-08/E-08 fixtures declare `.1`. The fork entry's own recorded
   shape ("a `.1`-first convention, if adopted, is planner policy over tags")
   is formalized, not amended.
8. **The released-pointer convention is the contract's, not the kernel's**
   (contract §2.8; D10): the pointer is a projected convenience recomputed
   from history, so "highest by precedence" is the moving rule (M-08); a
   pointer stands when the new release does not outrank it (P-02, P-07); and
   an override that sorts below the pointer is expressible only as a recorded
   operator decision input — the pointer then stands, the override is
   explicit, and the plan says both (P-02's ladder-override branch). The
   pointer value a plan computed from is recorded in the plan. Invariant 6's
   stress list names M-08, P-02, and P-07 as this rule's home.
9. **Supersession is a recorded relation with mixed-kind endpoints**
   (contract §2.10): a later plan supersedes an earlier one, or an open plan
   is closed by a decision record — never an edit (PL-08; invariant 5
   amended; the vocabulary table's `ReleasePlan` cell updated in this PR).
10. **Plan identity is the content fingerprint** (contract §2.11; D12):
    canonical JSON (recursively key-sorted) of the plan's semantic fields →
    SHA-256 → `plan_sha256:<hex>`. The input tuple is closed and enumerated in
    the contract so two implementations cannot diverge; policy digest and
    inputs fingerprint are carried in the plan (E-04, E-11; invariant 2).
11. **The planner's own bookkeeping is excluded before classification**
    (contract §2.12; D11): commits carrying the reserved `Release-Craft:`
    trailer namespace are identified deterministically and excluded — but
    surfaced, not invisible (PL-04); a malformed marker in that namespace
    fails toward explicit review. Fork 8's marker convention is routed here:
    Phase 1 shipped no adapter, so the convention lands with Phase 2
    extraction.
12. **The package axis is active for declared component metadata**
    (contract §2.15): propagation edges, topological order, and the negative
    proof (packages evaluated and not moved, with why) are declared content
    (PL-01..PL-03; forks 10, 12). Per-package tag naming is declared input
    configuration (fork 11's naming knob carried). The global tag-namespace
    precondition — target tag must not exist — is Phase 2-owned and not
    monorepo-gated (M-11; invariant 6).
13. **Bootstrap is a refusal, not a default** (contract §2.7, §6; forks 1–2):
    the planner demands the recorded operator decision for the first version
    (`1.0.0` vs `0.1.0` is the operator's call — S-02) and never invents one;
    a chore-only runway yields the recorded no-op (S-01).
14. **Amendment set (loud, this PR).** release-model.md §4: invariant 3's
    stress annotation extended (self-reference exclusion named, D11);
    invariant 4's stress list += M-01; invariant 5's sentence admits
    mixed-kind endpoints; invariant 6's stress list += M-08, P-02, P-07.
    release-model.md §3: the `ReleasePlan` vocabulary row's supersession cell
    admits decision-record endpoints. release-model.md §6: the fork count
    corrected to seventeen. release-scenarios.md: S-03's index line aligned to
    its canonical body heading; fork 17's entry annotated with its resolution
    (pointer to this ADR; entry text unchanged).
15. **Not adopted, with gates:** the nightly artifact class stays carried
    (fork 15); AR-04's ruling — nightly is a scheduled artifact-class build,
    no line allocation — is pinned as the standing default. Resolving fork 15
    line-side later triggers the three-surface amendment the D9 audit named
    (ADR-0002 vocabulary table, kernel value shape, invariant 8), loudly.

16. **A line's version namespace is declared configuration — the version
    band** (contract §2.13): `LineConfig.versionBand` names the major (and
    optionally minor) series a line releases into (`1.9` → `{major: 1,
minor: 9}`; `1.x` → `{major: 1}`); absence admits every admissible tag
    (single-line repos). Admission is band equality; an unparseable or
    out-of-band tag is foreign — surfaced, never consumed (S-03's `1.9.x`
    tags stay out of `2.x`'s history, and vice versa; E-06). No grammar is
    inferred from line ids or branch names — the band is data, the loader
    never guesses.

17. **The package graph is declared dependency metadata, and propagation is
    recorded, never implied** (contract §2.15): `ComponentMeta.dependencies`
    carries the declared edges with their range expressions (`^`/`~`/exact)
    as closed input — read from manifests, never discovered from the
    filesystem (invariant 2). A component release forces a dependent bump
    exactly when its new version falls outside the dependent's declared
    range; dependents widen transitively, in topological order, and every
    component that did not move carries negative evidence (`PL-01`–`PL-03`,
    `PL-03`'s "non-impact must be demonstrable"). A dependency naming an
    undeclared component is a caller contract violation, not a planning
    outcome.

18. **The review-wave vocabulary and the mapping posture** (contract §2.6,
    §2.9, §2.11, §2.13; D17): a promotion (`promote` intent over an
    in-flight prerelease) is a `release` decision with `bump: null` and an
    inherited empty change set targeting the pointed-at release — pending
    changes or no rc pointer refuse as operator contradiction (P-03). A
    `release-anyway` intent over a quiet line is a `forced` record that
    mints nothing (S-01 — the forced mint is declared-policy territory).
    While a prerelease holds the pointer, the in-flight-target rule
    governs: the candidate recomputed from the line's stable base
    (`LineState.stableBase`) against `bumpPatch(pointer)` — higher
    precedence wins, equal keeps the target and its sequence (P-04), a
    heavier join moves it and resets (P-05); a prerelease intent on the
    line suppresses the stable co-mint — the streams carry the target
    (P-07/M-08). Birth targets the recorded bootstrap version verbatim
    (S-02); a `release-as` intent overrides the computed target (row 2).
    The plan surfaces its exclusion data (`ReleasePlan.explanation`) and
    `inputsFingerprint` covers the policy-relevant projection (PL-08). The
    declared component graph stays the active §2.15 input (decision 17
    stands); the door refuses only the fabricated line↔component release
    mapping (PL-01's declared-future seam) — per-line decisions, targets
    and streams stay computable at their layers, and M-08's rejection half
    plus its two-release pass land with PR-6/PR-7's line-policy knobs and
    binding.

## Consequences

- The planner adds **no runtime dependency** and imports **nothing** outside
  the package layer and the kernel barrel; a planner-isolation suite (modeled
  on Phase 1's provider-isolation test) plus the phase's adversarial review
  are named deliverables of the integration workstream (contract §4, A3).
- Golden fixtures follow the matrix file as source of truth; the contract's
  scenario inventory (§5) is the planning-side index and is updated in the
  same PR whenever they diverge.
- Persistence remains adjacent: the plan and record shapes are persistable
  (fingerprint key, `supersedes` edge) but Phase 2 ships no writer; the thin
  package-layer writer is execution-phase work (contract §6, ruling 10).
- Phase 3 inherits exact boundaries: line-policy schema now, feeds/discovery/
  lifecycle/registry later (contract §6, ruling 2); per-line evaluation,
  ancestry attribution, and the releasedness predicate in Phase 2; line
  registry and one-pass multi-line orchestration later (ruling 3).

## Limitations

- The planner decides nothing about execution: ledger, claims, hooks, channel
  pointer events, artifact publication, and provider bindings remain
  execution-phase mechanics (invariants 10–13 own them later).
- Invariant 10's tightening — "never publishes _unrecorded_ new bytes" — is
  recorded as the execution contract's obligation (contract §7); the planner
  owns no part of it.
- The change→released-versions relation is carried as descriptive planning
  data, recomputed per plan; persisting it under a vocabulary name still
  requires the ADR-0002 amendment first (D9 obligation 9).
