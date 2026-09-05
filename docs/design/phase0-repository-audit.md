# Phase 0 — Repository and existing-design audit

Task 0A of the Phase 0 discovery run for issue
[#13](https://github.com/ecoma-io/release-craft/issues/13) (release
planning/versioning engine). Discovery only: this document records what the
tree contains today, the constraints later phases must preserve, where the
current decisions will chafe against a many-primitive kernel plus a planning
layer, where the design deliberately left room to grow, and what could break
silently when it does.

Line references are to branch `johnitvn/phase0-audit` at commit `db2b143`.

Every claim below carries one of three labels:

- **OBSERVED** — read directly from a file in this tree (file:line given).
- **INFERENCE** — a conclusion drawn from observed facts, with the facts named.
- **RECOMMENDATION** — advice for a later phase; binds nobody.

## 1. Current-state inventory

All of section 1 is **OBSERVED** unless a line says otherwise.

### 1.1 Moon workspace and projects

[`.moon/workspace.yml`](../../.moon/workspace.yml) declares an explicit project
map (a `moon.yml` under an unlisted directory is invisible to the graph —
comment at lines 2–7) and `vcs.provider: other` with `defaultBranch: main`
(lines 26–30). Three projects (lines 22–25):

| Project         | Path          | Tag            | Tasks                                                                  |
| --------------- | ------------- | -------------- | ---------------------------------------------------------------------- |
| `release-craft` | `.`           | `type-package` | `format`, `format-check`, `lint`, `typecheck`, `test`, `build`, `arch` |
| `core-domain`   | `core/domain` | `type-domain`  | `lint`, `typecheck` — deliberately no `test`, no `build`               |
| `gate-scripts`  | `scripts`     | `type-gates`   | `lint`, `typecheck`, `test` (node:test, refuses a zero-match glob)     |

Task graph facts that matter later:

- `release-craft` carries `dependsOn: [core-domain]`
  ([moon.yml:27-28](../../moon.yml)) — the only declared edge, and the one
  that makes `project://core-domain?group=sources` inputs (and therefore
  affected detection for kernel changes) work. Without it, a kernel-only
  change resolved to zero targets for the gates that judge the kernel
  (measured, moon.yml:12–17).
- Workspace-wide tasks (`format`, `format-check`, the root `lint`, `arch`) run
  with `cache: false` because the boundary law forbids the package ↔ gates
  edge that would let Moon hash the gate scripts as inputs (moon.yml:42–65,
  103–128; scripts/moon.yml:11–15).
- `core-domain` exposes its sources through the `project://` URI form because
  both tilde forms were measured to hash as literal, nonexistent paths
  (core/domain/moon.yml:23–32).

### 1.2 Gates

Package scripts ([package.json:41-58](../../package.json)): the canonical
interface `format`, `format:check`, `lint`, `typecheck`, `test`,
`test:coverage`, `build`, `arch`, `check` — plus the policy entry points
`check:files`, `check:package`, `check:workflows`, `check:docs`,
`check:pr-description`, and the composite `check:policy`. `pnpm check` runs
format-check + every project's lint/typecheck/test + build + arch.

Executable policy gates under `scripts/` (each with a node:test suite beside
it):

| Gate                         | What it enforces                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check-required-files.mjs`   | ~40 required files (governance docs, the one ADR, the kernel files, toolchain configs, the three workflows, templates, canary sources) exist; `archkeep.json` does not (list at scripts/check-required-files.mjs:20–99).                                                                                              |
| `check-package-contract.mjs` | name `@ecoma-io/release-craft`, `private: true`, `type: module`, exact pnpm pin in `packageManager`, `engines` node `>=24` / pnpm `>=11`, all 9 canonical scripts present, `dependencies` absent/empty, archkeep pinned exact, no `latest`/wildcard devDependency ranges (scripts/check-package-contract.mjs:49–122). |
| `check-workflow-safety.mjs`  | every `uses:` pinned to a 40-char SHA, no `pull_request_target`, no `permissions: write-all`, top-level `permissions:` declared, `persist-credentials: false` on every checkout, no `${{ secrets.* }}` in `run:`, `concurrency:` declared (rules at scripts/check-workflow-safety.mjs:10–26).                         |
| `check-docs-links.mjs`       | relative links and `#fragment` anchors resolve; every `pnpm <script>` / `pnpm run <script>` literal in prose names a real script; every cited `node scripts/<file>.mjs` exists. `pnpm exec …` and `pnpm install` are exempt (scripts/check-docs-links.mjs:1–33).                                                      |
| `check-pr-description.mjs`   | a pull-request body must be non-empty, carry the three load-bearing template sections, and contain no leftover HTML comments, no placeholder marker (`to be finalized`), no unchecked task box — outside quoted material (scripts/check-pr-description.mjs:11–34). With `PR_BODY` unset (local runs) it exits 0.      |

Architecture gate: `archkeep check` (`release-craft:arch`, moon.yml:103–128)
judges [module-boundaries.config.mjs](../../module-boundaries.config.mjs) over
the Moon project graph. Three dependency rows (lines 34–63):

| Source tag     | May depend on                 | External imports     |
| -------------- | ----------------------------- | -------------------- |
| `type-package` | `type-package`, `type-domain` | —                    |
| `type-domain`  | `type-domain` only            | `["*"]` — all banned |
| `type-gates`   | `type-gates` only             | —                    |

with `moduleBoundaryOptions` written out at their defaults (lines 81–90,
including `checkNestedExternalImports: false`) and `boundarySuppressions: []`
(lines 92–99; the loader rejects an entry without a reason).

### 1.3 Public surface of the package

- One package: `@ecoma-io/release-craft` 0.1.0, `private: true`, ESM
  (package.json:1–40). No `dependencies`; 16 devDependencies, of which
  `@ecoma-io/archkeep` is pinned exact `0.24.1` (package.json:62).
- `exports` has exactly two entries (package.json:26–35): `"."` →
  `dist/src/index.(d.)ts|js` and `"./domain"` →
  `dist/core/domain/version.(d.)ts|js`.
- [src/index.ts](../../src/index.ts) is the front door: it re-exports
  `InvalidVersionError` and `Version` from the package alias
  `@ecoma-io/release-craft/domain` (lines 20–32) and exports the
  `PACKAGE_NAME` literal (lines 34–35). Its header bars every
  release-planning/lifecycle/adapter/publishing concern from this file
  (lines 8–9).
- `pnpm-workspace.yaml` exists for pnpm-11 policy only (`allowBuilds`,
  release-age exclusion for the archkeep pin) — not a `packages/` layout
  (pnpm-workspace.yaml:1–21).

### 1.4 The domain kernel

- [core/domain/version.ts](../../core/domain/version.ts), 382 lines: the
  `Version` value (private constructor, `Object.freeze(this)` before any
  subclass body runs, frozen identifier arrays — lines 119–260),
  `InvalidVersionError` (lines 90–103), the strict SemVer 2.0.0 grammar regex
  with one release-craft restriction — the safe-integer bound (lines 65–82) —
  and pure helpers. Static door: `Version.parse` (152–167). Relations:
  structural `equals` vs precedence `compare` (200–226). Bumps return
  core-only versions; overflow past `Number.MAX_SAFE_INTEGER` throws
  `RangeError` (228–246, 322–330).
- [core/domain/tsconfig.json](../../core/domain/tsconfig.json) extends the
  root baseline and compiles with `types: []` (lines 4–6) — no ambient Node
  globals inside the kernel.
- The lint layer for `core/domain/**` (eslint.config.mjs:113–156) bans the
  non-import surface: `no-console`, a `no-restricted-globals` list (`Date`,
  `process`, `Buffer`, `global`, `globalThis`, `performance`, `fetch`,
  `crypto`, the four scheduler globals, `require`) and
  `Math.random` via `no-restricted-properties`.
- Purposely absent from the kernel project: test files, a build task, any
  import at all (core/domain/moon.yml:6–17).

### 1.5 Alias seam — the three declarations

The specifier `@ecoma-io/release-craft/domain` is declared once per resolving
tool, all naming the same file (ADR-0001 decision 8):

1. tsc (and archkeep's resolution): `paths` in
   [tsconfig.json:21-23](../../tsconfig.json) → `./core/domain/version.ts`
2. Node (emitted dist): `exports["./domain"]` in package.json:31–34 → the
   built `version.js`; dist carries the alias verbatim because TypeScript
   never rewrites paths (tsconfig.build.json:2)
3. Vitest (executes sources): `resolve.alias` in
   [vitest.config.ts:28-34](../../vitest.config.ts) → the same `.ts` file

### 1.6 Tests

- `test/version.test.ts` — the kernel's contract suite, importing **only**
  through the package surface (`../src/index.ts`, line 2). Sections: grammar
  (40–76), canonical serialization (78–125), invalid input (127–175),
  numeric-semantic ordering with a lexical foil (177–287), the two relations
  (289–336), immutability (338–378), bumps (380–409). Vitest reports 74
  tests across the two root suites; the ADR records "75 tests"
  (ADR-0001:225–226) — already false (see 3.7).
- `test/index.test.ts` — the toolchain canary: the `PACKAGE_NAME` identity and
  a live re-export probe (lines 15–38). It used to export a `stage` literal; a
  claim in code that no gate could read, removed in #9 (lines 9–14).
- `scripts/*.test.mjs` — five node:test suites, one per policy gate, proving
  each rule fires on its drift (run by `gate-scripts:test`, which refuses a
  zero-match glob, scripts/moon.yml:43–61).
- Coverage: `@vitest/coverage-v8`, thresholds 80% on lines/functions/
  branches/statements (vitest.config.ts:47–52), over an explicit include list
  `SOURCES = ["src/**/*.ts", "core/domain/**/*.ts"]` (line 20) — files the
  glob matches land in the report even when no test imports them, which is
  what makes a threshold mean anything (comment at lines 10–18).

### 1.7 ADRs, workflows, rulesets, templates

- Exactly one ADR: [ADR-0001](../../docs/adr/0001-domain-kernel-and-semantic-version.md)
  (10 decisions, refused alternatives, honest limitations, consequences), plus
  the bootstrap record [docs/bootstrap/ecosystem-analysis.md](../../docs/bootstrap/ecosystem-analysis.md)
  (ADOPT/ADAPT/REJECT classification and a deferred-with-trigger table at
  lines 111–121).
- Three workflows: `ci.yml` (six canonical gates + allow-list `ci-gate`;
  `format` and `arch` unconditional, the rest `moon ci --base` on pull
  requests), `analysis.yml` (CodeQL javascript-typescript + actions,
  Semgrep report-only in a digest-pinned container, checksummed Gitleaks
  binary over full history + `analysis-gate`), `policy.yml` (the five gates +
  PR-description gate + PR-title commitlint). All actions SHA-pinned with
  version comments; `persist-credentials: false` everywhere; least-privilege
  permissions restated per job in analysis.yml.
- Rulesets on `main` are referenced by README.md:59–62 and CONTRIBUTING.md:
  pull requests only, required checks, up-to-date branches, linear history,
  resolved conversations, no force-push/deletion, squash-only merges. The
  rulesets themselves are GitHub-side settings — not in this tree, so the
  exact required-check list is not observable from here (see section 6).
- Templates: `bug_report.yml` (title prefix `bug: `, labels
  `bug`+`needs triage`, seven-area dropdown), `feature_request.yml`
  (`feat: `, `enhancement`+`needs triage`, the "How could this fail
  silently?" question), `config.yml` (blank issues disabled, security
  advisory link), `PULL_REQUEST_TEMPLATE.md` (title-is-squash-subject note,
  silent-failure and verified sections, local-checks checklist).
- Local hooks ([lefthook.yml](../../lefthook.yml)): pre-commit = prettier on
  staged files + eslint on staged files + the whole `pnpm check:policy`
  (tree-level); pre-push = `pnpm test` + `moon projects` graph sanity;
  commit-msg = commitlint. `arch` runs only in `pnpm check` and CI — no hook
  runs it before push.
- Commit grammar ([commitlint.config.mjs](../../commitlint.config.mjs)):
  `config-conventional` with `scope-enum` restricted to `core`, `scripts`,
  `workspace`, `docs`, `deps`, `ci` (lines 11–22); body line length unlimited.

## 2. Constraints Phase 1 and Phase 2 must preserve

Each item names its enforcing gate — none rests on prose alone.

1. **Domain purity, three layers, one authority** (ADR-0001:67–84): imports
   via archkeep `bannedExternalImports: ["*"]` on `type-domain`
   (module-boundaries.config.mjs:51–55); ambient globals via `types: []`
   (core/domain/tsconfig.json:4–6); non-import surface via the eslint block
   (eslint.config.mjs:113–156). Every file added under `core/domain/`
   inherits all three automatically — the globs are directory-scoped.
2. **The three-row boundary law, exhaustive by intent**: an unlisted tag is
   unconstrained, so a new tag must arrive together with the row that judges
   it (module-boundaries.config.mjs:17–21). Internal layering is expressed as
   more tags, never by loosening a row (lines 35–39). archkeep also judges
   declared `dependsOn` edges (moon.yml:21–24).
3. **ADR-0001 is the single source of truth and moves with its enforcement**:
   the ADR and module-boundaries.config.mjs change together until `decisionRef`
   bindings exist (ADR-0001:171–177). No root `archkeep.json` — forbidden by
   check-required-files and refused by archkeep beside `.moon/`.
4. **Alias seam declared 3×** (tsconfig `paths`, package `exports`, vitest
   `resolve.alias`, section 1.5): a second kernel entrypoint extends all
   three declarations in the same change — the friction is the point
   (ADR-0001:154–156).
5. **Tests are external consumers**: the kernel keeps no test files and no
   test/build tasks; contract suites live in the root package and import only
   `../src/index.ts` (ADR-0001:158–169; test/version.test.ts:2). A vitest
   import inside `core/domain/` would itself be a banned external import.
6. **One-package contract**: `private: true`, no runtime `dependencies`, exact
   archkeep pin, the 9 canonical scripts, no `latest`/wildcard ranges,
   frozen-lockfile installs (check-package-contract.mjs:49–122; AGENTS.md
   invariants 1–2). The first runtime dependency is a design decision that
   edits the gate in the same change (scripts/check-package-contract.mjs:10–11).
7. **Coverage floors 80% ×4** over the explicit `SOURCES` include list
   (vitest.config.ts:20, 47–52), with `passWithNoTests: false` (line 40) and
   the gate-scripts zero-match refusal (scripts/moon.yml:49–56) — empty
   suites are never green.
8. **Moon input declarations**: declaring `inputs:` replaces Moon's defaults,
   so each task names exactly what can move its verdict (moon.yml:1–9);
   cross-project inputs must be `project://id?group=` URIs backed by a
   boundary-legal `dependsOn` edge; workspace-wide tasks opt out of caching
   rather than lie about inputs (moon.yml:42–65, 103–128). The explicit
   project map is pinned by `check:files` and the pre-push `moon projects`
   step (.moon/workspace.yml:2–7).
9. **Docs gate**: any relative link, anchor, cited `pnpm <script>` or cited
   `node scripts/<file>.mjs` in any markdown file must resolve
   (check-docs-links.mjs:1–18) — including files added under `docs/design/`.
10. **PR-title scope vocabulary**: the title becomes the squash subject and is
    commitlinted in `policy.yml` (policy.yml:95–100) against the six-scope
    enum (commitlint.config.mjs:11–22). New scopes are an explicit edit.
11. **Protected `main`** (referenced OBSERVED at README.md:59–62,
    CONTRIBUTING.md:83–87): PR-only, required status checks — the six
    canonical names `format`/`lint`/`typecheck`/`test`/`build`/`arch` plus
    the aggregates `ci-gate`/`analysis-gate` are the names the workflows
    publish (ci.yml:7–11); the exact ruleset list is GitHub-side (section 6).
    Never worked around with admin rights (AGENTS.md invariant 7).
12. **Workflow security posture** (check-workflow-safety.mjs:10–26): SHA
    pins, declared permissions, no `pull_request_target`, no secrets
    interpolation, concurrency blocks — scanned on every workflow change.
13. **Status honesty**: no file claims shipped capabilities the tree does not
    have (AGENTS.md; the removed `stage` literal, test/index.test.ts:9–14;
    src/index.ts:11–17).
14. **Gate independence**: `type-gates` imports nothing it judges
    (module-boundaries.config.mjs:57–62); `src/` may not `console.*`
    (eslint.config.mjs:108–111); exported surface types are written down
    (`explicit-module-boundary-types`, eslint.config.mjs:61–66).

## 3. Friction analysis — ADR-0001 vs a many-primitive kernel plus planning

For each contested decision: what breaks, and whether it is a real
contradiction (ADR amendment required) or compatible growth (mechanical,
anticipated by the current text).

### 3.1 Decision 8 — the alias seam names one file

**OBSERVED**: the three declarations (section 1.5) all name
`core/domain/version.ts`; ADR-0001:145–156 says they "all [name] the same
file", that the contract "lives once, in core/domain/version.ts", and that
adding a second kernel entrypoint means extending all three — friction
intended.

**INFERENCE**: adding a _file_ costs nothing (new primitives as sibling files
under `core/domain/` inherit tsconfig/eslint/arch/Moon/coverage scoping
automatically). Adding an _entrypoint_ is where the seam bites, and there are
exactly two shapes:

- **Barrel**: `core/domain/index.ts` re-exports the primitives; the three
  declarations retarget to the barrel. The ADR's singular phrasing ("all
  naming the same file", "the contract itself lives once in
  core/domain/version.ts") becomes false the moment the entrypoint's
  identity changes — that is a (small) ADR amendment or a successor ADR,
  landing in the same PR as the retarget.
- **Subpaths**: keep `./domain` → one entrypoint per concern, or add
  `./domain/<primitive>` exports — each subpath repeats the 3× declaration
  pattern. The ADR's phrasing survives; no amendment strictly required.

**Verdict: compatible growth with a scheduled ADR touch.** The friction is
deliberate and the ADR predicts it; only the _barrel_ route amends decision
8's wording. **RECOMMENDATION**: decide barrel vs subpaths in the first PR
that adds a second primitive, and amend the ADR there.

### 3.2 Decision 9 — contract suite as external consumer

**OBSERVED**: the suite imports only the package surface
(test/version.test.ts:2); the kernel has no test task
(core/domain/moon.yml:6–11); the root test task's inputs include
`project://core-domain?group=sources`, so kernel edits re-run the suite
(moon.yml:78–87).

**INFERENCE, scaling**: mechanically the pattern scales unchanged — new
primitives add `test/<primitive>.test.ts` files, picked up by
`include: ["test/**/*.test.ts"]` (vitest.config.ts:37) and the eslint test
block (eslint.config.mjs:84–97). The "tested surface = shipped surface"
property holds for exactly as long as everything is re-exported through
`src/index.ts`; a primitive absent from the front door is untestable through
the contract path — and simultaneously uncovered, because it sits under the
`SOURCES` globs, so the coverage floor pushes it into the suite. The system
self-corrects, but only via the aggregate threshold.

Two frictions as the suite grows:

- `src/index.ts` becomes the single chokepoint every primitive must pass;
  its canary role (a file that must stay tiny and honest) competes with its
  barrel role. Not a contradiction — a watch item.
- The 80% floors are one aggregate over `src/` + `core/domain/`; kernel and
  package dilute each other. Per-layer floors would be a vitest config
  change, not an ADR matter.

**Verdict: compatible growth.** No ADR amendment required; the rationale ("a
vitest import inside core/domain would be a banned external import") is
count-independent.

### 3.3 The exports map

**OBSERVED**: exactly two entries, `"."` and `"./domain"` → one built file
(package.json:26–35). **OBSERVED**: check-package-contract.mjs validates
name/private/type/packageManager/engines/scripts/dependencies/devDependencies
— it does not read `exports` at all (scripts/check-package-contract.mjs:49–122).

**Verdict: compatible growth.** Retargeting `"./domain"` or adding subpaths
is not gate-blocked; it must merely travel with the 3× seam (3.1) and keep
README/docs claims honest. The build side needs nothing: tsconfig.build.json
already compiles all of `core/domain/**/*` into `dist/` (tsconfig.build.json:12).

### 3.4 archkeep's Moon provider project map if new projects appear

**OBSERVED**: the map is explicit — a project not listed in
`.moon/workspace.yml` is invisible to `moon projects` and therefore to every
gate (.moon/workspace.yml:2–7, 22–25). `check:files` and the pre-push
`moon projects` step pin the map. A new project needs: a map entry, a
`moon.yml` (id, tag, tasks with explicit inputs), a boundary row for its tag,
affected-detection edges, and — if it holds shipped sources — an entry in the
coverage `SOURCES` list.

**INFERENCE**: for the planning layer there are two placements:

1. **Grow inside `release-craft`** (`src/…`, tag `type-package`): no map, row,
   or project changes at all — the existing `type-package` row already
   allows `type-package → type-domain`, which is precisely the ADR's stated
   consequence ("release policy … consumes `Version` through the package
   surface and stays outside `core/domain/`", ADR-0001:227–229).
2. **New project** (e.g. `core/planning`, tag `type-planning`): the full
   checklist above, plus an ADR amendment — see 3.6.

**Verdict: compatible growth either way; route 1 defers every structural
cost.** **RECOMMENDATION**: route 1 until a distinct archkeep source tag
earns its keep; the ecosystem-analysis deferred table already registers
`packages/` decomposition behind exactly that trigger (line 120).

### 3.5 The vitest coverage include list

**OBSERVED**: `SOURCES = ["src/**/*.ts", "core/domain/**/*.ts"]`
(vitest.config.ts:20); the include list exists so that untested-but-matched
files drag the percentage down (lines 10–18).

**INFERENCE — this is the sharp edge.** A _new source root_ (anything outside
`src/` and `core/domain/`, e.g. a `core/planning/` project from 3.4 route 2)
matches neither glob: its files never enter the report, thresholds stay
green, and new code ships untested. That is the exact silent-failure class
the include-list comment was written to kill, reintroduced one level up. The
mitigation is one line — append the new root to `SOURCES` — but nothing
mechanically forces it today.

**Verdict: compatible growth with a known silent failure mode.** Not an ADR
matter. **RECOMMENDATION**: whenever a new source root lands, `SOURCES`
changes in the same PR; a candidate hardening (out of Phase 0 scope) is a
small check that every shipped-source root appears in the coverage include
list.

### 3.6 The boundary-law rows if a `type-planning` project is added

**OBSERVED**: rows are exhaustive on purpose; a new tag must bring its row
(module-boundaries.config.mjs:17–21); the `type-package` row's comment
already scripts the growth — "more tags here — never by loosening this row"
(lines 35–39); archkeep judges declared `dependsOn` edges too
(moon.yml:21–24), so wiring affected detection to a new project must itself
be boundary-legal.

**INFERENCE**: a fourth row for `type-planning` is mechanical — planning
consumes the kernel (`["type-planning", "type-domain"]`), never the package
or the gates; the open design question is whether planning keeps
`bannedExternalImports` purity or is allowed adapters (Git, filesystem,
network). That question is exactly the kernel/planning split of ADR-0001
decision 7 (prerelease transitions "land with the release-line work that
needs it, not here", ADR-0001:132–135).

But: **ADR-0001 decision 2 is titled "The boundary law is three rows"** and
states the table as three (ADR-0001:50–65), and AGENTS.md invariant 4 repeats
"three rows". A fourth row makes those _count-claims false_ while the _law_
they describe still holds.

**Verdict: the law grows compatibly; the prose counts do not. Adding a
`type-planning` tag requires an ADR amendment (or successor ADR) in the same
PR — not because the design changed, but because the ADR records the count.**

### 3.7 Cross-cutting: the stale-count class

**INFERENCE** from the above, with one **OBSERVED** instance already live:
the repository carries a family of _numeric inventory claims in prose and
singular defaults_ that go quietly stale as the kernel and planning layer
grow. `check:docs` verifies links and command names — not numbers. The
inventory:

| Claim                                                            | Where                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------ |
| "population is exactly one value"                                | ADR-0001:34–36                                               |
| "The boundary law is three rows"                                 | ADR-0001:50; module-boundaries.config.mjs:19; AGENTS.md      |
| alias declarations "all naming the same file"                    | ADR-0001:145–156                                             |
| "the kernel's contract suite is test/version.test.ts" (singular) | ADR-0001:160                                                 |
| "75 tests" — already false: vitest reports 74                    | ADR-0001:225–226                                             |
| "Three projects"                                                 | .moon/workspace.yml:9                                        |
| kernel = "the `Version` value object, nothing else"              | README.md:20; AGENTS.md ("foundation plus one domain brick") |
| coverage include = two globs                                     | vitest.config.ts:20                                          |
| exports = two entries                                            | package.json:26–35                                           |
| "Only this edge exists" (one dependsOn)                          | moon.yml:19                                                  |

One row is already false (**OBSERVED**): the ADR's "75 tests" against
vitest's reported 74 across the two root suites — a discrepancy no gate can
see. **RECOMMENDATION**: correct the count in the next PR that touches the
ADR, and let every PR that changes one of these counts sweep the whole
table in the same change — the docs gate cannot be extended to catch
arithmetic, so the sweep is a review discipline; this table is the
checklist.

## 4. Existing extension seams

Deliberate hooks the current design left for growth, with locations:

1. module-boundaries.config.mjs:35–39 — internal layering arrives as _more
   tags_, never by loosening the package row.
2. module-boundaries.config.mjs:17–21 — a new tag must arrive together with
   its judging row (exhaustive-by-intent).
3. module-boundaries.config.mjs:46–50 — `checkNestedExternalImports` left at
   its default explicitly _while the kernel has zero external edges to nest_.
4. module-boundaries.config.mjs:92–99 — `boundarySuppressions: []`; the
   loader rejects any entry without a reason.
5. ADR-0001:126–135 (decision 7) — prerelease/channel transitions are
   release-line policy, deferred to the work that needs them.
6. ADR-0001:154–156 (decision 8) — the second-kernel-entrypoint procedure:
   extend all three declarations; friction intended.
7. ADR-0001:171–177 (decision 10) — `decisionRef` bindings deferred on
   purpose; until then ADR and boundary config move together.
8. ADR-0001:216–229 (consequences) — future primitives inherit the three
   purity layers, the three-row law, and the alias seam "without new
   configuration".
9. ADR-0001:210–214 (limitations) — new files under `core/domain/` inherit
   every layer automatically (glob-scoped); review owns _topic_.
10. .moon/workspace.yml:2–7 — the explicit map is the project registry;
    `check:files` + pre-push `moon projects` guard it.
11. moon.yml:12–28 — the `dependsOn: [core-domain]` edge is the
    affected-detection pattern every future consumer relationship replicates.
12. core/domain/moon.yml:23–32 — the `project://core-domain?group=sources`
    URI is the measured-good cross-project input form (tilde forms documented
    as broken).
13. vitest.config.ts:20 — `SOURCES`, the coverage perimeter, to be extended
    with each new source root.
14. package.json:26–35 — the exports map's subpath pattern (`"."`,
    `"./domain"`).
15. src/index.ts:8–9 — the front door explicitly reserves release-engine
    concerns to future changes; the re-export block (20–32) is the surface
    seam.
16. scripts/check-required-files.mjs:7–8 — "the list is data on purpose":
    adding a required file edits the list in the same change.
17. scripts/check-package-contract.mjs:10–11 — the first runtime dependency
    edits the gate that forbids it.
18. docs/bootstrap/ecosystem-analysis.md:111–121 — deferred capabilities,
    each with the trigger that ends its deferral (release-please pipeline,
    `action.yml`, house Semgrep rules, CODEOWNERS, `packages/` decomposition,
    merge queue, vendored assets).
19. commitlint.config.mjs:5–7 — the scope enum as routing data; new scopes
    are a deliberate edit.
20. version.ts:5–9 (header) — "a version's meaning inside a release process
    is policy that lives above this file, never inside it".

## 5. Risk register

What could silently break as the kernel grows. Severity is about _silence_ —
everything here passes all current gates.

| #   | Risk                                  | Mechanism                                                                                                                                                                                                                                                         | Ground                                                                          |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| R1  | New source root invisible to coverage | `SOURCES` lists `src/` and `core/domain/` only; a future `core/planning/` never enters the report; thresholds stay green over untested code                                                                                                                       | vitest.config.ts:10–20 (INFERENCE from OBSERVED globs)                          |
| R2  | Runtime resolution unverified         | Tests execute sources via the vitest alias; nothing in any gate imports `dist/`, so a wrong `exports` target passes build, test, and arch, failing only on a real consumer                                                                                        | vitest.config.ts:5–8; tsconfig.build.json:2 (OBSERVED; consequence INFERENCE)   |
| R3  | Triple-declaration drift              | `paths`, `exports`, and `resolve.alias` updated in different commits → one tool resolves the new entrypoint, another the old                                                                                                                                      | ADR-0001:145–156 (OBSERVED); failure mode INFERENCE                             |
| R4  | Unlisted Moon project                 | A `moon.yml` under a directory absent from the explicit map runs no tasks and is judged by no gate                                                                                                                                                                | .moon/workspace.yml:2–7 (OBSERVED)                                              |
| R5  | Tag without a row = unconstrained     | Nothing mechanical forces a `depConstraints` row to accompany a new tag; the requirement lives in a comment                                                                                                                                                       | module-boundaries.config.mjs:17–21 (OBSERVED comment; absence of gate OBSERVED) |
| R6  | Prose count-claims rot                | The 3.7 table's claims go stale silently; `check:docs` checks links/commands, not numbers — already demonstrated: the ADR says 75 tests, vitest reports 74                                                                                                        | section 3.7 (75-vs-74 instance OBSERVED)                                        |
| R7  | Boundary verdict delayed past commit  | No hook runs `arch` (pre-commit: format/lint/policy; pre-push: test/graph); a kernel import violation committed+pushed without `pnpm check` is first caught in CI. Also: archkeep reads git-tracked files, so a brand-new kernel file is unjudged until committed | lefthook.yml:16–48; ADR-0001:204–206 (OBSERVED)                                 |
| R8  | Aggregate coverage dilution           | One 80% union over `src/` + `core/domain/`: a large low-risk module can absorb kernel regressions (or vice versa); no per-layer floor exists                                                                                                                      | vitest.config.ts:41–53 (OBSERVED; effect INFERENCE)                             |
| R9  | Moon input-form regressions           | The tilde-forms-hash-as-nothing finding lives in comments; a new project copying the wrong input form silently re-creates the stale-cache bug                                                                                                                     | core/domain/moon.yml:23–32 (OBSERVED)                                           |
| R10 | Required-check name coupling          | Required checks are GitHub-side; workflow job names (`format`…`ci-gate`) must match the ruleset exactly — adding a canonical gate without a ruleset edit yields a check nobody requires                                                                           | ci.yml:7–11; section 1.7 (OBSERVED tree half; ruleset INFERENCE)                |
| R11 | Front-door chokepoint                 | Every primitive must be re-exported through `src/index.ts` to be contract-testable; the canary file's honesty competes with barrel growth                                                                                                                         | test/version.test.ts:2; src/index.ts:1–18 (OBSERVED; tension INFERENCE)         |
| R12 | Planning-layer purity ambiguity       | Nothing in the current rows governs _how impure_ non-kernel shipped code may be (only `no-console` for `src/`); adapter policy (Git/fs/network) for planning is undecided and lands with the first planning PR                                                    | eslint.config.mjs:108–111; module-boundaries rows (OBSERVED); gap INFERENCE     |

## 6. Unresolved questions

1. **The exact required-check list on the `main` ruleset.** The tree publishes
   the candidate names (`format`, `lint`, `typecheck`, `test`, `build`,
   `arch`, `ci-gate`, `analysis-gate`, plus the `policy` job) but the ruleset
   itself is a GitHub setting, not a file. Whether "8 required checks" means
   the six canonical + two gates (with `policy` informational) is not
   observable from here; `gh api` against the repo settings would settle it.
2. **Planning placement** — inside `release-craft` (route 1, zero structural
   cost) vs a `type-planning` project (route 2, full checklist + ADR
   amendment). Phase 2 design decision; tradeoffs in 3.4/3.6.
3. **Kernel entrypoint strategy** — barrel retarget (requires the decision-8
   amendment) vs per-primitive subpaths (requires none). Phase 1 decision at
   the second primitive.
4. **Whether per-layer coverage floors are wanted** once a second shipped
   source root exists (3.2/3.5), and whether the R1 hardening (a gate that
   every source root appears in `SOURCES`) should be built before Phase 2
   makes the blind spot reachable.
