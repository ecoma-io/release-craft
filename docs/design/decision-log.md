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

**Decided (2026-09-05, decision D4).** The release model is
**Model C′ = Model C + amendments A1–A7** — a release is the stateful
execution of a _Release Plan_ on a _release line_, with planning and execution
as separate domains. The full definition, vocabulary lock, invariants, and
complexity budget are recorded in `release-model.md` and ADR-0002, which
survived the adversarial design review; the decision and its evidence are
recorded under D4 below.

Candidate mental models that were evaluated:

- **Model A** — a release is a version-on-branch concept. **Rejected.**
- **Model B** — a release is a linear pipeline. **Rejected.**
- **Model C** — a release is the stateful execution of a _Release Plan_.
  **Survives with amendments → adopted as C′.**

## Decisions accepted

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Consequence                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| D0  | Phase 0 ships research/design documents only; no production release-engine code.                                                                                                                                                                                                                                                                                                                                                              | Issue #13 scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | The kernel's population stays `Version` until Phase 1.                                                                               |
| D1  | Work proceeds through PRs per phase (Phase 0 = PR-A), main stays protected.                                                                                                                                                                                                                                                                                                                                                                   | Repository rulesets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Serial phase gates; no direct pushes.                                                                                                |
| D2  | Prose carries no numeric inventory claims it cannot keep.                                                                                                                                                                                                                                                                                                                                                                                     | Audit §3.7 — the stale-count class; ADR-0001's "75 tests" was verified false (vitest: 74).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Counts live in the owning artifact; every PR that changes a counted thing sweeps the audit's §3.7 table.                             |
| D3  | Any new source root changes `SOURCES` in the same PR.                                                                                                                                                                                                                                                                                                                                                                                         | Audit §3.5 — a root outside the two globs escapes every coverage threshold silently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Recorded as a Phase 1/2 checklist item; candidate hardening deferred with evidence.                                                  |
| D4  | The release model is **Model C′ = Model C + amendments A1–A7** (Model C as defined in `_proposals/model-c.md`, amended by its own A1–A7). Settles U1, U2, U3.                                                                                                                                                                                                                                                                                 | Three independent evaluations against the 53-scenario matrix: A rejected (25 FAILS over 6 classes — PR-01..05, E-01/02/03/06, AR-01..06, P-02/05/06, M-03/10/11; amended to competency it is no longer A), B rejected (15 FAILS over 5 classes; required amendments delete defining properties P1/P2 — worst outcome E-09, completing an aborted release, is P2's default), C survives (zero killers; the matrix's two hardest stress families — attempt+ledger+claims, plan-as-first-class-object — are native structure). Triangulation: the A and B evaluators' own proposed alternatives independently converge on C's skeleton. | `release-model.md` + ADR-0002 (synthesis); Phase 1 primitives = the vocabulary's kernel-value kinds; Phase 2 planner consumes plans. |
| D5  | The planning engine lives in the package layer (`src/`), consuming kernel values — audit route 1. Settles U5.                                                                                                                                                                                                                                                                                                                                 | Audit §3.4 (zero structural cost, `type-package` row already allows it) + D4: planning is pure but consumes repository observations as data — package concern; the kernel keeps only value semantics.                                                                                                                                                                                                                                                                                                                                                                                                                                | Phase 2 planner lands in `src/`; no new source root unless justified, and then D3 applies.                                           |
| D6  | The kernel entrypoint becomes a barrel (`core/domain/index.ts`) once Phase 1 adds its second primitive; the same PR amends ADR-0001 decision 8 (barrel) **and** annotates decision 7's rationale ("the kernel does not know channels exist") and the consequences' parenthetical on lines/channels/transitions outside `core/domain/` — which govern policy resolution, not the locked value shapes (adversarial review MAJOR-3). Settles U7. | Audit §3.1 friction table — N primitives × 3 tool declarations each is friction without benefit; one barrel keeps the alias seam at one specifier. ADR-0001 read literally would file `Channel`/`ReleaseLine` values in `core/domain/` as a violation; the amendment reconciles values-in/policy-out in the winning document itself.                                                                                                                                                                                                                                                                                                 | PR-B carries all three ADR-0001 amendments; all three declarations still name one entrypoint.                                        |
| D7  | Phase 1 builds exactly the vocabulary's kernel-value kinds: `Change`, `ChangeSet`, `ReleaseLine`, `Channel`, `Artifact` beside `Version`. Settles U4.                                                                                                                                                                                                                                                                                         | `release-model.md` §3 vocabulary table (kind column) + ADR-0002 consequences — ReleasePlan is a planning concept (Phase 2), Release/Promotion/Transition are execution concepts, Hook is a deferred adapter.                                                                                                                                                                                                                                                                                                                                                                                                                         | Phase 1 contracts use the locked terms verbatim; the barrel (D6) lands with the first new primitive.                                 |
| D8  | The release-please compatibility boundary is the synthesis's committed table. Settles U6.                                                                                                                                                                                                                                                                                                                                                     | `release-model.md` §7 — 18 rows distilled from the baseline's 40-row classification; ADR-0002 §7 records the same boundary in decision register.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | "Preserve" means behavior survives with release-craft's own mechanisms, not config migration; verified per-behavior in later phases. |

## Decisions unresolved

None. All Phase 0 questions are settled: U1/U2/U3 by D4, U5 by D5, U7 by D6,
U4 by D7, U6 by D8. New questions enter through a synthesis or review
artifact, not ad hoc.

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

The synthesis (`release-model.md`, ADR-0002) passed an independent adversarial
review over six surfaces (invariant falsification, vocabulary integrity,
complexity-budget honesty, the twelve failure patterns, evidence consistency,
implementability) before PR-A: the model decision stood — 12/12 failure
patterns pass, all six identity separations hold — and every finding was
fixed in the documents (the invariant-1 phase-claim split, the
residual-inheritance row completing the compatibility boundary, the D6
amendment scheduling, and the minor citation/wording corrections).

## Risk register

| Risk                                                           | Likelihood               | Impact | Mitigation                                                                  |
| -------------------------------------------------------------- | ------------------------ | ------ | --------------------------------------------------------------------------- |
| Vocabulary drift between docs and later code                   | High                     | High   | Vocabulary locked in Phase 0F; every Phase 1 contract must use it verbatim. |
| Model chosen by convenience, not by rejection                  | Medium                   | High   | Phase 0E requires explicit rejection of weak models with scenario evidence. |
| Planning engine quietly acquires side effects                  | Medium                   | High   | Purity gates + adversarial planner review in Phase 2H.                      |
| ADR-0001's single-file alias seam conflicts with kernel growth | Certain (it must change) | Medium | Phase 0A audit names the exact seam changes; ADR amendment in Phase 1 PR.   |
| Scenario matrix too shallow to be a design asset               | Medium                   | High   | Three independent proposers with different lenses + reconciliation.         |
