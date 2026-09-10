---
id: 0004-line-policy
status: accepted
created: 2026-09-06
updated: 2026-09-06
---

# ADR-0004: Line policy — declared per-line configuration as planning input

## Status

Accepted. Implements the Phase 3 line-policy slice ([issue
#23](https://github.com/ecoma-io/release-craft/issues/23), [Phase 3
tracker](https://github.com/ecoma-io/release-craft/issues/17)); consumes the
seams ADR-0001 deferred (the kernel/policy boundary the scenarios name for
M-08) and refines ADR-0003 decision 18 / decision-log D17(8) where this ADR's
Decision 4 says so.

## Context

The scenarios make per-line configuration load-bearing three times, and the
Phase 2 planner deliberately read none of it:

- **M-08** resolves policy per line — `main` mints `2.4.0-rc.1` under an
  allowed `rc` stream while `1.9` mints the stable `1.9.1`, and the
  operator's prerelease request on `1.9` is _rejected with the policy
  reason, recorded, not retried_. A single repository-wide policy either
  forbids prereleases everywhere or mints against policy; the failure mode
  the scenario forbids is the silent fallback to stable.
- **PL-07** makes filtering deferral: a change withheld by declared policy
  stays inside the un-released span (the range cursor must not advance past
  it), enumerated, recoverable after an unfreeze — never deleted from
  consideration.
- **E-09/M-10** give lines lifecycles; `LineConfig.lifecycle` has arrived as
  input since PR-2, but the planner assigned no semantics to `frozen` or
  `retired`.

Three facts constrain the design, inherited from ADR-0003:

- The planner is a pure function of closed input (invariants 2–3); line
  policy is input data validated at the boundary, never ambient state.
- Defaults are data (RM §5, invariant 1): the zero-declaration path must be
  the default posture of the same schema — no code path keyed on "simple
  mode" survives review.
- Negative outcomes are records (§2.9): a policy refusal is a record on the
  plan, never an exception and never a fallback.

## Decision

1. **Per-line stream policy** — `LineConfig.streams: {allow?, seed?}`.
   `allow` is `"all"` (the default posture: every declared or ladder
   identifier is mintable), `"none"` (the line is stable-only), or an
   explicit identifier list — an opaque identifier is legal exactly by
   declaration (fork 4's open-identifier resolution), while the ladder's
   fixed order stays global promotion-slice data (fork 3). `seed` overrides
   `policy.prereleaseSeed` for the line's fresh keys (fork 17, recorded per
   stream since ADR-0003). `allow: "none"` turns a `prerelease` intent into
   a **recorded refusal on the plan** (`ReleasePlan.refusedIntents`, a
   fingerprinted tuple member): M-08's rejection half — recorded, never a
   stable fallback, and the rest of the plan is unaffected (M-08's
   stable-only line still releases its own change set in the same pass).

2. **Lifecycle semantics** — `lifecycle: "frozen" | "retired"` refuses
   release-shaped planning for the line as a `refused` record
   (`line-frozen` / `line-retired`): no targets, no streams, no release
   entry, everything else in the plan unaffected. The states are the
   declared vocabulary; the refusal is the planning semantics (taxonomy
   §1.14: vocabularies stay policy data).

3. **Withhold rules** — `LineConfig.withhold: {scope, reason}[]` (PL-07).
   Matching release-triggering changes are deferred: the release range pins
   below the earliest withheld commit so the un-released span keeps them
   (recoverable after an unfreeze), the withheld set is enumerated in the
   plan's explanation (excluded is not invisible), and a line left with
   nothing release-worthy yields the existing `withheld` decision
   (`policy-filter`) instead of a mint.

4. **The component binding** — `LineConfig.publishes` names the declared
   component the line's releases publish through the door. This is the
   executable completion of ADR-0003 decision 18 / D17(8): the door's
   anti-fabrication posture stands (probed against the pre-slice planner,
   the M-08 two-line/one-component world throws
   `InvalidPlanningInputError` naming the mapping gap), and it dissolves
   exactly when every releasing line declares its binding — the mapping
   stops being fabricated and becomes closed input. Undeclared or ambiguous
   mappings (a `publishes` naming an undeclared component; more releasing
   lines than declared bindings can carry) still refuse.
   `planPropagation`'s signature and semantics are unchanged — the door's
   composition may now hand it two releases for one component, which is
   data it already accepts.

## Consequences

- `ReleasePlan` gains a required `refusedIntents` field; the fingerprint
  tuple grows by construction (the fingerprint hashes the plan sans
  `planId`), so plans recording refusals fingerprint distinctly —
  requested-but-refused is plan content, and the identity tests pin tuples
  by spread so future tuple fields cannot drift out of the pins.
- The zero-declaration path is bit-for-bit the Phase 2 behavior: absent
  `streams` = `allow: "all"` + the global seed; absent `withhold` = no
  deferral; absent `publishes` = the D17(8) single-component posture.
- Channels and promotion (the next slice) consume the same schema — the
  ladder's promotion semantics land there, not here.
