# Release scenarios — the adversarial matrix

> **Status: Phase 0 design asset (task 0D, issue #13).** This is the
> reconciled master of the three Phase 0 lens proposals. It replaces the
> staging files on `johnitvn/phase0-scn-a`
> (`docs/design/_proposals/scenarios-lens-a.md`), `johnitvn/phase0-scn-b`
> (`scenarios-lens-b.md`) and `johnitvn/phase0-scn-c`
> (`scenarios-lens-c.md`): 59 proposed scenarios, 53 retained — six
> cross-lens near-duplicate pairs merged (lineage noted per scenario), zero
> scenarios dropped silently. Nothing here describes implemented behavior;
> the only domain object that exists today is the `Version` value
> ([ADR-0001](../adr/0001-domain-kernel-and-semantic-version.md)). Companion
> Phase 0 documents: the process taxonomy on `johnitvn/phase0-taxonomy`
> (`docs/design/release-taxonomy.md`, the vocabulary lock) and the
> release-please behavioral baseline on `johnitvn/phase0-rp`
> (`docs/design/release-please-baseline.md`).

## How to read this matrix

Each scenario is a concrete situation a naive release model answers wrongly
or cannot represent at all. States and inputs are stipulated; only the
SemVer arithmetic and commit semantics are spec-bound (Semantic Versioning
2.0.0, Conventional Commits v1.0.0). Six naive assumptions recur; scenario
bodies name them as N1–N6:

| Code | Naive assumption                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| N1   | The branch a release is cut from is the release line.                                                                                                              |
| N2   | Prerelease is a boolean, not a stream identity with per-stream numbering.                                                                                          |
| N3   | A release is one publication event: nothing exists between "decided" and "published" — no plan, no attempt, no partial failure, no decision that produces nothing. |
| N4   | The package manifest version is the source of truth for the next version.                                                                                          |
| N5   | "Released" is a boolean status field on a version.                                                                                                                 |
| N6   | Version string equals artifact identity: whatever bytes carry version X are forever release X.                                                                     |

Conventions:

- Every scenario carries the same thirteen fields (Class through Abstraction
  under stress). Prose is compressed; no field was dropped in reconciliation.
- **Lineage:** scenarios merged from two proposals say so
  (`merged from X-nn + Y-nn`). Distinct-but-related scenarios cross-reference
  (`see S-01`); related stress was kept, not collapsed.
- Source proposal ids (A-nn, B-nn, C-nn) refer to the three staging files
  named in the status block.

## Canonical vocabulary

Inherited from the taxonomy's relationship lock (`release-taxonomy.md` §R1,
§R4, §R5). These terms are used with exactly these meanings in every scenario.

- **Release line** — a durable, ordered stream of versions advancing in
  release order, tracked across refs and time; has a head and a policy. Not
  a branch. Line 1.x may be fed by `main` and `release/1.9` at once.
- **Branch** — a git ref as a _source scoping device_: which candidate
  commits are on a line right now. An adapter, never the line's identity.
- **Channel** — a named, mutable deliverability pointer a consumer reads
  (`stable`, `next`, `nightly`, an npm dist-tag, a container tag). Channels
  move; their moves are recorded events.
- **Prerelease stream** — one prerelease identifier sequence (alpha, beta,
  rc) over one target version on a line: `1.2.0-alpha.0`, `1.2.0-alpha.1`, …
- **Version** — a SemVer 2.0.0 value as parsed by the kernel: bare (no `v`
  prefix), numeric prerelease comparison, structural equality (build
  metadata participates) distinct from precedence (ADR-0001).
- **Change** — the atomic unit of work with an identity stable across lines
  (survives cherry-picks); **change set** — the group of changes a release
  instantiates; **pending change set** — a line's changes not yet released.
- **Range** — the git commit interval scanned for candidate changes
  (line's last release tag to the line's head).
- **Release plan** — a persisted, invalidatable projection: target version,
  change set, base bindings, preconditions, policy digest. Version equality
  does not imply plan equality.
- **Release attempt** — one execution of a release plan; the idempotency key
  for every publication step. **Execution ledger** — the durable per-attempt
  record of step completion. **Claim** — atomic ownership of the next
  version on a line (ref CAS or lease) before any mutation.
- **Artifact** — one publishable output (kind, coordinates, content digest);
  **artifact generation** — the immutable artifact set bound to one release.
- **Promotion** — a user-visible state change of an existing release without
  new content: a channel pointer move (channel mutation) or a maturity
  reclassification such as rc → stable (release event, keeps a
  `promoted-from` edge).
- **Released-version pointer** — per line, the latest released version.
- **Decision record** — a recorded no-op, refusal, block, or withholding
  with its cause; a negative decision is still a decision.
- **Evidence** — validation results bound to artifact content; freshness is
  part of its meaning.

## Terminology normalizations

The three proposals were written independently. These readings were
normalized; where a proposal's word survives, it is under the definition
above.

| From (proposals)                               | To (here)                                   | Note                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| "release branch" as the version trajectory (A) | **release line**; git ref = branch          | R1: branch is source scoping, never the line.                                                                                                   |
| `changeset` (A), `pending set` (B)             | **change set**, **pending change set**      | R4 granularity lock.                                                                                                                            |
| `v`-prefixed tags, `v1.2.0` (A throughout)     | bare `1.2.0`                                | Kernel refuses `v` prefixes (ADR-0001 decision 4); the `v` spelling survives only where a hand-pushed foreign tag is itself the anomaly (E-06). |
| "the `rc` prerelease channel" (B-08)           | prerelease stream `rc` on the line          | Channel is reserved for deliverability pointers.                                                                                                |
| `dist-tag`, `floating tag` (C)                 | **registry channel** (npm/container-backed) | A channel binding at a backend.                                                                                                                 |
| "attempt" (A-13, A-19), "Release attempt" (C)  | **release attempt**                         | Same concept, one name.                                                                                                                         |
| `plan P1` (A), `plan` (B, C)                   | **release plan**                            | Persisted and invalidatable in all three lenses.                                                                                                |
| "generation" (A-16), "artifact descriptor" (C) | **artifact generation** / **artifact**      | Both retained: the set, and one output in it.                                                                                                   |
| "rollback", "retraction" (A-18, A-20)          | promotion events (negative direction)       | R5: channel mutations with event records, never deletions.                                                                                      |
| "promote rc.1 to stable 1.2.0" (A-09, A-15)    | promotion as release event                  | Maturity reclassification; `promoted-from` edge recorded.                                                                                       |
| "no-op" (A-01, B-20, C-12)                     | **no-op decision (recorded)**               | Distinguishable from "the tool did nothing".                                                                                                    |
| "released-pointer" (B)                         | **released-version pointer**                | Per line.                                                                                                                                       |
| "evidence" (A-17), "validation" (C)            | **evidence**                                | Validation results bound to content, with freshness.                                                                                            |

## Scenario index

53 scenarios. Sources column gives the originating proposal id(s).

| ID    | Title                                                      | Class      | Sources     | Abstraction under stress                                 |
| ----- | ---------------------------------------------------------- | ---------- | ----------- | -------------------------------------------------------- |
| S-01  | Chore-only runway: the recorded no-op                      | SIMPLE     | A-01        | A decision that produces nothing is still an event (N3)  |
| S-02  | First release ever: two absent truths                      | SIMPLE     | A-02        | Bootstrap is underdetermined; manifest is not truth (N4) |
| S-03  | Manifest drift: the hotfixes that never came home          | SIMPLE     | A-03        | Line tag history outranks the manifest (N1, N4)          |
| S-04  | Release-worthy without changelog-worthy                    | SIMPLE     | A-05        | Release-worthy and changelog-worthy are independent (N5) |
| S-05  | Major cut while the maintenance line lives                 | SIMPLE     | A-06        | Line identity survives the major cut (N1)                |
| P-01  | Alpha increments: lexicographic order lies                 | PRERELEASE | A-07        | Numeric prerelease comparison (N2)                       |
| P-02  | Same target, three costumes: alpha → beta → rc             | PRERELEASE | A-08        | Ordered stream ladder; reset per identifier (N2)         |
| P-03  | RC to stable across a zero diff                            | PRERELEASE | A-09        | Promotion with an inherited change set (N3, N5)          |
| P-04  | Feat mid-RC: the boolean breaks                            | PRERELEASE | A-10        | Sequence bump, not state flip (N2)                       |
| P-05  | Breaking mid-RC: the target moves under you                | PRERELEASE | A-11        | Target is a derived, invalidatable projection (N2, N4)   |
| P-06  | Two streams, one target                                    | PRERELEASE | A-12        | Stream-keyed state, not one pointer (N2)                 |
| P-07  | RC-first on the maintenance line, under a 2.x main         | PRERELEASE | A-14        | Line-scoped prerelease computation (N1)                  |
| M-01  | A fix on the maintenance line is not a main commit         | MULTI-LINE | B-01        | Attribution by ancestry, never by default line           |
| M-02  | Three active lines release independently                   | MULTI-LINE | B-02        | No global next-version pointer                           |
| M-03  | One logical fix on three lines: cherry-pick vs propagate   | MULTI-LINE | B-03        | Change identity ≠ SHA ≠ content hash                     |
| M-04  | Clean backport: main must not move                         | MULTI-LINE | B-04        | Releasedness is per (line, change) (N5)                  |
| M-05  | Conflicting backport: same change, divergent payloads      | MULTI-LINE | B-05        | Lineage survives content divergence                      |
| M-06  | Backport of an already-released change                     | MULTI-LINE | B-06        | Version space per line; releasedness per line            |
| M-07  | Divergent maintenance line: commits main never had         | MULTI-LINE | B-07        | Ranges computed from the line's own tags                 |
| M-08  | Per-line policies: prerelease here, forbidden there        | MULTI-LINE | B-08        | Policy resolved per line (kernel/policy seam)            |
| M-09  | Fix released on maintenance before main receives it        | MULTI-LINE | B-09        | Version ordering implies nothing about content           |
| M-10  | Line renamed or retired                                    | MULTI-LINE | B-10        | Line identity ≠ ref name; retirement ≠ deletion          |
| M-11  | Same version number on two lines                           | MULTI-LINE | B-11        | Per-line versions, global tag namespace                  |
| PL-01 | Monorepo: one package changed, one package released        | PLANNING   | B-12        | Repo ≠ package; attribution is a total mapping           |
| PL-02 | Dependency propagation: the changed package has dependents | PLANNING   | B-13        | Range math, not messages alone                           |
| PL-03 | Unrelated isolation: neighbors must not move               | PLANNING   | B-14        | Non-impact must be demonstrable                          |
| PL-04 | The release PR's own output is not a change                | PLANNING   | B-15        | The planner's outputs are not foreign input              |
| PL-05 | Ambiguous commits: scope clash, breaking chore, merge      | PLANNING   | B-19        | Attribution is not total, unambiguous, or filter-proof   |
| PL-06 | Empty change set: every commit ignored by policy           | PLANNING   | B-20        | A no-op is a result, not an error                        |
| PL-07 | Change withheld by the line's package policy               | PLANNING   | B-21        | Filtering is deferral, never deletion                    |
| PL-08 | Stale release plan: the change set grew mid-flight         | PLANNING   | A-04 + B-16 | Plans are first-class and content-sensitive (N3)         |
| AR-01 | One release, three artifacts, all succeed                  | ARTIFACTS  | C-01        | A release is a bundle of stateful artifact ops           |
| AR-02 | Image depends on npm; registry propagation delay           | ARTIFACTS  | C-02        | Published ≠ immediately visible                          |
| AR-03 | Artifact version scheme differs from release version       | ARTIFACTS  | C-04        | Identity is the digest; coordinates are labels (N6)      |
| AR-04 | Nightly and stable from the same commit                    | ARTIFACTS  | C-06        | Version is f(commit, line, channel policy)               |
| AR-05 | Orphan artifact: published but unattributed                | ARTIFACTS  | C-07        | Existence is observed; attribution is recorded           |
| AR-06 | GitHub Release draft with stale notes                      | ARTIFACTS  | C-08        | Artifacts have intermediate states                       |
| E-01  | Crash after the tag push: half a release                   | EXECUTION  | A-13 + C-09 | Tag existence maps to ledger state, not error (N3)       |
| E-02  | Amputated mid-publication: resume the ledger               | EXECUTION  | A-19 + C-03 | Per-step idempotency and done-vs-conflict (N3)           |
| E-03  | The tag appeared: replay, satisfaction, conflict           | EXECUTION  | B-18 + C-12 | Idempotent replay of declarative intent                  |
| E-04  | Policy flips under a stored plan                           | EXECUTION  | B-17 + C-16 | Preconditions re-verified; verdicts never cached         |
| E-05  | Retry must reproduce the same plan (time is an input)      | EXECUTION  | C-10        | Plan purity: enumerated inputs, no clock reads           |
| E-06  | The foreign tag: resume-by-inference trap                  | EXECUTION  | C-11        | Attribution beats observation                            |
| E-07  | Two CI jobs release the same line concurrently             | EXECUTION  | C-13        | Claim before mutation; first writer wins                 |
| E-08  | Two runs compute the same rc number                        | EXECUTION  | C-14        | Allocation is a race-safe protocol                       |
| E-09  | Human intervention: abort, PR edit, force-push             | EXECUTION  | C-15        | Sometimes the correct continuation is stopping           |
| E-10  | Clock and ordering anomalies                               | EXECUTION  | C-17        | Ordering by topology, never by wall clock                |
| E-11  | Plan from stale state: hotfix interleave                   | EXECUTION  | C-18        | Same version number ≠ same release                       |
| PR-01 | Promote without rebuild: the bytes are the contract        | PROMOTION  | A-15        | Version is an assertion over immutable bytes (N6)        |
| PR-02 | Promote with rebuild: two bodies, one version name         | PROMOTION  | A-16        | Generations are tracked, never overwritten (N6)          |
| PR-03 | Stale evidence: promotion must re-prove                    | PROMOTION  | A-17        | "Validated" is a state with a clock                      |
| PR-04 | Backward channel move: rollback as a recorded event        | PROMOTION  | A-18 + C-05 | Channels move backwards, audited, CAS-guarded            |
| PR-05 | One release, many channels, over time                      | PROMOTION  | A-20        | Membership is a graph with a timeline (N5)               |

## The scenarios

### SIMPLE

#### S-01 — Chore-only runway: the recorded no-op

- **Lineage:** overlaps PL-06 (planner-side empty change set); kept separate
  because S-01 owns the operator-override refusal, PL-06 owns range-cursor
  semantics. See also E-03 for the replayed-completed-release no-op.
- **Class:** SIMPLE (patch-shaped, degenerate).
- **Initial state:** branch `main` only; tags `1.0.0`, `1.0.1`; manifest
  version `1.0.1`; no open release PRs.
- **Inputs:** three merges since `1.0.1`: `chore: bump devdep floor`,
  `docs: fix typo in quickstart`, `ci: cache the store directory`. Operator
  intent: "cut whatever is due."
- **Intended outcome:** the tool decides there is nothing to release and
  records that decision with its cause; "nothing happened" is
  distinguishable from "the tool is broken."
- **Expected release decision:** no release, no plan, no release PR; a
  decision record `no-op, cause: no release-worthy changes` (chore/docs/ci
  are not release-triggering by default — an open policy fork).
- **Expected versions:** manifest stays `1.0.1`; the latent `1.0.2` is
  minted nowhere.
- **Affected release lines:** none; line 1.x head remains `1.0.1`.
- **Expected artifacts:** none — no empty changelog section, no empty PR.
- **Expected transitions:** none; the decision record is the only state
  change.
- **Expected failure behavior:** with operator override ("release anyway"),
  the tool refuses by default; if policy allows an override it is recorded
  as operator-forced, never as a routine release. Contradictory input
  (chore-only history plus "release 1.0.2 now") surfaces the conflict.
- **Identity requirements:** the no-op decision has an identity binding the
  evaluated range (`1.0.1..HEAD`), the commit list, and the policy version
  that excluded them.
- **State requirements:** decision log entry (range, cause, policy version);
  whether it is persisted or a reproducible computation over tags and
  commits is an open fork.
- **Abstraction under stress:** N3 — a model where only publications are
  events cannot represent a decision whose entire output is a record.

#### S-02 — First release ever: two absent truths

- **Class:** SIMPLE (bootstrap).
- **Initial state:** branch `main` only; zero tags; no changelog; manifest
  `0.0.0`; history: `feat: core loop`, `feat: cli scaffold`,
  `fix: parser edge case`, plus chores.
- **Inputs:** operator intent: "make the first release." No initial-version
  policy configured.
- **Intended outcome:** the tool recognizes bootstrap is underdetermined —
  no "since last tag" range, no trustworthy manifest — and demands an
  explicit initial-version decision instead of guessing.
- **Expected release decision:** release (the first), gated on a recorded
  bootstrap decision; the release plan targets the chosen version over the
  whole history as change set (bounded by repository start, not a tag).
- **Expected versions:** `1.0.0` (stable-first API) or `0.1.0`
  (initial-development ramp; SemVer FAQ names both) — either is valid,
  silently derived is not. Manifest `0.0.0` never leaks as the release
  version.
- **Affected release lines:** the main line is created at the chosen major.
- **Expected artifacts:** initial changelog (epoch section), tag (`1.0.0` or
  `0.1.0`), artifact set, stable channel set to it.
- **Expected transitions:** line born → planned → attempted → published;
  stable channel gains its first membership.
- **Expected failure behavior:** no policy plus operator refusal to choose →
  hard stop with a named decision required, not `0.0.1`. Contradiction
  (operator expects `3.2.0`, history has no breaking changes) → the
  mismatch is surfaced; the tool does not own this choice.
- **Identity requirements:** the bootstrap decision itself (version, who,
  when); the initial change set has an identity despite having no lower tag
  bound.
- **State requirements:** the line's birth version recorded so every later
  computation inherits it.
- **Abstraction under stress:** N4 — with both truth sources absent, a
  manifest-first tool publishes `0.0.1` and a tag-first tool crashes; the
  selection of truth must be explicit at bootstrap.

#### S-03 — Manifest drift: the hotfixes that never came home

- **Class:** SIMPLE (patch with history divergence).
- **Initial state:** `main` manifest at `1.9.0`; tags `1.9.0` (from main)
  and `1.9.1`…`1.9.5` published from branch `release/1.9` (the hotfix
  line); the release PRs that would have bumped main's manifest were never
  merged; `main` is 6 commits ahead of `1.9.0`.
- **Inputs:** one merge on `main`: `fix: guard empty config`. Operator
  intent: "release the fix from main."
- **Intended outcome:** the tool selects the next version from the **line's
  tag history**, not the manifest: `1.9.6`; the manifest is a stale
  projection this release repairs.
- **Expected release decision:** release; patch on line 1.x; plan scoped to
  `1.9.5..HEAD` **on main** — hotfix commits inside `1.9.1`–`1.9.5` are
  already released and are not re-listed.
- **Expected versions:** `1.9.6`. Naive manifest-truth computes `1.9.1` —
  an existing tag: collision (re-tag refused) or the fix is never released.
- **Affected release lines:** line 1.x (head `1.9.5` → `1.9.6`); branch
  `release/1.9` unaffected.
- **Expected artifacts:** changelog section for 1.9.6 (the six main
  commits), tag `1.9.6`, artifacts; main's manifest updated to `1.9.6` as
  part of the release (drift closed, recorded).
- **Expected transitions:** plan (with a `manifest-repair` annotation) →
  attempt → published; drift flag cleared.
- **Expected failure behavior:** manifest `1.9.0` vs line head `1.9.5` is
  surfaced as drift **before** computing the version; operator insistence
  on the manifest is refused (tags are immutable facts, no downgrade). A
  racing second release sees `1.9.6` exists → re-plans `1.9.7`, never
  re-tags.
- **Identity requirements:** line identity distinct from branch identity
  (line 1.x is fed by `main` and `release/1.9`); per-line released range so
  hotfix commits are not double-counted.
- **State requirements:** per-line head pointer (derivable from tags) plus
  the recorded line→branch feed mapping; drift warning persists until the
  repair lands.
- **Abstraction under stress:** N1 + N4 — the version trajectory belongs to
  the line; the manifest is a projection, not a source of truth.

#### S-04 — Release-worthy without changelog-worthy

- **Class:** SIMPLE (patch with an empty changelog body).
- **Initial state:** tags through `1.0.4`; manifest `1.0.4`; config: scope
  `internal` is excluded from changelog notes.
- **Inputs:** two merges since `1.0.4`: `fix(internal): harden token
scrubbing`, `fix(internal): close race in session cache`. Operator
  intent: "release."
- **Intended outcome:** a release happens (`fix` is release-worthy) and its
  changelog section is deliberately empty of notes — recorded as an
  explicit outcome, not an accident.
- **Expected release decision:** release; patch on line 1.x.
- **Expected versions:** `1.0.5` (Conventional Commits: `fix` → patch). The
  bump-driving classification and the note-producing classification are
  independent; conflating them either skips the release or fabricates
  notes.
- **Affected release lines:** line 1.x on `main`.
- **Expected artifacts:** tag `1.0.5`; a changelog section titled for 1.0.5
  with an explicit "no user-facing notes" marker (or the commit list
  without prose); artifacts.
- **Expected transitions:** planned → attempted → published, with the
  empty-notes fact in the decision record.
- **Expected failure behavior:** if config also excludes the **bump** for
  scope `internal`, this collapses into S-01 — the two exclusions are
  distinct knobs that must not merge. Silent empty sections (no marker, no
  record) are a defect.
- **Identity requirements:** the release record carries both
  classifications per change (bump-relevant? note-relevant?).
- **State requirements:** changelog section existence plus emptiness marker
  persisted; the decision record names the exclusion config version used.
- **Abstraction under stress:** N5-adjacent — "a release with nothing to
  say" is a legitimate state that string-concatenation changelog models
  cannot represent without lying.

#### S-05 — Major cut while the maintenance line lives

- **Class:** SIMPLE (major with a surviving past).
- **Initial state:** `main` at manifest `1.9.0`; tags through `1.9.5`;
  branch `release/1.9` alive with an open backport (`fix: backport safe
default`) not yet released.
- **Inputs:** merge on `main`: `feat!: require config schema v2`
  (breaking). Operator intent: "cut 2.0.0 from main."
- **Intended outcome:** `2.0.0` is released from main **and** line 1.x
  stays releasable (`1.9.6` from `release/1.9` afterwards).
- **Expected release decision:** release; major on the new line 2.x; no
  interference with line 1.x.
- **Expected versions:** `2.0.0` (breaking → major; minor and patch reset).
  Two live lines whose tags interleave in time: `2.0.0`, then later
  `1.9.6` — global tag order is not version order.
- **Affected release lines:** line 2.x (created); line 1.x (open,
  untouched).
- **Expected artifacts:** tag `2.0.0`, changelog with an upgrade-guide
  section (breaking changes listed), artifacts; main's manifest → `2.0.0`.
- **Expected transitions:** line 1.x: active (maintenance posture); line
  2.x: created → active; both compute "next version" independently.
- **Expected failure behavior:** a single global "next version" pointer now
  computes either `2.0.1` or `1.9.6` — wrong for one line each time. When
  `1.9.6` is later tagged, no state may treat it as "older than published
  2.0.0" in a way that blocks it; line membership, not global recency,
  governs release order.
- **Identity requirements:** line identity (1.x vs 2.x) keys every
  next-version computation; release records keyed by line + version.
- **State requirements:** a line registry recording both lines, their feed
  branches, and their heads.
- **Abstraction under stress:** N1 — after a major, "the branch I release
  from" is no longer one branch; line identity must survive the cut.

### PRERELEASE

#### P-01 — Alpha increments: lexicographic order lies

- **Class:** PRERELEASE (sequence across consecutive runs).
- **Initial state:** `main`; tags include `1.2.0-alpha.9` (nine alpha runs
  of the upcoming 1.2.0 already published); manifest `1.1.7`.
- **Inputs:** one merge: `fix: retry idempotency keys`. Operator intent:
  "continue the alpha stream."
- **Intended outcome:** publish `1.2.0-alpha.10` — the numeric increment of
  the stream head, compared numerically (SemVer §11.4: `beta.2 < beta.11`).
- **Expected release decision:** release; prerelease on line 1.x, stream
  `alpha`, same target 1.2.0.
- **Expected versions:** `1.2.0-alpha.10`. A string-sorting tool reads head
  `alpha.9 > alpha.10` and re-publishes `alpha.9`, colliding with the
  existing tag. The kernel half of this trap (numeric comparison,
  safe-integer bounds) is already owned by ADR-0001.
- **Affected release lines:** line 1.x on `main`, prerelease stream
  `alpha`.
- **Expected artifacts:** tag `1.2.0-alpha.10`; prerelease-marked changelog
  section (the one fix); artifacts labeled with the full version string.
- **Expected transitions:** stream `alpha` head: `alpha.9` → `alpha.10`;
  target unchanged.
- **Expected failure behavior:** tag `1.2.0-alpha.10` already exists (a
  hand-pushed tag) → next is `alpha.11`, never a silent re-tag; the
  anomaly is recorded. Stream head unknown (tags deleted) → recompute by
  SemVer precedence over all `1.2.0-alpha.*` tags — never lexicographic,
  never manifest.
- **Identity requirements:** stream identity = (line, target, identifier);
  sequence position survives restarts (derivable from tags).
- **State requirements:** no extra ledger strictly required if tags are
  authoritative and precedence-correct; release attempt ids still required
  per publication (see E-01 for why).
- **Abstraction under stress:** N2 — a boolean prerelease flag has no place
  to store "which alpha is next," and naive ordering breaks exactly at 10.

#### P-02 — Same target, three costumes: alpha → beta → rc

- **Class:** PRERELEASE (stream transitions; ladder).
- **Initial state:** `main`; `1.2.0-alpha.3` published.
- **Inputs:** operator intent, no new commits: "move stabilization to
  beta," then later "promote to rc."
- **Intended outcome:** stream transitions mint a fresh sequence on the new
  identifier: `1.2.0-beta.0`, then `1.2.0-rc.0`. SemVer §11.4.2 (ASCII
  order: `alpha < beta < rc`) makes each step a forward jump despite the
  reset: `beta.0 > alpha.3`.
- **Expected release decision:** release (prerelease re-stream); the change
  set is identical to the alpha run's — a publication without content
  change, represented deliberately.
- **Expected versions:** `1.2.0-beta.0`, then `1.2.0-rc.0`; resetting the
  number per identifier is spec-consistent because the identifier dominates
  precedence.
- **Affected release lines:** line 1.x on `main`; the stream ladder
  alpha → beta → rc (fixed, ordered ladder; arbitrary identifiers are an
  open fork).
- **Expected artifacts:** one tag plus artifact set per publication;
  changelog entries marked with the stream they belonged to.
- **Expected transitions:** stream `alpha`: completed; stream `beta`:
  opened → completed; stream `rc`: opened. Prior streams are never deleted.
- **Expected failure behavior:** operator asks for beta while `rc.1` is
  already live → refused by default (a new `beta.0` sorts below `rc.1`,
  silently regressing the ladder); override requires a recorded operator
  decision. Naive "identifier is just a string" allows the regression.
- **Identity requirements:** publication identity even with zero content
  change; the content ↔ publications mapping (`alpha.3` and `beta.0`
  instantiate the same source commit) is queryable.
- **State requirements:** current stream pointer per line; per-stream
  lifecycle state (open/completed).
- **Abstraction under stress:** N2 — the prerelease identifier is an
  ordered stream key with per-key numbering; the ladder's order is what
  makes "downgrade" definable.

#### P-03 — RC to stable across a zero diff

- **Class:** PRERELEASE (RC → stable).
- **Initial state:** `main`; `1.2.0-rc.1` published at C1; no commits
  after C1.
- **Inputs:** operator intent: "promote rc.1 to stable" / "release 1.2.0."
- **Intended outcome:** publish stable `1.2.0` at C1 with the **same change
  set** as rc.1 — skipping would deadlock the promotion forever, because
  "no changes since the last tag" is exactly what a finished RC looks like.
- **Expected release decision:** release (stable) with an inherited change
  set; explicitly not a no-op despite the empty diff.
- **Expected versions:** `1.2.0` (SemVer §11.3: `1.2.0-rc.1 < 1.2.0`).
- **Affected release lines:** line 1.x on `main`; stream `rc` closes.
- **Expected artifacts:** tag `1.2.0`; a canonical stable changelog section
  (rc's section preserved and marked; one section per published version);
  artifact set for stable.
- **Expected transitions:** stream `rc`: completed; release 1.2.0:
  published; stable channel membership created; `promoted-from: 1.2.0-rc.1`
  edge recorded.
- **Expected failure behavior:** a commit (`fix: …`) lands after rc.1 and
  the operator still says "promote as-is" → contradiction: strict policy
  forces `rc.2` first, because stable must contain exactly what was
  validated. The tool states the impossibility; it never silently absorbs
  the fix into the promotion.
- **Identity requirements:** the rc.1 ↔ stable 1.2.0 equivalence is
  auditable (same change set id, same source commit) — this edge is the
  promotion's entire justification.
- **State requirements:** rc → stable promotion edge recorded; rc stream
  state completed, content preserved.
- **Abstraction under stress:** N3 + N5 — "release = diff since last tag"
  and a boolean released-flag both make the most common prerelease ending
  unrepresentable.

#### P-04 — Feat mid-RC: the boolean breaks

- **Class:** PRERELEASE (feat landing mid-RC).
- **Initial state:** `main`; `1.2.0-rc.1` at C1.
- **Inputs:** one merge: `feat: add webhook retries` (C2). Operator intent:
  "next RC."
- **Intended outcome:** publish `1.2.0-rc.2` — same target 1.2.0, sequence
  +1, the feat listed in rc.2's incremental changelog.
- **Expected release decision:** release; prerelease, stream `rc`, line
  1.x.
- **Expected versions:** `1.2.0-rc.2`. Both naive outcomes are wrong:
  "not a prerelease anymore → publish 1.2.0" ships an unreviewed feature
  inside the reviewed version; "restart at rc.0" produces a version that
  sorts below the live `rc.1` (identical cores: `rc.0 < rc.1`) and
  inverts history.
- **Affected release lines:** line 1.x on `main`, stream `rc`.
- **Expected artifacts:** tag `1.2.0-rc.2`; changelog: an rc.2 section with
  the feat (the cumulative stable changelog folds all rc increments only
  at stable time).
- **Expected transitions:** stream `rc` head → `rc.2`; target unchanged;
  the release plan for 1.2.0 updated to include C2.
- **Expected failure behavior:** operator demands "rebuild rc.1 with the
  feat" → refused: published versions are immutable (SemVer rule 3); the
  only path is a new sequence entry. Tag `1.2.0-rc.2` exists already →
  `rc.3`.
- **Identity requirements:** per-stream sequence state; the change-set
  delta C1..C2 attributed to rc.2's increment.
- **State requirements:** rc.2's changelog increment persisted; the plan's
  change set grows (the plan stays consistent with reality).
- **Abstraction under stress:** N2 — "prerelease" as a property of the
  version cannot express "the same upcoming version, later in its
  sequence."

#### P-05 — Breaking mid-RC: the target moves under you

- **Class:** PRERELEASE (breaking change landing mid-RC).
- **Initial state:** `main`; `1.2.0-rc.1` published (target 1.2.0).
- **Inputs:** one merge: `feat!: rename the config schema` (breaking).
  Operator intent: "continue stabilization."
- **Intended outcome:** the upcoming target recomputes to 2.0.0; the next
  prerelease is `2.0.0-rc.0` (keep the current stream identifier, reset
  the sequence — deterministic; restarting the ladder at `alpha.0` is the
  alternative and must be chosen explicitly). The `1.2.0-rc.*` sequence
  becomes **abandoned**: never stabilized, never deleted.
- **Expected release decision:** release; prerelease on the new target;
  supersession record for the abandoned 1.2.0 target.
- **Expected versions:** `2.0.0-rc.0`. Any `2.0.0-*` outranks all
  `1.2.0-*` by core comparison, so history never inverts.
- **Affected release lines:** line 1.x's in-flight target is replaced by
  line 2.x (trajectory re-key); no stable release affected.
- **Expected artifacts:** tag `2.0.0-rc.0`; changelog: the breaking change
  called out in the prerelease section; the abandoned rc.1 stays
  resolvable with a `superseded-by: target-move` annotation.
- **Expected transitions:** target(1.2.0) → superseded (cause: breaking
  commit C2); stream `rc` re-based on 2.0.0; published rc.1 keeps
  lifecycle state `orphaned-prerelease`, resolvable forever.
- **Expected failure behavior:** operator insists on finishing 1.2.0 → the
  tool cannot; the breaking commit must be reverted (a content decision
  outside tool authority) and the tool says so. Every plan still targeting
  1.2.0 is invalidated (see PL-08's mechanics); none silently survives.
- **Identity requirements:** the target version is a mutable plan property;
  the invalidation event has an identity binding cause (commit), old
  target, new target.
- **State requirements:** the supersession edge (1.2.0-rc.1 → abandoned) is
  durable; the recompute event is recorded with the breaking commit as
  evidence.
- **Abstraction under stress:** N2 + N4 — "next version" is a derived,
  invalidatable projection; a tool that stored it as a fixed invariant now
  plans a 1.2.0 that must never exist.

#### P-06 — Two streams, one target

- **Class:** PRERELEASE (multiple concurrent prerelease streams).
- **Initial state:** `main`; both `1.2.0-alpha.4` and `1.2.0-rc.1`
  published (alpha = exploratory builds, rc = stabilization builds).
- **Inputs:** one merge: `fix: race in the scheduler`. Operator intent:
  "advance rc only."
- **Intended outcome:** publish `1.2.0-rc.2`; the alpha stream is untouched
  (head stays `alpha.4`); the rc changelog increment lists the fix.
- **Expected release decision:** release; **targeted** prerelease on
  stream `rc` of line 1.x.
- **Expected versions:** `1.2.0-rc.2` only. A single "next version"
  pointer bumps the wrong stream, bumps both, or errors on ambiguity — all
  unacceptable.
- **Affected release lines:** line 1.x, stream `rc`; stream `alpha`
  paused.
- **Expected artifacts:** tag `1.2.0-rc.2`; rc-increment changelog; alpha
  artifacts unchanged.
- **Expected transitions:** stream `rc` head → `rc.2`; `alpha` untouched.
- **Expected failure behavior:** operator omits the stream → ambiguity
  error **listing the live streams** (never a guess). Adversarial
  extension: a breaking commit lands while both streams are live → the
  target moves to 2.0.0 (P-05); alpha may no longer mint
  `1.2.0-alpha.5` — both streams collapse onto the new target, and the
  tool must detect and report the collapse, not strand one stream on a
  dead target.
- **Identity requirements:** per-stream heads plus one shared line target;
  the stream label is part of publication identity.
- **State requirements:** a per-line stream table (label → head version,
  base commit, lifecycle state).
- **Abstraction under stress:** N2 — concurrent instantiation sequences of
  one target require stream-keyed state; a single prerelease pointer is
  structurally wrong.

#### P-07 — RC-first on the maintenance line, under a 2.x main

- **Class:** PRERELEASE (prerelease on a maintenance line).
- **Initial state:** `main` at `2.1.0` (manifest 2.1.0); branch
  `release/1.2` at `1.2.3`; policy: maintenance fixes ride an RC before
  stable.
- **Inputs:** on `release/1.2`: `fix: backport safe default`. Operator
  intent: "release it as an RC first, from the maintenance line."
- **Intended outcome:** publish `1.2.4-rc.0` **from `release/1.2`**; main
  and line 2.x untouched.
- **Expected release decision:** release; prerelease on line 1.x, fed by
  branch `release/1.2` — branch and line are distinct (N1).
- **Expected versions:** `1.2.4-rc.0`. A global-pointer tool computes
  `2.1.1-rc.0` (wrong line, wrong base) or `1.2.4` directly (skips the
  policy-mandated RC).
- **Affected release lines:** line 1.x (stream `rc` opened); line 2.x
  unaffected.
- **Expected artifacts:** tag `1.2.4-rc.0`; a maintenance changelog
  section; artifacts (full version in artifact names already disambiguates
  two live lines).
- **Expected transitions:** line 1.x stream `rc` opened; if validated,
  later `1.2.4` stable via P-03 mechanics.
- **Expected failure behavior:** the same patch is later backported to
  `main` → `2.1.1`'s changelog must reference the maintenance release
  (same content, two line-scoped release records); a global change-set
  dedup would drop one side. If `release/1.2` accidentally receives the
  breaking commit, the tool refuses to mint `1.2.x` from it — a patch line
  cannot jump its own major.
- **Identity requirements:** line-scoped next-version derivations (two
  coexist); a cross-line provenance edge for the backport (release record ↔
  release record).
- **State requirements:** per-line heads and stream tables; the provenance
  edge persisted with the later release.
- **Abstraction under stress:** N1 — with two live lines, every version
  computation is line-scoped or wrong; S-05 continued into the prerelease
  class.

### MULTI-LINE

#### M-01 — A fix on the maintenance line is not a main commit

- **Class:** MULTI-LINE (main + one maintenance branch).
- **Initial state:** branch `main` at C3 (released `2.3.0`, tag `2.3.0`);
  branch `1.9` at C9 (released `1.9.0`, tag `1.9.0`). Commit F
  (`fix(parser): handle empty input`) is pushed to `1.9` only.
- **Inputs:** a plan request for the repository with no explicit line
  argument; the two branches and their tags.
- **Intended outcome:** the planner discovers both lines, attributes F to
  the `1.9` line by ancestry, and plans a maintenance-only release.
- **Expected release decision:** release line `1.9`; `main` has an empty
  effective change set and is a no-op (see PL-06).
- **Expected versions:** `1.9.0` → `1.9.1`; `main` remains `2.3.0`.
- **Affected release lines:** `1.9`.
- **Expected artifacts:** a release PR for line `1.9`; tag `1.9.1` at the
  release commit; a changelog section under `1.9` listing F and nothing
  else.
- **Expected transitions:** the `1.9` released-version pointer moves
  `1.9.0` → `1.9.1`; F leaves the line's pending change set; `main` is
  untouched.
- **Expected failure behavior:** none on the happy path. If F is
  misattributed to `main` (scope collision or a default-line fallback),
  the engine must fail closed — refuse the plan — rather than silently
  produce `2.3.1` on `main` and strand the fix on `1.9`.
- **Identity requirements:** F is identified by its commit SHA within the
  `1.9` line's range; line attribution is by ancestry (the branch contains
  F), never by author date or message scope alone.
- **State requirements:** a per-line released-version pointer and head,
  plus a repository-level registry of which lines exist.
- **Abstraction under stress:** the single-line model where "the branch"
  is `main` and every pending commit implicitly targets it.

#### M-02 — Three active lines release independently

- **Class:** MULTI-LINE (main + multiple maintenance branches).
- **Initial state:** `main` released `2.3.0`; line `2.2` released `2.2.3`;
  line `1.9` released `1.9.0`. In one window: F1 (`fix:`) lands on `1.9`,
  F2 (`fix:`) on `2.2`, F3 (`feat:`) on `main`.
- **Inputs:** one plan request covering all lines; three commits; the
  three per-line tags.
- **Intended outcome:** three independent releases computed in one pass,
  each from its own line range.
- **Expected release decision:** release `1.9`, `2.2`, and `main`; no
  decision depends on or blocks another.
- **Expected versions:** `1.9.1` (fix), `2.2.4` (fix), `2.4.0` (feat).
- **Affected release lines:** `1.9`, `2.2`, `main`.
- **Expected artifacts:** three release PRs, three tags (`1.9.1`, `2.2.4`,
  `2.4.0`), three changelog sections, each listing only its line's
  commits.
- **Expected transitions:** three released-version pointers move
  independently; the three pending change sets drain independently.
- **Expected failure behavior:** a planner that computes a single global
  "next version" emits `2.4.0` once and drops two lines; each line's
  range must be evaluated separately, even when asked to plan once.
- **Identity requirements:** each commit belongs to exactly one line's
  release (by ancestry); no cross-line coupling in the bump computation.
- **State requirements:** per-line released-version pointers; a single
  repository-level "latest version" scalar must not be the source of
  truth.
- **Abstraction under stress:** the global version pointer — "next
  version" as a scalar instead of a per-line function. See also S-05.

#### M-03 — One logical fix on three lines: cherry-pick vs propagate

- **Class:** MULTI-LINE (one change, multiple lines, cherry-picked).
- **Initial state:** fix F authored on `main` (released `2.3.0`) is
  cherry-picked to `2.2` (as F′) and `1.9` (as F″). F′ and F″ have new
  SHAs and, on `1.9`, adapted content (a `main`-only API replaced by the
  local equivalent).
- **Inputs:** F, F′, F″; cherry-pick provenance (the
  `(cherry picked from commit …)` trailer or an equivalent change-id
  marker — an open fork); the three lines' tags.
- **Intended outcome:** all three lines release, each listing the same
  logical fix exactly once; later merges of the maintenance branches into
  `main` do not re-introduce the fix as pending.
- **Expected release decision:** release all three lines.
- **Expected versions:** `main` per its own pending change set; `2.2` →
  `2.2.4`; `1.9` → `1.9.1`.
- **Affected release lines:** `main`, `2.2`, `1.9`.
- **Expected artifacts:** three release PRs/tags; each changelog entry
  traceable to the same logical change id.
- **Expected transitions:** F, F′, F″ all leave their lines' pending
  change sets; the change's released-version set becomes
  `{<main's next>, 2.2.4, 1.9.1}`.
- **Expected failure behavior:** naive SHA identity triple-counts the fix
  when maintenance branches merge into `main` later; naive content-hash
  identity collapses F″ with F (different content) and loses the lineage.
  The engine must dedupe explicitly per lineage — never by either naive
  rule, never by fuzzy message matching.
- **Identity requirements:** change identity is a first-class concept
  distinct from both commit SHA and content hash; cherry-pick provenance
  is preserved and machine-readable.
- **State requirements:** a change → released-versions mapping (one
  change, many versions, many SHAs).
- **Abstraction under stress:** "commit = change" — the unit of release
  planning is not the unit of version control.

#### M-04 — Clean backport: main must not move

- **Class:** MULTI-LINE (backport, clean).
- **Initial state:** `main` released `2.3.0`; pending fix F on `main`
  (unreleased). Operator backports F to line `1.9` (released `1.9.0`) as a
  clean cherry-pick F′.
- **Inputs:** F and F′ with provenance; backport intent (implicit in the
  cherry-pick, or explicit in the request).
- **Intended outcome:** `1.9` releases the backport; `main`'s pending F is
  untouched and stays unreleased until main's own next release.
- **Expected release decision:** release `1.9` only; `main` unchanged (F
  remains pending).
- **Expected versions:** `1.9.0` → `1.9.1`; `main` remains `2.3.0` with F
  pending.
- **Affected release lines:** `1.9`.
- **Expected artifacts:** release PR and tag `1.9.1` on line `1.9`;
  changelog entry under `1.9` noting the backport lineage.
- **Expected transitions:** the `1.9` pending change set drains;
  `main`'s unchanged; the change's released-versions map records `1.9.1`
  only.
- **Expected failure behavior:** a planner that releases "everything
  pending anywhere" would cut an unrequested `main` release; a planner
  that marks F released because its backport shipped would silently drop
  F from `main`'s next release. Both must be impossible.
- **Identity requirements:** releasedness is evaluated per
  (line, change), never per change globally; F and F′ share lineage via
  provenance.
- **State requirements:** per-line released sets; cross-line lineage links
  that do not imply suppression.
- **Abstraction under stress:** releasedness as a global boolean per
  change (N5). See also M-06 and M-09 for the other two backport
  directions.

#### M-05 — Conflicting backport: same change, divergent payloads

- **Class:** MULTI-LINE (backport, conflicting).
- **Initial state:** fix F on `main` (released `2.3.0`) touches code
  refactored heavily since `1.9` branched. The cherry-pick to `1.9`
  conflicts; the maintainer hand-adapts, producing F′ with genuinely
  different content on `1.9` (released `1.9.0`).
- **Inputs:** F and F′ (different SHA, different patch) with provenance
  linking them; both lines' tags.
- **Intended outcome:** both lines release their side of the fix
  independently; the engine never requires content equality to treat F
  and F′ as one logical change.
- **Expected release decision:** release `1.9` (F′); `main` releases F
  with its own pending change set later.
- **Expected versions:** `1.9.1` for the backport; main's next per its own
  pending change set.
- **Affected release lines:** `1.9`, `main`.
- **Expected artifacts:** per-line release PRs/tags; changelog entries a
  reviewer can trace to the same logical fix despite different diffs.
- **Expected transitions:** both pending change sets drain independently;
  the lineage map records F ↔ F′.
- **Expected failure behavior:** patch-id identity breaks (different
  content); SHA identity breaks (different commits). The engine must
  either consume declared lineage or treat the two as
  unrelated-but-similar; fuzzy matching silently merges unrelated fixes
  and must be refused.
- **Identity requirements:** lineage survives content divergence; content
  equality is not required, and fuzzy matching is not a fallback.
- **State requirements:** a lineage graph allowing many-to-many relations
  between commits and changes across lines.
- **Abstraction under stress:** change identity = content, or change
  identity = SHA.

#### M-06 — Backport of an already-released change

- **Class:** MULTI-LINE (backport, already released upstream).
- **Initial state:** `main` released `2.3.0` containing fix F. Line `1.9`
  (released `1.9.0`) predates F; users of `1.9` need it. Operator
  backports F as F′ onto `1.9`.
- **Inputs:** F′ with provenance to the already-released F; both lines'
  tags.
- **Intended outcome:** the engine recognizes the change is released on
  `main` but **not** on `1.9`, and releases it there.
- **Expected release decision:** release `1.9`; no re-release or re-tag on
  `main`.
- **Expected versions:** `1.9.1` — allocated in `1.9`'s own version
  history; neither suppressed because F is released elsewhere, nor
  interacting with `2.3.0`.
- **Affected release lines:** `1.9`.
- **Expected artifacts:** release PR/tag `1.9.1`; changelog entry under
  `1.9` referencing the upstream release.
- **Expected transitions:** the change's released-versions map gains
  `1.9.1`; the `1.9` pending change set drains; `main` untouched.
- **Expected failure behavior:** the naive global rule
  "already-released → skip" leaves `1.x` users without the fix forever;
  the inverse (ignore release history) re-releases F on `main`. Both dead.
- **Identity requirements:** "released" is a predicate over
  (line, change); lineage is recorded for traceability but not used to
  suppress.
- **State requirements:** per-line released sets; version allocation
  strictly per line.
- **Abstraction under stress:** releasedness as global; version space as
  shared.

#### M-07 — Divergent maintenance line: commits main never had

- **Class:** MULTI-LINE (divergent maintenance branch).
- **Initial state:** line `1.9` (released `1.9.0`) carries D, a `feat:`
  commit shipping a capability that exists only on `1.x` (its `main`
  replacement landed differently), plus fix F1. `main` never received D;
  `main` is released `2.3.0` with an empty pending change set.
- **Inputs:** a plan request for `1.9`; the line's tag `1.9.0`; the branch
  head.
- **Intended outcome:** the engine releases `1.9` including D and F1,
  discovering them from `1.9`'s own range, not by diffing against `main`.
- **Expected release decision:** release `1.9`; the feat drives a minor
  bump even on a maintenance line (an alternative fix-only maintenance
  policy must then reject D loudly instead of demoting it silently).
- **Expected versions:** `1.9.0` → `1.10.0`.
- **Affected release lines:** `1.9`.
- **Expected artifacts:** release PR/tag `1.10.0`; changelog section
  listing D and F1.
- **Expected transitions:** the `1.9` released-version pointer → `1.10.0`;
  pending change set drains; `main` untouched and unaffected by D.
- **Expected failure behavior:** a range computed as "commits `main` has
  that `1.9` lacks" (any main-relative diff) finds nothing or
  mis-attributes D; each line's range is computed from its own last
  release tag to its own head.
- **Identity requirements:** per-line range definition (line's own tag →
  line's own head); no assumption of ancestry inclusion in either
  direction.
- **State requirements:** per-line last-release tag; an explicit model
  that `main` is not a superset of maintenance lines.
- **Abstraction under stress:** "`main` contains everything" — the linear
  history assumption under branch divergence.

#### M-08 — Per-line policies: prerelease here, forbidden there

- **Class:** MULTI-LINE (different policies per line).
- **Initial state:** `main` (released `2.3.0`) has a policy allowing the
  `rc` prerelease stream; line `1.9` (released `1.9.0`) is stable-only.
  Breaking change B (`feat:` + `BREAKING CHANGE:` footer) lands on `main`;
  fix F lands on `1.9`. An operator explicitly asks for a prerelease of
  `1.9`.
- **Inputs:** both commits; both line policies; the operator's prerelease
  request for `1.9`.
- **Intended outcome:** one plan pass, two different release shapes: a
  prerelease on `main`, a stable patch on `1.9`, and a refusal of the
  operator's request for `1.9`.
- **Expected release decision:** `main` → prerelease; `1.9` → stable
  patch; the prerelease request on `1.9` is rejected with the policy
  reason (recorded, not retried).
- **Expected versions:** `2.4.0-rc.1` on `main`; `1.9.1` on `1.9`. The
  kernel computes bumps but not next-prerelease — that operation is line
  policy per ADR-0001's deferred seam; this scenario is its first
  consumer.
- **Affected release lines:** `main`, `1.9`.
- **Expected artifacts:** prerelease tag `2.4.0-rc.1` and its artifacts on
  main's channel; stable tag `1.9.1`; per-line changelog entries.
- **Expected transitions:** main's released-version pointer → `2.4.0-rc.1`
  with stream state `rc`; `1.9` → `1.9.1`; the rejection becomes a
  decision record.
- **Expected failure behavior:** a single repository-wide policy either
  forbids prereleases everywhere or mints `1.9.1-rc.1` against policy;
  the prerelease request on `1.9` must fail with an explicit policy
  error, never a fallback to stable.
- **Identity requirements:** policy is resolved per line and versioned
  with the plan; the stream (`rc`) is part of the line's policy state,
  never inferred from the version string alone.
- **State requirements:** per-line policy records including stream
  allowance; the next-prerelease operation the ADR deferred (see P-02,
  P-07).
- **Abstraction under stress:** one global release policy; also the
  kernel/policy boundary ADR-0001 deliberately left open.

#### M-09 — Fix released on maintenance before main receives it

- **Class:** MULTI-LINE (fix released on maintenance first, then merged to
  main).
- **Initial state:** fix F was released on line `1.9` as `1.9.1`. Weeks
  later F reaches `main` as F″ (merge of `1.9` or a cherry-pick); `main`
  is released `2.3.0` with F″ now pending and no other pending commits.
- **Inputs:** F″ with lineage to the released F; main's tag `2.3.0`.
- **Intended outcome:** `main` releases F″ normally; the earlier `1.9`
  release neither suppresses it nor leaves a duplicate entry in a merged
  changelog.
- **Expected release decision:** release `main`.
- **Expected versions:** `2.3.0` → `2.3.1` — correct even though `1.9.1`
  already shipped the same fix to a different audience.
- **Affected release lines:** `main` (and, historically, `1.9`).
- **Expected artifacts:** release PR/tag `2.3.1`; changelog entry for F″;
  no re-publication of `1.9` artifacts.
- **Expected transitions:** main's released-version pointer → `2.3.1`;
  F″ drains from main's pending change set; the change's
  released-versions map now reads `{1.9.1, 2.3.1}`.
- **Expected failure behavior:** the naive rule "a greater version
  contains every lesser version's changes" concludes F″ is already
  delivered (`2.3.0 > 1.9.1`) and skips it — wrong for consumers pinned
  to `2.x`; the inverse (never re-release cross-line) strands `2.x`
  users.
- **Identity requirements:** lineage recorded cross-line but suppressive
  only within a line; release sets are per line.
- **State requirements:** per-line released sets; an explicit model that
  version precedence across lines implies nothing about content.
- **Abstraction under stress:** version ordering implies content
  inclusion.

#### M-10 — Line renamed or retired

- **Class:** MULTI-LINE (line renamed; line retired).
- **Initial state:** two variants. Rename: branch `1.9` (released
  `1.9.0`, one pending fix) is renamed to `1.9-lts`. Retire: line `1.6`
  (released `1.6.2`) is declared end-of-life; afterwards a fix F lands on
  its branch anyway.
- **Inputs:** the ref rename; the retirement decision (a policy state
  change); the post-retirement commit F.
- **Intended outcome:** rename — the line keeps its identity, released
  history, and pending change set; planning continues under the new name.
  Retire — F is refused release with an explicit reason and surfaced as
  withheld, not silently dropped; existing tags stay valid.
- **Expected release decision:** rename → release `1.9-lts` normally
  (`1.9.1`). Retire → no release; F withheld.
- **Expected versions:** `1.9.1` on the renamed line; none for the retired
  line.
- **Affected release lines:** `1.9`/`1.9-lts` (same line), `1.6`.
- **Expected artifacts:** normal `1.9.1` artifacts under the new branch
  name; for the retired line, a structured withheld-change record
  (commit, reason, timestamp), no tag, no changelog entry.
- **Expected transitions:** the renamed line's ledger survives the rename
  intact; the retired line's lifecycle state → `retired`; F parked as
  pending-withheld (same deferral rule as PL-07).
- **Expected failure behavior:** a model keying lines by branch name
  orphans the ledger on rename — the renamed line replans as a "new" line
  and computes a bogus version from an empty history; a retirement that
  just deletes the branch silently loses F. Both must be impossible.
- **Identity requirements:** line identity is a stable id independent of
  the mutable ref name; retirement is recorded state, not branch
  deletion.
- **State requirements:** a line entity with lifecycle (`active`,
  `frozen`, `retired`) keyed by stable id; ref-name changes tracked as
  renames, not create+delete.
- **Abstraction under stress:** branch name = line identity; deletion =
  retirement.

#### M-11 — Same version number on two lines

- **Class:** MULTI-LINE (tag collision within one shared history).
- **Initial state:** tag `1.9.1` exists on line `1.9` at commit C9x. A
  stale or mis-scoped planner run against `main` (released `2.3.0`)
  derives a candidate that would create tag `1.9.1` at a different commit
  on `main` — same number, different line, different commit. (Two
  unrelated histories independently using `1.0.0` is out of scope; this
  is the collision case.)
- **Inputs:** the invalid plan; the existing tag; the intended target
  commit.
- **Intended outcome:** the engine detects that tag `1.9.1` already exists
  at a different commit and refuses the plan before any mutation.
- **Expected release decision:** rejected plan; no release.
- **Expected versions:** none applied; the error names the colliding
  version, both commits, and both lines.
- **Affected release lines:** `main` (the offending plan), `1.9` (the
  legitimate holder).
- **Expected artifacts:** none — no tag, no changelog, no partial state.
- **Expected transitions:** none; the planner's own state is unchanged.
- **Expected failure behavior:** two opposite naive failures: per-line
  version checks alone create a duplicate tag (git refuses the push,
  leaving a half-applied release); a global version-unique rule alone
  refuses legitimate per-line histories. The correct model keeps both
  maps and checks both.
- **Identity requirements:** the tag namespace is repository-global;
  version allocation is per line; a plan verifies its target tag does not
  exist at any commit before execution.
- **State requirements:** a global tag → commit map re-read at execution
  time, alongside per-line version history. (The kernel's structural
  `equals` makes `1.9.1+a` ≠ `1.9.1+b`, but tags must not be disambiguated
  by build metadata; the collision is real.)
- **Abstraction under stress:** conflation of the version space (per
  line) with the tag namespace (global). See also E-08 for the concurrent
  variant.

### PLANNING

#### PL-01 — Monorepo: one package changed, one package released

- **Class:** PLANNING (package impact in a multi-package workspace;
  hypothetical future — today's tree is a workspace of one).
- **Initial state:** workspace with packages `app`, `lib-a`, `lib-b`.
  Commit `fix(lib-a): guard empty config` touches only
  `packages/lib-a/src/**`. `lib-a` is released `1.2.0`.
- **Inputs:** the commit; the package layout; a scope/path → package
  mapping.
- **Intended outcome:** exactly `lib-a`'s version moves; the release is
  attributed to `lib-a` by scope and verified by path.
- **Expected release decision:** release `lib-a` only.
- **Expected versions:** `lib-a` `1.2.0` → `1.2.1`; `app` and `lib-b`
  unchanged.
- **Affected release lines:** `lib-a`'s line.
- **Expected artifacts:** a `lib-a` changelog section; a per-package tag
  whose version component parses as bare `1.2.1` (the `v`-prefix ban
  applies to the value the kernel parses, not to ref naming policy — an
  open naming fork).
- **Expected transitions:** lib-a's released-version pointer → `1.2.1`;
  other packages' pointers untouched.
- **Expected failure behavior:** a repo-versioned engine bumps one global
  version for a one-package change — wrong in a multi-package future; a
  path-only attribution ignores `scope:` and vice versa. The mapping must
  be explicit and its misses loud (see PL-05a).
- **Identity requirements:** commit → package attribution via an explicit,
  total mapping (scope table and/or path filter); unmapped commits are an
  error, not a default package.
- **State requirements:** per-package released-version pointers; the
  package graph as plan input.
- **Abstraction under stress:** repo == package.

#### PL-02 — Dependency propagation: the changed package has dependents

- **Class:** PLANNING (dependency propagation in the package graph).
- **Initial state:** (hypothetical multi-package future) `lib-a`
  `1.2.0`; `lib-b` depends on `lib-a: "^1.2.0"`; `app` depends on `lib-a`
  and `lib-b`. Case 1: `fix:` on `lib-a` → patch. Case 2: breaking change
  on `lib-a` → `2.0.0`.
- **Inputs:** the commits; the workspace dependency graph; the manifests'
  range expressions.
- **Intended outcome:** case 1 — the caret range `^1.2.0` already accepts
  `1.2.1`, so dependents' behavior is unaffected; whether to bump them
  purely to refresh manifests is an explicit plan decision. Case 2 —
  `^1.2.0` no longer accepts `2.0.0`; `lib-b` must widen to `^2.0.0`, and
  `app` must follow for `lib-b`.
- **Expected release decision:** case 1 — release `lib-a`; dependents per
  explicit policy (recommended: bump only dependents whose manifests
  change, so lockfile truth matches the registry). Case 2 — release
  `lib-a` `2.0.0`; `lib-b` (range-widening = minor); `app` likewise.
- **Expected versions:** case 1: `lib-a` `1.2.1` (+ dependent patches per
  policy). Case 2: `lib-a` `2.0.0`, `lib-b` `1.5.0`, `app` `3.1.0`.
- **Affected release lines:** the packages' respective lines.
- **Expected artifacts:** per-package changelog sections; case 2 entries
  for dependents say "dependency range widened", never a fabricated
  feature.
- **Expected transitions:** case 2 propagates in topological order
  (`lib-a` → `lib-b` → `app`); manifests updated in the release PR.
- **Expected failure behavior:** a message-only planner never widens
  ranges → case 2 ships a `lib-b` that cannot resolve `lib-a@2`; an
  always-propagate planner bumps the world in case 1.
- **Identity requirements:** propagation follows declared dependency
  edges; range math (caret/tilde/exact/pinned) is read from manifests,
  not assumed.
- **State requirements:** the package graph plus manifest ranges read at
  plan time; propagation order = topological.
- **Abstraction under stress:** bump decisions from commit messages
  alone; the manifest layer does not exist.

#### PL-03 — Unrelated isolation: neighbors must not move

- **Class:** PLANNING (unrelated package isolation).
- **Initial state:** commit `fix(tool-x): correct CLI exit code` where
  `tool-x` is a leaf package nothing depends on; second commit
  `docs(lib-a): expand README`, docs-only.
- **Inputs:** the two commits; the dependency graph (no reverse edges from
  `tool-x`); docs filtered by policy.
- **Intended outcome:** `tool-x` bumps alone; the docs commit triggers
  nothing anywhere.
- **Expected release decision:** release `tool-x` (`0.3.0` → `0.3.1`);
  docs-only commit filtered (docs/chore are non-releasing types by
  policy, not by hard-coding).
- **Expected versions:** `tool-x` `0.3.1`; all others unchanged; a second
  plan run over the docs commit → no version anywhere.
- **Affected release lines:** `tool-x`'s line; the second run affects no
  line (see PL-06).
- **Expected artifacts:** `tool-x` changelog + tag; nothing for docs.
- **Expected transitions:** the `tool-x` pointer moves; others provably
  untouched.
- **Expected failure behavior:** an always-propagate planner bumps every
  package for a leaf fix; a planner with no docs filter bumps `lib-a` for
  prose. Both break the isolation contract in opposite directions.
- **Identity requirements:** non-impact must be demonstrable (absence of
  reverse-dependency edges; type filtered by explicit policy), not
  assumed.
- **State requirements:** the package graph; the release-type policy
  table; negative evidence is a first-class plan output ("why nothing
  else moved").
- **Abstraction under stress:** every commit is a release; impact is
  symmetric with change.

#### PL-04 — The release PR's own output is not a change

- **Class:** PLANNING (generated file mutation; planner self-reference).
- **Initial state:** the engine's previous release commit R mutated
  `CHANGELOG.md`, manifests, and the lockfile. R is now the newest commit
  on `main` inside the next planning range.
- **Inputs:** commit R, authored by the release bot and carrying a
  deterministic marker (a `Release-As:`/bot trailer — the exact
  convention is an open fork).
- **Intended outcome:** R is recognized as the planner's own output and
  excluded from change detection; one release does not become the input
  of the next.
- **Expected release decision:** no release attributable to R; if other
  pending commits exist the plan proceeds without R; otherwise PL-06's
  empty-change-set behavior applies.
- **Expected versions:** none caused by R.
- **Affected release lines:** none (from R alone).
- **Expected artifacts:** none attributable to R; no changelog entry
  "chore: release 2.3.1" re-entering a changelog.
- **Expected transitions:** R consumed and marked bookkeeping; the range
  cursor moves past R without a version event.
- **Expected failure behavior:** the naive all-commits-count engine sees
  a pending commit after every release and either loops forever (release
  → commit → release) or burns one patch bump per quiet period. A marker
  that is forgeable or optional must fail toward explicit review, not
  silent exclusion.
- **Identity requirements:** bot-authored release commits identifiable
  deterministically (author + trailer convention); ambiguous cases (a
  human edits the changelog by hand) surface for a decision, never
  auto-classify.
- **State requirements:** the release-bot identity convention; range
  scanning that classifies bookkeeping commits before change detection.
- **Abstraction under stress:** the planner treats its own outputs as
  foreign input — a self-reference/fixed-point hazard.

#### PL-05 — Ambiguous commits: scope clash, breaking chore, merge

- **Class:** PLANNING (three ambiguity shapes).
- **Initial state:** (a) commit `fix(core): …` where scope `core` maps to
  two packages in the hypothetical workspace; (b) commit
  `chore(build): drop node 18` carrying a `BREAKING CHANGE: …` footer,
  where `chore` is a non-releasing type; (c) a range containing a merge
  commit M whose branch commits are also individually in range.
- **Inputs:** the three commits; the scope→package table; the release-type
  policy; the range walk definition.
- **Intended outcome:** (a) the plan fails with an explicit ambiguity
  error — the engine must not guess one package, both, or none
  (resolution is a config table the operator extends). (b) the breaking
  marker must not vanish because the type is filtered: a
  `BREAKING CHANGE:` footer forces a major bump, or at minimum a hard
  error forcing a commit retype — the silent outcome is the worst one.
  (c) each logical change counted exactly once; merge commits themselves
  are not changes.
- **Expected release decision:** (a) no release — blocked pending config;
  (b) major bump or blocked-with-guidance; (c) a normal release from the
  deduplicated set.
- **Expected versions:** (a) none; (b) `2.0.0` if the breaking-marker rule
  is adopted; (c) per the deduplicated set.
- **Affected release lines:** (b) and (c) on the committing line; (a) on
  none until resolved.
- **Expected artifacts:** (a) an ambiguity report (commit, candidate
  packages); (b) either the major release or the blocking error; (c) a
  changelog with no duplicate entries.
- **Expected transitions:** (a) plan blocked pending config; (b) the
  commit classified breaking despite type `chore`; (c) merge commits
  marked structural, not change-bearing.
- **Expected failure behavior:** each shape silently breaks a naive rule:
  scope-guessing releases the wrong package; type-filtering swallows a
  breaking change; commit-counting over a range with merges
  double-counts or skips changes depending on walk order (first-parent
  vs topological — the walk is recorded policy).
- **Identity requirements:** the scope→package mapping is total or the
  plan fails; footer semantics are evaluated independently of type
  filters; range membership is a set (reachability), not a list.
- **State requirements:** the mapping table with its gaps visible; the
  range walk definition (first-parent recommended for release ranges)
  recorded as policy.
- **Abstraction under stress:** message-derived attribution is total,
  unambiguous, and commutes with type filters.

#### PL-06 — Empty change set: every commit ignored by policy

- **Class:** PLANNING (empty change set).
- **Initial state:** the range since `2.3.0` contains only `docs:` and
  `chore(ci):` commits — every one filtered by policy.
- **Inputs:** the filtered-to-empty range; the release-type policy.
- **Intended outcome:** the planner completes with a first-class
  "nothing to release" outcome — a success state, distinguishable from a
  crash, that mutates nothing.
- **Expected release decision:** no release; the plan exits with `no-op`
  plus the reason (per-commit classification proving emptiness).
- **Expected versions:** none; `2.3.0` remains the released version.
- **Affected release lines:** none.
- **Expected artifacts:** none — no tag, no release PR, no changelog
  re-date; at most a log record with the filtered-commit list.
- **Expected transitions:** none; the next planning run starts from the
  same released version. The range cursor does **not** advance past
  filtered commits until they are released or explicitly discarded —
  otherwise a later policy change un-ignoring `docs` would find them
  already skipped (same deferral rule as PL-07).
- **Expected failure behavior:** three naive failures: crash on empty
  input; an empty release PR (permanent review noise); a "date-bump"
  changelog mutation that creates a diff with no release.
- **Identity requirements:** emptiness is computed, then asserted with
  evidence (which commits, which filter rules); it is a result, not an
  error.
- **State requirements:** no state mutation on the no-op path; re-running
  is idempotent.
- **Abstraction under stress:** release as an always-producing operation;
  the "empty input is an error" bias. See S-01 for the release-decision
  side of the same contract.

#### PL-07 — Change withheld by the line's package policy

- **Class:** PLANNING (policy-excluded package).
- **Initial state:** maintenance line `1.9` has a freeze policy: package
  `app` receives no maintenance releases (only library packages do)
  (hypothetical multi-package future). Commit `fix(app): prevent startup
crash on old kernels` lands on `1.9`.
- **Inputs:** the commit; the line's package-allow policy.
- **Intended outcome:** the `1.9` line's plan excludes `app` from its
  release set; the commit is reported as withheld-with-reason and stays
  tracked as pending-withheld until the policy changes or an operator
  explicitly discards it.
- **Expected release decision:** if the withheld commit was the only
  pending change → no release (PL-06 behavior); otherwise release the
  remaining packages without `app`.
- **Expected versions:** none for `app` on `1.9`; other packages per
  their pending change sets.
- **Affected release lines:** `1.9`.
- **Expected artifacts:** a withheld-change record (commit, package,
  policy rule, timestamp); no changelog entry, no tag for the withheld
  change.
- **Expected transitions:** commit → `pending-withheld(app frozen on
1.9)`; on a later unfreeze it re-enters the pending change set — which
  is exactly why the range cursor must not have advanced past it (PL-06's
  deferral rule).
- **Expected failure behavior:** naive filtering deletes the commit from
  consideration: after an unfreeze the fix is unrecoverable by the
  planner (its range moved on) — silently lost work. Naive inclusion
  violates the freeze. The withheld state is the only correct middle.
- **Identity requirements:** exclusion is applied at release-decision
  time, never by rewriting history or dropping the commit; withholding
  persists as state keyed by (commit, line, rule).
- **State requirements:** a pending-withheld set per line with reasons;
  range bookkeeping that keeps withheld commits inside the un-released
  span.
- **Abstraction under stress:** policy filtering as terminal deletion
  instead of deferral. See M-10 for the line-retirement variant.

#### PL-08 — Stale release plan: the change set grew mid-flight

- **Lineage:** merged from A-04 + B-16 — the same staleness trap seen from
  the release-PR side and the plan-fingerprint side.
- **Class:** PLANNING (plan invalidation by new commits).
- **Initial state:** tags through `1.4.2`; an open release PR "release
  1.5.0" built from plan P1, frozen at commit C1, containing one `feat:`;
  `main` has moved on.
- **Inputs:** a new merge on `main`: `feat: export plugin api` (C2) while
  P1's PR is still open. Operator intent: "release again."
- **Intended outcome:** P1 is detected stale (its base C1 is no longer
  HEAD); the tool regenerates plan P2 for the same target `1.5.0` over
  the new range, closes P1 as superseded-by-P2, and keeps exactly one
  live release PR whose changelog covers both feats.
- **Expected release decision:** no immediate release; plan regeneration;
  the release happens when the regenerated PR merges.
- **Expected versions:** target stays `1.5.0` (minor over `1.4.2`) — but
  the plan identity changes (P1 → P2) because the change set changed.
  Version equality must not imply plan equality.
- **Affected release lines:** line 1.x on `main`.
- **Expected artifacts:** exactly one live release PR; P1's PR closed with
  a supersession link; the discarded plan logged.
- **Expected transitions:** P1: planned → superseded; P2: planned →
  awaiting merge. No attempt is created until merge.
- **Expected failure behavior:** if P1's PR merges concurrently (tag
  `1.5.0` appears), regeneration detects the published version and
  re-targets P2 to `1.5.1` instead of colliding. Validity is checked by a
  fingerprint — tip SHA plus the sorted policy-relevant commit ids and
  their computed bumps — verified immediately before execution;
  policy-ignored commits do not invalidate (docs-only commits must not
  thrash the plan). An execute-what-was-computed engine would ship an
  incomplete release and strand C2, possibly forever.
- **Identity requirements:** plan id separate from target version;
  change-set id (hash over the change set); base-commit pointer per plan;
  a durable supersession relation P1 → P2 (both resolvable).
- **State requirements:** persisted plans with explicit validity
  preconditions; execution re-verifies, never trusts; PR ↔ plan linkage
  recorded so orphaned PRs are detectable.
- **Abstraction under stress:** N3 — "next release" as an unnamed,
  implicit object cannot be detected stale; plans must be first-class and
  content-sensitive. See P-05 (target moves), E-04 (policy moves), E-11
  (base moves) for the other invalidation causes.

### ARTIFACTS

#### AR-01 — One release, three artifacts, all succeed

- **Class:** ARTIFACTS (the happy path, made explicit).
- **Initial state:** package `@ex/app` released `1.4.1` (hypothetical
  multi-package future); a release artifact pipeline configured for three
  outputs: npm tarball, GitHub Release, container image
  (`ghcr.io/ex/app`).
- **Inputs:** commit `abc123` on `main` carrying `feat: add streaming
export`; the pipeline configuration.
- **Intended outcome:** one release `1.5.0` (feat → minor) producing three
  artifacts whose states are tracked individually yet asserted together.
- **Expected release decision:** release.
- **Expected versions:** `1.5.0`; the tag is placed once, at the release
  commit; the three artifacts all bind to it.
- **Affected release lines:** `@ex/app`'s line on `main`.
- **Expected artifacts:** npm package `@ex/app@1.5.0`; a GitHub Release
  `1.5.0` with notes and checksums; image `ghcr.io/ex/app:1.5.0` — each
  with its own content digest recorded at build time.
- **Expected transitions:** tag → published; per-artifact state
  built → verified → published; the release as a whole complete only when
  all three artifact records are `published` in the execution ledger.
- **Expected failure behavior:** none here — this is the baseline against
  which E-01/E-02 break; the release is not "done" at the first success.
- **Identity requirements:** artifact identity = (kind, coordinates,
  digest); one release record linking the three.
- **State requirements:** a per-release artifact set with per-artifact
  states; release completion is a derived predicate, not a flag set at
  step one.
- **Abstraction under stress:** "a release" as one atomic publish event —
  it is a bundle of stateful operations that only occasionally all
  succeed together.

#### AR-02 — Image depends on npm; registry propagation delay

- **Class:** ARTIFACTS (artifact dependency; publication visibility).
- **Initial state:** same release as AR-01; the image build installs
  `@ex/app@1.5.0` from the npm registry.
- **Inputs:** the npm publish completing; the image build starting within
  seconds; CDN/registry propagation lag (unbounded, typically seconds to
  minutes).
- **Intended outcome:** the image build proceeds only after the npm
  artifact is verified visible (metadata fetch + tarball digest check) —
  not merely after the publish call returned.
- **Expected release decision:** release with an explicit verify step;
  npm publish → verify → image build, never publish → build.
- **Expected versions:** `1.5.0`; image pins the exact version and
  records the tarball's sha512 at build time.
- **Affected release lines:** `@ex/app`'s line.
- **Expected artifacts:** npm tarball; image layers containing the exact
  tarball; the recorded sha512.
- **Expected transitions:** npm: published+verified; image: blocked on
  verification, then built.
- **Expected failure behavior:** without verification the image bakes a
  404 or a stale cached layer — an image tagged `1.5.0` that cannot
  reproduce the npm artifact. With verification and a hard timeout
  exceeded → the release is **partial**, not failed: recovery is
  E-02's ledger resume, never a silent second npm publish.
- **Identity requirements:** cross-artifact dependency is recorded (image
  → tarball digest, not "the latest 1.5.0"); verification binds observed
  digest to expected digest.
- **State requirements:** artifact dependency edges; a visibility check
  with retries and an explicit timeout boundary that hands off to the
  recovery path.
- **Abstraction under stress:** "published == available"; publication is
  not a transaction across backends. See E-02 for the partial-failure
  continuation.

#### AR-03 — Artifact version scheme differs from release version

- **Class:** ARTIFACTS (container tags vs semver releases).
- **Initial state:** release `2.0.0` of an application; the image
  pipeline also maintains moving tags `v2` and `latest`.
- **Inputs:** the release; the image tag policy
  (`{2.0.0, v2, latest}` — container coordinates, not git tags, and
  exempt from the `v`-prefix ban, which governs the tags the kernel
  parses).
- **Intended outcome:** the immutable tag `2.0.0` is pushed once; the
  mutable tags are moved by the release, each move recorded as a channel
  event; image identity is the digest, not any tag.
- **Expected release decision:** release.
- **Expected versions:** `2.0.0`; the moving tags are channels, not
  versions — the mutable/immutable split is explicit.
- **Affected release lines:** the application's line.
- **Expected artifacts:** image `ghcr.io/x/app:2.0.0` (immutable) plus
  moved tags `v2`, `latest`; all three pointing at one digest at t1.
- **Expected transitions:** `v2`: digest D1 → D2 (a channel move with an
  event record); `latest`: likewise.
- **Expected failure behavior:** the `v2` move fails (registry outage)
  after `2.0.0` succeeded → split visibility: consumers of `v2` see the
  old digest, consumers of `2.0.0` see the new one. Recovery: report
  partial completion (E-02 resume semantics) and retry the move — the
  move is idempotent because it targets the same expected prior state.
  Identity confusion (treating tag name as artifact identity) makes the
  split undetectable.
- **Identity requirements:** digest is the artifact identity; tags are
  mutable channels over it; every move is an attributed event.
- **State requirements:** per-tag event log (from-digest, to-digest,
  cause, release id); release completion requires the declared tag set
  consistent.
- **Abstraction under stress:** N6 — version string as identity;
  container tags are channels, not versions.

#### AR-04 — Nightly and stable from the same commit

- **Class:** ARTIFACTS (multiple artifact flavors from one commit).
- **Initial state:** release channel policy: `stable` (release-triggered)
  and `nightly` (cron-triggered). Commit `abc123` is both tonight's
  nightly source and, three days later, the tip of release `1.5.0`.
- **Inputs:** the cron schedule; the release; the channel policy; the
  line's last released version `1.4.1`.
- **Intended outcome:** the nightly at t0 produces
  `1.5.0-nightly.20260905.abc123`; the stable release at t1 produces
  `1.5.0` from the same commit — two artifacts, two coordinates, one
  source; neither invalidates the other.
- **Expected release decision:** nightly: a scheduled build, not a
  release (no version allocation on the line — the base `1.5.0` is
  computed, not minted); stable: release `1.5.0`.
- **Expected versions:** `1.5.0-nightly.20260905.abc123` (a valid SemVer
  prerelease: identifier `nightly`, dot-separated build info) and
  `1.5.0`. Nightly naming must satisfy SemVer §11's identifier rules —
  dots inside the prerelease are allowed, and the timestamp must be
  allocated deterministically (see E-10).
- **Affected release lines:** the line on `main`; the nightly rides the
  channel `nightly`, the release rides `stable`.
- **Expected artifacts:** nightly images/packages under the `nightly`
  channel; release artifacts under `stable`; digests differ even though
  the source commit is identical (build timestamps/instructions may
  differ — digests are the truth, not the version).
- **Expected transitions:** channel `nightly` moves nightly (each move
  recorded); channel `stable` moves only at releases.
- **Expected failure behavior:** naive max-version logic makes the
  nightly (a prerelease, hence lower) invisible to `stable` consumers —
  correct here, but the same logic breaks rc ordering if channels are
  conflated (see P-02). Automation computing "latest" by max-version is
  safe only because `nightly.*` and `rc.*` are never compared for
  delivery decisions; any tool doing so must use channel state, not
  version arithmetic.
- **Identity requirements:** version = f(commit, line state, channel
  policy); the same commit may carry many artifact identities; channel
  membership, not version comparison, decides delivery.
- **State requirements:** per-channel pointers; nightly builds recorded
  with their base version and commit so the later release can prove
  lineage.
- **Abstraction under stress:** N6 + channel/version conflation.

#### AR-05 — Orphan artifact: published but unattributed

- **Class:** ARTIFACTS (partial attempt, ledger lost).
- **Initial state:** release attempt A for `1.5.0` published the npm
  tarball, then its runner died before the GitHub Release and before the
  execution ledger recorded progress. A retry B starts fresh.
- **Inputs:** attempt A's partial reality (npm registry state); attempt
  B's plan (same target, same source); no ledger from A.
- **Intended outcome:** attempt B detects the orphan (publish-existence
  probe), attributes it to A by evidence (registry metadata: publish
  timestamp, commit, attestation), and adopts it — B continues from
  GitHub Release onward — or escalates to an operator when attribution
  is ambiguous.
- **Expected release decision:** one release `1.5.0` total; B's ledger
  absorbs A's completed step as `adopted-from-A`.
- **Expected versions:** `1.5.0`, published exactly once on npm.
- **Affected release lines:** the line on `main`.
- **Expected artifacts:** one npm tarball; one GitHub Release; attempts A
  and B share the release record.
- **Expected transitions:** A: failed(unknown); B: resumed with an
  adopted step; the npm step: `published (attempt A) → verified (attempt
B)`.
- **Expected failure behavior:** naive retry re-publishes → npm rejects
  (versions are immutable) → hard failure; or a permissive registry
  accepts and there are two divergent tarbills for one version — the
  worst outcome. Integrity mismatch (orphan's digest ≠ B's build) is a
  hard stop: the version is burned, next attempt retargets `1.5.1`.
- **Identity requirements:** every write step is attributed (attempt id
  in attestation/metadata where backends allow); existence probes are
  mandatory before writes that cannot repeat.
- **State requirements:** the execution ledger persisted _before_
  effects (write-ahead), so "lost" ledgers become rare; reconciliation
  procedure for when they happen anyway.
- **Abstraction under stress:** "the runner's memory is the release
  state"; reality outruns the ledger and must be reconciled against it.

#### AR-06 — GitHub Release draft with stale notes

- **Class:** ARTIFACTS (intermediate artifact states).
- **Initial state:** attempt A creates the GitHub Release for `1.5.0` in
  **draft** state (notes computed against base `b1`), then dies. `main`
  gains two commits. Attempt B begins with base `b2`.
- **Inputs:** the draft's stored notes; the new base `b2`; the change
  sets for both bases.
- **Intended outcome:** B regenerates notes against `b2`, overwrites the
  draft (attributed, diff reported), and publishes. The draft is an
  intermediate state owned by the attempt, not a fact.
- **Expected release decision:** release `1.5.0` with notes covering
  `b1..b2` — the union, since `b2` includes `b1`'s span.
- **Expected versions:** `1.5.0`; the published notes match the final
  change set.
- **Affected release lines:** the line on `main`.
- **Expected artifacts:** GitHub Release `1.5.0` (published), its
  artifact assets, checksums; the pre-overwrite draft content preserved
  in the ledger for audit.
- **Expected transitions:** draft (A) → overwritten-draft (B) →
  published; every mutation attributed to its attempt.
- **Expected failure behavior:** naive flow publishes A's stale draft →
  notes silently missing two commits; the tool must treat drafts as
  attempt-owned scratch state. A draft created by a **foreign** actor
  (human, other tool) → never silently overwritten: escalate (ties to
  E-07's foreign-claim rule).
- **Identity requirements:** states absent/draft/published/failed exist
  per artifact with per-state attribution; overwrite rights follow
  attempt ownership, not name equality.
- **State requirements:** artifact state machine including
  intermediate states; ownership binding attempt → artifact instance.
- **Abstraction under stress:** artifacts have interiors (states between
  absent and published); "the GitHub Release exists" is not one fact but
  a state with an owner.

### EXECUTION

#### E-01 — Crash after the tag push: half a release

- **Lineage:** merged from A-13 (attempt dies post-tag; complete-in-place
  vs void-and-skip) + C-09 (tag-push as the no-return boundary; recovery
  procedure). The same trap seen from the attempt lifecycle and the
  recovery protocol.
- **Class:** EXECUTION (partial failure at the tag boundary).
- **Initial state:** attempt A executed: changelog committed, tag `1.5.0`
  pushed — then the runner died. Nothing else exists: no GitHub Release,
  no npm publish, no ledger record after the tag step (ledger
  write-ahead may still hold the tag step as completed).
- **Inputs:** the tag's existence; the ledger tail; the plan; the
  backend states.
- **Intended outcome:** recovery classifies the attempt from the tag (the
  externally-visible, hard-to-undo step) and either completes the
  remaining steps under a resumed attempt or voids the release —
  deterministically, from recorded state, never by guessing.
- **Expected release decision:** policy-bound, but not arbitrary:
  tag-present + plan-valid → complete-in-place (finish artifacts,
  channels, ledger); tag-present + plan-invalid → escalate (a human
  decides delete-tag vs repair); the void-and-skip path (leave the tag,
  mark the release abandoned, next version `1.5.1`) is the fallback when
  completion is unsafe. The tag is treated as a claim on `1.5.0` — see
  E-07.
- **Expected versions:** complete-in-place: `1.5.0` published. Void: no
  published `1.5.0`; the next release is `1.5.1` (tag namespace stays
  unique; burned tag recorded).
- **Affected release lines:** the line on `main`.
- **Expected artifacts:** complete-in-place: the full set. Void: none,
  plus a decision record explaining the burn.
- **Expected transitions:** A: `failed(unknown)` → classification →
  either `resumed (A′ completes)` or `abandoned (tag burned)`. The
  released-version pointer moves only when the release completes.
- **Expected failure behavior:** both naive recoveries are wrong:
  restart-from-scratch re-runs the changelog/tag steps and dies on the
  existing tag; treat-as-failed ignores a tag that consumers may already
  fetch (tag `1.5.0` exists but the release "doesn't"). Detection must
  map tag existence → ledger state → chosen recovery, with every step
  attributable (AR-05's probe discipline).
- **Identity requirements:** the tag is a claim on the version, not
  proof of completion; completion is a ledger predicate; each recovery
  decision is a recorded decision with cause.
- **State requirements:** the execution ledger with at least the
  completed-steps tail; recovery reads remote state and reconciles
  (write-ahead ledger preferred — the same discipline as AR-05).
- **Abstraction under stress:** N3 — the crash window between steps is
  the normal case, not the exception; a model without an attempt
  boundary treats half a release as either zero or one release.

#### E-02 — Amputated mid-publication: resume the ledger

- **Lineage:** merged from A-19 (attempt dies after npm publish, resume
  contract) + C-03 (multi-artifact publication with per-step resume;
  npm immutability). Same trap, attempt semantics + backend mechanics.
- **Class:** EXECUTION (mid-publication partial failure).
- **Initial state:** attempt A published the npm tarball `1.5.0` and
  died before creating the GitHub Release and moving channels. The
  ledger (write-ahead) shows: npm — completed; GitHub Release — started;
  channels — pending.
- **Inputs:** the ledger; registry state; the original plan (artifact
  digests recorded at build time).
- **Intended outcome:** a resumed attempt B verifies each completed step
  (digest match) and executes only the remainder — no step re-runs, no
  step is skipped.
- **Expected release decision:** release completes via resume; the
  release record spans A and B.
- **Expected versions:** `1.5.0` published once; npm's immutability
  means the completed step must be adopted, never re-run.
- **Affected release lines:** the line on `main`.
- **Expected artifacts:** one tarball (A's, verified), GitHub Release +
  channel moves (B's), all bound to the recorded digests.
- **Expected transitions:** per-step: completed → verified-by-B;
  started → re-attempted; pending → executed. Release completes when
  the ledger predicate says all steps verified.
- **Expected failure behavior:** a from-scratch retry dies on the
  existing npm publish (E-05's naive path) or — worse — republishes to
  a permissive backend. A "skip completed" without verification trusts
  A's claim: if A's tarball digest differs from B's build, the release
  would mix two bodies under one version — the integrity mismatch is a
  hard stop (AR-05's rule).
- **Identity requirements:** per-step idempotency keys (step kind +
  artifact coordinates); digests recorded before effects; done must be
  _verified_, not assumed — and a conflicting done is distinguishable
  from a matching done.
- **State requirements:** the durable ledger is the recovery source of
  truth; steps are individually resumable; the plan (with digests)
  outlives the attempt.
- **Abstraction under stress:** N3 — publication as one RPC; it is a
  multi-step transaction over backends with wildly different semantics
  (immutable registries, mutable channels,Drafts).

#### E-03 — The tag appeared: replay, satisfaction, conflict

- **Lineage:** merged from B-18 (declared release already exists —
  satisfied-externally) + C-12 (re-execution finds completed state —
  conflict vs no-op). Same detection point: target state exists before
  execution.
- **Class:** EXECUTION (declarative replay onto existing state).
- **Initial state:** release plan P targeting `1.5.0` on `main`; before
  execution, tag `1.5.0` exists at the intended commit (created by a
  retried run, a parallel worker, or a human following the runbook).
- **Inputs:** P; the tag; the commit it points to; optional external
  evidence (a changelog commit, an npm publish by another actor).
- **Intended outcome:** the engine classifies instead of crashing: does
  existing state satisfy P, or does it conflict with P?
- **Expected release decision:** tag at the intended commit + consistent
  evidence → satisfied-externally: P completes as a no-op with external
  provenance recorded (ledger-first done-ness: done is a property of
  the recorded state, not of who executed it). Tag at a **different**
  commit, or partial/inconsistent evidence → conflict: refuse and
  escalate; never silently re-plan (that is E-11's separate trap) and
  never silently proceed.
- **Expected versions:** satisfied: `1.5.0` (external, adopted).
  Conflict: none applied.
- **Affected release lines:** the line on `main`.
- **Expected artifacts:** satisfied: artifact audit — which of P's
  artifacts exist externally, which must still be produced (or
  deliberately skipped, each skip recorded). Conflict: a report naming
  both commits.
- **Expected transitions:** P: planned → completed(external, evidence)
  or blocked(conflict). The distinction is explicit — an external
  completion is not a failure.
- **Expected failure behavior:** naive execution dies with "tag
  already exists" (an error whose recovery is undocumented); naive
  success overwrites a foreign tag or double-publishes. The decision
  must consult: commit identity, evidence completeness, plan
  preconditions — in that order.
- **Identity requirements:** done-ness is evaluated against recorded
  state (ledger/tag/registry), with provenance attached; replay
  requires an idempotency key (plan id + target) so the second runner
  recognizes the first's work.
- **State requirements:** reconciliation semantics for "intended state
  already partially exists" as a first-class outcome (satisfied /
  conflict), not an exception path.
- **Abstraction under stress:** the plan as an imperative script; it is
  a declarative target whose execution must be idempotent and
  reconciling. See E-04 (the world changed instead), E-09 (the world
  was changed deliberately).

#### E-04 — Policy flips under a stored plan

- **Lineage:** merged from B-17 (policy drift under a pending PR) + C-16
  (gate activation between plan and execute). Same trap: plan
  preconditions aged.
- **Class:** EXECUTION (precondition drift between plan and execution).
- **Initial state:** plan P stored on t0: target `1.5.0`, evidence
  bundle E1 (checks green), policy digest D1. On t1, before execution:
  the release policy is amended (a new required gate activates, or the
  branch-protection rule tightens).
- **Inputs:** P, D1; the amended policy D2; the gate states at t1.
- **Intended outcome:** execution re-reads policy at execute-time,
  detects D2 ≠ D1, and re-evaluates P under D2 rather than executing a
  plan validated under a dead rulebook.
- **Expected release decision:** if P satisfies D2 → proceed (recorded:
  revalidated under D2). If not → blocked with the delta (which
  precondition, which gate, what is missing); nothing consumed.
- **Expected versions:** proceed: `1.5.0`. Blocked: none — the tag is
  not placed, nothing partial exists.
- **Affected release lines:** the line on `main`.
- **Expected artifacts:** proceed: normal set, plus the revalidation
  record. Blocked: a precondition-failure report; the plan remains
  resumable once the gap closes (P-03's resumability).
- **Expected transitions:** P: planned → revalidating → executing, or
  planned → blocked(precondition-delta). The evidence bundle is
  re-linked, not blindly reused.
- **Expected failure behavior:** execute-what-was-stored ships a release
  that skips a gate activated mid-flight; refuse-everything-foreign
  blocks forever on a benign policy change. The correct behavior is
  revalidation, and the stored plan must carry enough (policy digest,
  precondition list) to make the delta computable.
- **Identity requirements:** plans reference the policy version they
  were validated under; verdicts are never cached across policy
  boundaries; every revalidation is recorded.
- **State requirements:** plan ↔ policy-version binding; gate states
  queryable at execute time; the delta report as a durable artifact.
- **Abstraction under stress:** the plan as a frozen permission; it is
  a claim that must be re-proven against the current rulebook at the
  moment of execution. See PL-08 (the change set moved instead) and
  E-03 (the target state exists instead).

#### E-05 — Retry must reproduce the same plan (time is an input)

- **Class:** EXECUTION (plan purity; retry semantics).
- **Initial state:** release `1.5.0` computed at T0: notes dated
  2026-09-05, artifacts built, digests recorded. The run dies before
  publishing. Retry executes at T2 (hours later).
- **Inputs:** the plan from T0; wall-clock time at T0 and T2; the
  recorded digests.
- **Intended outcome:** the retry executes the **same plan** — same
  notes, same digests, same everything — because the plan enumerated
  its inputs at T0 and froze them; wall-clock time is not read during
  execution.
- **Expected release decision:** release `1.5.0` exactly as planned at
  T0; the retry is a continuation, not a recomputation.
- **Expected versions:** `1.5.0`; the ledger's plan hash at T2 equals
  the one at T0 (equality proof recorded).
- **Affected release lines:** the line on `main`.
- **Expected artifacts:** artifacts whose metadata timestamps are the
  frozen T0 values (or explicitly designated fields), not T2's; the
  same digests as computed at T0.
- **Expected transitions:** attempt A (failed) → attempt B (resumed,
  same plan id); the release record shows one plan, two attempts.
- **Expected failure behavior:** a plan that reads the clock during
  execution produces different bytes at T2 (dated notes, timestamps) —
  the retry is a _different release_ wearing the same version, and
  verification against the T0 digests fails. Undated nondeterminism
  (random ids, environment-dependent paths) is the same defect.
- **Identity requirements:** the plan is a pure function of enumerated
  inputs (repo state at a commit, config, policy digest, frozen
  time); the plan hash is the identity proof; execution consumes the
  hash, never recomputes.
- **State requirements:** plans serialized with input digests;
  execution-time recomputation limited to precondition _verification_
  (E-04), never value recomputation.
- **Abstraction under stress:** "just run it again" — retry of an
  impure process is a different process; determinism must be
  constructed by freezing inputs, time included.

#### E-06 — The foreign tag: resume-by-inference trap

- **Class:** EXECUTION (foreign state with a plausible story).
- **Initial state:** attempt A died before any tag. A human,
  reconstructing the release by hand, pushes tag `v1.4.2` at commit
  `abc123` — the same commit the attempt would have tagged, with the
  version the plan computed.
- **Inputs:** the plan (target `1.4.2`); the tag `v1.4.2` at `abc123`
  (note: `v`-prefixed — the anomaly itself); no matching ledger record.
- **Intended outcome:** the engine treats the tag as **unattributed
  foreign state**: never resume-by-inference ("a tag with my version
  exists → my attempt must have succeeded"). It stops and asks.
- **Expected release decision:** no automatic continuation. Options
  presented (adopt the tag as the release, void it and re-tag bare
  `1.4.2`, abort): attribution (who/what created it) decides, and a
  human provides it.
- **Expected versions:** adopt: `1.4.2` released (with the tag-name
  anomaly recorded, and a normalization policy applied — the `v` form
  is what the kernel's parser rejects, ADR-0001 decision 4). Void: tag
  deleted, release proceeds as `1.4.2` with the bare tag.
- **Affected release lines:** the line on `main`.
- **Expected artifacts:** per choice; the decision record always.
- **Expected transitions:** plan: planned → blocked(unattributed-state)
  → (human decision) → resumed or re-planned.
- **Expected failure behavior:** inference resumes: the engine marks
  the release complete on the strength of a tag it did not create —
  attribution now impossible, artifacts may not exist, the tag name
  violates policy, and the human's intent (maybe they wanted `1.4.3`)
  is overwritten. Existence is evidence of _something_, never of _my
  success_.
- **Identity requirements:** attribution beats observation: state is
  adopted only with provenance (who, what, when); unverifiable state
  blocks the path that would depend on it.
- **State requirements:** the execution ledger (its absence here is the
  point); a blocked-on-foreign-state outcome with a human-resolution
  path.
- **Abstraction under stress:** state convergence as evidence of
  execution; a resumable system must distinguish "my work" from "work
  that looks like mine."

#### E-07 — Two CI jobs release the same line concurrently

- **Class:** EXECUTION (concurrent attempts on one line).
- **Initial state:** a retried workflow and the original overlap:
  runners R1 and R2 both plan release `1.5.0` from commit `abc123` on
  `main`, seconds apart. No distributed lock exists yet.
- **Inputs:** both attempts; the shared line; the tag namespace; the
  registry.
- **Intended outcome:** exactly one wins; the loser detects the winner
  and exits without corrupting anything. Version allocation and tag
  placement are serialized by a claim (tag push as compare-and-swap:
  first push wins; the loser's push is rejected).
- **Expected release decision:** one release `1.5.0`; the loser records
  `abandoned(follower of R1)`.
- **Expected versions:** `1.5.0` published once.
- **Affected release lines:** the line on `main`.
- **Expected artifacts:** one artifact set; the loser's partial local
  artifacts (built tarball) are discarded, recorded as waste.
- **Expected transitions:** R1: claim → execute → published. R2:
  claim-fails → follower → abandoned. Both transitions recorded.
- **Expected failure behavior:** the naive interleavings are all
  corrupting: both tag (second tag is a no-op or an error, but both
  proceed to publish); both publish to a permissive registry (two
  tarballs for `1.5.0`); both move channels (last-writer-wins hides
  the race). The claim must be acquired **before** any mutation and
  its loss must be detectable _after_ every step (fencing tokens, or
  re-verify ownership before each write).
- **Identity requirements:** the claim binds (line, next version,
  attempt id); every mutating step re-checks ownership; the loser's
  abandonment is attributed, not silent.
- **State requirements:** a claim mechanism on the line's next version
  (tag CAS, lease with fencing, or a lock service — parameters are an
  open fork); attempts carry their claim token.
- **Abstraction under stress:** "the attempt is alone in the world" —
  version allocation is a distributed-consensus problem in miniature.
  See E-08 for the allocation-race variant.

#### E-08 — Two runs compute the same rc number

- **Class:** EXECUTION (concurrent prerelease allocation).
- **Initial state:** no `1.6.0-rc.*` tags exist. Runs triggered by
  commits `abc123` and `def456` (def456 lands moments after abc123)
  both compute "next rc = `1.6.0-rc.1`" from the same empty tag set.
- **Inputs:** both runs; the shared prerelease sequence; the tag
  namespace.
- **Intended outcome:** the sequence stays injective: one run gets
  `rc.1`, the other `rc.2` (or one is refused with an explicit
  conflict) — decided by claim order, not by who pushed first, and
  both outcomes are recorded.
- **Expected release decision:** two prerelease publications with
  distinct sequence numbers, ordered by claim acquisition; the second
  run's changelog covers its own commit only (its base is abc123's
  publication).
- **Expected versions:** `1.6.0-rc.1` (abc123) and `1.6.0-rc.2`
  (def456) — or an explicit conflict for the second if policy
  serializes rc runs.
- **Affected release lines:** the line on `main`, stream `rc`.
- **Expected artifacts:** two prerelease tags; two changelog sections;
  if both publish to a registry channel, the channel moves land in
  claim order (see AR-04 for channel vs version ordering).
- **Expected transitions:** the rc stream head advances twice,
  monotonically; the loser of the initial CAS recomputes from the
  winner's tag (max-by-precedence over the stream) and retries once —
  bounded retry, then refuse.
- **Expected failure behavior:** the naive read-max-then-write protocol
  mints two artifacts both claiming `rc.1`: in a shared coordinate
  space (npm, container registry) the second publish either fails
  confusingly or silently overwrites. Version → content must be
  injective per line+stream; allocation must be claim-verify-write,
  never read-compute-write.
- **Identity requirements:** sequence allocation is atomic per
  (line, target, stream); the injectivity invariant is checked at
  write time (tag must not exist, publish must not exist).
- **State requirements:** the claim primitive reused from E-07,
  scoped finer (line+stream+target); bounded retry on CAS loss.
- **Abstraction under stress:** monotonic sequence allocation without a
  central counter; E-07's claim, refined.

#### E-09 — Human intervention: abort, PR edit, force-push

- **Class:** EXECUTION (deliberate external mutation mid-release).
- **Initial state:** release `1.5.0` from `abc123` is mid-attempt: tag
  pushed, ledger partially filled. The operator aborts the run, edits
  the release PR (minor → major intent), and force-pushes `def456` to
  `main`.
- **Inputs:** the abort; the PR edit; the force-push; the ledger; the
  orphaned tag `1.5.0`.
- **Intended outcome:** the engine stops cleanly: the in-flight attempt
  is **abandoned-by-human** (a terminal state, not a retryable
  failure); the orphan tag is recorded and surfaced (delete it? keep
  it? — ask); a fresh plan computes `2.0.0` from `def456`.
- **Expected release decision:** no completion of the old attempt; a
  new plan (target `2.0.0`) after explicit operator confirmation; the
  abort is honored as authoritative.
- **Expected versions:** `1.5.0` unpublished (tag orphaned, recorded);
  next release `2.0.0` from `def456`.
- **Affected release lines:** the line on `main`.
- **Expected artifacts:** a decision record for the abandonment; an
  orphan-tag record (tag, commit, disposition — deleted or kept);
  fresh release artifacts for `2.0.0` later.
- **Expected transitions:** attempt: executing →
  abandoned-by-human; the released-version pointer never moved; the
  pending change set absorbs both abc123 and def456 content.
- **Expected failure behavior:** an engine that "helpfully" retries
  after the abort publishes a release the operator explicitly killed —
  the worst outcome. An engine that treats the force-push as
  ordinary-new-commits (PL-08's regeneration path) without noticing
  the _abort_ overrides the plan. Human intent is the highest-precedence
  input; the ledger records it.
- **Identity requirements:** human actions (abort, force-push) are
  attributed events with precedence over automation; orphaned
  external state (the tag) is tracked until dispositioned.
- **State requirements:** attempt states include human-terminal
  outcomes; an orphan registry for external effects awaiting
  disposition; the abort decision persisted.
- **Abstraction under stress:** automation as the sole actor; the
  correct continuation is sometimes _stopping_. Contrast E-03 (the
  world moved benevolently) and E-04 (the rules moved).

#### E-10 — Clock and ordering anomalies

- **Class:** EXECUTION (time is not an ordering oracle).
- **Initial state:** a maintenance branch's commit history carries an
  author date anomaly: child C2 has author date 2026-08-20, parent C1
  2026-09-01 (rebase, import, or clock skew); C2's committer date is
  correct. Separately: a nightly build stamped from a runner whose
  clock is a day behind.
- **Inputs:** the anomalous history; the nightly stamping policy; the
  import that produced it (timestamps normalized to 2027-01-01 by the
  VCS — an artifact of the import tool).
- **Intended outcome:** ordering decisions use **topology**
  (parent-before-child), never wall-clock dates; the nightly stamp is
  allocated from the build-time input frozen into the plan (E-05's
  purity rule) and is not used for ordering at all — it is a label.
- **Expected release decision:** releases compute normally over the
  anomalous history; the nightly's version string embeds the stamp
  (`1.5.0-nightly.20260905.abc123`-style) but no behavior keys off the
  stamp's ordering.
- **Expected versions:** per the pending change sets; nightly stamps
  are labels, not sequence numbers.
- **Affected release lines:** the maintenance line (history anomaly);
  the nightly channel (stamp anomaly).
- **Expected artifacts:** changelog sections ordered by topology;
  nightly artifacts carrying the stamp; no artifact of "date-sorted"
  processing.
- **Expected transitions:** none anomalous — the point is that none
  occur despite the malformed input.
- **Expected failure behavior:** a changelog built by sorting commits
  on author date reverses causality (the child's fix listed before
  the parent's feature it depends on); a release-detection rule "newer
  than last release tag by date" misfires when dates lie; a
  timestamp-derived nightly sequence (date-only stamps) collides when
  two nightlies run the same (skewed) day — the stamp must include
  enough entropy (commit sha) to stay unique, or be sequence-allocated
  under a claim (E-08's discipline).
- **Identity requirements:** ordering derives from graph topology;
  timestamps are labels allocated at a defined moment and frozen;
  uniqueness comes from identity components (sha), never from clock
  resolution.
- **State requirements:** the walk policy (topological, first-parent
  for release ranges — PL-05c) recorded; nightly stamp inputs
  enumerated and frozen.
- **Abstraction under stress:** wall-clock time as ordering and as
  identity; git dates are data, not truth.

#### E-11 — Plan from stale state: hotfix interleave

- **Class:** EXECUTION (stale plan; range re-computation at execute
  time).
- **Initial state:** plan P1 targets `1.5.0` with range `1.4.1..abc123`
  on `main`. While P1's release PR is open: `1.4.2` is published from
  elsewhere (hotfix line interleave), and two commits land on `main`
  (head now `xyz789`).
- **Inputs:** P1 (frozen range, target `1.5.0`); the new released
  version `1.4.2`; the new head `xyz789`.
- **Intended outcome:** at execution time P1 is validated against
  current state and found stale on **both** axes: its base version
  (`1.4.1` is no longer the released head — `1.4.2` is) and its range
  (head moved). The engine recomputes rather than executing the
  snapshot.
- **Expected release decision:** re-planned P2: target stays `1.5.0`
  (its bump is computed against the _new_ base `1.4.2`, and the
  pending change set justifies the same minor), range
  `1.4.2..xyz789`; P1 superseded (PL-08's supersession semantics,
  triggered at execution instead of at PR time).
- **Expected versions:** `1.5.0` — but the version is **not** the plan:
  same target, different content set than P1 planned. (Had the hotfix
  been `1.5.0`-shaped or the new commits breaking, the target itself
  would move — E-04/PL-08 mechanics.)
- **Affected release lines:** the line on `main`; the hotfix line
  (already released `1.4.2`).
- **Expected artifacts:** release notes covering `1.4.2..xyz789` —
  exactly the delta; no silent swallowing of the two new commits; the
  superseded P1 logged.
- **Expected transitions:** P1 → superseded(stale-at-execution); P2 →
  planned → executed. The pending change set drains fully: nothing
  from `abc123..xyz789` is left stranded.
- **Expected failure behavior:** execute-the-snapshot ships a `1.5.0`
  whose notes and change set are wrong (they miss two commits and
  assume base `1.4.1`); a naive re-computation that only bumps
  ("already computed `1.5.0`, just re-run") without re-deriving the
  range produces the same wrong notes. Version equality must never
  short-circuit plan equality.
- **Identity requirements:** the plan is bound to (base version, range,
  target, change-set hash); execution re-verifies all four; equality
  of any one never implies equality of the plan.
- **State requirements:** the released-version pointer re-read at
  execution; plan validation includes base-version freshness; PL-08's
  fingerprint check available at execute time, not only at PR time.
- **Abstraction under stress:** the plan as a snapshot executed blind;
  staleness has two axes here (base and tip) and each demands
  re-derivation, not patching.

### PROMOTION

#### PR-01 — Promote without rebuild: the bytes are the contract

- **Class:** PROMOTION (promotion; artifact immutability).
- **Initial state:** `1.2.0-rc.1` published: npm tarball, container
  image, checksums file. Operator intent: "promote this exact build to
  stable `1.2.0`."
- **Inputs:** the rc artifacts (content digests recorded at rc
  publication); the promotion request.
- **Intended outcome:** `1.2.0`'s artifacts are the **same bytes** as
  rc.1's; the promotion re-binds identity (tag, channels, GitHub
  Release) to existing content — no rebuild happens.
- **Expected release decision:** promotion as release event (P-03's
  mechanics) with a strict no-rebuild contract.
- **Expected versions:** `1.2.0`; every artifact digest equals the rc.1
  digest it was promoted from — digest equality is the promotion's
  precondition.
- **Affected release lines:** the line on `main`; the `rc` stream
  closes; channels `next`/`stable` move.
- **Expected artifacts:** stable tags/labels applied over the identical
  digests; stable checksums re-published but byte-identical to the
  rc checksums.
- **Expected transitions:** release `1.2.0-rc.1` → promoted-from edge →
  release `1.2.0` (same generation, new identity bindings); channel
  moves recorded.
- **Expected failure behavior:** any rebuild under the promotion (even
  byte-identical-by-luck) breaks the contract: if digests differ, the
  release is a different body wearing `1.2.0` — hard fail, the
  operator must choose the rebuild path (PR-02) explicitly. Verify
  before bind: fetch rc artifacts, compare digests, only then move
  channels.
- **Identity requirements:** the artifact generation is immutable;
  promotion binds identity, never regenerates; digest equality is
  checkable at promotion time.
- **State requirements:** recorded digests per published artifact;
  promotion as a distinct operation type (bind, not build) in the
  ledger.
- **Abstraction under stress:** N6 — a version is an assertion over
  immutable bytes; "promote" that rebuilds silently lies about what it
  asserted.

#### PR-02 — Promote with rebuild: two bodies, one version name

- **Class:** PROMOTION (promotion; tracked generations).
- **Initial state:** the rc artifacts cannot satisfy the stable pipeline
  (signing cert rotated, provenance attestation required on stable
  only). A rebuild is genuinely necessary to promote `1.2.0-rc.1` →
  `1.2.0`.
- **Inputs:** the rc digests; the rebuild requirements; the source
  commit.
- **Intended outcome:** rebuild permitted **deliberately**: the tool
  produces stable artifacts from the same source commit, records both
  generations (`gen-1` rc bytes, `gen-2` stable bytes), and publishes
  the stable set — the old generation remains resolvable, nothing is
  overwritten.
- **Expected release decision:** promotion with rebuild, recorded as
  such (a first-class operation, not a silent deviation from PR-01's
  default).
- **Expected versions:** `1.2.0`; version name shared by two
  generations, distinguished by generation id and digest — the version
  is not the bytes (N6 inverted: this is the model _admitting_ the
  gap, not hiding it).
- **Affected release lines:** the line on `main`.
- **Expected artifacts:** stable artifact set (gen-2); gen-1 retained
  (rc channel keeps serving it); provenance states
  same-source-rebuild-of.
- **Expected transitions:** generation gen-1 (published, rc) and gen-2
  (published, stable) both linked to release `1.2.0`; channels move to
  gen-2.
- **Expected failure behavior:** untracked rebuild = the naive hazard:
  `1.2.0` silently means different bytes at different times, and no
  one can prove which body a bug report refers to. Equals-vs-compare:
  the kernel offers structural equality and build-metadata semantics
  (ADR-0001 decision 6) — generations make that distinction _usable_.
  The rebuild must fail loudly if the source commit moved.
- **Identity requirements:** artifact generation as a first-class,
  append-only concept; every published body traceable to (release,
  generation, source commit, digest).
- **State requirements:** a generation table per release; channels
  point at generations, not at "the version."
- **Abstraction under stress:** N6 from the other side — when reality
  forces a second body, the model must already have a place to put it
  without breaking the first.

#### PR-03 — Stale evidence: promotion must re-prove

- **Class:** PROMOTION (evidence freshness).
- **Initial state:** rc.1 validated at T0 (evidence bundle E1: tests,
  scans, soak results). The promotion to stable is requested at T0 + 9
  days; policy TTL for evidence is 7 days. The revalidation run now
  fails (a dependency advisory landed mid-window).
- **Inputs:** E1 with its T0 timestamps; the TTL policy; the request
  time; the failed revalidation.
- **Intended outcome:** the tool refuses the promotion on stale
  evidence, attempts revalidation, and reports the revalidation
  failure — two distinct findings, neither masked by the other.
- **Expected release decision:** blocked: `evidence-stale →
revalidation-required → validation-failed`. Nothing is consumed; the
  release stays planned.
- **Expected versions:** none minted; `1.2.0` untagged.
- **Affected release lines:** the line on `main`; `rc` stream stays
  open.
- **Expected artifacts:** the failure report (what expired, what
  failed, when); no stable artifacts.
- **Expected transitions:** promotion request → blocked(validation);
  resumable: fix the finding, rerun validation, promote with fresh
  evidence.
- **Expected failure behavior:** "validated once, valid forever"
  promotes on 9-day-old evidence past a newly-known CVE; the opposite
  error conflates staleness with failure (operator re-runs the whole
  release instead of just the validation). The three-state chain must
  stay distinguishable.
- **Identity requirements:** evidence bundles carry their validation
  time and the exact artifact digests they cover; TTL is policy, not
  folklore; the covered-digest binding survives (E-04's revalidation
  reuses it).
- **State requirements:** evidence store queryable by (digest, kind,
  validated-at); the blocked-but-resumable state for the promotion.
- **Abstraction under stress:** "validated" as a permanent property;
  it is a state with a clock attached.

#### PR-04 — Backward channel move: rollback as a recorded event

- **Lineage:** merged from A-18 (stable rollback: channel CAS + event
  log) + C-05 (dist-tag rollback: instance semantics, stale replay).
  Same operation — a channel moving backwards — at the release-engine
  and registry-binding layers; taxonomy R5 pins both as channel
  mutation events.
- **Class:** PROMOTION (channel move; rollback).
- **Initial state:** three layers, one intent. (a) The `stable` channel
  points at release `1.2.0`; the operator rolls back to `1.1.9`. (b)
  The npm `latest` dist-tag points at `1.2.0`; the rollback must move
  this instance. (c) A stale automation replays an old "move stable to
  1.5.2" command after the rollback already happened.
- **Inputs:** the rollback request (target channel, from, to); the
  channel event log; the replayed command; current channel states.
- **Intended outcome:** (a) `stable` moves `1.2.0` → `1.1.9` as a
  **recorded event** with reason and actor — a rollback is a normal,
  auditable operation, never a deletion or a rewrite. (b) The npm
  dist-tag move is the same event's backend binding, executed with
  expected-prior-state CAS (`from: 1.2.0`) so concurrent moves cannot
  interleave. (c) The replay is rejected: its expected prior state
  (`1.1.9`? `1.2.0`?) no longer matches, and the event log already
  contains the rollback — stale replays fail toward a human, not
  toward a silent second move.
- **Expected release decision:** no new release; one channel-mutation
  event (a), one CAS-guarded binding move (b), one rejected stale
  command (c).
- **Expected versions:** `1.2.0` remains published and fully resolvable
  — rollback hides, never erases.
- **Affected release lines:** the line on `main` (channel state only;
  the released-version pointer is unchanged — the line still ends at
  `1.2.0`).
- **Expected artifacts:** none created or destroyed; npm `latest` moves
  to `1.1.9`; the event log gains the record.
- **Expected transitions:** channel `stable`: `1.2.0` → `1.1.9`
  (recorded); the rejected replay produces no transition, only a
  report.
- **Expected failure behavior:** implementing rollback as manifest
  reversion + re-release mints `1.1.9` twice (colliding with the
  real one) or a fake `1.1.9+build`; implementing it as deletion
  breaks every consumer's lockfile history; the naive replay (c)
  executed blind would yank `stable` back to `1.5.2` against the
  operator's just-expressed intent. CAS + event log + "what did
  stable serve between T1 and T2?" as a queryable property.
- **Identity requirements:** channel state is a pointer with a
  history; moves are events (from, to, actor, reason, time); the
  expected-prior-state is part of every move command (CAS).
- **State requirements:** the channel event log; the served-window
  query (which version did this channel deliver in [T1, T2)); the
  replay-protection (idempotency keys on commands).
- **Abstraction under stress:** channels as current-state-only; a
  rollback that leaves no record is indistinguishable from the release
  never having happened — which is a lie consumers can detect.

#### PR-05 — One release, many channels, over time

- **Class:** PROMOTION (channel membership over time).
- **Initial state:** channels `stable` and `next`; release `1.3.0`
  ships to `next` at T1, is promoted to `stable` at T1 + 7d
  (gradual-rollout policy).
- **Inputs:** the release; the two channels; the rollout policy
  (dwell time); the promotion trigger (timer + a green health check).
- **Intended outcome:** `1.3.0` is a **member** of `next` from T1 and
  of `stable` from T1+7d; membership history is per (release,
  channel): two edges, each with its own lifetime; the release is
  never "in" a channel globally — the question is always "member
  when?"
- **Expected release decision:** one release, two sequential channel
  memberships; the stable promotion is automatic under the policy but
  recorded with its trigger evidence.
- **Expected versions:** `1.3.0`; `next` and `stable` both serve it
  after T1+7d (until something newer ships).
- **Affected release lines:** the line on `main`.
- **Expected artifacts:** none new; consumers' views are channel-scoped
  and time-scoped.
- **Expected transitions:** `next` membership: added T1 → superseded
  when a newer release ships to `next`; `stable` membership: added
  T1+7d with the promotion record. A retraction (negative promotion)
  removes future membership, never history.
- **Expected failure behavior:** modeling "released" as one boolean
  (N5) cannot answer "which channel served 1.3.0 on Thursday?" — the
  question every incident review asks. The naive fix (a status enum)
  still loses the `next` tenure after the `stable` promotion. Membership
  is a graph with a timeline, not a state.
- **Identity requirements:** membership edges are first-class:
  (release, channel, from, to, cause); every view ("what does stable
  serve now") is a query over edges, never a stored scalar.
- **State requirements:** the membership graph; policy metadata
  (dwell, triggers) attached to the transitions; retraction recorded
  as an event (PR-04's discipline).
- **Abstraction under stress:** N5 — release status as a single
  mutable flag; deliveredness is (channel × time), not a property of
  the release.

## Open forks this matrix deliberately retains

The scenarios generate decision pressure; the forks are the questions
that pressure exposes. None is silently resolved here.

1. **Chore/docs/ci-only history** → recorded no-op vs a "chore
   release" policy (S-01, PL-06).
2. **Bootstrap default** → `1.0.0` vs `0.1.0` for the first release,
   and where the bootstrap decision is recorded (S-02).
3. **Stream restart on target move** → keep the identifier with a
   reset sequence (`2.0.0-rc.0`, this matrix's default) vs restart the
   ladder at `alpha` (P-05).
4. **Fixed ladder vs open identifiers** → is `alpha → beta → rc` the
   only legal progression, or may lines define arbitrary ordered
   streams? (P-02, M-08.)
5. **Half-published recovery doctrine** → complete-in-place vs
   void-and-skip after a crash past the tag boundary, and which
   failures force which (E-01, E-02, AR-05).
6. **Rollback posture** → channel-move rollback only, or a first-class
   "re-release" concept for registry immutability violations (PR-04).
7. **Evidence TTL ownership** → who sets validation freshness (policy
   file vs gate config) and per-kind TTLs (PR-03).
8. **Change-id marker convention** →
   `(cherry picked from commit …)` trailer vs a footer-style change-id
   vs both accepted (M-03, M-05).
9. **Range-cursor deferral** → cursor never advances past
   filtered/withheld/abandoned changes: confirmed here as the
   invariant; the fork is the discard protocol (who may explicitly
   drop a withheld change) (PL-06, PL-07, M-10).
10. **Breaking-on-non-releasing-type** → force the major bump
    (recommended) vs hard-error demanding a commit retype (PL-05b).
11. **Per-package tag naming** → `lib-a-1.2.1` vs `lib-a/v1.2.1` vs
    other, under the kernel's bare-semver parse of the version
    component (PL-01, M-11).
12. **Dependent bumps on compatible ranges** → bump dependents
    manifest+lockfile always, never, or only when the lockfile
    actually changes (PL-02 case 1).
13. **Claim mechanism parameters** → git-tag CAS vs lease+fencing
    tokens vs a lock service; retry bounds on CAS loss (E-07, E-08).
14. **One stale-plan policy or several** → a single invalidation
    framework with per-cause parameters (target/base/policy/change
    set) vs distinct paths per cause (P-05, PL-08, E-03, E-04, E-09,
    E-11).
15. **Nightly as line-release vs artifact class** → does a nightly
    allocate anything on the line, or is it purely a channel-scoped
    build? (AR-04, E-10.)
16. **Ledger/decision-record storage** → where execution ledgers and
    decision records live (repo files, notes refs, external store) —
    outside `core/domain/` in any case, per ADR-0001's purity boundary
    (E-01, E-02, S-01).
17. **First mint of a fresh sequence** → `.0` (P-02/P-05/P-07 all mint
    `beta.0`/`rc.0`/`rc.0` — this matrix's default, and what Phase 1's
    kernel records) vs `.1` (E-08's "next rc = `1.6.0-rc.1`" from an
    empty tag set; P-01's nine alpha runs leaving head `alpha.9`; M-08's
    first-ever `2.4.0-rc.1`). The `.1` bodies read as planner-side
    next-from-tags computations, not recordings of an advance — the
    kernel seeds at `.0` and a `.1`-first convention, if adopted, is
    planner policy over tags (recorded by decision-log D9).
    **Resolved 2026-09-06 (ADR-0003 decision 7, decision-log D13):** declared
    seed policy — `seed: .0` is the kernel default, `.1` by explicit line
    declaration; this entry's text stands unchanged.

## Stress analysis

Reading the 53 scenarios as evidence, the abstractions that fail most
often — ranked by how many scenarios each one fails — are the design
agenda for the release engine.

| Abstraction under stress                                              | Count | Scenarios                                          |
| --------------------------------------------------------------------- | ----- | -------------------------------------------------- |
| Release line as the scoping unit (line ≠ branch; per-line everything) | 17    | S-03, S-05, P-07, M-01–M-11, PL-01, PL-07, E-11    |
| Multi-step transaction: attempt + ledger + claims                     | 8     | E-01, E-02, E-07, E-08, AR-01, AR-02, AR-05, AR-06 |
| Negative decisions are records (no-op, refused, withheld, blocked)    | 8     | S-01, S-04, M-08, M-10, PL-03, PL-06, PL-07, PR-03 |
| Prerelease as per-stream identity, not a boolean                      | 7     | P-01–P-07                                          |
| Change identity ≠ SHA ≠ content hash                                  | 7     | M-03, M-04, M-05, M-06, M-09, PL-04, PL-05         |
| Attribution beats observation (who did it decides what it means)      | 7     | E-01, E-02, E-03, E-06, E-07, AR-05, AR-06         |
| Release plan as a first-class, invalidatable object                   | 6     | P-05, PL-08, E-03, E-04, E-09, E-11                |
| Artifact identity = digest; generations, not strings                  | 6     | AR-03, AR-04, AR-05, PR-01, PR-02, PR-04           |
| Dependency graph over messages (monorepo propagation)                 | 5     | PL-01, PL-02, PL-03, PL-05, PL-07                  |
| Race-safe allocation (claims, CAS, injectivity)                       | 3     | M-11, E-07, E-08                                   |
| Channels are auditable mutable pointers (event log, served-window)    | 3     | AR-04, PR-04, PR-05                                |
| Evidence expires (freshness is part of validity)                      | 3     | AR-02, E-04, PR-03                                 |
| Wall-clock time is never an ordering oracle                           | 2     | E-05, E-10                                         |

The five hardest, each in one sentence:

- **M-03** — change identity that is neither SHA nor content hash, yet
  survives divergent cherry-picks without fuzzy matching, is the
  purest data-model demand in the matrix.
- **S-03** — the ordering "line tag history outranks the manifest"
  must exist before any version arithmetic in this document means
  anything.
- **PL-08** — version equality must not imply plan identity, which
  forces content-sensitive plan fingerprints and explicit supersession
  chains, including under a concurrent merge (its own retarget path).
- **E-01** — an externally-visible step (the tag push) succeeded while
  everything else vanished: recovery must map tag existence to ledger
  state and choose complete-in-place vs void-and-skip
  deterministically.
- **E-08** — two allocators race for one ordinal in a shared
  coordinate space: version→content injectivity needs claim-verify
  protocols, not read-max-then-write.
