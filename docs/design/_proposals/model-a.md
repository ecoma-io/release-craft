# Model A under the scenario matrix — release as (branch, version)

> **Status: Phase 0 design asset (task 0E-a, issue #13, orchestrated run).**
> This document evaluates one candidate release model — Model A — against the
> reconciled scenario matrix and states a verdict. Inputs read in full: the
> reconciled master matrix on `johnitvn/phase0-reconcile`
> (`docs/design/release-scenarios.md`, 53 scenarios), the process taxonomy on
> `johnitvn/phase0-taxonomy` (`docs/design/release-taxonomy.md`, §R1–§R6 and
> the judgment matrix), the release-please behavioral baseline on
> `johnitvn/phase0-rp` (`docs/design/release-please-baseline.md`, §17–§18),
> and the domain-kernel ADR
> ([ADR-0001](../../adr/0001-domain-kernel-and-semantic-version.md)). Nothing
> here describes implemented behavior; the only domain object that exists
> today is the `Version` value. The taxonomy/baseline/matrix documents are
> cited by branch and path, not linked, because they live on their own Phase 0
> branches.

## Method and evidence labels

The taxonomy's label discipline is reused: **OBSERVED** — taken directly from
an input document or repo file, cited inline; **INFERENCE** — reasoned from
observed facts; **RECOMMENDATION** — release-craft's position, argued, not
observed.

Each of the 53 scenarios gets one of three grades:

- **HANDLES** — the stipulated process produces the scenario's intended
  outcome with nothing added.
- **NEEDS-RULE** — a named, bounded special case must be added; once added,
  behavior is correct and no state is silently wrong.
- **FAILS** — the model must invent machinery it has no place to put, or it
  answers wrongly and silently. This grade carries the argument.

## The model under evaluation

Stipulated, at full precision — this is the strongest reading, not a
strawman:

- A **release** is identified by the pair **(branch, version)**.
- The process is **per branch**: each configured branch computes the next
  version from conventional commits since the **last tag reachable from that
  branch's head**, updates files, opens or updates a release PR, and on merge
  tags and publishes.
- **Channels do not exist** as a concept: npm `latest`/`next` are just "the
  tag we publish after merge".
- **Prerelease** is a version-string property plus a **per-branch prerelease
  flag** (and, implicitly, one prerelease identifier per branch).
- **Promotion** means merging a branch, or re-running with a flag flipped.
- **Artifacts** are the outputs of the publish step, keyed by version string.

**Where Model A sits among the matrix's naive assumptions**
[OBSERVED: matrix §"How to read this matrix", N1–N6]. Model A instantiates
N1 (branch = release line), N2 (prerelease = boolean flag, not a stream
identity), and N6 (version string = artifact identity). For N5 it is weaker
than the assumption named: releasedness has no representation at all — a
release "exists" only as its tag. It does **not** instantiate N4: state
derives from tags reachable from the branch head, never from a manifest —
its single best property, and the one the successor must keep. N3 it
half-instantiates: the open release PR is a quasi-plan, but it is not
persisted, fingerprinted, or invalidatable as an object.

## Part 1 — Steelman: the strongest honest case

1. **Zero new concepts.** [RECOMMENDATION] Branch, tag, commit, PR, version
   string — everything Model A names already exists in the user's head and in
   git. Nothing to learn before the first release. This is not a small virtue:
   it is the difference between adoption and a design document.
2. **It is release-please's actual shape, proven at scale.** [OBSERVED:
   baseline §9.1–§9.2 per-branch `target-branch` workflows as the documented
   maintenance pattern; §8.1 `prerelease` + per-branch versioning config;
   §11.1 idempotent re-run; §7 tag-on-merge] Model A is a faithful
   description of how thousands of repos release today with release-please.
   The familiarity argument is empirical, not aesthetic.
3. **Tag-derived state is genuinely strong.** [INFERENCE, per scenario]
   Because truth is "last tag reachable from head", recomputed fresh every
   run: manifest drift is impossible to suffer (S-03); there is no range
   cursor to over-advance past filtered commits, so policy deferral holds
   for free (PL-06; PL-07 fails on the missing withheld record, not on
   deferral); a benevolent external tag is absorbed correctly
   (E-03's happy half); there is no stored plan to go stale, so the entire
   plan-staleness invalidation class is vacuous (E-04, and E-05 reduces to
   deterministic recomputation over fixed inputs); computation deferred to
   merge time is re-verification at execution (PL-08, E-11).
4. **Per-branch is per-line for the common topology.** [INFERENCE] The
   matrix's scariest-sounding class — multi-line — is mostly just works under
   Model A: independent version spaces per branch (M-04, M-06), own-tag
   ranges (M-07), per-branch policy (M-08), maintenance-first releases
   (M-09), independent parallel lines (M-01, M-02). Seven of eleven
   MULTI-LINE scenarios grade HANDLES.
5. **The failure posture is "nothing to corrupt".** [INFERENCE] The model
   holds no mutable engine state; the world (git + registry) is the store. A
   crashed run leaves nothing half-written by the engine itself. Tag pushes
   are naturally atomic and unique, which gives concurrent runs a free
   compare-and-swap at exactly the right boundary (E-07, E-08 — the loser's
   tag push is rejected).
6. **The trivial repo pays zero tax.** [RECOMMENDATION] One branch, one
   config entry, maybe a prerelease flag. Question (d) below answers
   honestly: for the 80% repo, Model A is the default mental model and the
   complexity tax is zero.

This is a real model with a real domain of validity. The case against it is
not that it is stupid; it is that its domain of validity ends exactly where
release-craft's charter (issue #13: lines, prerelease lines, hooks,
artifacts, publishing for humans and agents) begins.

## Part 2 — The matrix run, class by class

Verdicts per the method section. [OBSERVED] facts cite the input documents;
behavioral derivations are [INFERENCE]; grades are [RECOMMENDATION].

### SIMPLE (S-01 … S-05)

- **S-01** (chore-only runway) — **NEEDS-RULE.** No bump from
  chore/docs/ci is the conventional default [OBSERVED: baseline §1.4,
  "not a releasable unit"], so no PR opens; but the scenario's demand — a
  _recorded_ no-op decision with its cause — has no home. The model can be
  silent-correct; it cannot be audible-correct.
- **S-02** (first release) — **NEEDS-RULE.** Bootstrap default (`0.1.0` vs
  `1.0.0`) is one config knob [OBSERVED: baseline §2.3 `initial-version`];
  recorded bootstrap decision again homeless.
- **S-03** (manifest drift) — **HANDLES.** The model never reads a manifest
  as truth; "line tag history outranks the manifest" [OBSERVED: matrix
  stress analysis names S-03's ordering as prerequisite] holds by
  construction.
- **S-04** (release-worthy ≠ changelog-worthy) — **NEEDS-RULE.** Per-type
  section/hidden config decouples the two [OBSERVED: baseline §3.2
  `changelog-sections`]; standard.
- **S-05** (major cut, maintenance line lives) — **NEEDS-RULE with a silent
  hazard.** Per-branch computation yields `2.0.0` on main and `1.9.x` on the
  line independently — correct. But publishing `1.9.1` after `2.0.0` flips
  npm `latest` backwards unless the publish step is told "this branch must
  not take latest" [INFERENCE from baseline §8.1/§9.2 patterns: the dist-tag
  decision is branch-keyed]. That instruction is a channel field in disguise,
  living in CI glue, unaudited.

### PRERELEASE (P-01 … P-07)

- **P-01** (alpha.9 → alpha.10) — **NEEDS-RULE.** Next-of-stream must be
  derived from tags by numeric prerelease increment, never lexicographic
  [OBSERVED: baseline §8.2 `bumpPrerelease` increments the last number group;
  matrix N2 "naive ordering breaks exactly at 10"]. Tag-derived derivation
  works; the rule must be stated or the .10 boundary breaks silently.
- **P-02** (alpha → beta → rc ladder) — **FAILS.** One flag = one identifier;
  there is no stream identity, no per-stream numbering, no ladder. Re-running
  with the flag changed mints `1.2.0-beta.0` while `rc.1` is live — a silent
  regression the scenario explicitly refuses [OBSERVED: matrix P-02 expected
  failure behavior]. To fix it ad hoc the model must parse every tag,
  order identifiers by SemVer §11.4 ASCII rank, and enforce monotonic
  progression — i.e. rebuild stream identity out of string parsing,
  distributed across scripts.
- **P-03** (rc → stable across zero diff) — **NEEDS-RULE, and the rule is
  load-bearing.** "Next version from commits since the last tag" with zero
  commits yields _nothing_ — the most common prerelease ending deadlocks.
  The flag-off strip rule (last tag is prerelease + flag off → mint the
  stripped core) must be added [OBSERVED: baseline §8.2, `prerelease: false`
  strips the suffix]. Residue: the `promoted-from` edge and rc-stream
  closure the scenario demands are unrepresentable (N3/N5).
- **P-04** (feat mid-RC) — **NEEDS-RULE, fragile.** Correct answer
  `1.2.0-rc.2` requires: parse the live tag's core (`1.2.0`), recognize the
  in-flight target, apply the feat's minor to the _target_ (already in
  flight → no core move), increment the sequence. The naive rule — apply the
  bump to the core — ships `1.3.0-rc.1` or unmasks `1.2.0` with an
  unreviewed feat [OBSERVED: matrix P-04 names both naive outcomes wrong].
  Expressible as string rules, but they are exactly the per-stream
  sequencing the model declines to model, and they multiply (see P-05).
- **P-05** (breaking mid-RC) — **FAILS.** The target move itself is
  computable (parse core, major bump, reset-sequence rule → `2.0.0-rc.0`).
  What fails silently: the scenario demands the abandoned `1.2.0-rc.*`
  sequence be _recorded_ as superseded/orphaned [OBSERVED: matrix P-05
  "supersession record", "resolvable forever"]. Model A has no object any
  record can attach to; the old tags just sit there meaning nothing.
- **P-06** (two streams, one target) — **FAILS structurally.** One branch
  carries one flag; `alpha.4` and `rc.1` live on the same commits by
  stipulation. The escape is branch-per-stream plus filtering reachable tags
  by identifier prefix — string-parsing again — and it breaks silently when
  a sync-merge is forgotten: the stale branch's range then swallows the
  other stream's commits [INFERENCE from reachability semantics].
- **P-07** (RC-first on the maintenance line) — **NEEDS-RULE.** The version
  computation is right by construction (own tags → `1.2.4-rc.0`). Needs:
  the "a patch line cannot jump its major" refusal policy, and the same
  `latest`-flip hazard as S-05. Cross-line provenance edge unrepresentable
  (cosmetic here).

### MULTI-LINE (M-01 … M-11)

- **M-01** (fix on maintenance line) — **HANDLES.** Ancestry-scoped range
  per branch; main computes an empty set and does nothing.
- **M-02** (three independent lines) — **HANDLES.** Three branches, three
  ranges, three PRs. No shared mutable state file exists to fight over —
  the manifest-conflict pain release-please users know [OBSERVED: baseline
  §5.3 manifest as durable state] is dodged by having no manifest.
- **M-03** (one fix, three lines, cherry-picks) — **FAILS.** No change
  identity exists. When the maintenance branches later merge back, F′/F″
  are ordinary new commits inside main's range: duplicated changelog
  entries and re-attributed bumps, silently [INFERENCE from range-based
  attribution]. The ad hoc fix — parse `(cherry picked from …)` trailers
  (open fork #8) into a dedup filter — is change identity rebuilt as a
  regex.
- **M-04** (clean backport; main must not move) — **HANDLES.** Releasedness
  per branch is exactly the (line, change) predicate for release mechanics;
  F stays pending on main.
- **M-05** (conflicting backport) — **HANDLES** for behavior (independent
  releases are correct); the lineage edge the scenario wants for
  traceability is unrepresentable — a documentation gap, not a behavior gap.
- **M-06** (backport of an already-released change) — **HANDLES.** Per-branch
  tags are per-line version spaces; no global suppression rule exists that
  could misfire.
- **M-07** (divergent maintenance line) — **NEEDS-RULE.** Own-tag range
  discovers D and F1 correctly; "feat on a fix-only maintenance line must be
  rejected loudly" is a per-branch policy the config grain supports
  natively.
- **M-08** (prerelease here, forbidden there) — **HANDLES.** Per-branch
  policy flags are the model's native grain; the refusal-on-1.9 is config.
- **M-09** (fix released on maintenance before main) — **HANDLES.** `2.3.1`
  computed normally; no "greater version contains lesser versions" rule
  exists to misfire. Cross-line changelog cross-reference unrepresentable
  (cosmetic).
- **M-10** (line renamed or retired) — **FAILS (one half silently).**
  Rename: tags and computation survive, but release identity — the pair
  (branch, version) — is unstable across the rename, and every branch-keyed
  config must be migrated by hand [INFERENCE; the matrix's "ledger orphaned
  on rename" failure is softened only because the ledger is tags]. Retire:
  deleting the branch's config makes post-retirement commits _silently
  invisible_ — exactly the "withheld, not dropped" outcome the scenario
  forbids. There is no withheld state to record.
- **M-11** (same version on two lines) — **NEEDS-RULE.** The pair
  distinguishes releases conceptually, but the model's only storage — git
  tags — is a global namespace keyed by version string alone, so the
  collision is real at exactly the layer the model stores [OBSERVED: matrix
  M-11 "conflation of the version space (per line) with the tag namespace
  (global)"]. The demanded resolution — keep both maps, verify the tag does
  not exist at any commit before execution — reduces here to a global
  uniqueness check; without an explicit pre-execution tag-exists check the
  failure is git's push rejection mid-release (half-applied).

### PLANNING (PL-01 … PL-08)

- **PL-01** (monorepo: one package changed) — **FAILS structurally (axis
  absent).** (branch, version) has no package axis; the model computes one
  repo-version per branch. Per-package tags/config per branch is a config
  explosion, not a model. The matrix marks the multi-package workspace
  hypothetical-future [OBSERVED: matrix PL-01 initial state], but the
  taxonomy's "first model must not preclude" list and the baseline's
  classification of monorepo grouping as ADAPT [OBSERVED: baseline §17] both
  require the axis to be admissible. It is not.
- **PL-02** (dependency propagation) — **FAILS structurally (same axis).**
  No package graph, no range math, no topological propagation.
- **PL-03** (neighbors must not move) — **vacuous today; FAILS structurally**
  under the monorepo future for the same reason.
- **PL-04** (release PR's own output) — **NEEDS-RULE.** The release commit is
  chore-typed: excluded from the bump and hidden from the changelog by the
  same default that handles S-01 [OBSERVED: baseline §1.4, §3.2]. The
  bot-marker hardening (deterministic author+trailer identification) is an
  addable rule.
- **PL-05** (ambiguous commits) — **NEEDS-RULE (two of three).** (b) the
  BREAKING CHANGE footer must force the bump despite a filtered type — the
  parser already separates footer detection from type [OBSERVED: baseline
  §1.2]; (c) the range walk policy (first-parent vs topological) must be
  stipulated once. (a) scope→package is deferred with PL-01.
- **PL-06** (empty change set) — **HANDLES.** The recomputed range leaves no
  cursor to over-advance: a later policy change un-ignoring `docs:` still
  finds those commits — the deferral invariant holds for free. The
  no-op-as-result needs the same rule as S-01 to become audible.
- **PL-07** (withheld by package policy) — **FAILS structurally (package
  axis).** The single-package analog (line freeze) fails like M-10's retire
  half: no withheld record exists.
- **PL-08** (stale plan; change set grew mid-flight) — **HANDLES
  behaviorally, with an audit residue.** "Opens _or updates_ a release PR"
  plus recompute-per-run _is_ plan regeneration: one live PR, changelog
  covering the union, and the concurrent-merge retarget falls out of
  tag-derived state (the merged tag becomes the base; the next computation
  retargets). What is lost: the plan as an identity — fingerprint,
  supersession chain, validation-vs-execution binding. That residue is
  precisely N3's complaint [OBSERVED: matrix PL-08 abstraction note] and it
  returns with interest in EXECUTION.

### ARTIFACTS (AR-01 … AR-06)

- **AR-01** (one release, three artifacts) — **FAILS.** The happy path
  publishes three things, but the scenario's demand — per-artifact state
  tracked individually, the release complete only when all three are
  recorded published [OBSERVED: matrix AR-01] — has no substrate. The
  publish step is one fire-and-forget; "done" is not a predicate, it is the
  absence of an exception.
- **AR-02** (registry propagation delay) — **FAILS silently.** No verify
  step, no artifact-dependency edge, no recorded digest: the image build
  bakes the 404 or the stale layer, and the partial state that should hand
  off to recovery is unrecordable [OBSERVED: matrix AR-02 failure behavior].
  A hook can perform a check but cannot _record_ it anywhere the model
  reads.
- **AR-03** (artifact scheme differs; moving tags) — **FAILS structurally.**
  Moving container tags are channels with event logs; digest-as-identity is
  absent; the `v2`-move-fails-after-`2.0.0`-succeeded split visibility is
  undetectable. Ad hoc: publish-script string logic — N6 verbatim.
- **AR-04** (nightly and stable from one commit) — **FAILS structurally.**
  Two gaps compound: nightly is a second stream on the branch (P-06's
  structural failure), and it is a _build that allocates nothing_ — N3
  again; every run of the stipulated process computes a release, so
  "scheduled build, not a release" is inexpressible.
- **AR-05** (orphan artifact; ledger lost) — **FAILS silently.** No attempts,
  no ledger, no probes. Crash-after-publish plus retry hits npm immutability
  as a confusing error — or, on a permissive registry, double-publishes two
  bodies under one version: the scenario's named worst outcome, reached by
  the model's default recovery ("re-run the process") [OBSERVED: matrix
  AR-05 failure behavior].
- **AR-06** (draft GitHub Release with stale notes) — **FAILS.** Re-run
  regeneration covers the benign overwrite; the scenario's core — drafts as
  attempt-owned intermediate state with per-state attribution and
  foreign-draft escalation — has no owner concept to bind.

### EXECUTION (E-01 … E-11)

- **E-01** (crash after tag push) — **FAILS silently; the worst failure in
  the run.** Tag `1.5.0` exists → the next computation treats `1.5.0` as the
  released base → the missing npm publish, GitHub Release, and channels are
  never noticed by anything. The model reads tag existence as _completion_,
  exactly where the truth is "half a release" [OBSERVED: matrix E-01 "the
  crash window between steps is the normal case"]. Complete-in-place vs
  void-and-skip requires a ledger to consult; there is none.
- **E-02** (amputated mid-publication) — **FAILS structurally.** Resume is a
  query over per-step completion; the model's only recovery is recompute,
  which post-tag collapses into E-01's misreading. Per-step idempotency keys
  and digest verification are unrepresentable.
- **E-03** (the tag appeared) — **FAILS on one half.** Steelman half: a
  benevolent external tag at the intended commit is _absorbed correctly_ by
  tag-derived state — satisfied-externally for free. Failure half: a tag at
  the _wrong_ commit is adopted with equal silence — the satisfied-vs-conflict
  distinction requires stored intent to conflict against, and the model has
  none.
- **E-04** (policy flips under a stored plan) — **HANDLES vacuously.** No
  stored plan, no drift; every run re-reads policy. The cost is charged
  elsewhere: nothing binds validation to execution (feeds E-05/E-09).
- **E-05** (retry must reproduce the same plan) — **NEEDS-RULE.** With no new
  commits (the scenario's stipulation), recompute over fixed inputs is
  deterministic — the stateless model is _more_ robust against stale-plan
  replay, not less. The rule to add: no clock reads or environment reads in
  generated metadata, and reproducible builds, so same-input recompute
  yields same digests.
- **E-06** (the foreign tag) — **FAILS silently.** The trap scenario is
  built exactly against this model: a human pushes `v1.4.2` (needing
  tag-parsing rules on top), and tag-derived state adopts it as release
  truth without a stutter. "Attribution beats observation" [OBSERVED: matrix
  E-06] is not merely unimplemented here — resume-by-inference is the
  model's _default behavior_.
- **E-07** (two CI jobs, one line) — **NEEDS-RULE.** Tag-push uniqueness is a
  real CAS at the right boundary: the loser's push is rejected. What is
  missing is the protocol — claim before _any_ mutation, re-verify ownership
  after each step, attribute the loser's abandonment. The primitive is
  present; the discipline is not.
- **E-08** (two runs compute the same rc number) — **NEEDS-RULE.** Both
  compute `1.6.0-rc.1` → the tag collision serializes them; the loser
  recomputes `rc.2` from the winner's tag. Bounded-retry-on-CAS-loss
  emerges naturally; it must be stated as protocol (and npm's immutability
  backs the same invariant at the registry).
- **E-09** (human intervention) — **FAILS.** Recompute absorbs the
  force-push benignly (PL-08's path), but the scenario's core demands — the
  abort honored as an authoritative recorded event, abandoned-by-human as a
  terminal state, the orphan-tag registry — all need an attempt/ledger
  substrate that does not exist.
- **E-10** (clock anomalies) — **HANDLES.** Ranges are reachability, not
  dates; the nightly stamp is a string label nothing orders by. The
  stateless model never sorts history by author date because it never sorts
  history at all.
- **E-11** (stale plan; hotfix interleave) — **HANDLES.** Computing at merge
  time _is_ re-validation at execution: base re-read from tags, range
  re-derived, content correct. Per-line ranges isolate the hotfix line.
  Residue: no audit trail of what was re-derived and why.

### PROMOTION (PR-01 … PR-05) — the killing floor

- **PR-01** (promote without rebuild) — **FAILS structurally.** "Promotion =
  re-run with the flag off" produces: the P-03 zero-diff deadlock, or — with
  the strip rule — a _new_ version `1.2.0` that is tagged and _published
  anew_: rebuilt, re-uploaded, new digests. The scenario's contract — same
  bytes, digest equality as precondition, identity re-bound not regenerated
  [OBSERVED: matrix PR-01; taxonomy §R5: re-pointing ≠ new release] — is not
  weakly supported; it is _unrepresentable_. The model cannot even record
  the rc's digests to compare against.
- **PR-02** (promote with rebuild; two generations) — **FAILS structurally.**
  Version string = artifact identity means two bodies under `1.2.0` is
  either impossible (npm refuses the second publish — correct tool, wrong
  story) or silent (mutable registries overwrite, untracked). Generations
  need a place; the model has none.
- **PR-03** (stale evidence) — **FAILS structurally.** Evidence bundles,
  TTLs, blocked-but-resumable state: all records. Hooks can run checks; they
  cannot gate with recorded freshness, and their results have no home.
- **PR-04** (backward channel move) — **FAILS structurally.** Rollback in
  this model is `npm dist-tag add pkg@1.1.9 latest` typed by hand: outside
  the model, unrecorded, no expected-prior-state CAS, replay-unsafe
  [OBSERVED: matrix PR-04; taxonomy §R1 npm dist-tag as the canonical
  mutable pointer]. Adding a dist-tag field to per-branch publish config
  imports channels through the back door — at which point the model has
  channels again, but history-less and unaudited.
- **PR-05** (one release, many channels, over time) — **FAILS structurally.**
  Membership as a graph with a timeline [OBSERVED: matrix PR-05] is
  unanswerable from branch-derived state, which yields only the present:
  "which channel served 1.3.0 on Thursday?" — the incident-review question —
  has no answer.

### Tally

| Grade      | Count | Scenarios                                                                                                                                                           |
| ---------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HANDLES    | 13    | S-03, M-01, M-02, M-04, M-05, M-06, M-08, M-09, PL-06, PL-08, E-04, E-10, E-11                                                                                      |
| NEEDS-RULE | 15    | S-01, S-02, S-04, S-05, P-01, P-03, P-04, P-07, M-07, M-11, PL-04, PL-05, E-05, E-07, E-08                                                                          |
| FAILS      | 25    | P-02, P-05, P-06, M-03, M-10, PL-01, PL-02, PL-03, PL-07, AR-01, AR-02, AR-03, AR-04, AR-05, AR-06, E-01, E-02, E-03, E-06, E-09, PR-01, PR-02, PR-03, PR-04, PR-05 |

[INFERENCE] The distribution is the finding: 28 of 53 in the top two grades,
concentrated almost entirely in SIMPLE and MULTI-LINE — the classes a
per-branch tool meets daily. Every failure concentrates where the matrix
says the domain actually lives: stream identity (P-02, P-05, P-06), execution
state (E-01, E-02, E-03, E-06, E-09, AR-05), artifact identity (AR-01 through
AR-06), channels (PR-01 through PR-05), and identity substrates (M-03, M-10,
M-11).

## Part 3 — The six fixed questions

**(a) Where do branch/channel semantics leak into core?**
[RECOMMENDATION] Structurally, everywhere — because the branch _is_ half of
release identity. The computation core is branch-keyed by definition, so the
domain cannot say "a line fed by two branches" (P-06's collapse), survive a
rename with identity intact (M-10), or admit a line with no branch (the
taxonomy's Chrome counter-example [OBSERVED: taxonomy §1.2, §R1]). The
channel semantics leak worse because they leak _out_: npm `latest` vs `next`
vs nothing is decided per branch inside publish glue — a channel table
distributed across CI files, unrecorded and unaudited (S-05, P-07, PR-04).
The model does not exclude channels; it makes them deniable, which is why
they come back as string-parsed tag filters (P-02, P-06) and per-branch
publish flags (PR-04).

**(b) Is failure/recovery representable?**
[RECOMMENDATION] Only the pre-tag half. Before the tag push, statelessness
is a virtue: recompute is idempotent, external convergence is absorbed
(E-03's good half), nothing half-written is ours. After the tag push, the
model has no vocabulary for what happened: no attempt, no ledger, no partial
states, no orphan registry (E-01, E-02, E-09, AR-05). Recovery degenerates
to "re-run the process", which is correct exactly when nothing external
happened and silently wrong otherwise — and E-06 shows the default recovery
path is the trap scenario itself.

**(c) Are hooks compositional?**
[RECOMMENDATION] Superficially yes, essentially no. Hooks bolt onto named
steps of the fixed pipeline (the release-please plugin precedent
[OBSERVED: baseline §12.3, taxonomy §1.15]) — but they cannot introduce
state (no store to read or write), cannot gate with recorded semantics
(PR-03's TTL evidence, E-04's revalidation), cannot form dependency edges
between steps (AR-02's verify-then-build), and their results vanish with the
runner (E-02's resume). They are side-effect slots in a stateless pipeline —
composition without accumulation. Every stateful behavior the matrix demands
is one hooks cannot deliver.

**(d) Do simple releases stay simple — the tax on a trivial repo?**
[RECOMMENDATION] Yes; this is Model A's crown and the successor must not
forfeit it. A single-branch repo needs one config entry and learns nothing.
The tax arrives with the second line and is paid in glue, not in the model:
latest-pinning per branch (S-05), stream-branch synchronization (P-06),
backport changelog hygiene (M-03) are each re-solved per repo in CI wiring.
The honest statement: complexity is zero at one branch, and _unbounded and
uncentralized_ at three.

**(e) What special cases does it require in total?**
[RECOMMENDATION] Counting the NEEDS-RULE and ad-hoc-invention list from
Part 2: (1) numeric prerelease increment over tags (P-01); (2) flag-off strip
rule (P-03); (3) target-vs-sequence bump rule for in-flight prereleases
(P-04); (4) ladder/identifier monotonicity guard via §11.4 string ordering
(P-02); (5) branch-per-stream plus identifier-prefix tag filtering (P-06,
AR-04); (6) bootstrap default (S-02); (7) no-bump→no-PR policy, ideally with
a recorded no-op (S-01, PL-06); (8) per-type changelog sections (S-04);
(9) per-branch "don't take latest" publish config (S-05, P-07, PR-04);
(10) breaking-footer-forces-bump and walk-policy rules (PL-05); (11) bot
commit filter (PL-04); (12) pre-execution global tag-exists check (M-11);
(13) cherry-pick trailer parsing for changelog dedup (M-03); (14) loser
detection + bounded retry on tag CAS loss (E-07, E-08); (15) tag-name
parsing incl. `v`-prefix tolerance (E-06, and every tag-derived rule
already listed). [INFERENCE] Read together, these fifteen rules are the
line/stream/channel/attempt model re-derived as scattered string parsing —
which is the strongest internal evidence that the concepts are real and
merely homeless.

**(f) Can it represent release identity distinct from the version string
(same version on two lines)?**
[RECOMMENDATION] On paper yes — the pair (branch, version) — and in every
place that matters, no. The pair's two halves live in different worlds: the
branch in mutable config and PR titles, the version in the global tag
namespace. M-11 shows the storage layer (tags) cannot hold the distinction
the pair promises; M-10 shows the config layer's half (branch name) is
unstable under rename. The matrix's demanded resolution — per-line version
spaces _plus_ a global tag map, checked against each other — is only
half-expressible: Model A has the global map and nothing else. Identity that
exists only in prose is not identity.

## Part 4 — Verdict

**REJECTED** as the core model for release-craft. [RECOMMENDATION]

The scenarios that kill it, by class:

- **PROMOTION, wholesale** — PR-01, PR-02, PR-03, PR-04, PR-05: no channels,
  no generations, no evidence, no history. A release engine that cannot
  promote without rebuilding or roll back with a record is missing the
  domain's second half.
- **Execution state** — E-01, E-02, E-03, E-06 (plus AR-05): tag existence
  misread as completion; resume-by-inference as default behavior.
- **Artifact identity** — AR-01 through AR-06: version-string-keyed outputs
  with no digest, no generations, no per-artifact states.
- **Stream identity** — P-02, P-05, P-06: prerelease as boolean + string
  parsing.
- **Identity substrates** — M-03, M-10, M-11: change identity and line
  identity have no storage.
- **Package axis** — PL-01, PL-02, PL-03, PL-07: deferred per the matrix's
  "hypothetical future" stamp, but the model's identity axis cannot _admit_
  a package dimension without changing what a release is — which fails the
  taxonomy's must-not-preclude bar [OBSERVED: taxonomy §3, "must not
  preclude" list].

**Why not SURVIVES-WITH-AMENDMENTS.** [RECOMMENDATION] The amendment list
needed to clear the FAILS column is: a release entity with its own identity;
prerelease streams with per-stream sequence state; channels as recorded
mutable pointers; artifact generations keyed by digest; attempts with a
write-ahead ledger; per-package version spaces. That is precisely the six
concepts the taxonomy locks (ReleaseLine, Channel, Change/ChangeSet,
Release, Artifact, plus the execution layer) [OBSERVED: taxonomy §4].
Amended to competency, Model A is no longer Model A — the amendment _is_
the successor. What survives rejection is a set of properties, and they are
worth stating as inheritance:

1. **Tag-derived, recomputed state** — never a manifest scalar, never a
   stored "next version" (S-03, PL-06 deferral, E-04, E-10, E-11).
2. **Compute at the last responsible moment** — version and notes derived at
   execution, re-verified against current state (PL-08, E-11).
3. **Tag-push CAS as the allocation primitive** — the seed of the claim
   protocol (E-07, E-08).
4. **Per-line grain for everything** — the per-branch computation is already
   per-line for the common topology (MULTI-LINE's seven HANDLES).
5. **A zero-concept 80% path** — one branch must map to one line and one
   channel with no user-visible vocabulary tax (Part 1, question d).

## Part 5 — Proposed alternative

[RECOMMENDATION] The alternative is not invented here; it is the taxonomy's
locked vocabulary made executable while keeping Model A's four surviving
properties as design constraints.

**Definition.** A release is an event with its own identity on a **release
line** — a durable, ordered stream of versions with a stable id, a head, and
a policy. The **next version on a line** is derived from the line's tag
history (never a manifest scalar) and allocation is serialized by a **claim**
on the line's next version — tag-push compare-and-swap with ownership
re-verified before each mutating step. **Branches are source-scoping
adapters** bound to lines by configuration; a line may be fed by several
branches and survives renames. **Prereleases are per-stream sequences**
(line, target, identifier) under an ordered ladder policy. **Channels are
named, mutable pointers** over a line's releases (npm dist-tags and
container tags are backend bindings), every move a recorded event with
expected-prior-state CAS; promotion without content change is a channel move
or a maturity reclassification carrying a `promoted-from` edge — never a
rebuild; rollback is a backward channel move, hidden, never erased.
**Artifacts are (kind, coordinates, content-digest) records** bound to a
release in immutable generations; publish steps are idempotent,
ledger-resumable operations attributed to an attempt. **Execution** is plan
(persisted, fingerprinted, invalidatable) → attempt (claim + write-ahead
ledger) → publication; failure is a legal, reconcilable state, and recovery
is ledger classification with attribution beats observation — never
recompute-and-hope. **Change identity** survives cherry-picks so a change
releases once per line and is traceable across lines. All of it must
degenerate gracefully: with one branch and default policy, the model presents
exactly Model A's face — one line, one channel, tag-on-merge — and the
additional concepts materialize only when a scenario demands them.

**Top three risks.**

1. **Concept weight on the 80% repo.** Six concepts is a documentation and
   config surface that Model A does not have; if the zero-concept default
   path is not guarded as a first-class product property, the tool becomes a
   design document with a CLI. Mitigation: the default mapping (one branch ⇒
   one line ⇒ one channel) must be the tested, documented, dominant path —
   measured by how much of the test suite can be written without naming a
   channel.
2. **Two sources of truth.** Tag-derived state (inherited, rightly) and
   recorded state (ledger, channel events, generations) can disagree, and a
   reconciliation discipline wrong once is worse than no ledger — the ledger
   then lies with authority (the exact failure E-06 warns about, one level
   up). Mitigation: attribution beats observation as an invariant everywhere
   state is adopted; recorded state is advisory until verified against the
   world; conflicts block toward a human instead of resolving silently.
3. **Scope gravity.** The model invites building channels, generations, and
   evidence infrastructure before anyone needs them — in a repo that is, per
   its own README, a one-package canary [OBSERVED: README status section].
   Mitigation: land the alternative as identity seams and extension points
   (stable ids, stream keys, digest fields, ledger _interface_), with the
   subsystems behind them built only when a scenario from the matrix is
   scheduled — the matrix's own "hypothetical future" stamps are the
   sequencing signal.

## Unresolved questions

1. **Claim mechanism parameters** (open fork #13): if tag-push CAS is the
   kernel of the claim protocol, what fencing token does a resumed attempt
   carry, and what re-verifies ownership after steps the tag cannot see
   (publish, channel moves)?
2. **Ledger/decision-record storage** (open fork #16): repo files, notes
   refs, or an external store — every choice changes E-01's recovery
   semantics; the purity boundary only requires it stays out of
   `core/domain/` [OBSERVED: ADR-0001 boundary rows; matrix fork #16].
3. **Change-id marker convention** (open fork #8): Model A's M-03 failure is
   fixable only by adopting one; which — the `(cherry picked from …)`
   trailer, a footer change-id, or both?
4. **Does the `latest`-pinning rule (S-05, P-07) belong to line policy
   (declared, audited) or to publish config (glue)?** Model A's failure mode
   suggests it must become policy data; the successor should decide early.
5. **Nightly as line-release vs artifact class** (open fork #15): AR-04
   fails Model A twice over; the successor must decide whether a nightly
   allocates on the line before the stream model is finalized.
6. **Bootstrap and no-op records** (forks #1, #2): the two NEEDS-RULE
   simples show the model can be silent-correct; whether the successor owes
   the world _audible_ correctness (decision records) is still open and
   shapes the storage answer to question 2.
