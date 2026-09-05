# Phase 1 contracts — the kernel's five release values

> **Status: Phase 1 design asset ([#13](https://github.com/ecoma-io/release-craft/issues/13)).**
> This document is the contract the Phase 1 implementation and its suite are
> reviewed against. It implements the Phase 0 vocabulary lock
> ([ADR-0002](../adr/0002-release-model-and-domain-vocabulary.md)) exactly:
> the five kernel-value kinds — `Change`, `ChangeSet`, `ReleaseLine`,
> `Channel`, `Artifact` — beside the existing
> [`Version`](../adr/0001-domain-kernel-and-semantic-version.md). Nothing here
> may introduce a term outside that vocabulary, a provider concept, or a
> planning/execution responsibility; each contract cites the invariant and
> scenarios it serves.

## Design rules inherited from `Version`

Every value follows the discipline ADR-0001 established for `Version`
(`core/domain/version.ts`):

1. **One door, validated.** Values are constructed through static factories
   (`parse`, `of`, `create`) that validate everything and throw a dedicated
   `Error` subclass carrying the offending input and a human reason;
   constructors are private; no partially built state can exist.
2. **Frozen deeply.** `Object.freeze` on the instance and on every array
   field; mutation returns a new value or throws — never edits in place.
3. **Identity is explicit.** `equals` is structural over declared fields;
   where identity differs from structural equality (Change), a named method
   states the identity relation. No `valueOf`/`toString` tricks beyond a
   canonical `toString`.
4. **Opaque strings stay opaque.** Ids, digests, and coordinates are
   non-empty, trimmed strings the kernel never parses, patterns, or
   dereferences. Validation is presence and shape-agnostic: non-empty after
   trim, that is all. (Invariant 15: the kernel names no provider state —
   this is enforced by having no field that could carry one.)
5. **Errors name their contract.** One error class per value
   (`InvalidChangeError`, …) mirroring `InvalidVersionError`'s shape: the full
   input and a reason; no leaking of internal fragments as the input.

## `Bump` — the implied bump level

A version-semantics enum (not one of the five values; it is the vocabulary
`ChangeSet` needs, expressed over `Version`'s existing `bumpMajor/bumpMinor/
bumpPatch`):

- `type Bump = "major" | "minor" | "patch"` — a frozen const record
  `BUMP_LEVEL` maps each level to its ordinal (0 patch < 1 minor < 2 major)
  for comparison.
- `Bump.max(a, b)` — the higher level. The Conventional-Commits mapping
  (`feat`→minor, `fix`→patch, breaking→major) is **planning/adapter policy**
  and does not live here; combining already-decided levels is value
  semantics (baseline §17 KEEP row 2 is preserved conceptually by the
  planner, not by this enum).
- `Version#apply(bump)` is **not** added — `bumpMajor/bumpMinor/bumpPatch`
  already exist; a switch at the call site would duplicate them.

## `Change` — the atomic unit of work, identified for transport

Serves [invariant 9](release-model.md#architectural-invariants) (change
identity survives transport), scenarios M-03, M-04, M-05, M-06, M-09, PL-04,
PL-05.

```ts
export class Change {
  public readonly id: string; // opaque, stable across cherry-picks
  public readonly lineage: ChangeLineage;
  public static of(id: string, lineage?: ChangeLineage): Change;
  public sameIdentity(that: Change): boolean; // id equality only
  public equals(that: Change): boolean; // id + lineage, structural
}
export interface ChangeLineage {
  readonly parent?: string; // ChangeId this one derives from (F″→F′→F)
  readonly originCommit?: string; // opaque sha where it originated
  readonly originLine?: string; // LineId it originated on, if known
}
```

- **Identity is the id, nothing else.** `sameIdentity` compares ids alone:
  one logical fix on three lines is one change (M-03); the same id with
  divergent payload descriptors is the conflicting-backport case (M-05), and
  the value keeps both facts — same identity, different lineage records.
- **Identity is never derived** from content, shas, or hashes (invariant 9);
  the marker convention that produces ids (trailer/footer, open fork 8) is
  adapter-side and out of scope here.
- **Validation:** `id` must be a non-empty trimmed string; `lineage` fields,
  when present, must be non-empty trimmed strings. Anything else throws
  `InvalidChangeError`. No structural constraint links `parent` to any other
  value — the kernel does not resolve lineages, it records them.

## `ChangeSet` — an enumerated group and the bump it implies

Serves R4 (granularity lock), scenarios PL-06 (empty is a result), P-03
(change set may be inherited), M-03 (no triple-counting).

```ts
export class ChangeSet {
  public readonly changes: readonly Change[];
  public readonly bump: Bump; // "patch" when empty
  public static of(changes: readonly Change[], bump: Bump): ChangeSet;
  public static empty(): ChangeSet;
  public includesIdentity(id: string): boolean;
  public equals(that: ChangeSet): boolean;
}
```

- **The group's bump is supplied, decided upstream, and recorded verbatim.**
  A `Change` carries no bump — the commit-type mapping is planning policy —
  so `of` takes `(changes, bump)` and `empty()` is `of([], "patch")`. The
  planner computes the level from its own policy; the value carries it,
  frozen ([ADR-0002](../adr/0002-release-model-and-domain-vocabulary.md):
  ChangeSet "with the bump it implies" — the implication is decided
  upstream, recorded here).
- **Identity-uniqueness enforced:** two members with the same
  `sameIdentity` throw `InvalidChangeSetError` at construction — the
  triple-count failure (M-03) is made unrepresentable at the value level.
  Same id with different lineage is still one identity: the conflict is a
  planning fact (to be surfaced there), not two entries.
- **Order-insensitive equality:** the group is a set by identity; `equals`
  compares identity sets and the bump, not entry order.

## `ReleaseLine` — the ordered stream of versions, identified by itself

Serves [invariant 7](release-model.md#architectural-invariants) (identity is
not a ref name) and [invariant 8](release-model.md#architectural-invariants)
(prereleases are streams), scenarios M-10, S-03, S-05, P-01, P-02, P-05,
P-06, P-07, M-08.

```ts
export type LineLifecycle = "active" | "frozen" | "retired";
export interface PrereleaseStreamState {
  readonly target: Version; // the target version the stream runs to
  readonly identifier: string; // "alpha" | "beta" | "rc" | … (opaque)
  readonly sequence: number; // head of the numeric sequence, ≥ 0
}
export class ReleaseLine {
  public readonly id: string;
  public readonly lifecycle: LineLifecycle;
  public readonly released: Version | null; // released-version pointer
  public readonly streams: readonly PrereleaseStreamState[];
  public static create(id: string): ReleaseLine; // active, null, []
  public withReleased(version: Version): ReleaseLine; // monotonic guard
  public advanceStream(target: Version, identifier: string): ReleaseLine;
  public streamVersion(target: Version, identifier: string): Version | null;
  public freeze(): ReleaseLine;
  public retire(): ReleaseLine;
  public equals(that: ReleaseLine): boolean;
}
```

- **No branch anywhere.** The value has no feed field; feed mappings are
  planning-side data (A5). Invariant 7's test constructs a line, "renames the
  feed branch" (a no-op on the value), and asserts identity survives — the
  test proves the absence of the field.
- **The released pointer is monotonic per line.** `withReleased` requires
  `version.compare(this.released) > 0` (and a non-prerelease? no — a line may
  publish a prerelease pointer only through streams; the pointer holds
  releases; guard: throws `InvalidLineTransitionError` on regression or
  equality). Equal-version re-release on one line is a conflict the value
  refuses to represent (M-11/E-11 are per-line facts).
- **Streams are keyed by (target, identifier), carried as state.**
  `advanceStream` returns a new value with that key's `sequence + 1`, seeded
  at 0 when absent — the arithmetic of sequence advancement is value
  semantics (P-01: `alpha.9` → `alpha.10`, never lexicographic; P-04: a
  mid-RC `feat` bumps the sequence). Advancing a _different_ target under
  the same identifier is a new key — no cross-target continuation (P-05:
  the target moved under you). Choosing _which_ stream, or a ladder
  (alpha→beta), is policy; the value computes none of it.
- **`streamVersion` composes** `target` + `-identifier.sequence` through
  `Version.parse` and orders by `Version#compare` — the stream's current
  version as a value (P-06: two streams, one target, both expressible; P-02:
  the ladder is per-identifier).
- **Lifecycle transitions are total and validated:**
  `active → frozen | retired`, `frozen → retired`, `retired` is terminal;
  anything else throws `InvalidLineTransitionError` (M-10: retirement is a
  state, not deletion). Mutating methods on a retired line throw.
- **`equals` is structural** over id, lifecycle, released (Version
  `equals`), and the stream set keyed by (target, identifier).

## `Channel` — the mutable deliverability pointer, as a value

Serves R1, [invariant 7](release-model.md#architectural-invariants), scenarios
PR-04, PR-05, AR-04.

```ts
export interface ChannelTarget {
  readonly line: string; // LineId
  readonly version: Version; // the released version pointed at
}
export class Channel {
  public readonly id: string;
  public readonly target: ChannelTarget | null; // null = hidden/empty
  public static create(id: string): Channel; // target null
  public static of(id: string, target: ChannelTarget | null): Channel;
  public repoint(target: ChannelTarget | null): Channel; // move or hide
  public pointsAt(line: string, version: Version): boolean;
  public equals(that: Channel): boolean;
}
```

- **A move is a new value; history is not stored here.** The event log of
  moves is execution-side (PR-04's audited events, PR-05's timeline); the
  kernel value is the current binding only — `repoint` back to a prior
  target (rollback) is the same value-level operation as any move
  (S-04/PR-04: hiding is `repoint(null)`).
- **The target names a line and a version, never a branch, ref, PR, or
  registry object** (invariant 15). Whether the binding also names an
  artifact is execution-side (registry channels are adapters).
- **`pointsAt` is identity by value:** `line` string equality plus Version
  `equals` — the query PR-05's membership timeline asks of one point in
  time.

## `Artifact` — one publishable output, identified by digest

Serves R6, A4, scenarios AR-01..AR-06, PR-01, PR-02, PR-03, and the kernel
half of [invariant 15](release-model.md#architectural-invariants).

```ts
export class Artifact {
  public readonly kind: string; // "npm" | "container" | … (opaque)
  public readonly coordinates: string; // "ghcr.io/x/app:2.0.0" | … (opaque label)
  public readonly digest: string; // content identity, opaque
  public static of(kind: string, coordinates: string, digest: string): Artifact;
  public sameContent(that: Artifact): boolean; // digest equality only
  public equals(that: Artifact): boolean; // all three, structural
}
```

- **Content identity is the digest** (PR-01: promoting without rebuild is
  pointing at the same digest; PR-02: a deliberate rebuild is a new
  generation — _generation_ is execution-side bookkeeping over digest
  records, not a kernel field).
- **Coordinates are labels, never references** (AR-03: the artifact version
  scheme differs from the release version; a container tag is not parsed,
  compared, or ordered by the kernel).
- **Evidence does not live here.** Validation results with freshness (PR-03)
  are execution-side bundles bound to digests; the kernel records the
  (kind, coordinates, digest) triple and nothing about validity.

## The barrel and the alias seam

`core/domain/index.ts` becomes the kernel's single entrypoint, exporting
`Version` + the five values + `Bump`/`BUMP_LEVEL` + every error class. The
three declarations (tsconfig `paths`, `package.json` `exports`, vitest
`resolve.alias`) all name the barrel instead of `version.ts`;
`src/index.ts` re-exports the same surface. This is the ADR-0001 decision-8
amendment (D6) and it lands in the same PR as the second primitive — this
PR.

## ADR-0001 amendments carried by this PR (D6)

1. **Decision 8** — the alias seam now names the barrel
   `core/domain/index.ts`; adding a primitive no longer touches the three
   declarations.
2. **Decision 7 rationale annotation** — "the kernel does not know channels
   exist" is narrowed to _progression policy_: the kernel now carries the
   `Channel` pointer value and stream **state**; which stream advances, and
   when, remains line/channel policy outside `core/domain/` code paths
   (computations over stream state — `advanceStream`, `streamVersion` — are
   value semantics, not policy).
3. **Consequences parenthetical annotation** — "(lines, channels,
   transitions)" governs policy **resolution**, not the value shapes; the
   shapes are locked by ADR-0002 and land in `core/domain/`.

## Test obligations (the suite is an external consumer, ADR-0001 decision 9)

All tests import through `../src/index.ts` only. Per value, the contract
suite must prove at least:

- **Construction doors** — every factory's rejection cases (empty ids,
  blank strings, wrong types) with the error class and full-input contract.
- **Freeze discipline** — mutating a frozen array field throws; no method
  mutates the receiver (call it twice, assert deep equality).
- **`Change`** — M-03/M-05: same id across three lines is one identity
  (`sameIdentity` true) while lineage differs; identity is never a function
  of content descriptors (two different origins, same id: still one).
- **`ChangeSet`** — duplicate identity throws; empty set equals `empty()`;
  order-insensitive equality; bump recorded verbatim.
- **`ReleaseLine`** — invariant 7: no branch field exists (assert the
  value's own enumerable keys against the contract's field list); monotonic
  released pointer (equal and lower throw); P-01 sequence arithmetic
  (`alpha.9` → `alpha.10`, and ordering by `compare` — never string sort);
  P-05 target move starts a new key at 0; lifecycle transition matrix
  including retired-terminal; stream composition round-trips through
  `Version.parse`.
- **`Channel`** — repoint/hide as new values; `pointsAt` by value; the
  target carries no provider concept (keys assertion as above).
- **`Artifact`** — `sameContent` true across different coordinates with one
  digest (AR-03/PR-01); structural equality distinguishes coordinates.
- **Interaction** — a line + channel + artifacts ensemble: release on the
  line moves the pointer, channel repoints to it, artifact records bind by
  digest — the PL-01-shaped ensemble expressed purely in kernel values, as
  the planner's future input alphabet.
- **Provider isolation, executable** — for every exported value, the test
  asserts the value's field names contain no provider vocabulary
  (`branch`, `ref`, `pr`, `pull`, `github`, `dist-tag`, `registry`,
  `runner`); this is invariant 15's kernel half made runnable, as the
  adversarial review demanded.

## Out of scope (and where it stays)

Planning (bump policy, line selection, plan building) — Phase 2, `src/`.
Execution (attempts, claims, ledgers, publishing, promotion machinery,
evidence) — later phases. The change-id marker convention (fork 8) and
decision-record storage (fork 16) — adapters/Phase 2 decisions respectively.
No file in this PR introduces any of them.
