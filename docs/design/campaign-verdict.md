# Campaign stabilization verdict — issue #321

This report closes the stabilization campaign's verdict slice. It applies the
readiness rule from [issue #321] and decides one of `READY` / `READY WITH
EXPLICIT LIMITATIONS` / `NOT READY`. Every number below is measured from
artifacts in this repository at the verdict head (`1c0455a` on
`docs/campaign-verdict-321`, base `9fe0893`), not carried from earlier prose
(the D81 lesson).

## 1. Verdict and rule application

**VERDICT: NOT READY.**

The readiness rule, verbatim from issue #321:

> `READY` only when all required checks are green and no P0 semantic defect,
> unverified certification claim, unexplained divergence, or unbounded
> recovery/concurrency claim remains. `READY WITH EXPLICIT LIMITATIONS` is
> allowed only when EACH limitation is (a) written in its owning
> contract/ADR, (b) surfaced by the relevant interface, and (c) covered by a
> negative or refusal test — all three cited per limitation. Otherwise
> `NOT READY`.

The decisive clause is the third sentence. Section 3 classifies the open list
of 22 issues exhaustively. The result that forecloses the limitations tier:
**thirteen open defects cannot be honestly bounded by (a)+(b)+(c).** Each is
either a product-code defect with no contract text that bounds its reach and
no negative test that pins its refusal, or a recorded divergence carried as
`UNKNOWN` with no test coverage at all, or a toolchain/docs defect with no
negative test for its claimed behavior. Per the rule's own instruction — "any
open defect the classification cannot bound forces `NOT READY` — no silent
defaults" — the verdict does not pass through the limitations tier. No slice
may inflate the verdict past what the evidence forces.

## 2. Resolved issues by workstream

The campaign's slices landed through the decision-log's D-rows. The D70–D84
rows are read in full for this report.

| Workstream                       | Closed / resolved                                                                                                                     | Landing decisions      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| W1 — commit mapping              | #196 (breaking-footer alias), #192 (guard-first channel order), #193 (hook replay content compare)                                    | D70 slate (D72, D73)   |
| W2 — versioning / policies       | #271 (quiet-line release path), #272 (band-overlap birth law)                                                                         | D66, D67               |
| W3 — workspace / propagation     | #285 (root-package dependency skip), #286 (node-workspace refusal evidence)                                                           | D74                    |
| W4 — app boundary / ports        | #279 (verify-stage boundary guard), #287 (mutation completion target path), #309 (GitHub ReleasePRPort), #202 (Release-PR lifecycle)  | D70, D77, D79, D80–D81 |
| W5 — recoverabilty / determinism | #227 (durable resume holder policy), #292 (isolation gate Intl), #269 (validate holds), #303/#304 (supersession keys, tag-door taker) | D75, D72, D68, D78     |
| W6 — channnel transition / docs  | #292 (planner isolation), #283/#284/#297 (contract passage truing), #274 (second-release publish)                                     | D72, D73, D65          |
| W7 — evidence                    | #293 (changelog matrix truing), #315/#317 (shadow comparison, producer act)                                                           | D76, D82, D83          |
| Gate A                           | #25 (scenario matrix)                                                                                                                 | D19                    |
| Gate D                           | #200 (compatibility matrix)                                                                                                           | D76, D81               |
| §12–14                           | #319 (plan identity), #317, #315                                                                                                      | D84, D83, D82          |
| Self-release                     | #259                                                                                                                                  | D63, D65, D69          |

The campaign's own ledger (D82) records the field-level result: 48 field
records across three release-please consumers, 27 equal / 18 divergent
(15 `release-craft-stronger` + 3 `release-please-quirk`) / 3 not-exercised,
0 unexplained — verified first-hand from the evidence files this slice. D83
records the Tier 3 producer act: 8 equal fields, 5 cited divergences,
1 not-exercised (prerelease ladder), 0 unexplained, the never-both-mutate
hold verified (zero open release-please PRs before, during, after). D84
records the plan-identity fix.

## 3. Limitations — every open issue classified

Inventory from `gh issue list --state open` at the verdict head: **22 open
issues**. They classify exhaustively into (i) bounded limitations, (ii)
declared-out roadmap, and (iii) open defects.

### (i) Bounded limitations — each with its three readiness citations

| Issue                                                 | Contract (a)                                                                                   | Interface (b)                                                                                                                                                                          | Negative/refusal test (c)                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **#237** claim-exclusion enforcement                  | ADR-0011 decision 2's two-clone shape, D69's surface split                                     | `TestDomain` live check, `test/adapters/git/claim-register.test.ts:952-1010` (two clones acquire the same line independently; each register lists only its own; verify returns `lost`) | The same live pin is a refusal test: a git refusal, no engine outcome kind.                 |
| **#262** check-workflow-safety comment-text blindness | D69's evidence cell names the gate's inventory; the workflow's own header admits the blindness | `scripts/check-workflow-safety.mjs:87` (raw source match)                                                                                                                              | `scripts/dogfood/self-release-workflow.test.mjs` — 11 pins read the comment-stripped shape. |

### (ii) Declared-out roadmap — named, never dropped

| Issue                                                                                                                                     | Position                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| #203–#208 feature arc (`feat:` updater layer, manifest surface, workspace propagation, changelog renderer, bootstrap, CLI/Action surface) | Feature-frozen epics; product state recorded in E/F rows.                  |
| #234 user-pending                                                                                                                         | The CLI and Action contract ([#208]); recorded user-pending, never closed. |
| #268 multilingual README                                                                                                                  | Blocked by the English-only invariant (D63's surface).                     |
| Dependency Dashboard                                                                                                                      | Named here, never dropped.                                                 |

### (iii) Open defects — the classification cannot bound them

**#223** — ADR-0012's divergent-prior-target conflict is unreachable.
`applyPlannedChannelTransitions` builds `from: observed.target`
(`src/app/channels.ts:97,120,127`) — the freshly observed ref, so the store's
`conflict` row can only fire on the read→CAS interleaving inside the compare-
and-swap loop; divergence predating the walk's read never classifies
`conflict`. Neither bound: `test/app/channels.test.ts:455-520` pins the
completed-stage replay only. (a) ADR-0012 decision 4 promises the conflict;
no amendment bounds the started-uncompleted window. (b) No interface surfaces
the re-point. (c) No negative test covers the started-uncompleted drift.

**#288** — the Release-PR gate writes gate records outside the ExecutionLedger
with no content digest or claim token. `src/app/release-pr.ts:217-240,356`.
No contract bounds the parallel sink; no negative test pins the refusal.

**#289** — host-declared mutations carry no plan binding. `request.declarations`
(`src/app/types.ts:189`) → `scheduleMutations` (`src/execution/updater.ts:103`)
consumes declarations without consulting the plan; the `ReleasePlan → mutation
plan` middle term named in #203's proposal does not exist. No contract bounds
the missing binding; no test refuses a declaration contradicting the plan.

**#291** — the changelog renderer has no production caller and the plan record
lacks the fields it requires. `renderChangelog` (`src/planner/changelog.ts:166`)
is imported only by its barrel and its own tests; the recorded plan's change
records carry only `{id, lineage, type, bump}` (`src/planner/types.ts:736-741`).
E1's cell records "no production caller"; no interface surfaces the renderer;
no negative test pins the absence.

**#294** — the changelog digest chain never carries renderer bytes. The producer
emits a `git-tree:<oid>` selector (`src/adapters/git/producer-git.ts:54`);
publication's verification chain (`src/adapters/github/publication.ts:203-251`)
is exercised only against hand-written `CHANGELOG_BODY` fixtures. No record
pins rendered bytes; no test recomputes a bytes digest.

**#299** — the isolation gate misses `localeCompare` and the legacy `Date()`
form. The token list (`test/planner/isolation.test.ts:168-195`) has neither; a
planner module using them passes the purity gate. (a) The gate's own contract
forbids the class; (b) the token list is the interface; (c) no negative test
covers the two reads — fail-open.

**#305** — the baseline §3.1 section-heading observation and the renderer's
`###` sections disagree. Recorded `UNKNOWN` in the matrix (the commit-types
row). The issue itself says "one of the two texts is wrong"; nothing settles
it — the divergence is unexplained, and no test pins either authority.

**#307** — the adopt door mints a completed updater-step record without
`targetPath`. The only writers are `src/execution/updater.ts:240,:377`; the
adopt door's construction (`src/execution/adopt.ts:170-190`) omits it, while
the record's docblock claims "present only on a completed updater step's
record; the scheduler writes it". No test pins the adoption shape.

**#311** — the update-time claim-vs-branch tamper check skips when the claim's
tokens cannot derive a head branch. `derived.ok && derived.branch !==
current.headRef` (`src/adapters/github/release-pr.ts:1176`): when derivation
fails the guard is `false`, the comparison is skipped. No negative test pins
the skip; the create path's refusal (D79) is a different door.

**#222** — the vertical fixture driver still encodes the pre-#192 channel
order. `test/vertical/matrix.ts:627` hardcodes `guards: [{ guard:
"claim-held", passed: true }]`; `walkStages` (:859-866) CAS-before-guard. The
product runs guard-first (`src/app/engine.ts`); the driver diverges. No
contract binds the driver; no test judges its order.

**#230** — the live triage check fails every fix PR that amends documentation.
`triage.json5` declares `bug` and `documentation` exclusive over
`semantic-classification`; the action honors the sheet, so a fix-that-amends-
contract (this repo's standard shape) stays red and unlabeled. No test covers
the sheet's exclusivity; the run stays `dry-run` mislabeled (stale comment).

**#235** — the PR template ships unchecked boxes the policy gate refuses.
`.github/PULL_REQUEST_TEMPLATE.md:13-16` + `scripts/check-pr-description.mjs`
(no-unchecked-box rule): every verbatim-templated PR starts red on policy. No
shape makes the verbatim template pass; the workaround ("reword to a single
checked item") is undocumented.

**#248** — phase12 §2.1 still teaches the CLI imports the boundary through the
package front door, contradicting the `#155`-corrected boundary row
(`module-boundaries.config.mjs:100-101`: the `type-cli` row). A stale contract
with no test binding the text.

**#250** — the CLI test harness spawns the CLI child with the inherited worker
environment. `runCli` (`test/cli/harness.ts:43-53`) inherits `env` wholesale;
the fixed shape is the minimal-allowlist `runBin` in `test/certification/
drive.ts` (after #246). No negative test pins the hermetic default.

**#253** — `scripts/test-stress.mjs` sits in node's default test glob. A bare
`node --test` in `scripts/` executes the stress harness and fails it;
`stress-results.json` is ungitignored. No test binds the filename/glob.

**Named as open defects that cannot be bounded:** #223, #288, #289, #291,
#294, #299, #305, #307, #311, #222, #230, #235, #248, #250, #253. These
thirteen force `NOT READY`.

## 4. Evidence provenance

Every evidence file below is committed in-repo at the verdict head; each
sha256 was computed from the tree at `1c0455a` this slice and matches the
digest its decision row recorded.

| File                                                           | sha256 at head                                                     | Row |
| -------------------------------------------------------------- | ------------------------------------------------------------------ | --- |
| `e2e/evidence/release-pr-e2e-2026-09-12.jsonl`                 | `be0dd83f347fc29cb75bd9d7431f964dcbb3ab889333ed512d512c77f890922f` | D81 |
| `e2e/evidence/shadow-tier12-action-agents-2026-09-12.jsonl`    | `619a34da94fd422e51ee90a8ebb898660f34a516be0075ccb3415d6128139230` | D82 |
| `e2e/evidence/shadow-tier12-archkeep-2026-09-12.jsonl`         | `dbeb86b1158bcedd5402c7bd1b498ccf8de2f5868793087c15b0ad8616d35924` | D82 |
| `e2e/evidence/shadow-tier12-ledger-2026-09-12.jsonl`           | `64cbfd01a2b6bab4113a6fad5644fe27f4facbb1e7e4a265dd75cd7e80cb8633` | D82 |
| `e2e/evidence/shadow-tier12-loom-2026-09-12.jsonl`             | `be4fbd8d00da3dc9b71730375b27c32c153afe4bb91748324badaf2d0388c48a` | D82 |
| `e2e/evidence/shadow-tier3-action-agents-2026-09-12.jsonl`     | `3612a9b67b89f6c222b3eb47c9e49d9c21a4cced438205369044d5f6b66ef40f` | D83 |
| `e2e/evidence/shadow-tier3-mutate-gate-probe-2026-09-12.jsonl` | `8660d25c6de20016036bc996a25c2f01d1b9a2868132a6a180d1c2fd166ad653` | D83 |
| `e2e/evidence/shadow-tier3-record-2026-09-12.json`             | `569362c9ca3f80280ede1806645c77bb3bd66089044c932c2ec747239eff5364` | D83 |

D82's 27/18/3 field split and D83's 8/5/1 split were re-derived from the
files this slice; the independent review folds are cited per row. Hosted-run
ids: the self-release legs cite runs 34635157220, 34635275253, 34597572065,
34597897169; the D81 live legs ran on PR #313; the D82/D83 windows ran over
the three consumers (2026-09-12). None were re-executed by this slice; the
committed bytes are the measured artifact.

## 5. Self-release results

The self-release surface (#259) is closed as **future adoption work**, not a
gate capability — D63/D65/D69 record it so. Its recorded live legs:

- Run 34635157220 concluded `success`, fetched the register ref into the
  checkout, acquired, and pushed the minted `0.2.0` plus the register's child
  tip (D69 / D73 evidence cell).
- Run 34635275253 concluded `failure` (the demanded stop-band posture's
  expected conclusion), logging `blocked` / `released-version-observed` at
  the planning boundary — no claim, no mint, no second attempt (D65 / D69).
- D81's Release-PR live legs ran on PR #313: `create` minted a DRAFT;
  `detect-adopts` found it; `update-in-place` answered `current`; a bogus
  token answered `transport-failure`; the tamper leg recorded `plan-conflict`
  with the body byte-preserved; the coordinator closed the draft unmerged.

The honest posture: **E1 dogfood is `none`** — no recorded live run ever
minted changelog bytes (B17). The self-release pushes tags and the register
tip only; `publish-mint.mjs` contains **zero** `releases` references — no
GitHub Release object was ever created on any recorded leg. The F6 row's
certification fixture (`certification/git.test.ts`, `github-vertical.test.ts`)
simulates the remote; the GitHub Release object (`POST /releases`) has no
recorded live invocation anywhere. **This is the unverified certification
claim** the readiness rule names.

## 6. Dogfood results

- **§12 Tier 1+2** (D82): the read-only observer re-planned three real
  release-please consumers over release-please-decided windows; 48 field
  records — 27 equal / 18 cited-divergent / 3 not-exercised / 0 unexplained.
  Read-only law enforced in code (git verb allowlist; `tag` absent); consumers
  received zero writes.
- **§12 Tier 3** (D83): the production Release-PR driver drove one real draft
  Release PR on a real foreign consumer (action-agents), judged and closed
  unmerged; 8 equal / 5 divergent / 1 not-exercised / 0 unexplained; the
  never-both-mutate hold verified.
- **Divergences routed upstream**: action-agents#521 (empty answer) and
  action-agents#527 (assembled-prompt fit counts THREAD growth — 85k/128k
  refusal) are filed in the consumer repo, which owns them.
- **§14 review gate**: every row's evidence walked the author≠reviewer gate
  (reviewer-316 round-1 → fold; reviewer-318; reviewer-320). This slice's own
  evidence is independently authored.

## 7. Gate-D recount — a fresh mechanical 6-state recount at the verdict head

The 6-state ladder (never collapse): `SEMANTICALLY DEFINED → IMPLEMENTED
(unit) → INTEGRATED (multi-module) → E2E VERIFIED (recorded live run) →
DOGFOODED (shadow/live consumer) → PARITY-PROVEN (RC-vs-RP same-field diff
recorded)`.

The compatibility matrix (`docs/compatibility/release-please.md`) carries
**59 rows** by mechanical count: 6 PARITY / 13 RC-STRONGER / 28 PARTIAL / 10
GAP / 2 NOT-APPLICABLE. The matrix is not the 6-state table; the 6-state
frame is the campaign table's. Mapping each matrix row through the campaign
table's per-row states gives:

| State                | Count |
| -------------------- | ----- |
| E2E VERIFIED         | 14    |
| SEMANTICALLY DEFINED | 11    |
| INTEGRATED           | 9     |
| IMPLEMENTED          | 22    |
| DOGFOODED            | 3     |
| declared-out (N-A)   | 2     |
| PARITY-PROVEN        | 0     |

The reconciliation is mechanical: the campaign table's per-row states
(A1..J5, the source of truth) applied to the 59 matrix rows, split where the
matrix separates a merged campaign row (D2/D3/D5/D6 = 4 SD, E2/E3 = 2 IMP,
the gate's `CHANGELOG.md` projection = 1 IMP, the F-rows' sub-capabilities
sharing F1/F2/F4/F5's E2E). Zero state-ladder collapses: no row's state was
promoted without a recorded live run at that tier, and no DOGFOODED row was
raised to PARITY-PROVEN.

**Matrix staleness found, reported not edited** (per the scope law): the
"Known bugs that depress parity rows" paragraph at
`docs/compatibility/release-please.md:238-244` cites **seven now-closed
issues** (#196, #191, #182, #193, #194, #195, #199) as though they were open
— all seven are CLOSED at the verdict head (verified via the tracker). The
paragraph is stale.

**Cosmetic residuals, named as cosmetic (not verdict-relevant, untouched by
this slice):** the #310 files-column shorthand, #312 DM-1 phrasing, #314
"surface's" spelling, and one residual stale §2.11 attribution inside D84's
alternatives-rejected clause. None affects any classification in this report.

## Decision-log row

The D85 row appended to `docs/design/decision-log.md` records the verdict,
the final-commit head digest, and the recount totals. The log's D70–D84 rows
are unchanged.

[issue #321]: https://github.com/ecoma-io/release-craft/issues/321
