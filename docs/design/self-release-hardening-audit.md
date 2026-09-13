# Phase 0 audit — the release engine at HEAD, reconciled against D85

**Campaign**: adversarial self-release hardening toward 1.0.
**Audit commit**: `a1de69d` (2026-09-13) — the D85 verdict merge itself, so this
audit reconciles the verdict against its own HEAD.
**Audit issue**: [#323](https://github.com/ecoma-io/release-craft/issues/323).
**Method**: six read-only agents (planner/identity; execution/claim/ledger;
git+GitHub adapters; CLI/Action/workflows; test/evidence posture;
release-please conformance) each reconciling the mission capability matrix
against actual source with an `implemented / tested / simulated /
dogfood-tested` classification, then the lead re-reading the cited ground truth
directly. Every capability row cites `file:line` (the reader can open it). The
D85 verdict's counts and sha256 digests are **claims**, not authority — the
audit re-measures them against the tree.

Classification vocabulary: **implemented** (code exists, no executable proof),
**tested** (a test file pins it), **simulated** (the test exercises a fake
transport/store), **dogfood-tested** (committed live-run evidence on a real
remote). Mocks and dry-runs do **not** count as production evidence.

---

## 1. What already works — the genuinely-proven core

These capabilities are proven by tests against a **real** substrate (real git,
real CAS, real cross-process signals), not by fake transports:

| Capability                                                        | Class                   | Evidence                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic planning                                            | tested                  | `src/planner/*` pure; double-run deep-equal + goldens pinned to scenario docs (`test/planner/plan.golden.test.ts`, `test/planner/assemble.test.ts`); `Date.now`/`new Date(`/`Math.random(`/`process[.[]`/`globalThis`/`Intl`/`toLocale*` banned by an executable static gate (`test/planner/isolation.test.ts:163-199`)                                       |
| Plan identity (`plan_sha256`, `inputs_sha256`)                    | tested + dogfood-tested | Canonical serializer is key-sorted, whitespace-free, deterministic (`src/planner/identity.ts:65`); **#319 fix holds at `identity.ts:204`** (empty `intents` === absent — one semantic fact, one fingerprint); plan/inputs fingerprints stable across the D82 shadow windows                                                                                   |
| Claim-before-mutation                                             | tested                  | Real-git CAS (`src/adapters/git/claim-store-git.ts:380-434` via `git update-ref` old-value compare-and-set); a hostile `git` PATH shim kills the process mid-CAS (`test/adapters/git/claim-register.test.ts:448`); two-clone exclusion race pinned (`:947-1010`); the engine refuses to mutate claimless (`src/app/engine.ts:923-930`, mint door `:606-614`)  |
| Execution ledger (durability/resume)                              | tested                  | Write-ahead start-before-effect (`src/app/engine.ts:430-448`); content-aware tip dedup absorbs crash-restart (`src/adapters/git/ledger-git.ts:158-193`, #185); forward-only CAS fails closed; a fresh binding reloads the tail and classifies identically (`test/vertical/github-vertical.test.ts:716-748`)                                                   |
| Attempt state machine + supersession terminality                  | tested                  | Closed edge table, empty terminal rows (`src/execution/attempt.ts:49-58`); no revival edge; abandonment is a durable record (`src/app/engine.ts:996-1003`), the tail — not process-local value — is authority (`test/execution/abandonment-record.test.ts:197-330`)                                                                                           |
| Tag mint                                                          | tested + dogfood-tested | `src/adapters/git/tag-door.ts` (existence CAS, same-target idempotent `minted` / different-target `conflict`); live-minted on origin (self-release run 34635157220 pushed `0.2.0`)                                                                                                                                                                            |
| Idempotent retry                                                  | tested in parts         | Same-attemptId resume re-runs an effect exactly once (`test/app/resume.test.ts:311-369`); completed steps replay `noop`; ledger tip dedup; tag re-mint never rewrites the ref (`test/adapters/git/claims-mint.test.ts:269`); release create is read-before-write with an ambiguous-on-lost-response classifier (`src/adapters/github/publication.ts:266-310`) |
| Provider isolation (kernel purity)                                | tested                  | `core/domain` imports only itself; archkeep bans every external import (`module-boundaries.config.mjs:72-76`); no provider vocabulary in kernel value names (`test/provider-isolation.test.ts:151-206`)                                                                                                                                                       |
| Release-PR gate identity + live gate legs                         | dogfood-tested          | Body claim-marker identity, never title/label (`src/app/release-pr.ts:49-77`); six live legs on PR #313 (`e2e/evidence/release-pr-e2e-2026-09-12.jsonl`); D83 draft PR #528 on a real foreign consumer, tags byte-identical                                                                                                                                   |
| Self-release workflow orchestrates the engine (no special-casing) | implemented + tested    | No `if: repository == release-craft` conditional anywhere in `.github/workflows/`; both workflows invoke the pinned public Action `ecoma-io/release-craft@<sha>` exactly as any consumer would — `self-release.yml:174-184`, `dogfood.yml:112-122`                                                                                                            |

## 2. What is incomplete (implemented but never wired to a production path)

| Capability                     | Class                                                                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Version mutation**           | implemented (scheduler only) / tested / **not consumable**              | The real scheduler exists (`src/execution/updater.ts:103` — claim gate `:275-288`, write-ahead `:292`, write-verify `:305-327`, completion with `contentFingerprint`+`targetPath` `:367-379`), but **no producer that bumps a version exists**: the CLI/Action shut doors declare no mutations (`src/cli/index.ts:83-93`); the node-workspace adapter is detection-only (`src/adapters/node-workspace/index.ts:15-18`); dogfood closure declares none (`scripts/dogfood/close-world.mjs`, 0 hits). D85 **#289** (no plan→mutation binding) is the open middle term |
| **Changelog renderer**         | implemented / tested / **no production caller (#291)**                  | `src/planner/changelog.ts:166` `renderChangelog` appears in exactly four places: its definition, the barrel `src/planner/index.ts:39`, its tests, and the read-only shadow harness (`e2e/shadow/shadow-run.mjs:66`). The engine, git assembly, GitHub adapter, Action, and Release-PR gate **never call it**. The Release PR writes its own hand-rolled CHANGELOG.md projection (`src/app/release-pr.ts:171-184`)                                                                                                                                                  |
| **GitHub Release publication** | implemented / tested-against-fakes / **no live invocation**             | `src/adapters/github/publication.ts:301-309` `POST /releases`; only ever crossed **canned/fake transports** (`test/adapters/github/publication.test.ts:77-91`, `test/vertical/matrix-github.ts:173`). **`EnginePorts` has no publication port** (`src/app/types.ts:114-127`), so the engine walk cannot reach it; `publish-mint.mjs` has zero `releases` refs (`grep -c` = 0); `verify-origin.mjs` reads only `git ls-remote`. **Never created a GitHub Release object on any recorded leg.**                                                                      |
| **Commit**                     | not implemented (no adapter creates a release commit) / stage simulated | The walk's `commit` canonical stage (`src/execution/types.ts:228`) is a **ledger/fingerprint gate**, not a write — `stageContentFingerprint("commit")` hashes `planLine.changes`. The only `commit-tree` in any adapter is the CAS register append (`src/adapters/git/git-refs.ts:144-145`). The tag is minted directly at the feed-ref head (`src/cli/targets.ts:15-28` → `src/app/engine.ts:615-630`), so no release commit is created or needed                                                                                                                 |
| **Artifacts**                  | implemented / tested / **not consumable in shipped runs**               | Domain value + scheduler (`core/domain/artifact.ts`, `src/execution/artifacts.ts:91`); real git-tree producer (`src/adapters/git/producer-git.ts:50-56`); but a real run would need declared `artifacts` + producers, and neither CLI run nor Action declares any                                                                                                                                                                                                                                                                                                  |
| **Promotion / release-lines**  | implemented / tested (incl. vertical) / **not live**                    | `src/app/channels.ts:79-137`, git-ref durability `src/adapters/git/channel-store-git.ts:50-56`, vertical promote ladder (`test/vertical/github-vertical.test.ts:466-518`); dogfood world closure declares no channels, so no recorded leg ever moved one on origin                                                                                                                                                                                                                                                                                                 |
| **Adoption (`adopt()`)**       | implemented + tested / **unwired**                                      | `src/execution/adopt.ts:100-200` — the kernel admission door for adopting an observed existing tag; its only reference is the barrel export (`src/execution/index.ts:15`). The engine path for an existing tag is **conflict, not adoption** (#237-bound cross-checkout)                                                                                                                                                                                                                                                                                           |

## 3. What is only simulated (and therefore not production-grade evidence)

| Capability                           | Class                          | Evidence                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub HTTP surface — every test     | **simulated**                  | `FakeRemote` in-memory Map transport (`test/vertical/matrix-github.ts:173`); `github.fake` URLs; the git side is a real temp repo behind a PATH shim that **refuses the network** (`test/adapters/github/origin-shim.ts:70-75`). Disclosed in-file: "No fixture spawns network anywhere" (`matrix-github.ts` header) |
| Release-create crash window (V8, V5) | **simulated**                  | arm-gated fake writer between the idempotency read and the create (`test/vertical/github-vertical.test.ts:1186-1238`, `:1241-1283`); ambiguous on lost create (`publication.ts:314-321`); **no real-GitHub-publish recovery leg exists anywhere**                                                                    |
| Hostile git-CAS interleaving         | **simulated (real substrate)** | Deterministic PATH shim interleave — real git CAS, scripted timing — the honest tier boundary, disclosed as such                                                                                                                                                                                                     |
| Process-kill / SIGKILL crash seats   | **simulated (real signals)**   | `CrashingLedger` (`test/certification/drive.ts:580`), `crashAfterStartOf*` over real git, SIGKILL stand-in bin (`test/action/conclusions.test.ts:238`), live SIGSTOP/SIGCONT two-process takeover (`test/certification/cross-process.test.ts:300-367`)                                                               |
| Cross-checkout claim exclusion       | **bounded limitation #237**    | per-clone ref-space exclusion until pushed — real two-clone test `claim-register.test.ts:947-1010`; no remote backstop                                                                                                                                                                                               |

## 4. What violates the intended invariants — the open D85 defects, verified at HEAD `a1de69d`

All 16 D85 defects were re-checked at HEAD; every one is still present (HEAD is
the D85 merge itself, docs-only delta over the measured base `9fe0893`, so no
code fix could have landed). The four with the sharpest architectural bite:

| Defect                                                                         | State at HEAD | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#288** Release-PR gate records live outside the ExecutionLedger              | present       | `src/app/release-pr.ts:228-241` writes `gate-start`/`gate-outcome` `{action, identity, planId, outcome}` — no content digest, no claim token — to a caller-injected `ReleasePRRecordSink`. The only implementation is the in-memory `MemoryRecordSink` (`:245-274`); **no git-backed sink exists** (grep over `src/` + `test/`). The driver requires a sink (`src/release-pr-driver.ts:45`) but supplies no durable one |
| **#289** host-declared mutations carry no plan binding                         | present       | `request.declarations` flows to `scheduleMutations` (`src/app/engine.ts:341-348`) with no consultation of the `planLine`; no test refuses a declaration contradicting the plan                                                                                                                                                                                                                                          |
| **#307** adopt door mints a completed updater-step record without `targetPath` | present       | `src/execution/adopt.ts:174-189` — field set lacks `targetPath`, though `src/execution/types.ts:336-345` promises it is always present on a completed updater step; `adopt` excludes artifact keys but not `updater:<id>`; no test pins the shape                                                                                                                                                                       |
| **#311** update-time tamper check skipped on head-branch derivation failure    | present       | `src/adapters/github/release-pr.ts:1176` `if (derived.ok && derived.branch !== current.headRef)` — a failed derivation short-circuits the whole guard (fail-open); no negative test pins the skip                                                                                                                                                                                                                       |

Plus the rest of the ledger, re-confirmed present: #222 (vertical fixture still
encodes pre-#192 channel order — `test/vertical/matrix.ts:627` hardcodes
`guards: [{guard: "claim-held", passed: true}]` while production
`src/app/channels.ts:130` reports the live claim since commit `7f7bb17`), #223,
#230 (live triage with an external exclusive role), #233 (phase14 R2 verb-less
fragment), #235 (`.github/PULL_REQUEST_TEMPLATE.md:13-16` ships `- [ ]` boxes;
`scripts/check-pr-description.mjs:182` refuses an unchecked box), #248
(`docs/design/phase12-cli-contract.md` §2.1 still teaches the front-door
import; `module-boundaries.config.mjs:102-116` forbids it), #250
(`test/cli/harness.ts:43-56` inherits the vitest worker env when `env` is not
passed), #253 (`scripts/test-stress.mjs` matches node's `test-*.mjs` glob; the
sanctioned gate task never runs it), #291/#294 (changelog renderer & digest
chain), #299 (`localeCompare` + legacy `Date()` form stale in the isolation
gate's token list), #305 (section-heading `##` vs `###` UNKNOWN), and the two
bounded limitations #237/#262.

## 5. The two sharpest D85 claims — re-measured at HEAD

**(a) No recorded live GitHub Release object — CONFIRMED TRUE at HEAD.**
`POST /releases` exists only in `src/adapters/github/publication.ts:301-309`;
every test injects canned/fake transports; `EnginePorts` gives the walk no path
to publication; `publish-mint.mjs` has zero `releases` references and pushes
only minted git refs; `verify-origin.mjs` reads only `ls-remote`; no `gh
release` exists in workflows, scripts, or the Action. The only live GitHub
writes ever recorded are Release PRs (D81 PR #313, D83 draft PR #528) — no
Release object was ever created on any recorded leg.

**(b) No recorded live changelog mint — CONFIRMED TRUE at HEAD.** `renderChangelog`
has no production caller; the plan record still lacks `subject`/`scope`/`date`/
`url` (`src/planner/types.ts:736-741`); the digest chain still carries only
`git-tree:<oid>` selectors over hand-seeded or pre-existing trees
(`src/adapters/git/producer-git.ts:54`; `test/vertical/matrix-github.ts:82,
343-344`); the Action/CLI/dogfood surfaces declare no changelog mutation or
artifact step. The shadow harness renders bytes for comparison into its rc
records — computed, observed, compared, but **never minted** into any
repository or release.

Precision correction on D85's inventory prose: the certification fixture does
**not** simulate the GitHub remote — `test/certification/` never touches GitHub
at all; the fake remote belongs to the vertical tier (`test/vertical/
matrix-github.ts`). D85's claim count (E2E VERIFIED 14 · DOGFOODED 3 ·
PARITY-PROVEN 0) is exactly the tree's honest posture.

## 6. Compatibility / conformance posture (matrix `docs/compatibility/release-please.md`, 59 rows)

Re-counted at HEAD: **PARITY 6 · RC-STRONGER 13 · PARTIAL 28 · GAP 10 ·
NOT-APPLICABLE 2**, matching D85 §7. The 6-state campaign table:
E2E VERIFIED 14 · SEMANTICALLY DEFINED 11 · INTEGRATED 9 · IMPLEMENTED 22 ·
DOGFOODED 3 · **PARITY-PROVEN 0** (accurate — no same-field full-canonical
RC-vs-RP diff exists; D82 is 16 fields short). Recorded UNKNOWN divergences:
#305 (section-heading), E5 (undeclared types), D8 (root aggregation).

Row-body staleness found beyond the seven D85 names (audit does **not** edit the
matrix — this is the "reported, not edited" scope law):

- **A2** still classifies the `BREAKING-CHANGE:` alias as a live BUG/#196, while
  `src/planner/extract.ts:135` + `extract.adversarial.test.ts:259-289` implement
  and pin it (it is closed at HEAD).
- **D1** says "no committed configuration document exists", while `parseManifest`
  exists (`src/planner/config.ts:713`) with a full contract suite
  (`test/planner/manifest.test.ts`) — accurate only in that no CLI/Action door
  consumes it.
- **D5** says "nothing writes files", while the ledger-tracked updater layer
  exists (`src/execution/updater.ts`) — accurate only in that mutations are
  host-declared with no plan binding (#289).

Executable conformance coverage at HEAD is: bump/version/tag/decision fields
(D82 shadow, 3 real consumers, committed evidence), Release-PR semantic
outcomes (D81/D83 live), renderer bytes vs RP's committed changelogs (shadow
field-level only). Not covered executably: multi-commit messages
(`BEGIN_COMMIT_OVERRIDE`), `always-bump-*` quiet-line forcing, **Release-As in
any recorded comparison** (row A3's own debt note), pre-1.0 feat→patch knob,
grouped/separate PRs + linked-versions, plan-bound dependent-file mutation, the
prerelease stream/channel pair, `extra-files`/language updaters, and
merge→tag→GitHub-Release through a merged Release PR.

## 7. What must change before self-release through the public path

Ordered by the mission's phases; **no feature expansion** — these are the gaps
the 1.0 self-release gate depends on:

1. **Canonical self-release path (Phase 1)** — wire a real GitHub Release
   publication into the walk and the self-release workflow (give `EnginePorts`
   a publication port; make `publish-mint.mjs` (or the workflow) create the
   release object from the recorded body, never from a re-plan). This closes
   the largest of the two sharpest gaps.
2. **A real changelog mint (Phase 2)** — give `renderChangelog` a production
   caller: plan the renderer's fields (`subject`/`scope`/`breaking`/`date`/`url`)
   so it can render from the plan (#291), and carry renderer bytes in the
   digest chain (#294) so publication verifies the recorded body.
3. **Fault injection (Phase 3)** + **recovery matrix (Phase 4)** — iterate the
   existing crash-window suite over the newly-wired publish path; the V7/V8
   matrix already covers all 9 canonical stages over real git but the
   **publish window has only fake-transport coverage**.
4. **Idempotency proof (Phase 5)** — compose the existing parts (tag re-mint,
   release create read-before-write, ledger tip dedup, `noop` replay) into one
   "full second run → zero duplicates" proof; the pieces exist, the composite
   does not.
5. **Conformance tests (Phase 6)** — turn the D82/D83 shadow evidence into a
   test-authored conformance suite; Release-As remains completely unmeasured
   against RP.
6. **Compatibility boundary (Phase 7)** — reconcile the three stale matrix row
   bodies (A2/D1/D5) and settle #305 in a test, not prose.
7. **Real self-dogfood loop (Phase 8)** — each cycle needs: planId +
   inputsFingerprint + DecisionRecord + claim + ledger + version + commit +
   tag + **GitHub Release + changelog body + verification**. None of those
   objects exist at HEAD for the Release/changelog halves.
8. **Must-close before READY** — the four architecturally-sharp D85 defects
   (#288 gate records out of the ledger, #289 no plan binding for mutations,
   #307 adopt mints a shape-incomplete record, #311 fail-open tamper check),
   and the bounded limitations that block the self-release claim
   (#237 cross-checkout exclusion), plus the isolation gap #299 (a reflective
   no-op that would be caught by adding `localeCompare`/`Date` tokens rather than
   by this audit's own static passes).

The honest posture in one sentence: **the engine's core discipline — pure
planning, claim-before-mutation, write-ahead durably-ledgered execution, CAS
minting, terminal supersession — is real and proven at the real-git tier; what
is missing is the last half of the public release surface (GitHub Release
object + changelog bytes minted and verified live), the four sharpest open
defects, and the composed idempotency/crash proofs over the newly-wired
publish path.**
