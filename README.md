# release-craft

The release engine for the ecoma-io organization: release planning, versioning,
prerelease lines, lifecycle hooks, artifacts, and publishing — humans, AI agents
and code all operating the same release machinery.

**Status: foundation.** This repository currently ships its engineering
substrate only — toolchain, task graph, architecture governance, CI, analysis,
and executable policy. The release engine itself is not implemented yet; no
file in `src/` does release work, and none claims to. Domain work starts after
this foundation, tracked in
[#1](https://github.com/ecoma-io/release-craft/issues/1).

## What is in the tree today

| Layer         | Where                                                                | What guarantees it                                                   |
| ------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Package       | `src/`, `test/` — `@ecoma-io/release-craft`, a toolchain canary only | `test`, `build`                                                      |
| Task graph    | `.moon/`, `moon.yml`, `scripts/moon.yml`                             | every task declares its `inputs`; `pnpm check` composes all gates    |
| Boundary law  | `module-boundaries.config.mjs`                                       | `arch` (archkeep, pinned exact) — gates may never import the package |
| Gate scripts  | `scripts/check-*.mjs` + tests                                        | `policy` workflow, `pnpm check:*`                                    |
| Docs contract | `README`, `CONTRIBUTING`, `AGENTS`, `docs/`                          | `check:docs` — links, anchors and commands resolve                   |

## Quickstart

Requirements: Node 24 ([`.node-version`](.node-version)), pnpm 11 (via
Corepack, version pinned in [`package.json`](package.json)), git.

```sh
pnpm install --frozen-lockfile
pnpm check        # format · lint · typecheck · test · build · arch
pnpm check:policy # required files · package contract · workflow safety · docs
```

Every gate also runs on its own: `pnpm format`, `pnpm lint`, `pnpm typecheck`,
`pnpm test`, `pnpm build`, `pnpm arch` — all of them thin wrappers over the
Moon graph, which is the real definition. Tasks are cache-aware and
affected-aware: `pnpm exec moon ci --base <sha> ...:lint` runs exactly what a
change can have moved.

## Governance

Three workflows, three different questions — none is a god workflow:

- **CI** (`.github/workflows/ci.yml`) — is _the change_ correct:
  `format`, `lint`, `typecheck`, `test`, `build`, `arch`, aggregated by
  `ci-gate`.
- **Analysis** (`.github/workflows/analysis.yml`) — is _the repository_
  healthy: CodeQL (TypeScript + the workflow files themselves), Semgrep
  (report-only), Gitleaks over full history, aggregated by `analysis-gate`.
- **Policy** (`.github/workflows/policy.yml`) — does _governance_ hold: the
  four executable gates plus the PR title against the commitlint rules.

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
