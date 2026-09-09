# Phase 14 contract — the certification fixture, the pinned standard across assemblies and interruption windows

Owner: [#125](https://github.com/ecoma-io/release-craft/issues/125). The
numbering is proposed — the phase after the GitHub Action — and the
maintainer confirms or renumbers it in review
([§11](#11-open-questions-for-the-maintainer), question 1). This document is
the fixture's design slice: it decides the scenario matrix, the expectation
format, the change protocol, the Action's scenario model, and the dogfood
standard; it ships no fixture code, adds no `test/` directory, and binds no
implementation — the fixture lands as its own reviewed PR against this
contract.

The fixture is the artifact two merged contracts already named and both
refused to design. The CLI contract's handoff: "the certification fixture
(task #10) will consume this contract — the exit-code table, the output
shapes, and the pass-through equality — as pinned fixtures across assemblies
and interruption windows. This contract names it and designs none of it; its
design slice owns its scenario selection and its fixture data"
([phase 12 §7](phase12-cli-contract.md#7-the-other-slices)). The Action
contract's consumption: "the certification fixture (task #10) consumes this
contract's pinned surfaces — the conclusion table and the byte-equality — as
fixtures across its own scenarios; its design slice owns scenario selection
and fixture data"
([phase 13 §7](phase13-github-action-contract.md#7-the-other-slices)).
Nothing below reopens a phase 11, 12, or 13 decision; where this contract
needs something those contracts refuse, it names the amendment and refuses
the side door.

The contract is written against the BUILT surfaces, not the prose alone:
main carries the application boundary (PR #110), the CLI (PR #119), the
durability amendments (PR #117's abandonment record,
[ADR-0013](../adr/0013-abandonment-record.md)), and the phase 13 contract
(PR #121) at `e49d19d` as this contract is finalized. Every door name,
outcome kind, exit code, refusal detail, and test-harness posture below was
read from `src/app/types.ts`, `src/app/engine.ts`, `src/cli/exit-codes.ts`,
`src/cli/render.ts`, `src/cli/selection.ts`, `src/execution/claim.ts`,
`src/execution/resume.ts`, and the existing fixture harnesses
(`test/vertical/`, `test/app/harness.ts`, `test/cli/harness.ts`) and is
quoted, not invented; each section names what was verified by reading and
what is this contract's own decision.

## 1. Scope and non-goals

In scope: the scenario matrix — walks, interruption windows, and assemblies,
enumerated with the reason each cell earns or is refused a pinned fixture
([§3](#3-the-scenario-matrix)); the expectation format, one decision per
expectation class, with the drift-detection story
([§4](#4-the-expectation-format)); the change protocol that moves the fixture
when a surfaced shape legitimately moves
([§5](#5-the-change-protocol)); the Action's scenario model — the data the
phase 13 contract's fixtures instantiate, owned here
([§6](#6-the-action-fixture-model)); the dogfood standard task #11 will meet
or fail visibly ([§7](#7-the-dogfood-standard)); the never-does inventory
([§8](#8-what-the-fixture-never-does)); and the implementation slice's test
obligations ([§9](#9-test-obligations)).

Non-goals:

- **No fixture implementation here.** Docs-only: no `src/` or `test/` change,
  no manifest file, no expected bytes. A later slice implements.
- **No second composition** (invariant 2.10), stated for test code with more
  force than for product code: a fixture that re-derives a claim view, a walk
  order, or a scope derivation certifies the fixture, not the product
  ([§8](#8-what-the-fixture-never-does)).
- **No new doors, ports, or vocabulary.** The fixture drives what the
  boundary, the CLI, and the Action already expose; a scenario the surfaces
  cannot produce is a gap to file, never a drive-by (the phase 10 §1 posture,
  one layer up).
- **Not a replacement for the per-phase suites.** The boundary's, CLI's,
  Action's, kernel's, planner's, and vertical matrix's suites stand; the
  fixture pins what they cannot see — stability of the surfaced standard
  across assemblies, interruption windows, and time. A pin that merely
  re-proves a lower suite's own fixture is refused
  ([§3.2](#32-the-earning-rules), rule R3).
- **No user-code surface.** The declarations law
  ([ADR-0007](../adr/0007-hooks-as-steps.md) decision 2,
  [ADR-0008](../adr/0008-artifact-graph.md) decision 2) holds one layer up:
  the fixture injects effects only through the boundary's declared per-run
  seam, and no process transport of the fixture declares anything
  ([§8](#8-what-the-fixture-never-does)).
- **No environment, clock, or randomness reads.** The fixtures' recorded
  values only — the vertical matrix's law ("no fixture reads a clock or the
  environment", `test/vertical/matrix.ts`'s header; "no clock, no
  environment, no randomness", `test/app/harness.ts`'s), inherited verbatim.
  The one random value in the system is met by a recorded projection, never a
  live read ([§4.3](#43-the-generation-mechanism)).
- **Ecoma appears nowhere** (invariant 2.12;
  [product-boundary.md](product-boundary.md)): the fixture certifies a
  general-purpose engine's surfaces; the maintainer's product is one future
  consumer.

## 2. The subject — what the fixture is, and the two values it holds

**Decided: the certification fixture is one pinned standard** — a recorded
set of scenarios (the matrix, [§3](#3-the-scenario-matrix)) and a recorded
set of expectations (the classes, [§4](#4-the-expectation-format)) whose
value is that a regression in any layer is visible as a fixture delta, and
that task #11's self-dogfood has a defined standard to meet instead of
improvising one. It has three consumers, each named by an upstream contract:
the Action implementation (whose fixtures instantiate this contract's
scenario data, [§6](#6-the-action-fixture-model)), the self-dogfood
([§7](#7-the-dogfood-standard)), and every future surface (a new surface
proves itself by satisfying the pinned classes, not by inventing a private
standard).

Two values, held together and stated separately because they are earned
separately:

- **Stability** — the surfaced shapes (exit codes, envelope bytes,
  conclusions, projections) are recorded data, diffed, never re-derived at
  test time. A diff means a shape moved; the diff is the review artifact.
- **Honesty** — the scenario matrix is enumerated against the recorded
  interruption taxonomy (the execution contracts' windows), with refusals
  justified, not absent. A window the contracts do not record is refused by
  rule; a recorded window with neither a pinned cell nor a written refusal is
  a fixture defect the suite catches
  ([§3.2](#32-the-earning-rules), rule R0).

### 2.1 The recorded world — reuse, not fork

**Decided: the fixture drives the vertical matrix's recorded world.** The
five lines, their seeds and policies, the five channels, the recorded
`COMMITTED_AT` and policy digest — the phase 10 fixtures' hand-written data
(`test/vertical/matrix.ts`) — are the fixture's world, imported as recorded
data, not re-declared. The walks below are that world's runs.

The alternatives, weighed:

- **A second, minimal world** (a one-line toy the fixture owns). Refused:
  two recorded truths for one engine — a drift between them is
  unattributable, and the five-line shape is precisely what makes
  cross-line independence (M-02), the prerelease ladder (P-06), and the
  maintenance cut (P-07) observable. The vertical's world is reviewed data
  with three suites already depending on it; a fork would be its fourth and
  least-reviewable copy.
- **A fresh world per cell.** Refused: no two cells would be comparable, and
  the fixture's cross-assembly promise — the same world driven through every
  assembly — dissolves.

One honest wrinkle, recorded rather than hidden: the shared data modules
import a planner internal (`test/vertical/matrix.ts` reaches
`plan` through `src/planner/assemble.js`), a phase 10 posture the
application boundary superseded. The import law of
[§8](#8-what-the-fixture-never-does) binds the fixture's own modules — which
import the package barrel and the adapter barrels only — and binds fixture
data only transitively; the vertical modules are recorded data shared across
suites (the established pattern: `test/cli/harness.ts` and
`test/app/harness.ts` both import them), not `src/`. Relocating the shared
recorded world to a barrel-clean home is the implementation slice's option
([§11](#11-open-questions-for-the-maintainer), question 5); re-declaring it
is refused either way.

### 2.2 The transports — three public surfaces, no fourth

**Decided: the fixture drives exactly three public transports**, and every
cell names the transport that produces it:

1. **The boundary's `Engine` doors** — the embedder surface (phase 11 §2.6),
   driven in-process through the package barrel. The only transport that can
   declare extensions, seed a fault at the port seam, or carry an attempt
   across doors within one process.
2. **The built CLI as a subprocess** — the process surface, driven exactly as
   the CLI's own suite drives it (`test/cli/harness.ts` spawns
   `dist/src/cli/index.js`): "an in-process import would test a different
   thing" (phase 12 §6). The transport whose subject is the exit table and
   the envelope.
3. **The Action's one invocation script** — the automation surface, driven
   as a transcript exactly as phase 13 §6 fixture 1 drives it: the assembled
   argv, the constructed environment, the conclusion, the output write. The
   fixture owns the scenario data; the Action implementation owns the
   mechanism ([§6](#6-the-action-fixture-model)).

The alternatives, weighed:

- **A fourth transport that imports the CLI's modules directly** (driving
  `src/cli/` in-process for speed). Refused: it tests the modules, not the
  process envelope — the exact substitution phase 12 §6 refuses — and it
  would drag the CLI's internals into the fixture's import graph against
  [§8](#8-what-the-fixture-never-does).
- **Driving the Action's composite `action.yml` itself.** Refused: the
  composite's subject is the runner's provisioning and materialization,
  which a hermetic suite cannot honestly exercise (phase 13 §6 drives the
  invocation script as the transcript); the fixture instantiates scenarios,
  it does not re-decide that boundary.

### 2.3 The direct side — independent construction, and what that pins

The pass-through equality needs a direct side: the same door called in
process, over the same world-document bytes, to be compared against the
surface's rendering. **Decided: the fixture's direct side constructs its
engine through the boundary's own factories** (`assembleMemoryStores`,
`assembleGitBinding` over `openGitBinding`) with the fixture's own recorded
tag naming (the vertical's `naming`: the every-tag namespace root, the
scope's rendered tag) — never through the CLI's `selectEngine`.

This is a deliberate supersede of the CLI suite's harness posture for the
fixture, and the reason is what each posture proves. The CLI suite builds
both sides through `selectEngine`, making equality hold by construction
("identical assembly, identical boundary values, only the transport
differs" — `test/cli/harness.ts`'s header); its subject is the rendering,
and the by-construction posture is right for it. The fixture's subject is
the standard itself: equality between independently constructed engines is
the stronger claim, and it pins one more thing for free — the CLI's declared
naming derivation (phase 12 §2.3) must render the tags the fixture's
recorded naming names, or the mint equality breaks loudly. If the fixture
used `selectEngine` on both sides, that derivation would be exempt from the
fixture's sight by construction.

The alternatives, weighed:

- **Reusing `selectEngine` for the direct side** (harness reuse). Refused
  here, kept there: it would prove the CLI renders the CLI's value, and it
  would make the fixture import a surface module the pass-through law exists
  to judge independently. Both postures are named so nobody silently
  "fixes" one to match the other.
- **No direct side — assert bytes only.** Refused: pass-through equality is
  the one phase 12 obligation that is structural rather than data, and
  dropping it would let a translation, default, or gate ship green
  (phase 12 §6.3's own words).

## 3. The scenario matrix

### 3.1 The axes

**Walks** — the recorded world's runs, five of them, each a scenario the
phase 10 matrix already owns as data:

| Walk | The run                                                                                                                                                                     | Scenario ancestry                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| W1   | the beta ladder run — `main`, intent `prerelease:beta:main`, mints `5.0.0-beta.1`; a second run mints `.2`                                                                  | the ladder's first two rungs (P-06, §3.2)        |
| W2   | the promote walk — `main`: beta.1, rc.1, then the promote intent mints `5.0.0`; the channels `stable` and `next` move, the promoted-from edge records, the rc stream closes | the promote door end to end (P-03, V4, ADR-0012) |
| W3   | the maintenance cut — `4.8.x` mints `4.8.7` from its own tags                                                                                                               | P-07's shape; M-02's independence                |
| W4   | the plan-only walk — the `plan` door over the declared world, twice                                                                                                         | the planner's purity (phase 2 §2.14)             |
| W5   | the deny walk — two attempts demand one scope: a stable-version denial, and a prerelease-sequence denial under a declared retry bound                                       | E-07's staging; E-08's bounded retry             |

**Interruption windows** — the recorded taxonomy, every window cited to the
contract that records it. A window not on this list is refused by rule
([§3.2](#32-the-earning-rules), R0); a window on this list with neither a
pinned cell nor a written refusal is a fixture defect
([§9](#9-test-obligations)).

| Window | Name                       | Recorded by                                                                                                                                                                        |
| ------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1     | mid-claim denial           | phase 4 §2.4's deterministic collision adjudication (E-07); the denial names the holder                                                                                            |
| I2     | sequence-retry denial      | phase 4 §2.4 item 5 (E-08); `retrySequence` — the bound exhausted conflicts explicitly, a denial with no recorded holder sequence conflicts immediately (D31's parity fold)        |
| I3     | write-ahead crash mid-walk | ADR-0006 decision 2's write-ahead discipline; E-01's crash doctrine — the started record is durable, the resume re-runs the step exactly once more (V7)                            |
| I4     | post-tag crash             | phase 4 §2.5's no-return boundary; `classifyCrash`'s complete-in-place (E-01) — tag recorded, plan valid                                                                           |
| I5     | post-abort restart         | ADR-0013 decision 4 — the fresh run refuses quoting the recorded abandonment; the refused run burns one ordinal, recorded                                                          |
| I6     | resume after abort         | ADR-0013 decision 3 — terminal from the ledger alone; the carried attempt throws the named violation, the fresh process refuses `unknown attempt` first                            |
| I7     | staleness                  | phase 5 §2.3's `classifyResume` (E-05) — the carried fingerprint disagrees with the recorded one; `stale`, re-plan                                                                 |
| I8     | resolution                 | phase 5 §2.7's blocked loop — `blocked`, then the recorded resolution re-arms, then the resumed outcome matches the uninterrupted run's                                            |
| I9     | channel ambiguity          | invariant 2.6; ADR-0012 decision 7 — a store that cannot determine whether a move landed records `ambiguous`, never `completed`; pinned twice (the stop, and the non-success read) |
| I10    | channel transition         | ADR-0012 decisions 3–4 — the moves land exactly between the started and completed records; a completed move replays `noop`; a divergent prior target conflicts                     |
| I11    | the declared lie           | phase 12 §2.4 — an unobserved feedRef faults at the planner's classification (exit 70, nothing executed); an unobserved ref head faults at the mint (exit 70, records standing)    |
| I12    | the pre-walk refusal       | phase 11 §2.5 — the engine's own target refusal on the hand-built-request path (a minting line with no recorded target), `handle: null`, `drives: []`                              |
| I3ext  | extension-step crash       | phase 10 §3.5's resumed hook — the declared hook's effect faults mid-window; the start is durable; the resume runs the effect exactly once more (ADR-0007 decision 6)              |

**Assemblies** — three, the boundary's own distinctions:

| Assembly          | What it is                                                                                                             | What only it can show                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `A-memory`        | `assembleMemoryStores` — the zero-persistence bundle; deterministic counter claim tokens                               | byte-identical envelopes with no projection; the published-without-mint posture; the store-less channel refusal                          |
| `A-git`           | `assembleGitBinding` over a hermetic temp repository (`withTempRepo` + the seeded line heads)                          | durability — recorded refs, the mint, restart visibility, byte-pinned tails                                                              |
| `A-cross-process` | the git assembly with a restarted engine — a second assembly over the same repository, nothing process-local surviving | the process-local attempt store's exact boundary between refusing and working ([§3.5](#35-the-cross-process-posture-what-it-pins-today)) |

### 3.2 The earning rules

A cell is a (walk, window, assembly) triple. It earns a pinned fixture only
under all of:

- **R0 — the window is recorded.** Only the taxonomy of
  [§3.1](#31-the-axes) produces cells. Interruption invention is the exact
  "recorded-evidence gap ships as certified" failure issue #125 names.
- **R1 — a transport can produce it through public doors today, or it is
  pinned as a typed row.** The typed-row class is phase 12 §6.2's own: rows
  the declarations-less one-shot process cannot produce are pinned as the
  table's typed rows and the renderers' renderings, with a declared
  reachability note in the manifest; the slice that makes one reachable moves
  the pin as part of its own obligations.
- **R2 — the assembly earns it by its distinguishing property.** A cell
  pinned on `A-memory` must exercise memory's determinism or its no-mint or
  store-less posture; on `A-git`, its durability; on `A-cross-process`, the
  process-local boundary. A cell that runs identically on two assemblies is
  pinned once, on the cheaper one.
- **R3 — the cell pins a crossing, not a floor.** The kernel's
  classification table, the planner's 53-scenario matrix, and the adapter
  suites already own their floors; a cell whose only assertion re-proves one
  is refused (the phase 10 §1 posture).
- **R4 — the cell's expectation is on the pinned-class list.** A scenario
  whose only claim is "it works" pins nothing
  ([§4.2](#42-the-classes)).

### 3.3 The earned cells

Thirty cells earn pins. The manifest
([§5](#5-the-change-protocol)) is this table's executable form — one row per
cell, naming its transports, its expectation classes and files, its owning
contract sections, and its live/typed status. Cell ids are
`<assembly>-<nn>`: deliberately outside the recorded scenario-code
namespaces (`M-`, `E-`, `P-`, `V-`, `R-` are the release matrix's and the
vertical's — a fixture id shaped like a scenario code would misroute every
grep).

| Cell        | Walk × window                                         | Assembly              | Transport                                  | Pinned classes                                                                                           | Why it earns                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ----------------------------------------------------- | --------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory-01` | W4                                                    | A-memory              | CLI                                        | exit, envelope bytes, determinism                                                                        | The pure surface's stability: double `plan` renders byte-identical JSON and the same exit (phase 2 §2.14 at the process); the one envelope needing no projection at all.                                                                                                                                                                                                |
| `memory-02` | W1                                                    | A-memory              | CLI + boundary                             | exit, envelope bytes, kind and tag rendering                                                             | The published-without-mint posture rendered verbatim — `published`, the plan's tag reported, no ref minted (`assembleMemoryStores` wires `mint: null`; verified). R2: memory's own distinction.                                                                                                                                                                         |
| `memory-03` | W5 × I1                                               | A-memory              | CLI + boundary                             | exit 11, `holder`, envelope bytes                                                                        | E-07 at the process: the loser's denial names the winner, and the pass-through equality holds on a stop.                                                                                                                                                                                                                                                                |
| `memory-04` | W5 × I2                                               | A-memory              | CLI (bound 0) + boundary (bound raised)    | exit 14 and exit 0                                                                                       | E-08's declared bound, both sides: the CLI's fail-closed default renders the explicit `conflict` (0 of 0); the raised bound's retry lands `sequence + 1`. The flag-to-kernel-clause mapping is a crossing.                                                                                                                                                              |
| `memory-05` | W1 × I3                                               | A-memory              | boundary                                   | exit, ledger projection, resumed-equals-uninterrupted                                                    | The write-ahead crash window through the embedder surface (V7 at the boundary; the phase 11 §5 obligation 5 posture, cell-ized).                                                                                                                                                                                                                                        |
| `memory-06` | W1 × I3ext                                            | A-memory              | boundary                                   | exit, ledger projection, exactly-once effect                                                             | The recorded extension-step window (the declared hook's mid-effect fault): the start is durable, the resume runs the effect once more, never duplicating a completion. The fixture's only declared-injection cell class — a caller posture, not a user-code surface ([§8](#8-what-the-fixture-never-does)).                                                             |
| `memory-07` | W1 × I7                                               | A-memory              | boundary                                   | exit 16, `stale` rendering                                                                               | E-05's refusal rendered at the surface, through the declared port-seam window (the `ShiftingLedger`-class wrapper — a fault seated where a store sits, the app harness's own pattern).                                                                                                                                                                                  |
| `memory-08` | W1 × I8                                               | A-memory              | boundary                                   | exits 12 → 2 → 0, ledger projection                                                                      | The blocked loop live: `blocked`, the recorded resolution re-arms, the resumed outcome matches the uninterrupted run's. The typed rows (`blocked`, `resolved`) made reachable on the embedder surface — the declared-injection note of R1, satisfied.                                                                                                                   |
| `memory-09` | —                                                     | A-memory              | CLI                                        | exit 10, `refused`, never a null                                                                         | The store-less channels corner: `show channels` over a memory assembly renders the engine's own refusal (no store wired; verified in `selectEngine`), never an empty list that reads as "no channels recorded" (phase 12 §2.7's corner).                                                                                                                                |
| `memory-10` | all memory cells                                      | A-memory              | CLI + boundary                             | byte identity                                                                                            | The zero-random assembly's determinism: every memory envelope is byte-identical across runs with no projection. The pairing with `git-01` is the proof that the projection rule ([§4.3](#43-the-generation-mechanism)) is the only delta between recorded and live git bytes.                                                                                           |
| `git-01`    | W2                                                    | A-git                 | CLI (and `action-01`'s subject)            | exit 0, envelope bytes (projected), tag, `drives`                                                        | The flagship: the promote walk through the process — the minted `5.0.0`, the `drives` list riding verbatim, the envelope pinned as reviewed bytes.                                                                                                                                                                                                                      |
| `git-02`    | W3                                                    | A-git                 | CLI                                        | exit 0, envelope bytes, tag                                                                              | The maintenance cut: cross-line independence at the process (M-02), the second byte-pinned walk.                                                                                                                                                                                                                                                                        |
| `git-03`    | W1 (second run)                                       | A-git                 | CLI                                        | exit 0, tag `.2`                                                                                         | The sequence advanced across processes: the durable claim register's recorded sequence is the only memory the second process has (P-06 across processes).                                                                                                                                                                                                               |
| `git-04`    | W5 × I1                                               | A-git                 | CLI + boundary                             | exit 11, holder attempt id, records standing                                                             | E-07 over the durable register: the denial names the winner's attempt id, the loser's records stand.                                                                                                                                                                                                                                                                    |
| `git-05`    | W5 × I2                                               | A-git                 | CLI (bound 0) + boundary (raised)          | exits 14 / 0, the immediate-conflict row                                                                 | E-08 over the durable register, plus the fold parity pin: a denial carrying no recorded holder sequence conflicts immediately (`retrySequence`'s first branch — D31's exclusion-path denials).                                                                                                                                                                          |
| `git-06`    | W2 × I10                                              | A-git                 | boundary                                   | ledger projection (moves between the started and completed records), replay `noop`, divergent `conflict` | ADR-0012's door at the surface: the moves land exactly in the write-ahead window; the replay classifies, never moves twice.                                                                                                                                                                                                                                             |
| `git-07`    | W2 × I9                                               | A-git                 | CLI + boundary                             | exit 15 pinned twice                                                                                     | Invariant 2.6 at the process: the ambiguity window (the deterministic `.lock` fault — the CLI harness's own mechanism) stops the walk, and the read a proceeding caller would have had to misread is pinned beside it.                                                                                                                                                  |
| `git-08`    | W1 × I3                                               | A-git                 | boundary                                   | byte-pinned tails, resumed-equals-uninterrupted                                                          | Durability's proof: a fresh binding over the same repository resumes from the reloaded tail; the resumed classification matches the uninterrupted run's; the tails compare byte-exact (the 10.3/10.4 bytes-over-values law at the fixture).                                                                                                                             |
| `git-09`    | W2 × I4                                               | A-git                 | boundary                                   | complete-in-place                                                                                        | E-01's no-return boundary live: tag recorded, plan valid, the doctrine resumes with the tag already satisfied. The one window whose verdict is not a re-run.                                                                                                                                                                                                            |
| `git-10`    | W3 × I5                                               | A-git                 | boundary (the abort) + CLI (the fresh run) | exit 10 quoting the record, the ordinal burn recorded                                                    | ADR-0013 decision 4: the fresh process re-running an aborted plan refuses, quoting the recorded actor, reason, and attempt id — and the expectation records the burned ordinal explicitly, so the derived-ordinal growth is legible rather than mysterious.                                                                                                             |
| `git-11`    | I6                                                    | A-git                 | boundary (thrown) + CLI (refused 10)       | the two renderings of one doctrine                                                                       | ADR-0013 decision 3: where the engine still carries the attempt, the later resume throws the named violation; from a fresh process the carried-attempt door refuses `unknown attempt` first. One doctrine, both renderings pinned, neither translated into the other.                                                                                                   |
| `git-12`    | W1 × I11                                              | A-git                 | CLI                                        | exit 70 twice, distinct rows, stdout empty                                                               | Phase 12 §2.4's honest rendering: the unobserved feedRef faults at the planner's classification before anything executes; the unobserved ref head faults at the mint after the walk's records stand. Two fault-band rows that must never collapse into one cell — the second leaves recorded evidence, the first leaves none.                                           |
| `git-13`    | —                                                     | A-git (nominally)     | CLI                                        | typed rows + renderings                                                                                  | The exit table's unreachable-today rows (`satisfied-externally`, `resolved`, `abandoned`, `blocked`, `failed`, `stale`, `escalate`) pinned as typed rows and renderings, exactly phase 12 §6.2's declared class — pinned here so the fixture's census of the table is total.                                                                                            |
| `git-14`    | I12                                                   | A-git                 | boundary                                   | `refused`, `handle: null`, `drives: []`                                                                  | The engine's own pre-walk target refusal on the hand-built-request path (verified in the boundary's git-assembly fixture) — the row the CLI's planner-classified lie deliberately does not render ([§3.3](#33-the-earned-cells), `git-12`'s other half).                                                                                                                |
| `x-01`      | —                                                     | A-cross-process       | CLI                                        | exit 10, pass-through equality with a fresh engine's value                                               | The carried-attempt doors (`resume`, `resolve`, `abort`, `show attempt`) from a fresh process render `refused(unknown attempt)` — pinned as pass-through, not as a verdict (phase 12 §6.7's pin, cell-ized): the assertion is equality with what a fresh engine returns, so the durable attempt lookup moves the value and not the cell ([§5](#5-the-change-protocol)). |
| `x-02`      | —                                                     | A-cross-process       | CLI                                        | exit 0, the recorded targets                                                                             | The one observation that works cross-process today: `show channels` reads the wired store's recorded states, not the carried entry.                                                                                                                                                                                                                                     |
| `x-03`      | I5                                                    | A-cross-process       | CLI                                        | exit 10 quoting the record                                                                               | The abandonment refusal read by a stranger process: the derived-ordinal scan reads the ledger only, so a process that never saw the abort still refuses the recorded evidence.                                                                                                                                                                                          |
| `x-04`      | —                                                     | A-cross-process       | CLI                                        | the recorded replay                                                                                      | A double run over unchanged recorded state does not re-execute: the second process's outcome is whatever the recorded evidence and the claim protocol yield — the exact expectation derived by hand from phase 12 §6.6's second half before the first run (the goldens discipline), never asserted loosely.                                                             |
| `action-01` | W2                                                    | A-git                 | Action                                     | envelope bytes ≡ the same invocation's CLI stdout (the runner-parse replay), conclusion success          | Phase 13 fixture 3's scenario cell: the promote scenario through the invocation script, the output write replayed against the runner's documented parse, byte-equal to `git-01`'s stdout.                                                                                                                                                                               |
| `action-02` | W5 × I1, W5 × I2 (bound 0), I12's CLI-classified half | A-git                 | Action                                     | conclusion failure, annotation fields verbatim                                                           | Phase 13 fixture 2's reachable rows instantiated with this contract's scenarios: `denied`, `refused`, `conflict` — each with its exit, its envelope kind, and its annotation fields.                                                                                                                                                                                    |
| `action-03` | I11                                                   | A-git                 | Action                                     | conclusion failure, stdout empty, the first stderr line verbatim                                         | The fault rows: exit 64 and exit 70 scenarios conclude failure with the fault text verbatim, stdout empty (pinned by the render module's own law).                                                                                                                                                                                                                      |
| `action-04` | —                                                     | A-git                 | Action                                     | conclusion failure + the raw exit or signal                                                              | The no-verdict row instantiated: a killed child, an unparseable envelope, a kind↔exit mismatch — each fails with the raw evidence, never green, never neutral.                                                                                                                                                                                                          |
| `action-05` | W2                                                    | A-git                 | Action                                     | envelope ≡ the clean run, byte for byte                                                                  | Phase 13 fixture 4's scenario cell: the planted ambient (lying `GITHUB_*`, `INPUT_WORLD`, `GIT_DIR`, a `NODE_OPTIONS` marker, a token-shaped `GH_TOKEN`) changes nothing the envelope, annotation, or conclusion carries.                                                                                                                                               |
| `action-06` | —                                                     | the repository itself | Action                                     | declared values ≡ the pin files                                                                          | Phase 13 fixture 1's drift row as scenario data: the composite's declared toolchain values paired with the repository's `.node-version` and `packageManager` — the row's data (which files, which fields) is owned here; the mechanism is the Action implementation's.                                                                                                  |

### 3.4 The refusals

| Refused cell                                                          | The rule that refuses it                                                                                                                                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Any hook or artifact window (I3ext) on a process transport            | The CLI v1 executes the empty declaration (phase 12 §2.6); the Action inherits it (phase 13 §2.3's refused `declarations`). The window is the boundary transport's, with declared injection. R1. |
| Any tag, mint, or post-tag window on A-memory                         | The memory assembly wires no tag door (`mint: null`, verified) — the tag boundary is the git assembly's. R2.                                                                                     |
| Any cross-process cell on A-memory                                    | Nothing persists; a second memory process is a second universe, and pinning it would certify amnesia. R2 (the same durability reasoning phase 13 §2.6 used to pin the Action's assembly to git). |
| Supersession windows (E-11, PL-08)                                    | The boundary has no supersede door (phase 11 §6) — the fixture cannot pin what no door performs. R1; the slice that lands the door owns the cells.                                               |
| Multi-line and whole-plan cells                                       | One line per run is the boundary's declared posture (phase 11 §4 question 7); a whole-plan cell would design the cross-line claim-ordering decision that slice owns. R1.                         |
| World-reader cells (a world derived from the repository)              | No alternative world source exists (phase 12 §7's slice); the fixture's worlds are declared documents, exactly the surfaces' posture. R1.                                                        |
| Publication and remote cells                                          | Nothing remote exists (ADR-0010's adapter is not wired to the run; phase 13 §2.8's token journey is decided empty). R1.                                                                          |
| A cell for the durable attempt lookup before it lands                 | The fixture pins today's refused posture ([§3.5](#35-the-cross-process-posture-what-it-pins-today)); the future cell is the change protocol's business, not a speculative pin. R1.               |
| Any window outside the §3.1 taxonomy                                  | R0. A suspected missing window is filed against the contract that should record it, then it enters here.                                                                                         |
| Duration, timing, and performance assertions                          | Not a performance suite (phase 10 §1's law, inherited).                                                                                                                                          |
| The kernel's and planner's own scenario matrices re-pinned end to end | R3 — the fixture pins crossings; the floors have their suites.                                                                                                                                   |

### 3.5 The cross-process posture — what it pins today

The posture the fixture pins is narrower than either surface contract's
blanket sentence, and pinning it precisely is the fixture's job. Today, from
a fresh process over a durable git assembly:

- `resume`, `resolve`, `abort`, and `show attempt` refuse — the engine
  carries no attempt for the plan; the rendered value is the boundary's own
  `refused(unknown attempt)` at exit 10, quoting the handle (verified:
  `carriedEntry` in `src/app/engine.ts`). Pinned as `x-01`.
- `show channels` works — the observation reads the wired store's recorded
  states, not the carried entry. Pinned as `x-02`.
- A fresh `run` over an abandoned plan refuses, quoting the recorded
  evidence — the derived-ordinal scan reads the ledger alone, so the
  process-local store's absence does not mute it. Pinned as `x-03`.
- A fresh `run` over a _completed_ plan does not re-execute — the recorded
  evidence and the claim protocol answer it. Pinned as `x-04`.

So the cross-process leg is not uniformly refused: two refusal cells, two
working cells. The fixture pins all four rather than the blanket "today, that
is `refused(unknown attempt)`" — the blanket sentence (phase 12 §2.7) is
true of the carried-attempt doors and false of the observation and the
fresh-run scan, and a fixture that pinned the blanket would go stale on the
day the durable lookup landed without any shape having moved dishonestly.

**The declared change.** When the durable attempt lookup lands (phase 11 §4
question 6 — its own reviewed change, never a drive-by), `x-01`'s four
carried-attempt renderings start working across invocations with zero
grammar change. The equality pin is what makes this cheap: `x-01` asserts
the rendered outcome equals what a fresh engine returns for that handle, so
the slice that lands the lookup regenerates `x-01`'s expectation file and
flips its manifest row's note — the cell does not move, the assertion does
not move, only the value does. The Action's `command` input refusal (phase
13 §2.3, §7) is tied to the same posture and moves in the same slice.

## 4. The expectation format

### 4.1 The derivation rule — two layers, one honesty

**Decided: expectations are recorded data, and the fixture states which of
two derivations produced each class.** The phase 10 law — "a golden the
engine produced is a mirror, not an expectation" — governs the first layer
and is deliberately, explicitly excepted for the second:

1. **The contract-derived layer** — expectations derived by hand from the
   phase contracts before any run asserts them: exit codes, outcome kinds,
   envelope shapes, tag mints, ledger projections' record sequences,
   conclusion rows. This layer catches regressions: it is what makes a
   byte-drift meaningful rather than merely visible, because a human can
   say which clause moved.
2. **The stability layer** — the envelope bytes, generated once, reviewed,
   committed, and diffed. These are mirrors by nature: no human hand-derives
   a plan fingerprint's hex. Their mirrorhood is the point — the standard
   being pinned is the byte-exact surfaced shape, and the diff is the review
   artifact when the shape legitimately moves. A regression that changes
   bytes fails both layers: the contract-derived layer names the moved
   clause, the stability layer names the moved bytes.

The alternative readings, weighed:

- **All expectations re-derived at test time** (compute the expected value
  from the code under test, compare to the code under test). Refused: it
  certifies whatever the code currently does — the exact silent-regression
  failure issue #125 opens with. No comparator may import the machinery it
  judges.
- **All expectations hand-derived, no byte pins.** Refused: hand-deriving
  envelope bytes would mean re-implementing the canonical-JSON hashing
  outside the engine — the second engine
  ([§8](#8-what-the-fixture-never-does)) under a test harness's name.
- **All expectations generated, no contract-derived layer.** Refused: a
  pure-mirror fixture makes every drift equally weighted noise; the
  reviewer would re-derive intent from first principles on every diff,
  which is how reviewed fixtures rot into rubber stamps.

### 4.2 The classes

One format decision per expectation class — the issue's list, closed:

| Class                               | Format                                                                                                                                                                                                                                                                             | Derivation                                                                                                                                                | What a diff means, and who re-reviews                                                                                                                                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exit codes                          | Recorded data — the fixture's own copy of the §3.2 table, asserted per cell                                                                                                                                                                                                        | Hand-derived from phase 12 §3.2                                                                                                                           | A table amendment (phase 12 §8 question 8's "renumbering is a table edit"): the edit lands in the same PR as the table. The fixture's copy is pinned equal to the CLI's `EXIT_CODES` record by a cross-pin in the CLI's own suite — one table, no second mapping ([§9](#9-test-obligations)) |
| Outcome kinds and envelope shapes   | Recorded data — the union's rows (kind plus carrying fields plus the context trio `planId`/`handle`/`drives`), asserted per cell                                                                                                                                                   | Hand-derived from `src/app/types.ts` and phase 11 §2.8's table                                                                                            | A surfaced shape moved; the owning slice updates the rows in its PR; the reviewer reads the diff against the union's own text                                                                                                                                                                |
| Envelope bytes (`--json`)           | Recorded data — one committed file per byte-pinned cell under the fixture's `expected/` directory, produced by the committed generator, with the projection rule applied ([§4.3](#43-the-generation-mechanism))                                                                    | Generated once, reviewed                                                                                                                                  | A surfaced byte moved; the slice that moved it regenerates in its own PR and names the cell in the body; the suite fails on any un-regenerated drift, so the update can never be silent                                                                                                      |
| Pass-through equality               | Structural — no data; per cell, the child's parsed stdout equals the direct door value serialized (the CLI harness's `expectPassThrough` posture, applied to the independently constructed direct side of [§2.3](#23-the-direct-side-independent-construction-and-what-that-pins)) | Not derived — asserted                                                                                                                                    | A translation, default, gate, or rendering drift the surface added; the surface's own slice owns the fix                                                                                                                                                                                     |
| Tag mints                           | Recorded data — the minted names per walk (`5.0.0-beta.1`, `5.0.0-rc.1`, `5.0.0`, `4.8.7`)                                                                                                                                                                                         | Hand-derived from the planner's declared formats (the vertical's `GOLDEN` values, reused)                                                                 | A naming or format drift; the planner slice's PR carries it, and the pass-through cells break loudly beside it                                                                                                                                                                               |
| Ledger projections                  | Recorded data — per cell, the tail's record-kind and step-key sequence in append order; on the git assembly, the byte-pinned tail with the projection applied                                                                                                                      | Hand-derived from the canonical stage sequence, the walk order (phase 11 §2.5), and the anchors — empty on process transports, whose runs declare nothing | A walk-order or record-vocabulary drift; the owning kernel/ledger/boundary slice regenerates in its PR, and the vertical matrix's V6/V7 rows fail beside it                                                                                                                                  |
| Action conclusions and output bytes | Recorded data — per scenario cell, the expected conclusion, the annotation fields, and the byte-equality with the CLI stdout (the parse replay's survivor)                                                                                                                         | Hand-derived from phase 13 §3.2's table; the bytes are the stability layer's                                                                              | A conclusion-table amendment: phase 13's slice owns the table, and this contract's copy updates in that slice's PR — one table, two renderings, never a fork                                                                                                                                 |

### 4.3 The generation mechanism

**Decided: a committed generator, committed expected files, and a suite that
only compares.** The mechanism, precisely:

- The **generator** lives beside the fixture (`test/certification/generate.ts`
  in the implementation slice's layout) and is invoked explicitly when a
  shape legitimately moved. It drives the same public transports through the
  one shared drive module, applies the projection rule, and writes the
  `expected/` files. It is deterministic: same world, same seeds, same bytes
  (modulo the projected values), provable by double generation.
- The **expected files** are committed data — one per byte-pinned cell,
  named by cell id (`expected/git-01.json`), each carrying the cell id, the
  projection-rule version, the projected stdout, the projected stderr where
  the class pins it, and the exit code.
- **`pnpm check` never runs the generator.** The suite rebuilds each
  byte-pinned cell through the same drive module and compares against the
  committed file. Generation is a review-time act; an accidentally-run
  generator can never turn a drift green, because nothing in the gated path
  writes.
- **Vitest snapshot mechanics are refused.** The `-u` affordance puts silent
  regeneration one flag away; obsolete-snapshot suppression hides deleted
  cells (the manifest's completeness is the fixture's own law,
  [§5](#5-the-change-protocol)); snapshot names are not manifest cell ids;
  and a snapshot file's provenance ("which decision pins this?") lives
  nowhere. A committed file named by cell id, with a manifest row naming its
  decision, is the same bytes with the provenance made executable.

**The projection rule** — the one honest concession to nondeterminism,
recorded as data rather than waved through: the git binding's claim token is
`randomBytes(32).toString("hex")` (verified:
`src/adapters/git/claim-store-git.ts`; the CLI harness documents it as "the
binding's one intentionally random value"), and the repository path is
per-repository. The projection is the generator's recorded, versioned rule —
the repo path rewritten to `REPO`, every 64-hex claim token rewritten to
`CLAIM`, in string and escaped-string spellings — applied identically at
generation and at comparison, so the comparator holds no cleverness and the
committed bytes are exactly what a reviewer reads. The memory assembly needs
no projection (its claim tokens are a seeded counter — `claim:1`, verified:
`MemoryClaimStore`), which is what makes the `memory-10`/`git-01` pairing
the proof that the projection is the only delta: if a second random value
ever entered the git path, the pairing would flake loudly rather than pin a
lie.

Rejected: projecting at _comparison_ time only (the committed file would
hold raw, repository-shaped bytes that differ on every contributor's
machine — unreviewable); seeding the git claim store to avoid the projection
(the seed would be a port bypass — the fixture reaching into the binding's
token allocation, [§8](#8-what-the-fixture-never-does)); and excluding git
cells from byte-pinning entirely (the durability layer is exactly where byte
stability is the promise — the 10.4 law inherited).

### 4.4 The drift-detection story, stated once

A fixture delta is a finding, not a failure of the fixture. The flow is the
same for every class: the suite goes red naming the cell and the class; the
slice whose change moved the shape regenerates the data, updates the
manifest row, and names the cell in its PR body; the reviewer reads the diff
as the artifact — the contract-derived layer's row tells them which clause
moved, the stability layer's diff shows them exactly what the surface now
says. A PR that regenerates without the shape having moved is as suspect as
a PR that lets the suite stay red: the diff is reviewed either way, and the
manifest's provenance row says which decision the cell serves.

## 5. The change protocol

**Decided: the manifest is the mechanism** — one committed, executable
census at `test/certification/manifest.ts` (the implementation slice's
layout), one row per cell:

```text
ManifestRow {
  id                  // "git-01" — the cell id, and the expected/ file's name
  walk, window, assembly, transports
  classes             // which pinned classes the cell asserts
  expectedFiles       // the committed byte files, when the cell has them
  provenance          // the owning contract sections — phase 12 §3.2, ADR-0013 decision 4, …
  status              // "live" | "typed-row"
  reachability        // for typed rows: the declared-unreachable note and its mover
}
```

The manifest is enforced, not decorative — the suite fails when:

- an `expected/` file exists with no manifest row, or a row names a file
  that does not exist (no orphans, either direction);
- a row's cell id is not produced by any test (a census row without a pin);
- the set of windows appearing across the manifest differs from the
  recorded taxonomy's set — every window of [§3.1](#31-the-axes) appears in
  exactly one of the earned cells or the refusals table. This is R0 made
  executable: a window quietly omitted from both is a red suite, not a
  recorded-evidence gap shipping as certified.

Per-fixture provenance comments (each expected file's header naming its cell
and decisions) are kept as the reading aid, but the manifest is the law — a
comment can rot silently, a completeness check cannot.

**The protocol, step by step:**

1. A surfaced shape legitimately moves in slice S — a phase 12/13 amendment,
   the durable attempt lookup, a new outcome field, a conclusion-table edit.
2. S regenerates the byte files the shape moved, updates the manifest rows
   (including flipping any `typed-row` whose reachability S changed), and
   amends the cross-references in this document if the decision itself
   moved.
3. The diff is the review artifact: S's PR body names every drifted cell by
   id, and the contract-derived layer's diff names the clause.
4. Never silently: the suite fails on un-regenerated drift, the gate is
   never weakened, and a regenerated fixture whose production change is
   absent (or the reverse) is refused in review.

The known movers are named now so the protocol's first uses are not
improvised: the **durable attempt lookup** (phase 11 §4 question 6 —
`x-01`'s values flip, the grammar does not move, the Action's `command`
input is revisited in the same slice); the **world-reader slice** (phase 12
§7 — `--world` gains a source; the fixture's world documents gain a
provenance row, no cell moves); the **publishing slice** (phase 13 §7 — the
publication cells are refused today and enter through that slice's PR); and
any slice that makes a `typed-row` reachable (phase 12 §6.2's standing
obligation, inherited by every mover).

## 6. The Action fixture model

**Decided: the Action's scenarios are data owned here; the mechanisms are
the Action implementation's.** Phase 13's fixtures name what they consume —
fixture 1's invocation-and-drift rows, fixture 2's conclusion table, fixture
3's byte-equality and parse replay, fixture 4's hostile leg, fixture 8's
metadata gate — and this contract owns the scenario list and expected data
those fixtures instantiate:

- The **scenario set** is this contract's git-assembly cells driven through
  the invocation-script transport: `action-01` (the promote scenario — the
  world document, the line, the actor, the intents, the tag namespaces, the
  expected envelope bytes shared with `git-01`'s file), `action-02` (the
  stop scenarios: the denial, the refusal, the bound-exhausted conflict),
  `action-03` (the fault scenarios), `action-04` (the no-verdict
  scenarios), `action-05` (the hostile-ambient scenario paired byte-for-byte
  with its clean run), `action-06` (the drift row's paired files).
- Each scenario is recorded data: the world document's exact bytes (the
  recorded world's, serialized once), the argv the grammar demands, the
  expected exit, the expected envelope kind and bytes, the expected
  conclusion, the expected annotation fields.
- The Action implementation consumes these modules — the same import
  relationship the app harness has to the vertical matrix — and owns the
  mechanisms around them: the script drive, the `env -i` construction, the
  output write, the runner-parse replay, the metadata gate.

The alternative — the Action suite declaring its own scenarios — is
refused for the reason issue #125 names: the Action's scenarios are
instantiated data, and data instantiated twice is data that drifts. The
conclusion rows beyond the one-shot `run`'s reachable subset
(`satisfied-externally`, `resolved`, `abandoned`) are typed rows in the
Action's own suite under phase 13 §6.2's declared posture; the fixture
models them no further.

## 7. The dogfood standard

**Decided: "certified" for task #11's self-run means the run lands inside
the pinned classes on the git assembly, plus the Action conclusion row it
exercises.** The dogfood runs the repository's own release through the
repository's own Action — a real run over a real world, not the fixture
harness — so the standard is class-shaped, not byte-shaped:

1. **The exit-code class** — the run's exit code equals the §3.2 table's
   entry for its rendered kind. No band-collapse observed at any layer.
2. **The envelope class** — the run's `--json` envelope parses to the pinned
   shape inventory: the kind, its carrying fields, the `planId`/`handle`/
   `drives` context. (Its bytes are the repository's own, not the fixture's.)
3. **The ledger-projection class** — the recorded tail after the run matches
   the projected record sequence for the run's walk class (the promote walk's
   cells, `git-01`/`git-06`, are the shape).
4. **The Action leg** — `steps.release.outputs.outcome` equals the run's
   stdout byte for byte (the output-write replay re-proven on the runner
   itself, phase 13 §6.3's own expectation), and the step conclusion equals
   the conclusion table's row for the envelope's kind.

One mismatch is a filed defect against the owning slice, never a waived
row — that sentence is the gate's wording, and it is the whole wording. The
proposed default from the issue is confirmed with one addition: the
projection-class row (3) is what makes the dogfood a certification rather
than a smoke test, because it reads the recorded evidence rather than the
process's own claims.

What certified does **not** demand, stated so nobody discovers it in the
run: byte-equality with the fixture's recorded envelopes (the dogfood's
world is the repository's own); a remote tag, a GitHub Release, or anything
left the runner (phase 13 §7's honest v1 verdict stands — the dogfood
verifies verdicts, conclusions, and recorded evidence, not publication); and
a second dogfood run as a determinism proof (a re-run over unchanged
recorded state lands the recorded replay — `x-04`'s class — which the
fixture already pins; the dogfood need not repeat it, though it may).

## 8. What the fixture never does

The never-does inventory, each row with its enforcement:

- **No second engine.** The fixture derives nothing the engine derives — no
  claim-view derivation, no scope derivation, no walk re-ordering, no
  planner call outside the public door, no retry loop, no ordering rule of
  its own. The generator is a driver, not an oracle: it feeds inputs and
  records outputs; it computes nothing about releases. Enforcement: the
  import law below plus review; a fixture that needs a derivation the
  surfaces do not export has found a surface gap, and files it.
- **No port bypass.** No store mutation outside the doors, no direct ref
  write, no mint outside the walk, no seeded state that walks around a
  guard. The seeded-fault windows sit at the port seam — the app harness's
  wrapper class (`ShiftingLedger`, `SwitchableClaimStore`), a fault seated
  where a store sits, producing every outcome through the public surface —
  and each such cell's manifest row names its wrapper. A wrapper that
  invents behavior rather than withholding honesty is a second engine by
  another name. Enforcement: the manifest's wrapper column plus review.
- **No user-code surface.** The fixture injects hook effects and producers
  only through the boundary's declared per-run seam, on boundary-transport
  cells only ([ADR-0007](../adr/0007-hooks-as-steps.md) decision 2's caller
  posture — the fixture is a caller, which is exactly what that seam is
  for); no module path is ever named, no effect library is created, and no
  process-transport cell declares anything (the CLI v1 and Action
  inheritances). Enforcement: the transport table
  ([§2.2](#22-the-transports-three-public-surfaces-no-fourth)) plus the
  negative inventory ([§9](#9-test-obligations)).
- **No environment, clock, or randomness reads.** Recorded `COMMITTED_AT`,
  the binding's fixed commit identity, counter tokens; the one random value
  meets the projection rule ([§4.3](#43-the-generation-mechanism)), never a
  live read. Enforcement: the isolation probe below, the layers' own
  mechanism inherited.
- **No `src/` imports past the barrels.** The fixture's own modules import
  the package barrel (`src/index.ts`) and the adapter barrel
  (`src/adapters/git/index.js`) only — the boundary's own law ("the barrels
  are the doors", phase 11 §3) is the tests' law, and the existing harness
  honors it the same way (`test/app/harness.ts` imports the package front
  door and the fixture data modules, nothing else). The CLI enters only as
  the built bin in a subprocess, never as an import; the exit-table
  cross-pin is the CLI suite's business for exactly that reason
  ([§9](#9-test-obligations)). The known transitive exception — the shared
  recorded-world modules' planner-internal import — is recorded, not
  waved through ([§2.1](#21-the-recorded-world-reuse-not-fork)).
  Enforcement: the isolation probe walks the fixture modules' imports.
- **No cross-fixture coupling.** Cells are order-independent: each seeds its
  own repository and world; no cell reads another cell's output; the one
  deliberate sharing is the recorded world's data modules, and any
  shared-store scenario is declared in its manifest row (the app harness's
  shared-register posture). A suite that passes only in file order is a
  suite that lies on `--shard`. Enforcement: suite structure plus the
  manifest's sharing column.
- **No timing, duration, network, or real-remote assertions.** Phase 10 §1's
  law, inherited whole.
- **Ecoma appears nowhere** (invariant 2.12): the fixture's worlds, actors,
  and lines are the vertical matrix's invented values.

## 9. Test obligations

For the implementation slice. The fixture suite is **organized by assembly,
addressed by manifest id** — the vertical suites' naming law ("every test
name names its invariant row and the step it proves") carried to the
fixture:

- **Layout** (proposed home, [§11](#11-open-questions-for-the-maintainer),
  question 3): `test/certification/` — `manifest.ts` (the census),
  `matrix.ts` (the scenario list: walks, windows, worlds — recorded data
  importing the vertical modules), `drive.ts` (the one shared drive module
  the generator and the suite both use — the two never fork a runner),
  `generate.ts` (the committed generator, never run by `pnpm check`),
  `expected/` (the committed byte files), and one suite per assembly:
  `memory.test.ts`, `git.test.ts`, `cross-process.test.ts`,
  `action.test.ts` (the boundary-transport cells live in the assembly suite
  of the assembly they pin; the transport is a column of the manifest, not a
  directory of the suite).
- **Naming**: `<cell id> · <window or posture> · <the claim>` — e.g.
  `git-10 · post-abort restart · the fresh run refuses quoting the record and burns one ordinal`. A
  test name that cannot be found in the manifest is a defect in one of them.
- **What `pnpm check` runs**: the certification suites join the package's
  `test` task (the moon task already hashes `test/**/*`, verified — no
  input edits owed), so format, lint, typecheck, tests, build, and arch all
  judge them like any other test code. The generator runs in no gated path.
- **The executable laws**, beyond the cell pins: the manifest completeness
  checks ([§5](#5-the-change-protocol)); the exit-table cross-pin — the
  fixture's recorded §3.2 copy equals `EXIT_CODES`, pinned in the CLI's own
  suite (`test/cli/exit-codes.test.ts`), which may import the CLI's module
  where the fixture may not; the isolation probe — no
  `process.env`, no clock, no randomness, and no non-barrel `src/` import
  anywhere under the fixture's own modules; and the refusal-inventory probe —
  a fixture module naming a refused input (`--declarations`, `--target`,
  `--naming-module`, an `assembly` Action input) fails the suite that names
  the inventory (phase 12 §6.4 and phase 13 §6.6's pattern, inherited).
- **The coverage posture**: the fixture drives public surfaces, so its
  coverage rides the same run under the existing 80% thresholds; it adds no
  internal-suite obligations and claims none — the internal modules stay
  their own suites' business, and the fixture must not be counted as their
  substitute when a threshold is argued.
- **The runtime budget** is an obligation, not a hope:
  [§11](#11-open-questions-for-the-maintainer), question 2 proposes it and
  the implementation PR measures it.

## 10. How this design could fail silently

The honesty section — the fixture's failure modes, and what pins each:

- **The fixture re-derives expectations at test time and certifies whatever
  the code currently does.** The regression ships green. Pinned by the
  two-layer derivation rule ([§4.1](#41-the-derivation-rule-two-layers-one-honesty)):
  the contract-derived layer is hand-authored before any run, the stability
  layer is committed data, and no comparator imports the machinery it
  judges.
- **The generator and the suite drift into two runners** — the suite
  compares against a rebuilt world the generator never produced, and the
  pins certify the suite's own drive. Pinned by the one shared drive module
  both consume ([§9](#9-test-obligations)); a second runner is a review
  refusal, and the memory/git pairing (`memory-10` vs `git-01`) would flake
  if the two drives diverged in their projection.
- **The projection hides a real nondeterminism.** A second random value
  enters the git path and the byte pins start flaking instead of pinning.
  Honest limit: the flake is loud, and the projection rule is versioned
  data — a new projected field is a reviewed regeneration, never a silent
  widening of the regex. What cannot be pinned structurally is pinned by
  the pairing.
- **The matrix quietly omits an interruption window** and a recorded-evidence
  gap ships as certified. Pinned by R0 plus the executable census
  ([§5](#5-the-change-protocol)): every recorded window appears in exactly
  one of the earned cells or the refusals, and the suite enforces the set
  equality.
- **The fixture grows a second composition** and certifies the fixture's
  behavior instead of the product's. Pinned by the never-does inventory
  ([§8](#8-what-the-fixture-never-does)), the barrel-only import probe, and
  the pass-through equality — which is precisely the assertion a second
  composition breaks first.
- **A typed row rots**: a slice makes `blocked` (say) reachable through the
  CLI and nobody moves the pin, and the fixture reads as under-tested
  against a boundary that moved. Pinned by the manifest's declared
  reachability notes being the change protocol's step 2 — the mover flips
  the row in its own PR (phase 12 §6.2's standing obligation, inherited).
- **The dogfood waives a row** ("the run is green, the shape is close
  enough"). Pinned by §7's one-sentence gate: one mismatch is a filed
  defect, never a waived row — and the standard's classes are checkable
  without the fixture harness, so the waiver would be visible in the run's
  own artifacts.
- **The fixture's own suite gets slow enough that contributors stop running
  it locally**, and drift is discovered only in CI. Pinned by the runtime
  budget being an obligation with a refusal priority
  ([§11](#11-open-questions-for-the-maintainer), question 2) — a budget
  nobody enforces is a budget nobody has.

## 11. Open questions for the maintainer

The contract decides the shape and the discipline; these are deliberately
left open, each with its proposed default:

1. **The phase number.** "Phase 14" is proposed — the phase after the
   Action — and this document's name follows it; renumbering is a rename,
   not a redesign.
2. **Matrix breadth versus suite runtime.** The repository's suite already
   takes roughly five to six minutes; the fixture must not tax that
   silently. Proposed: the certification suites cost no more than **90
   seconds** wall within the test task, measured on the implementation PR
   (the class costs are known: a git cell is a temp repository plus seeds,
   a CLI cell is a subprocess spawn, the rest is in-process), and a cap of
   **40 live cells** — the §3.3 table's thirty leaves headroom for the
   change protocol's additions. If a future slice busts the budget, the
   refusal priority is fixed now: first narrow the byte-pinned classes to
   the flagship walks (`git-01`, `memory-01`); second collapse the
   boundary-transport cells whose rows the app suite already pins to their
   exit-rendering class alone; third collapse the cross-process leg to its
   posture minimum (`x-01` through `x-03`). The full-matrix dream — every
   window on every assembly — is refused by this rule rather than by
   silence.
3. **The fixture's home.** `test/certification/` is proposed over
   `test/fixture/`: the directory holds the standard (manifest, matrix,
   drive, generator, expected bytes, suites) exactly as `test/vertical/`
   holds the vertical matrix's, and a `test/fixture/` would read as "inputs
   for other tests" — which this is not; it is the thing other surfaces
   consume. The shape does not move with the name.
4. **The dogfood gate wording.** §7's four classes and the one-sentence
   waiver rule are proposed as task #11's acceptance wording, verbatim.
5. **The shared recorded world's home.** Imported from `test/vertical/`
   as-is is proposed (one recorded truth; the transitive planner-internal
   import is the vertical modules' own posture, recorded in
   [§2.1](#21-the-recorded-world-reuse-not-fork)); relocating the shared
   data modules to a barrel-clean home is the implementation slice's
   option, taken in its own PR, never a re-declaration.
