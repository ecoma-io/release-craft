---
id: "0008"
title: "The artifact graph — artifact steps, generations, and declared coordinates"
status: Proposed
implements: "https://github.com/ecoma-io/release-craft/issues/36"
created: 2026-09-06
updated: 2026-09-06
---

# ADR-0008: The artifact graph — artifact steps, generations, and declared coordinates

## Context

The Artifact value is the oldest locked vocabulary in the system: one
publishable output as a record of (kind, coordinates, content digest),
digest as content identity, coordinates as labels (ADR-0002's Artifact row;
`core/domain/artifact.ts` implements the triple verbatim). The carried
obligations around it are equally old and equally explicit: AR-02's
artifact-dependency-DAG + verify-precondition fragment was deferred "to the
execution phase" with the quote that artifact coordinates are execution
vocabulary (D19(6), G-16); the deliberate-rebuild clause — any rebuild is a
new artifact generation, never new bytes under an existing version identity —
was tightened at the execution contract (D9's obligation 6, ADR-0005) with
its machinery named "the artifact phase (7)"; and PR-02's sanctioned escape
(a deliberate rebuild under one version identity) has been a clause with no
machinery since Phase 0.

The seam it needs now exists: Phase 4's closed step sequence anticipated the
extension ("hooks (Phase 6) and artifact steps (Phase 7) extend it through
their own ADRs, which must name their insertion rules"), and Phase 6 built
the extension machinery itself — the widened `StepKey`, the effective step
list, the classification-driven scheduler, the recorded-proof postconditions,
and the blocked(validation) reconciliation. Phase 7
([#36](https://github.com/ecoma-io/release-craft/issues/36),
[contract](../design/phase7-artifacts-contract.md)) lands the artifact graph
on that machinery. Terms already canonical (artifact, generation, claim,
guard, evidence, ledger — ADR-0002 §4, ADR-0005, ADR-0006, ADR-0007) are
used verbatim and are not re-decided.

## Decision

1. **Artifact steps live in `src/execution/` — no new layer.** The artifact
   step is execution's own extension of the step seam, exactly as the hook
   was (ADR-0007 decision 1); a separate `src/artifacts/` would re-own step
   identity and the ledger key space the kernel already locks. No runtime
   dependency enters (the house rule).
2. **An artifact step is a declared value; the engine computes no digest.**
   The declaration is pure data — an identifier, an anchor, the declared
   (kind, coordinates) pair, declared dependencies, declared postconditions,
   and one guard name riding the kernel's guard machinery exactly as a
   hook's does. The **producer** — the function that observes produced
   content and returns its digest — is caller-injected at the seam and
   never stored or invented by the engine: the engine records what the
   producer returns, as with hook effects (ADR-0007 decision 2). The kernel
   is untouched: no producer ever runs inside `core/domain/`, and nothing
   about the filesystem, network, or registry is read by the engine — the
   digest arrives, it is never computed here (invariant 2's posture; the
   domain's opaque-string door validates, never normalizes).
3. **Insertion rules (the anticipated extension, named).** `StepKey` widens
   once more to `StageKey | HookStepKey | ArtifactStepKey`, where
   `ArtifactStepKey` is `` `artifact:${string}` `` — an artifact step's
   ledger key is `artifact:<id>`, unique per attempt. The declaration
   anchors at exactly one canonical stage, before or after it, declaration
   order breaking ties at the same anchor; the effective step list is the
   canonical sequence with hooks and artifact steps interleaved at their
   anchors. The plan value, the plan fingerprint, and `attemptIdentity`
   are untouched — the attempt gains an optional execution-side
   `artifacts` field alongside `hooks`, excluded from identity exactly as
   hooks are.
4. **Kinds and coordinates are declared labels, never references.** The
   declared (kind, coordinates) pair is recorded verbatim into the domain
   `Artifact` triple at the generation record; there is no operation that
   parses, compares, orders, or dereferences a coordinate (AR-03,
   invariant 15's output-schema half, §2.16 of the planner contract). The
   plan's declared artifact labels (`PlanLine.artifacts`) stay the
   planning-side projection; execution validates declarations
   structurally (opaque, non-empty, unpadded) and never against the plan
   value — the attempt carries no plan body, by design.
5. **Generations are the attempt's recorded artifact set — immutable, one
   per attempt.** Every completion proof an artifact step records lands in
   the attempt's generation; the generation is complete when every declared
   artifact step has recorded its proof. Generation identity is the
   attempt's identity — a deliberate rebuild under one version identity is
   a **new attempt and therefore a new generation**, recorded, never an
   overwrite and never silent (PR-02's sanctioned escape; D9 obligation 6's
   machinery). No record in a generation is ever amended: the ledger's
   append-only discipline is the generation's.
6. **Digest is content identity; reconciliation compares digests.** The
   triple's identity rule is the domain's `sameContent` posture: replay and
   resume re-read the recorded digest, never re-run the producer (the
   scheduler-driven replay of ADR-0007 decision 6, artifact-side). Within
   one attempt, a second completion record for an artifact step whose
   recorded digest differs from the first is a `conflict` — E-02's
   per-step done-vs-conflict — not a silent pass.
7. **The dependency DAG is closed, declared, and acyclic by protocol.** An
   artifact step declares `dependsOn` identifiers among its sibling
   artifact steps on the same attempt; a dependency naming an undeclared
   sibling, and any cycle, are protocol violations refused at the
   openAttempt door (deterministic detection, no graph inference). The DAG
   does not reorder the effective step list; it is the verify
   precondition's input (AR-02's fragment, deferred since D19(6)).
8. **The verify precondition is the dependency digests being recorded
   first.** An artifact step's completion requires its dependencies'
   digests to be recorded in the same generation before its own proof
   lands; a dependency whose proof is missing lands the kernel's recorded
   refusal (no record, walk stopped) — the same shape an unheld claim
   takes. An unmet postcondition proof still fails closed through
   `blocked(validation:artifact:<id>:<cause>)` and Phase 5's resolution
   loop, exactly as a hook's does (ADR-0007 decision 8).
9. **The publish gate is the completed generation.** The `publish` stage's
   completion requires the generation to be complete — a publish recorded
   over an incomplete generation would mint a version identity without its
   declared artifacts (S-04's expected artifacts, AR-01's one-release
   posture). The gate is a precondition of the existing publish step, not
   a new stage; no channel move exists anywhere in it — PR-04's
   transitions remain the only channel door.
10. **The scheduler stays classification-driven.** The artifact walk rides
    the scheduler's shape: effective-list order, replay answered by the
    ledger projection before anything is invoked, refusal or escalation
    stopping the walk, outcomes recorded, successor attempt returned. No
    timers, no event loops, no environment reads; determinism provable by
    double-run (ADR-0007 decision 9, unchanged).
11. **The public surface is the barrel.** The artifact vocabulary exports
    through `src/execution/index.ts`; tests import through
    `../src/index.ts` only (ADR-0001 decision 9's shape, unchanged).
12. **The runtime stays with the adapters.** Producing npm tarballs,
    pushing containers, computing real digests — all adapter territory
    (Phase 8's git binding, Phase 9's GitHub adapter), as with hooks
    (ADR-0007 decision 12). Fork 15's artifact half is resolved here: a
    nightly artifact is an artifact step whose declared kind names it —
    no version allocation on the line, no line-release semantics (AR-04's
    ruling pinned execution-side); the channel-scheduling half stays
    carried (P-03's channels, Phase 3's door).

### Amendments this ADR makes (loud, in this PR)

- [decision-log.md](../design/decision-log.md): D23 records the decision
  set above.
- [release-model.md](../design/release-model.md): the "not yet designed"
  list's "artifact sets, generations, and evidence freshness rules
  (AR-01, PR-02, PR-03)" narrows to what this ADR leaves open — evidence
  freshness rules (PR-03) stay carried; artifact sets and generations
  (AR-01, PR-02) are now owned here. The taxonomy needs no row moves:
  Artifact is already LOCK, and the deferral that named this phase
  (AR-02's execution-phase fragment) closes with D23.

## Consequences

- The step seam now carries all three key spaces it was closed for —
  canonical stages, hooks, artifact steps — and no fourth extension is
  anticipated; the closed-vocabulary comment retires with the graph landed.
- Kill-anywhere, replay, resume, and double-run determinism hold uniformly
  over canonical, hook, and artifact steps; the classification core knows
  no artifact-specific case.
- A hook's content-fingerprint proof stays exactly what ADR-0007 made it — a
  recorded proof on a hook's completion record — never a generation entry:
  only artifact steps mint generation records (the deliberate non-decision
  "artifact-producing hooks" closes here).
- The deliberate-rebuild clause is machinery, not prose: a rebuild is a new
  attempt, therefore a new generation, recorded beside the old one with
  both digests readable.
- What this ADR deliberately does not decide: evidence bundles' freshness
  rules (PR-03 — carried), persistence of artifact records beyond the
  ledger (fork 16, Phase 8's binding), real digest computation and
  registry interactions (the adapters), and channel semantics around
  artifacts (PR-04's door is untouched by design).
