# Phase 13 contract — the GitHub Action, the automation surface above the boundary

Owner: [#120](https://github.com/ecoma-io/release-craft/issues/120). The
numbering is proposed — the phase after the CLI — and the maintainer confirms
or renumbers it in review ([§8](#8-open-questions-for-the-maintainer),
question 1). This document is the Action's design slice: it decides the
surface, ships no `action.yml`, and binds no implementation — the Action
lands as its own reviewed PR against this contract.

The contract is written against the BUILT CLI, not the prose alone: main
carries the CLI at `a77e88d` (PR #119) as this contract is finalized, and
every flag row, exit code, and rendering rule below was read from
`src/cli/grammar.ts`, `src/cli/exit-codes.ts`, and `src/cli/render.ts` — the
grammar as executable data, quoted not invented. Phase 12
[§7](phase12-cli-contract.md#7-the-other-slices) names exactly what this
contract inherits: "the door mapping, the declarations decision, the outcome
rendering rules, and the hermeticity envelope from this contract; its inputs
are action metadata, its secrets are its own problem, and its slice does not
reopen what is decided here." Nothing below reopens a phase 12 decision; two
of the issue's premises are corrected against the built surface as the
contract's own findings (the mint does not push —
[§2.8](#28-the-tokens-journey-decided-empty) — and the conclusion table is
not the exit table — [§3.3](#33-the-rules-the-table-pins)).

Two runner behaviors this contract leans on are named up front because both
are load-bearing: the runner injects a composite action's inputs into the
composite's `run:` steps as `INPUT_<NAME>` environment variables
([§4](#4-hermeticity-in-ci-the-two-lines)), and the runner's file-command
parser consumes an output value's final newline before the delimiter
([§3.1](#31-outputs-one-envelope-verbatim)). Everything below is written as
if both hold, because they do — the Action's job is to make the first the
channel that carries nothing and to keep the second from eating a byte of
the envelope.

## 1. Scope and non-goals

In scope: the Action's placement and the consumer-side pinning story; the
action kind, weighed with hermeticity as the deciding axis; the inputs
inventory — every input mapped onto an exact decided CLI flag or refused with
the reason; the actor decision; the world document's form in CI; the
assembly's; the outputs and the step-conclusion table; the hermeticity
posture between the runner and the bin; the token's journey; the inventory of
what the Action never does; and the implementation slice's test obligations.

Non-goals:

- **No `action.yml` here.** The metadata file is the implementation slice's
  artifact, built exactly to [§2](#2-shapes)'s decisions; this contract
  sketches its shape ([§2.3](#23-the-inputs-action-metadata-onto-the-closed-grammar))
  and decides nothing by sketching.
- **No second composition** (invariant 2.10), carried up from phase 12 §1
  verbatim: the Action parses action metadata into argv, runs one command,
  and renders what came back. No retry loop, no claim-view re-derivation, no
  walk re-ordering, no second projection of the repository's recorded state.
- **No reopening of the CLI contract.** The door mapping, the grammar, the
  exit table, the rendering rules, the declarations decision, and the
  hermeticity envelope are inherited; where this contract needs something the
  grammar does not offer, it says "a phase 12 amendment" and refuses the side
  door ([§2.3](#23-the-inputs-action-metadata-onto-the-closed-grammar)).
- **No publication.** The tag mint is a local `git tag --no-sign` (verified:
  `src/adapters/git/tag-door.ts`; `git-refs.ts` is the CAS family), and
  remote publication is the adapter's
  and the publishing slice's territory ([ADR-0010](../adr/0010-github-adapter.md);
  phase 11 §6; phase 12 §1). The Action does not push, does not create
  releases, and does not enumerate refs for anyone
  ([§2.8](#28-the-tokens-journey-decided-empty)).
- **No engine changes.** The boundary, the kernel, the planner, and the CLI
  are consumed, never re-owned; a need this contract cannot meet with
  inherited surface is a named slice, not a drive-by.
- **Ecoma appears nowhere** (invariant 2.12;
  [product-boundary.md](product-boundary.md)): the Action serves any software
  project on GitHub; the maintainer's own product is one consumer of it.
- **The certification fixture (#10) and the self-dogfood (#11) are not this
  slice** — they consume this contract's decisions
  ([§7](#7-the-other-slices)); neither is designed here.

## 2. Shapes

### 2.1 The placement and the pinning story

**Decided: the Action lives at the root `action.yml` of this repository.**
The Action is this repo's own bin consumed through a metadata file — one
product, one repository, one pin. A consumer references:

```text
uses: ecoma-io/release-craft@<40-character-sha>
```

and the organisation's law is the pin itself: every Action reference is a
full 40-character SHA (AGENTS.md invariant 3, enforced on this repo's own
workflows by `check:workflows`). The law now applies to the product's own
front door: the SHA a consumer pins carries the `action.yml`, the sources it
declares, the lockfile the build installs from, and the grammar table the
inputs map onto — one commit, one behavior, no drift between a metadata
version and the code it runs.

The alternatives, weighed:

- **A separate `release-craft-action` repository.** Refused for v1. The
  Action and the CLI must version together — the Action's whole inventory is
  a projection of the grammar table, and the table is versioned by this
  repo's commits. A second repository forces one of two lies: a release
  artifact copied across repos (two sources of truth for one bin), or the
  action repo checking this one out at a pin (a pin chain that must be
  re-pinned on every engine change, reviewed in two places). The org's
  two-repo topology exists for the saas/enterprise split
  (`ecoma`/`ecoma-cloud`), not for surface types; and the org already
  carries a decision that a tool's repository is its home
  (`archkeep` ships from its own repo _because_ it is its own npm package —
  the Action is not a package, it is a metadata view of this one). If the
  publishing slice ever produces a reason — a release cadence that must
  diverge from the engine's, a consumer base that pins independently — the
  move is a migration of one file plus its pinning story, and nothing in
  this contract's decisions depends on the address.
- **A subdirectory (`action/action.yml`).** Refused: no gain over root — the
  runner resolves nested action paths fine, but the root is where consumers
  and tooling look first, and this repository's root holds exactly one
  product entry today (`package.json`); the Action is the second, and it
  belongs beside the first.

The tag story follows the placement. When this repository has its own
release machinery (the self-dogfood, task #11, is the intended first
consumer), moving major tags (`v1`) may be published as conveniences; the
contract's position is that the SHA remains the only _supported_ reference —
a tag that moves under a consumer that pinned it is precisely the drift the
SHA law exists to kill, so tags are documentation, never trust. The repo
does not use release-please (the org's shared convention names
`release-craft` itself as the exception under construction); whatever
machinery lands, it lands through its own slice and this contract consumes
it, not the reverse.

### 2.2 The kind — composite, hermeticity deciding

**Decided: a composite action.** The composite's steps are (1) provision —
install the lockfile and build the bin inside the runner's own
materialization of this repository at the consumer's pin
(`github.action_path`; [§2.7](#27-the-invocation-the-constructed-command));
(2) invoke — run the built bin under a constructed
environment with argv assembled from the inputs
([§2.7](#27-the-invocation-the-constructed-command)). The kind was weighed on
one axis first, because the runner is wall-to-wall ambient — `GITHUB_*`,
`ACTIONS_*`, `RUNNER_*`, `CI`, `INPUT_*` — and the binding's
`hermeticGitEnv()` floor is the _inner_ line of defence, not the outer one.
The question each kind must answer is: what does "the process touches no
environment of its own" mean when the process is spawned by a machine whose
whole job is environment?

- **Composite.** The invocation is a `run:` step whose script the review
  reads line by line; the child is spawned under `env -i` with an explicit
  allowlist ([§4](#4-hermeticity-in-ci-the-two-lines)), so the strip is a
  reviewed step in this repository, not library behavior inside a runtime.
  Hermeticity is _achievable by construction_: the ambient layer ends at a
  shell line this repo owns. Cost: cold start — a `pnpm install
--frozen-lockfile` plus `tsc` build per run, minutes on a release job.
  Accepted and stated: releases are not latency-critical, and the build is
  what makes the pinned SHA mean the reviewed sources.
- **`node24` (a JavaScript action).** Refused. The `main` entry must exist at
  the pinned SHA, which forces a built bundle committed to git — and this
  repository's own hygiene refuses that posture in writing (`.gitignore`:
  "Build output — regenerated by `pnpm build`, never a source of truth");
  committing `dist/` forks the artifact from the reviewed sources or demands
  a new bundle-equals-src gate to police the fork. Worse on the deciding
  axis: a JavaScript action's process runs _inside_ the ambient layer it
  would have to strip. The runner spawns it with the full environment; the
  action toolkit reads `INPUT_*` ambient variables as its input mechanism;
  and stripping in-process means the strip executes in code that already
  shares a process with reads the review cannot order. "The process touches
  no environment of its own" is unsatisfiable for a JS action — the runtime
  _is_ an environment consumer. It wins cold start and loses the contract's
  subject.
- **A container action.** Refused. The isolation is real but bought at the
  wrong price: an image must be built, pushed, and pinned by digest — a
  second artifact supply chain standing up _before the publishing slice
  exists_, for a v1 that mints local refs ([§2.8](#28-the-tokens-journey-decided-empty));
  the binding walks a checked-out repository that lives outside the
  container (mounts, `safe.directory`, uid mismatches — each a reviewed
  surface nobody has asked for); the token journey is not simplified (still
  threaded in, now across a boundary); and the cold start adds a registry
  pull to an install it does not replace. The repo has no Docker story, and
  this contract declines to start one.

Runner posture: consumers run the Action on `ubuntu-latest` — linux, x64,
bash, `git` preinstalled on the image. Windows and macOS are refused in v1:
the invocation shell is bash, the composite is written for it, and promising
runners the suite never exercised is the kind of claim this repository does
not make. Node is pinned by this repository's `.node-version` (24 — matching
the package's `engines.node >= 24`), pnpm by its `packageManager` field
(`pnpm@11.25.0`) — and the composite pins **values**, not file paths:
`actions/setup-node` gets `node-version: 24`, `pnpm/action-setup` gets
`version: 11.25.0`.

The file-keyed mechanism is decided against, and the reason is a platform
fact, verified against the actions' sources at the pins this repository's
CI carries today (and identical from `setup-node` v4.0.0 through the pinned
v7.0.0): **neither action joins its file input as-given — both join it onto
`GITHUB_WORKSPACE` with `path.join`, which does not reset on an absolute
segment** (only `path.resolve` does). Under the no-checkout posture
([§2.7](#27-the-invocation-the-constructed-command)) the Action's pin files
exist only at `github.action_path`, so the natural spelling
`${{ github.action_path }}/.node-version` arrives as an absolute path and
is **mangled**: `actions/setup-node`'s `resolveVersionInput` builds
`path.join(process.env.GITHUB_WORKSPACE, versionFileInput)` (`src/main.ts`)
and `getNodeVersionFromFile` throws when the joined path does not exist
(`src/util.ts`) — the first consumer run hard-faults on a nested
nonsense path; `pnpm/action-setup`'s `parseInputPath` expands only a tilde
(`src/inputs/index.ts`), and `readTargetVersion` does
`readFileSync(path.join(GITHUB_WORKSPACE, packageJsonFile))` inside a catch
that **swallows** the ENOENT (`src/install-pnpm/run.ts`, "Swallow error if
package.json doesn't exist in root") — `packageManager` stays undefined
and, with no `version` input, the pnpm pin silently disengages. The
explicit-value spelling is robust in both directions: `node-version`
returns from `resolveVersionInput` before any file read, and `version`
returns from `readTargetVersion` regardless of what the workspace probe
found. `working-directory` does not deliver the pins either — its
justification is scoped to `run:` steps, and these are `uses:` steps.

The refused alternatives, in order of distance:

- **File-keyed inputs at the materialization**
  (`node-version-file: ${{ github.action_path }}/.node-version`,
  `package_json_file: ${{ github.action_path }}/package.json`) — the
  mangled-join fault above; it was this contract's first draft and is
  recorded refused so the mistake is not re-derived.
- **Relative spellings** — no relative spelling the runner's contract
  defines reaches the materialized tree; the ones that would normalize
  into it (`../../_actions/…`) encode the runner's private on-disk layout,
  undefined across runner versions and on self-hosted runners. A path that
  resolves to the consumer's files, or to a layout the runner never
  promised, is not a pin.
- **Overriding `GITHUB_WORKSPACE`** — the runner re-derives the variable
  per step, so a step-level `env:` override stays step-scoped, but its
  blast radius is inside the step it re-points: `setup-node`'s main and
  post steps must agree on what the workspace is (caching keys, matcher
  files, the toolchain probes above), and only one of them sees the
  override — unreviewable from this repository.
- **A run-step provisioner standing in `github.action_path`** (cwd
  resolution is real for `run:` steps) — workable, but it re-implements the
  two actions' reviewed logic (mirror selection, `PNPM_HOME` wiring,
  caching) as a script this repository then owns; the same
  second-implementation drift the build-command pin exists to kill, now for
  provisioning.

One residual is owned rather than hidden: `readTargetVersion` probes the
consumer's workspace-root `package.json` unconditionally (default
`package_json_file`), and if that file exists, declares a
`packageManager`, and disagrees with the declared `version`, the action
**throws** ("Multiple versions of pnpm specified"). That is a loud
provisioning fault on a consumer repository that pins its own pnpm — never
a silent different-toolchain install — and it resolves like any step that
dies before the invocation: no envelope, the no-verdict annotated failure
([§3.2](#32-the-conclusion-table)). A consumer repo whose root manifest
carries no `packageManager`, or none at all, probes clean.

The declared values are single-sourced to the repository's own pin files by
obligation, not by mechanism:
[§6](#6-test-obligations), fixture 1's drift row binds `node-version: 24`
to the materialized `.node-version`'s content and `version: 11.25.0` to the
materialized `packageManager`'s value — the same
declared-value-versus-repo-file shape as the build-command pin — so a
toolchain bump that edits the repo files but not the composite goes red.
The provisioning actions are reused from
`.github/workflows/ci.yml`'s 40-character pins, re-pinned to current at
implementation time by the slice that lands the file, which re-verifies the
join behavior above against whatever SHAs it pins.

### 2.3 The inputs — action metadata onto the closed grammar

The Action's inventory is a projection of the `run` command's grammar rows
(`GRAMMAR.run` in `src/cli/grammar.ts` — verified). Every input maps onto
exact decided flags; nothing else exists. The Action drives **one door**:
`run`.

| Input               | Required | Default                   | Feeds (grammar row)                                                                           |
| ------------------- | -------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| `world`             | yes      | —                         | `--world <inputs.world>` (a path; [§2.5](#25-the-world-document-in-ci-a-path-never-a-stream)) |
| `line`              | yes      | —                         | `--line <inputs.line>` — `RunRequest.lineIds`, exactly one (M-02)                             |
| `actor`             | yes      | —                         | `--actor <inputs.actor>` — `RunRequest.actor` ([§2.4](#24-the-actor-declared-one-layer-up))   |
| `intents`           | no       | empty                     | one `--intent` per non-empty-spelling line (the repeatable row)                               |
| `tag-namespaces`    | yes      | —                         | one `--tag-namespace` per line (the repeatable row; the git assembly demands at least one)    |
| `repo`              | no       | `.`                       | `--repo <inputs.repo>` — `BindingConfig.repo`                                                 |
| `max-retries`       | no       | `0`                       | `--max-retries <inputs.max-retries>` — `AssemblyConfig.maxRetries`                            |
| `working-directory` | no       | `${{ github.workspace }}` | no flag — the invocation step's own cwd ([§4](#4-hermeticity-in-ci-the-two-lines))            |

The multiline rule: `intents` and `tag-namespaces` are newline-separated,
one value per line, lines forwarded verbatim as one flag occurrence each —
the only list spelling added, and it is transport, not grammar: the values
are exactly the CLI's own spellings, and a line the grammar refuses reaches
the grammar and usage-faults (exit 64, annotated failure). The one trailing
newline a YAML block scalar carries is dropped (it is the scalar's own
punctuation, not a value); interior lines are forwarded as written. For
`tag-namespaces` that includes the empty line — the every-tag namespace root
is a legitimate grammar value (`parse.ts` refuses the empty string as a flag
value _everywhere except_ `--tag-namespace`, verified), so an interior empty
line forwards as `--tag-namespace ""`. For `intents` an interior empty line
forwards as `--intent ""` and is usage-faulted by the CLI — the author's
line, the grammar's refusal, loudly.

The `max-retries` default deserves its own sentence: the Action always
forwards the flag, default `0` — the CLI's own declared default
(phase 12 [§8](phase12-cli-contract.md#8-open-questions-for-the-maintainer),
question 4 — fail closed; a bound exhausted renders the explicit `conflict`,
never a silent retry) made explicit in argv rather than implied by omission.
A consumer who wants the kernel's bounded re-acquisition raises the number in
their `with:` block, visibly in their own workflow file.

The demanded rows (`world`, `line`, `actor`, `tag-namespaces`) are declared
`required` in the metadata — and the metadata is _not_ the enforcement
layer: the grammar's own demands stand behind every invocation, and an
input that arrives empty where the runner's `required` check was satisfiable
surfaces as the CLI's exit 64 with the synopsis, annotated. The Action adds
no validation of its own; the closed grammar is the validation.

Sketch of the decided metadata shape (the implementation slice's file, not
this contract's artifact):

```yaml
name: release-craft
description: Runs the release-craft engine's run door over a declared world.
inputs:
  world:            { required: true, description: "Path to the world document" }
  line:             { required: true, description: "Release line id to run" }
  actor:            { required: true, description: "Attribution string recorded on every record" }
  tag-namespaces:   { required: true, description: "Declared namespace roots, one per line" }
  intents:          { default: "", description: "Operator intents, one per line" }
  repo:             { default: ".", description: "Repository path the binding walks" }
  max-retries:      { default: "0", description: "Claim sequence retry bound" }
  working-directory:{ default: "${{ github.workspace }}", description: "Where the run stands" }
runs:
  using: composite
  steps: [provision…, invoke…]
```

**Refused inputs**, each with the reason the inventory closes on it:

| Refused                                                             | Why                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assembly`                                                          | Pinned `git` — [§2.6](#26-the-assembly-in-ci-git-pinned)                                                                                                                                                                                                 |
| `command` (a door selector)                                         | `run` only — the cross-process doors return `refused(unknown attempt)` from a fresh process today (phase 12 §2.7), so offering them offers a guaranteed refusal; `plan`-only is the CLI's own door, reachable by any workflow that runs the bin directly |
| `token`                                                             | No token exists in v1 — [§2.8](#28-the-tokens-journey-decided-empty)                                                                                                                                                                                     |
| `json` / any rendering switch                                       | `--json` is pinned, always — the envelope is the machine contract the conclusion table reads; two renderings invite divergence (phase 12 §3.1)                                                                                                           |
| `declarations`, `naming-module`, `target`                           | The grammar refuses them (phase 12 §2.3, §2.5, §2.6; the suite's negative inventory) — an action input would be the refused side door re-entering through metadata                                                                                       |
| release/publication vocabulary (`release-id`, `draft`, `labels`, …) | Publication is not this surface ([§2.8](#28-the-tokens-journey-decided-empty))                                                                                                                                                                           |

No input synthesizes a flag the grammar refuses, and no input invents a new
one: if the Action ever needs something the grammar lacks, the need is a
**phase 12 amendment** — its own reviewed change to `src/cli/grammar.ts` and
the contract that owns it — never a side door in the metadata.

### 2.4 The actor — declared one layer up

**Decided: `actor` is a demanded input with no default. The Action never
reads `github.actor` — or any identity context — itself.** The workflow
author writes `actor: ${{ github.actor }}` when the triggering identity is
their declared word, and writes any other string — a release identity, a
team handle — when it is not. Every record the walk appends carries the
string they wrote, and the diff that changed it is in _their_ workflow file.

This is E-09's human precedence carried one layer up, and the alternative is
exactly the law's violation:

- **Hard default to `${{ github.actor }}`** (in the metadata, so omission
  still runs). Refused. It is ambient-by-proxy: the Action never executes an
  environment read, but a default composed from a runner context is the same
  inference with extra steps — attributions silently become "whoever
  triggered the run" (a bot, an app installation, a token identity) on every
  ledger record, with no author's word anywhere. On scheduled and
  `repository_dispatch` events `github.actor` is a token identity, not a
  person; phase 12 §2.2's rule — "an absent `--actor` is a usage fault,
  never an inferred identity" — would be satisfied in the letter and
  abandoned in the substance. The demand is the law: the author says who
  acted, or nothing runs.
- **A defaulted-but-validated variant** (default to `github.actor`, warn when
  used). Refused — a warning in a log is not a declaration; the record still
  carries the inferred identity.

The honest cost, stated: an author who omits `actor` gets a red step
(missing required input) instead of a run attributed to their trigger —
correct, and cheaper than an attribution nobody made.

### 2.5 The world document in CI — a path, never a stream

**Decided: `world` is a filesystem path, demanded.** The `--world -` stdin
spelling is a CLI capability this inventory does not expose:

- The declared world is the release's whole input — phase 12 §2.4's "one
  document, one schema, zero translation" — and it deserves the form that
  makes that true in a repository: reviewed, diffable, versioned. A stdin
  document in a workflow travels through a shell variable or a herestring —
  quoting-hostile, size-limited, and invisible in any diff.
- The invocation reads no stdin at all
  ([§4](#4-hermeticity-in-ci-the-two-lines)); the child's stdin is closed.
  `-` is not refused by a gate the Action adds — it is absent from the
  inventory. The mechanism, stated against the built code: the CLI **does**
  wire the stream for that spelling (`world.ts` reads
  `location === "-" ? 0 : location` — fd 0), so through the Action a `-`
  value takes the CLI's stdin branch, finds the closed stream, and fails as
  the usage fault it is (exit 64, the stdin-specific fault line) — the
  outcome is the grammar's own refusal, reached through the branch the
  grammar built for it, never through a path read of a file named `-`.
- An inline-JSON spelling (`world-json`) is refused for the reason phase 12
  §2.4 refused per-field flags: a second spelling of one input is a second
  place for the two to disagree.

The workflow that _produces_ a document at run time — from a previous step's
output, from a generation script — writes it to a file first and passes the
path. `steps.*.outputs` → file → path input is the workflow's own
composition, visible at the layer that owns it; the Action's contract
consumes files. How the document came to be is the consumer's declared
world: committed artifact or prior step, the Action demands nothing about
its provenance and observes nothing to close it (phase 12 §2.4's law —
declared, not discovered — carried up unchanged). The path resolves against
`working-directory`, like every other path-shaped input here.

### 2.6 The assembly in CI — git, pinned

**Decided: the Action pins `--assembly git` and offers no `assembly` input.**
Is a memory assembly meaningful in CI? No — and the reason is durability,
not preference: the memory stores construct from nothing
(`assembleMemoryStores` wires `mint: null`, verified in
`src/app/assemble.ts`; phase 12 §2.5) and die with the process. A memory run in CI is a walk whose
every record — ledger, claims, the minted tag — evaporates with the runner:
performed, recorded, gone. The only evidence a CI context can consult after
the step is over is the git assembly's recorded refs in a repository someone
can read. The memory assembly remains what the boundary made it — the
embedder's and the suite's zero-persistence bundle (phase 11 §2.2) — not CI's.

Pinning git also fixes the grammar's assembly-conditional demands into the
inventory: `--repo` and `--tag-namespace` are demanded on this surface, and
the inputs table carries them (`repo` with its declared `.`, `tag-namespaces`
demanded). A flag the selected assembly cannot consume is a lie in argv
(phase 12 §2.2) — the pin is what keeps that lie unwritable.

### 2.7 The invocation — the constructed command

The invocation step assembles exactly this command (every row cited in
[§2.3](#23-the-inputs-action-metadata-onto-the-closed-grammar)):

```text
node <action>/dist/src/cli/index.js run \
  --assembly git \
  --repo <inputs.repo> \
  --tag-namespace <root₁> [--tag-namespace <root₂>…] \
  --max-retries <inputs.max-retries> \
  --world <inputs.world> \
  --intent <i₁> [--intent <i₂>…] \
  --actor <inputs.actor> \
  --line <inputs.line> \
  --json
```

- The build is `tsc -p tsconfig.build.json` — the same command the moon
  graph's `release-craft:build` task names (`moon.yml`), run without moon:
  the dev graph stays out of the runner's critical path, and the compile is
  self-contained (`tsconfig.build.json` includes `src/` and `core/domain/`).
  The obligation that keeps this honest is
  [§6](#6-test-obligations), fixture 1: the Action's build command and the
  moon task's command may not drift.
- The argv assembly and the environment construction live in **one script
  file in this repository**, which the composite's `run:` step invokes —
  the suite drives the same file as a subprocess. One definition, no
  drifted duplicate in a test.
- Provisioning (install, build) runs _before_ and _outside_ the
  hermetic envelope — it reads the network and the ambient runner
  environment freely, because it is the Action's provisioning, not the
  engine's execution. The envelope wraps exactly the invocation of the
  built bin ([§4](#4-hermeticity-in-ci-the-two-lines)); everything after the
  build's completion reads nothing ambient.
- **The provisioning root is the runner's own materialization — no second
  checkout exists.** The runner downloads the composite's sources at the
  consumer's resolved pin before any step runs and exposes that tree at
  `github.action_path`; provisioning stands there (the steps set
  `working-directory: ${{ github.action_path }}` explicitly — a composite's
  `run:` steps stand in the caller's workspace by default, and the build
  must stand in the Action's own tree). The same tree is what the
  toolchain pins are held against: the provisioning actions take explicit
  **values** (`node-version`, `version` — their file inputs cannot reach
  this tree; [§2.2](#22-the-kind-composite-hermeticity-deciding)), and the
  materialized `.node-version` and `packageManager` are the drift reference
  fixture 1 binds the declared values to. The alternative — a second
  `actions/checkout` of this repository at `github.action_ref` — was weighed
  and refused: the materialization **is** the pin's guarantee (the runner
  resolves the consumer's reference once and hands the composite that exact
  tree, a stronger provenance than a checkout re-resolving a context
  field), and refusing it deletes a step class rather than managing it —
  no `github.action_ref` spelling risk, no `persist-credentials` obligation
  on a checkout of our own, no clone time. The build needs no git history
  (`tsc`; every lockfile dependency is a registry package), so the
  materialization's fetch posture is irrelevant to it. The bin the run
  executes is built from the same commit the consumer pinned by
  construction; the runner-behavior facts this rests on — the
  materialization guarantee and the context spelling — are pinned by
  [§6](#6-test-obligations), fixture 1, and the maintainer's eyes are asked
  in [§8](#8-open-questions-for-the-maintainer), question 6.

### 2.8 The token's journey — decided empty

The issue's premise was that "the tag mint needs push rights." The built
surface says otherwise, and the contract follows the built surface:
**verified — the mint is `git tag --no-sign <name> <resolved>` on the local
repository** (`src/adapters/git/tag-door.ts` — a lightweight, unsigned tag at
the locally resolved target), beside the CAS append family's local
`git update-ref` writes (`git-refs.ts`); the target resolution itself is a
local `rev-parse --verify`, and the binding spawns every git on
`hermeticGitEnv()` — no remote, no credential, `GIT_TERMINAL_PROMPT=0`.
Nothing in the engine, the boundary, or the CLI names a remote. A v1 run in
CI therefore mints its tag and lands its records as refs in the checked-out
copy; the run's writes are the walk's writes, all local.

**Decided: the Action has no token input in v1, configures no credential,
touches no secret, and runs no git of its own against the target repository**
— no fetch, no push, no tag, no config write. What "published" means through
this surface, stated so nobody discovers it in a release run: the walk
completed and the tag ref exists in the runner's copy of the repository. It
does **not** mean a remote tag exists, a GitHub Release exists, or anything
left the runner. The refusal to push is not an oversight this contract
forgot to close:

- Enumerating which refs a release leaves behind **is** the remote
  projection's knowledge (phase 9 §2.7–§2.8 — the binding's read seams exist
  for exactly that consumer), and an Action that pushed would be a second,
  unreviewed projection. Publication is the adapter's and the publishing
  slice's territory ([ADR-0010](../adr/0010-github-adapter.md); phase 11 §6;
  phase 12 §1).
- The org's `persist-credentials: false` law reaches this composite
  vacuously: it performs **no checkout at all** — the consumer's repository
  remains the consumer's workflow's own step, and the Action's own sources
  arrive as the runner's materialization
  ([§2.7](#27-the-invocation-the-constructed-command)). The Action does not
  check out the consumer's repository for anyone: the caller chooses the
  fetch posture and the layout, and the declared world must make its named
  commits resolvable in that checkout — the mint's `rev-parse` is where a
  mismatch faults (exit 70), which is phase 12 §2.4's declared-lie posture,
  not a gap.

The constraints the publishing slice starts from (this contract's
contribution to that slice, not its design), with the mechanism classes
named so the decision cannot pass one by unremarked:

- **Never persisted.** A credential never lands in repository config or any
  file (`persist-credentials: false` generalized — `.git/config` is a
  reviewable file a token must never sit in). A credential-helper _script_
  on disk is refused by the same clause: it is a file carrying the token.
- **Never ambient.** A credential never enters the Action's own environment
  or the runner's ambient layer — and the ambient-injection channels stay
  closed (the floor strips `GIT_CONFIG_COUNT`/`GIT_CONFIG_PARAMETERS` by
  design: an env-injected config is stripped, not delivered).
- **Child-scoped transport is the in-tree precedent.** The built GitHub
  adapter already ships the third class, and it is the starting point this
  contract names rather than rediscovers: an **inline** credential helper —
  `-c credential.helper=` (clearing any inherited helper list) followed by
  `-c credential.helper=!f(){ … }; f` answering git's query from the
  spawned git's **own child environment** (verified:
  `src/adapters/github/remote-git.ts`), with `GIT_TERMINAL_PROMPT=0` so a
  remote that would prompt fails instead of hanging. The constraints judge
  it as written and it passes: a child-process environment is _scoped_ —
  one spawn, one transport, never the Action's env, never a file, never the
  runner's layer — so it satisfies "never persisted" and "never ambient"
  **provided the slice says so in exactly those terms** (scoped to the
  child, not ambient); what this contract refuses is the same token in the
  Action's environment or on disk, and the distinction is the review's
  burden to keep visible.
- **Process-scoped config** (`git -c http.<url>.extraheader=…`) remains the
  weighed alternative: it dies with the process but exposes the token on
  the command line (`ps` for the push's lifetime on a single-use runner —
  the residual a slice may accept). The slice that owns publication decides
  in its own PR; this contract only fixes what v1 refuses and names what
  already exists so that decision starts honest.

Mask rules, stated though v1 makes them vacuous: no secret exists to leak;
no output carries anything but the envelope; no annotation quotes anything
but outcome fields and fault text. The suite's token-journey pin
([§6](#6-test-obligations), fixture 5) is the negative inventory, executable,
so the day a token input is proposed the suite that forbids it fails loudly.

### 2.9 What the Action never does

The inherited pass-through law, stated as an inventory the implementation
slice's suite pins:

- **No retry loop around `run`.** E-08's bounded sequence retry is the
  kernel's clause, driven by the declared `max-retries`; the Action neither
  retries a door nor loops a command, and this contract publishes no
  workflow recipe — no `if: always()` composition, no retry scaffold — that
  would paper over a stop-band verdict.
- **No claim-store or ledger access outside the doors.** No reading recorded
  refs to "check" anything; an observation is the `show` door's, and this
  inventory drives `run` only.
- **No GitHub API composition into the engine.** No `gh`, no REST, no
  checks or releases API. The `::error::` annotation is the runner's log
  protocol, not an API call.
- **No outcome translation.** Annotations quote fields verbatim; the output
  is the envelope; nothing renamed, reworded, dropped, or converted
  (phase 12 §3.1's law at the automation layer).
- **No provider vocabulary beyond the runner's own metadata.** The engine's
  values stay provider-blind (invariant 2.11); the Action's _shell_ being
  GitHub-native is its placement, not the engine's vocabulary — nothing
  GitHub-shaped enters a flag, an engine value, or the envelope.
- **No publication** ([§2.8](#28-the-tokens-journey-decided-empty)).
- **No user code, no invented declarations.** The empty declaration
  (phase 12 §2.6) is inherited verbatim; an input naming a module path
  would be the refused option re-entering through metadata.
- **No capability gate.** Like the CLI (phase 12 §2.7), the Action does not
  pre-refuse doors the engine may one day serve: the `command` input's
  absence is a v1 inventory decision tied to the cross-process posture,
  revisited when the durable attempt lookup lands
  ([§7](#7-the-other-slices)) — not a verdict on the doors.
- **Ecoma appears nowhere** (invariant 2.12).

## 3. The step surface — outputs and conclusions

### 3.1 Outputs — one envelope, verbatim

**Decided: one output, `outcome`, carrying the `--json` envelope
byte-for-byte** — the captured stdout of the invocation, written to
`$GITHUB_OUTPUT` with one deliberate shape: the envelope, then an **empty
line**, then the delimiter (`renderJson` emits one compact line plus a
trailing newline, so the value is single-line-safe). The platform fact that
forces the shape, recorded so nobody simplifies it back: the runner's
file-command parser consumes the value's final newline before the delimiter
(it substrings each content line without its trailing newline —
actions/runner's `FileCommandManager`; actions/runner#1182), so a bare
heredoc would deliver `outputs.outcome` **without** the envelope's trailing
newline and the equality pin below would fail on every run. The empty
content line absorbs that consumption — the parser eats its empty line, and
the envelope's own trailing newline survives. The write is pinned against
the runner's documented parse in [§6](#6-test-obligations), fixture 3, and
the dogfood's first real run re-proves it on the runner itself. The
envelope is also relayed to the step log verbatim — display, not
translation. A caller diffing `steps.release.outputs.outcome` against the
same invocation's CLI stdout must find them equal, byte for byte.

- **No shaped outputs.** `tag`, `plan-id`, `handle` as separate outputs
  would require the Action to parse the envelope and re-emit selected
  fields — a second schema over the outcome union, and the parser that
  maintains it is a translation surface the pass-through law refuses
  (phase 12 §3.1's "no field dropped, no outcome converted", one layer up).
  A consumer extracts with `jq` from the verbatim envelope, in the workflow
  that owns the reading.
- **The 1 MB ceiling, named.** The runner truncates step outputs larger than
  1 MB with a warning rather than a hard failure. The envelope's realistic
  size is kilobytes — `kind`, `planId`, `handle`, `tag`, the `drives` list —
  because the outcome union carries no changelog-bearing payload (phase 12
  §3.1's verbatim rendering carries the walk's evidence, not prose). The
  ceiling does not bind today; the byte-equality fixture is what would catch
  the day it does (truncation breaks equality loudly), and a future union
  that grows past it is a phase 12 amendment first.

### 3.2 The conclusion table

The outcome kind → step conclusion. The table is total over the
`RunOutcome` union — mirroring `EXIT_CODES`' exhaustive record
(`src/cli/exit-codes.ts`, verified) — though the `run` door's reachable
subset today is narrower; the rows beyond it are pinned as typed rows with
the same honesty as phase 12 §6, obligation 2. `satisfied-externally`,
`resolved`, and `abandoned` are outcomes the declarations-less one-shot
`run` does not return today — phase 12 §6, obligation 2, names the class —
and `resume` outcomes arrive through no input this inventory offers.

| Kind                   | Exit                                                                                                                                                                                                                              | Conclusion | The annotation (`::error::` line, fields verbatim)                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `published`            | 0                                                                                                                                                                                                                                 | success    | none required                                                                                                                                                                                                     |
| `satisfied-externally` | 1                                                                                                                                                                                                                                 | success    | typed row — the one-shot `run` never returns it today; when reachable it names ledger-first done-ness, the evidence reads back through `show` (phase 12 §3.2)                                                     |
| `resolved`             | 2                                                                                                                                                                                                                                 | success    | typed row — `run` never returns it today                                                                                                                                                                          |
| `abandoned`            | 3                                                                                                                                                                                                                                 | success    | typed row — `run` never returns it today                                                                                                                                                                          |
| `refused`              | 10                                                                                                                                                                                                                                | failure    | `refused` + `detail` verbatim                                                                                                                                                                                     |
| `denied`               | 11                                                                                                                                                                                                                                | failure    | `denied` + `holder` — another attempt owns the scope; the winner is named                                                                                                                                         |
| `blocked`              | 12                                                                                                                                                                                                                                | failure    | `blocked` + `cause` — needs a human resolve, then resume; **never** a retryable failure                                                                                                                           |
| `failed`               | 13                                                                                                                                                                                                                                | failure    | `failed` + `cause` — inspect the tail; a later resume re-judges                                                                                                                                                   |
| `conflict`             | 14                                                                                                                                                                                                                                | failure    | `conflict` + `detail` — a human judges                                                                                                                                                                            |
| `ambiguous`            | 15                                                                                                                                                                                                                                | failure    | `ambiguous` + `detail` — never success (invariant 2.6), never folded into `failed`                                                                                                                                |
| `stale`                | 16                                                                                                                                                                                                                                | failure    | `stale` + `detail` verbatim — re-plan                                                                                                                                                                             |
| `escalate`             | 17                                                                                                                                                                                                                                | failure    | `escalate` + `detail` — a human judges the tail                                                                                                                                                                   |
| usage fault            | 64                                                                                                                                                                                                                                | failure    | the first stderr line verbatim (stdout is empty — pinned by phase 12 §3.3)                                                                                                                                        |
| escaped throw          | 70                                                                                                                                                                                                                                | failure    | the first stderr line verbatim — `Name: message`, never translated into an outcome                                                                                                                                |
| no verdict             | any other exit or signal; missing or unparseable envelope; kind↔exit mismatch; a provisioning step faulting before the invocation — there the failing step's own conclusion fails the job, and no exit or signal exists to record | failure    | `no verdict` + the raw exit or signal — the run produced no verdict; the recorded evidence is the truth (a pre-invocation fault emits no annotation — the failing step's own log and conclusion are the evidence) |

Every stop-band row concludes failure. GitHub offers no verdict-shaped
status below success; the distinction the table must preserve lives in the
annotation and the verbatim kind in the envelope — the surrounding
automation tells "needs a human" from "broken" by the kind it reads, never
by an exit code it guesses at.

### 3.3 The rules the table pins

- **The step conclusion is not the exit code.** `satisfied-externally` exits
  1 — a shell reads failure; the Action concludes success. (It is a typed
  row today — the example stands for the day the row is reachable, which is
  exactly when the distinction first bites.) The exit table
  (phase 12 §3.2) answers "did the invocation do what it said" to a process;
  the conclusion table answers "what did the release do" to a workflow; the
  kind is the one verdict, and both renderings key on it. An Action that
  propagated the exit code would lie about `satisfied-externally` (and
  `abandoned`); an Action that mapped exit codes to conclusions _without_
  the kind would have no defense against the two drifting apart — so the
  table requires both, and their disagreement is the no-verdict row.
- **`ambiguous` never success, and never `failed`.** Invariant 2.6 at the
  automation layer: a store's undecided landing must not let a matrix job
  read a half-decided release as landed. Its annotation is its own word, so
  the log and any reader distinguish "verify through a read, then resume"
  from "inspect a fault".
- **`blocked` (12) is not `failed` (13).** Phase 12 §3.3's rule rendered for
  automation: a blocked stop routes a human to `resolve` + `resume`; a
  failed stop routes tail inspection and a re-judging resume. Collapsing
  the annotations sends the surrounding automation to the wrong remedy —
  the retry-shaped one over a human-required one.
- **`abandoned` proceeds** because the door did what the operator asked
  (E-09; terminal is terminal) — a typed row today, pinned so the day
  `run`'s union reaches it the conclusion does not move.
- **Faults are never verdicts.** Exit 64/70 carry the fault text verbatim
  and conclude failure; an invocation that never reached a door has no
  release verdict to render, and the Action does not invent one by calling
  a usage fault a `refused`.
- **Fail closed on the missing verdict.** A killed process — the caller's
  timeout, a runner death, an OOM — leaves no envelope; the conclusion is
  failure with the raw exit or signal. _Rejected alternative: GitHub's
  `neutral` conclusion_ (the act-of-god suggestion weighed when this table
  was drafted): neutral leaves the _job_ green, and a release step that
  produced no verdict must not let surrounding automation read green — the
  engine's own fail-closed law (invariant 2.6) reaches the last layer as
  failure, and the recorded evidence is what a human reads when the red
  sends them looking. When the runner itself cancels the step, the runner
  renders its own conclusion and the Action never speaks; this contract
  does not interpret that rendering.
- **One table, two renderings.** The kind↔exit agreement is an integrity
  pin: both derive from `EXIT_CODES`, and a mismatch means the CLI under
  the pinned SHA and the Action disagree — exactly the loud way to find
  that.

## 4. Hermeticity in CI — the two lines

The runner is ambient wall to wall. The contract holds the line at two
places, outer and inner, and names what each owns:

- **The outer line — the invocation step's environment, constructed by
  allowlist.** The child runs under `env -i` with exactly: `PATH` (the
  step's own, so `node` and `git` resolve), and `HOME` pointed at a fresh
  empty directory under `$RUNNER_TEMP` (so any leaked `HOME`-relative
  config read finds nothing). Nothing else: no `GITHUB_*`, no `ACTIONS_*`,
  no `RUNNER_*`, no `CI`, no `INPUT_*`, no `NODE_OPTIONS`,
  no `NODE_COMPILE_CACHE`. The declared inputs enter as **argv, through
  `${{ inputs.* }}` interpolation** — the one channel. The runner _also_
  injects every input as an `INPUT_<NAME>` environment variable into a
  composite's `run:` steps (documented runner behavior), which is why
  `env -i` is load-bearing rather than decorative: without it, every input
  would silently have a second, ambient channel beside the reviewed
  interpolation. No Action script reads `INPUT_*`; the suite pins that a
  planted `INPUT_*` lie changes nothing
  ([§6](#6-test-obligations), fixture 4).
- **The inner line — the binding's floor, inherited verbatim.** Every git
  spawn runs on `hermeticGitEnv()` (`src/adapters/git/git-run.ts`, verified):
  process env minus the leaked repository context (`GIT_DIR`,
  `GIT_WORK_TREE`, `GIT_TRACE*`, the `GIT_CONFIG*` injection channels, …),
  plus `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, and the baked deterministic commit
  identity. The CLI opens the binding and inherits the floor; the Action
  adds no env plumbing of its own and no flag that could inject one (phase
  12 §4, carried up unchanged). Defense in depth is the point of two lines:
  the inner line would strip a leaked `GIT_DIR` the outer missed; the outer
  line is what keeps ambient lies from reaching _planning_ at all — the
  floor passes `GITHUB_*` through untouched (harmless to git, but the law
  is that the process reads nothing ambient, and the outer line is what
  delivers that law to the node process).

**Allowlist, decided.** The posture is allowlist (`env -i` plus two names),
never a blocklist, for the reason this repository has already measured in
another gate: `ci.yml`'s `ci-gate` states it — "a deny-list of known-bad
states fails OPEN on any state it does not know." The runner's ambient set
grows with every runner release (new `ACTIONS_*`, new `GITHUB_*`); a strip
list enumerating today's variables is tomorrow's silent leak. `env -i` plus
the allowlist is the whole policy, and the review of the policy is the
review of the list.

- **`NODE_OPTIONS` is a supply-chain leg, not hygiene.** A hostile
  `NODE_OPTIONS` in the runner environment is arbitrary code injection into
  the node process; `env -i` strips it before node starts. The
  hostile-environment fixture plants exactly this and pins the run unchanged.
- **stdin.** The invocation reads none; the child's stdin is closed
  ([§2.5](#25-the-world-document-in-ci-a-path-never-a-stream)). Nothing is
  read interactively — no prompt, no confirmation — because no door offers
  one (phase 12 §4's rule, inherited).
- **Protocol files.** `GITHUB_OUTPUT` is written by the _outer_ step shell
  only (the child sees no `GITHUB_*` at all — the envelope reaches the
  output through the outer shell's file handle, not through the child's
  environment). `GITHUB_ENV` is never written by this Action — no ambient
  smuggling of anything into downstream steps. `GITHUB_STEP_SUMMARY` is
  unused in v1; the envelope in the log and the output are the surfaces.
- **The cwd resolution, stated explicitly.** Phase 12 §4's law — "no
  working-directory default stands in for `--repo`" — binds the _process's
  inputs_: the CLI receives a literal `--repo` and never consults its
  working directory. The Action makes both sides declared. The invocation
  step's cwd is `${{ inputs.working-directory }}`, whose _default_ is
  `${{ github.workspace }}` — a declared runner fact, resolved by the
  runner and written into reviewed, versioned action metadata: the same
  kind of declared value as a grammar default, not an ambient read by any
  process. `repo` defaults to `.` — declared argv resolving against that
  declared cwd. Nothing is inferred at any layer; the law survives because
  both values are spelled.

## 5. Laws

- **Assemble and call.** The Action turns action metadata into argv, runs
  one command, and renders what came back. Everything else — validation
  beyond the metadata's demanded rows, composition, retry, a second
  projection of repository state — is drift (invariant 2.10).
- **The envelope rides verbatim, out as well as in.** The `outcome` output
  is the captured stdout; the annotations quote fields verbatim; no layer
  between the door and the workflow rewords the engine.
- **The conclusion is a rendering of the kind, never a verdict of its own.**
  One table, keyed on the kind; the exit code is its integrity check.
- **Fail closed on the missing verdict, loudly, at the last layer**
  (invariant 2.6): `no verdict` is a failure, never green, never neutral.
- **Declared, never ambient — one layer up.** The actor is the author's
  declared word; the inputs enter through interpolation; the environment is
  an allowlist; `github.workspace` is declared metadata. The runner's
  ambient layer reaches nothing past the provisioning steps.
- **No git outside the binding's runner, against the target repository.** No
  fetch, no push, no tag, no config write by the Action's own hand — the
  binding's spawns are the only git the target repository sees from this
  surface.
- **No retry policy of its own.** E-08's bounded sequence retry is the
  kernel's clause, driven by the declared `max-retries`; the Action neither
  retries a door nor loops a command, and this contract publishes no
  workflow recipe that would paper over a stop — no `if: always()`
  composition advice anywhere in it. A workflow that wants retries writes
  its own loop and reads the kind.
- **No writes outside the walk.** No push, no release, no changelog, no
  ref enumeration for publication — the walk's local writes are the
  surface's whole footprint ([§2.8](#28-the-tokens-journey-decided-empty)).
- **No user code, no invented code.** The empty declaration (phase 12 §2.6)
  is inherited verbatim; an input that named a module path would be the
  refused option re-entering through metadata, and the inventory refuses it
  by name.
- **Ecoma appears nowhere** (invariant 2.12;
  [product-boundary.md](product-boundary.md)).

## 6. Test obligations

The implementation slice's suite is an **artifact suite: it drives the
composite's invocation as a transcript**, because the contract's subject is
the step envelope — the assembled argv, the constructed environment, the
conclusion, the output — not the modules (the boundary's and CLI's suites
already cover those; phase 11 §5, phase 12 §6).

1. **One invocation script, driven as a subprocess.** The argv assembly and
   environment construction live in one script file in the repository (the
   composite's step invokes it); the suite executes that file directly. The
   same fixture pins the Action's build command equal to the moon task's
   command (`tsc -p tsconfig.build.json`) so the two definitions of "build"
   may not drift, and pins the runner-behavior facts provisioning rests on
   ([§2.7](#27-the-invocation-the-constructed-command)): the materialized
   `github.action_path` tree is what the build stands in, and the invocation
   executes the bin built from it. The toolchain pin joins that list as a
   **drift row**: the composite's declared values (`node-version`,
   `version` — [§2.2](#22-the-kind-composite-hermeticity-deciding)) are
   asserted equal to the repository's own pin files at the materialization
   (`node-version` = `.node-version`'s content, `version` =
   `packageManager`'s `pnpm@<version>` value), the same
   declared-value-versus-repo-file shape as the build-command pin above — a
   toolchain bump that edits the repo files but not the composite (or the
   reverse) goes red. The adversarial form is retained structurally: the
   composite declares no file-path input at all, so a consumer workspace's
   own `.node-version` is provably unread, and its root `packageManager`
   cannot re-pin the Action's toolchain — the declared `version` wins; a
   disagreement makes provisioning throw loudly
   ([§2.2](#22-the-kind-composite-hermeticity-deciding)'s owned residual), a
   fault, never a silent different-toolchain install. The metadata rows are
   enforced by fixture 8's gate.
2. **The conclusion table, pinned kind by kind.** Every
   [§3.2](#32-the-conclusion-table) row asserted by envelope kind, expected
   conclusion, and annotation content. The rows the declarations-less
   one-shot `run` cannot produce today (`satisfied-externally`,
   `resolved`, `abandoned` — phase 12 §6.2's own class) are pinned as typed
   rows through the harness's outcome injection, declared here so a later
   slice that makes one reachable moves the pin as part of its own
   obligations rather than reading the suite as under-tested (phase 12
   §6.2's posture, one layer up).
3. **Byte-equality, proven against the runner's own parse.**
   `steps.*.outputs.outcome` equals the same invocation's CLI `--json`
   stdout, byte for byte — including the trailing newline `renderJson`
   emits — for every fixture. The harness drives the invocation script with
   the outputs path pointed at a temp file and replays the runner's
   file-command parse over what was written (each content line taken
   without its trailing newline, the delimiter line dropped —
   [§3.1](#31-outputs-one-envelope-verbatim)'s platform fact), asserting the
   surviving value equals stdout exactly; the empty-line write is what
   makes the assertion hold, and the dogfood's first real run re-proves it
   on the runner itself. A `drives`-bearing `published` outcome from a real
   temp-repo walk (the binding's own `withTempRepo` harness) is the
   realistic-size pin under the 1 MB output ceiling.
4. **The hostile-environment leg.** The invocation under a planted ambient —
   lying `GITHUB_*` values, `ACTIONS_*`, `RUNNER_*`, `CI=true`,
   `INPUT_WORLD` naming a different document, `GIT_DIR` pointing elsewhere,
   a `NODE_OPTIONS` carrying a marker, a token-shaped `GH_TOKEN` — must
   produce an envelope byte-identical to the clean-environment run, with no
   planted value reachable anywhere in the envelope, the annotation, or the
   conclusion. This is the two-lines probe: phase 12 §6.5's isolation
   fixture, extended to the runner's ambient layer.
5. **The token-journey pin.** v1's journey is empty, so the pin is the
   negative inventory, executable: the action metadata declares no token
   input, references no secret anywhere, and names no `actions/checkout`
   step — the composite performs no checkout of any repository (the
   consumer's is the caller's step; the Action's own sources arrive as the
   runner's materialization), so `persist-credentials` is vacuously
   satisfied and pinned as such; the invocation script names no `git`
   invocation of its own.
6. **The inputs' negative inventory.** The refused inputs
   ([§2.3](#23-the-inputs-action-metadata-onto-the-closed-grammar)) are
   asserted absent from the metadata — `assembly`, `command`, `json`,
   `token`, `declarations`, `naming-module`, `target` — phase 12 §6.4's
   fixture, one layer up. The multiline rule is pinned at its edges: the
   dropped trailing newline, the interior empty line forwarded verbatim
   (`--tag-namespace ""` accepted, `--intent ""` usage-faulted).
7. **Determinism at the step.** Double invocation over one declared world —
   byte-identical outputs and the same conclusion (phase 2 §2.14's law at
   the automation layer).
8. **The metadata gate.** `action.yml` is scanned by no policy gate today —
   `check:workflows` walks `.github/workflows` only. The implementation
   slice extends the policy suite (or the required-files gate) to validate
   the action metadata: schema, the org-law rows (40-character SHA pins on
   any `uses:` step, `persist-credentials: false` on any checkout, no
   secrets in `run:`), the input inventory of
   [§2.3](#23-the-inputs-action-metadata-onto-the-closed-grammar), and the
   provisioning steps' `with:` rows by name — the declared toolchain values
   (`node-version`, `version`) and the absence of any file-path resolution
   input (`node-version-file`, `package_json_file` — the mangled-join
   mechanism of [§2.2](#22-the-kind-composite-hermeticity-deciding) must be
   unrepresentable, not merely unused). Without this, the contract's
   metadata decisions are gated by nothing the day the slice merges — the
   gate is part of the slice, not a follow-up.

## 7. The other slices

- **The certification fixture (task #10)** consumes this contract's
  pinned surfaces — the conclusion table and the byte-equality — as
  fixtures across its own scenarios; its design slice owns scenario
  selection and fixture data. This contract names what it consumes and
  designs none of it.
- **The self-dogfood (task #11)** runs this Action on this repository's own
  releases. The ordering follows the ladder: the Action's implementation
  slice lands first. The honest v1 dogfood verdict, stated so nobody
  discovers it in a release run: the walk's records and the minted tag land
  in the runner's copy of the repository; until the publishing slice, the
  dogfood verifies verdicts, conclusions, and recorded evidence — not
  remote tags.
- **The publishing slice** owns remote publication and the token's real
  journey. It starts from [§2.8](#28-the-tokens-journey-decided-empty)'s
  constraints — nothing persisted to disk or repo config, nothing ambient
  in the Action's environment (a child-scoped transport env is the in-tree
  precedent's class, named there), process-scoped transport — and decides
  the mechanism in its own PR.
- **The world-reader slice** (phase 12 §7) is where `--world` gains a
  legitimate alternative source; the Action's `world` input may grow a
  spelling there, in that slice's PR — never amended silently here.
- **The durable attempt lookup** (phase 11 §4, question 6) turns the
  cross-process doors from refused to working; the `command` input's
  refusal ([§2.3](#23-the-inputs-action-metadata-onto-the-closed-grammar))
  is a v1 posture tied to that posture, revisited when the lookup lands —
  the inventory may grow with the doors it can honestly serve.

## 8. Open questions for the maintainer

The contract decides the shape and the discipline; these are deliberately
left open, each with its proposed default:

1. **The phase number.** "Phase 13" is proposed — the phase after the CLI —
   and this document's name follows it; renumbering is a rename, not a
   redesign.
2. **The placement.** Root `action.yml` is decided here
   ([§2.1](#21-the-placement-and-the-pinning-story)); the separate-repo
   option is refused, not erased — the maintainer's eyes belong on it
   before the first consumer pins, because the pinning story ships once.
3. **Container actions.** Refused
   ([§2.2](#22-the-kind-composite-hermeticity-deciding)); the proposed
   standing answer is "not unless a slice needs an isolation boundary bash
   cannot draw" — which v1 does not.
4. **Convenience outputs** (`tag`, `plan-id`, `handle`). Refused in v1 —
   derivable by `jq` from the verbatim envelope; proposed to stay refused
   until a consumer exists that cannot parse JSON in a `run:` step.
5. **A plan-only dry-run input.** Refused in v1 — a plan gate is a workflow
   step running the built bin's `plan` command directly, which the
   provisioning already makes possible; the Action stays the release
   execution surface.
6. **The provisioning root.** Decided: the runner's materialization at
   `github.action_path`, no second checkout
   ([§2.7](#27-the-invocation-the-constructed-command)) — the alternative
   was weighed and refused there. What stays open is the maintainer's eyes
   on _relying_ on that materialization before the first consumer pins:
   proposed default is to rely on it, with fixture 1 pinning the
   materialization guarantee and the context spelling against the current
   runner so a runner change breaks the suite before it breaks a release.
7. **The cold-start cost.** Build-from-source at the pinned SHA costs a
   `pnpm install` plus `tsc` per run, minutes on a release job; a committed
   bundle would buy it back and cost the repo's build-not-commit hygiene
   ([§2.2](#22-the-kind-composite-hermeticity-deciding)). Proposed: accept
   the minutes. If a consumer's latency ever matters, caching the toolchain
   (not committing the artifact) is the lever that keeps one source of
   truth.
8. **The timeout posture inside a composite.** The runner grants no
   `timeout-minutes` to steps inside a composite action — the caller's
   job-level timeout is the only bound; the implementation slice verifies
   this against the runner's current behavior. Proposed posture either way:
   a killed run is a no-verdict failure ([§3.3](#33-the-rules-the-table-pins)),
   never a verdict, and the contract gains no timeout knobs of its own.
