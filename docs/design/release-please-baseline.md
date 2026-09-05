# release-please Behavioral Baseline

Phase 0 research artifact for release-craft. Documents observable behavior and
limitations of [release-please](https://github.com/googleapis/release-please)
so that someone who has never read its source can decide what release-craft
must be able to express.

> **Version stamped:** commit `c65408d9f68b2772c6e61dcdc4a8b6f5969bb4e1`
> on `main` (2026-09-05). Claims verified against that snapshot. Anything
> unverifiable from public docs or source is labeled `UNVERIFIED`.

## Source legend

| Label      | Meaning                                                      |
| ---------- | ------------------------------------------------------------ |
| OBSERVED   | Directly quoted from the source file or documentation listed |
| INFERENCE  | Logical conclusion drawn from observed facts; not quoted     |
| UNVERIFIED | Could not confirm from the sources fetched in this run       |

---

## 1. Conventional Commits parsing

### 1.1 Supported types

**OBSERVED** — The commit parser (`src/commit.ts`) calls
`@conventional-commits/parser` with `conventional-commits-filter`. The
`splitMessages` function splits on a blank line followed by any of the
Conventional Commits types:

```
feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert
```

(`src/commit.ts` — `splitMessages` regex, line ~410 of raw file)

Any type string is accepted by the underlying parser; release-please does not
enforce a whitelist beyond what the split regex recognizes for multi-commit
messages.

### 1.2 Breaking-change markers

**OBSERVED** — Three mechanisms are detected (all in `src/commit.ts`):

1. **`!` after scope** in the summary — parsed as `breaking-change` AST node in
   the summary section; the `breaking` field on `ConventionalCommit` is set to
   `true`.
2. **`BREAKING CHANGE` footer token** — the conventional-commits parser exposes
   this as a note with title `"BREAKING CHANGE"`. If present, `breaking` is set
   `true`.
3. **`BREAKING-CHANGE:` in commit body** — detected by a regex
   (`bodyString.match(/BREAKING-CHANGE:\s*(.*)/)`); the extracted text is
   appended to the existing `BREAKING CHANGE` note or creates a new one.

**OBSERVED** — Extended context is supported: lines after the initial breaking
change description that start with `#### ` or a bulleted list marker (`*- `)
are indented and kept as part of the note (post-processor
`hasExtendedContext`).

### 1.3 Scopes

**OBSERVED** — Scopes are parsed from the summary section
`(scope)` and stored as `ConventionalCommit.scope` (nullable string). Scopes
appear in changelog entries when `changelog-sections` mapping includes them
under a heading.

### 1.4 What is ignored by default

**OBSERVED** — Commits whose type is `chore`, `build`, `ci`, `style`, `test`,
or `revert` do not produce changelog entries by default. The README states:

> A releasable unit is a commit to the branch with one of the following
> prefixes: "feat", "fix", and "deps". (A "chore" or "build" commit is not a
> releasable unit.)

(README, "Release Please bot does not create a release PR. Why?")

**INFERENCE** — If _every_ commit since the last release is non-releasable
(`chore`/`build`/`ci`/etc.), no release PR is created. Language-specific types
are added for some strategies (e.g. `docs` is releasable for Java and Python).

### 1.5 Commit → bump mapping (default strategy)

**OBSERVED** — `src/versioning-strategies/default.ts`:

| Commit kind                                 | Bump      | Pre-1.0 exception                                |
| ------------------------------------------- | --------- | ------------------------------------------------ |
| Any commit where `commit.breaking === true` | **major** | `minor` if `bumpMinorPreMajor` is `true`         |
| `type === 'feat'` or `'feature'`            | **minor** | `patch` if `bumpPatchForMinorPreMajor` is `true` |
| Everything else (`fix`, `perf`, etc.)       | **patch** | —                                                |

**OBSERVED** — `Release-As: x.x.x` in a commit body (case-insensitive footer)
overrides all bump logic and forces the exact version. Commits are iterated
newest→oldest; the _first_ (newest) `Release-As` note wins.

### 1.6 Multi-commit messages

**OBSERVED** — `src/commit.ts` supports two mechanisms for bundling multiple
changes in one commit:

- **Trailing conventional-commit paragraphs** separated by a blank line: each
  paragraph is parsed as its own conventional commit.
- **`BEGIN_NESTED_COMMIT` / `END_NESTED_COMMIT` blocks** in the commit body:
  the inner content is split into additional commits.

### 1.7 Commit override (squash-merge only)

**OBSERVED** — `preprocessCommitMessage` in `src/commit.ts` checks the pull
request body for `BEGIN_COMMIT_OVERRIDE` / `END_COMMIT_OVERRIDE` and, if
present, replaces the entire commit message for parsing. This only works when
the commit carries its pull-request association (i.e. squash-merge); plain
merge commits have no PR body attached.

---

## 2. SemVer calculation

### 2.1 Default bump rules

Covered in §1.5. The `VersionUpdater` classes (`src/versioning-strategy.ts`):

- `MajorVersionUpdate.bump(v)` → `v.major+1, 0, 0, v.preRelease, v.build`
- `MinorVersionUpdate.bump(v)` → `v.major, v.minor+1, 0, v.preRelease, v.build`
- `PatchVersionUpdate.bump(v)` → `v.major, v.minor, v.patch+1, v.preRelease, v.build`
- `CustomVersionUpdate.bump(_v)` → `Version.parse(overrideString)`

**OBSERVED** — Major/minor/patch bumpers **preserve** `preRelease` and
`build` metadata from the input version. This means a minor bump of `1.2.3-beta`
yields `1.3.0-beta` (not `1.3.0`). This is non-standard SemVer; the prerelease
versioning strategy explicitly handles stripping/replacing prerelease parts
when needed (see §8).

### 2.2 How the last release is found

**INFERENCE from docs** (confirmed by `docs/manifest-releaser.md`):

1. **Manifest mode (default path):** release-please locates the most recent
   _merged release PR_ for the package. It reads the manifest file content at
   the commit of that merged PR to obtain the last-released version. Fallback:
   if the package version is absent from the merged-PR manifest, it reads the
   manifest at the tip of the configured target branch.

2. **Tag-based lookup** (`<component>-v<version>` tag search): used to find
   releases when there is no merged PR or when `--target-branch` differs from
   default. The `findRecentReleases` method searches GitHub releases by
   `tag_name` prefix matching (OBSERVED in `docs/manifest-releaser.md`
   "Subsequent Versions").

3. **`last-release-sha`** overrides the previous-release detection entirely and
   forces commits from a given SHA onward (top-level config, always processed).

### 2.3 No prior release

**OBSERVED** — When the manifest has no entry for a package and no merged
release PR exists, the default initial version is `0.1.0` for most strategies
and `0.0.0` for the `simple` strategy. The `initial-version` config option
overrides this (per-package or top-level). `bootstrap-sha` limits the commit
history scanned on the very first run and is _ignored_ on every subsequent run.

### 2.4 Mixed commits in one range

**OBSERVED** — All commits between the last release and HEAD are collected, then
parsed. The versioning strategy examines the full set and applies the _highest_
bump type: breaking > feature > patch. The commit order does not affect the
bump _magnitude_ (the "max" wins), but `Release-As` from the _newest_ commit
takes precedence.

### 2.5 `release-as` override

**OBSERVED** — Two paths:

- **In commit body:** `Release-As: x.x.x` (case-insensitive) — takes
  precedence over everything; resolved from newest commit.
- **In config:** `"release-as": "x.x.x"` — the config value is deprecated but
  still honored. Per-package `release-as: ""` (empty string) forces fallback to
  conventional commits even when a top-level `release-as` is set.

**OBSERVED** — After the release PR is merged, `release-as` in config should be
removed or updated; otherwise subsequent runs will continue proposing the same
version.

---

## 3. Changelog generation

### 3.1 Format

**OBSERVED** — The default changelog builder (`src/changelog-notes/default.ts`)
uses `conventional-changelog-writer` with the `conventional-changelog-conventionalcommits` preset.
The output follows the standard [Conventional Changelog](https://www.conventionalcommits.org/)
format: a `## <version>` header, `## Features` / `## Bug Fixes` etc. sections
with bulleted entries linking to commits and PRs.

**OBSERVED** — The `, closes` keyword is replaced with `, refs` in the commit
template to prevent GitHub from auto-closing referenced issues when the release
PR is merged.

### 3.2 Section grouping

**OBSERVED** — `changelog-sections` config overrides the preset's type→section
mapping. Each entry has:

```json
{ "type": "feat", "section": "Features", "hidden": false }
```

- `type`: the conventional commit type string.
- `section`: the heading under which the entry appears.
- `hidden`: if `true`, the type's entries are excluded from the changelog.

Default sections come from the `conventionalcommits` preset (e.g. `feat` →
"Features", `fix` → "Bug Fixes", `perf` → "Performance Improvements",
`docs` → "Documentation", etc.). UNVERIFIED: the exact full default list for
this version of the preset — it is defined in `@conventional-changelog/
conventionalcommits` package.

### 3.3 Ordering

**OBSERVED** — Entries are grouped by section in the order defined by
`changelog-sections`. Within each section, commits appear in the order
returned by the parser (newest first). The `changelog-type: "github"` option
delegates to GitHub's own release-notes API instead.

### 3.4 Note handling

**OBSERVED** — `BREAKING CHANGE` notes are rendered as special items within
their section. Issue references like `(#123)` are rewritten to full URLs, e.g.
`[#123](https://github.com/googleapis/release-please/issues/123)`.

### 3.5 Updating an existing changelog vs. creating

**OBSERVED** — release-please's changelog updater (`src/updaters/changelog-
md.ts`, not read in full but described in docs) prepends new entries under the
appropriate version heading. The first version entry also receives a full
`## [version] (date)` heading with a link. On first creation, a `# Changelog`
header is written.

**UNVERIFIED:** Exact handling of duplicate entries on re-runs (e.g. running
release-pr twice without merging).

### 3.6 `skip-changelog`

**OBSERVED** — `"skip-changelog": true` causes release-please to skip writing
the `CHANGELOG.md` update for that package. The release PR will still contain
version bumps in other files.

---

## 4. Release PR

### 4.1 Creation

**OBSERVED** — `release-please release-pr` (or `manifest-pr`, deprecated) opens
a pull request against the configured target branch (default: repository
default branch). The PR contains:

- Updated `CHANGELOG.md` (unless `skip-changelog`).
- Version bumps in language-specific files (`package.json`, `version.rb`, etc.).
- Updates to `extra-files` via annotation-based updaters.
- Updates to `.release-please-manifest.json` (manifest mode only).

Labels applied: `autorelease: pending` (customizable via `label`).

### 4.2 Update-on-new-commits behavior

**INFERENCE from docs:** When release-please runs again and finds an existing
open PR with the `autorelease: pending` label on the same head branch, it
updates that PR's body/title/files rather than creating a new one. With
`always-update: true`, the PR is refreshed even when the release notes have
not changed.

**UNVERIFIED from source** — exact diff-detection logic in manifest.ts
(scout pending).

### 4.3 Merge behavior

**OBSERVED** — Both squash-merge and merge commits work with release PRs. The
README "highly recommends" squash-merge for a linear history and clean
changelog.

### 4.4 PR title format

**OBSERVED** — Default pattern: `chore${scope}: release${component} ${version}`
(e.g. `chore(main): release foo-bar v1.2.3`). Customizable via
`pull-request-title-pattern`. The `${scope}` defaults to the target branch name.

### 4.5 Draft PRs

**OBSERVED** — `draft-pull-request: true` opens the release PR as a draft.

### 4.6 Signoff

**OBSERVED** — `--signoff "Name <email>"` or `"signoff"` in config adds a
`Signed-off-by` trailer to the release commit.

---

## 5. Manifest / state

### 5.1 Configuration files

**OBSERVED** — Two source-controlled JSON files at the repo root:

| File                            | Purpose                                                          |
| ------------------------------- | ---------------------------------------------------------------- |
| `release-please-config.json`    | Release configuration: packages map, top-level defaults, plugins |
| `.release-please-manifest.json` | Version tracking: `{"path/to/pkg": "x.y.z", ...}`                |

Default file names are overridable via `--config-file` and `--manifest-file`.

### 5.2 Repo-level vs. package-level

**OBSERVED** — Top-level keys in `release-please-config.json` apply as defaults
for every package. Per-package overrides live in `packages.<path>`:

```json
{
  "release-type": "python",
  "prerelease": true,
  "packages": {
    "libs/core": { "release-type": "node", "release-as": "" },
    "libs/cli": { "changelog-path": "docs/CHANGES.md" }
  }
}
```

**OBSERVED** — Required top-level key: `packages`. Everything else is optional
(schema: `schemas/config.json`, `"required": ["packages"]`).

### 5.3 State between runs

**OBSERVED** — The `.release-please-manifest.json` file is the durable state.
After a release PR merges, the manifest records each released package's new
version. On the next `release-pr` run, release-please reads the manifest at the
merged-PR commit SHA and uses those versions as the baseline.

**OBSERVED** — `bootstrap-sha` is consumed on the first `manifest-pr` run and
then ignored (the merged PR is the new baseline). `last-release-sha` is
permanent and always processed — it overrides the merged-PR lookup and must be
removed once the bad release is fixed.

### 5.4 `.release-please-manifest.json` can be manually edited

**OBSERVED** — Manual edits are appropriate only during initial bootstrap.
After that, release-please writes to the manifest on every merged release PR.

---

## 6. Monorepo behavior

### 6.1 Grouped releases (default)

**OBSERVED** — With a `packages` map, release-please creates a _single_ release
PR covering all changed packages. The PR body lists all affected packages and
their version bumps. The grouped PR title uses
`group-pull-request-title-pattern` (default: `"chore: release ${branch}"`).

### 6.2 Per-package releases

**OBSERVED** — `"separate-pull-requests": true` creates one PR per package that
has releasable changes. Each PR contains only that package's bumps.

### 6.3 Dependency-aware bumping (plugins)

**OBSERVED** — Plugins run _after_ individual strategies have determined each
package's bump, and _before_ PR creation/update. Plugins listed in config:

| Plugin            | Effect                                                                                                                                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node-workspace`  | Builds a dependency graph of local npm packages; if a dependency is bumped, dependents are patch-bumped and their `package.json` updated. `always-link-local: false` limits this to SemVer-range-compatible bumps. `updatePeerDependencies: true` also bumps `peerDependencies`. |
| `cargo-workspace` | Same for Rust/Cargo workspaces; also updates `Cargo.lock`.                                                                                                                                                                                                                       |
| `maven-workspace` | Same for multi-module Maven; `considerAllArtifacts: true` (default) considers all `pom.xml` files.                                                                                                                                                                               |
| `linked-versions` | Syncs versions across a named group: all components in the group are bumped to the highest version among them. Requires `groupName` and `components` list.                                                                                                                       |
| `sentence-case`   | Capitalizes the leading word in changelog entries (e.g. `patch issues` → `Patch issues`), with known exceptions (e.g. gRPC).                                                                                                                                                     |
| `group-priority`  | When a prioritized group (e.g. `["snapshot"]`) has pending changes, only that group's PRs are opened — blocking lower-priority groups.                                                                                                                                           |
| `merge`           | Merges multiple separate PRs into one combined PR.                                                                                                                                                                                                                               |
| `workspace`       | Generic workspace plugin (see schema).                                                                                                                                                                                                                                           |

**OBSERVED** — Workspace plugins (`node-workspace`, `cargo-workspace`,
`maven-workspace`) have a `merge` option: when combined with
`linked-versions`, set `merge: false` on the workspace plugin to avoid
duplicate merging logic.

### 6.4 Component tags

**OBSERVED** — In monorepo mode, each package gets its own release tag:
`<component>-v<version>` (default). The component name defaults to the
directory name; override via `"component"` in package config. The tag format
is controlled by:

- `include-component-in-tag` (default `true`): `false` → `v<version>` only.
- `include-v-in-tag` (default `true`): `false` → `<component>-<version>`.
- `tag-separator`: custom separator between component and version.

### 6.5 The `"."` package path

**OBSERVED** — A package at path `"."` reacts to changes anywhere in the
repository. Useful for a root package that aggregates all sub-packages.

---

## 7. Tag formats

**OBSERVED** — The default tag is `<component>-v<release-version>` (e.g.
`my-lib-v1.2.3`). Configuration knobs:

| Option                     | Default | Effect                            |
| -------------------------- | ------- | --------------------------------- |
| `include-component-in-tag` | `true`  | `false` → `v<version>`            |
| `include-v-in-tag`         | `true`  | `false` → `<component>-<version>` |
| `tag-separator`            | `-`     | Custom separator                  |

**OBSERVED** — Tags are created at the commit that was merged via the release
PR (the HEAD of the release PR branch at merge time). For manifest releases
with grouped PRs, tags are created per-package.

---

## 8. Prerelease

### 8.1 Configuration

**OBSERVED** — Two settings must both be configured:

1. `"prerelease": true` — marks GitHub Releases as prerelease.
2. `"versioning": "prerelease"` — uses the prerelease versioning strategy.

Setting only `"prerelease": true` without the prerelease versioning strategy
will mark the GitHub Release as prerelease but the version string will be a
full semver (e.g. `1.3.0` not `1.3.0-beta.1`). INFERENCE: this is a common
mistake.

### 8.2 How prerelease versions progress

**OBSERVED** — `src/versioning-strategies/prerelease.ts`:

| Scenario                                                                  | Behavior                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Current version has prerelease (e.g. `1.2.3-beta01`), bump is patch-level | Prerelease number incremented: `1.2.3-beta02`. Leading zeros preserved.  |
| No existing prerelease, feat commit                                       | New prerelease version: `<next>.0-<prereleaseType>` (e.g. `1.3.0-beta`). |
| `prerelease: false` in config, prerelease strategy selected               | Prerelease suffix is **stripped** — produces a full release version.     |

**OBSERVED** — `bumpPrerelease(prerelease)`: finds the last number group in the
prerelease string via `/(?<number>\d+)(?=\D*$)/`, increments it, and preserves
zero-padding. If no number exists, appends `.1`. If multiple numbers exist
(e.g. `beta01-01`), only the last set increments.

### 8.3 Known limitations

1. **Must use the `prerelease` versioning strategy** — the `default` strategy
   does not produce prerelease suffixes even when `"prerelease": true` is set.
2. **Cannot coexist with stable releases on the same branch** — once a branch
   produces a prerelease version, all subsequent releases on that branch are
   prerelease unless `Release-As: x.y.z` (without prerelease) is used.
3. **No concurrent stable + prerelease line from the same release-please config** —
   you cannot have two packages where one is stable and one is prerelease with
   the same major version being bumped, without separate config or
   `Release-As` overrides. INFERENCE from behavior.
4. **Incremental prerelease numbering works across runs** (manifest stores the
   prerelease version; `bumpPrerelease` increments). However the prerelease
   _line_ is always attached to the same major.minor.patch — it does not
   advance the major/minor/patch while in prerelease mode.
5. **Minor/major bumps while in prerelease**: `PrereleaseMinorVersionUpdate`
   only bumps the prerelease number if `patch === 0` (e.g. `1.3.0-beta` →
   `1.3.1-beta`); otherwise it drops to a full `MinorVersionUpdate` (producing
   `1.4.0` without prerelease). This asymmetry is a subtle edge case.
   UNVERIFIED by tests in this run.

---

## 9. Multiple release branches / fork mode / backports

### 9.1 Target branch

**OBSERVED** — `--target-branch` (or `target-branch` in config) sets the
branch to open the release PR against and to tag releases on. Defaults to the
repository's default branch.

### 9.2 Branch support (major-version branches, maintenance)

**INFERENCE** — The standard pattern for backport/maintenance branches is to
run release-please as a separate workflow on each branch. Example for a
`v1-maintenance` branch: configure a GitHub Actions workflow that triggers on
pushes to `v1-maintenance` and passes `--target-branch v1-maintenance` (or a
workflow matrix per branch). Each branch maintains its own release PR and tags.

**UNVERIFIED:** Whether release-please has built-in multi-branch coordination
or whether this is purely an external wiring concern.

### 9.3 Fork mode

**OBSERVED** — `"fork": true` (or `--fork`) creates the release PR from a
fork of the repository instead of the same repo. This is useful when
`GITHUB_TOKEN` lacks write permission to open PRs directly.

### 9.4 Cherry-pick backports

**OBSERVED** — release-please does not manage cherry-picks itself. The
documented workflow is: (1) cherry-pick commits to the backport branch, (2)
run release-please on that branch. The `always-bump-patch` versioning
strategy is recommended for backport branches to ensure a patch bump on every
release.

---

## 10. Snapshot / lockfile handling

### 10.1 Java SNAPSHOT versions

**OBSERVED** — The `java` and `maven` strategies can propose SNAPSHOT
versions. After each stable release, release-please may open a snapshot PR
bumping the version to `<next>-SNAPSHOT` (e.g. `1.2.3-SNAPSHOT`). The snapshot
PR carries the label `autorelease: snapshot` (configurable via
`snapshot-label`).

**OBSERVED** — The `--next-snapshot-version` and `skip-snapshot` options
control whether snapshot PRs are generated. Snapshot releases are a
language-specific concern (Java/Maven only).

### 10.2 Node lockfile

**UNVERIFIED** — Whether release-please updates `package-lock.json` or
`pnpm-lock.yaml` during release PRs. The `node` strategy updates
`package.json`; lockfile updates may be expected from CI.

---

## 11. Failure / recovery

### 11.1 Re-running after a failed run

**OBSERVED** — release-please is idempotent: re-running `release-pr` after a
failure (e.g. API timeout, rate limit) is safe. It will find the existing PR
by its head branch and label and update it, or create a new one if no PR exists.

### 11.2 PR conflicts

**INFERENCE from docs and source structure** — When an existing release PR has
merge conflicts with the target branch, release-please detects this via the
GitHub API (`mergeable` / `mergeable_state`). In manifest mode, it creates a
**new PR** with a different branch name (the head branch is de-duplicated with
a suffix) rather than attempting to resolve the conflict automatically.

**UNVERIFIED:** Exact branch-name de-duplication logic in `manifest.ts`.

### 11.3 Partial failures mid-monorepo release

**OBSERVED** — `manifest-release` (now `github-release`) creates releases
sequentially or concurrently (controlled by `sequential-calls`). If any single
package release fails, the command can be re-run safely; it creates only the
releases that are still missing. "Creating all the releases is not
transactional." (docs/cli.md, `manifest-release` section).

### 11.4 What release-please does NOT do

**OBSERVED:**

- **No automatic npm/pypi/cargo publish.** The GitHub Action outputs
  `releases_created` and per-package `paths_released`; the _user's workflow_
  is responsible for actual publication. The action README example shows
  manual `lerna publish from-package` after the release step.
- **No lockfile management** (stated limitation in README: "It does not handle
  publication to package managers or handle complex branch management").
- **No semantic merge conflict resolution** — if the release PR conflicts, a
  new PR is opened; the user must resolve conflicts by merging the new PR.
- **No draft-release tag creation by default.** Draft GitHub Releases do not
  get a git tag until published. This can cause release-please to miss the
  previous release on re-runs — mitigated by `force-tag-creation: true`.

### 11.5 The `autorelease: pending` label stuck scenario

**OBSERVED** — If the tag was not removed on a previous release (due to GitHub
API failure), release-please sees an existing `autorelease: pending` PR and
will not create a new one. Remedy: manually remove the stale label.

---

## 12. Configuration model

### 12.1 Where config lives

| Source                          | Scope            | Notes                                                            |
| ------------------------------- | ---------------- | ---------------------------------------------------------------- |
| `release-please-config.json`    | Repo, committed  | Primary config for manifest mode                                 |
| `.release-please-manifest.json` | Repo, committed  | Version state only                                               |
| CLI flags                       | Per-run          | Override config file values                                      |
| GitHub Action inputs            | Per-workflow-run | Map to CLI flags; see action.yml                                 |
| `.github/release-please.yml`    | Legacy           | Used by the v2 action; deprecated in favor of the manifest files |

### 12.2 Precedence

**INFERENCE** — CLI flags and action inputs override config file values. Per-
package overrides in the `packages` map override top-level defaults.

### 12.3 Plugins system

**OBSERVED** — Plugins are specified as an array in `release-please-config.json`
(top-level `"plugins"`). Each entry is either a string (`"node-workspace"`) or
an object with `type` plus plugin-specific options. Plugins receive the full
monorepo context (all packages' candidates, GitHub API, config) and can modify
the candidate PR list (merge packages, bump dependents, reorder). The
`ManifestPlugin` interface (`src/plugin.ts`) is the extension point.

---

## 13. GitHub Action inputs & outputs

**UNVERIFIED (action.yml not fetched; action lives in
`googleapis/release-please-action`)** — The action README documents:

| Output                                  | Type       | Description                       |
| --------------------------------------- | ---------- | --------------------------------- |
| `releases_created`                      | boolean    | `true` if any release was created |
| `paths_released`                        | JSON array | List of released package paths    |
| `prs_created` / `pull_requests_created` | JSON array | Created PR URLs                   |
| `prs`                                   | JSON array | PR details                        |
| `tag_name`                              | string     | Tag of the created release        |

Standard inputs: `token`, `release-type`, `command` (`release-pr` / `github-
release` / `manifest`), `default-branch` / `target-branch`, etc.

---

## 14. Versioning strategies (full list)

**OBSERVED** (from `docs/customizing.md`):

| Strategy            | Description                                                          |
| ------------------- | -------------------------------------------------------------------- |
| `default`           | Standard SemVer bumps (breaking → major, feat → minor, else → patch) |
| `always-bump-patch` | Every release bumps patch (useful for backport branches)             |
| `always-bump-minor` | Every release bumps minor                                            |
| `always-bump-major` | Every release bumps major                                            |
| `prerelease`        | Increments prerelease number; strips or adds prerelease suffix       |
| `service-pack`      | Maven service-pack versions (e.g. `1.2.3-sp.1`)                      |

---

## 15. Changelog types

| Type      | Description                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `default` | conventional-changelog-writer with conventionalcommits preset                                                                             |
| `github`  | GitHub's own [Generate release notes](https://docs.github.com/en/rest/releases/releases#generate-release-notes-content-for-a-release) API |

---

## 16. Extra files

**OBSERVED** — The `extra-files` config accepts:

- **Strings** (plain file paths): uses the Generic updater with inline
  annotations (`x-release-please-version`, `x-release-please-major`, etc.).
- **Objects** with `type: "json"` / `"yaml"` / `"toml"` / `"xml"` / `"pom"` /
  `"generic"`: targeted updates via `jsonpath` / `xpath`.
- **Glob support:** `glob: true` on object entries allows matching multiple
  files.

---

## 17. Classification table — release-craft implications

| Capability                                                                               | Classification   | Rationale                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conventional Commits parsing (types, `!`, BREAKING CHANGE)                               | **ADAPT**        | release-craft needs the same semantic but should own the parser — decouple from `@conventional-commits/parser` dependency and support richer scoped types.    |
| Commit-to-bump mapping (default: breaking→major, feat→minor)                             | **KEEP**         | This is the de facto standard SemVer mapping; reproduce the same observable rules.                                                                            |
| `Release-As` override                                                                    | **KEEP**         | Essential escape hatch; same footer semantics.                                                                                                                |
| Pre-1.0 bump dampening (`bumpMinorPreMajor`, `bumpPatchForMinorPreMajor`)                | **KEEP**         | Widely used pre-v1 behavior; same config knobs.                                                                                                               |
| CHANGELOG generation (conventionalcommits preset format)                                 | **ADAPT**        | Same output format for compatibility, but release-craft should own the template to avoid external preset drift.                                               |
| `changelog-sections` config                                                              | **ADAPT**        | Same idea (type→section mapping with hidden flag), but model it as a first-class config rather than passing through to a preset.                              |
| `changelog-type: "github"` (GitHub release-notes API)                                    | **OUT OF SCOPE** | Not core to a versioning engine; can be a future plugin.                                                                                                      |
| Release PR creation, update-on-new-commits                                               | **ADAPT**        | Same lifecycle (pending→tagged), but release-craft should support PR-based and non-PR-based flows (e.g. direct commits).                                      |
| Draft PR support                                                                         | **KEEP**         | Trivial, useful.                                                                                                                                              |
| PR title pattern customization                                                           | **KEEP**         | Same templating.                                                                                                                                              |
| Manifest config (`.release-please-manifest.json` + `release-please-config.json`)         | **REPLACE**      | release-craft should define its own state format; the two-JSON-file model is release-please–specific. Same concept (config + version state), different shape. |
| Per-package config overrides                                                             | **KEEP**         | Same hierarchical config pattern.                                                                                                                             |
| `bootstrap-sha` / `last-release-sha`                                                     | **ADAPT**        | `bootstrap-sha` (first-run boundary) is useful. `last-release-sha` is an emergency override; model as a general "last-known-good" pointer.                    |
| `initial-version`                                                                        | **KEEP**         | Same behavior for new packages.                                                                                                                               |
| Monorepo grouped releases (single PR)                                                    | **ADAPT**        | Same grouping concept; release-craft should support more granular grouping rules (not just path-based).                                                       |
| Separate PRs per package                                                                 | **KEEP**         | Same behavior.                                                                                                                                                |
| `node-workspace` plugin                                                                  | **ADAPT**        | Dependency-aware bumping is critical for JS monorepos; release-craft should support this generically, not tied to npm.                                        |
| `cargo-workspace` plugin                                                                 | **ADAPT**        | Same for Rust; make workspace graph a generic concept.                                                                                                        |
| `linked-versions` plugin                                                                 | **KEEP**         | Same observable behavior (sync versions in a group).                                                                                                          |
| `sentence-case` plugin                                                                   | **KEEP**         | Cosmetic, useful.                                                                                                                                             |
| `group-priority` plugin                                                                  | **ADAPT**        | Priority-based PR gating is useful; generalize beyond snapshot.                                                                                               |
| Tag format (`<component>-v<version>`, `include-v`, `include-component`, `tag-separator`) | **KEEP**         | Same formatting knobs.                                                                                                                                        |
| `include-component-in-tag: false`                                                        | **KEEP**         | Required for single-package repos using `v<version>` tags.                                                                                                    |
| Prerelease versioning strategy                                                           | **ADAPT**        | Same prerelease-number increment logic; however, the known asymmetry (minor/major bump dropping prerelease) should be fixed in release-craft.                 |
| `always-bump-patch` / `always-bump-minor` / `always-bump-major`                          | **KEEP**         | Backport/maintenance branch support.                                                                                                                          |
| `service-pack` strategy                                                                  | **OUT OF SCOPE** | Java/Maven-specific; not relevant to release-craft's polyglot domain.                                                                                         |
| `force-tag-creation`                                                                     | **KEEP**         | Prevents the draft-release + missing tag issue.                                                                                                               |
| `skip-github-release`                                                                    | **KEEP**         | For users with custom release infrastructure.                                                                                                                 |
| `skip-changelog`                                                                         | **KEEP**         | Same behavior.                                                                                                                                                |
| Fork mode PR creation                                                                    | **OUT OF SCOPE** | Operational concern for CI; release-craft focuses on version/changelog computation.                                                                           |
| `separate-pull-requests`                                                                 | **KEEP**         | Same behavior.                                                                                                                                                |
| `always-update`                                                                          | **KEEP**         | Same behavior.                                                                                                                                                |
| `sequential-calls`                                                                       | **KEEP**         | Rate-limit mitigation; same behavior.                                                                                                                         |
| `release-search-depth` / `commit-search-depth`                                           | **ADAPT**        | Same API-paginated search limits; release-craft should support similar depth bounds but may use a different search mechanism.                                 |
| Extra files (jsonpath, xpath, annotations)                                               | **KEEP**         | Same file-update model; essential for polyglot repos.                                                                                                         |
| `BEGIN_COMMIT_OVERRIDE` / `BEGIN_NESTED_COMMIT`                                          | **KEEP**         | Useful for squash-merge workflows; same semantics.                                                                                                            |
| `conventional-commits-filter` (revert filtering)                                         | **ADAPT**        | Same behavior (skip revert commits); verify exact filter logic before implementing.                                                                           |
| Snapshot PRs (Java SNAPSHOT)                                                             | **OUT OF SCOPE** | Language-specific; not core to release-craft.                                                                                                                 |
| `group-pull-request-title-pattern`                                                       | **KEEP**         | Same behavior for grouped PRs.                                                                                                                                |
| GitHub Action wiring (two-step: release-pr then github-release)                          | **ADAPT**        | Same lifecycle (PR→merge→tag+release), but release-craft should support richer orchestration (e.g. pipeline hooks).                                           |

---

## 18. Compatibility boundary

### Minimal set of observable behaviors a release-please user would expect

release-craft to preserve conceptually

1. **Conventional Commits as the primary signal** — `feat` → minor, `fix` →
   patch, `!` / `BREAKING CHANGE` → major.
2. **`Release-As` override** — exact version forced by commit footer.
3. **SemVer pre-1.0 dampening** — breaking changes bump minor (not major)
   before v1.0.0.
4. **CHANGELOG in conventionalcommits format** — same section headings, same
   bullet-point entries with commit/PR links, same breaking-change notes.
5. **Release PR lifecycle** — `autorelease: pending` → merge → tag →
   `autorelease: tagged`.
6. **Monorepo support** — multiple packages, grouped or separate PRs, per-
   package tags.
7. **Tag format** — `<component>-v<version>` (with `include-v` and
   `include-component` toggles).
8. **Version state** — a source-controlled file tracking each package's last
   released version; manifest survives between runs.
9. **Extra files** — version updates in arbitrary files via annotations or
   jsonpath/xpath.
10. **Dependency-aware bumping** — when a local dependency is bumped, dependents
    are notified (workspace plugin concept).

### What release-craft explicitly breaks or changes

1. **No two-JSON-file manifest** — release-craft defines its own state format
   (likely a single structured file, not `config.json` + `manifest.json`).
2. **No GitHub-specific lifecycle coupling** — release-please's PR + GitHub
   Release is one deployment path; release-craft supports direct tag/commit
   flows and pipeline hooks.
3. **No external conventional-changelog preset dependency** — changelog
   generation is fully internal.
4. **No language-specific strategies (node/python/rust/maven/java)** —
   release-craft uses a generic strategy model with pluggable file updaters.
5. **No snapshot/version-as-service-pack** — out of core scope.
6. **Prerelease asymmetry fixed** — the minor/major bump dropping prerelease
   suffix is corrected in release-craft.
7. **No fork-mode PRs** — CI orchestration concern, not a versioning concern.
8. **No `autorelease:` label lock** — release-craft uses a more robust
   "in-progress release" state that does not block on stale labels.

---

## Sources

| File                                    | URL                                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| release-please README                   | `https://github.com/googleapis/release-please/blob/c65408d/README.md`                               |
| manifest-releaser.md                    | `https://github.com/googleapis/release-please/blob/c65408d/docs/manifest-releaser.md`               |
| customizing.md                          | `https://github.com/googleapis/release-please/blob/c65408d/docs/customizing.md`                     |
| cli.md                                  | `https://github.com/googleapis/release-please/blob/c65408d/docs/cli.md`                             |
| config schema                           | `https://github.com/googleapis/release-please/blob/c65408d/schemas/config.json`                     |
| src/commit.ts                           | `https://github.com/googleapis/release-please/blob/c65408d/src/commit.ts`                           |
| src/versioning-strategies/default.ts    | `https://github.com/googleapis/release-please/blob/c65408d/src/versioning-strategies/default.ts`    |
| src/versioning-strategies/prerelease.ts | `https://github.com/googleapis/release-please/blob/c65408d/src/versioning-strategies/prerelease.ts` |
| src/versioning-strategy.ts              | `https://github.com/googleapis/release-please/blob/c65408d/src/versioning-strategy.ts`              |
| src/version.ts                          | `https://github.com/googleapis/release-please/blob/c65408d/src/version.ts`                          |
| src/changelog-notes/default.ts          | `https://github.com/googleapis/release-please/blob/c65408d/src/changelog-notes/default.ts`          |
| src/plugins/ (directory)                | `https://github.com/googleapis/release-please/tree/c65408d/src/plugins`                             |
