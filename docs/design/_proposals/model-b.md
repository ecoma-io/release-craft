# Model B — the linear pipeline, evaluated against the reconciled scenario matrix

> **Status: Phase 0 design asset (task 0E-b, issue #13).** This document
> evaluates MODEL B — a release is a run of a linear pipeline — against the
> reconciled 53-scenario matrix. It is an evaluation for the model
> reconciliation, not a decision record; nothing here describes implemented
> behavior, and the only domain object in the tree is the `Version` value
> ([ADR-0001](../../adr/0001-domain-kernel-and-semantic-version.md)).
>
> Inputs read for this evaluation (all cited by branch, none copied):
> the master matrix `johnitvn/phase0-reconcile:docs/design/release-scenarios.md`,
> the vocabulary lock `johnitvn/phase0-taxonomy:docs/design/release-taxonomy.md`
> (§R1–R6, judgment matrix), the behavioral baseline
> `johnitvn/phase0-rp:docs/design/release-please-baseline.md` (§17–18), and
> [ADR-0001](../../adr/0001-domain-kernel-and-semantic-version.md).

## 0. The model under test

MODEL B, restated from the task definition without interpretation:

1. A release is a run of a linear pipeline: collect changes → compute bump →
   generate changelog → open release PR → on merge, tag → build artifacts →
   publish → announce.
2. Each run executes the pipeline start to finish; **progress state lives in
   how far the current run got** (which stages completed).
3. Re-running starts a new attempt that **detects and skips already-done work
   via ambient state** (existing tags, published versions).
4. One pipeline per repository (or per package in a monorepo).
5. Release lines are just the pipeline run against different base branches.
6. Channels are publish-stage targets.
7. Prerelease is a pipeline input flag.
8. Promotion is re-running later stages with a different target.

Five named properties carry the evaluation, because they are what later
sections turn on:

- **P1 — progress = stage position.** The only execution state is which
  stages of the current run completed; it dies with the runner.
- **P2 — ambient-state idempotency.** A retry discovers prior work by
  observing the world (tags, published versions), never by reading a record
  of intent.
- **P3 — the branch is the line.** Line identity is a config entry naming a
  base branch; there is no other identifier.
- **P4 — channels are publish targets.** Channel state is whatever the
  backend (registry tag, dist-tag) currently points at.
- **P5 — promotion is a re-run.** A promotion is not an operation; it is a
  pipeline invocation starting at a later stage.

## 1. Method and evidence labels

Same discipline as the input documents:

- **OBSERVED** — quoted or closely paraphrased from the three input
  documents or the ADR, cited inline. I read all of them this session.
- **INFERENCE** — my simulation of what Model B would do against an OBSERVED
  scenario contract. Every per-scenario verdict below is INFERENCE.
- **RECOMMENDATION** — release-craft's position: the verdict (§5) and the
  alternative (§6).

Per-scenario verdicts use three values:

- **clean** — the model handles the scenario with its existing stages and
  config; no new concept required.
- **partial** — the model produces the right outcome only after inventing an
  ad hoc input, scan rule, or side-channel; named per scenario.
- **fails** — the model's stated mechanism produces one of the matrix's
  named wrong outcomes, silently; no local patch exists that does not
  reintroduce a concept the model refuses.

## 2. Steelman — the strongest honest case for Model B

1. **Zero new concepts.** One pipeline, eight stages, a config file. The 13
   scenarios Model B handles cleanly (tally in §3.8) need no invention —
   among them first release (S-02), independent per-branch releases
   (S-05, M-02, M-06, M-07, M-09), monorepo scoping (PL-01), and the
   artifact-ordering case (AR-02). For the single-line, squash-merge,
   single-channel repository — the overwhelming majority — Model B is not a
   simplification of the problem; it **is** the problem.
2. **Empirical anchor.** Model B is, to first order, release-please plus a
   publish stage. The baseline (OBSERVED) documents a real, widely deployed
   tool of exactly this shape: two commands, ambient manifest state,
   idempotent re-runs (§11.1). Its OBSERVED limitations — prerelease streams
   cannot coexist (§8.3.2–3), monorepo release is "not transactional"
   (§11.3), a stale label wedges the next release (§11.5), maintenance
   branches need separate workflows (§9.2) — are precisely the matrix's
   PARTIAL/FAILS classes. The steelman's strongest form: **the failure
   classes are known, documented, and accepted by real users.** Model B is
   the 80% tool, honestly marketed.
3. **Ambient-state idempotency works on the happy path.** Re-running after a
   failed run is OBSERVED-safe for release-please (§11.1): the PR is found
   by branch and label, or created. P2 delivers real value exactly where
   failures are infrastructure noise, not logic faults.
4. **Concurrency is serialized for free — twice.** The PR merge linearizes
   competing release attempts at a point GitHub already serializes (the
   taxonomy OBSERVEDs this trick, §1.21), and the tag push is a natural
   compare-and-swap: first writer wins, the loser's push is rejected
   (E-07, E-08). Because the tag stage precedes build and publish, both
   corrupting interleavings the matrix names (double tag, double publish)
   die at the tag stage — provided tag-existence means _fail_, not _skip_
   (an amendment, see E-07/E-08 below, but a small one).
5. **The tag cursor buys two matrix invariants free.** The range is
   "line's last release tag → line's head," so the cursor never advances
   past filtered or withheld commits (PL-06, PL-07's OBSERVED deferral
   invariant) and a release's own commit never re-enters the next range
   (PL-04) — the fixed-point hazard resolves without a bot-commit detector.
6. **Recompute-per-run has a real upside.** With no stored plan, no release
   can execute under a dead rulebook across runs (E-04's inter-run half is
   structurally impossible), and base-staleness (E-11) self-heals once the
   tag scan is reachability-scoped. Model B is **always fresh**; the price
   is E-05, and the steelman says the price is real but rare.
7. **Per-branch runs are accidentally correct on the suppression traps.**
   M-06 and M-09 (backport direction) come out right because Model B has no
   global "already released" rule to misapply — each branch's pipeline sees
   only its own range. The matrix's naive failures there require a concept
   Model B lacks.
8. **The failure surface is holdable in one head.** Eight stages, CI logs,
   tags and registry as truth. Debuggability and teachability are not
   decorative: they are why tools of this shape get adopted and why their
   failure modes get diagnosed by users rather than developers.

That is the honest best case. The rest of this document is what it costs.

## 3. The matrix, class by class

Every verdict is INFERENCE; the scenario contracts are OBSERVED from the
matrix. For each non-clean scenario the table names the invention Model B
requires or the outcome that breaks silently.

### 3.1 SIMPLE

| ID   | Verdict | What Model B must invent / what breaks silently                                                                                                                                                                                                                                                                 |
| ---- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-01 | partial | Exit-0 on an empty range is trivial, but the OBSERVED contract — a durable decision record binding range, commit list, and policy version — has no home. After the run ends, "the tool decided no-op" and "the tool broke" are indistinguishable. Invention: a decision-record side-channel that no stage owns. |
| S-02 | clean   | Bootstrap is a pipeline input (initial version); the baseline's OBSERVED `initial-version` + `bootstrap-sha` config proves the shape works.                                                                                                                                                                     |
| S-03 | partial | Needs two named rules the definition lacks: scan only tags reachable from the base head, and tags outrank the manifest. Without them, manifest-truth computes `1.9.1` — an existing tag (OBSERVED collision) — and the drift is never surfaced or repaired.                                                     |
| S-04 | clean   | Bump-classification and changelog-classification are two independent stage configs; the pipeline separates them naturally.                                                                                                                                                                                      |
| S-05 | clean   | Per-base-branch runs compute `2.0.0` and `1.9.6` independently; there is no global next-version scalar to misuse.                                                                                                                                                                                               |

### 3.2 PRERELEASE

| ID   | Verdict | What Model B must invent / what breaks silently                                                                                                                                                                                                                                                                                                         |
| ---- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-01 | partial | "Next prerelease" is exactly the operation ADR-0001 decision 7 deferred to line policy; compute must grow a precedence-based max over stream tags. String-sorting re-publishes `alpha.9` (OBSERVED collision at 10). The matrix itself concedes tags are sufficient authority here — but the operation is stage-engineering Model B must add, not have. |
| P-02 | fails   | The boolean flag stringifies into a stream name; the ordered ladder, the regression refusal (`beta.0` while `rc.1` live — OBSERVED refusal), and zero-diff publication are three ad hoc inputs. Publication with an identical change set collides with collect-stage gating (see P-03).                                                                 |
| P-03 | fails   | Collect sees an empty range and exits no-op — the promotion deadlocks forever (OBSERVED: "skipping would deadlock the promotion"). Rescue = a start-from-stage input plus changelog inheritance, which means re-running later stages must string-parse its own `CHANGELOG.md` to find rc.1's section — string-parsing promotion, literally.             |
| P-04 | partial | Correct only if compute holds the target from ambient rc tags instead of recomputing the bump. The two naive outcomes are both OBSERVED-wrong and one is silent: recompute mints `1.3.0-rc.1`, stranding `rc.1` on a dead target.                                                                                                                       |
| P-05 | partial | Version arithmetic survives (recompute → `2.0.0-rc.0` outranks everything `1.2.0-*`). The OBSERVED supersession bookkeeping — `1.2.0-rc.1` as `orphaned-prerelease`, resolvable forever — has no representable state; ambient tags cannot record "abandoned."                                                                                           |
| P-06 | fails   | One prerelease flag cannot name a stream. The OBSERVED unacceptable outcomes (bump the wrong stream, bump both, guess on ambiguity) are exactly what a flag-only model produces. Needs a stream selector, live-stream enumeration for the ambiguity error, and collapse detection — a per-line stream table the model does not have.                    |
| P-07 | clean   | A pipeline run against base `release/1.2`, scanning that branch's tags, yields `1.2.4-rc.0`. Model B's own "lines are base branches" is correct here — this is its home turf.                                                                                                                                                                           |

### 3.3 MULTI-LINE

| ID   | Verdict | What Model B must invent / what breaks silently                                                                                                                                                                                                                                                                                                  |
| ---- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M-01 | partial | Works per configured branch — the baseline OBSERVEDs the pattern (one workflow per branch, §9.2). But line discovery and admission are out of band: a new branch nobody configured a workflow for silently never releases.                                                                                                                       |
| M-02 | partial | Three configured runs, independent — mechanically fine; correctness holds, the config tax triples, and nothing in the model knows the lines exist.                                                                                                                                                                                               |
| M-03 | fails   | No change identity exists anywhere in the model. When maintenance merges back to main, main's collect counts F′/F″ as new pending work (the OBSERVED double-count trap); the lineage F ↔ F′ ↔ F″ is unrecordable at any stage.                                                                                                                   |
| M-04 | clean   | Per-branch disjointness: main does not move because nobody ran main's pipeline. The correctness is accidental — absence of a suppression rule to misapply — but the OBSERVED contract holds.                                                                                                                                                     |
| M-05 | partial | Per-line bumps and changelogs are correct; the OBSERVED lineage requirement (F ↔ F′ surviving content divergence, no fuzzy matching) is unrecordable.                                                                                                                                                                                            |
| M-06 | clean   | Per-branch tag scan never consults `2.3.0` → `1.9.1` directly. The global "already released → skip" trap requires a global rule Model B does not have.                                                                                                                                                                                           |
| M-07 | clean   | Range = the branch's own tag to the branch's own head; D and F1 are found without diffing against main (exactly the OBSERVED per-line range definition).                                                                                                                                                                                         |
| M-08 | partial | Config-as-policy yields a de facto refusal (1.9's pipeline has no prerelease input), but an explicit operator request has no channel to land on and the OBSERVED contract — a recorded policy refusal — cannot be produced.                                                                                                                      |
| M-09 | clean   | Same immunity as M-06: main's run sees F″ pending → `2.3.1`; cross-line version ordering is never consulted because nothing compares it.                                                                                                                                                                                                         |
| M-10 | fails   | Config keys (branch names) are the only line identity (P3). Rename orphans the workflow — a silent release stop — or replans the renamed line as a new line from an empty history; retirement is config removal, after which a late fix either releases against policy or vanishes; the OBSERVED withheld-with-reason record is unrepresentable. |
| M-11 | partial | Nothing pre-checks the global tag namespace; the collision surfaces as a git push rejection **after** changelog and build — late, half-applied residue. The tag-CAS rejection is E-07's mechanism, not the OBSERVED plan-time refusal naming both commits.                                                                                       |

### 3.4 PLANNING

| ID    | Verdict | What Model B must invent / what breaks silently                                                                                                                                                                                                               |
| ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PL-01 | clean   | "One pipeline per package" is in the definition; scope/path attribution is a collect-stage mapping table with fail-closed gaps.                                                                                                                               |
| PL-02 | partial | Expressible as a stage/plugin — the baseline OBSERVEDs release-please's `node-workspace` doing exactly this — but topological ordering across packages is orchestration _between_ pipelines, which the linear model does not name.                            |
| PL-03 | partial | Isolation is natural (no run for untouched packages), but the OBSERVED "demonstrable non-impact" negative evidence is a record no stage produces.                                                                                                             |
| PL-04 | clean   | The tag cursor keeps the release commit at/below the tag, outside every later range; the baseline OBSERVEDs release-please recommending the squash-merge discipline that makes this hold.                                                                     |
| PL-05 | clean   | Scope-clash fail-closed, footer-over-type-filter precedence, and the first-parent walk are collect-stage semantics — stage engineering, not model invention.                                                                                                  |
| PL-06 | partial | Exit-0 with a reason is easy, and the tag cursor never advances past filtered commits — the OBSERVED deferral invariant holds for free. But the durable no-op decision with per-commit evidence has no home (same gap as S-01).                               |
| PL-07 | partial | The tag-cursor deferral again keeps withheld commits in range — an unfreeze recovers them, which is the OBSERVED contract. The withheld record keyed by (commit, line, rule) does not exist.                                                                  |
| PL-08 | partial | The open release PR is ambient state: a re-run updates it (OBSERVED release-please behavior, §4.2/§11.2), so regeneration works. Plan identity, supersession edges, and the execute-time fingerprint re-check are implicit at best — nothing records P1 → P2. |

### 3.5 ARTIFACTS

| ID    | Verdict | What Model B must invent / what breaks silently                                                                                                                                                                                                                  |
| ----- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AR-01 | partial | The happy path is fine (stage ordering), but "complete only when all three artifacts are published" is a predicate over a ledger that dies with the runner — progress is stage position (P1).                                                                    |
| AR-02 | clean   | Verify-between-publishes is an explicit stage; ordering dependencies are the pipeline's home turf.                                                                                                                                                               |
| AR-03 | partial | Immutable + moving tags are publish-stage outputs, but the OBSERVED per-tag move event (from, to, cause, release id) is unrecorded — audit exists only in registry-side logs, if at all.                                                                         |
| AR-04 | partial | A second (nightly) pipeline with a stamp input works, and nightly-as-non-release (no line allocation) is expressible; the nightly channel's moves are unrecorded — same gap as AR-03.                                                                            |
| AR-05 | fails   | The ambient-skip doctrine **is** resume-by-inference: the orphan tarball's existence is adopted without attribution or digest check. The OBSERVED contract (existence probes, adoption evidence, integrity hard-stop) is unreachable from P2.                    |
| AR-06 | fails   | A draft is intermediate, attempt-owned state; Model B knows only "exists → skip" (stale notes ship) or "update" (a foreign draft is overwritten). The OBSERVED ownership rule — overwrite rights follow attempt ownership, not name equality — is inexpressible. |

### 3.6 EXECUTION

| ID   | Verdict | What Model B must invent / what breaks silently                                                                                                                                                                                                                                                                                            |
| ---- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E-01 | partial | Complete-in-place emerges from ambient skip — one OBSERVED fork-5 option. But the classification (plan still valid? void-and-record?) cannot run: there is no plan and no ledger, so a crash on a stale plan voids **silently**, burning the tag with no record.                                                                           |
| E-02 | fails   | Resume-by-skip executes the remainder but never verifies completed steps. The OBSERVED contract — digest match before adoption, conflicting-done distinguishable from matching-done — requires records; done-ness is assumed, and the integrity hard-stop is unreachable.                                                                  |
| E-03 | fails   | No satisfy/conflict classification exists. A tag at a **different** commit plus skip-and-continue publishes content the tag does not describe — the OBSERVED injectivity break. The cheap fix (compare commits, not existence) is an amendment the model does not contain.                                                                 |
| E-04 | partial | Recompute-per-run makes cross-run stale-plan execution structurally impossible — a genuine strength. Intra-run drift (the policy flips between the run's own stages) and the OBSERVED precondition-delta report are unrepresentable.                                                                                                       |
| E-05 | fails   | Retry recomputes: new timestamps, new base, new digests — the OBSERVED defect, "a different release wearing the same version," is Model B's retry semantics. Freezing inputs requires a plan object P1 refuses to keep. The release-please variant freezes state in the PR, which the tag → build → publish continuation does not consult. |
| E-06 | fails   | The doctrine **is** the trap: "a tag with my version exists → skip the tag stage → my attempt succeeded" is resume-by-inference verbatim. The `v`-prefixed anomaly is invisible to a strict parser or handled by string-stripping — both OBSERVED refusals.                                                                                |
| E-07 | partial | PR-merge linearization (OBSERVED trick, taxonomy §1.21) or tag-CAS serializes allocation. But the loser dies as an unclassified git rejection, not `abandoned(follower)`; and tag-existence must mean fail-not-skip or the loser publishes from the wrong commit.                                                                          |
| E-08 | partial | Git CAS + fail-not-skip + rerun converges: the loser recomputes `rc.2` from the winner's tag. Injectivity survives only because the tag stage precedes publish. No claim record, no bounded-retry protocol — crash-only concurrency, safe but loud.                                                                                        |
| E-09 | fails   | Abort is unrecordable. The ambient-skip path (E-01's complete-in-place) applied after an abort **completes the release the operator killed** — the OBSERVED worst outcome is P2's default behavior. The orphan tag's disposition vanishes with the run.                                                                                    |
| E-10 | clean   | Topological walk policy and stamp entropy are stage configs; nothing in the model pushes toward date-ordering.                                                                                                                                                                                                                             |
| E-11 | partial | The reachability-scoped tag scan (the S-03 rule) fixes base-freshness, and recompute-at-execute aligns with the model. The superseded-plan logging and the change-set-drain proof are unrecorded.                                                                                                                                          |

### 3.7 PROMOTION

| ID    | Verdict | What Model B must invent / what breaks silently                                                                                                                                                                                                          |
| ----- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR-01 | fails   | Promotion-as-stage-rerun **rebuilds**: the OBSERVED digest-equality precondition is unenforceable because nothing records digests. Skipping the build means fetching "the rc artifacts" by version string — N6 as a lookup rule.                         |
| PR-02 | partial | Registry immutability preserves both bodies by accident; the OBSERVED generation tracking (gen-1/gen-2, `same-source-rebuild-of`, channels pointing at generations) is unrecorded.                                                                       |
| PR-03 | partial | Validation-as-stage re-runs on promotion and refuses past the CVE — the safety outcome holds. But the OBSERVED three-state chain (stale → revalidation-required → validation-failed) collapses into "red run," and blocked-but-resumable does not exist. |
| PR-04 | fails   | The move itself is a publish-stage mode, but CAS expected-prior-state, the channel event log, and stale-replay rejection are all absent — a replayed command executes blind (the OBSERVED disaster).                                                     |
| PR-05 | fails   | Channel state is a current registry pointer only (P4). The OBSERVED incident-review question — "which channel served 1.3.0 on Thursday?" — is unanswerable; membership edges do not exist.                                                               |

### 3.8 Score and pattern

| Verdict | Count | Scenarios                                                                                                                                                      |
| ------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| clean   | 13    | S-02, S-04, S-05, P-07, M-04, M-06, M-07, M-09, PL-01, PL-04, PL-05, AR-02, E-10                                                                               |
| partial | 25    | S-01, S-03, P-01, P-04, P-05, M-01, M-02, M-05, M-08, M-11, PL-02, PL-03, PL-06, PL-07, PL-08, AR-01, AR-03, AR-04, E-01, E-04, E-07, E-08, E-11, PR-02, PR-03 |
| fails   | 15    | P-02, P-03, P-06, M-03, M-10, AR-05, AR-06, E-02, E-03, E-05, E-06, E-09, PR-01, PR-04, PR-05                                                                  |

INFERENCE, pattern: the 15 fails sit exactly on the matrix's own stress
ranking — attempt + ledger + claims (E-02, E-03, AR-05, AR-06),
attribution-beats-observation (E-06, E-09, AR-05, AR-06), per-stream
prerelease identity (P-02, P-03, P-06), line identity vs branch name (M-10),
change identity (M-03), plan as a first-class object (E-05), artifact
identity/generations (PR-01), and channels-as-auditable-pointers (PR-04,
PR-05). Model B fails precisely where the matrix says naive models fail most
often, and its clean 13 are the scenarios the stress table does not test.

## 4. The six fixed questions

### (a) Where do branch/channel semantics leak into core?

Model B has no core/domain seam for process, so the leak is total and
structural rather than a misplaced module. Every stage takes the base branch
as its scoping input; the line **is** a config entry naming a branch (P3);
channels are publish-target strings (P4). The taxonomy's R1 verdict —
branch = adapter, release line = fundamental, channel = fundamental — is
inverted: the mutable ref name is the only durable identifier in the model,
which is why M-10 (rename) breaks identity: there is no identity to preserve.
Channel semantics leak as an _absence_: moves are performed by the publish
stage but have no event home, so AR-03/PR-04/PR-05's audit contracts fail
silently. Promotion (P5) additionally conflates R5's two promotions —
channel mutation and maturity reclassification — into one "re-run."

### (b) Is failure/recovery representable?

Only as a mechanism, never as state. Recovery = "the run exited non-zero;
the retry's ambient skip decides what to redo." What is not representable:
verified per-step done-ness (E-02), satisfy/conflict classification (E-03),
abandoned-by-human as a terminal state (E-09 — worse, the retry undoes the
abort), decision records for void/burn paths (E-01), and blocked-but-
resumable (PR-03). Failure states live in CI logs, which are ephemeral. The
soundness of the recovery mechanism rests entirely on ambient-state
inference — and E-06 proves that inference unsound: existence is evidence of
_something_, never of _my success_.

### (c) Are hooks compositional?

No. Stages are a fixed sequence; hooks attach at stage boundaries and can
block or decorate, but cannot (i) introduce new durable state (evidence TTL,
withheld records, decision records), (ii) introduce ordering constraints
across stages or pipelines (AR-02's verify gate is a stage, fine, but
PL-02's topological cross-package ordering is not expressible as any single
pipeline's hook), or (iii) mutate another pipeline's inputs. The empirical
warning is in the baseline (OBSERVED §12.3): release-please's plugins had to
grow into functions receiving "the full monorepo context" and rewriting the
candidate PR list — i.e., the hook seam already had to widen into a
plan-mutation interface. Hooks on a pipeline want a plan/attempt model
underneath; the pipeline shape does not survive contact with the hook
requirements the matrix generates.

### (d) Do simple releases stay simple — what is the complexity tax?

The trivial repo's tax is ~zero — this is Model B's real win (steelman §2.1).
The tax is real but lands elsewhere: on the **model**, as config accretion.
Every non-trivial scenario adds an untyped input flag or scan rule (stream
selector, empty-publish override, start-from-stage, fail-not-skip,
channel-move-only mode, reachability-scoped scan, fail-closed scope table)
until "linear pipeline with eight stages" is a switchboard. Config accretion
is arguably worse than concept accretion: booleans and strings per pipeline
have no names, no invariants, and no tests of interaction, whereas the
concepts they secretly encode (stream, claim, ledger) at least carry their
contracts with them.

### (e) What special cases does it require in total?

The full inventory — each is a config flag, scan rule, or side-channel the
definition does not contain:

1. Empty-change-set publication override (P-02, P-03).
2. Start-from-stage-N / stage-skip operator input — progress becomes an
   input (P-03, PR-01, PR-04, E-01 recovery).
3. Stream selector + per-(line, target, stream) precedence-based max-scan in
   compute (P-01, P-02, P-04, P-05, P-06, E-08, M-08).
4. Stream ladder ordering table + regression refusal (P-02).
5. Reachability-scoped tag scan + tags-outrank-manifest precedence (S-03,
   E-11).
6. Per-branch pipeline configs as the line registry + a new-line admission
   procedure (M-01, M-02, M-08).
7. Line lifecycle flags (active/retired) + refusal-with-record on retired
   lines (M-10).
8. Global tag→commit collision pre-check before mutation (M-11).
9. Change-identity/provenance convention consumed by collect — cherry-pick
   trailer parsing with explicit lineage (M-03, M-05).
10. Fail-not-skip semantics on tag-exists, with commit comparison (E-07,
    E-08, E-03-detection).
11. A durable decision-record side-channel (S-01, PL-06, PL-07, E-01, M-08,
    M-10).
12. Digest recording at build + verify-before-skip on resume (E-02, AR-05,
    PR-01).
13. Draft/intermediate artifact ownership checks (AR-06).
14. Channel event log + CAS expected-prior-state + stale-replay rejection
    (AR-03, AR-04, PR-04, PR-05).
15. Abort-as-terminal-state marker that suppresses retries (E-09).
16. Policy-digest binding to detect intra-run drift (E-04).
17. A plan-freeze discipline for reproducible retries (E-05) — a plan
    object, i.e., not Model B.
18. Attribution probes before any adopt-on-existence (E-06, AR-05, AR-06,
    E-03).

Items 11, 12, 14, 15, 17, and 18 are not special cases — they are the
attempt, ledger, channel-event, plan, and attribution concepts re-entering
through the back door. That is the load-bearing observation of this
evaluation.

### (f) Is release identity distinct from the version string? Are concurrent runs distinguishable?

No, and no. The only durable identifier in Model B is the version string (and
the tag naming it). Two releases of one version (PR-02's generations) are
distinguished — if at all — by registry state, not by the model; `(line,
version)` is implicit in a tag name at best. Two concurrent runs on one line
are distinguishable while alive by ephemeral CI run ids; their **effects**
are not: after both die, their ambient traces are indistinguishable (E-06's
exact hazard). Concurrent prerelease numbering (E-08) resolves only as
crash-and-retry: both compute `rc.1`, git CAS rejects one tag, and the loser
recomputes `rc.2` **only if someone re-runs it** — no claim token binds
(line, target, stream, sequence) to an attempt, so there is nothing to
resume, only something to redo. Bolting on attempt ids and a ledger to fix
(f) is bolting on the alternative model.

## 5. Verdict

**RECOMMENDATION — REJECTED as the release model.** The decision rule
applied: a model _survives with amendments_ when its amendments **extend**
it; it is _rejected_ when the amendments **delete its defining properties**.
Here, amendments 11, 12, 14, 15, 17, and 18 (§4e) each remove P1 (progress =
stage position) or P2 (ambient-state idempotency) — after them, "a linear
pipeline that skips done work by observing the world" is a thin skin over
the plan/attempt/ledger model, retained only as vocabulary. Keeping Model B
as specified would mean shipping a model whose two named properties are the
two least defensible things about it.

Killing scenarios (each OBSERVED in the matrix, each failing under INFERENCE
above), by class:

- **EXECUTION** — E-09 (the worst outcome — completing an aborted release —
  is P2's default), E-06 (the doctrine is the trap), E-05 (retry produces a
  different release under the same version), E-03 (tag/commit mismatch
  publishes silently), E-02 (done-ness assumed, never verified).
- **PRERELEASE** — P-03 (zero-diff promotion deadlocks), P-02 (stream ladder
  - regression), P-06 (stream keying).
- **MULTI-LINE** — M-03 (no change identity), M-10 (branch name is the only
  identity).
- **ARTIFACTS** — AR-05, AR-06 (attribution and ownership inexpressible).
- **PROMOTION** — PR-01 (promotion rebuilds; bytes contract unenforceable),
  PR-04 (channel moves unaudited, replays execute blind), PR-05 (channel
  history unanswerable).

No single scenario is unpatchable — the set shares about six roots, and
patching them all reconstructs a different model. Five of seven classes
contribute killers; the rejection is not one class's edge case.

**What survives (the salvage list).** Model B contributes real, load-bearing
mechanics to any successor, and the successor should say so:

- the eight-stage pipeline as the **default step sequence of an attempt**
  (the happy path should not regress in ergonomics);
- the tag push as a **claim/CAS primitive** (E-07, E-08);
- the release PR as a **plan carrier** (the merged PR freezes target,
  change set, and notes — release-please's OBSERVED de facto plan);
- the tag cursor as the **default range policy** (PL-04, PL-06, PL-07's
  deferral invariants hold under it);
- ambient state, demoted from _record of done-ness_ to _evidence to be
  attributed and verified_ (existence probes, digest checks).

## 6. Proposed alternative — Model C: claim-guarded line transitions

**RECOMMENDATION.** Definition: a release line is a durable identity,
independent of any ref name, carrying a policy, a released-version pointer,
a pending change set, and zero or more open prerelease streams keyed by
(line, target, identifier). A release is a state transition on one line,
executed as an **attempt**: a persisted, content-fingerprinted **plan**
(target version, change set, base binding, policy digest, frozen time) is
created and may be invalidated (change set grew, target moved, policy
flipped, base moved — PL-08, P-05, E-04, E-11), whereupon it is superseded,
not edited; an attempt **claims** the target (tag-namespace CAS or an
equivalent lease, re-verified before each mutating step) and executes
**ledger**-tracked steps, each idempotency-keyed by (attempt, step),
adopted only after verification, and attributed to its attempt; externally
visible effects are probed and reconciled (satisfied-externally /
conflict), never assumed. Attempt terminal states include published,
failed, superseded, and abandoned-by-human; every no-op, refusal,
withholding, and void produces a decision record. Channels are named
mutable pointers over releases with an append-only event log — moves are
CAS-guarded events, and membership is queryable as (release, channel,
from, to, cause). Promotion without content change is either a channel
mutation or a maturity reclassification recorded as a release event with a
`promoted-from` edge; artifact identity is (kind, coordinates, digest),
bound into per-release generations. Ambient state (tags, registry
contents) is evidence to attribute and verify, never the record of
done-ness. The single-line trivial repo is the **degenerate
configuration**: one line, one channel, the release PR carrying the plan,
CI checks standing in for the ledger — and Model B's eight-stage pipeline
survives intact as the default step sequence of an attempt.

This is not a new invention; it is the canonical vocabulary the taxonomy
locked (R1–R6) and the matrix's stress table demands, assembled. Model B is
its P1/P2-approximation for the configuration where plan = PR, ledger =
checks, and claim = tag.

**Top three risks:**

1. **Concept weight.** Line, plan, attempt, ledger, claim, channel-event —
   six primitives before the first line of release logic; the trivial repo
   pays bookkeeping for guarantees it never exercises. Mitigation: the
   degenerate profile must be a first-class configuration (derived plan,
   optional-but-defaulted ledger storage — matrix open fork 16), not a
   half-hearted pipeline emulation.
2. **The storage/claim fork is loaded with global consequences.** Where
   ledgers, decision records, and claims live (repo files, notes refs,
   external service — forks 13 and 16) fixes concurrency semantics,
   auditability, and the trust model, and is expensive to migrate after the
   fact; git-CAS claims cap throughput and tie recovery to git
   availability.
3. **Correctness burden migrates from users to the engine.** The E-class
   recovery/attribution paths become the engine's job, multiplying states
   and tests; the realistic failure is shipping the pipeline subset while
   the ledger rots unused. The degenerate path must be **less work than the
   workaround**, or the model will be bypassed in practice.

## 7. Open questions for the reconciler

1. Is any deployment class permanently out of scope for streams,
   generations, and channel history? If a consumer truly never promotes or
   streams, Model C's degenerate profile covers them — confirm nothing
   forces Model B to be the core rather than a profile.
2. Fail-not-skip on tag-exists (amendment 10): adopt as an engine-wide
   invariant (recommended) or per-stage policy?
3. Can the degenerate profile's ledger remain derived state (PR checks +
   tag) without losing E-01/E-02 guarantees, or is minimal persisted state
   required from the first release (fork 16)?
