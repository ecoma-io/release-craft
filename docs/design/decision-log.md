# Phase decision log — the orchestrator's working record

This file is the coordination log for the phased construction of the release
engine ([#13](https://github.com/ecoma-io/release-craft/issues/13)). It records
the state of architectural thinking as it moves: the current hypothesis, what is
settled, what is deliberately still open, what was rejected, and what each
workstream depends on. Decisions that survive review are promoted into ADRs;
this log keeps the trail that led there — including the trails that dead-ended.

Rules for this file:

- One row per decision, with the evidence that justified it.
- Nothing is deleted when it is rejected — it moves to "Rejected alternatives"
  with the reason.
- Vocabulary changes are never silent: any term redefined here must be reflected
  in the scenario matrix before Phase 1 implements it.

## Current architecture hypothesis

**Open.** Phase 0 exists to produce this. Candidate mental models under
evaluation:

- **Model A** — a release is a version-on-branch concept.
- **Model B** — a release is a linear pipeline.
- **Model C** — a release is the stateful execution of a _Release Plan_.

The hypothesis the phases are biased toward (to be confirmed or overturned by
the scenario matrix): planning and execution are separate domains — a
deterministic, side-effect-free planner turns repository state + changes +
configuration + history into a `ReleasePlan`, and every release effect (commit,
tag, publish) belongs to a later executor that consumes plans. Evidence for or
against lands in `release-model.md` once the scenario matrix exists.

## Decisions accepted

| #   | Decision                                                                         | Evidence                                                                                   | Consequence                                                                                              |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| D0  | Phase 0 ships research/design documents only; no production release-engine code. | Issue #13 scope.                                                                           | The kernel's population stays `Version` until Phase 1.                                                   |
| D1  | Work proceeds through PRs per phase (Phase 0 = PR-A), main stays protected.      | Repository rulesets.                                                                       | Serial phase gates; no direct pushes.                                                                    |
| D2  | Prose carries no numeric inventory claims it cannot keep.                        | Audit §3.7 — the stale-count class; ADR-0001's "75 tests" was verified false (vitest: 74). | Counts live in the owning artifact; every PR that changes a counted thing sweeps the audit's §3.7 table. |
| D3  | Any new source root changes `SOURCES` in the same PR.                            | Audit §3.5 — a root outside the two globs escapes every coverage threshold silently.       | Recorded as a Phase 1/2 checklist item; candidate hardening deferred with evidence.                      |

## Decisions unresolved

| #   | Question                                                                                                     | Blocked on                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| U1  | Which mental model survives the scenario matrix (A / B / C / other)?                                         | Scenario matrix (Phase 0D).                                                                                         |
| U2  | Is `Branch ≠ ReleaseLine ≠ Channel` the right split?                                                         | Taxonomy R1 says three concepts; scenarios confirm or break it.                                                     |
| U3  | Is prerelease a version flag, a channel-stream position, or both?                                            | Taxonomy R3 says "both, split by layer"; prerelease scenarios decide.                                               |
| U4  | Which primitives enter Phase 1 (Change, ChangeSet, ReleaseLine, ReleasePlan, Release, Artifact, Transition)? | Model comparison (0E); taxonomy §4 proposes six core concepts.                                                      |
| U5  | Does the planning engine live in the dependency-pure zone (`core/`) or the package layer (`src/`)?           | Audit §3.4 leans route 1 (in-package, `type-package` row already allows it, zero structural cost); final after 0E.  |
| U6  | What is the compatibility boundary with release-please?                                                      | Behavioral audit (0B) — delivered, awaiting synthesis into `release-model.md`.                                      |
| U7  | Barrel (`core/domain/index.ts`) or per-primitive subpaths for the kernel entrypoint?                         | Audit §3.1 — decided in the first PR adding a second primitive; barrel amends ADR-0001 decision 8, subpaths do not. |

## Rejected alternatives

| #   | Alternative                                                       | Why rejected                                                                                                                                     |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | Adopt release-please's internal architecture as the domain model. | Its shapes are a working codebase's history, not a domain analysis; it would become a dependency of the core. (To be sharpened by the 0B audit.) |
| R2  | Implement primitives directly, skip discovery.                    | Issue #13: invents prerelease/branch/hook concepts ad hoc — the drift this phase exists to prevent.                                              |

## Workstream dependencies

```text
0A audit ──────────┐
0B release-please ─┼─► 0D scenario matrix ─► 0E model comparison ─► 0F vocabulary ─► 0G complexity budget ─► PR-A
0C taxonomy ───────┘        (3 proposers + reconciler)      (3 evaluators + synthesis)
```

## Scenario coverage

Tracked in `release-scenarios.md` once reconciled. Every accepted
architectural invariant must name the scenarios that stress it.

## Risk register

| Risk                                                           | Likelihood               | Impact | Mitigation                                                                  |
| -------------------------------------------------------------- | ------------------------ | ------ | --------------------------------------------------------------------------- |
| Vocabulary drift between docs and later code                   | High                     | High   | Vocabulary locked in Phase 0F; every Phase 1 contract must use it verbatim. |
| Model chosen by convenience, not by rejection                  | Medium                   | High   | Phase 0E requires explicit rejection of weak models with scenario evidence. |
| Planning engine quietly acquires side effects                  | Medium                   | High   | Purity gates + adversarial planner review in Phase 2H.                      |
| ADR-0001's single-file alias seam conflicts with kernel growth | Certain (it must change) | Medium | Phase 0A audit names the exact seam changes; ADR amendment in Phase 1 PR.   |
| Scenario matrix too shallow to be a design asset               | Medium                   | High   | Three independent proposers with different lenses + reconciliation.         |
