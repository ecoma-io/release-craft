---
id: "0007"
title: "Hooks as steps — the execution seam, the scheduler, and reconciliation"
status: Proposed
implements: "https://github.com/ecoma-io/release-craft/issues/33"
created: 2026-09-06
updated: 2026-09-06
---

# ADR-0007: Hooks as steps — the execution seam, the scheduler, and reconciliation

## Context

The taxonomy classifies the hook as an **adapter** and locked its direction
early ("user code must never enter the pure kernel"; execution-side step,
never a planning participant), deferring the shape with an explicit trigger
([release-model.md](../design/release-model.md), "Hook is deferred, with
trigger"): the execution phase's design of the attempt step list, where
model-c's recommendation — hooks as steps with declared pre/postconditions,
plan-mutating hooks refused by construction — becomes testable. Phases 4 and
5 built that seam: the attempt's step list, the claim/guard machinery, the
seven-outcome replay classification, and the durable ledger whose projections
resume is a pure classification over. The trigger has fired.

Phase 6 ([#33](https://github.com/ecoma-io/release-craft/issues/33),
[contract](../design/phase6-hooks-contract.md)) lands the hook. This ADR
exists because hooks extend closed vocabulary — the canonical eight stages
are explicitly closed until "their own ADR names the insertion rules" — and
because the refusal direction ("never mutate a plan") must become a
structural property, not a hope. Terms already canonical (attempt, step,
claim, guard, evidence, ledger — ADR-0002 §4, ADR-0005, ADR-0006) are used
verbatim and are not re-decided.

## Decision

1. **The hook lives in `src/execution/` — no new layer.** The hook is
   execution's own extension of the step seam (the taxonomy's adapter kind);
   a separate `src/hooks/` would re-own step identity the kernel already
   locks. Phase 6 ships the declared hook value, the scheduler, and the
   reconciliation paths beside the kernel and ledger they extend, mirroring
   Phase 4/5's posture. No runtime dependency enters (the house rule).
2. **A hook is a declared value with a caller-injected effect; the engine
   never stores or invents user code.** The hook declaration is pure data —
   an identifier, an anchor, declared preconditions, declared
   postconditions. The effect is a function the caller supplies at the seam;
   the engine invokes it and records what it returns. The kernel's purity
   (ADR-0001) is untouched: no effect ever executes inside `core/domain/`,
   and no effect is persisted — the ledger records outcomes, not code.
3. **Insertion rules (the closed vocabulary's named extension).** The
   canonical eight stages gain a sibling key space: `StepKey` extends to
   `StageKey | HookStepKey`, where `StageKey` is the unchanged canonical
   eight and `HookStepKey` is `` `hook:${string}` `` — a hook's ledger key is
   `hook:<id>`, unique per attempt. A hook declaration anchors at exactly
   one canonical stage, `before` or `after` it; the attempt's **effective
   step list** is the canonical sequence with each hook inserted at its
   anchor, declaration order breaking ties at the same anchor. The plan
   value and the plan fingerprint are untouched: hooks attach at the
   execution seam, never in a plan (the taxonomy's "it can never mutate a
   plan", model-c question c). `StageKey` becomes the explicit name for the
   eight; every port that means "one of the canonical stages" narrows to it.
   Loudly: the attempt value gains an optional execution-side `hooks` field
   — declared data the scheduler and resume read — while `attemptIdentity`
   stays `attempt_sha256` over `{planId, ordinal}` and the plan fingerprint
   is untouched.
4. **Preconditions are claim requirements, evaluated as the transition's
   guards.** A hook's preconditions name claims that must be held and
   verified before the effect may run; they ride the kernel's existing
   guard machinery and are recorded verbatim on the hook's start record.
   There is no second guard system — a precondition the kernel cannot
   verify is the kernel's recorded refusal, not a hook-runtime invention.
5. **Postconditions are recorded proofs on the completion record.** A
   postcondition declares what proof the completion must carry (a content
   fingerprint, non-empty evidence). The scheduler checks the proof before
   recording completion; the proof lives on the record, so replay and
   resume re-read it rather than re-run anything.
6. **Hook steps obey the ledger discipline exactly.** Write-ahead: the
   hook's start is durable before the effect may run (ADR-0006 decision 2);
   a completed hook is never re-executed — replay is the ledger projection's
   business as usual; kill-anywhere extends: truncation at a hook boundary
   classifies identically under double-run, and resume's classification
   walks the effective step list, so a resume may continue at a hook step.
7. **Plan-mutating hooks are refused by construction.** The effect's return
   type (the hook observation) carries attribution, optional evidence and
   content fingerprint (present when the declaration demands them), and
   optional caller metadata — no plan-shaped field
   exists, and the engine exposes no port by which a hook could hand back a
   modified plan or attempt. The refusal is structural (type-level), pinned
   by tests that assert the plan value and fingerprint are unchanged after
   effects run; the deep-freeze discipline stays as defence in depth, not
   the gate.
8. **Postcondition failure is a recorded, fail-closed escalation.** A
   failed precondition is the kernel's refusal; a failed or missing
   postcondition proof lands the hook's step record as `failed` and blocks
   the attempt with `blocked(validation)` — the existing blocked vocabulary,
   the cause naming the hook id and the failed postcondition — closed only
   by Phase 5's resolution loop (§2.7 of the phase 5 contract). Nothing
   passes silently; no new attempt state is invented.
9. **The scheduler is classification-driven, not timer-driven.** The
   scheduler walks the effective step list in order, drives each step
   through the kernel's doors, and invokes effects at the seam: no
   timers, no event loops, no environment reads. Determinism holds —
   identical declarations, ledgers, claims, and effects classify
   identically, provable by double-run.
10. **The kernel's time and isolation discipline carries.** No clock,
    randomness, environment, filesystem, or network reads in the hook
    modules; timestamps enter as caller-supplied metadata (the hook
    observation's, verbatim); the isolation gate extends to the hook
    files in the implementation PR.
11. **The public surface is the barrel.** The hook vocabulary exports
    through `src/execution/index.ts`; tests import through
    `../src/index.ts` only (ADR-0001 decision 9's shape, unchanged).
12. **The hooks runtime stays with the adapters.** The engine schedules
    declared hooks and records outcomes; executing arbitrary user code
    against real systems is the adapter tiers' work (Phase 8's git
    binding, Phase 9's GitHub adapter). Phase 6 owns the seam and its
    laws — deliberately not the runtime.

### Amendments this ADR makes (loud, in this PR)

- [release-model.md](../design/release-model.md): the taxonomy's Hook row
  moves **DEFER** → **LOCK** (this ADR names the insertion rules the
  deferral required); the open-items line "hooks, once the execution phase
  defines the step seam" closes.
- [decision-log.md](../design/decision-log.md): D22 records the decision
  set above.

## Consequences

- The step seam is extensible by declaration, not by editing the canonical
  eight — Phase 7's artifact steps extend the same seam through their own
  ADR (the closed-vocabulary comment anticipated exactly this).
- Resume, replay, and the kill-anywhere guarantee hold uniformly over
  canonical and hook steps; nothing hook-specific is special-cased in the
  classification core.
- The engine still executes no user code of its own: every effect is
  caller-injected, every outcome recorded. The gap between "declared hook"
  and "running hook" is exactly the adapters' territory, and stays there.
- What this ADR deliberately does not decide: persistence of hook
  declarations (Phase 8's binding), artifact-producing hooks (Phase 7's
  graph), and any hook notion of channels or promotion (out of scope —
  PR-04's transitions remain the only channel door).
