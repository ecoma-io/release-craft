## Description

Plan-recorded change words bind the `changelog-render` mutation (issue #291), plus the baseline docs fix (issue #305).

`PlanLine.changes` now carries the renderer's words — `subject`, `scope`, `breaking` (`src/planner/types.ts`, `src/planner/assemble.ts`). `changelogOf(lines, options)` projects the recorded plan's change set into `ChangelogInput` — one version per line, the stable target first else the first stream, a versionless line contributing nothing; the host-declared presentation (`date`, `sections`, `repository`, `existing`, `url` via `ChangelogOptions` on `RunDeclarations.changelog`) rides through untouched. `bindMutationsToPlan` gains a `changelogOptions?` parameter: a declared `changelog-render` mutation must produce exactly `plannedChangelog(line, options)` — faithful passes, contradiction or missing intent refuses before the walk opens. `version-mutation-driver.ts` derives the changelog from the plan (`changelogOf([planLine], changelogOptions)`, byte-identical with the old extract+re-derive over liveWorld). The app barrel exports `plannedChangelog` and `CHANGELOG_RENDER_MUTATION_ID` (surface test updated).

`docs/design/release-please-baseline.md`: `## Features` → `### Features` (#305); decision-log records D96.

Closes #291
Closes #305

## Type of change

- [x] Foundation / tooling
- [x] Documentation
- [ ] Governance (gates, workflows, rulesets)
- [ ] Product (release engine — currently nothing lives here)

## Could this fail silently?

No new gate; no affected-detection inputs change. The `changelog-render` bind refuses before the walk opens — every contradiction test pins a `refused` outcome naming the mutation, never a record (`test/app/mutation-plan.test.ts` "refuses the contradiction before the attempt opens").

## How was this verified?

- `pnpm test` — 119 files, 1954/1954 green (baseline 1945 + 9 new: 4 `changelogOf` rows in `test/planner/changelog.test.ts`, 5 changelog-render bind rows in `test/app/mutation-plan.test.ts`)
- `pnpm check` — 25 tasks pass (format/lint/typecheck/test/build/arch + 93% coverage over the 80% threshold)
- `pnpm check:policy` — all six gates pass

## Checklist

- [x] `pnpm check` and `pnpm check:policy` pass locally
- [x] No new runtime dependencies; no floating versions; lockfile unchanged or reviewed
- [x] Documentation updated where behaviour it describes changed
- [x] AI-assisted changes are disclosed in the commit trailer
