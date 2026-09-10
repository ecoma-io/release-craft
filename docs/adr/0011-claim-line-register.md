---
id: 0011-claim-line-register
status: proposed
created: 2026-09-07
updated: 2026-09-10
---

# ADR-0011: The per-line claim register — atomic cross-scope exclusion

## Context

The git-backed claim store (ADR-0009 decision 4) enforces the exclusion
law — a held `release-line` claim excludes every other claim on that
line, and a `release-line` request yields to any held claim on it
(Phase 4 contract §2.3, E-07) — as a serial scan-then-CAS: `acquire`
scans every claim ref that exists, evaluates the exclusion predicate
over the records it reads back, and only then creates its own scope's
ref with a one-ref compare-and-set. The scan and the create are two
steps over _different_ refs: two scopes on one line hash to two
distinct refs, so the CAS arbitrates same-scope races only. Two
processes whose scans both complete before either create lands can both
accept on different scopes of the same line — the Phase 4 invariant
holds only serially. This is the known window, filed as #47 and tracked
as #49.

The exclusion relation itself is line-local: `excludedBy(requested,
held)` is false unless both scopes share a `lineId`. No exclusion ever
crosses a line. Whatever mechanism arbitrates the predicate therefore
needs to coordinate exactly the claims of one line — nothing more, and
nothing less.

## Decision

1. **The binding's claim store holds one register ref per release
   line, and every mutation is a compare-and-set of the whole
   register.** The register ref lives under the same claim namespace —
   `refs/release-craft/claims/<sha256(lineId)>`, the digest over the lineId's
   UTF-8 bytes (revised in #133 to the product-neutral family
   `refs/release-craft/`; the mapping's shape is unchanged, invariant 2.12) —
   and its tip commit's blob is
   the line's claim set in canonical form:
   `{"claims":[<claim record>…]}`, the records sorted by their scope's
   canonical JSON (a total order; scopes are unique within a register —
   same scope is the same key). `acquire` reads exactly its line's
   register and computes the next set; `release(token)` — the port's
   only release signature — first resolves the token through the
   all-register walk decision 3 names, then computes the next set.
   Both land with the existing
   one-ref CAS (`casAppendCommit` against the observed tip — the observed
   tip is the same read's: a mutation reads the register once, content and
   base together, because a base read separately would let a concurrent
   writer land strictly between the two reads and the old-value check
   would pass over a set the mutation never saw); a lost CAS
   re-reads and re-evaluates, it never adjudicates against stale state —
   and a release's re-read re-checks the record's presence and removes
   **by token, never by scope**: a release racing the same scope's
   re-acquisition by a new holder must delete the old holder's record
   only. The exclusion predicate and the accept become one atomic
   transition
   per line: the same ref's CAS that creates the claim is the CAS that
   checked the line's other claims.

2. **The invariant the register enforces (and the failure model it
   assumes).** For any two claims that coexist in the store, neither
   excludes the other — and no interleaving of two `acquire` calls
   whose scopes share a line can return a claim to both. The model is
   the one the binding already assumes: concurrent writers on one
   repository, git's per-ref lockfile making each ref update atomic, no
   wall clock, no network coordination, no component above git. The
   register needs nothing newer: the claim–verify–write cycle the
   protocol already names (the CAS is the verify), whose loser observed
   a concurrent winner and simply retries from the new
   tip. Cross-line concurrency touches different refs and needs no
   coordination — the predicate it would have to enforce does not
   exist. The model's "one repository" is the guarantee's whole reach:
   the register's exclusion is one shared ref space — compare-and-set
   over the one repository's own `refs/release-craft/claims/*` — and it
   extends exactly that far (#182). Two runs of the same line in two
   different checkouts of one repository do not share local claim refs
   (a standard clone fetches only `refs/heads/*` and `refs/tags/*`; the
   adapter never fetches remote claim state — ADR-0010 decision 3), so
   each acquires in its own ref space, both mint locally, and the
   divergence first surfaces at the consumer's push — a non-fast-forward
   rejection, outside the engine's verdict vocabulary. Serializing across
   checkouts is a declared precondition of every surface above the
   binding (the CLI's law, phase 12 §5; the Action's posture, phase 13
   §2.9), not a mechanism the register provides or ever proposes to
   provide.

3. **Reads narrow to the line, with three named exceptions.** `acquire`
   reads exactly one ref (the
   requested scope's line register) instead of scanning every claim ref
   in the namespace; `verify(token)`, `release(token)`'s token
   resolution, and the tag door's held-claim
   lookup still walk every register (the token index is the set of
   registers), but the enumeration is per-line registers, not
   per-scope refs. The `ClaimStore` port is unchanged — the same
   `acquire`/`verify`/`release` surface, the same `Claim`/`ClaimDenied`
   values, and the in-memory store is untouched: it already enforces
   the invariant atomically, and once the rewrite lands the two stores
   are indistinguishable through the port (ADR-0009 decision 3;
   decision 7 records today's one divergence, #69).

4. **An empty register persists; the ref is never deleted.** Releasing
   the last claim of a line leaves `{"claims":[]}` at the ref. Deleting
   the ref would add a second CAS class (delete racing a writer who
   based on the old tip) for no benefit: an empty register reads as an
   unclaimed line, the twin of an absent one, and the write path stays
   one primitive.

5. **A register blob that is not a register refuses loudly.** The
   claim namespace's blob shape is part of the mapping the binding
   owns; a blob without the register envelope is corrupted recorded
   state or a foreign layout, and reading it is a thrown fault, never
   a silent empty set. The canonical form is the envelope's own
   contract: an unsorted or duplicate-scope set, or an element outside
   the record's fields, refuses with the same voice — the writer sorts
   before every land, so a set no writer could have produced is
   corruption, not a value. This decides the layout change's stance: the
   mapping is total — **repositories written by the per-scope layout
   are not readable by the register store and fail loudly on the first
   claim read.** The project is pre-adoption; no migration path is
   owed, and the loud refusal is chosen over an incompatible-namespace
   mapping whose stale refs would be silently invisible.

6. **No lease, no clock, no stale owner.** The issue's proposed
   mechanism — a transient per-line lock with timestamp-based lease
   staleness — is rejected: the binding's discipline bans the wall
   clock from every door (ADR-0009 decision 4's "no ambient `HEAD`",
   the execution layer's clock-free rule), a lease converts a crashed
   holder into a stale owner that blocks the line until the clock
   declares it dead, and staleness under clock skew is silent — the
   exact failure class the store exists to refuse. The register has no
   transient state and therefore no stale owner: a crash before the
   CAS moved nothing; a crash after it left a recorded claim, released
   by token or superseded through the recorded path (E-05/E-09)
   exactly as Phase 4 already provides. Recovery is the next compare-
   and-set. Neither mutation bounds that loop: `release` re-reads and
   re-evaluates exactly as `acquire` does, so the port's release — like
   the in-memory store's — cannot surface a lost race as an error;
   sustained same-line contention costs retries, not failures.
   Amendment landed in #231 (issue #194): the release half of that
   sentence is engine-unreachable on today's main. The token is minted
   at `acquire`
   and the acquiring process is its only carrier — no engine code path
   calls `claims.release` (the binding's passthrough is the port's only
   caller in `src/`), and a fresh process cannot name the token, so
   "released by token" never fires after process death. Cross-process
   recovery remains unsupported: a restarted process is a fresh attempt
   id (the durable register's ordinal), and the same-scope adjudication
   denies it as a non-holder of the dead holder's still-recorded claim —
   a permanent denial for a stable-version record (the stable-scope dead
   lock, E-07) and a `holderSequence+1` success that strands the dead
   attempt's tail for a prerelease sequence (phase 11 contract §2.7's
   accepted residuals). The durable plan-keyed attempt lookup and the
   holder policy that would make a takeover honest are tracked as #227,
   not provided by the register.

   Amendment (issue #194): the recovery loop now crosses processes for
   the boundary's resume door — the reconstructed attempt re-enters the
   same attempt id and the store's idempotent same-scope re-acquisition
   returns the durably stored token, no release or supersede door
   needed. `release` by token remains engine-unreachable (no caller in
   `src/app`; only the binding's passthrough), and the other
   carried-attempt doors keep the refusal their process-local posture
   gives them (phase 11 §2.7's residual).

7. **Denials match the in-memory store exactly (issue #69, folded
   here).** An exclusion-path denial carries no `holderSequence` — the
   held scope in that path is a line-level exclusion, and the
   requester's own sequence is not a retry base. The same-scope
   adjudication denial carries the _winner's_ sequence when the
   winner's scope is a prerelease sequence (E-08's retry base). The
   git store's current exclusion path stamps the requester's own
   sequence into `holderSequence`, diverging from the reference store
   and enabling an E-08 retry loop keyed on a meaningless
   base; the register rewrite lands the parity pin.

8. **The Phase 9 read seams follow the record (the amendment's blast
   radius, loud here).** A claim ref now names a register blob, so the
   changelog seam's single-record read widens to the set:
   `ContentRead.claim(ref): ClaimRecord | null` becomes
   `ContentRead.claims(ref): readonly ClaimRecord[]` (an absent ref is
   the empty array), and the publication unit's tag→claim derivation
   iterates the set. `RefRead.claims()` is unchanged mechanically — it
   enumerates the namespace — and its documented object ("the
   canonical record's blob") becomes the register blob. The tag door's
   held-claim lookup changes its source, not its shape: same filter,
   same caller contract. No engine port widens and no new door exists;
   the widening is the binding's own §2.8 read seam, named above.

### Rejected alternatives

- **Rejected — the issue's lease lock** (`refs/ecoma/locks/<lineId>` —
  recorded under the pre-#133 namespace family, kept verbatim as the
  rejection's history; timestamp staleness): banned clock, stale-owner
  cleanup, and it does not even remove the per-scope CAS — it adds a
  second coordination primitive beside it, each with its own failure
  window (the lock's staleness window around the CAS's exclusion window).
- **Rejected — fencing epochs on the scope refs**: a monotonically
  issued epoch would order writers across the scan/create gap, but the
  epoch counter needs its own atomic, durable allocation — the same
  register CAS underneath — plus new vocabulary in every record; it
  widens the surface to keep the two-step shape the register
  collapses.
- **Rejected — a serialized single writer** (one process owns all
  claim mutations): moves the invariant out of the store into an
  availability bottleneck the binding cannot verify; the object store
  already provides the arbitration primitive.
- **Rejected — a per-line append-log folded at read time**: records
  each accept/release as a commit and computes the claim set on every
  read. Equivalent arbitration, larger blast radius: every Phase 9
  seam consumer (the refs enumeration, the changelog seam, the tag
  door) would fold instead of read, and the folded state the readers
  want is exactly what the register keeps materialized.
- **Rejected — documenting the serial-only guarantee**: #49's own
  rejected alternative; it weakens the Phase 4 contract instead of
  enforcing it.

## Consequences

- **Test strategy.** The exclusion matrix re-pins on both backends:
  the memory store's exclusion matrix (`test/execution/claim.test.ts`)
  and the git claim fixtures (`test/adapters/git/claims-mint.test.ts`)
  re-pinned on the register shape, plus one dual-backend scenario list
  run over both stores — new suite work, not a re-pin of an existing
  one. The deterministic concurrency suite drives two writers
  one move at a time through a hostile `GitRun` that diverges the
  register between a loser's read and its CAS — at the CAS itself, and
  at the read the CAS bases on (the window whose closure pins the
  single-read base): the loser re-evaluates against the diverged tip
  and lands or denies — never both-accept,
  never a stale adjudication. The release pins hold the removal key:
  a release racing the same scope's re-acquisition deletes the old
  holder's record, never the new holder's. The crash windows pin the
  register at a
  consistent tip on either side of every CAS. The #69 pins hold the
  denial shapes. The empty-register, foreign-blob, and non-canonical-form
  pins hold decision 4 and 5's postures. The decision 2 scope boundary
  (#182) is pinned as a negative capability test: two clones of one
  repository, the same line's claim acquired in each — both acquire,
  each register lists only its own record, neither token verifies in the
  other's ref space, and the two clones hold the same register ref name
  at disjoint tips under a heads-only clone refspec.
- **Recorded state grows with claim churn.** A register mutation
  appends one full-set commit, so every accept and release on a line
  adds a commit where the per-scope lease's release deleted its ref —
  the ledger's append-only norm extended to claims, bounded by the
  line's claim lifetime; the same posture the ledger's tail already
  holds.
- **Zero-config regression** holds: the store is opened exactly as
  before, on a repository path; the mapping is internal.
- **The layout amendment is loud**: ADR-0009 decision 4 is amended
  (the one-ref accept becomes the one-register accept, and the
  check-and-set delete of a scope's ref leaves the claim path), the
  Phase 8 contract's §2.2 mapping sentence and §2.3's accept diagram
  and release paragraph are amended with it, D24 is annotated as
  superseded on the claim mapping, and the Phase
  9 contract's §2.7/§2.8 seam texts follow the widened read. The
  decision log records this as D31.

## Amendments this ADR makes (loud, in this PR)

- [0009-git-binding.md](0009-git-binding.md): decision 4's accept and
  release boundaries (per-scope refs → the per-line register; the
  check-and-set delete dies with the per-scope mapping —
  `casDeleteRef` leaves the claim path).
- [../design/phase8-git-binding-contract.md](../design/phase8-git-binding-contract.md):
  §2.2's per-scope mapping sentence and §2.3's accept diagram, release
  paragraph, and mint-door phrasing.
- [../design/phase9-github-adapter-contract.md](../design/phase9-github-adapter-contract.md):
  §2.7's claim-object wording and §2.8's `claim(ref)` → `claims(ref)`.
- [../design/decision-log.md](../design/decision-log.md): D31, with
  D24 annotated.
