# Phase 10 contract — the complex release vertical matrix

Owner: [#74](https://github.com/ecoma-io/release-craft/issues/74). This
contract is Phase 10's deliverable (task 10.1); the slices it bounds
(10.2–10.5) bind only as their own reviewed PRs, in the order §4 fixes.

## 1. Scope and non-goals

Phase 10 adds no engine behavior. The mechanisms the matrix exercises
have landed: the deterministic planner (ADR-0003/0004), the execution
kernel (ADR-0005, Phase 4), the ledger (ADR-0006, Phase 5), hooks as
steps (ADR-0007, Phase 6), the artifact graph (ADR-0008, Phase 7), the
git binding (ADR-0009, Phase 8), the assembled GitHub adapter
(ADR-0010, Phase 9), the per-line claim register (ADR-0011, #49), and
the channel transition (ADR-0012's `channel-transition` canonical stage
with the channel store's compare-and-set — PR-04's execution half, the
gap [#76] filed, landed since). The matrix drives the promote's planned
moves through the store door and asserts what moved (§3.1, V4).
The phase's deliverable is proof: one complex release scenario, carried
vertically through the stack one layer at a time, re-proving the phase
contracts' guarantees where their failures actually hide — between
layers. No ADR accompanies this contract: it decides nothing
architectural, and a mechanism the matrix cannot exercise without
inventing one is a gap to file, not to design here.

Non-goals:

- **No new doors, ports, or vocabulary.** A slice that needs one has
  found a defect or a gap — file it; the slice stops at the gap.
- **No remote side effects.** The GitHub slice's transport is
  caller-injected exactly as ADR-0010 decision 2 provides; the matrix
  never touches a real remote.
- **Not a performance suite.** Nothing here asserts duration, only
  recorded state.
- **Not a replacement for the per-phase proofs.** The 53-scenario
  planner matrix (D19) and the per-phase suites stand; the vertical
  composes them and pins what they cannot see.

## 2. Shapes — the scenario declaration

The matrix is one scenario declaration every slice consumes. In text
(the slices hold it as fixture data; nothing here enters the public
surface):

```text
VerticalMatrix {
  lines: readonly LineFixture[5]       // §3.1 — seeds and policies
  channels: readonly ChannelFixture[5] // §3.1 — the named pointers
  ladder: readonly LadderRun[4]        // §3.2 — 5.0.0-beta.1 → 5.0.0
  sideRuns: readonly SideRun[…]        // §3.2/§3.3 — 4.8.7, patches, propagation
  artifacts: readonly ArtifactStep[6]  // §3.4 — anchor + guard each, phase 7 §2.1 shape
  hooks: readonly HookFixture[4]       // §3.5 — succeeding/failing/retried/resumed
  interruptions: readonly Interruption[…] // §3.6 — crash and failure windows
}
```

A `LineFixture` names a line id, its recorded seed (bootstrap version or
existing tags), and its line policy — including the per-line prerelease
seed (`streams.seed`, D13's fork: `"0"` numbers a stream's first
prerelease `.0`; `main` declares `"1"` so §3.2's ladder numbers from
`.1`). A `ChannelFixture` names a channel
id and the target the matrix asserts at each checkpoint — the `Channel`
value's own shape (line, version), constructed through the domain door.
An `Interruption` names the step key and the window kind: `crash` (the
process dies mid-step, E-01) or `failure` (the step's observation
refuses, recorded, resumed past).

Every fixture is recorded data — no fixture computes. The matrix's
expected surface (decisions, versions, channel targets, the ledger tail,
the recorded refs, the derived remote rows) is written as golden values
in the slices, derived by hand from the phase contracts before any run:
a golden the engine produced is a mirror, not an expectation.

## 3. The matrix

### 3.1 The five lines and the five channels

| Line      | Seed                               | Reads as                             |
| --------- | ---------------------------------- | ------------------------------------ |
| `main`    | bootstrap `4.9.0`, tags to `4.9.2` | the ladder line (§3.2)               |
| `4.8.x`   | tags to `4.8.6`                    | the maintenance cut `4.8.7`          |
| `3.x`     | tags to `3.2.1`                    | a minor line releasing beside `main` |
| `2.x`     | tags to `2.4.0`                    | a second independent line (M-02)     |
| `1.9-lts` | tags to `1.9.1`, LTS policy        | the long-term line (M-10 vocabulary) |

Channels are the `Channel` domain value's named pointers, five of them:
`stable`, `beta`, `rc`, `next`, `lts`. Each fixture fixes a seeded
target — `stable` at `4.9.2`, `lts` at the `1.9-lts` cut, the rest at
the matrix's declared pointers. A channel moves only through the
transition door ADR-0012 landed: the `channel-transition` canonical
stage writing through the channel store's compare-and-set. Every run
that plans no move asserts every channel unchanged at its seed; the
promote run on `main` moves exactly the channels its plan names —
`stable` and `next` to the promoted stable (V4) — and never a channel
its plan does not name.

### 3.2 The prerelease ladder and the stable cut

On `main`, four runs in order, one release line policy throughout:

1. `5.0.0-beta.1` — the beta stream opens (P-02's fresh sequence per
   identifier).
2. `5.0.0-beta.2` — only the beta stream advances: P-06 holds within a
   run and across the ladder's runs, and no other stream's number
   moves.
3. `5.0.0-rc.1` — the rc stream opens from its own key; the beta and
   rc scopes coexist, so nothing denies across them.
4. `5.0.0` — the promote door: empty change set, `bump: null`, and the
   stable version mints as a record (ADR-0009 decision 4, phase 8
   §2.3). The run's transition half is the plan's channel content
   (ADR-0012 decision 2): the `stable` and `next` moves in declaration
   order, then the promoted-from edge, then the rc stream close. The
   matrix pins the planner surface and the executed outcome — the
   store's moved pointers, the ledger's channel-transition records
   keyed by what the store observed deciding (V4).

The E-08 staging is same-scope: two attempts demand the same stream's
next version through one register, the loser's denial carries the
winner's sequence as its retry base (ADR-0011 decision 7), and the
retry lands the next number.

Beside the ladder, `4.8.x` cuts `4.8.7` from its own tags — P-07's
maintenance shape, transferred to the vertical — and `3.x` / `2.x`
release their own minors/patches independently: no cross-dependency
between any two lines' runs (M-02). A `stable-version` claim on any
line is a record, not a lease: its release is a no-op and a later
verify still reads held (ADR-0009 decision 4, phase 8 §2.3 — the
scenario code P-01 names the alpha-increments scenario instead; the
repo-wide misattribution is filed as [#77]).

### 3.3 Cross-line propagation

One fix lands on `main` and is carried to `4.8.x` and `1.9-lts`. Each
line mints its own version for it — `4.8.7`, `1.9.2` — with lineage
recording the shared change; no line's history merges another's and no
version repeats across lines (M-09's lineage-is-traceability, M-11's
collision gate if a fixture ever aims two lines at one tag — the matrix
asserts the refusal names tag, both lines, both heads).

### 3.4 The artifact walk

Six artifact steps, declared in the phase 7 §2.1 shape — each with its
`anchor` and `guard`; `kind` and `coordinates` opaque, recorded
verbatim, never dereferenced:

| id            | kind          | dependsOn                        | postconditions              |
| ------------- | ------------- | -------------------------------- | --------------------------- |
| `package`     | `npm`         | —                                | content-fingerprint-present |
| `binary`      | `binary`      | —                                | content-fingerprint-present |
| `container`   | `container`   | `package`                        | content-fingerprint-present |
| `sbom`        | `sbom`        | `package`, `binary`              | evidence-present            |
| `changelog`   | `changelog`   | `package`, `binary`              | evidence-present            |
| `publish-all` | `publication` | `container`, `sbom`, `changelog` | evidence-present            |

The graph is the phase 7 dependency DAG: the verify precondition holds
before `publish-all`, a dependency's absence refuses at declaration
validation, and the generations record the walk. Every step completes
inside the walk, before the `publish` stage: the phase 9 §2.8 gate
refuses a publish whose declared `changelog` step lacks its completion
record (`changelog-unrecorded`), so the DAG orders `changelog` before
`publish-all` and the matrix never meets the refusal — no step anchors
after the publish stage. The six kinds are the matrix's declared
labels, nothing more — the engine sees opaque strings.

### 3.5 The hook runs

Four declared hooks, the phase 6 shape (one guard name, one
caller-injected effect, recorded proofs):

- **Succeeding** — `hook:notify`: the observation meets the declared
  postconditions; the completion records with its proof.
- **Failing** — `hook:attest`: the observation refuses a postcondition;
  the failure records (§2.5's recorded failure, never a throw), the
  attempt's outcome classifies, and the walk stops in order.
- **Retried** — `hook:sign`: the first observation refuses; the failure
  records and the attempt blocks (`blocked(validation)`, cause
  `validation:hook:sign:<unmet postcondition>`) — a failed hook blocks,
  it never skips (phase 6). `resolveBlocked` re-arms the attempt,
  `classifyResume` then walks back to the hook step, and the second
  observation lands. The failed record stays in the tail — the retry
  appends beside it; a completed hook is never re-executed (the ledger
  projection answers the replay).
- **Resumed** — `hook:publish`: the process dies between the hook's
  write-ahead start and its completion; the crash classifies (E-01) and
  the resume re-runs the effect exactly once more, never duplicating a
  completion.

### 3.6 The interruption windows

The matrix pins one interruption per canonical stage of one line's run —
`plan`, `claim`, `prepare`, `validate`, `commit`, `tag`,
`channel-transition`, `publish`, `verify` (ADR-0012's ninth stage included)
— plus three hook windows by name: `hook:attest`'s failure,
`hook:sign`'s first failure, `hook:publish`'s mid-effect crash — plus
one window inside the artifact walk (after `sbom`, before `changelog`
completes). Every window is `crash` except the two named failures. The
full-matrix run then completes: every window classified on the next
run, and every resume's classifications and completions matching the
uninterrupted run's (§6 recovery) — the resumed tail is not required
byte-equal, because a re-appended write-ahead start legitimately
widens it.

## 4. The slices

Each slice is one PR, ascending one layer at a time; each inherits the
whole matrix and adds only its layer's proving mechanics. Each names,
in its PR body, the §6 invariant rows it lands and the steps that
exercise them.

### 10.2 — the in-memory semantic vertical

Planner and execution kernel over the memory stores. Constructs the
engine through the public doors (`plan()`, `openAttempt`,
`scheduleHooks`, the `ClaimStore` port) with no persistence; asserts
decisions, versions, claims, transitions, and outcomes for every §3 run.
This slice owns the matrix's first full expression: every §6 invariant
the table carries here — all but V6, whose byte-identity needs a
persisted tail — gets its in-memory proof.

### 10.3 — the ledger-backed replay vertical

The same matrix through the ledger's doors: between runs nothing lives
in process memory — the next run reloads the recorded tail (phase 8
§2.2.3's reload path) and classifies through `classifyResume` (phase 5
§2.3, the crash classes E-01). A completed step replays
`noop`/`conflict` exactly as E-02 keys them (fingerprint mismatch
included); the resumed run classification-matches the uninterrupted
run's (§6 recovery), and an uninterrupted double run is byte-identical.

### 10.4 — the git-backed vertical

The binding's real persistence under the full matrix: the ledger, the
attempt register, and the claim register are the binding's recorded
refs; the matrix reads back through the binding's read doors only. The
deterministic concurrency harness (ADR-0011's hostile-git pattern)
drives two attempts one move at a time inside the matrix's `claim`
stages; the crash windows kill mid-write and pin the register and the
ledger at consistent tips on either side. Double runs land byte-equal
tails (the fixed identity and clock make them so).

### 10.5 — the GitHub-backed vertical

The assembled adapter (ADR-0010's `openGitHubAdapter`) over the matrix,
constructed zero-config: repository path, credentials, the injected
transport — nothing ambient. Publication derives every remote row from
the recorded evidence alone (the changelog seam); the tag mint is the
binding's create-if-absent door (phase 8 §2.6) and the remote push is
the adapter's synchronization; reconciliation compares the remote
against the binding per R-10..R-12 under D30's per-listing observation
outcomes — a listing failure is an outcome, never a demotion — and an
out-of-band remote mutation is detected on the next reconcile.

## 5. Laws

The matrix inherits every door discipline; a slice that violates one is
wrong regardless of its assertions:

- **No mutation before claim** (Phase 4 §2.9): every mutating stage of
  every run holds its claim first; the register arbitrates.
- **Write-ahead** (ADR-0006 decision 2): every step's start is durable
  before its effect may run — the resume and crash windows sit exactly
  there.
- **No wall clock** (E-05/E-10, phase 4 §2.10; phase 8 §3): no fixture, no
  assertion, no resume decision reads a clock; git identities are the
  binding's fixed ones.
- **Refusals are returned values** (Phase 9's failure classes; the
  recorded-refusal discipline): nothing in the matrix asserts a thrown
  surprise; every refusal is classified and recorded.
- **Append-only tails** (ADR-0009; ADR-0011 decision 4's empty
  register): no slice deletes or rewrites a recorded ref; immutability
  is asserted, not assumed.
- **Zero-config per layer** (ADR-0009; ADR-0010): a slice constructs
  its store/binding/adapter from a repository path alone; 10.5 adds the
  injected transport and nothing else.
- **Public doors only**: the matrix drives `plan()`, `openAttempt`,
  `scheduleHooks`, the store ports, the binding and adapter factories —
  never an internal.

## 6. The invariants

Eleven named invariants — the vertical set the slices prove. They are
numbered here, not in the kernel's list (Phase 4 §3 names the kernel's
own); where both speak, the kernel's reading is the definition and this
section names the steps that carry it upward.

| #   | Invariant           | Statement                                                                                                                                                                                                                                                                                                                                 | Carried by |
| --- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| V1  | Plan integrity      | Same inputs plan identically (the plan fingerprint, E-05 / ADR-0006 decision 4); the executed steps are exactly the planned canonical sequence; content fingerprints verify (E-03).                                                                                                                                                       | 10.2–10.5  |
| V2  | Identity            | `attemptIdentity` is stable across resume and crash; step identity `(attemptId, stepKey)` is unique per run; five lines' runs never share an attempt.                                                                                                                                                                                     | 10.2–10.5  |
| V3  | Prerelease sequence | The ladder advances per stream §3.2; only the demanded stream moves; a same-scope denial carries the winner's sequence as the retry base (E-08), and beta and rc coexist.                                                                                                                                                                 | 10.2–10.5  |
| V4  | Promotion           | The promote run lands the promote decision (empty change set, `bump: null`) and the stable `5.0.0` record; the channels move exactly as the plan records them — `stable` and `next` to the promoted stable, the untouched channels standing (§3.1) — and the replay classifies every move noop, never moving twice (ADR-0012 decision 4). | 10.2–10.5  |
| V5  | Supersession        | An abandoned target's `supersedes` relation records; the abandoned attempt's claims release by token; no channel points at an abandoned version (D19(4), E-09).                                                                                                                                                                           | 10.2–10.5  |
| V6  | Immutability        | Every recorded tail is append-only across the whole matrix; each record reads back byte-identical at every later checkpoint.                                                                                                                                                                                                              | 10.3–10.5  |
| V7  | Recovery            | Every §3.6 window classifies and resumes from the recorded tail — no completed step re-executes, no uncompleted step skips, and the resumed run's classifications and completions equal the uninterrupted run's (phase 5 §2.3, phase 8 §2.2.3).                                                                                           | 10.2–10.5  |
| V8  | Concurrency         | No two attempts hold excluding claims on one line (ADR-0011 decision 2), through the vertical's own claim path; a lost CAS re-evaluates and lands or denies, never both-accepts.                                                                                                                                                          | 10.2–10.5  |
| V9  | Divergence          | Lines sharing a fix mint their own versions (§3.3); propagation never merges line identity; a two-lines-one-tag plan refuses naming both (M-09, M-11).                                                                                                                                                                                    | 10.2–10.5  |
| V10 | Reconciliation      | The remote surface derives from recorded evidence alone and reconciles per R-10..R-12 under D30's per-listing outcomes; an out-of-band mutation is detected.                                                                                                                                                                              | 10.5       |
| V11 | Zero-config         | Each slice's construction takes only its layer's inputs (§5's last two laws); no ambient environment, clock, or configuration surface appears.                                                                                                                                                                                            | 10.2–10.5  |

A slice's PR body enumerates its rows with the test names that pin them;
a row without a test in some slice is either not that slice's row (the
table says so) or the slice is incomplete.

## 7. Test obligations

- One suite per slice (e.g. `test/vertical/`), matrix fixture data
  shared per slice, goldens written by hand from the phase contracts
  before the runs that assert them.
- Every test name names its invariant row and the §3 step it proves
  (`V7 · tag-window · resume completes the run`).
- Bytes over values from 10.3 onward: persisted tails, register blobs,
  and derived remote rows compare byte-exact, through the layer's read
  doors only (§4's per-slice read rule).
- The concurrency rows (V8) drive the ADR-0011 harness pattern — the
  hostile runner, the arm-gated interception, the fired-flag worlds —
  in the slices with an interception seam (10.4's `GitRun` shim, 10.5's
  injected transport); at 10.2–10.3 V8 is the port's own atomic
  semantics. A serial-only concurrency proof is the #47 class and
  refuses review.
- Determinism is asserted, not assumed: every slice runs the matrix
  twice and requires identical tails (10.4's byte-equality is exact).
- The hermetic-environment assertions (leaked hook environment, hostile
  config) hold in every slice; no fixture spawns git or network outside
  the layer under test.
