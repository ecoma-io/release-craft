# Adopting release-craft — install, first release, and the Action

release-craft is a general-purpose release engine for any software project.
It plans and executes releases over a **declared world**: one JSON document
that states your release policy, your repository's observed history, and your
release lines. Nothing is discovered from the environment — the document is
the whole input, and the CLI validates its shape, never its semantics
([phase 12 §2.4](design/phase12-cli-contract.md#24-the-world-document-where-the-planning-input-comes-from)).

The boundary, stated up front: the engine's planning and execution machinery
ships — the deterministic planner, the execution kernel, the append-only
ledger, the git binding, the assembled GitHub adapter, and the GitHub Action —
while this repository's own publishing pipelines and its npm package do not
exist yet. Adoption today means building the CLI from a clone of this
repository. The README's status section is the honest inventory; the product
boundary is recorded in
[`docs/design/product-boundary.md`](design/product-boundary.md).

## Install

Requirements: Node 24, pnpm 11, git — the same toolchain the repository pins
by value (`.node-version`, `packageManager`).

```sh
git clone https://github.com/ecoma-io/release-craft.git
cd release-craft
pnpm install --frozen-lockfile
pnpm build
node dist/src/cli/index.js --help
```

`--help` is answered in the command position, on stdout, exit 0 — six
commands (one per engine door) and the declared intent spellings:

```text
release-craft <command> [flags]

  plan    --assembly memory|git [assembly flags] --world <path|-> [--intent <i>]...
  run     --assembly ... --world ... --actor <string> --line <lineId>
          [--intent <i>]... [--max-retries <n>]
  resume  --assembly ... --world ... --actor <string>
          --plan <planId> --attempt <attemptId> [--line <lineId>]
  resolve --assembly ... --actor <string>
          --plan <planId> --attempt <attemptId> --step <stepKey>
          ( --resolution human --note <string>
          | --resolution revalidation --plan-fingerprint <fp> )
  abort   --assembly ... --actor <string>
          --plan <planId> --attempt <attemptId> --reason <string>
  show    --assembly ... ( attempt --plan <planId> --attempt <attemptId> | channels )

  assembly flags: --repo <path> --tag-namespace <ns> (git only, repeatable)
                  --max-retries <n> (default 0)

  intents (--intent, repeatable):
    release | release-anyway | prerelease:<stream>:<lineId> | release-as:<version> | promote:<lineId>

  help: release-craft --help | -h prints this text and exits 0
```

Help is deliberately no command's flag: `release-craft run --help` is the
usage fault — exit 64, empty stdout, and on stderr the fault naming the
closed inventory (`usage: unknown flag --help for command run — the inventory
is closed: …`) followed by the same synopsis
([phase 12 §2.2](design/phase12-cli-contract.md#22-the-grammar-one-command-per-door)).
Every exit the CLI can produce sits in three bands — 0–3 proceed, 10–17 stop,
64/70 fault
([phase 12 §3.2](design/phase12-cli-contract.md#32-the-exit-code-table)) — so
a script that checks the code never mistakes a stop for success.

## The world document

The planner takes one closed, serializable input, and the CLI's `--world`
value is that value verbatim in JSON — no CLI-owned dialect, no per-field
flags. The schema **is** `PlanningInput`
([phase 12 §2.4](design/phase12-cli-contract.md#24-the-world-document-where-the-planning-input-comes-from)):

| Field                 | What the world states                                                                                                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy`              | the release policy, declared: a `digest` label carried verbatim into every identity, the `bumpMappingId`, the `prereleaseLadder` and its `prereleaseSeed` (`"0"` or `"1"`), `pre10Dampening`, the reserved `selfReferenceNamespace`, and per-line `tagFormats` |
| `repository.commits`  | the commit universe — `sha`, `message`, `committedAt`, `parents`, `containingRefs`                                                                                                                                                                             |
| `repository.refs`     | the refs the world asserts — `name` and `head`, each head inside the commit universe                                                                                                                                                                           |
| `history.tags`        | the recorded releases — tag `name` and the `commit` it binds                                                                                                                                                                                                   |
| `lines`               | the release lines — `id`, `feedRef`, `lifecycle` (`active` \| `frozen` \| `retired`), `declared`; optional `versionBand`, `streams`, `withhold`, `publishes`                                                                                                   |
| `components` optional | the declared components — `name`, `manifestVersion`, `paths`; the single-component posture (exactly one component, no `publishes` binding) is the degenerate first-class configuration                                                                         |
| `bootstrap` optional  | the recorded first-version decision (S-02) — `version`, `who`, `when` as recorded constants, never a clock read                                                                                                                                                |
| `intents` optional    | operator intents inside the document; `--intent` flags win over document intents                                                                                                                                                                               |
| `channels` optional   | declared channel transitions — `id` and the `target` (`line`, `version`)                                                                                                                                                                                       |

The CLI's check is structural only — valid JSON, `PlanningInput`'s shape; a
malformed document is a usage fault (exit 64) before any engine sees it. A
semantically wrong document is not refused by the surface: it is the caller's
declared lie and is executed as declared — stale worlds surface through the
planner's fingerprint discipline, the claim store, and the guards, not through
a second validation the CLI does not perform
([phase 12 §2.4](design/phase12-cli-contract.md#24-the-world-document-where-the-planning-input-comes-from)).

A minimal first world, for a repository whose line rides `refs/heads/main`,
with one commit pending and no recorded releases:

```json
{
  "policy": {
    "digest": "my-project-release-policy-1",
    "bumpMappingId": "default",
    "prereleaseLadder": ["alpha", "beta", "rc"],
    "prereleaseSeed": "0",
    "pre10Dampening": true,
    "selfReferenceNamespace": "Release-Craft:",
    "tagFormats": {}
  },
  "repository": {
    "commits": [
      {
        "sha": "f02c13886b137f49b9c4fed387e562070ede3aee",
        "message": "feat: the first change",
        "committedAt": "2026-09-10T09:00:00Z",
        "parents": [],
        "containingRefs": ["refs/heads/main"]
      }
    ],
    "refs": [{ "name": "refs/heads/main", "head": "f02c13886b137f49b9c4fed387e562070ede3aee" }]
  },
  "history": { "tags": [] },
  "lines": [{ "id": "main", "feedRef": "refs/heads/main", "lifecycle": "active", "declared": true }]
}
```

**This page's documents and digests are machine-checked.** The suite
(`test/docs/adopters.test.ts`) extracts the world documents on this page and
drives each through the CLI's own world reader (`readWorldDocument`, the same
reader the Action's invoke step reaches through `--world`) and the planner's
memory assembly — the same doors the process surface drives. The quoted
refusal below is pinned to the engine's own `detail` string; every
`plan_sha256:` digest quoted in the transcripts is checked against the
engine's own computed plan identity over this page's world bytes; and the
run transcript's last row is checked against the engine's own renderer over
the same world. The transcripts themselves are illustrative — captured once
on the head this page was written at, not re-executed by the suite — so a
planner rewording, a stale digest, or a reshaped `PlanningInput` and a stale
page fail the same test run. Run it with `pnpm test`.

## The first release — and the refusal you should expect

Plan the world above over the memory assembly — the zero-persistence bundle,
enough to see what a release would do:

```sh
node dist/src/cli/index.js plan --assembly memory --world world.json
```

Executed on this head, the human rendering is:

```text
planned
plan plan_sha256:73eb12be3f1d6a964dbac8b4f77d78d74b549f1719507e1dbf4c549606c01376
policy my-project-release-policy-1
decision main blocked bootstrap-required
detail the evaluated range starts at line birth, pending changes present, and no recorded bootstrap decision — the first version is the operator's call (S-02)
```

This refusal is the **expected outcome of a first run**, not a failure. A line
whose evaluated range starts at its birth, with pending changes and no
recorded bootstrap decision, stops at the planning boundary
(`src/planner/decide.ts`, the `bootstrap-required` classification of S-02):
the planner never invents the first version. Exit 0 — the door did what the
invocation asked; the refusal rides the rendering. With `--json` the same
verdict is the envelope's `decisions[]`, verbatim:

```json
{
  "kind": "blocked",
  "cause": "bootstrap-required",
  "lineId": "main",
  "range": {
    "lineId": "main",
    "releasedUpTo": null,
    "head": "f02c13886b137f49b9c4fed387e562070ede3aee"
  },
  "policyDigest": "my-project-release-policy-1",
  "detail": "the evaluated range starts at line birth, pending changes present, and no recorded bootstrap decision — the first version is the operator's call (S-02)"
}
```

The blocked line contributes no plan line — `plan.lines` is empty; the
decision record is the line's whole presence in the pass
([phase 12 §3.1](design/phase12-cli-contract.md#31-output-shapes)).

The next move is the operator's, and it is a declaration, not a prompt:
record the first version in the world's `bootstrap` block, and declare the
released component (the single-component posture — exactly one component,
no `publishes` binding — needs nothing else). Merge these two top-level keys
into `world.json`:

```json
{
  "components": [{ "name": "my-project", "manifestVersion": "0.1.0", "paths": ["package.json"] }],
  "bootstrap": {
    "version": "0.1.0",
    "who": "Ada Opter <ada@example.com>",
    "when": "2026-09-10T09:00:00Z"
  }
}
```

`who` and `when` are recorded constants — the moment the decision was made,
written down by the person who made it; the engine reads no clock. Re-planning
now renders the release:

```text
planned
plan plan_sha256:39060e01955ae20f87f273277151e1a63c0ab9337cdc6129e8f70e795e9a7b00
policy my-project-release-policy-1
line main 0.1.0 (tag 0.1.0)
```

## Releasing over a real repository

The `git` assembly records the walk in the repository — claims, ledger, and
the minted tag are refs someone can read after the process is gone. The
command below walks `--repo .` — the repository you execute it in — so run
it in a **scratch clone of your repository**, and re-declare the world over
that clone's new head: a world declaring a head the walked repository does
not hold faults the mint (exit 70, `the mint target … does not resolve to a
commit`). With the world re-declared over the new head:

```sh
node dist/src/cli/index.js run --assembly git --repo . --tag-namespace "" \
  --world world.json --actor "Ada Opter <ada@example.com>" \
  --line main --intent release
```

Executed on this head over a scratch repository holding the one `feat:`
commit:

```text
published
plan plan_sha256:9f9710e51f8260498eb627a78953001949fa87638fcb230cbcebd40e2e26a9e7
attempt attempt_sha256:c0d7232a7ef2bad412034be1d65b8cf3efd6b9b25a707bba37b36dd984d505b7 (actor Ada Opter <ada@example.com>)
tag 0.1.0
stopped at verify (advance)
```

The tag `0.1.0` is minted locally (`git tag -l`), and the recorded state is
refs under `refs/release-craft/` — the claim, the ledger tail for the
attempt, and the plan register. `--tag-namespace ""` is the every-tag root,
the root the repository's own runs use.

Re-running the same release does not re-publish. The scope is owned; the
engine refuses and names the winner (exit 11, the `denied` stop band):

```text
denied
plan plan_sha256:9f9710e51f8260498eb627a78953001949fa87638fcb230cbcebd40e2e26a9e7
attempt attempt_sha256:ff83283b6b20b53e663cb4eaa4bd3beb8aaea3e2c97a61758b442bc6ef45ebc8 (actor Ada Opter <ada@example.com>)
holder attempt_sha256:c0d7232a7ef2bad412034be1d65b8cf3efd6b9b25a707bba37b36dd984d505b7
```

The next release comes from new reality, re-declared: close the world again
over the new head — the new commit in `repository.commits`, the ref head
moved, the released tag added to `history.tags` — and run once more. On the
same scratch repository, a second `feat:` commit planned and published
`0.2.0` — the `default` bump mapping read the change's type (`feat` → a
minor bump) and planned `0.2.0` over the recorded `0.1.0`.

## Wiring the GitHub Action

The Action lives at the root `action.yml` of this repository. A consumer
references it pinned to a **full 40-character commit SHA**:

```yaml
- uses: ecoma-io/release-craft@98c8ec226448debca27234f8582ba86ea28e342c # main at the time this page was written
```

Read the current head — `git rev-parse origin/main` — and pin that. The SHA
is the only supported reference, and the pin is the whole point
([phase 13 §2.1](design/phase13-github-action-contract.md#21-the-placement-and-the-pinning-story)):
the pinned commit carries the `action.yml`, the sources it builds, the
lockfile the build installs from, and the grammar table the inputs map onto —
one commit, one behavior. Moving major tags are documentation, never trust,
and this organisation enforces the same law on its own workflows
(`pnpm check:workflows` refuses any Action reference that is not a full SHA).
This repository re-pins its own consumer the same way — its self-dogfood
workflow was re-pinned to the then-current main head in one reviewed commit —
and its
[`dogfood.yml`](../.github/workflows/dogfood.yml) is the living example of
every spelling on this page.

The eight inputs
([phase 13 §2.3](design/phase13-github-action-contract.md#23-the-inputs-action-metadata-onto-the-closed-grammar)),
each mapping onto exactly one `run`-command flag:

| Input               | Required | Default                   | What it feeds                                                                                      |
| ------------------- | -------- | ------------------------- | -------------------------------------------------------------------------------------------------- |
| `world`             | yes      | —                         | `--world <path>` — a file path, never a stream                                                     |
| `line`              | yes      | —                         | `--line <lineId>` — exactly one line per step                                                      |
| `actor`             | yes      | —                         | `--actor` — the attribution recorded on every record; the Action never reads `github.actor` itself |
| `tag-namespaces`    | yes      | —                         | one `--tag-namespace` per line                                                                     |
| `intents`           | no       | empty                     | one `--intent` per non-empty line                                                                  |
| `repo`              | no       | `.`                       | `--repo` — the repository the binding walks                                                        |
| `max-retries`       | no       | `0`                       | `--max-retries` — the claim retry bound                                                            |
| `working-directory` | no       | `${{ github.workspace }}` | the invocation step's own cwd                                                                      |

`intents` and `tag-namespaces` are newline-separated, one value per line. The
every-tag namespace root is **one empty line** — an entirely empty value
forwards zero roots and usage-faults, so the root is spelled as a quoted
newline, exactly as the dogfood does: `tag-namespaces: "\n"`.

A minimal workflow step:

```yaml
- uses: ecoma-io/release-craft@98c8ec226448debca27234f8582ba86ea28e342c # pin the current main head
  with:
    world: world.json # a committed file — a path, never a stream
    line: main
    actor: release-bot # your declared word, recorded on every ledger record
    tag-namespaces: "\n"
    intents: release
```

The `world` input is a filesystem path
([phase 13 §2.5](design/phase13-github-action-contract.md#25-the-world-document-in-ci-a-path-never-a-stream)):
reviewed, diffable, versioned. The Action performs no checkout step — your
workflow's own `actions/checkout` stands (the run needs no token; the
dogfood's checkout declares `persist-credentials: false`), and the run's
writes are local: the mint is a local `git tag`, and zero remote writes are a
claimed, captured property of the self-dogfood's runs.

The step's one output, `outcome`, carries the run's `--json` envelope byte
for byte
([phase 13 §3.1](design/phase13-github-action-contract.md#31-outputs-one-envelope-verbatim)),
and the step concludes per the envelope's `kind`
([phase 13 §3.2](design/phase13-github-action-contract.md#32-the-conclusion-table)).

Misspelling an input is refused, not defaulted. The runner passes undeclared
`with:` keys through, so `intent:` (for `intents:`) would silently run on the
declared default; the invocation program reads the injected `INPUT_` key
names and refuses an unknown one before any engine runs. Executed on this
head with `INPUT_INTENT` planted:

```text
action-invoke: undeclared action input "intent" — the declared inputs are world, line, actor, tag-namespaces, intents, repo, max-retries, working-directory; the runner passes undeclared `with:` keys through, so a misspelled key would silently run on the default
```

Exit 1, empty stdout, the `outcome` output never written. A workflow-level
`env:` variable named `INPUT_<something>` reaches the same scan and is
refused by the same arm, by design
([phase 13 §2.3](design/phase13-github-action-contract.md#23-the-inputs-action-metadata-onto-the-closed-grammar)):
nothing outside `with:` may speak in an input's name.

## Vocabulary — the five primitives

Every term below is locked by its owning contract; the paragraphs carry the
contracts' semantics, none invented.

**ReleaseLine** — a durable, ordered stream of versions with a stable id, a
head derived from its own tags, and a lifecycle; the policy that governs what
it releases is planning-side data, not a field of the value. It is a kernel
value, locked in the vocabulary table
([release-model.md, "The locked vocabulary"](design/release-model.md#the-locked-vocabulary);
[ADR-0002 §4](adr/0002-release-model-and-domain-vocabulary.md#4-the-vocabulary)),
and it is not a branch: a line is fed by branches through recorded feed
mappings — in the world document, the line's `feedRef`.

**Attempt** — one execution of a plan, with its own identity. Attempt
identity is content-anchored (`attempt_sha256:<hex>` over `{ planId,
ordinal }`) and register-allocated; a retry is a new attempt over the same
plan — "one plan, two attempts" — and the state machine is exactly
`planned → executing → { published | satisfied-externally | failed |
superseded | abandoned }` with `executing ⇄ blocked(cause)` suspension
([release-model.md, "The chosen model"](design/release-model.md#the-chosen-model);
[ADR-0005, Decision 2–3](adr/0005-execution-kernel.md#decision)). The
`attempt attempt_sha256:…` row in the run rendering above is this value.

**Claim** — atomic ownership the attempt acquires before any mutation:
of the next version for releases, of `(line, target, stream)` positions for
prerelease sequences, or of the whole line where declared policy asks for it.
Scopes are a closed set of three, each atomic to one attempt; two claims on
one scope cannot coexist, and the store's atomic accept is the collision
adjudication — no wall-clock, no arrival-order assumption
([ADR-0005, Decision 4–5](adr/0005-execution-kernel.md#decision);
[ADR-0011](adr/0011-claim-line-register.md) for the per-line register the git
binding holds). The `denied` re-run above is a claim refusal naming its
holder.

**Ledger** — execution's durability: a write-ahead, append-only record of
steps keyed by `(attemptId, stepKey)`, each step idempotent and attributed.
A step's `started` record is durable before the step's effect may run, and
resume is classification over the recorded tail — never recomputation
([release-model.md, "The chosen model"](design/release-model.md#the-chosen-model);
[ADR-0006, Decision 1–3](adr/0006-execution-ledger.md#decision)). In the git
assembly the ledger is refs under `refs/release-craft/ledger/`, one per
attempt.

**DecisionRecord** — the planner's second, equally first-class output beside
`ReleasePlan`: a recorded no-op, refusal, block, or withholding carrying its
cause, its evaluated range, and the policy version that produced it — a
negative decision is still a decision, returned as a record, never thrown as
an exception or dropped
([release-model.md, "The chosen model"](design/release-model.md#the-chosen-model);
[ADR-0002, Decision 1](adr/0002-release-model-and-domain-vocabulary.md#1-the-model-model-c-model-c-amendments-a1a7)).
The bootstrap refusal above is one — a `blocked` record with cause
`bootstrap-required`.

**Generation** — the attempt's recorded artifact set: immutable, one per
attempt, complete when every declared artifact step has recorded its proof.
Generation identity is the attempt's identity — a deliberate rebuild under
one version identity is a new attempt and therefore a new generation,
recorded, never an overwrite
([ADR-0008, Decision 5](adr/0008-artifact-graph.md#decision);
[phase 7 §2.3](design/phase7-artifacts-contract.md#23-generation-records)).

## What does not exist yet

Stated plainly, so no page implies a capability:

- **No npm package.** The engine is consumed by building this repository
  and invoking the built file directly — `node dist/src/cli/index.js`, the
  path every transcript on this page uses. The `bin` entry (`release-craft`
  → that path) is declared in `package.json`, but the package is not
  installed anywhere, so the command name does not resolve.
- **No world-reader product slice.** The world is declared, not discovered:
  nobody observes your repository for you. The self-dogfood's
  `scripts/dogfood/close-world.mjs` is a working example of a caller-side
  observer — and it is caller-side tooling for that slice, explicitly not the
  product surface ([phase 12 §7](design/phase12-cli-contract.md#7-the-other-slices)).
- **One hosted consumer exists.** The Action's one certified hosted run is
  this repository's own self-dogfood dispatch; broader adoption is exactly
  what this page exists to enable, and no other deployment is claimed.
- **One line per Action step.** The Action drives the `run` door with exactly
  one `line`; a multi-line repository runs one step per line.
- **The plan door is a process, not a service.** Every invocation is one
  process over one declared world; nothing here watches a repository.
