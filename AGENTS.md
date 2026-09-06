# AGENTS.md — release-craft operational contract

Rules for any agent — human or AI — changing this repository. Read this file
before the first edit; it is imported by the repository's `CLAUDE.md` when one
exists. The org-wide cross-repo rules live in the user's global `CLAUDE.md`
and are not duplicated here.

## What this repository is

The release engine of ecoma-io. **It is in foundation phase, the kernel's
value population, the deterministic planner, and the execution kernel**:
`src/` holds a toolchain canary, the planner (`src/planner/`, the
deterministic planning door — ADR-0003, ADR-0004), and the execution kernel
(`src/execution/`, the pure attempt/claim/transition machinery — issue #27,
ADR-0005), and `core/domain/` holds the semantic `Version` value plus the
five release values the Phase 0 vocabulary locked — `Change`, `ChangeSet`,
`ReleaseLine`, `Channel`, `Artifact` — behind the barrel entrypoint
(ADR-0001, ADR-0002). The ledger, lifecycle hooks, artifact realization,
publishing, and provider behavior do not exist yet — no ledger, hook,
artifact, Git, or provider code may appear outside its own phase. Do
not implement release planning twice, release lines as behavior,
lifecycle hooks, artifact publishing, GitHub Releases, npm publishing, or
release-please compatibility in a drive-by change — that work lands through
its own issue and design, not inside unrelated fixes. Do not claim shipped
capabilities in docs or code comments; the README's status section is the
honest one.

## Commands

```sh
pnpm install --frozen-lockfile  # the only sanctioned install
pnpm check                      # format · lint · typecheck · test · build · arch
pnpm check:policy               # required files · package · workflows · docs
pnpm exec moon <targets>        # the graph is the real definition; scripts wrap it
pnpm test:coverage              # tests with the 80% thresholds enforced
```

Run `pnpm check` and `pnpm check:policy` before you claim done. The Moon graph
(`.moon/workspace.yml`, `moon.yml`, `scripts/moon.yml`) defines every task;
each task declares its `inputs` — if you add a file a task consumes, add it to
that task's inputs or affected-detection will lie. Cross-project files are
declared as `project://id?group=` URIs (the tilde forms hash as nothing —
measured); files Moon cannot name without a forbidden `dependsOn` edge — the
gate scripts, for every package-side task — are covered by `cache: false` and
unconditional CI jobs instead (see `moon.yml` and the `format`/`arch` jobs in
`ci.yml`).

## Invariants (each enforced by a gate, not by hope)

1. **No runtime dependencies.** `dependencies` stays absent;
   `check:package` fails if it appears. Dev tooling only.
2. **Frozen installs, no floating versions.** The lockfile is committed and
   installs use `--frozen-lockfile`. Caret/tilde ranges are allowed for
   ordinary dev tooling; `@ecoma-io/archkeep` is pinned **exact**; `latest`
   and bare wildcards are refused anywhere.
3. **Every GitHub Action is pinned to a full 40-character SHA** (version kept
   as a trailing comment), every checkout sets `persist-credentials: false`,
   every workflow declares least-privilege `permissions`, no
   `pull_request_target`, no `${{ secrets.* }}` inside `run:`, concurrency
   declared. `check:workflows` scans all of it on every change.
4. **The boundary law has three rows and the kernel imports nothing.**
   `module-boundaries.config.mjs` makes `type-gates` → `type-package` a
   violation, `type-domain` self-sufficient (`onlyDependOnLibsWithTags:
["type-domain"]`), and — the purity row — every external import from
   `core/domain/**` banned (`bannedExternalImports: ["*"]`: no Node built-in,
   no npm package, no cross-project module). `arch` (archkeep, exact pin)
   enforces all three in CI. Suppressions need a written reason; the current
   count is zero. Do not create `archkeep.json` at the workspace root — beside
   `.moon/` it is a hard error for the archkeep Moon provider, and
   `check:files` refuses it. The domain purity layering (archkeep for imports,
   `types: []` for ambient globals, lint for the non-import surface) is
   specified in [ADR-0001](docs/adr/0001-domain-kernel-and-semantic-version.md)
   — do not add a second boundary authority.
5. **Docs resolve.** Any relative link, anchor, or `pnpm <command>` cited in a
   markdown file must exist — `check:docs` walks all of it.
6. **Commits are Conventional** with scope ∈ {core, scripts, workspace, docs,
   deps, ci}; the squash commit's subject is the PR title, which the policy
   workflow commitlints.
7. **`main` is protected by repository rulesets**: PR-only, required checks,
   up-to-date branches, linear history, no force push or deletion. Never work
   around them with admin rights; if the ruleset blocks legitimate work, the
   change to the ruleset is its own reviewed PR.

## Workflow layering

Three workflows, three questions, no god workflow:

- `ci.yml` — the change: six canonical gates + `ci-gate` (allow-list guard:
  every `needs.*.result` must equal `success`; empty results fail).
- `analysis.yml` — the repository: CodeQL (javascript-typescript + actions),
  Semgrep (registry packs, report-only), Gitleaks (full history, checksummed
  binary) + `analysis-gate`.
- `policy.yml` — governance: the five `scripts/check-*.mjs` gates (required
  files · package · workflows · docs · PR description) + the PR title.

When you add a job, add it to its gate's `needs:` — the gates tighten only
through that list, visibly, in review.

## Filing defects found while working here

A defect observed here may belong to another repo (archkeep verdicts,
action-agents workflows, the Moon integration, loom components). File it in
the **owning** repository, after searching for duplicates, using that repo's
issue template exactly — YAML forms filed via API must be reproduced as
markdown sections. Security issues never go through issues: follow
[`SECURITY.md`](SECURITY.md).

## Conventions

- Public artifacts (commits, issues, PRs, docs) are English.
- Comments explain why, and a comment that states a rule the gates enforce
  says which gate.
- Tests live beside what they test (`test/*.test.ts`, `scripts/*.test.mjs`)
  and prove each gate fires on the drift it exists to catch. The one
  deliberate exception: the domain kernel's contract suite
  (`test/version.test.ts`) lives in the root package and consumes
  `core/domain` only through the public package surface (`../src/index.ts`) —
  the kernel project itself carries no test files and imports nothing, which
  is what keeps a test dependency out of the kernel (ADR-0001).
- Architecture decisions are recorded under `docs/adr/` in the registry
  dialect; the kernel's contract decisions live in
  [ADR-0001](docs/adr/0001-domain-kernel-and-semantic-version.md) and changes
  to any of them update the ADR in the same PR.
