---
id: 0001-domain-kernel-and-semantic-version
status: accepted
created: 2026-09-05
updated: 2026-09-05
---

# The domain kernel starts as a boundary and one value: the semantic Version

## Status

Accepted, 2026-09-05. This record is the single source of truth for the kernel
boundary, its enforcement, and the `Version` contract. Where any other file
(prose, comments, the ADR-adjacent tables in
[`docs/bootstrap/ecosystem-analysis.md`](../bootstrap/ecosystem-analysis.md))
disagrees with this one, this one wins.

## Context

The previous PR ([#5](https://github.com/ecoma-io/release-craft/pull/5)) merged
claiming a "domain kernel" while its diff was empty — the claim was never
tested against repository state, and the discrepancy was filed as
[#6](https://github.com/ecoma-io/release-craft/issues/6). This ADR is written
against what actually exists in the tree now: one value object, its contract
suite, and the executable boundaries around it.

Release-craft's domain needs version semantics everywhere — release lines,
prerelease channels, artifact naming, publish decisions all judge versions
against each other. That logic must not be free to accrete infrastructure
imports (Git, GitHub, the filesystem), or the day the release engine is built
on top of it, every unit test of release logic needs a network or a working
tree to run.

What exists today is deliberately small: **the kernel's boundary is
established and enforced; its population is exactly one value.** Nothing in
this ADR claims more than that.

## Decision

### 1. Project grain — the kernel is its own Moon project

`core/domain/` is the project `core-domain`, declared in the explicit map in
[`.moon/workspace.yml`](../../.moon/workspace.yml) beside `release-craft` and
`gate-scripts`. The grain is architectural, not organizational: a distinct
archkeep source tag is only possible for a distinct project, and the purity
row below only exists because the kernel is one. It carries two tasks
(`lint`, `typecheck`); it deliberately has no `test` or `build` task — see
decision 9.

### 2. The boundary law is three rows

[`module-boundaries.config.mjs`](../../module-boundaries.config.mjs) judges
three directions, and each row is load-bearing:

| Source tag     | May depend on                 | External imports     |
| -------------- | ----------------------------- | -------------------- |
| `type-package` | `type-package`, `type-domain` | —                    |
| `type-domain`  | `type-domain` only            | `["*"]` — all banned |
| `type-gates`   | `type-gates` only             | —                    |

The domain row does double duty: `onlyDependOnLibsWithTags: ["type-domain"]`
makes cross-project imports violations, and `bannedExternalImports: ["*"]`
makes every direct external import — Node built-ins included — a
`bannedExternalImportsViolation`. There is no row that lets the kernel reach
out, and none that lets gate code or package code reach in.

### 3. Purity is layered because no single checker sees the whole surface

One tool cannot see every way impurity enters:

- **archkeep owns imports.** Any `import`/`export … from` of a Node built-in,
  an npm package, or another project is a verdict failure.
- **The kernel's own tsconfig owns ambient globals.** `core/domain/tsconfig.json`
  compiles with `types: []`, so `process`, `Buffer`, `__dirname` and friends
  do not exist at type level — using one is a compile error, which no import
  analysis can produce.
- **Lint owns the non-import surface.** `Date`, timers, `Math.random`,
  `console` are globals and methods, not modules; the ESLint block for
  `core/domain/**` refuses them.

These are one authority in three layers — each named in the code next to the
surface it watches, none duplicating another's reach. They are not three
boundary systems, and no fourth checker may be added while one of these three
can carry the rule.

### 4. Grammar scope — the strict SemVer 2.0.0 shape, made stricter by one bound

`Version.parse` accepts the SemVer 2.0.0 grammar — three dot-separated numeric
components without leading zeroes, optional `-prerelease` of dot-separated
alphanumeric-hyphen identifiers, optional `+build` of the same shape —
intersected with exactly one restriction of release-craft's own, the
safe-integer bound of decision 5. The accepted language is therefore a strict
**subset** of SemVer 2.0.0: nothing looser than the grammar, and one bound
stricter — a grammar-valid string such as `9007199254740992.0.0` is rejected
here, by design. Also refused by decision, not by omission: `v` prefixes,
whitespace, loose or coercing modes, partial versions. This is a judgment for
a _release_ tool — the strings release-craft judges come from git tags and
package manifests and must already be canonical; coercion is a policy concern
and would hide data errors this domain should surface.

Build metadata may carry leading zeroes. The spec forbids them only in numeric
_prerelease_ identifiers; build identifiers are never compared, so the
restriction has no semantic ground to stand on.

### 5. Compared numerics are bounded to safe integers

Core components and numeric prerelease identifiers must fit
`Number.MAX_SAFE_INTEGER`. Beyond it, JavaScript's numbers stop promising the
decimal equality the grammar's ordering is defined in terms of, and a version
comparison that silently lies is worse than a version string that is
rejected. Build identifiers are unbounded — they are never compared. An
increment (`bump*`) that would leave the safe domain throws `RangeError`
rather than wrapping.

### 6. Two relations, kept distinct

- **`equals` is structural.** Build metadata is part of a version's identity:
  `1.0.0+a` does not equal `1.0.0+b`.
- **`compare` is SemVer 2.0.0 §11 precedence.** Build metadata is ignored
  there: the same pair compares as `0` in both directions.

Collapsing either into the other is the classic versioning bug (releases
deduplicated by string, or prerelease artifacts ordered lexically); the
contract suite asserts both facts, in both directions.

### 7. Bumps are releases; prerelease transitions are deferred

`bumpMajor`/`bumpMinor`/`bumpPatch` return core-only versions — prerelease and
build stripped — following the npm-semver convention: on a prerelease,
`bumpPatch` returns the release it points at (`1.2.3-rc.1` → `1.2.3`), while
`bumpMajor`/`bumpMinor` increment from the core. Producing the _next
prerelease_ (`1.2.4-rc.1`, incrementing a channel) is release-line policy, not
value semantics — it needs to know which channel it is on, and the kernel does
not know channels exist. That operation lands with the release-line work that
needs it, not here.

### 8. The alias seam — one specifier, three declarations

The kernel is imported through the package's self-reference:
`@ecoma-io/release-craft/domain`. Cross-project _relative_ imports are
refused outright by archkeep's `noRelativeOrAbsoluteImportsAcrossLibraries`
(it fires before the constraint table), and a workspace package would require
inventing a second package in a repo whose package contract is
"one package, no dependencies". So the specifier is declared three times, once
per tool that resolves it, all naming the same file:

| Tool                            | Declaration                                                     |
| ------------------------------- | --------------------------------------------------------------- |
| tsc (and archkeep's resolution) | `paths` in [`tsconfig.json`](../../tsconfig.json)               |
| Node (the emitted dist)         | `exports` in [`package.json`](../../package.json)               |
| Vitest (executes sources)       | `resolve.alias` in [`vitest.config.ts`](../../vitest.config.ts) |

The contract itself lives once, in
[`core/domain/version.ts`](../../core/domain/version.ts). Adding a second
kernel entrypoint means extending all three declarations — that friction is
the point.

### 9. Tests are external consumers; the kernel project has no test files

The kernel's contract suite is [`test/version.test.ts`](../../test/version.test.ts)
— inside the root package, importing the kernel only through the public
surface (`../src/index.ts`). Two reasons, one consequence:

- A vitest import _inside_ `core/domain/` would itself be a banned external
  import — the purity row and a colocated suite are mutually exclusive.
- The suite can only assert what the package actually exports, so the tested
  surface and the shipped surface cannot drift apart. The kernel therefore has
  no `test` or `build` task of its own; the root package's gates cover both,
  and `pnpm arch` runs once per workspace, which is where a verdict belongs.

### 10. `decisionRef` bindings are deferred

archkeep's ADR registry can bind a decision to code locations for drift
detection. This ADR is written in the registry dialect but carries no
`decisionRef` yet — the binding vocabulary should be adopted deliberately with
the rest of archkeep's governance features, not as a drive-by. Until then,
this ADR and `module-boundaries.config.mjs` must be changed together.

## Refused alternatives

- **A workspace package for `core/domain`.** Requires inventing a second
  package in a repo whose recorded contract is one package with no
  dependencies, and moves the kernel out of archkeep's project graph. The
  alias seam (decision 8) gives the same import hygiene without either cost.
- **An archkeep `allow` exemption for the kernel.** `moduleBoundaryOptions`
  exemptions are global, not per-project — they punch a hole in every row to
  ease one. The boundary must hold without exceptions; today it does.
- **A relative import plus `rewriteRelativeImportExtensions`.** Still a
  cross-project relative import — archkeep refuses it before the constraint
  table is ever read.
- **Importing a semver library.** Beyond the banned import, no library gives
  the contract above: strict SemVer grammar bounded per decision 5,
  structural equality distinct from precedence, and a frozen immutable value.
  The contract is ~330 lines and fully owned here.
- **Restating the contract in prose docs.** The contract lives in the kernel's
  header comments (pointing here), the type signatures, and the executable
  suite. This ADR records decisions, not a parallel specification.

## Limitations, stated honestly

- **archkeep sees imports only.** `Date.now()` inside the kernel passes the
  arch verdict; that is exactly why decisions 3's other two layers exist. The
  layering is the mitigation, not an oversight.
- **archkeep reads git-tracked files.** A new kernel file is invisible to the
  verdict until committed — the first `pnpm arch` on a branch does not yet
  judge it. CI always judges committed state; local runs must commit first.
- **The lint layer covers the non-import surface only for `core/domain/**`.**
  Package and gate code keep their existing (weaker) rules; widening is a
  separate decision.
- **The purity of `core/domain` is a property of its current single file's
  discipline plus the gates.** A file added under `core/domain/` inherits all
  three layers automatically (glob-scoped), but nothing stops _unrelated_
  content from being placed there — the boundary governs imports, not topic.
  Review owns topic.

## Consequences

- Every future domain primitive lands in `core/domain/` and inherits the
  three-layer purity, the three-row law, and the alias seam without new
  configuration.
- The first import that would make the kernel impure fails `pnpm arch` at
  commit time and in CI — proven by canary (a `node:fs` import inserted into
  `version.ts` produced `bannedExternalImportsViolation`; the tree was
  re-verified clean afterwards).
- The kernel's contract can only be changed together with its suite: coverage
  thresholds enforced from this first commit. The test count is stated by the
  suite, never by prose — this record once carried "75 tests" where the suite
  runs 74, a drift no gate can see that the Phase 0 audit
  ([`phase0-repository-audit.md`](../design/phase0-repository-audit.md) §3.7)
  caught; counts live in the artifact that owns them.
- Release policy that needs version semantics (lines, channels, transitions)
  consumes `Version` through the package surface and stays outside
  `core/domain/`.
