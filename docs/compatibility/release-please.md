# The living release-please compatibility matrix

This document pairs every release-please capability the phase-0 baseline observed with
release-craft's answer today: a parity class, the configuration that governs it, the
executable evidence behind the claim, and its dogfood status. It is the compatibility
campaign's central artifact — [issue #200] records the problem statement and the rules
this file holds itself to.

Provenance and update discipline:

- **Release-please behavior** is not restated here. The [phase-0 baseline](../design/release-please-baseline.md)
  is the authority — a static snapshot, version-stamped at commit
  `c65408d9f68b2772c6e61dcdc4a8b6f5969bb4e1`. This file links it instead of copying it.
- **Release-craft behavior** is claimed only with executable evidence: a test, a fixture,
  or a recorded run, cited per row. Prose is never evidence.
- The document is **living**: every PR that lands or changes a capability updates its rows
  in the same PR. A dogfood cell moves only on a recorded run. The GAP rows are the
  campaign's backlog — each carries either its tracking issue or the named open
  decision that must land before the work can be filed.

## How to read

Parity classes:

| Class            | Meaning                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `PARITY`         | Same observable outcome as release-please, evidence cited.                                                                       |
| `RC-STRONGER`    | Release-craft strictly subsumes the capability; difference classified `RC-STRONGER`.                                             |
| `PARTIAL`        | Overlap plus a named, classified difference — often a known bug or a pending decision.                                           |
| `GAP`            | Release-craft cannot do this today. The row's issue — or, where a decision gates the work, that named decision — is the backlog. |
| `NOT-APPLICABLE` | Outside the engine's product boundary per the baseline's classification table. Documented, never silently dropped.               |

Divergence classifications attached in the Differences column: `EQUIVALENT`,
`RC-STRONGER`, `POLICY DIFFERENCE`, `UNSUPPORTED`, `RELEASE-PLEASE QUIRK`, `BUG`,
`UNKNOWN`. Two rules: a release-please quirk is never adopted merely because
release-please does it, and `UNKNOWN` is a confession with a name, not a shrug.

Two reference systems share the letter-D namespace and must not be confused: row
references like `A5`, `D6`, `I3` are coordinates inside the section tables below,
while `decision D1`–`D7` are the numbered open decisions listed in
[Open decisions](#open-decisions). A `GAP` row may carry either; a decision-only
row becomes a filed issue once its decision lands.

Dogfood statuses: `none` — no recorded run; `self` — the engine's own repository releases
through its own Action (the [self-dogfood PR #141] and its re-pins); `shadow` — a
recorded release-please-vs-release-craft comparison run. No shadow run has been recorded
yet; the field list they must compare is defined [below](#the-shadow-comparison-fields).

## A. Commit signals

| Capability                                                           | Release-Please                                                                             | Release-Craft                                                                                                             | Parity        | Configuration                                                             | Differences                                                                                                          | Tests & evidence                                                                                                        | Dogfood |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------- |
| Conventional type → bump mapping                                     | feat→minor, fix→patch, breaking→major; chore/build/ci non-releasable                       | Declared commit-type → bump mapping, breaking marker dominates any type                                                   | `PARITY`      | `policy.bumpMappingId` (today only the id `default` is accepted)          | `EQUIVALENT` — the mapping is declared policy data, not a hardcoded strategy                                         | [decide.test.ts], [assemble.test.ts] (S-04: bump-driving independent of changelog-worthiness), [kernel version.test.ts] | `self`  |
| Breaking markers (`!`, footer)                                       | `!` suffix, `BREAKING CHANGE` footer, `BREAKING-CHANGE` alias, wrapped continuation values | Marker dominates the declared type                                                                                        | `PARTIAL`     | —                                                                         | `BUG` — [#196]: the `BREAKING-CHANGE` alias and wrapped continuation lines are missed, silently under-bumping majors | [decide.test.ts], [extract.adversarial.test.ts]                                                                         | `none`  |
| Release-As                                                           | `Release-As` footer; newest-first precedence                                               | `release-as` operator intent, kernel-grammar-validated; the first intent in input order wins                              | `PARITY`      | Operator intent (a config-file key would ride the config surface, [#204]) | `EQUIVALENT` mechanism, different surface                                                                            | [plan.test.ts] (`namedTag`), [input.test.ts]                                                                            | `none`  |
| Operator-forced release without bump-qualifying commits              | None (Release-As used as a workaround)                                                     | First-class `release-anyway` intent with a recorded refusal path                                                          | `RC-STRONGER` | Operator intent                                                           | `RC-STRONGER`                                                                                                        | [decide.test.ts]                                                                                                        | `none`  |
| Multi-commit messages (`BEGIN_COMMIT_OVERRIDE`, nested blocks)       | Parsed and flattened                                                                       | Not modeled; malformed markers and unparseable messages are surfaced classifications, never silently swallowed            | `GAP`         | —                                                                         | `UNSUPPORTED` today — open decision D1                                                                               | [extract.adversarial.test.ts] (the refusal classifications), [identity.ts]                                              | `none`  |
| Revert commits                                                       | Ignored from releasable units                                                              | Absent from the declared mapping → no bump; their changelog display is unrendered today                                   | `PARTIAL`     | Mapping                                                                   | Version effect `EQUIVALENT`; notes display `UNKNOWN` pending the renderer, [#206]                                    | [decide.test.ts]                                                                                                        | `none`  |
| Per-commit changelog suppression (`skip-changelog`, hidden sections) | `skip-changelog` footer; `changelog-sections` hidden types                                 | Per-line withhold rules: scope + reason, deferral pinned under the withheld commit, recoverable on unfreeze (PL-06/PL-07) | `PARTIAL`     | `line.withhold[]`                                                         | `POLICY DIFFERENCE` — scope-based deferral with recovery, not type-based hiding                                      | [line-policy.test.ts]                                                                                                   | `none`  |
| Commit identity (squash chains, cherry-picks, Change-Id)             | Commit sha, message heuristics                                                             | Change-Id footer / cherry-pick origin / sha identity sources feeding attribution                                          | `RC-STRONGER` | —                                                                         | `RC-STRONGER`                                                                                                        | [identity.test.ts], [identity.ts]                                                                                       | `none`  |

## B. Versioning

| Capability                                                                                   | Release-Please                                       | Release-Craft                                                                                                                                                                 | Parity           | Configuration                                                      | Differences                                                                          | Tests & evidence                                                                                     | Dogfood |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------- |
| Default bump rules                                                                           | Semver bump from commit types                        | The kernel's `Version` bump laws + the declared mapping                                                                                                                       | `PARITY`         | `policy.bumpMappingId`                                             | `EQUIVALENT`                                                                         | [version.test.ts] (kernel contract), [decide.test.ts]                                                | `self`  |
| Pre-1.0 dampening (breaking bumps minor below 1.0.0)                                         | `bump-minor-pre-major`                               | `pre10Dampening` line-default policy                                                                                                                                          | `PARITY`         | `policy.pre10Dampening`                                            | `EQUIVALENT`                                                                         | [plan.test.ts] (dampened and undampened pins, `1.0.0` crossing)                                      | `none`  |
| Pre-1.0 feat→patch knob (`bump-patch-for-minor-pre-major`)                                   | Supported flag                                       | Not modeled                                                                                                                                                                   | `GAP`            | —                                                                  | `UNSUPPORTED` today; a policy-knob decision tracked with the config surface, [#204]  | —                                                                                                    | `none`  |
| `always-bump-patch` / `always-bump-minor` / `always-bump-major`                              | Dedicated strategies                                 | `release-anyway` intent + declared mapping cover the observable outcome; strategy kinds are not ported                                                                        | `PARTIAL`        | Intent + mapping                                                   | Decision D2: map onto policy, never port the strategy taxonomy                       | [decide.test.ts]                                                                                     | `none`  |
| Service-pack strategy                                                                        | Maven-specific                                       | —                                                                                                                                                                             | `NOT-APPLICABLE` | —                                                                  | Baseline classification table: OUT OF SCOPE                                          | baseline, [classification table](../design/release-please-baseline.md)                               | `none`  |
| Prerelease versioning                                                                        | `prerelease` flag + strategy; documented asymmetries | Streams are first-class: declared ladder, seed policy (`0`/`1`), per-line admission (`all`/`none`/list), sequences read from tag history, stable-only refusal recorded (M-08) | `RC-STRONGER`    | `policy.prereleaseLadder`, `policy.prereleaseSeed`, `line.streams` | `RC-STRONGER`                                                                        | [channels.test.ts], [plan.golden.test.ts] (P-rows), the [scenario map](../design/matrix-coverage.md) | `none`  |
| Promotion prerelease → stable                                                                | Not modeled (Release-As escape hatch)                | `promote` intent, channel transitions, promoted-from evidence, stream close                                                                                                   | `RC-STRONGER`    | Operator intent + channels                                         | `RC-STRONGER`                                                                        | [channels.test.ts], [plan.golden.test.ts] (P-rows)                                                   | `none`  |
| Initial version / bootstrap boundary                                                         | `bootstrap-*` config, `initial-version`              | Birth base `0.0.0` + first bump; the recorded `BootstrapDecision` names the line's birth (S-02 records `1.0.0` verbatim)                                                      | `PARTIAL`        | —                                                                  | The guided bootstrap flow is a `GAP` → [#207]                                        | [input.test.ts] (bootstrap boundary), [plan.ts]                                                      | `none`  |
| History window overrides (`release-search-depth`, `last-release-sha`, `commit-search-depth`) | API depth bounds + emergency overrides               | Closed observation: the caller's tag/ref/commit window is explicit input; the planner performs zero git calls                                                                 | `PARTIAL`        | Caller-supplied observations                                       | `POLICY DIFFERENCE` — the window is data, not a knob; large-repo ergonomics unproven | [history.test.ts], [input.ts]                                                                        | `none`  |

## C. Lines, branches, prerelease posture

| Capability                                  | Release-Please                           | Release-Craft                                                                                                      | Parity        | Configuration             | Differences                                                   | Tests & evidence                                             | Dogfood |
| ------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ | ------- |
| Target branch                               | `target-branch` per package              | Release lines are identities, never branches (invariant 7); `feedRef` observes a branch, identity survives renames | `RC-STRONGER` | `line.id`, `line.feedRef` | `RC-STRONGER` — M-10 pins retire/rename without identity loss | [line-policy.test.ts], [maintenance-decisions.test.ts]       | `none`  |
| Maintenance branches                        | Multiple `target-branch`es, known quirks | Version bands (`major`/`minor`), per-line histories, band admission, out-of-band tags surfaced (M-01..M-11)        | `RC-STRONGER` | `line.versionBand`        | `RC-STRONGER`                                                 | [maintenance-decisions.test.ts], [version-collision.test.ts] | `none`  |
| Independent multi-line releases             | Per-branch runs                          | Planned lines release independently through one plan                                                               | `RC-STRONGER` | Lines                     | `RC-STRONGER`                                                 | [plan.golden.test.ts] (M-rows)                               | `none`  |
| Concurrent stable + prerelease on one major | Impossible (baseline §8.3.3)             | Streams live per line: stable on the feed line, prerelease streams alongside (P-05/P-07)                           | `RC-STRONGER` | `line.streams`            | `RC-STRONGER`                                                 | [channels.test.ts]                                           | `none`  |

## D. Monorepo / manifest

| Capability                                                              | Release-Please                                      | Release-Craft                                                                                                                                                                                                                                | Parity        | Configuration              | Differences                                                            | Tests & evidence                                               | Dogfood |
| ----------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- | ------- |
| Package configuration surface (`release-please-config.json` + manifest) | Two JSON files, packages map, per-package overrides | The planner consumes fully-capable declared input (`PlanningInput`: components with paths and dependency edges, lines with bands/streams/withhold, policy) — but no committed configuration document exists; callers hand-assemble the world | `GAP`         | —                          | `GAP` → [#204]; planner semantics themselves are pinned (PL-01..PL-08) | [types.ts] (`ComponentMeta`, `LineConfig`), [assemble.test.ts] | `none`  |
| Grouped release (single PR over all packages)                           | Combined mode                                       | —                                                                                                                                                                                                                                            | `GAP`         | —                          | `GAP` → [#202] (one projection of one plan)                            | —                                                              | `none`  |
| `separate-pull-requests`                                                | Per-package PRs                                     | —                                                                                                                                                                                                                                            | `GAP`         | —                          | `GAP` → [#202]                                                         | —                                                              | `none`  |
| Workspace dependency propagation (semantics)                            | `node-workspace` plugin: dependents patch-bumped    | Propagation planner: topologically ordered edges, declared range grammar (`^`, `~`, exact), negative evidence that a component did _not_ move (`notMoved`), pinned by PL-02/PL-03                                                            | `RC-STRONGER` | `component.dependencies[]` | `RC-STRONGER` semantics — the file mutation is the gap below           | [propagate.test.ts], [plan.golden.test.ts]                     | `none`  |
| Dependent file mutation (`package.json` ranges)                         | Updater writes dependents                           | Propagation plans; nothing writes files                                                                                                                                                                                                      | `GAP`         | —                          | `GAP` → [#203]                                                         | —                                                              | `none`  |
| `linked-versions`                                                       | Group plugins                                       | Not modeled                                                                                                                                                                                                                                  | `GAP`         | —                          | Decision D3 — grouping is declared policy, never inferred              | —                                                              | `none`  |
| `merge`, `group-priority`, `sentence-case` plugins                      | Plugin library                                      | Extension points exist: declared artifact producers, hook schedulers at anchors, hooks-as-steps (ADR-0007)                                                                                                                                   | `PARTIAL`     | Declared steps             | Mechanism `EQUIVALENT`; the specific plugins are undecided per plugin  | [hooks.test.ts], [artifacts.test.ts]                           | `none`  |
| `"."` root package                                                      | Root package reacts to all changes                  | Explicit `components.paths`; an ambiguous component→change mapping is a surfaced refusal, never a guess                                                                                                                                      | `PARTIAL`     | `components.paths`         | Root-aggregating semantics unverified — `UNKNOWN`, decision D7         | [assemble.test.ts] (ambiguous-mapping refusal)                 | `none`  |

## E. Changelog

| Capability                                   | Release-Please                    | Release-Craft                                                                                                                                                                                                                  | Parity           | Configuration         | Differences                                                                                                  | Tests & evidence                                                       | Dogfood                                  |
| -------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | --------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------- |
| `CHANGELOG.md` generation                    | conventionalcommits-preset writer | The changelog is a declared artifact step: content recorded as a git-tree digest in the ledger, publication refuses unrecorded bytes (`changelog-unrecorded`) — but no production renderer exists; only fixtures produce trees | `PARTIAL`        | Artifact declarations | Pipeline `RC-STRONGER` (recorded and evidence-bound, same-process pins); producer `GAP` → [#206]             | [publication.ts], [publication.test.ts], [artifacts.test.ts]           | `self` (pipeline ran end-to-end in #141) |
| `changelog-sections` (custom/hidden)         | Section config                    | —                                                                                                                                                                                                                              | `GAP`            | —                     | `GAP` → [#206]; withhold is scope-deferral, not section-hiding (`POLICY DIFFERENCE`)                         | —                                                                      | `none`                                   |
| PR/commit links, author attribution          | Rendered into notes               | —                                                                                                                                                                                                                              | `GAP`            | —                     | `GAP` → [#206]; attribution must be recorded evidence or omitted, never ambient                              | —                                                                      | `none`                                   |
| Custom changelog path (`changelog-path`)     | Per-package path                  | Artifact coordinates declared per step                                                                                                                                                                                         | `PARTIAL`        | Artifact declarations | `EQUIVALENT`-shaped; exact coordinates pinned with the renderer                                              | [artifacts.test.ts]                                                    | `none`                                   |
| `changelog-type: github` (release-notes API) | Supported                         | —                                                                                                                                                                                                                              | `NOT-APPLICABLE` | —                     | Baseline classification table: OUT OF SCOPE — ambient provider output is not a deterministic plan projection | baseline, [classification table](../design/release-please-baseline.md) | `none`                                   |

## F. Release PRs

| Capability                                    | Release-Please                                           | Release-Craft                                                                                                                      | Parity   | Configuration | Differences                                                                   | Tests & evidence                                                | Dogfood |
| --------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------- | ------- |
| Release PR creation                           | Core loop                                                | No PR operations exist in the GitHub adapter (doors: sync, publish, verify, reconcile)                                             | `GAP`    | —             | `GAP` → [#202]; planned as a deterministic projection of the recorded plan    | [adapter.ts]                                                    | `none`  |
| Detect & update existing PR in place          | Core loop                                                | —                                                                                                                                  | `GAP`    | —             | `GAP` → [#202]; identity = component + line + target, never a mutable label   | —                                                               | `none`  |
| Pending-state labels (`autorelease: pending`) | Label-based state; the stale-label trap (baseline §11.5) | Claim/attempt identity in ledger refs replaces label state by design                                                               | `GAP`    | —             | `RELEASE-PLEASE QUIRK` deliberately not adopted; the surface itself is [#202] | [claims-mint.test.ts]                                           | `none`  |
| PR title/body patterns                        | Configurable patterns                                    | —                                                                                                                                  | `GAP`    | —             | `GAP` → [#202] (the projection render)                                        | —                                                               | `none`  |
| Draft release PRs                             | `draft-pull-request`                                     | —                                                                                                                                  | `GAP`    | —             | `GAP` → [#202]                                                                | —                                                               | `none`  |
| Merge → tag + GitHub release                  | The `github-release` command                             | The run door: plan → attempt → claim → ledger → tag → publish, proven end-to-end by the self-dogfood and the certification fixture | `PARITY` | —             | `EQUIVALENT` at engine level (no PR gate in between)                          | [certification/git.test.ts], [github-vertical.test.ts], PR #141 | `self`  |

## G. Tag naming

| Capability                                                           | Release-Please                               | Release-Craft                                                                                                                                                                                      | Parity        | Configuration               | Differences                        | Tests & evidence                                                                                                                                                                        | Dogfood                                                   |
| -------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Tag format knobs (`include-component`, `include-v`, `tag-separator`) | Three knobs                                  | Declared per-line templates over `{major}` `{minor}` `{patch}` `{prerelease}` (required); the component name is spelled literally in the template — the three knobs are expressible configurations | `PARITY`      | `policy.tagFormats[lineId]` | `EQUIVALENT` via configuration     | [input.test.ts] (validation, `{prerelease}` required), [plan.test.ts] (`ecoma-app-v{major}...` render), [modules.test.ts] (the CLI's `formatTag` projection equals the plan's spelling) | `self` (the world pins the bare default, [world.test.ts]) |
| Tag collision across lines                                           | Ungated                                      | The version-collision gate refuses two lines minting one tag (M-11)                                                                                                                                | `RC-STRONGER` | —                           | `RC-STRONGER`                      | [version-collision.test.ts]                                                                                                                                                             | `none`                                                    |
| `force-tag-creation` (draft-release workaround)                      | Escape hatch for a missing draft-release tag | Tag mint is a create-if-absent CAS door; no draft-release dependency exists                                                                                                                        | `RC-STRONGER` | —                           | `RELEASE-PLEASE QUIRK` not adopted | [claims-mint.test.ts], R-rows in the [scenario map](../design/matrix-coverage.md)                                                                                                       | `none`                                                    |

## H. State between runs

| Capability                                           | Release-Please                  | Release-Craft                                                                                                                                            | Parity        | Configuration | Differences                                                                                                                         | Tests & evidence                                                          | Dogfood |
| ---------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------- |
| Version state file (`.release-please-manifest.json`) | The manifest file is RP's truth | No state file: tags are the only truth; manifest versions ride as projections (invariant 6); a second run with no new changes is a recorded no-op (S-03) | `RC-STRONGER` | —             | `RC-STRONGER` — nothing to drift                                                                                                    | [state.test.ts], [planner isolation.test.ts], [version.test.ts]           | `self`  |
| Adopting an existing release-please repository       | —                               | Nothing reads release-please state                                                                                                                       | `GAP`         | —             | `GAP` → [#207]; the import decision (read RP state vs re-derive from tags) is recorded there                                        | —                                                                         | `none`  |
| Recovery from a stuck pending state                  | Manual label surgery            | Ledger replay, claim CAS, abort/supersede and abandonment doors                                                                                          | `PARTIAL`     | —             | `BUG` [#194] — cross-process recovery is broken today; the door design intent survives, and the full PR surface arrives with [#202] | [resume.test.ts], [abort-supersede.test.ts], [abandonment-record.test.ts] | `none`  |

## I. The GitHub Action

| Capability                    | Release-Please                                                                              | Release-Craft                                                                                                                                                                   | Parity    | Configuration | Differences                                                                                                                                         | Tests & evidence                         | Dogfood                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| Action inputs                 | Wide input surface (`release-type`, `command`, `config-file`, `manifest-file`, `skip-*`, …) | Closed inventory: `world`, `line`, `actor`, `tag-namespaces`, `intents`, `repo`, `max-retries`, `working-directory`; unknown input maps onto an exact grammar row or is refused | `PARTIAL` | `action.yml`  | `POLICY DIFFERENCE` — different surface model (world document vs package config); `BUG` [#191] — defaulted input typos currently fall back silently | [metadata.test.ts], [invocation.test.ts] | `self` (re-pins #145, #148, #160, #171) |
| Action outputs                | Discrete: `releases_created`, `paths_released`, `tag_name`, `prs_created`, …                | One `outcome` envelope; consumers extract fields (jq) per the documented pattern                                                                                                | `PARTIAL` | `action.yml`  | The output shape is decision D4 → [#208]                                                                                                            | [metadata.test.ts]                       | `self`                                  |
| Fork mode / GHE endpoints     | Supported                                                                                   | The transport is injected and credential-scoped, but a non-github.com target is unverified                                                                                      | `GAP`     | Transport     | `UNSUPPORTED` today — decision D5                                                                                                                   | [remote-git.ts]                          | `none`                                  |
| No package-manager publishing | Delegates                                                                                   | Delegates                                                                                                                                                                       | `PARITY`  | —             | `EQUIVALENT` — both stop at GitHub                                                                                                                  | —                                        | —                                       |

## J. Reliability & recovery

| Capability                   | Release-Please           | Release-Craft                                                                                                                                                                                                         | Parity        | Configuration | Differences                                                                                                                                                        | Tests & evidence                                                                               | Dogfood |
| ---------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------- |
| Idempotent re-run            | Re-run tolerated         | Ledger replay + claim CAS; the same-process double-run produces a deep-equal world (isolation pins) — but hook replay never compares recorded content ([#193]) and canonical-stage fingerprints are constant ([#195]) | `PARTIAL`     | —             | `BUG` — same-process legs pinned; cross-process re-run is broken by [#194]                                                                                         | [execution isolation.test.ts], [no-mutation-before-claim.test.ts], [planner isolation.test.ts] | `self`  |
| Partial failure mid-run      | Not transactional        | Attempts per plan step; terminality decided once by the ledger tail (R-rows); resumable within one process                                                                                                            | `PARTIAL`     | —             | `BUG` [#194] — a new process cannot resume a mid-flight attempt (git ordinals defeat the claim protocol's own recovery); crash-window re-appends tracked as [#195] | [resume.test.ts (execution)], [resume.test.ts (app)]                                           | `self`  |
| Ambiguous transport outcomes | Unclassified failures    | The `ambiguous` outcome class + the explicit verify door (R-13)                                                                                                                                                       | `RC-STRONGER` | —             | `RC-STRONGER`                                                                                                                                                      | [reconciliation.test.ts], [reconciliation.ts]                                                  | `none`  |
| Concurrency across runners   | Client-side locking only | Claim refs, CAS per ref; known gap: exclusion is repository-local ([#182])                                                                                                                                            | `PARTIAL`     | —             | `BUG` [#182] — separate checkouts each acquire                                                                                                                     | [concurrency.test.ts], [claims-mint.test.ts]                                                   | `none`  |
| Git environment hermeticity  | Unaddressed              | A floor git env + namespaced refs (`refs/release-craft/**`) insulate the host repository                                                                                                                              | `RC-STRONGER` | —             | `POLICY DIFFERENCE` — RC treats hermeticity as a contract, not a hope                                                                                              | [namespace-boundary.test.ts]                                                                   | `none`  |

## Release-Please versioning strategies — the decision table

Every release-please versioning strategy gets an explicit verdict; none is ported as a
strategy kind:

| Strategy        | Verdict            | Release-craft mapping                                                                                                               |
| --------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `default`       | `PARITY`           | Declared bump mapping + `pre10Dampening`.                                                                                           |
| `always-bump-*` | Decision D2 (open) | Map to `release-anyway` intent + declared mapping; never port the taxonomy.                                                         |
| `prerelease`    | `RC-STRONGER`      | Streams: ladder, seeds, admission, promotion.                                                                                       |
| `simple`        | `PARITY`           | Birth base `0.0.0` + first bump; guided initial version rides [#207].                                                               |
| `service-pack`  | `NOT-APPLICABLE`   | Baseline OUT OF SCOPE; never modeled. If Java snapshot semantics are ever demanded, they ride streams/channels — not this taxonomy. |

## The shadow-comparison fields

A shadow run (release-please and release-craft planning the same repository state) is
recorded only when every field below is compared and stored. This list is this
document's canonical definition:

repository sha · commit range · selected changes · release decision · decision reason ·
version · release line · prerelease stream · channel · tag · changelog · release notes ·
package/component · dependency propagation · final outcome.

## Open decisions

| #   | Decision                                                           | Where it bites         | Tracking                  |
| --- | ------------------------------------------------------------------ | ---------------------- | ------------------------- |
| D1  | `BEGIN_COMMIT_OVERRIDE` / nested-commit blocks                     | Row A5                 | None yet — open on demand |
| D2  | `always-bump-*` → mapping + intent policy                          | Row B4, strategy table | [#204]                    |
| D3  | `linked-versions` grouping policy                                  | Row D6                 | None yet — open on demand |
| D4  | Action output shape: discrete outputs vs envelope extraction guide | Row I2                 | [#208]                    |
| D5  | Fork/GHE transport targets                                         | Row I3                 | None yet — open on demand |
| D6  | `bump-patch-for-minor-pre-major` knob                              | Row B3                 | [#204]                    |
| D7  | `"."` root-package aggregation semantics                           | Row D8                 | [#204]                    |

## GAP → issue tracking

The GAP rows are the campaign backlog: one issue per subsystem, each filed through the
feature-request template. Three further GAP rows (A5, D6, I3) wait on open decisions
D1, D3 and D5 — their engineering issues are filed once those decisions land:

| Issue                                       | Subsystem                                                     | Rows                      |
| ------------------------------------------- | ------------------------------------------------------------- | ------------------------- |
| [#202] — the Release PR lifecycle           | Detect, create, update-in-place, projection render, draft PRs | F1–F5, D2, D3 projections |
| [#203] — the updater layer                  | Ledger-tracked file mutations                                 | D5, E1 producer path      |
| [#204] — the manifest configuration surface | Components, lines, policy as declared input                   | D1, A3, B3, D7, D2, D6    |
| [#205] — Node workspace support             | Workspace graph detection feeding propagation + updates       | Feeds D4, D5              |
| [#206] — the changelog renderer             | Deterministic `CHANGELOG.md` bytes from the recorded plan     | E1–E4                     |
| [#207] — bootstrap                          | Inspect, infer/accept policy, emit config + first plan        | B8, H2                    |
| [#208] — CLI/Action surface                 | New doors, output shape, loud refusals                        | I2                        |

Known bugs that depress parity rows: [#196] (A2, breaking-marker alias),
[#191] (I1, Action input typos), [#182] (J4, repository-local claim exclusion),
[#193] (J1, hook replay skips content comparison), [#194] (J2, H3, J1 — no
cross-process resume), [#195] (J1, constant stage fingerprints),
[#199] (open question: prerelease tags through the pack action).

## Counts

| Parity class     | Rows |
| ---------------- | ---- |
| `PARITY`         | 7    |
| `RC-STRONGER`    | 14   |
| `PARTIAL`        | 16   |
| `GAP`            | 16   |
| `NOT-APPLICABLE` | 2    |

55 capability rows. Thirteen GAP rows map to the seven tracking issues above; three
more (A5, D6, I3) hang on open decisions D1, D3 and D5 until those decisions turn
them into filed work. The decision rows (D1–D7) are visible, named, and none is
hidden inside a partial row.

[issue #200]: https://github.com/ecoma-io/release-craft/issues/200
[self-dogfood PR #141]: https://github.com/ecoma-io/release-craft/pull/141
[#191]: https://github.com/ecoma-io/release-craft/issues/191
[#182]: https://github.com/ecoma-io/release-craft/issues/182
[#196]: https://github.com/ecoma-io/release-craft/issues/196
[#194]: https://github.com/ecoma-io/release-craft/issues/194
[#193]: https://github.com/ecoma-io/release-craft/issues/193
[#195]: https://github.com/ecoma-io/release-craft/issues/195
[#199]: https://github.com/ecoma-io/release-craft/issues/199
[#202]: https://github.com/ecoma-io/release-craft/issues/202
[#203]: https://github.com/ecoma-io/release-craft/issues/203
[#204]: https://github.com/ecoma-io/release-craft/issues/204
[#205]: https://github.com/ecoma-io/release-craft/issues/205
[#206]: https://github.com/ecoma-io/release-craft/issues/206
[#207]: https://github.com/ecoma-io/release-craft/issues/207
[#208]: https://github.com/ecoma-io/release-craft/issues/208
[decide.test.ts]: ../../test/planner/decide.test.ts
[assemble.test.ts]: ../../test/planner/assemble.test.ts
[kernel version.test.ts]: ../../test/version.test.ts
[extract.adversarial.test.ts]: ../../test/planner/extract.adversarial.test.ts
[plan.test.ts]: ../../test/planner/plan.test.ts
[input.test.ts]: ../../test/planner/input.test.ts
[line-policy.test.ts]: ../../test/planner/line-policy.test.ts
[identity.test.ts]: ../../test/planner/identity.test.ts
[identity.ts]: ../../src/planner/identity.ts
[version.test.ts]: ../../test/version.test.ts
[channels.test.ts]: ../../test/planner/channels.test.ts
[plan.golden.test.ts]: ../../test/planner/plan.golden.test.ts
[maintenance-decisions.test.ts]: ../../test/planner/maintenance-decisions.test.ts
[version-collision.test.ts]: ../../test/planner/version-collision.test.ts
[propagate.test.ts]: ../../test/planner/propagate.test.ts
[types.ts]: ../../src/planner/types.ts
[plan.ts]: ../../src/planner/plan.ts
[hooks.test.ts]: ../../test/execution/hooks.test.ts
[artifacts.test.ts]: ../../test/execution/artifacts.test.ts
[history.test.ts]: ../../test/planner/history.test.ts
[input.ts]: ../../src/planner/input.ts
[publication.ts]: ../../src/adapters/github/publication.ts
[publication.test.ts]: ../../test/adapters/github/publication.test.ts
[adapter.ts]: ../../src/adapters/github/adapter.ts
[certification/git.test.ts]: ../../test/certification/git.test.ts
[github-vertical.test.ts]: ../../test/vertical/github-vertical.test.ts
[claims-mint.test.ts]: ../../test/adapters/git/claims-mint.test.ts
[world.test.ts]: ../../test/dogfood/world.test.ts
[state.test.ts]: ../../test/planner/state.test.ts
[planner isolation.test.ts]: ../../test/planner/isolation.test.ts
[resume.test.ts]: ../../test/execution/resume.test.ts
[abort-supersede.test.ts]: ../../test/execution/abort-supersede.test.ts
[abandonment-record.test.ts]: ../../test/execution/abandonment-record.test.ts
[metadata.test.ts]: ../../test/action/metadata.test.ts
[invocation.test.ts]: ../../test/action/invocation.test.ts
[remote-git.ts]: ../../src/adapters/github/remote-git.ts
[execution isolation.test.ts]: ../../test/execution/isolation.test.ts
[no-mutation-before-claim.test.ts]: ../../test/execution/no-mutation-before-claim.test.ts
[resume.test.ts (execution)]: ../../test/execution/resume.test.ts
[resume.test.ts (app)]: ../../test/app/resume.test.ts
[reconciliation.test.ts]: ../../test/adapters/github/reconciliation.test.ts
[reconciliation.ts]: ../../src/adapters/github/reconciliation.ts
[concurrency.test.ts]: ../../test/execution/concurrency.test.ts
[namespace-boundary.test.ts]: ../../test/adapters/git/namespace-boundary.test.ts
[modules.test.ts]: ../../test/cli/modules.test.ts
[scenario map]: ../design/matrix-coverage.md
