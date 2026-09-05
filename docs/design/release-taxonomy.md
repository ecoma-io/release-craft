# Release-process taxonomy

Phase 0 discovery artifact for [`release-craft`](https://github.com/ecoma-io/release-craft)
(issue context: orchestrated Phase 0 research, task 0C). This document maps the
release-process problem space into dimensions, classifies each against the core
domain, and analyzes the relationships that lock the Phase 0 vocabulary.

**Status:** discovery only. This is analysis, not a code change and not a
decision record (ADRs in `docs/adr/` hold decisions). It says nothing that
shipped in the product; the README's status section remains the honest one.

## Method and evidence labels

Every claim below is tagged with one of:

- **OBSERVED** — taken directly from a primary source I read (release-craft's
  own files, or a system's official documentation / source), cited inline.
- **INFERENCE** — reasoned from observed facts or from widely-known behaviour I
  did not re-verify against a primary source in this session.
- **RECOMMENDATION** — release-craft's position, argued, not observed.

Three judgment classes appear in every dimension entry:

- **FUNDAMENTAL DOMAIN CONCEPT** — belongs in `core/domain/`, because it
  constrains version semantics, identity, or release logic in a way that must
  be pure and dependency-free (the ADR's purity row).
- **ADAPTER/EXTENSION MECHANISM** — belongs at the edges: providers, hooks,
  configuration, integration code.
- **DEFERRED / OUT OF SCOPE** — not in the model yet, but the model must not
  preclude it.

The boundary rule that drives these judgments, OBSERVED from
[docs/adr/0001-domain-kernel-and-semantic-version.md](../adr/0001-domain-kernel-and-semantic-version.md):
the kernel may import nothing (no Node built-in, no npm package, no other
project), and "producing the next prerelease… is release-line policy, not value
semantics — it needs to know which channel it is on, and the kernel does not
know channels exist."

---

## 1. Dimensions

### 1.1 source/ref — the object a release is derived from

**Definition.** The input unit a tool reads to decide _what_ to release: a git
commit, a branch head, a tag, a manifest, a directory, a package. The "ref" is
the pointer; "source" is the thing it resolves to.

**What varies.**

- **OBSERVED** — `cargo-release` derives a release from the current git
  commit/branch: it runs `cargo publish` and applies "right branch" and
  "up-to-date with remote" preconditions
  ([`cargo-release` README](https://github.com/crate-ci/cargo-release)).
- **OBSERVED** — release-please and semantic-release derive from pushes to a
  configured branch; semantic-release also keys off the commit message grammar
  (Conventional Commits) on that ref (INFERENCE for the exact grammar linkage —
  widely documented, not re-read this session).
- **INFERENCE** — Chrome's source is not git but a build tree: a channel
  consumes many commits over a cycle and ships a composed build; the "ref" is
  a current-trunk snapshot, not one tagged commit.
- **OBSERVED** — changesets reads `.changeset/*.md` files plus package
  manifests in the working tree (OBSERVED from
  [`changesets` prerelease docs](https://changesets.dev/guide/prereleases));
  its "source" is files on disk, not a git ref.

**Judgment: FUNDAMENTAL DOMAIN CONCEPT.** A release engine must name the input
parent (commit, manifest set, tag set) to reason about change selection
(§1.7), propagation (§1.8), and identity. "A release is a release _of X_".
The _resolution_ of a ref (git plumbing, file reads) is an adapter at the
edge — but the released-from reference is part of release lineage and identity.
RECOMMENDATION: model a `source/ref` as a value (an opaque but comparable id),
kept pure; resolving it to files/commits is a provider.

### 1.2 branch — the git-lineage scoping device

**Definition.** A git branch: a movable pointer into commit history. In release
practice it is the most common _container_ that answers "which changes are on
this stream right now" (via `main..branch` or the branch's tip).

**What varies.**

- **OBSERVED** — semantic-release's "release branches" recipes let committed
  branches map to release _channels_ and influence prerelease formatting
  (INFERENCE on the exact recipe list — the canonical page 404'd this session;
  the feature itself is documented widely, e.g. `next`/`next-major` branches
  formatting `2.0.0-next.1`).
- **OBSERVED** — Chrome's channels are **not** git branches: Canary/Dev/Beta/
  Stable diverge by _testing stage_ and ship a fixed major "milestone" per
  cycle, with "Channel ≠ version"
  ([Chrome release channels](https://developer.chrome.com/docs/web-platform/chrome-release-channels)).
  This is the counter-example: a channel that exists without a branch.
- **INFERENCE** — backporting (§1.10) is almost universally expressed as cherry-picks
  between branches. A branch is where "which commits are candidates" is answered.
- **INFERENCE** — many tools (cargo-release "right branch", semantic-release's
  branch maps) treat the branch as the unit of "what am I releasing".

**Judgment: ADAPTER/EXTENSION MECHANISM.** Git branches are one concrete
scoping mechanism, not a domain concept. `release-craft` must not hard-code
"a release line is a git branch" — Chrome shows lines that are not branches,
and a provider (git, filesystem, a database of records) supplies the actual
change-set scoping. RECOMMENDATION: keep `branch` at the adapter layer; the
domain concept is the **release line** (§1.3) and the **change set** (§R4),
which a git-branch provider may back.

### 1.3 release line — the durable, ordered stream a product advances along

**Definition.** A named, durable stream of versions that move forward in
release order, tracked _across_ refs and time. A line has a head (latest
released/proposed version), a cadence or policy, and an ordered list of
members. It is the abstraction Chrome's "channel" names, and what a "maintenance
line" (v1.2 line patched while v1.3 develops) is.

**What varies.**

- **OBSERVED** — Chrome's per-channel version sequence ("a series of versions…
  deployed within each release channel") is a release line: each channel has its
  own ordered stream
  ([Chrome release channels](https://developer.chrome.com/docs/web-platform/chrome-release-channels)).
- **OBSERVED** — `changesets` "prerelease mode" is a line: `pre enter next`
  makes versions `-next.N` and exits back to the "normal" line (`pre exit`)
  ([`changesets` prereleases](https://changesets.dev/guide/prereleases)).
- **INFERENCE** — npm's `next` tag names the "upcoming version" stream while
  `latest` tracks stable (OBSERVED that `next` "is used by some projects",
  npm-dist-tag).
- **OBSERVED** — ADR-0001: "producing the next prerelease… is release-line
  policy… it needs to know which channel it is on, and the kernel does not know
  channels exist." This is release-craft's own statement that lines/channels
  are policy above the `Version` value
  ([ADR-0001](../adr/0001-domain-kernel-and-semantic-version.md)).

**Judgment: FUNDAMENTAL DOMAIN CONCEPT.** The release line is the spine of the
domain — the thing versions are ordered _on_ and channels are the _views into_.
It must exist in `core/domain/` (as a concept + policy folder) so lines,
channels, promotion and backport all speak one vocabulary. RECOMMENDATION: a
line is a value-ish identity with a head and policy; it is not "a branch".

### 1.4 channel — a named deliverability view over a line (or over releases)

**Definition.** A named slot that makes a _particular_ version (or artifact
variant) reachable by a consumer class: `stable`, `canary`, `next`, `beta`,
a Docker tag, an OS distribution stream. A channel answer is "what should
`npm install pkg` or `docker pull image:latest` give me?".

**What varies.**

- **OBSERVED** — Chrome has exactly four channels (Canary, Dev, Beta, Stable),
  each with its own version sequence and cadence; "channel ≠ version"
  ([Chrome release channels](https://developer.chrome.com/docs/web-platform/chrome-release-channels)).
- **OBSERVED** — npm dist-tags are arbitrary named aliases onto a version;
  `latest` is default, `stable/beta/dev/canary` are idiomatic, "no tag [other
  than latest] has any special significance to npm itself"
  ([npm-dist-tag](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag)).
- **OBSERVED** — changesets uses the prerelease tag _as_ the dist tag; e.g.
  `pre enter next` publishes to the `next` dist tag
  ([`changesets` prereleases](https://changesets.dev/guide/prereleases)).
- **INFERENCE** — Docker channel = a registry tag naming a distribution stream
  (`latest`, `slim`, `alpine`, `1.2`); also CI/progress semantics (`edge`).
- **OBSERVED** — semantic-release maps release branches to channels where the
  merged branch's commits determine the version shape (INFERENCE on exact
  recipe; page 404'd this session).

**Judgment: FUNDAMENTAL DOMAIN CONCEPT (with an adapter slice).** The _notion_
of a named channel that a version or artifact is promoted into is core: it is
what promotion (§1.11) mutates and what prerelease streams (§1.5) ride on.
But the _binding_ (npm tag, Docker tag, registry, apt repo, internal DB) is an
adapter. RECOMMENDATION: channel is a first-class domain identity (a name +
which line/view it selects from + the version it currently points at); the
_backend the channel maps onto_ (npm dist-tag, Docker tag) is a provider
(§1.12 artifacts, §1.6).

### 1.5 stable/prerelease — the maturity axis

**Definition.** A two-valued (or continuum) maturity classification of a
version: `stable` = production-safe, `prerelease` = pre-production (alpha,
beta, rc, nightly, canary). SemVer encodes it as the `-prerelease` suffix.

**What varies.**

- **OBSERVED** — the `Version` kernel treats prerelease as a grammar field with
  SemVer §11 precedence: numerics by value, numerics below alphanumerics, text
  in ASCII order ([`core/domain/version.ts`](../../core/domain/version.ts),
  ADR-0001 decision 6).
- **OBSERVED** — `bumpMajor`/`bumpMinor`/`bumpPatch` return **core-only**
  versions — prerelease stripped — per npm-semver convention: `1.2.3-rc.1` →
  `1.2.3`; producing the _next_ prerelease is deferred as line policy
  ([ADR-0001](../adr/0001-domain-kernel-and-semantic-version.md), decision 7).
- **OBSERVED** — changesets decrees stability by whether prerelease mode is
  entered/exited: `1.0.0-beta.0` → exit → `1.0.0`
  ([`changesets` prereleases](https://changesets.dev/guide/prereleases)).
- **INFERENCE** — npm `latest` conventionally holds stable while `next`/`beta`
  hold prereleases (OBSERVED idiom in npm-dist-tag docs).
- **OBSERVED** — Chrome's maturity axis is the _channel_ (Canary→Dev→Beta→
  Stable), a ladder of increasing stability
  ([Chrome release channels](https://developer.chrome.com/docs/web-platform/chrome-release-channels)).

**Judgment: FUNDAMENTAL DOMAIN CONCEPT.** Stability is not purely a string
flag — it is the domain's mechanism for ordering and for controlling reach.
SemVer already encodes it in `Version` (OBSERVED). RECOMMENDATION: keep
`stable/prerelease` as a property **derived from the version plus its line
policy** — the kernel knows the grammar; the line policy decides whether a
prerelease belongs to a channel. The maturity _transition_ (prerelease→stable)
is promotion (§1.11), not a version concern.

### 1.6 version stream — the ordered sequence of versions a line produces

**Definition.** The monotonic, ordered history of versions assigned to a line
over time: `1.0.0 → 1.0.1 → 1.1.0 → 2.0.0` or the prerelease-spaced
`1.1.0-next.0 → 1.1.0-next.1 → 1.1.0`. The stream is what backport, promotion
and dependency solving (§1.10, §1.11, §1.9) consume.

**What varies.**

- **OBSERVED** — the kernel's `compare` implements SemVer §11 precedence over
  the whole stream, build metadata ignored; `equals` is structural (build
  retained) — the two relations must not be conflated
  ([ADR-0001](../adr/0001-domain-kernel-and-semantic-version.md), decision 6).
- **OBSERVED** — changesets advances a prerelease stream by re-running
  `version`: `1.0.0-next.0 → 1.1.0-next.1` as changesets accumulate
  ([`changesets` prereleases](https://changesets.dev/guide/prereleases)).
- **OBSERVED** — cargo-release bumps within/between crates and updates dependent
  crates' requirements when a version changes
  ([`cargo-release` README](https://github.com/crate-ci/cargo-release)).
- **INFERENCE** — npm `next` traces the upcoming-version stream while `latest`
  holds the released one (OBSERVED idiom, npm-dist-tag).

**Judgment: FUNDAMENTAL DOMAIN CONCEPT.** The version stream _is_ the ordered
backbone; `Version.compare` is already its ordering primitive. RECOMMENDATION:
the stream is a derived view over a line (§1.3) — not a separate stored entity,
but a query the model must answer (head, next, gaps, history).

### 1.7 change selection — which changes belong to a release

**Definition.** The decision of which candidate changes (commits/changesets)
are grouped into a particular release's change set. This is the heart of
"release planning".

**What varies.**

- **OBSERVED** — semantic-release/keyword-driven (Conventional Commits) picks
  commits by type to decide the bump, then assembles them into one release
  (INFERENCE on exact grammar; the canonical recipe page 404'd this session).
- **OBSERVED** — changesets asks the _author_ to declare a change explicitly in
  a `.changeset/*.md` file with a bump level; nothing is shipped unless a
  changeset names it (INFERENCE on the file grammar; OBSERVED that prerelease
  mode re-versions accumulated changesets).
- **OBSERVED** — cargo-release does "change detection to help guide in what
  crates might not need a release"
  ([`cargo-release` README](https://github.com/crate-ci/cargo-release)).
- **OBSERVED** — release-please derives release notes and version bumps from
  Conventional Commit subjects scoped per path (INFERENCE on scope mapping —
  widely documented; not re-read).

**Judgment: FUNDAMENTAL DOMAIN CONCEPT.** Deciding _which changes constitute a
release_ and the resulting bump is the domain's primary reasoning. The _sources
of evidence_ (git log, changeset files, an AI-triaged list) are adapters.
RECOMMENDATION: model change selection as a core operation over a `Change` set
(§R4) that yields a planned version bump; the classifier that turns
evidence into changes is a policy/provider at the edge.

### 1.8 change propagation — changes flowing between lines/streams

**Definition.** Where a change appears after release — how a change that
entered one line becomes present (or absent) in another (e.g. a fix merged to
`main` that must reach a maintenance line, or a change that "rides" a channel).

**What varies.**

- **INFERENCE** — the classic pattern: merge to trunk, cherry-pick the same
  commit to maintenance branches; the same _logical change_ exists in multiple
  lines with different commits.
- **OBSERVED** — `changesets` forces propagation by _bumping dependents_: a
  prerelease of a dependency (`5.1.0-next.0`) forces its dependents to
  prerelease too because semver ranges stop matching
  ([`changesets` prereleases](https://changesets.dev/guide/prereleases)). That is
  propagation driven by the dependency graph (§1.9), not just git.
- **OBSERVED** — Chrome's staged rollouts move one change through Canary→Dev→
  Beta→Stable channels, propagation as a _promotion ladder_
  ([Chrome release channels](https://developer.chrome.com/docs/web-platform/chrome-release-channels)).

**Judgment: DEFERRED/OUT OF SCOPE for the first model — but MUST NOT preclude.**
Propagation is a cross-line concern that depends on change identity (§R4),
lines and the dependency graph. It is real and core-shaped, but release-craft's
first model can describe it _derivatively_ (a change is present in a line if its
source ref/commit appears in that line's change set). RECOMMENDATION: model
change _identity_ and _line membership_ now so propagation can be computed
later; do not build a propagation engine yet.

### 1.9 dependency graph — package/component dependencies

**Definition.** The directed graph of how artifacts/packages/components depend
on one another (edges = "A depends on B at range R"). It constrains release
ordering (bump B before A), compatibility, and prerelease propagation.

**What varies.**

- **OBSERVED** — cargo-release "updates dependent crates in workspace when
  changing version" and uses "change detection to help guide in what crates
  might not need a release"
  ([`cargo-release` README](https://github.com/crate-ci/cargo-release)).
- **OBSERVED** — changesets bumps dependents automatically because a prerelease
  version stops satisfying their semver ranges
  ([`changesets` prereleases](https://changesets.dev/guide/prereleases)).
- **INFERENCE** — a monorepo with 100 packages and a loose coupling between
  "logical change" and "which packages it touches" is where the graph matters
  most; a single-package tool (semantic-release default) has a trivial graph.
- **INFERENCE** — Nx release computes targetProjects/affected from the project
  graph (widely documented; not re-read this session).

**Judgment: ADAPTER/EXTENSION MECHANISM.** The _fact_ that packages depend on
each other and that release ordering follows it is domain-shaped, but the
graph _representation_ (registry lockfile, workspace project graph, OCI image
layers) is an adapter. RECOMMENDATION: model a narrow, pure `dependency edge`
(“release of A requires/depends on release of B”) as a domain concept only
insofar as it drives ordering and propagation; the graph source is a provider.
Avoid importing a graph library into the kernel — keep edges as plain values
or defer to an adapter.

### 1.10 backport — moving a fix to an older line

**Definition.** A specific kind of change propagation (§1.8): taking a change
released (or to be released) on a newer line and porting it to an _older,
still-supported_ line, re-versioned appropriately (a patch bump on the
maintenance line).

**What varies.**

- **INFERENCE** — the concrete form is a cherry-pick onto a maintenance branch
  plus a patch-level bump and a maintenance-line note/changelog entry.
- **INFERENCE** — semantic-release supports independently versioned maintenance
  branches (e.g. `1.x` branches) whose commits are backports; the version on
  the maintenance line advances independently (patch) from the trunk line.
- **OBSERVED** — Chrome keeps separate maintenance within a line by channel
  cadence, but true "server-side backport" is distinct from the channel ladder —
  the ladder forwards, backport reverses
  ([Chrome release channels](https://developer.chrome.com/docs/web-platform/chrome-release-channels),
  forward-only ladder inferred from the promotion description).

**Judgment: DEFERRED/OUT OF SCOPE for the first model — MUST NOT preclude.**
Backport is the _reverse_ of the normal stream direction: it needs lines, change
identity, and re-versioning to already exist. It is a policy workflow layered on
those primitives. RECOMMENDATION: ensure a line can hold multiple concurrent
versions (so `1.2.4` and `1.3.0` can both exist) and that a change has identity
across lines; then backport is an extension that cherry-picks and re-bumps. Do
not build backport into the first model.

### 1.11 promotion — moving an artifact/version to a more public channel

**Definition.** Advancing a version (or artifact) to a channel with a wider or
more stable audience, without changing its content: e.g. the same build moves
from `beta` to `latest`, or a tested npm package is re-tagged `latest`.

**What varies.**

- **OBSERVED** — npm promotion = re-pointing a dist-tag at an already-published
  version: `npm dist-tag add pkg@1.0.0 latest`
  ([npm-dist-tag](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag)).
- **OBSERVED** — Chrome's channel ladder (Canary→Dev→Beta→Stable) is promotion
  of _the product_ through stages, with staged rollouts (1–5%→100%)
  ([Chrome release channels](https://developer.chrome.com/docs/web-platform/chrome-release-channels)).
- **INFERENCE** — Docker: retagging/pushing the same image digest under `latest`
  after QA; the content (digest) is unchanged, the channel pointer moves.
- **INFERENCE** — semantic-release's channel promotion is often _implicit_: the
  released version lands on a channel determined by branch, not an explicit
  promote step.

_(Relationship §R5 gives the full promotion-vs-release analysis.)_

**Judgment: FUNDAMENTAL DOMAIN CONCEPT.** Promotion is distinct from releasing
new content: it mutates _channel membership_ (§1.4) of an existing
version/artifact, and it is the operation the release line's stability ladder
is built on. RECOMMENDATION: model promotion as a first-class transition
(channel pointer moves; content immutably same) so `stable` promotion, npm
re-tagging, and Docker re-tagging share one concept, with per-backend details
as adapters.

### 1.12 artifacts — the deliverable units a release produces

**Definition.** The concrete, immutable things a release outputs and users
consume: npm tarball, Docker image (by digest), binary, source archive,
container bundle, SBOM. An artifact has content identity (a digest/hash) and
metadata (version, provenance).

**What varies.**

- **OBSERVED** — Docker images are identified by _digest_; the channel/tag
  (`latest`, `1.2`) points at a digest and can be moved without changing
  content (INFERENCE on digest mechanics — universal Docker fact).
- **OBSERVED** — Chrome ships channel-specific _builds_ (the "Chrome" artifact
  per channel); a single release can carry many platform artifacts
  ([Chrome release channels](https://developer.chrome.com/docs/web-platform/chrome-release-channels)).
- **INFERENCE** — npm publish produces one versioned tarball per package+version;
  the artifact is content-addressed at the registry.

**Judgment: FUNDAMENTAL DOMAIN CONCEPT.** Artifacts with immutable content
identity are how "promotion without changing content" is provable (digest
stable across channels). RECOMMENDATION: artifact = (kind, version, contentId);
publishing/uploading is an adapter. Artifact identity must be _content-stable_
so promotion (§1.11) can assert "same thing, new channel".

### 1.13 artifact dependencies — edges between artifacts

**Definition.** How released artifacts depend on each other at release time:
image A embeds binary B at version V; package A requires package B at range R;
a distribution bundles a set of lib versions. Distinct from source dependency
graph (§1.9) in that it is about _released_ objects, not source packages.

**What varies.**

- **OBSERVED** — changesets' dependents-bump is a release-time artifact/package
  dependency: `<pkg>@1.1.0-next.1 has dep on pkg-b@^2.1.0-next.0`
  ([`changesets` prereleases](https://changesets.dev/guide/prereleases)).
- **OBSERVED** — cargo-release updates dependent crates' version requirements
  when a dependency's version changes
  ([`cargo-release` README](https://github.com/crate-ci/cargo-release)).
- **INFERENCE** — Docker: an image's `FROM`/embedded layer pins a base; a
  distro stream pins a set of package versions together (a "release set").

**Judgment: ADAPTER/EXTENSION MECHANISM.** The graph of released artifacts and
its consistency rules (all pins resolve, ranges satisfied) is real, but the
_specific_ graph shape (package.json ranges, OCI layers, OS package sets) is a
provider concern. RECOMMENDATION: model a pure "release of A references
release/number of B" edge only as far as consistency checking and ordering
need it; the graph source lives at the adapter layer. Do not put a semver-range
solver in the kernel at first.

### 1.14 lifecycle transitions — the legal state graph a release walkthrough

**Definition.** The set of states a release or version passes through and the
allowed transitions: `planned → built → tested → staged → published →
superseded/archived`, with validity rules (can't publish before build,
can't promote unverified, etc.).

**What varies.**

- **INFERENCE** — npm: an unpublished version is nothing; a published version is
  permanent-ish (cannot fully delete); retraction (`npm unpublish/deprecate`) is
  a transition with strong constraints.
- **OBSERVED** — changesets has explicit `pre enter`/`pre exit` transitions
  that toggle prerelease mode, a coarse lifecycle
  ([`changesets` prereleases](https://changesets.dev/guide/prereleases)).
- **OBSERVED** — Chrome rollouts can be _paused_ mid-rollout and features
  disabled by field-trial flags without a new release — a lifecycle where a
  "live" release can be ephemerally controlled
  ([Chrome release channels](https://developer.chrome.com/docs/web-platform/chrome-release-channels)).
- **INFERENCE** — semantic-release has few explicit states — release happens
  atomically on publish; there is no rich staging model.

**Judgment: ADAPTER/EXTENSION MECHANISM** (with a thin core). The _list_ of
states is workflow-specific and backend-specific, but the _notion_ of an
ordered transition with guards is domain-shaped. RECOMMENDATION: the core
models that a release has a current state and that transitions are guarded;
the state vocabulary (what states exist, what guards apply) is configuration/
policy at the edge. The kernel should not enumerate publishing states.

### 1.15 hooks — user/extensible steps at lifecycle points

**Definition.** User-supplied code invoked at named points during a release:
pre-publish validation, changelog generation, tag search-and-replace, notify,
canary-verify. Hooks are how non-core, system-specific side effects attach.

**What varies.**

- **OBSERVED** — cargo-release has a "pre-release hook for extra customization,
  including CHANGELOG generation", plus pre-release search-and-replace for
  version strings in Dockerfiles
  ([`cargo-release` README](https://github.com/crate-ci/cargo-release)).
- **INFERENCE** — release-please exposes build/update/release "plugins" and
  manifests; semantic-release exposes plugins+`verifyConditions` etc.
- **INFERENCE** — npm `prepublish`/`prepack` scripts are lifecycle hooks
  (well-known npm fact, not re-read).

**Judgment: ADAPTER/EXTENSION MECHANISM.** Hooks are the escape hatch for
system-specific behaviour — they must never enter the pure domain (they are
code, side effects, I/O). RECOMMENDATION: hooks are a provider/plugin seam at
the edges; the core defines the _named lifecycle points_ (§1.14) hooks attach
to, but not the hooks' implementation.

### 1.16 policy — rules governing releases

**Definition.** The rules that constrain what is allowed: branch protection,
minimum tests, "must be green", version grammar, who may promote, cadence,
approval requirements, required change types, semver range hygiene.

**What varies.**

- **OBSERVED** — cargo-release enforces "right branch, up-to-date with remote,
  clean tree" before releasing
  ([`cargo-release` README](https://github.com/crate-ci/cargo-release)).
- **OBSERVED** — release-craft already ships executable policy gates (workflow
  safety, docs integrity) for its own repo; the org philosophy is "governance
  that runs, not prose that hopes"
  ([`docs/bootstrap/ecosystem-analysis.md`](../bootstrap/ecosystem-analysis.md)).
- **OBSERVED** — ADR-0001 separates _grammar_ (kernel: strict SemVer) from
  _policy_ (release-line decisions such as "produce the next prerelease")
  ([ADR-0001](../adr/0001-domain-kernel-and-semantic-version.md)).
- **INFERENCE** — Chrome's staged rollout percentage and pause are rollout
  _policy_, not version semantics.

**Judgment: ADAPTER/EXTENSION MECHANISM — but policy-on-version is core-leaning.**
The _enforcement machinery_ (CI, rulesets, checks) is an adapter, and most
policy is workflow config. But a small amount of policy is intrinsic to the
domain — e.g. "the next prerelease on this channel" (§1.5) — which ADR-0001
already assigns to line policy outside the value kernel. RECOMMENDATION: keep a
`Policy` concept at the edges (evaluated, not embedded), but let the _line_
carry its policy (what channels, what prerelease format, what bump rules) as
declared data the core reads — never hard-coded into `core/domain/`.

### 1.17 approvals — human gate before a release event

**Definition.** A requirement that a human (or agent) explicitly approve before
a release/promotion/publish proceeds. Distinct from a hook (§1.15): an approval
_blocks_ the flow until granted; a hook runs as a step.

**What varies.**

- **INFERENCE** — GitHub release PRs (release-please) give a human a chance to
  review the proposed change set + version before merge; merge _is_ the
  approval.
- **INFERENCE** — npm 2FA/OTP on auth-and-writes (OBSERVED as a flag: `--otp`)
  is an approval on publish ([npm-dist-tag](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag)).
- **OBSERVED** — Chrome requires "rigorous automated testing and manual checks"
  before Stable, an approval gate between Beta and Stable
  ([Chrome release channels](https://developer.chrome.com/docs/web-platform/chrome-release-channels)).

**Judgment: ADAPTER/EXTENSION MECHANISM.** Approval = a blocking _policy_
condition (§1.16) that suspends the lifecycle (§1.14). The domain models that a
transition can be _pending-approval_ and gated; the approval channel (human PR
review, OTP, agent) is an adapter. RECOMMENDATION: approvals are a policy flag
on guarded transitions; the core supports a `pending` state, not the approval UX.

### 1.18 failure — a release that did not complete

**Definition.** The state a release/propagation reaches when a step fails —
publish partially completed, a promotion rejected, a build broke, a dependency
mismatch. The domain must represent failed/incomplete releases distinctly from
successful ones.

**What varies.**

- **OBSERVED** — Chrome can _pause_ a rollout and respin when metrics show
  problems ([Chrome release channels](https://developer.chrome.com/docs/web-platform/chrome-release-channels)).
- **INFERENCE** — a partial npm publish (some packages tagged, one failed) leaves
  a registry in a half-state that must be represented, not just "errored".
- **INFERENCE** — cargo-release dry-run-by-default exists so a release can be
  validated before it can fail (`--execute` required)
  ([`cargo-release` README](https://github.com/crate-ci/cargo-release)).

**Judgment: FUNDAMENTAL DOMAIN CONCEPT (state only).** A release must have an
observable terminal state that is _not_ success (failed, partial, superseded),
so operators and agents can reconcile. RECOMMENDATION: model failure as a
legal lifecycle state with a record of what completed (§1.14); the _response_
(retry/resume, §1.19–1.20) is policy.

### 1.19 retries — retrying a failed release step

**Definition.** Re-attempting a failed step, usually idempotently (publish again,
re-run verification, re-tag). Succeeds only if the operation is safe to repeat.

**What varies.**

- **INFERENCE** — HTTP publish failures to npm are naturally retryable when the
  operation is idempotent (same version+content); tools retry with backoff.
- **OBSERVED** — cargo-release's explicit dry-run-then-`--execute` design means a
  failed run can be re-run after fixes without partial state surprises
  ([`cargo-release` README](https://github.com/crate-ci/cargo-release)).

**Judgment: ADAPTER/EXTENSION MECHANISM.** Whether a step is safely retryable is
backend-specific (a registry accepting the same publish is different from a
gate that already ran). RECOMMENDATION: the core marks a step's retryability and
failure state; the retry loop/backoff is an adapter. Do not build retry into
the domain value semantics.

### 1.20 resume — continuing a partially-completed release

**Definition.** Not re-running from scratch but picking up a multi-step release
at the first not-yet-completed step after a failure — distinct from a naive
retry that would repeat already-done work.

**What varies.**

- **INFERENCE** — a monorepo publish that tagged 5/8 packages: resuming should
  detect the 5 done and continue with the remainder; a naive retry would
  re-publish or conflict.
- **OBSERVED** — Chrome respins (a form of resume after a paused rollout) —
  "they may need to turn off a feature, update a component, or respin"
  ([Chrome release channels](https://developer.chrome.com/docs/web-platform/chrome-release-channels)).

**Judgment: ADAPTER/EXTENSION MECHANISM (records-based).** Resume works only if
a durable record of completed steps exists, which points at the lifecycle state
(§1.14) and artifact/publish records. RECOMMENDATION: the domain must _persist_
per-step completion (so resume is a query over what done); the resume driver
itself is an adapter. "Can I know what already happened?" is core; "run the
remaining steps" is edge.

### 1.21 concurrency — concurrent release attempts and prerelease numbering

**Definition.** Two or more release operations happening at once — two agents
cutting a release, parallel CI on the same line, or the danger of two
simultaneous prerelease bumps colliding on numbering (`1.0.0-next.0` from two
runners).

**What varies.**

- **OBSERVED** — Chrome is the extreme: thousands of contributors, staged
  rollouts, field trials — concurrency of _development_, but _Stable_ is
  strictly serially rolled out
  ([Chrome release channels](https://developer.chrome.com/docs/web-platform/chrome-release-channels)).
- **INFERENCE** — npm's registry and tags are a single ordered namespace: two
  publishers racing on `latest` last-writer-wins; two runners bumping
  `-next.N` can collide unless the number is derived atomically.
- **INFERENCE** — release-please/changesets avoid collision by making the
  version bump happen in a single merged PR (linearizes concurrency at the
  branch/PR level).

**Judgment: ADAPTER/EXTENSION MECHANISM** (with a core invariant). The _risk
model_ — concurrent attempts on a line and prerelease-number collisions — is
an operational concern (locks, serialization of `latest`, atomic tag sets).
But one core invariant is intrinsic: a _stream of versions on a line must stay
monotonic and collision-free_. RECOMMENDATION: the kernel guarantees
`Version` orderability/comparison (so collisions are detectable); the _policy_
of serialization, locking, and atomic channel re-tagging is an adapter at the
edge. The model "must not preclude" concurrent prerelease numbering, but the
numbering mechanism itself is line-policy (per §R3 and ADR-0001 decision 7).

### 1.22 human intervention — a human operating a release by hand

**Definition.** The whole class of "a person (or agent) drives, approves,
corrects, or overrides a release outside the automated happy path" — cutting a
release manually, re-tagging, resolving a half-published state, bypassing a gate
with justification.

**What varies.**

- **INFERENCE** — the entire spectrum: fully-automated on merge (semantic-release
  publish on merge), PR-gated then manual merge (release-please), fully manual
  (someone runs `npm publish` + `git tag` by hand).
- **OBSERVED** — changesets is PR-gated-and-manual-mergable, and its docs
  explicitly warn "mistakes can lead to repository and publish states that are
  very hard to fix"
  ([`changesets` prereleases](https://changesets.dev/guide/prereleases)).
- **OBSERVED** — Chrome operators pause/respin rollouts by hand based on metrics
  ([Chrome release channels](https://developer.chrome.com/docs/web-platform/chrome-release-channels)).

**Judgment: ADAPTER/EXTENSION MECHANISM.** The domain is _descriptive_: it must
record that a human acted (audit), support approval states (§1.17) and manual
corrections — but "the operator" is not a domain object. RECOMMENDATION: the
core models releases, states, approvals and records; human intervention is a
_who/performer_ on a transition, represented as data (the actor), never
hard-coded as a special case in the kernel.

---

## 2. Relationships (the vocabulary lock)

This section is the load-bearing part: these identity questions decide whether
the Phase 0 vocabulary is one concept or several.

### R1. Branch vs ReleaseLine vs Channel — three concepts or aliases?

**Are they one?** No. They are three distinct concepts that are _frequently
aligned_ in simple tools and _frequently separated_ in real systems.

**Distinguish them:**

- **OBSERVED** — Chrome proves channel ≠ branch and channel ≠ line: "Channel ≠
  version"; each channel has its own version _sequence_ (line), and none of the
  four channels is a git branch
  ([Chrome release channels](https://developer.chrome.com/docs/web-platform/chrome-release-channels)).
- **OBSERVED** — npm dist-tags are channels that can be _re-pointed_ without any
  branch or line change (`npm dist-tag add pkg@1.0.0 latest`) — a channel
  mutation that touches neither branch nor version stream
  ([npm-dist-tag](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag)). This is
  the cleanest counter-evidence: a real system where channel is a first-class,
  mutable pointer.

**What breaks if conflated?**

- If **line ≡ branch**: you cannot express Chrome's channels (not branches), nor
  a maintenance line hosted on two branches, nor a line migrating between hosts.
- If **channel ≡ line**: you cannot have two channels on one line (npm `stable`
  and `next` both drawing from the same product line; Docker `latest` and `1.2`
  on one release set) — that is the _norm_, not an edge case.
- If **channel ≡ branch**: you cannot re-point a channel (distribution) without
  a branch operation.

**RECOMMENDATION.** Three distinct concepts, in a containment/pointer model:

- **ReleaseLine** — a durable, ordered version stream (the spine).
- **Channel** — a named view/pointer that targets a _version_ (or artifact) on
  a line (or across lines) — mutable, backend-mapped (npm tag, Docker tag).
- **Branch** — a concrete _source scoping device_ (which candidates are "on"
  this stream Right Now), supplied by a git provider. The domain should not
  require a branch to exist.

`line` and `channel` are FUNDAMENTAL DOMAIN CONCEPTs (§1.3, §1.4); `branch` is
an adapter (§1.2).

### R2. Version vs Release — is a release just a version?

**A release is not just a version.**

The `Version` value (OBSERVED, ADR-0001) is a _grammar + precedence_ object —
pure, comparable, build-inclusive. A release is an _event/entity with identity_:
a version **plus** the change set it ships (§R4), the source ref it was built
from (§1.1), its artifacts (§1.12), its lifecycle state (§1.14), and its channel
memberships (§1.4).

The identity question alone breaks the collapse:

- **Same version, two lines.** `1.2.4` can exist on the `1.2` maintenance line
  and be a planned-but-different event on the `1.3` line. A version number does
  not uniquely name a release when two lines can cite the same number.
- **Two _releases_ of one version, different channels.** OBSERVED: npm lets a
  single published version be tagged onto several channels
  (`npm dist-tag add pkg@1.0.0 beta` then `… latest`) — one version, multiple
  channel memberships, and "promotion" is exactly re-pointing a channel at the
  same version without a new version ([npm-dist-tag](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag)).
- **One release, many artifacts.** A version can produce a dozen platform
  artifacts ([Chrome](https://developer.chrome.com/docs/web-platform/chrome-release-channels):
  one numbered release, many builds).

**Consequence.** `Version` is a **value type** in the kernel; `Release` is a
**first-class entity with its own identity**, composed of: a `Version`, a
change set, a source lineage, artifacts, a lifecycle state, and channel
memberships. Version equality (structural/`equals`) is not release identity.
Collapsing them would make "two releases of one version on different channels"
and "same version, two lines" inexpressible — both real.

**RECOMMENDATION:** Release is FUNDAMENTAL DOMAIN CONCEPT, distinct from but
referencing `Version`. A release's _identity_ is its own (e.g. line+sequence or
an opaque id), not the version string.

### R3. Prerelease: version flag vs position in a channel stream

**Argue both sides.**

- **Argument A — version flag.** Prerelease is a property of the _version
  itself_ (the `-prerelease` suffix). OBSERVED: SemVer defines it as grammar +
  precedence; the kernel already models it as a field and orders it
  ([`core/domain/version.ts`](../../core/domain/version.ts)). It is intrinsic,
  comparable, and travels with the value. This side is _structurally true_ — a
  version can be stably classified prerelease vs stable by looking at it.
- **Argument B — position in a channel stream.** Prerelease is _where_ a version
  sits in a line/channel — is it the head of `next`, or has it promoted to
  Stable? OBSERVED: classification as "prerelease" in practice is usually about
  _not yet stable_, which is a scheduling/maturity fact, not just a string.
  OBSERVED: `bumpMajor/Minor/Patch` strip prerelease — the _transition_ off
  prerelease ("make it stable") is not a version comparison; it is a release
  event ([ADR-0001](../adr/0001-domain-kernel-and-semantic-version.md) decision 7).

**Recommendation — both, cleanly separated by layer:**

1. **Kernel (value)**: prerelease is a _version flag_ — grammar + precedence,
   already modelled. This is non-negotiable; it is what makes `Version`
   comparable.
2. **Line/channel policy (above the kernel)**: "is this version a _stable
   release_ or a _prerelease on channel X_" is determined by **where it sits in
   the line and what channel it is on** — the flag does not decide that alone.
   Producing the _next_ prerelease is the line's job (OBSERVED, ADR-0001).

So the answer is **both at the correct layer**: the _flag_ is a value property;
the _meaning_ (stable vs prerelease-in-a-channel) is a membership/scheduling
property of the line+channel. Concretely, `1.0.0` is grammatically stable, but
_whether it is the `latest` that users get_ is a channel fact, and whether it
was ever a `beta` is a history fact. Neither collapses into the string.

### R4. Change vs ChangeSet — granularity, identity, selection

- **Change** — the atomic unit of work: one commit, one changeset file, one
  rationale-driven edit. It has its own identity (commit SHA, changeset id)
  that is **stable across lines** (OBSERVED: changesets names each declarable
  change; a cherry-pick of a commit keeps the commit identity).
- **ChangeSet** — the set of _changes selected into a release_ — the release
  payload a changelog is derived from — plus
  the bump it implies. A change set is an _enumerated group_: it answers
  "which changes does release X carry".

**Granularity:** a Change is a beard-level unit (a commit/declaration) with its
own identity; a ChangeSet is a _composition_ — a named, release-scoped group.
**Selection** (§1.7) is the operation that assembles changes into a change set;
**identity** is what lets a change be re-selected on another line (backport,
§1.10) without losing provenance.

**Conflation risk:** if you collapse them, you cannot (a) have _one change_ in
_multiple change sets_ across lines (backport), (b) express an _empty_ change
set (cargo-release's "crate might not need a release" — OBSERVED), or (c)
separate "what was selected" from "what a release cargo". **RECOMMENDATION:**
Change = FUNDAMENTAL (identity-carrier); ChangeSet = FUNDAMENTAL (release
payload grouping). Change identity must survive line-to-line movement.

### R5. Promotion vs a new release — when is promoting a release event vs a channel mutation?

**The distinguishing test is whether content (the version/artifact) changes.**

- **Promotion as channel mutation — content unchanged.** OBSERVED: npm
  re-tagging (`npm dist-tag add pkg@1.0.0 latest`) changes _nothing_ about the
  version; it only re-points the channel. The artifact digest, version, and
  change set are identical. This is **not** a new release — it is a §1.11
  channel mutation (§1.4). The lifecycle states are also unchanged: the same
  version simply gains a wider channel membership.
- **Promotion as a release event — the _classification_ changes.** When the
  promotion _changes the maturity meaning_ (e.g. a prerelease becomes stable, or
  a build moves Dev→Beta and that build is _itself the deliverable_), the
  promotion is **part of the release lifecycle**, and it is a _transition_
  (§1.14) on a release, not merely a pointer move. OBSERVED: Chrome's channel
  ladder _is_ the release pipeline — a build moving Canary→Dev→Beta→Stable is a
  sequence of release-lifecycle promotions, each gated by testing
  ([Chrome release channels](https://developer.chrome.com/docs/web-platform/chrome-release-channels)).
- **The invariant that separates them:** does the promotion introduce a _new
  version / new artifact_, or does it re-point an existing one?

  - Re-pointing an existing version to a channel = **channel mutation** (a
    `Channel` state change; no new `Release`).
  - A new version, or a change in which _version_ is the stable/head of a line =
    **release event** (new `Release`, or a lifecycle transition).

**RECOMMENDATION.** Both are real and both are FUNDAMENTAL (channel mutation is
core to the channel concept; lifecycle transition is core to the release
concept). The point is that promotion is **not modelled as "creating a new
release"** when content is unchanged — otherwise every re-tag would fabricate a
release and destroy the identity of "one version, many channels" (§R2). Rule:
**promotion changes channel membership or lifecycle state; only a change in
version/artifact content yields a new Release.**

### R6. Artifact vs Release — one release many artifacts; artifacts with their own versions?

**One release, many artifacts — yes, and the relation is many-to-one.**
OBSERVED: Chrome's single numbered release carries many platform builds; npm's
one version is one package tarball, but a "release" in a monorepo spans many
packages. The `Release` is the _event/entity_ (§R2); `Artifact` objects are its
produced outcomes (§1.12).

**Artifacts with their own versions — yes, as a _derived_ property, not an
independent spine.**

- An artifact is tied to the release's _version_ (an npm tarball is
  `pkg@1.0.0`; a Docker image usually tagged with the same version). Its
  "version" is the release's version — _unless_ a system names artifacts by a
  different scheme.
- **Concrete counter-example (OBSERVED):** Docker identifies artifacts by
  **digest** — a content address that is NOT a semver and does not change when
  the channel/tag/version pointer moves. So an artifact's _content identity_
  (digest) is orthogonal to the _version_ attached to it. An image can be
  `pkg:1.0.0` (version in a tag) while its immutable id is `sha256:…`.
  ([Chrome](https://developer.chrome.com/docs/web-platform/chrome-release-channels)
  similarly: a build has a version _and_ a channel, plus platform specifics.)
- **Inflection point:** one release may _not_ have one "the version" for all its
  artifacts in a polyglot/multi-component release — each artifact carries its
  own component version (monorepo: package A at 1.1.0, package B at 1.1.0, both
  under one release event).

**Recommendation.** Keep `Release` and `Artifact` as separate FUNDAMENTAL
concepts:

- `Release` — the planned+build+published event with a primary `Version`,
  change set, lifecycle, and a set of produced artifacts.
- `Artifact` — an immutable deliverable with its own _content identity_ (digest)
  and a _version_ (usually the release's, possibly a per-component version).
- A release **has** artifacts (1:N). An artifact's content identity is
  distinct from the version label on its channel, so promotion (§1.11, §R5)
  can assert content-stability across channels.

---

## 3. Judgment matrix

| Dimension             | Judgment                           | Why (one line)                                                                             |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------ |
| source/ref            | FUNDAMENTAL                        | release lineage/identity needs a released-from value; ref _resolution_ is adapter          |
| branch                | ADAPTER                            | git branches are one scoping mechanism; Chrome shows lines that aren't branches            |
| release line          | FUNDAMENTAL                        | the ordered stream is the domain spine; ADR-0001 names it as the home of prerelease policy |
| channel               | FUNDAMENTAL + adapter              | the notion is core; the backend mapping (npm/Docker tag) is adapter                        |
| stable/prerelease     | FUNDAMENTAL (flag)                 | SemVer field + precedence already in the kernel; maturity _policy_ sits on the line        |
| version stream        | FUNDAMENTAL                        | ordered backbone; `Version.compare` is already the ordering primitive                      |
| change selection      | FUNDAMENTAL                        | deciding a release's change set + bump is the domain's primary reasoning                   |
| change propagation    | DEFERRED (must not preclude)       | derivable from change identity + line membership; build later                              |
| dependency graph      | ADAPTER                            | edges drive ordering/propagation, but the graph source is a provider                       |
| backport              | DEFERRED (must not preclude)       | reverse-direction workflow over lines + change identity                                    |
| promotion             | FUNDAMENTAL                        | channel-membership + lifecycle transition, distinct from new content                       |
| artifacts             | FUNDAMENTAL                        | immutable content identity proves promotion is content-stable                              |
| artifact dependencies | ADAPTER                            | consistency/ordering edges; solver/registry specifics live at the edge                     |
| lifecycle transitions | ADAPTER (thin core)                | states are workflow-specific; core models guarded transitions + terminal-failure           |
| hooks                 | ADAPTER                            | user code must never enter the pure kernel                                                 |
| policy                | ADAPTER (line policy core-leaning) | enforcement is edge; line-carried policy data is core-readable                             |
| approvals             | ADAPTER                            | a blocking policy condition; core models pending, not the approval UX                      |
| failure               | FUNDAMENTAL (state)                | non-success must be a legal, reconcilable lifecycle state                                  |
| retries               | ADAPTER                            | retryability is backend-specific                                                           |
| resume                | ADAPTER (records-based)            | depends on durable per-step completion records; the driver is edge                         |
| concurrency           | ADAPTER (invariant)                | collision-safety of version streams is core; locking/serialization is edge                 |
| human intervention    | ADAPTER                            | describe/record actors on transitions; never a kernel special-case                         |

**What the first model must not preclude** (so it stays open, per the task):

1. Several concurrent version streams (multiple lines) each with independent
   order — so backport and maintenance lines fit later.
2. Two releases of the _same version_ on different lines or channels (identity
   is not the version string, §R2).
3. Channels that are not branches and are re-pointable (npm-style tag mutation,
   §R1).
4. Artifact content identity distinct from version label (digest-stable
   promotion, §R6).
5. One release carrying many artifacts and per-component versions.
6. Concurrent prerelease numbering on a line (duration policy, §R3) — the model
   only guarantees detectability via `Version` orderability.
7. A change retaining identity across lines (for propagation/backport, §R4).

---

## 4. What this means for the Phase 0 vocabulary

- **Lock these six as distinct, core, first-class concepts:** `Version`
  (already materialized, OBSERVED), `ReleaseLine`, `Channel`, `Change`
  (+`ChangeSet`), `Release`, `Artifact`.
- **Keep at the edge:** `branch` (as a git-provided scoping device), `hooks`,
  `policy` enforcement, `approvals`, the full `lifecycle` state vocabulary,
  `dependency-graph` sources, publish/upload mechanics, retry/resume drivers.
- **Defer (model must admit later):** propagation engine, backport, concurrent
  prerelease numbering policy.
- **One invariant crosses every layer:** **content identity** (of a version or
  artifact) is immutable and distinct from _reach_ (the channel/pointer that
  names it). Every relationship above (R1–R6) is ultimately about keeping
  "what something is" separate from "where it is reachable".
