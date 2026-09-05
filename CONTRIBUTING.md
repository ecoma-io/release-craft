# Contributing to release-craft

The whole flow is: branch → commit → push → pull request → checks → review →
squash-merge. Every step after the first is enforced somewhere mechanical —
this document tells you where, so nothing is a surprise at the end.

## 1. Set up

```sh
git clone https://github.com/ecoma-io/release-craft.git
cd release-craft
pnpm install --frozen-lockfile   # hooks install themselves via `prepare`
pnpm check                        # the tree should already be green
```

Dependencies install frozen by policy: the lockfile is the contract, and a
command that would rewrite it (`pnpm update`, unpinned adds) belongs in its own
reviewed change. Dependency updates arrive through Renovate, never by hand —
see the dependency policy in [`AGENTS.md`](AGENTS.md).

## 2. Branch

Branch from `main`, name it after the work (`feat/…`, `fix/…`, `chore/…`).
`main` takes no direct pushes — the repository ruleset rejects them before the
hook would.

## 3. Commit

Conventional Commits, scopes limited to: `core`, `scripts`, `workspace`,
`docs`, `deps`, `ci` — for example `feat(core): …`, `chore(deps): …`. The
commit-msg hook runs commitlint on every commit.

Keep the tree green per commit:

- pre-commit (fast, staged files only): Prettier, ESLint, and the full policy
  gate (`pnpm check:policy`).
- pre-push (slower): the test suite and the Moon project graph sanity check.

If a hook rewrites your files, the result is already re-staged; review it with
`git diff` and re-run the commit.

## 4. Open the pull request

Use the template. Three things it asks for are load-bearing:

- **Could this fail silently?** — the question that catches checks wired to
  pass. If your change adds a gate, prove it bites (the bootstrap boundary was
  verified with a deliberate violation, then removed — see
  [`docs/bootstrap/ecosystem-analysis.md`](docs/bootstrap/ecosystem-analysis.md)).
- **How was this verified?** — the commands you ran, not the ones you assume
  CI runs.
- The title: it becomes the squash commit's subject, so it must pass
  commitlint — the `policy` workflow checks it, and the commit-msg hook never
  sees it.

The description itself is governed, not just requested: the `policy` workflow
refuses a body that still carries the template's comments or placeholder
markers, that leaves checklist boxes unticked, or whose load-bearing sections
were never written (#5 merged exactly that way — see the gate born from it,
`check:pr-description`). The gate judges the body as of the last push, the
same way the title check does; editing the description afterwards re-judges
on the next push.

## 5. Checks

Three workflows run, each answering one question (see
[`README.md`](README.md#governance)):

| Workflow | Question                   | Checks                                                                                 |
| -------- | -------------------------- | -------------------------------------------------------------------------------------- |
| CI       | Is this change correct?    | `format`, `lint`, `typecheck`, `test`, `build`, `arch` → `ci-gate`                     |
| Analysis | Is the repository healthy? | CodeQL (TS + workflows), Semgrep, Gitleaks → `analysis-gate`                           |
| Policy   | Does governance hold?      | required files · package contract · workflow safety · docs · PR description · PR title |

On a pull request, the CI gates run through Moon's affected detection: a
change that cannot have moved a gate leaves it empty by the graph's own
claim, not by skipping.

## 6. Review and merge

Every pull request is reviewed, including the maintainer's own — review is
where "could this fail silently" gets answered by someone other than the
author. The ruleset requires the branch to be up to date with `main`, every
conversation resolved, and linear history; merges are squash-only, so the
squashed subject is the PR title you already validated. A stale branch
re-bases onto `main` and lets the checks re-run — force-pushing over a
reviewed branch is not possible by design.

## 7. If a check fails

Fix forward on the same branch; a new commit re-runs everything. If a required
check fails for infrastructure reasons rather than content, re-run it once and
say so in the PR — a check that passes only on retry gets an issue, not a
re-run ritual.
