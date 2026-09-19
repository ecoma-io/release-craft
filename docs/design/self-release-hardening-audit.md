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

| Capability                                                        | Class                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic planning                                            | tested                  | `src/planner/*` pure; double-run deep-equal + goldens pinned to scenario docs (`test/planner/plan.golden.test.ts`, `test/planner/assemble.test.ts`); `Date.now`/`new Date(`/`Math.random(`/`process[.[]`/`globalThis`/`Intl`/`toLocale*` banned by an executable static gate (`test/planner/isolation.test.ts:163-199`)                                                                                          |
| Plan identity (`plan_sha256`, `inputs_sha256`)                    | tested + dogfood-tested | Canonical serializer is key-sorted, whitespace-free, deterministic (`src/planner/identity.ts:65`); **#319 fix holds at `identity.ts:204`** (empty `intents` === absent — one semantic fact, one fingerprint); plan/inputs fingerprints stable across the D82 shadow windows                                                                                                                                      |
| Claim-before-mutation                                             | tested                  | Real-git CAS (`src/adapters/git/claim-store-git.ts:380-434` via `git update-ref` old-value compare-and-set); a hostile `git` PATH shim kills the process mid-CAS (`test/adapters/git/claim-register.test.ts:448`); two-clone exclusion race pinned (`:947-1010`); the engine refuses to mutate claimless (`src/app/engine.ts:923-930`, mint door `:606-614`)                                                     |
| Execution ledger (durability/resume)                              | tested                  | Write-ahead start-before-effect (`src/app/engine.ts:430-448`); content-aware tip dedup absorbs crash-restart (`src/adapters/git/ledger-git.ts:158-193`, #185); forward-only CAS fails closed; a fresh binding reloads the tail and classifies identically (`test/vertical/github-vertical.test.ts:716-748`)                                                                                                      |
| Attempt state machine + supersession terminality                  | tested                  | Closed edge table, empty terminal rows (`src/execution/attempt.ts:49-58`); no revival edge; abandonment is a durable record (`src/app/engine.ts:996-1003`), the tail — not process-local value — is authority (`test/execution/abandonment-record.test.ts:197-330`)                                                                                                                                              |
| Tag mint                                                          | tested + dogfood-tested | `src/adapters/git/tag-door.ts` (existence CAS, same-target idempotent `minted` / different-target `conflict`); live-minted on origin (self-release run 34635157220 pushed `0.2.0`)                                                                                                                                                                                                                               |
| Idempotent retry                                                  | tested in parts         | Same-attemptId resume re-runs an effect exactly once (`test/app/resume.test.ts:311-369`); completed steps replay `noop`; ledger tip dedup; tag re-mint never rewrites the ref (`test/adapters/git/claims-mint.test.ts:269`); release create is read-before-write with an ambiguous-on-lost-response classifier (`src/adapters/github/publication.ts:266-310`)                                                    |
| Provider isolation (kernel purity)                                | tested                  | `core/domain` imports only itself; archkeep bans every external import (`module-boundaries.config.mjs:72-76`); no provider vocabulary in kernel value names (`test/provider-isolation.test.ts:151-206`)                                                                                                                                                                                                          |
| Release-PR gate identity + live gate legs                         | dogfood-tested          | Body claim-marker identity, never title/label (`src/app/release-pr.ts:49-77`); six live legs on PR #313 (`e2e/evidence/release-pr-e2e-2026-09-12.jsonl`); D83 draft PR #528 on a real foreign consumer, tags byte-identical                                                                                                                                                                                      |
| Self-release workflow orchestrates the engine (no special-casing) | implemented + tested    | No `if: repository == release-craft` conditional anywhere in `.github/workflows/`; both workflows invoke the pinned public Action `ecoma-io/release-craft@<sha>` exactly as any consumer would — `self-release.yml:174-184`, `dogfood.yml:112-122`                                                                                                                                                               |
| Version-carrying commit door (#339)                               | tested                  | `src/adapters/git/commit-door.ts` — a deterministic `commit-tree` over the recorded base: base entries kept byte-equal, produced mutation bytes overlaid, same input → identical oid (idempotent replay, no CAS); unclaimed and foreign-token attempts refused, an unresolvable base throws `GitFaultError` (exit-70 posture, D39) — `test/adapters/git/commit-door.test.ts`, 7 rows over real temp repositories |

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

## 8. Re-audit addendum — HEAD `f89c0f7` (2026-09-19)

Method: the six commits since `a1de69d` (#326–#335) were delta-audited, and
the three load-bearing chains — publication, mutation→commit→changelog, and
the Action/caller posture — were re-grounded by direct source reads. Every
"still present" below was re-verified at this HEAD, not carried from D85.

### What changed since the audit

- **#335 — the publication port is wired into the engine.** `EnginePorts`
  gained `publication` (`src/app/types.ts:166`), the release-remote assembly
  composes it (`assemblePublicationBinding`, `src/app/assemble.ts:73-98`;
  the shell composition `openPublicationDriver`, `src/publication-driver.ts:38`),
  and `completeRun` runs mint → `publishRelease` → `verifyRelease`, landing
  `published` only on a verified read and blocking with resumable causes on
  `absent`/`unavailable`/`ambiguous` (`src/app/engine.ts:645-705`), plus the
  D87 pre-walk refusal of a publication wired without a tag door
  (`src/app/engine.ts:940-946`). Tested — `test/app/publication-port.test.ts`
  (ok, refused-422, ambiguous status-0, transport-500, body-bytes,
  resolve+resume) — over **fake transports only**.

- **#327/#331/#333 — the changelog artifact is declared end to end.** The
  CLI declares one `artifact:changelog` step behind `--changelog`
  (`src/cli/index.ts:29-47`), the Action gained the input (`action.yml:64-66`),
  the self-release workflow passes it, and the judge asserts the record's
  internal consistency (`scripts/dogfood/judge.mjs:873-956`). The bytes are
  still the **pre-existing committed CHANGELOG.md** — `GitArtifactProducer`
  digests `git-tree:<HEAD^{tree}>` (`src/adapters/git/producer-git.ts:50-56`);
  `renderChangelog` still has no production caller (#291) and no digest in
  the chain carries renderer bytes (#294).

### New ground truth this addendum records

1. **Publication over the REST/API transport is unimplemented; the git-ref
   transport is real.** The publication and verification units run over an
   injected `GitHubTransport` (`src/adapters/github/publication.ts:257-264`)
   and every test injects a fake — no live REST/API transport, no endpoint
   wire, and the Action/CLI have no token ingress for it (tracked as #336,
   PR #337). Do not confuse that with the adapter's git-ref transport, which
   is real: `GitRemoteSync` (`src/adapters/github/sync.ts:159-175`) opens
   `openRemoteGit` with the token in an inline credential helper
   (`src/adapters/github/remote-git.ts:37-42`) and runs `ls-remote` and
   `push ref:ref` against the binding's own `origin`
   (`src/adapters/github/sync.ts:63-107`, `:166-193`) — live-capable,
   classified outcomes, but composed behind `openGitHubAdapter` and never
   invoked by the self-release workflow yet.
2. **The create can mint a tag at the wrong commit.** The create POST
   carries only `{tag_name, name, body}` — no `target_commitish`, and no
   remote tag precondition or SHA check exists before the write or inside
   `verifyRelease` (`src/adapters/github/publication.ts:301-309`,
   `:335-369`). Because the origin lacks the tag, GitHub's create-release
   behavior creates that tag at the default branch's head — the
   wrong-commit hazard a public release path must refuse. The required
   composition is sync → create → verify (the sync unit already compares
   the remote listing against the binding's recorded targets,
   `src/adapters/github/sync.ts:35-44`, `:109-148`), but that composition
   is not implemented yet. Release-blocking.
3. **The publish/verify effects append no effect-boundary ledger records.**
   The canonical `publish`/`verify` stage records are the walk's
   fingerprint-gate records; the actual remote effects in `completeRun`
   touch only the attempt (`src/app/engine.ts:645-705`). Crash safety rides
   idempotent re-execution (read-before-write create, same-target re-mint),
   which holds; the durable journal names stages, not effects — a Phase 1
   adversarial-review item, not a proven invariant.
4. **Mutations never reach a tagged commit.** Attempt mutations come only
   from host `request.declarations` (#289; `scheduleMutations`,
   `src/app/engine.ts:331-363`); no adapter commits a mutated worktree (the
   only `commit-tree` is the CAS register append,
   `src/adapters/git/git-refs.ts:144-145`); and the mint target is the
   feed-ref head the caller recorded (`src/cli/targets.ts:15-28`;
   `src/app/engine.ts:615-630` names it "never ambient HEAD"). A
   version-carrying release — the thing a real self-release is — has no
   path from plan to tagged commit yet: no version-bump producer, no
   release-commit door, no changelog mint. Release-blocking.
5. **The publication body seam is correct-by-construction but currently
   feeds stale bytes**: `recordedChangelog` projects the completed
   `artifact:changelog` record's digest and reads the file from the
   recorded tree (`src/adapters/github/publication.ts:209-249`). Once
   #291/#294 land, this same seam binds exact rendered bytes into the
   release and its verification.
6. **Origin identity is enforced open-time, not verify-time.**
   `openGitHubAdapter` refuses an origin↔credentials mismatch
   (`src/adapters/github/remote-identity.ts`); `verifyRelease` performs no
   repository-identity or tag-SHA read.

### Defect census at this HEAD

Re-verified present by direct read: #288 (only `MemoryRecordSink` exists in
`src/`), #289, #291 (`renderChangelog` named only by its definition and the
barrel), #294, #299 (`test/planner/isolation.test.ts:156-159` records the
`localeCompare` gap), #307 (`src/execution/adopt.ts` names no `targetPath`),
#311 (`src/adapters/github/release-pr.ts:1176`), #233
(`phase14-certification-fixture-contract.md:305-306` still ends the
`A-cross-process` leg after naming the boundary), #248
(`phase12-cli-contract.md:84`). Carried from the D85 audit with no touching
commits since `a1de69d`: #222, #223, #230, #235, #237, #250, #253, #262.

### Reconciliations taken with this addendum

- PRs #325 (audit duplicate), #234 (#208 early cut, 53 commits stale), #211
  (#194 closed; the capability lives in `src/execution/resume.ts` and the
  certification matrix) closed as superseded, with comments.
- Historical tags `0.1.0` (`e6e8546`) and `0.2.0` (`5eb0440`) on origin are
  **rehearsal artifacts** of the self-release workflow (the audit's §1
  mint row: run 34635157220 minted `0.2.0`): lightweight tags at their
  landing commits, no GitHub Release objects, `package.json` still at
  `0.1.0`. They are not promotable evidence; the first real release is a
  fresh cycle whose identifiers must all agree.

### Posture delta over §1–§3

| Capability                                        | Was    | Now                                       |
| ------------------------------------------------- | ------ | ----------------------------------------- |
| Publication port (engine half)                    | absent | implemented + tested (fake transport)     |
| Changelog artifact declaration                    | absent | implemented (bytes stale until #291/#294) |
| Live publish leg (transport, token ingress)       | absent | absent (#336)                             |
| Publication ordering invariant (tag→expected SHA) | absent | absent — now named, release-blocking      |
| Plan→mutation→commit→tag chain                    | absent | absent — now named, release-blocking      |

## 9. Re-audit addendum — the #339 working tree (2026-09-20)

Method: the #339 slice (issue
[#339](https://github.com/ecoma-io/release-craft/issues/339) — the
version-carrying self-release engine half) was delta-audited against §2's
three incomplete rows — **Version mutation**, **Changelog renderer**,
**Commit** — on the branch's working tree, and the new seams were re-read at
their source and re-run in their suites.

### What changed since §8

- **The git binding gained a `commit` port.** `GitCommitDoor`
  (`src/adapters/git/commit-door.ts`) is a pure, deterministic
  `commit-tree`: `ls-tree -r` over the recorded base (raw paths), the
  completed updater steps' produced bytes overlaid, a recursive `mktree` in
  git ordering, and one `commit-tree` whose message names the release —
  tag, line, plan. No index, no worktree, no ref move. Content addressing
  makes replay idempotent: the same recorded tail re-derives the same oid,
  so resume needs no CAS. §2's "no adapter creates a release commit" row is
  answered at the adapter tier.
- **The engine wired it before the mint.** `completeRun` calls the port
  when the assembly declares one and the ledger tail holds completed
  updater steps; the mint's target resolves from the **committed** oid —
  the release names a commit that carries its own bump bytes, never ambient
  `HEAD`. Zero updater steps skips the door (byte-identical memory runs:
  memory assembly declares no commit port). A mutation path the declared
  seam cannot re-read is a **fail-closed refusal before any commit**; the
  pre-walk also refuses a committed-but-untagged finished attempt and an
  uncommitted mint with commit-anchored mutations.
- **The version-carrying driver exists** (`src/version-mutation-driver.ts`):
  plan → `version-bump` + `changelog-render` mutations → commit → mint →
  publication, composed as a package-shell factory (the publication-driver
  precedent). `planLine.changes` stays untouched — **#291's
  change-shape binding is not part of this slice**, stated deliberately.

### New ground truth this addendum records

- **The committed tree is the produced tree.** The vertical driver test
  asserts the tagged tree's `VERSION` and `CHANGELOG.md` byte-equal to the
  driver's own produced values and the recorded base entry byte-equal to
  the base blob — the release commit carries exactly its mutations, nothing
  ambient (class 1).
- **The changelog mint is the release body's seam (class 3).** The
  changelog artifact producer mints a `git-tree:` digest of a
  single-entry tree holding the rendered changelog at its path; the
  publication resolver reads the recorded digest through
  `binding.content.file(digest, "CHANGELOG.md")`. The vertical driver test
  proves that read returns the **same bytes the commit carried** — recorded
  tree and committed tree agree by construction, byte-equal (the created
  release object itself is the publication-port suite's proof on the
  identical assembly and resolver).
- **The commit is the release's auditable identity.** Its subject is
  `release-craft: release <tag> for <line> (<planId>)` verbatim; the
  vertical test pins the full subject, tying the minted tag to the recorded
  plan through the commit's message. (The extraction-classification of the
  release's own commits — D11's trailer-namespace rule governs the
  `Release-Craft:` trailer, not this subject — is a subsequent slice's
  recorded question, not decided here.)

### Defect census delta at this tree

- **#289 (no plan→mutation binding)** — partially answered: the driver
  derives `version-bump` and `changelog-render` mutations from the plan's
  recorded line (its version), the middle term §2 names; `planLine.changes`
  (#291) is deliberately not consumed — the change-shape binding remains
  open.
- **#291 (renderChangelog has no production caller)** — answered at the
  driver tier: the changelog-render mutation's producer and the changelog
  artifact producer are production callers; the release-pr.ts hand-rolled
  projection is unchanged and stays #291-scoped.
- Re-verified present, unchanged by this slice: #288, #294, #299, #307,
  #311, #233, #248, and the carried #222/#223/#230/#235/#237/#250/#253/#262.

### Posture delta over §1–§3

| Capability                                        | Was    | Now                                            |
| ------------------------------------------------- | ------ | ---------------------------------------------- |
| Version mutation (producer exists)                | absent | implemented + tested (driver #339)             |
| Changelog renderer (production caller)            | absent | implemented + tested (driver #339)             |
| Release commit                                    | absent | implemented + tested (real git)                |
| Commit→mint ordering (tag names the bump commit)  | absent | present — mint target is the committed oid     |
| Publication port (engine half)                    | absent | implemented + tested (fake transport)          |
| Changelog artifact declaration                    | absent | implemented (bytes stale until #291/#294)      |
| Live publish leg (transport, token ingress)       | absent | absent (#336)                                  |
| Publication ordering invariant (tag→expected SHA) | absent | absent — now named, release-blocking           |
| Plan→mutation→commit→tag chain                    | absent | present through the commit door (driver scope) |

## 10. Re-audit addendum — merged HEAD `b286796` (2026-09-20)

Method: the Wave 1c merge (issue
[#339](https://github.com/ecoma-io/release-craft/issues/339), PR #348 →
`b286796`) is the first slice that landed through the org gate, so this
addendum re-measures the audit's posture at the **merged** HEAD rather than a
working tree. Four read-only reconnaissance agents (adapters, surfaces,
execution, issues) delta-audited each subsystem, then this lead re-read the
load-bearing seams directly — the publication create, the commit-door
filter, the assembly selection, the module-boundary law, the invocation
environment — and re-measured the repository facts (tags, releases, package,
PR #337 state). Every "absent"/"present" below was re-verified at this HEAD,
not carried from §8 or §9.

### What changed since §9

- **Wave 1c is merged and CI-verified.** The version-carrying commit door
  (`src/adapters/git/commit-door.ts`), the version-mutation driver
  (`src/version-mutation-driver.ts`), their tests, and this audit's §9
  posture delta landed as PR #348 (`b286796`); issue #339 closed. The
  engine's commit→mint→publication chain (§9's "release commit",
  "commit→mint ordering", "plan→mutation→commit→tag chain" rows) is now
  main's state, not a branch's. The `pnpm check` bar for that merge (1905
  tests, 92.75% statements) is the baseline every subsequent slice must
  hold.
- **PR #337 is an empty gate commit, not the publish leg.** The #336
  publish-leg wiring (§8 row "live publish leg", tracked as PR #337) has
  **zero file changes**: its only commit `c3c53b6` is a gate commit whose
  tree equals its parent `f89c0f7`. The branch is also based on
  `f89c0f7`, before Wave 1c — a diff against current `main` shows 22 files
  of _deletions_ that are main's later work. Neither the tenth `publish`
  input, nor the token env amendment, nor the judge's release attestation
  exists anywhere. Planning must not treat #336 as partially landed.

### New ground truth this addendum records

1. **The create POST carries `target_commitish` and a tag-ref precondition
   at this HEAD — the §8 "wrong-commit hazard" claim is closed.**
   `publishRelease` reads the existing release first (idempotency,
   `src/adapters/github/publication.ts:384-401`), then — only on a 404 —
   derives the recorded tag target (`recordedTagTarget`,
   `:343-359`), gates the create on the remote tag ref answering that
   recorded SHA (`tagRefVerdict`, `:255-287`: 200 + `object.sha ===
recordedTarget` → `proceed`; 404 → `release-tag-missing` over an
   observable repository; other → the read taxonomy), and only then POSTs
   `{tag_name, name, body, target_commitish: recordedTarget.target}`
   (`:429-441`). §8's cited lines (`:301-309`, `:335-369`) described the
   pre-#338 state. Verified by direct read at this HEAD.
2. **Two tag-gate windows remain open.** (a) **TOCTOU**: the
   `tagRefVerdict` GET and the create POST are separate requests with no
   re-assertion between them — and after the create returns 201 nothing
   re-reads the tag or the release (the `verifyRelease` half is a separate
   engine phase; the create's own `releaseUrl` is trusted as returned).
   (b) **Idempotent-ok skips the gate entirely**: on the 200-match path
   (`:391-398`) the function returns `ok` without consulting the tag ref —
   the comment at `:407-411` states this deliberately ("a re-run of a
   succeeded publication does not re-assert the tag"). A tag deleted or
   moved after first publication (or a release deleted and re-created with
   the same body) is therefore **silently accepted** by the idempotent
   re-run. Phase 1's close-the-transaction work must decide and seal these
   two windows.
3. **No REST/API transport exists in `src/` — the publication port is
   still unproven against the real provider.** `GitHubTransport` is an
   injected interface (`src/adapters/github/adapter-types.ts:329-334`,
   "the implementation supplies the fetch mechanics"); grep across
   `src/adapters/github/` finds the interface and its fake consumers
   (tests) only — no `fetch(`, no `node:http`, no `https.request`. Every
   publication/release-pr/reconciliation test injects a fake. The git-ref
   transport (`GitRemoteSync`, `src/adapters/github/sync.ts`) is real and
   live-capable, but no **GitHub Release object has ever been created on
   any recorded leg** — the self-release workflow's publish step pushes
   git refs only (`scripts/dogfood/publish-mint.mjs`), and its verification
   reads `git ls-remote` only (`scripts/dogfood/verify-origin.mjs`). This
   is the single largest unproven surface on the path to a real
   self-release: a live REST transport implementation + one live create
   leg.
4. **The CLI/Action surfaces cannot reach the publication port — no token
   ingress, no assembly.** `selectEngine` offers exactly the two
   null-publication factories (`src/cli/selection.ts:36-57`); the module
   boundary law pins CLI dependencies to
   `app/execution/planner/adapters-git` and forbids the package front door
   (`module-boundaries.config.mjs:33`, `type-cli` row) — the CLI
   architecturally cannot compose the GitHub adapter. The Action's
   invocation spawns the bin with an environment of exactly `{PATH, HOME}`
   (`action/invoke.mjs:361-362`) and its declared inputs close at
   `changelog` (`:181-190`). #336 (tenth `publish` input, token via the
   step env, hermeticity amendment) is the required bridge — and it is not
   implemented (ground truth 2 above).
5. **Ledger/claims durability is proven at the git tier; the claims-register
   fetch gap (#237) stands.** Ledger per-attempt refs with first-parent
   record streams and CAS appends, whole-envelope CAS claim registers, and
   ordinal registers are all durable and tested (fixture-1 reload
   byte-exact, resume equivalence). But no engine/adapter code fetches the
   remote claims register (#237): only `self-release.yml:132-140`
   pre-fetches `+refs/release-craft/claims/*` before invoking the Action;
   a plain consumer of the released Action runs against local claims only.
6. **Adopted updater completions are invisible to the commit door (#307).**
   `completedMutationFiles` filters ledger records on
   `record.record.targetPath !== undefined`
   (`src/app/engine.ts:589-624`) before feeding the commit door; `adopt()`
   mints updater completions without a `targetPath` (no such field on the
   adoption record), so an adopted update is silently omitted from any
   release commit. Engine-tested paths (the version driver) flow through
   the targetPath-carrying `updater` layer and are unaffected; the
   adoption path is the gap.
7. **Historical tags are rehearsal artifacts — no promotable evidence
   exists.** Re-measured: `0.1.0` → `e6e85464`, `0.2.0` → `5eb04403` (both
   on `main` history, `package.json` at `0.1.0`), `9.9.9` → `8587b13a`
   (off-`main`, divergent rehearsal). `gh release list` is empty — zero
   GitHub Release objects. Per goal §9's taint rule, none of these tags
   can stand as evidence of a real self-release; the first real release
   mints fresh identifiers and all of them must agree (version commit →
   tag → release → changelog → ledger).
8. **The completeRun ordering is commit-first, then mint, then verified
   publication.** Re-verified at `src/app/engine.ts:636-800`: when the
   walk recorded completed updater steps and the assembly declares a
   commit port, the commit door runs before the mint (the mint target is
   the committed oid, never ambient HEAD); the publication port runs after
   the mint, and `published {tag, releaseUrl}` lands only on a verified
   read — determinate refusals return `refused`, absent/ambiguous/transport
   failures block the attempt with a resumable cause. This is the
   transaction order Phase 1 must harden, not rebuild.

### Defect census at this HEAD (issue #349 re-audit)

All 27 tracked issues reconciled against merged HEAD `b286796` (read-only;
each verdict cites the owning source or the measured command output):

| Verdict             | Issues                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FIXED               | #339 (commit door + driver, merged #348), #206 (renderer, production caller), #204 (manifest door), #203 (updater layer), #205 (node-workspace detection)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PARTIAL             | #336 (engine half merged; Action leg unwired — PR #337 empty), #294 (changelog bytes digest-sealed on the driver path only), #291 (rendered changelog reachable via driver; `planLine.changes` shape unchanged), #289 (driver binds its mutations; host-declared corridors plan-blind), #237 (workflow-level fetch only)                                                                                                                                                                                                                                                                                                                 |
| UNRESOLVED          | #311 (release-pr tamper guard skips on derivation failure, `release-pr.ts:1176`), #307 (adopt completions lack targetPath — invisible to commit door, ground truth 6), #299 (isolation list lacks `localeCompare`/bare `Date()`), #262 (persist-credentials gate comment-satisfiable), #250 (CLI test harness inherits ambient env), #235 (PR template ships unchecked boxes the gate refuses), #230 (triage dry-run flag unshipped), #253 (test-stress.mjs in node's default glob), #223 (pre-read channel drift still silent), #222 (vertical fixture forges claim-held guard), #288 (release-pr records outside the execution ledger) |
| DOC-ONLY            | #233 (phase14 R2 sentence truncated), #248 (phase12 §Layering contradicts the enforced boundary), #305 (changelog `##` vs `###` citation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| FEATURE-NOT-STARTED | #208 (release-pr CLI/Action surface), #207 (bootstrap CLI door), #268 (harmonise English gate)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### Reconciliations taken with this addendum

- **PR #337** — recorded as empty (zero file changes) and re-based on a
  pre-Wave-1c `f89c0f7`; the #336 work must be built fresh on `main` and
  this PR superseded, not "finished".
- **Scout divergences resolved in the lead's favor**: the §8-era "create
  lacks `target_commitish`" claim (ScoutSurfaces repeated it) is closed at
  this HEAD — the live source carries it plus the tag-ref gate (ground
  truth 1). The audit doc, not the older workflow snapshot, is the
  authority for the current contributor.

### Posture delta over §1–§3

| Capability                                        | Was (§8/§9)                           | Now (merged HEAD `b286796`)                            |
| ------------------------------------------------- | ------------------------------------- | ------------------------------------------------------ |
| Version mutation (producer exists)                | branch (working tree)                 | main, merged + CI-verified (#339/#348)                 |
| Changelog renderer (production caller)            | branch (working tree)                 | main, merged (driver tier)                             |
| Release commit                                    | branch (working tree)                 | main, merged (real git)                                |
| Commit→mint ordering                              | branch (working tree)                 | main, merged — verified ordering                       |
| Publication port (engine half)                    | implemented + tested (fake transport) | unchanged — still fake-transport only                  |
| Create carries `target_commitish` + tag gate      | absent (§8 claim)                     | present at HEAD (`publication.ts:429-441`, `:255-287`) |
| Tag-gate TOCTOU / idempotent-ok skip              | unnamed                               | named, open — Phase 1 scope                            |
| Live publish leg (REST transport + token ingress) | absent (#336)                         | absent — PR #337 empty, work not started               |
| #307 adopted-updater visibility to commit door    | named                                 | verified filter (`engine.ts:589-624`) — open           |
| Claims-register fetch (#237)                      | absent (workflow-level fetch only)    | unchanged — open                                       |
| GitHub Release object ever created (any leg)      | none recorded                         | none recorded — unproven surface                       |
