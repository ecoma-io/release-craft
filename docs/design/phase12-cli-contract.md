# Phase 12 contract — the CLI, the first surface above the application boundary

Owner: [#112](https://github.com/ecoma-io/release-craft/issues/112). The
numbering is proposed — the phase after the application boundary — and the
maintainer confirms or renumbers it in review
([§8](#8-open-questions-for-the-maintainer), question 1). This document is the
CLI's design slice: it decides the surface, changes no behavior, and binds no
implementation — the CLI lands as its own reviewed PR against this contract.

The CLI lives above the application boundary, and that placement is the phase
11 contract's own non-goal, not this document's assertion: "The CLI and the
GitHub Action live above the boundary (invariant 2.10) — thin surfaces that
call it and compose nothing of their own; their slices do not open here"
([phase 11 §1](phase11-application-boundary-contract.md),
[§6](phase11-application-boundary-contract.md#6-out-of-scope-and-where-it-stays)).
The boundary's implementation is merged (PR #110; main carries it at
`9c3671d` as this contract is finalized), and this contract is written
against that reviewed surface: every door name, request field, and outcome
kind below was read from `src/app/types.ts` and is quoted, not
invented — each shape's subsection names what was verified by reading and
what is this contract's own decision. Where the boundary is still moving,
the contract says so instead of guessing. One moving part is named rather
than guessed around: main carries #113 for the moment (a declared extension
whose injection map is absent entirely is skipped where the kernel's law
names the throw), and its fix is in review (PR #116) — the
[declarations decision](#26-the-declarations-decision) never consults an
injection map, so it stands unaffected either way.

## 1. Scope and non-goals

In scope: the CLI's command grammar and its mapping onto the `Engine` doors;
the input rules (what argv, stdin, and the world document deserialize into,
and nothing more); the declarations decision — what a CLI process may execute
when `RunDeclarations` are caller-injected user code it does not have; the
mint target's derivation; the exit-code table and output shapes that render
the outcome union to a process; the hermeticity envelope; and the CLI's own
test obligations. The proposed home is `src/cli/` with a package `bin` entry
([§8](#8-open-questions-for-the-maintainer), question 5).

Non-goals:

- **No second composition** (invariant 2.10): the CLI parses and calls. No
  claim-view re-derivation, no walk re-ordering, no port re-ownership, no
  retry loop around a door, no capability gate the boundary never declared
  ([§2.7](#27-the-doors-that-need-a-carried-attempt-the-cross-process-posture)
  decides the one case that tempts it). A flag that maps onto no boundary
  value is a design violation, not a feature
  ([§2.2](#22-the-grammar-one-command-per-door)).
- **No user code.** `RunDeclarations.hookEffects` and `producers` are
  functions — the caller's effects, injected per run (ADR-0007 decision 2,
  ADR-0008 decision 2); a CLI process holds none, and the contract refuses
  the one move that would fake having them
  ([§2.6](#26-the-declarations-decision)).
- **No new read path.** The CLI does not observe the repository itself: the
  binding's read seams stay the binding's (phase 9 §2.7–§2.8), no port is
  widened here, and no git subprocess outside the binding's runner
  ([§2.4](#24-the-world-document-where-the-planning-input-comes-from)).
- **No provider semantics** (invariant 2.11): no GitHub vocabulary, no
  credential, no token, no remote in any flag, output, or module —
  publication is the adapter's and the publishing slice's territory
  ([ADR-0010](../adr/0010-github-adapter.md); phase 11 §6).
- **No new locking, no artifact mutation, no re-decided layer** — the phase
  11 §1 rows carry up one surface unchanged: the claim store is the
  concurrency control (invariant 2.7), generations are immutable (invariant
  2.9), and the kernel, ledger, register, and adapters are consumed, never
  re-owned.
- **Ecoma appears nowhere** (invariant 2.12;
  [product-boundary.md](product-boundary.md)): the CLI serves any software
  project; the maintainer's own product is one consumer of it.
- **The GitHub Action is not this slice** — its inputs are `action.yml`'s,
  not argv's ([§7](#7-the-other-slices)); it inherits this contract's
  decisions, not its flags.

## 2. Shapes

### 2.1 The layer

```text
src/cli/
  index.ts     // the bin entry: argv in, exit code out
  <parsing, rendering, and assembly-selection modules>
```

- Layering: the CLI imports the boundary through the package's front door —
  `src/index.ts`, which re-exports the app barrel wholesale (verified on
  `feat/app-boundary`: `export * from "./app/index.js"`) — and the git
  binding's own barrel (`openGitBinding` from
  `src/adapters/git/index.js`). Never an internal module. Nothing imports
  the CLI: it is the process's top, the one module whose only consumer is a
  shell.
- **No runtime dependency, so no argument-parser package.** The house rule
  keeps `dependencies` absent (AGENTS.md invariant 1, gated by
  `check:package`), and a CLI is runtime code. Argv parsing, JSON
  validation, and rendering are hand-rolled on node's built-ins. This is a
  decision, not an open question — the invariant closes the door the
  argument-parser temptation walks through.
- The one module the CLI owns beyond parsing and rendering is the declared
  tag naming ([§2.3](#23-the-git-assemblys-declared-naming)) — the
  data-only derivation the binding's config demands and a process cannot
  receive as a function.

### 2.2 The grammar — one command per door

One command per `Engine` door (all door names verified against
`feat/app-boundary:src/app/types.ts`):

```text
release-craft plan    --assembly memory|git [assembly flags] --world <path|-> [--intent <i>]…
release-craft run     --assembly … --world … --actor <string> --line <lineId>
                      [--intent <i>]… [--max-retries <n>]
release-craft resume  --assembly … --world … --actor <string>
                      --plan <planId> --attempt <attemptId> [--line <lineId>]
release-craft resolve --assembly … --actor <string>
                      --plan <planId> --attempt <attemptId> --step <stepKey>
                      ( --resolution human --note <string>
                      | --resolution revalidation --plan-fingerprint <fp> )
release-craft abort   --assembly … --actor <string>
                      --plan <planId> --attempt <attemptId> --reason <string>
release-craft show    --assembly … ( attempt --plan <planId> --attempt <attemptId> | channels )
```

| Command   | Door (verified signature)                                                      | Notes                                                                        |
| --------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `plan`    | `plan(input: PlanningInput): PlanningOutcome`                                  | pure — no store is touched; double-run identical (phase 2 §2.14, inherited)  |
| `run`     | `run(request: RunRequest): RunOutcome`                                         | plan + execute, to the terminal or the stop (phase 11 §2.5's walk)           |
| `resume`  | `resume(handle: AttemptHandle, request: RunRequest): RunOutcome`               | classify first, never re-plan; the request's `input`/`intents` not consulted |
| `resolve` | `resolve(handle, stepKey: StepKey, resolution: BlockedResolution): RunOutcome` | the only door that re-arms a blocked attempt (phase 5 §2.7)                  |
| `abort`   | `abort(handle: AttemptHandle, actor: string, reason: string): RunOutcome`      | terminal is terminal (E-09)                                                  |
| `show`    | `observe(query: ObservationQuery): Observation`                                | read doors only; the `attempt` / `channels` positionals pick the query kind  |

Every flag maps onto exactly one boundary value, and this is the rule
invariant 2.10 becomes when it reaches the process:

| Flag                                           | Feeds                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `--assembly`                                   | the factory choice: `assembleMemoryStores` / `assembleGitBinding`                                                   |
| `--repo <path>`                                | `BindingConfig.repo`                                                                                                |
| `--tag-namespace <ns>` (repeatable)            | `BindingConfig.tagNaming` — the CLI's declared derivation ([§2.3](#23-the-git-assemblys-declared-naming))           |
| `--max-retries <n>`                            | `AssemblyConfig.maxRetries` (E-08's declared bound)                                                                 |
| `--world <path\|->`                            | the `PlanningInput` half of `RunRequest.input` ([§2.4](#24-the-world-document-where-the-planning-input-comes-from)) |
| `--intent <i>` (repeatable)                    | `RunRequest.intents` — the `OperatorIntent` union serialized ([§2.2](#22-the-grammar-one-command-per-door))         |
| `--actor <string>`                             | `RunRequest.actor` / the handle's `actor` (E-09's attribution)                                                      |
| `--line <lineId>`                              | `RunRequest.lineIds` — exactly one occurrence on `run` (M-02)                                                       |
| `--plan` / `--attempt`                         | `AttemptHandle.planId` / `AttemptHandle.attemptId`                                                                  |
| `--step <stepKey>`                             | `resolve`'s `stepKey`                                                                                               |
| `--resolution`, `--note`, `--plan-fingerprint` | `BlockedResolution` — `{ kind: "human", note }` or `{ kind: "revalidation", planFingerprint }` (verified union)     |
| `--reason <string>`                            | `abort`'s reason                                                                                                    |

- `--repo` and `--tag-namespace` are demanded on the git assembly and are
  usage faults on `--assembly memory`, whose stores construct from nothing
  (verified: `assembleMemoryStores` takes no repository) — a flag the
  selected assembly cannot consume is a lie in argv, refused before any
  door is reached.
- The intents serialize kind-first, one `--intent` per demand, repeatable:
  `release`, `release-anyway`, `prerelease:<stream>:<lineId>`,
  `release-as:<version>`, `promote:<lineId>` — the `OperatorIntent` union's
  five rows, verified verbatim. A value that parses to none of them is a
  usage fault (exit 64, [§3.2](#32-the-exit-code-table)), and so is an id
  carrying `:` — the serialization is kind-first and colon-delimited, and
  a colon-bearing stream or line id would make the split ambiguous; such
  an id is declared in the world document, never in an `--intent`.
- **Defaults are declared, never ambient.** No flag reads `process.env`, no
  flag defaults from the working directory, no flag falls back to git
  config for the actor. `--actor` is demanded on every mutating door
  because every record the run appends carries it (E-09's human
  precedence); an absent `--actor` is a usage fault, never an inferred
  identity. `--max-retries` defaults to `0` — the fail-closed posture: a
  denied `prerelease-sequence` surfaces as the explicit `conflict` (exit 14) E-08 itself names — the bound exhausted (0 of 0), never a silent
  retry — and the operator who wants the kernel's bounded re-acquisition
  raises the bound explicitly
  ([§8](#8-open-questions-for-the-maintainer), question 4). (`denied`,
  exit 11, is the rendering of non-sequence denials — a stable-version
  scope another attempt holds.)
- `--line` is demanded on `run` and accepted-but-not-demanded on `resume`:
  the carried attempt's entry is authoritative for the line it executes
  (the boundary's `AttemptEntry.planLine`), and a resume's grammar should
  not re-ask for a fact the engine holds.

### 2.3 The git assembly's declared naming

The git assembly consumes `openGitBinding({ repo, tagNaming })` (verified:
`BindingConfig { repo, tagNaming }`), and `tagNaming` is a `GitTagNaming` —
`{ namespaces, tagFor(scope) }`, a **function**. A CLI process cannot
receive a function from argv, and the same law that decides
[§2.6](#26-the-declarations-decision) decides this: the module path is
refused, and the CLI ships **one declared, in-repo derivation**.

- `--tag-namespace <ns>` is repeatable; each value is a declared namespace
  root. `tagFor(scope)` returns the scope's rendered tag — the plan's own
  spelling, per the decided rendering below — when a declared root claims
  it, and returns `null` when none does — at which point the binding's
  namespace door denies the acquisition exactly as ADR-0009 decision 5
  fixes (`ClaimDenied { refusal: "namespace" }`, holder absent, a returned
  outcome the walk stops on). The CLI adds no second derivation and never
  repairs a denial (phase 11 §2.3's rule, carried up one surface).
- **Decided, as amended by the implementation slice's review (#119): the
  rendering is the planner's own, over the same document's declared
  formats.** The mint door is fail-closed by equality — it admits a mint
  only when the naming's projection of a held claim's scope equals the
  plan's tag (`tagFor(record.scope) === input.tag`, verified:
  `tag-door.ts`'s held-claim walk) — and the plan's tag is rendered by the
  planner's `formatTag` over the same world document's declared
  `policy.tagFormats` for the scope's line (verified: `plan.ts`, the
  `{prerelease}` token the input requires). So the CLI's `tagFor` renders
  through the planner's own `formatTag` — exported by the planner barrel
  for exactly this consumer — over that document's declared formats; a
  line with no declared format renders bare, which is the planner's own
  undeclared default. A projection that guessed at the shape would strand
  the operator: with a bare projection where the world declares `v…`, the
  claim stands, the walk completes its records, and the mint refuses
  `unclaimed` — recorded evidence, nothing minted. That failure was
  reproduced live in review; the reuse (not re-derivation) of the
  renderer is what makes it structurally impossible rather than tested
  away. The declared roots are a FILTER over the rendered tag: claimed
  returns the rendered tag itself — the root is never prepended, a denial
  is never repaired by renaming — and unclaimed returns `null`. The empty
  namespace root is an accepted spelling and reads as every tag (the
  binding door's own clause; the git vertical fixture's naming uses
  exactly `namespaces: [""]`, which remains the proven model for the
  scope's own decomposition — the rendered version's base and the
  `-<stream>.<n>` suffix the claim scope carries).
- What is deliberately absent: no `--naming-module`, no per-invocation code
  path, no implicit namespace. The naming is declared configuration, the
  same posture the empty declaration takes in
  [§2.6](#26-the-declarations-decision).

### 2.4 The world document — where the planning input comes from

The planner's single argument is closed, serializable, and
provider-neutral, and "the planner performs zero git calls; observations
arrive precomputed and closed" (phase 2 §2.1–§2.2; verified: the
`PlanningInput` interface's own header). Someone must close it. The
boundary refuses to (the binding's read seams are the remote projection's,
phase 9 §2.7–§2.8), so the CLI's caller does — through one declared
document.

**Decided: the closed planning world arrives as one `--world <path>`
document** (`-` reads stdin), JSON, whose schema **is** `PlanningInput` —
verbatim fields, no CLI-owned dialect
([§8](#8-open-questions-for-the-maintainer), question 6): `policy`,
`repository.commits`, `repository.refs`, `history.tags`, `lines`, and the
optional `components`, `bootstrap`, `intents`, `channels`. The CLI checks
the document structurally — valid JSON, `PlanningInput`'s shape — and a
malformed document is a usage fault (64): the invocation never reached the
engine, so the engine's outcome vocabulary does not apply. Beyond the
shape, the CLI validates nothing: the planner's own door normalizes and
refuses as landed (phase 11 §4 question 4's posture — the boundary
re-validates nothing, and neither does the surface above it), and
`RunRequest.intents` is overlaid from `--intent` flags, which win over any
intents inside the document (verified: the boundary plans over
`{ ...input, intents }`).

The alternatives, weighed:

- **The CLI observes the world itself** — through the binding's read seams
  or through its own git invocations. Refused. The read seams cannot close
  the input: `RefRead` enumerates recorded claim refs and
  declared-namespace tags and `ContentRead` reads recorded trees — no
  feed-ref heads, no commit graph, no `HEAD`, never the working tree
  (verified: `binding-types.ts`'s `RefRead`/`ContentRead`). Closing
  `PlanningInput` from them needs a port widening, and a port widened for a
  consumer is its own reviewed change (phase 11 §1's posture), not a
  drive-by inside the CLI's slice. And a git subprocess outside the
  binding's runner would be a second read path beside the binding — the
  exact drift the boundary exists to kill. The world-reader (a read seam
  for the planner's observations) is its own slice
  ([§7](#7-the-other-slices)); until it lands, the world is declared, not
  discovered.
- **Per-field flags** (`--line-config`, `--policy-file`, …). Refused: a
  dozen flags re-serialize one document, each spelling a second schema and
  each a place for the flag's value to disagree with the document's. One
  document, one schema, zero translation.

**Stale worlds are the engine's problem, not the CLI's.** The CLI performs
no verification of its own — no diff of the declared world against the
repository, no second reader to consult. A world that disagrees with the
recorded state surfaces through the machinery that already exists: the
planner's fingerprint discipline (phase 2 §2.10–§2.11), the claim store's
CAS, the guards' `blocked` records (E-04), the walk's stop-and-record.
`bootstrap` absent stays what phase 2 made it — a `blocked` record at the
planning boundary (S-02), never a CLI prompt.

One declared lie does not classify: a feed-ref head the repository does
not hold survives every classification above and faults the mint (exit
70 — the tag door's unresolvable-target `GitFaultError`), after the
walk's records stand. That is the honest rendering of a world document
that lied — the fault band, not a stop the recorded evidence cannot name.

### 2.5 The mint target — derived once, from the same world

`RunRequest.targets` is "the recorded base per line id the tag door mints
onto — demanded by any run whose plan mints over an assembly that wired the
tag door, and refused by name when a minting line lacks one" (verified:
`RunRequest.targets`'s doc; the refusal is pinned by the boundary's own
git-assembly fixture — the detail names the rule: "no recorded target …
never ambient HEAD"). The target is a supplied value, never chosen by the
binding (phase 8 §2.3; ADR-0009 decision 4).

**Decided: `targets[lineId]` is the head of that line's `feedRef` as
observed in the same `--world` document the run plans over.** The plan
records no head commit of its own (verified: `RunRequest`'s doc says
exactly that), so the caller that holds the world supplies the base from
the world — the git vertical fixture's own posture, stated as a rule
(`matrix-git.ts`'s `lineHeads` are "the per-line head oids the mint door
targets … the target is supplied by the assembly, never chosen by the
binding"). One derivation, one source: **no `--target` flag exists**, and
its absence is a decided non-goal — a target that disagrees with the
planned range is a silent lie, and the operator who needs a different base
corrects the declared world, whose change moves the plan identity with it.

- The derivation is pure over declared input: the world document's
  `repository.refs` observation for the line's `feedRef` names its head —
  the same observation the planner's range derivation takes, the last
  occurrence of a ref name in document order, so the plan's range and the
  mint always evaluate one head and never two.
- A minting line whose feed ref is absent from the document yields no
  target — and through this surface the process renders the FAULT, not
  the pre-walk `refused`. As amended by the implementation slice's review
  (#119): the planner's own range derivation classifies first and refuses
  an unobserved feedRef (`InvalidPlanningInputError`, exit 70 — verified:
  `history.ts`'s `deriveRanges` throws before the engine's target check
  can fire), so the declared-lie posture of
  [§2.4](#24-the-world-document-where-the-planning-input-comes-from)
  governs. The engine's pre-walk `refused` (verified: the git-assembly
  fixture, which also pins `handle: null` and `drives: []` on that stop)
  remains the hand-built-request path — a caller that supplies `targets`
  itself — not a rendering this surface performs. The CLI adds no second
  validation in front of either.
- The memory assembly wires no tag door (verified:
  `assembleMemoryStores` wires `mint: null`), so a memory run demands no
  target and reports the plan's tag without a minted ref — the boundary's
  own distinction, rendered verbatim.

### 2.6 The declarations decision

The hard one, stated plainly. `RunDeclarations` are caller-injected per
run: declared hook and artifact steps **frozen with the attempt**, and
`hookEffects` / `producers` — functions the walk invokes at their anchors
(ADR-0007 decision 2, ADR-0008 decision 2; verified: the `RunDeclarations`
interface). "The engine never stores or invents user code" is the kernel's
own law, and the kernel enforces it with a named throw: a declared hook
whose effect the map lacks stops the walk with
`InvalidExecutionTransitionError` (verified: `src/execution/hooks.ts`).
A CLI process has no user code to inject. What, then, may a CLI `run`
declare?

**Option 1 — a declarations module path** (`--declarations ./release.craft.js`,
dynamically imported). **Refused.** In the letter it is doctrine-clean —
the code would be the caller's injection, not the engine's invention. In
the process it is anything but: the CLI becomes an arbitrary-code execution
surface whose closure may read the clock, the environment, and the network
— the hermeticity contract ([§4](#4-hermeticity-what-the-process-reads))
becomes unenforceable the moment the flag exists, because the undeclared
reads move inside code the CLI loaded but did not write. It drags a module
ABI — shape, versioning, trust — into the thinnest surface in the package,
and it invites the composition invariant 2.10 forbids through the side
door: a module that closes over ambient state is a second composition root
that no contract suite can see. If caller-declared effects ever ship to a
process surface, they ship as a declared, reviewed, in-repo effect library
behind its own design — never a per-invocation code path
([§8](#8-open-questions-for-the-maintainer), question 7).

**Option 2 — refuse executed runs** (plan-only, `show`, `resolve`, `abort`
only). **Refused.** The walk needs no user code when the declaration set is
empty — the stages, the claim, the ledger, the channel moves, and the mint
are all the assembly's wired ports. Refusing executed runs would withhold
an engine capability that never had the problem the refusal fears.

**Option 3 — a fixed, declared-in-repo declaration set that exercises the
binding's own effects** (e.g. declare an artifact step so the walk reaches
the wired producer). **Refused for v1.** A declaration the operator never
made is the CLI inventing release semantics — the same law as inventing
user code, one step removed. The binding's producer stays wired for hosts
that declare artifacts (the boundary's per-id fallback, verified:
`assembleGitBinding` wires it and the walk falls back to it only under the
run declarations' map); it is not a reason for the CLI to fabricate steps
that would reach it.

**Decided: the CLI v1 executes runs with the empty declaration.**
`declarations` is structurally absent — no `hooks`, no `artifacts`, no
`hookEffects`, no `producers`. The effects a run then performs are exactly
the operations whose effects are the binding's own: the ledger's records,
the claim store's CAS, the channel store's moves under the
`channel-transition` stage (ADR-0012 decision 6's wiring), the tag door's
mint. Nothing code-shaped ever enters the process, and ADR-0007 decision
2's law holds at the surface by construction rather than by review.

- **This is not a reduced mode.** The walk with no declared extension steps
  is the engine's own canonical walk (phase 11 §2.5's order with no-op
  anchors): claims still arbitrate, records still land, the tag still
  mints, and `published` still means what phase 11 §2.8 says it means.
- **The cost, stated honestly:** a CLI release today records and mints but
  performs no caller operation — no notify hook, no publish-shaped step, no
  artifact step. Nothing the v1 CLI withholds has a landed owner: remote
  publication is the adapter's and publishing slice's territory regardless
  ([ADR-0010](../adr/0010-github-adapter.md); ADR-0007 decision 12;
  ADR-0008 decision 12; phase 11 §6). When a slice lands that owns a
  publish-stage effect, it owns the question of how a process surface
  declares it — and this contract's refusal of the module path is the
  answer it starts from.

### 2.7 The doors that need a carried attempt — the cross-process posture

`AttemptHandle` is engine-minted and plan-keyed (verified:
`{ planId, attemptId, actor }`), and the engine's attempt store is
process-local bookkeeping (phase 11 §2.7) — a `resolve`/`abort` naming a
plan the engine does not carry is a returned refusal that quotes the
handle back (verified: `AttemptHandle`'s doc), and `resume` shares that
refusal wherever its durable reconstruction cannot answer. A CLI process
is one-shot: the engine that ran the walk dies with the process, and no
second invocation carries its attempt.

**Decided: the CLI maps every door anyway and gates nothing on
capability.** `resume`, `resolve`, `abort`, and `show attempt` construct
the handle from `--plan`/`--attempt`/`--actor`, call the door, and render
whatever comes back. The durable attempt lookup has landed for `resume`
(phase 11 §4 question 6's reconstruction — issue #194): a fresh process
resuming a dead holder's attempt re-assembles the plan from the
request's own closed input and completes across invocations — the
promised zero grammar change held (`--line` stays
accepted-but-not-demanded; a cross-process resume names it, since the
carried entry that was authoritative for the line is gone). The doors
without the reconstruction — `resolve`, `abort`, and `show attempt` —
keep the engine's own `refused(unknown attempt)` at exit 10 from a
fresh process until their own reviewed change
([§7](#7-the-other-slices)): honest, recorded, and scriptable.

- The refusal is not the CLI's invention, and the CLI must not preempt it:
  a client-side refusal ("resume is not supported from a CLI") would be the
  CLI knowing the boundary's internals — a capability gate, which §1
  refuses — and it would go stale the day the lookup lands. The engine's
  outcome is the truth; the CLI is its rendering.
- **`show channels` works cross-process today**: the channels observation
  reads the wired store's recorded states, not the carried entry (verified:
  `ObservationQuery { kind: "channels" }` and the `Observation` union). It
  is the one observation a second invocation can meaningfully make, and the
  `run` output carries the handle so a human or script can hold it for the
  doors that will one day accept it across processes.
- The store-less memory assembly renders the same discipline for channels:
  the observation returns `null` channels when no store is wired (verified:
  the `Observation` attempt row's `channels` field), and the CLI renders
  that null verbatim — never as an empty list that reads as "no channels
  recorded". The two query kinds differ in that corner: the `attempt`
  row's null is the no-store case, while a `channels` query over a
  store-less assembly renders the engine's own `refused` ("no channel
  store is wired") at exit 10, never a null.

## 3. The process surface — outputs and exit codes

### 3.1 Output shapes

- **`--json` is the machine contract: exactly one JSON document on stdout**
  — the door's returned value, serialized verbatim. `RunOutcome`,
  `PlanningOutcome`, and `Observation` are rendered as returned: the
  `kind`, the carrying fields (`detail`, `cause`, `holder`, `reason`,
  `tag`), and the context the boundary already attaches (`planId`,
  `handle`, `drives` — the per-step outcomes ride the run outcome verbatim,
  phase 11 §2.8). Nothing else on stdout, ever: no banner, no progress, no
  pretty-printing. One record per invocation.
- **The CLI never translates an outcome** — the boundary's own rule
  ("outcomes ride verbatim, never translated") carried one surface out: no
  kind renamed, no detail reworded, no field dropped, no outcome converted
  into another's shape. A caller diffing `--json` output against the
  `Engine` door's return value (the same assembly, the same world document)
  must find them equal — and the test obligations pin exactly that
  ([§6](#6-test-obligations), fixture 4).
- **Default (human) rendering**: the same information, as short text on
  stdout — the kind, the handle, the minted tag, the stopping step and its
  outcome, the detail/cause string verbatim. Diagnostics, when any, go to
  stderr. Both shapes carry the same facts; only the encoding differs.

### 3.2 The exit-code table

Three bands. The **proceed** band: the door did what the invocation asked.
The **stop** band: the walk or door stopped, the recorded evidence names
what to do, and every one is non-zero — a shell script that ignores exit
codes never mistakes a stop for success. The **fault** band: the invocation
or the contract broke before any classification.

| Code | Band    | Outcome / class        | The caller's next move (phase 11 §2.8's column, rendered)                                                                                                                                                                             |
| ---- | ------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | proceed | `published`            | proceed — the walk completed, the tag minted, the terminal recorded                                                                                                                                                                   |
| 1    | proceed | `satisfied-externally` | proceed — ledger-first done-ness (E-03); the evidence reads back through `show`                                                                                                                                                       |
| 2    | proceed | `resolved`             | proceed — the recorded resolution re-armed the attempt; `.resume` next                                                                                                                                                                |
| 3    | proceed | `abandoned`            | proceed — the abort was honored and terminal (E-09)                                                                                                                                                                                   |
| 10   | stop    | `refused`              | read the detail — it names the owner and the refused door                                                                                                                                                                             |
| 11   | stop    | `denied`               | another attempt owns the scope (E-07) — the winner is named                                                                                                                                                                           |
| 12   | stop    | `blocked`              | a guard failed on world state — resolve through `resolve`, then `resume`                                                                                                                                                              |
| 13   | stop    | `failed`               | a recorded failure stopped the walk — inspect the tail; a later resume re-judges                                                                                                                                                      |
| 14   | stop    | `conflict`             | same identity, different content or inconsistent evidence (E-02) — a human judges                                                                                                                                                     |
| 15   | stop    | `ambiguous`            | never success (invariant 2.6) — verify through a read, then resume                                                                                                                                                                    |
| 16   | stop    | `stale`                | the resume verdict surfaced verbatim — re-plan                                                                                                                                                                                        |
| 17   | stop    | `escalate`             | the resume verdict surfaced verbatim — a human judges the tail                                                                                                                                                                        |
| 64   | fault   | usage                  | unknown command/flag, missing `--actor`/`--world` (`--repo` demanded on the git assembly only), malformed `--intent`, a `--world` document that is not valid JSON or not `PlanningInput`-shaped — the invocation never reached a door |
| 70   | fault   | escaped throw          | the kernel's named contract violations, `InvalidAssemblyConfigError`, `GitFaultError` — name and message printed verbatim on stderr, never translated into an outcome                                                                 |

The doors whose unions differ from `RunOutcome` render through the same
table where the rows coincide: `plan`'s `PlanningOutcome` (verified
two-row union) maps `planned` → 0 and `refused` → 10; `show`'s
`Observation` maps the `attempt` and `channels` rows → 0 and its `refused`
row → 10.

### 3.3 The rules the table pins

- **`ambiguous` is its own non-zero code** (15) — invariant 2.6 at the
  process boundary: a caller scripting the CLI cannot read a store's
  undecided landing as success, and no band-collapse (`ambiguous` into
  `failed`, say) is acceptable at any layer, including this one.
- **`blocked` (12) is not `failed` (13).** A blocked attempt has a recorded
  cause and a resolve loop (phase 5 §2.7); a failed walk needs tail
  inspection and a re-judging resume. Collapsing them would send scripts to
  `resolve` over an inspectable fault and humans into tails over a
  resolvable block — the process surface would be lying about which human
  act the stop demands.
- **`denied` (11) is not `conflict` (14).** A denial names a live winner
  (E-07); a conflict names inconsistent evidence a human judges (E-02).
  The loser path is recorded either way; the next move differs.
- **`abandoned` (3) is proceed-band** because the door did what the
  operator asked — the abort was honored and the attempt stays terminal
  (E-09). The exit code answers "did the invocation do what it said", not
  "is the release shipped"; `--json`'s `kind` answers the second question.
- **Success-shaped kinds share no code.** `satisfied-externally` proceeds,
  but at 1, not 0: a script that wants to proceed over ledger-first
  done-ness opts in by accepting 1, and phase 11 §2.8's own distinction
  between the two proceed rows survives the rendering.
- **Faults are never classifications.** Exit 70 is not 10: a `refused`
  outcome names a refused door, an escaped throw names a broken contract
  (phase 4 §2.2's split, phase 11 §2.8's carried law). The CLI catches the
  throw, prints it verbatim, and stops — it does not convert the throw into
  the outcome vocabulary to keep its table tidy.
- **A faulted process puts nothing on stdout.** Both fault rows (64, 70)
  render their text on stderr only, and stdout stays empty: stdout carries
  outcomes, and a fault is the invocation that never produced one, so a
  caller can never read stdout as a partial verdict.
- The plan door's purity is visible at the process: `plan` touches no
  store, and a double `plan` renders byte-identical JSON and the same exit
  code (phase 2 §2.14's law, inherited twice — once by the boundary, once
  by the rendering).

## 4. Hermeticity — what the process reads

- **The CLI's own decisions read nothing ambient.** No `process.env`
  lookup feeds any flag or default; no working-directory default stands in
  for `--repo`; no clock read renders any timestamp (recorded values only —
  E-05/E-10); no randomness; no network — the word remote appears in no
  flag, output, or module (invariant 2.11). The ambient world enters only
  as declared configuration: argv, the `--world` document, the binding's
  configuration.
- **The one environment the process touches is the binding's hermetic
  floor.** The git runner spawns on `process.env` minus the leaked
  repository context (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_NAMESPACE`,
  `GIT_TRACE*`, …), plus
  `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_TERMINAL_PROMPT=0`, and a baked deterministic commit identity —
  verified: `hermeticGitEnv()` in `src/adapters/git/git-run.ts`. The CLI
  opens the binding and inherits the floor; it adds no env plumbing of its
  own and exposes no flag that could inject one. Nothing the CLI does can
  make git consult an operator's gitconfig or prompt for a credential.
- **stdin is declared input, not an ambient read**: `--world -` reads the
  document from stdin, and that is the one stream the CLI reads beyond
  argv. Nothing else is read interactively — no prompt, no confirmation
  ([§8](#8-open-questions-for-the-maintainer), question 3 decides `resolve`'s
  shape on the same principle).
- **`abort` and `resolve` are the only destructive-adjacent doors, and both
  demand their human context by flag** — `--reason`, `--note` — because
  every record's attribution must be declared (E-09), and an undeclared
  reason is a usage fault, not a default string.

## 5. Laws

- **Parse and call.** The CLI deserializes argv, stdin, and the world
  document into boundary values and calls one door. Everything else —
  composition, ordering, validation beyond declared shapes, capability
  knowledge — is drift (invariant 2.10).
- **Outcomes ride verbatim, out as well as in.** The JSON rendering is the
  door's value; the exit table is keyed on the value's `kind`; no layer
  between the door and the shell rewords the engine.
- **Fail closed on ambiguity, loudly, at every layer** (invariant 2.6):
  exit 15 exists so the last layer — the shell — can fail closed too.
- **No user code, no invented code.** The empty declaration
  ([§2.6](#26-the-declarations-decision)) and the declared naming
  ([§2.3](#23-the-git-assemblys-declared-naming)) are the same law twice:
  the process executes only code reviewed in this repository, and only
  declarations the engine's contract provides for.
- **The claims are the concurrency control** (invariant 2.7): two CLI
  processes over one repository are two callers of one engine law — the
  claim store's CAS is the only arbitration, met across processes today
  only by a fresh run's fresh ordinal meeting a recorded claim (phase 11
  §2.7's residuals), and the CLI adds no mutex, no queue, no advisory
  locking of its own. The arbitration the claim store provides extends
  exactly one shared ref space: it is enforced by compare-and-set over
  the repository's own `refs/release-craft/*`, so the "one repository"
  in this law is one checkout's ref space, and two processes in two
  different checkouts of the same repository each hold their own (#182)
  — both acquire the same line, both mint locally, and the divergence
  first surfaces at the consumer's push as a non-fast-forward rejection,
  a git refusal outside the engine's verdict vocabulary. Serializing
  across checkouts is a declared precondition of the caller (phase 13
  §2.9 names the Action's posture), not a mechanism this surface
  provides.
- **No retry policy of its own.** E-08's bounded sequence retry is the
  kernel's clause driven by the boundary (phase 11 §2.5 step 3); the CLI
  neither retries a door nor loops a command. A script that wants retries
  writes its own loop, visible at the layer that owns it.
- **No writes outside the walk.** No claim-store bypass, no ledger append,
  no mint, no channel move except through the doors — phase 11 §2.9's
  inventory is the CLI's law verbatim, and reaching past it is not a
  shortcut (the layers' own refusals are what the CLI would surface, not
  spare anyone).
- **Ecoma appears nowhere** (invariant 2.12;
  [product-boundary.md](product-boundary.md)).

## 6. Test obligations

The CLI's suite is a **surface suite: it drives the built CLI as a
subprocess**, because the contract's subject is the process envelope — an
in-process import would test a different thing (the boundary's suite
already covers the doors; phase 11 §5).

1. **Two assemblies, one world.** The memory assembly (the zero-persistence
   bundle — `MemoryAttemptRegister`, `MemoryLedger`, `MemoryClaimStore`
   construct from nothing and ride `assembleMemoryStores`; verified:
   package-barrel exports, `freshStores`' zero-config posture) and a real
   temp-repo git binding (the binding's own `withTempRepo` harness). The
   same world documents drive both; the git side adds the target
   derivation ([§2.5](#25-the-mint-target-derived-once-from-the-same-world))
   and the minted-ref check through `show channels`' sibling read doors.
2. **The exit-code table, pinned kind by kind.** Every
   [§3.2](#32-the-exit-code-table) row produced through public doors and
   asserted by exit code **and** `--json` kind. `ambiguous` is pinned
   twice — as its exit code and as the value a proceeding caller would have
   had to misread (invariant 2.6); exit 70 pinned by declared contract
   violations (an `AssemblyConfig` that fails the assembly's structural
   check, and — as amended by the implementation slice — the two
   planner-classified lies: an unobserved ref head and an unobserved
   feedRef) asserted **not** to render as `refused`. The stop rows a
   one-shot, declarations-less process cannot produce —
   `satisfied-externally`, `resolved`, `abandoned`, `blocked`, `failed`,
   `stale`, `escalate` — are pinned as the table's typed rows and the
   renderers' renderings, not as subprocess runs: their subprocess
   unreachability is the boundary's own posture (the carried-attempt law
   of [§2.7](#27-the-doors-that-need-a-carried-attempt-the-cross-process-posture),
   the walk's recorded-stop doors), and it is declared here so a later
   slice that makes one reachable moves these pins as part of its own
   obligations rather than reading the suite as under-tested against a
   boundary that moved.
3. **Pass-through equality — the generalization posture made executable.**
   For each fixture: the CLI's `--json` stdout, parsed, equals the direct
   `Engine`-door outcome serialized — same assembly, same world document,
   same inputs. The equality proves the rendering is a pass-through — no
   translation, default, or gate stands between the door's value and
   stdout, and any one the CLI adds breaks the equality loudly. What it
   cannot judge, named honestly (Refs #128): both sides are built through
   the same derivation — `selectEngine`'s assembly selection and the
   declared naming of
   [§2.3](#23-the-git-assemblys-declared-naming) — so a drift inside that
   shared derivation moves both sides and the equality stays green.
   Judging the derivation itself needs an independently constructed direct
   side, which is the certification fixture's job
   ([§7](#7-the-other-slices)); the phase 14 contract supersedes this
   posture there.
4. **The grammar's negative inventory.** A flag that maps onto no boundary
   value fails the suite that names the flag inventory
   ([§2.2](#22-the-grammar-one-command-per-door)'s table, executable); the
   absent flags are asserted absent — no `--target`, no `--naming-module`,
   no `--declarations` ([§2.5](#25-the-mint-target-derived-once-from-the-same-world),
   [§2.6](#26-the-declarations-decision)).
5. **Hermeticity-negative** (phase 11 §5's isolation probe, one layer up):
   the CLI's modules name no `process.env`, no clock, no randomness; the
   suite runs green with the world supplied only through `--world` and the
   repository only through `--repo`, including an invocation whose
   environment carries hostile ambient values (`GIT_DIR` pointing
   elsewhere, a `GIT_CONFIG_GLOBAL` with content) that must not leak past
   the binding's floor.
6. **Determinism at the process surface.** Double `plan` over the same
   declared inputs renders identical JSON and identical exit codes; a
   double `run` over unchanged state lands the recorded replay
   (done-ness through classification, not ambient inference — phase 2
   §2.14 and the ledger's replay discipline, at the rendering).
7. **The cross-process posture, pinned as pass-through, not as a verdict.**
   A run exits; a new process resumes the printed handle; the fixture
   asserts the rendered outcome equals what a fresh engine returns for that
   handle. The durable attempt lookup has landed (issue #194): the value
   moved — a fresh process's resume of a dead holder's attempt now
   publishes, re-minting the recorded tag — and the equality held with the
   fixture unmoved
   ([§2.7](#27-the-doors-that-need-a-carried-attempt-the-cross-process-posture)).
   The carried-attempt doors without the reconstruction keep the
   `refused(unknown attempt)` value at exit 10; when their reconstruction
   lands, the equality holds with a different value again and the fixture
   does not move — the slice that lands it updates the affected values as
   part of its own obligations.

## 7. The other slices

- **The certification fixture (task #10)** will consume this contract —
  the exit-code table, the output shapes, and the pass-through equality —
  as pinned fixtures across assemblies and interruption windows. This
  contract names it and designs none of it; its design slice owns its
  scenario selection and its fixture data.
- **The GitHub Action (task #9)** inherits the door mapping, the
  declarations decision, the outcome rendering rules, and the hermeticity
  envelope from this contract; its inputs are action metadata, its secrets
  are its own problem, and its slice does not reopen what is decided here.
  This contract proposes the CLI first — the thinner consumer, whose
  decisions the Action reuses — and leaves the ordering to the maintainer
  ([§8](#8-open-questions-for-the-maintainer), question 2).
- **The world-reader slice** — the read seam the planner's observations
  deserve ([§2.4](#24-the-world-document-where-the-planning-input-comes-from)).
  When it lands, `--world` gains a legitimate alternative source; the
  change is revisited in that slice's own PR, never amended silently here.
- **The durable attempt lookup** (phase 11 §4 question 6) turns
  [§2.7](#27-the-doors-that-need-a-carried-attempt-the-cross-process-posture)'s
  carried-attempt doors from refused to working. The grammar does not
  move; the fixture's expected value does (its own slice's obligations).

## 8. Open questions for the maintainer

The contract decides the shape and the discipline; these are deliberately
left open, each with its proposed default:

1. **The phase number.** "Phase 12" is proposed — the phase after the
   application boundary — and this document's name follows it; renumbering
   is a rename, not a redesign.
2. **Ordering against the Action.** CLI first is proposed (question 2 in
   [§7](#7-the-other-slices)); if the maintainer wants the Action's slice
   first, this contract's decisions transfer unchanged — only the first
   implementing slice moves.
3. **`resolve` by flag or interactively.** Flag-only is proposed —
   `--resolution human --note …` / `--resolution revalidation
--plan-fingerprint …` (verified two-row `BlockedResolution` union) —
   because a prompt is a second interactive surface the hermeticity
   contract would have to carry, and a flagged resolution is scriptable
   and testable the same way every other door call is. An interactive
   wrapper can live above the CLI without this contract's change.
4. **The default `--max-retries`.** Proposed: `0` — fail closed; a denied
   `prerelease-sequence` renders the explicit `conflict` (exit 14) E-08
   itself names — the bound exhausted, never a silent retry — and the
   operator who wants the kernel's bounded re-acquisition raises the bound
   explicitly. (`denied`, exit 11, is the rendering of non-sequence
   denials.) The boundary test harness's `2` is a fixture convenience, not
   a policy.
5. **Home and bin name.** `src/cli/` and bin `release-craft` are proposed;
   the shape does not move with the name.
6. **The world document's schema ownership.** Verbatim `PlanningInput` is
   proposed — one schema, zero translation, and the planner's own
   normalization owns the semantics. A CLI-owned dialect would re-serialize
   the same fields and drift.
7. **Whether the declarations refusal is forever.** Proposed: a
   per-invocation code path never ships; if process surfaces ever declare
   effects, they do it through a declared, reviewed, in-repo effect
   library behind its own design slice — the engine never stores or
   invents user code, and neither does its CLI.
8. **The exit-code band layout.** The proposed bands are proceed 0–3, stop
   10–17, fault 64/70; renumbering is a table edit and a suite update, not
   a redesign — but the numbering ships once and scripts hang on it, so
   the maintainer's eyes belong on it before the first release.
