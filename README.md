# release-craft

A general-purpose, open-source release engine for any software project —
release planning, versioning, prerelease lines, lifecycle hooks, artifacts,
and publishing — humans, AI agents and code all operating the same release
machinery. Built by ecoma-io; dogfooded by Ecoma, the fair-code labor OS —
a consumer, not the domain. The product boundary is recorded in
[`docs/design/product-boundary.md`](docs/design/product-boundary.md).

**Status: foundation, the kernel's release values, the deterministic planner, and the
execution kernel.** The engineering substrate ships — toolchain, task graph, architecture
governance, CI, analysis, executable policy — and the domain kernel carries its value
population: the semantic
[`Version`](docs/adr/0001-domain-kernel-and-semantic-version.md) plus the five release
values Phase 0's vocabulary locked — `Change`, `ChangeSet`, `ReleaseLine`, `Channel`,
`Artifact` ([ADR-0002](docs/adr/0002-release-model-and-domain-vocabulary.md)) — pure,
frozen, and archkeep-enforced behind one barrel entrypoint. The planner ships:
`src/planner/` is the deterministic, side-effect-free planning door
([ADR-0003](docs/adr/0003-deterministic-release-planner.md),
[ADR-0004](docs/adr/0004-line-policy.md)), pinned by the 53-scenario suite. The
execution kernel ships: `src/execution/` is the pure decision machinery of Phase 4 —
attempts, claims, transitions, step classification
([#27](https://github.com/ecoma-io/release-craft/issues/27),
[ADR-0005](docs/adr/0005-execution-kernel.md)) — frozen values in, classified outcomes
out. The engine's machinery ships through Phase 9: the append-only ledger
(Phase 5), lifecycle hooks (Phase 7), artifact realization (Phase 7), the
git binding (Phase 8), and the assembled GitHub adapter — remote
synchronization, release publication, reconciliation behind
`openGitHubAdapter` (Phase 9, [ADR-0010](docs/adr/0010-github-adapter.md)).
Not built yet: this repository's own adoption of the engine for its
releases. The GitHub action — the composite front door over the run door —
ships (phase 13), and a dispatch-only rehearsal of that adoption exists:
[`dogfood.yml`](.github/workflows/dogfood.yml)
([#187](https://github.com/ecoma-io/release-craft/issues/187)) runs one
self-release through the released Action and certifies it class-shaped per
[phase 14 §7](docs/design/phase14-certification-fixture-contract.md).
Phase 0's model — vocabulary,
invariants, complexity budget, built on the
[53-scenario matrix](docs/design/release-scenarios.md) and adversarially reviewed — is
in [`release-model.md`](docs/design/release-model.md); older work in
[#1](https://github.com/ecoma-io/release-craft/issues/1).

## Using release-craft

The consumer path — install, first release, Action wiring, and the engine's
vocabulary — lives in [`docs/adopters.md`](docs/adopters.md); every command
transcript and both world-document examples on that page are machine-checked
against the engine by the suite. The shape of adoption:

1. **Declare a world** — one JSON document stating your release policy, your
   repository's observed history, and your release lines. The CLI validates
   its shape and reads nothing else: declared, not discovered.
2. **Plan, and expect the first refusal** — a line with no recorded release
   stops as a `blocked` decision until you record the first version: the
   first version is the operator's call, never the planner's invention.
3. **Run the release** — the `git` assembly mints the tag and records the
   walk (claims, ledger) in your repository.
4. **Wire the Action** — `uses: ecoma-io/release-craft@<full-sha>`, pinned
   by SHA like every Action this organisation runs.

There is no npm package yet: the CLI is built from a clone of this
repository. The Quickstart below is the contributor path — building and
gating this codebase.

## What is in the tree today

| Layer            | Where                                                                                                                                                  | What guarantees it                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package          | `src/`, `test/` — `@ecoma-io/release-craft`, canary + the kernel re-export + the planner + the execution kernel + the git binding + the GitHub adapter | `test`, `build`                                                                                                                                                                                                        |
| Domain kernel    | `core/domain/` — `Version` + the five release values, one barrel entrypoint                                                                            | `arch` (zero external imports), domain `typecheck`, `test` via the package surface — [ADR-0001](docs/adr/0001-domain-kernel-and-semantic-version.md), [ADR-0002](docs/adr/0002-release-model-and-domain-vocabulary.md) |
| Release model    | `docs/design/` — scenario matrix, model evaluations, synthesis, ADR-0002                                                                               | [ADR-0002](docs/adr/0002-release-model-and-domain-vocabulary.md) — vocabulary and invariants are contract for Phases 1–2                                                                                               |
| GitHub adapter   | `src/adapters/github/` — the assembled remote layer (Phase 9): sync, publication, reconciliation behind `openGitHubAdapter`                            | `test/adapters/github/` — the contract §4 scenarios through the barrel + the white-box classifier pins — [ADR-0010](docs/adr/0010-github-adapter.md)                                                                   |
| Planning engine  | `src/planner/` — the deterministic planning door (Phases 2–3)                                                                                          | the 53-scenario suite + `test/planner/isolation.test.ts` — [ADR-0003](docs/adr/0003-deterministic-release-planner.md), [ADR-0004](docs/adr/0004-line-policy.md)                                                        |
| Execution kernel | `src/execution/` — the pure attempt/claim/transition machinery (Phase 4)                                                                               | `test/execution/` — fixtures E-01…E-09 + `test/execution/isolation.test.ts` — [ADR-0005](docs/adr/0005-execution-kernel.md)                                                                                            |
| Task graph       | `.moon/`, `moon.yml`, `scripts/moon.yml`                                                                                                               | every task declares its `inputs`; `pnpm check` composes all gates                                                                                                                                                      |
| Boundary law     | `module-boundaries.config.mjs`                                                                                                                         | `arch` (archkeep, pinned exact) — gates may never import the package; the kernel may import nothing                                                                                                                    |
| Gate scripts     | `scripts/check-*.mjs` + tests                                                                                                                          | `policy` workflow, `pnpm check:*`                                                                                                                                                                                      |
| GitHub action    | `action.yml` + `action/invoke.mjs` — the composite front door over the run door (phase 13)                                                             | `test/action/` — the artifact suite over the one script — plus `check:action`                                                                                                                                          |
| Docs contract    | `README`, `CONTRIBUTING`, `AGENTS`, `docs/`                                                                                                            | `check:docs` — links, anchors and commands resolve                                                                                                                                                                     |

## Quickstart

Requirements: Node 24 ([`.node-version`](.node-version)), pnpm 11 (via
Corepack, version pinned in [`package.json`](package.json)), git.

```sh
pnpm install --frozen-lockfile
pnpm check        # format · lint · typecheck · test · build · arch
pnpm check:policy # required files · package contract · workflow safety · docs · PR description
```

Every gate also runs on its own: `pnpm format`, `pnpm lint`, `pnpm typecheck`,
`pnpm test`, `pnpm build`, `pnpm arch` — all of them thin wrappers over the
Moon graph, which is the real definition. Tasks are cache-aware and
affected-aware: `pnpm exec moon ci --base <sha> ...:lint` runs exactly what a
change can have moved.

Running `pnpm exec vitest run` directly (bypassing Moon) requires the built
CLI — run `pnpm build` first. A `globalSetup` preflight enforces this: if
`dist/` is absent, vitest aborts before any suite with the exact fix named.
The Moon-ordered entry points (`pnpm test`, `pnpm check`) build automatically.

## Governance

Three workflows, three different questions — none is a god workflow:

- **CI** (`.github/workflows/ci.yml`) — is _the change_ correct:
  `format`, `lint`, `typecheck`, `test`, `build`, `arch`, aggregated by
  `ci-gate`.
- **Analysis** (`.github/workflows/analysis.yml`) — is _the repository_
  healthy: CodeQL (TypeScript + the workflow files themselves), Semgrep
  (report-only), Gitleaks over full history, aggregated by `analysis-gate`.
- **Policy** (`.github/workflows/policy.yml`) — does _governance_ hold: the
  six executable gates plus the PR title against the commitlint rules and a
  finalized PR description — the gate born from #6, which merged with a
  "(To be finalized)" body and an untouched checklist.

Three workflows sit outside this layering — none is a governance gate, and
none appears in any gate's `needs:`; all are held to the same
`check:workflows` posture as the three above. `triage.yml` (#101) labels
issues and pull requests from a model verdict. `review.yml` (#214) reviews
pull requests with the same sibling's `review` action, currently in its
documented dry-run posture: the run record is the whole output until the
flip. `dogfood.yml` (#187) is this repository's own release rehearsal —
one judged `workflow_dispatch` of the released Action over this
repository, capturing the four certification classes (phase 14 §7) and
judging in-job every class the captured material settles mechanically;
the rows no machine can settle print as NOT ASSERTED, never a waived
pass.

The three layers rest on GitHub rulesets on `main`: pull requests only, the
required checks above, linear history, up-to-date branches, resolved
conversations. The security posture of every workflow (SHA-pinned actions,
least-privilege tokens, no `pull_request_target`, secrets via `env`) is not a
promise in this README — it is enforced by `pnpm check:workflows` on every
change to `.github/workflows/`.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the branch → commit → pull
request → merge flow, and [`docs/bootstrap/ecosystem-analysis.md`](docs/bootstrap/ecosystem-analysis.md)
for what was adopted from the sibling repositories and why.

## Contributing and support

- Bugs and feature requests: the issue templates (`bug: ` / `feat: `).
- Security vulnerabilities: **never** in an issue — follow
  [`SECURITY.md`](SECURITY.md).
- Agents (human or AI): read [`AGENTS.md`](AGENTS.md) before changing anything.

## License

[Apache-2.0](LICENSE).

<!-- Branch ruleset verification: this comment exercises the pull-request path end to end. -->
