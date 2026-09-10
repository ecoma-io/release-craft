# Phase 9 contract — the GitHub adapter

Phase 9 lands the GitHub adapter: remote synchronization, tag publication,
GitHub Release creation, and E2E reconciliation over the git binding's
recorded state (ADR-0010, ADR-0009). Everything here consumes the git
binding's barrel — never its internals, never the engine's internals — and
adds no persistence store, no second claim authority, and no new domain
vocabulary.

## 1. Scope and non-goals

In scope:

- A GitHub adapter layer under `src/adapters/github/` consuming the git
  binding's barrel (`src/adapters/git/index.js`).
- Remote ref synchronization (push of claim refs and minted tags).
- GitHub Release creation and verification for published tags.
- E2E reconciliation: discovery of pre-existing remote state (tags,
  releases) and comparison against the binding's recorded state.
- Failure classes: `ok`, `refused` (with reason), `transport-failure`,
  `ambiguous` — returned values, never exceptions.
- Idempotency: every remote write carries an identity; a retry that finds
  the remote already satisfied returns success.
- Authentication supplied at open, never ambient.
- Scenario coverage for remote write failure, reconciliation divergence,
  rate-limit handling, and credential expiry.

Non-goals:

- Any change to `core/domain/`, `src/execution/`, or the git binding's
  internal modules. The adapter consumes the barrel only (ADR-0009 decision
  7; ADR-0010 decision 1).
- A second persistence store. The binding's ledger and claim store are the
  source of truth; the remote is a projection (ADR-0010 decision 3).
- Release-please compatibility. The baseline's compatibility boundary
  (release-model.md §18) is unchanged.
- Promotion or channel semantics (ADR-0012's `channel-transition` door).
- The per-line lock redesign. The claim store's cross-scope exclusion is
  serial-only under the one-ref mapping (issue #47). The redesign is
  tracked in issue #49 and lands through its own ADR.
- Multiple remotes or non-GitHub providers.
- Ambient `HEAD` or wall-clock time. Every remote operation reads its
  input from the binding's recorded state (ADR-0010 decision 4).

## 2. Shapes

### 2.1 The adapter layer

```text
src/adapters/github/          // the new layer; consumes, never re-owns
  index.ts                    // barrel; the tests' only entry
  <implementation modules>    // the mapping the adapter owns
```

- The layer opens on an already-opened `GitBinding` and credentials —
  plus the caller-injected `GitHubTransport` (ADR-0010 decision 2 as
  amended by #65) — never on an ambient token. It takes no repository
  path from its caller: the repository it transports against is the
  binding's own, read through the binding's seam (§2.7) — the adapter
  layers over the binding's repository, never one chosen independently.
  The transport is injected at open because Node has no synchronous
  HTTPS client and every in-factory improvisation would put the token
  into argv or a temp file; the mechanics are the assembly PR's, under
  the same no-runtime-dependency rule.
- Layering: nothing under `core/domain/` reaches the layer (structural,
  ADR-0001); `src/execution/` does not import it; the package gains no
  runtime dependency (the house rule).
- The isolation gate extends to the layer: the engine's suite runs green
  with the adapter absent, and no engine module names a GitHub concept.

### 2.2 The adapter surface

```typescript
interface GitHubAdapter {
  /** Push the binding's recorded refs (claims, tags) to the remote.
   *  Returns a sync report naming every ref pushed, refused, or skipped
   *  (already satisfied). */
  syncRemote(): SyncReport;

  /** Publish a GitHub Release for the tag the binding minted.
   *  Returns the release URL or a refusal/conflict outcome. */
  publishRelease(tag: string): ReleaseOutcome;

  /** Verify that a remote release matches the binding's recorded
   *  changelog artifact for the given tag. */
  verifyRelease(tag: string): VerificationOutcome;

  /** Discover pre-existing remote state (tags, releases) and compare
   *  against the binding's recorded state. Each listing carries its own
   *  observation outcome; comparison results are claimed only by the
   *  listings that are `listed` (issue #66). */
  reconcile(): ReconciliationReport;
}
```

Every method is synchronous — the adapter may perform network I/O (the
Phase 8 contract's "no network" rule is binding-local; the adapter
deliberately reaches the network) but returns a value, never a promise
or callback, consistent with the binding's synchronous discipline.

`verifyRelease` reports a release that does not exist for the recorded
tag as `absent` (issue #60): absence is a determinate read, never a
`transport-failure` to retry and never a refusal of a write. The
caller's action is the publication itself — `publishRelease`'s create
path is idempotent (§2.4).

`reconcile`'s report claims its comparison only over the listings that
are `listed` (issue #66): each of the two observations — the tag
listing, the release listing — carries its own outcome on the report,
and the comparison's results live only on the `listed` outcome. Both
listings are always requested; one listing's failure never preempts
the other's, and each outcome describes the request the adapter made.
**A listing is the observation of the resource's complete surface**
(issue #68, D32): the adapter follows the listing's pagination — the
response's `Link: <…>; rel="next"` header (RFC 8288) — from the first
page to the provider-declared end, so a remote holding more than one
page of tags or releases is compared in full. A listing that stops
before the surface is complete is an **unobserved** listing (never a
partial comparison): a page that never becomes usable on any link of
the chain — refused, an unexpected status, a body that is not a list, a
lying row — carries `transport-failure` for the whole listing, and the
comparison claims nothing over the pages already read. The `listed`
outcome records the observation's row count (`listed`) and its
completeness (`pagination: "complete" | "truncated"`); only the
adapter's deliberate stop produces `truncated` (none is produced
today), and a truncated listing is never a passed comparison.

- `listed` — the observation is determinate: the comparison over that
  resource ran, and its divergences (and, for tags, its verified tags)
  are claimed. An empty listing is a determinate clean observation —
  absence, not failure (the listing shape's twin of `verifyRelease`'s
  `absent`).
- `refused` — the provider declined the observation, with the reason
  and the refusal detail (decision 9's rate-limit reset timestamp on
  `rate-limited`). A listing's refusal carries only `auth-expired` or
  `rate-limited` — the operator-intervention classes; the write-conflict
  and projection reasons (`release-conflict`, `changelog-unrecorded`,
  `already-pushed-different-target`) name writes and recorded-state
  decisions, and a listing never carries them.
- `transport-failure` — the listing never became a usable observation:
  the remote was unreachable, answered with any other status, returned
  a body that is not a list, or returned a row whose compared field is
  not a string (§2.3's "unexpected response" — a lying listing is
  unobserved, never partially compared).

The shape makes an unobserved listing unrepresentable as a passed
comparison: an unobserved listing carries no divergences and no
verified tags. The caller's obligation is symmetric — a report over an
unobserved listing is inconclusive, not clean, and no caller may read
it as a passed comparison. A listing never returns `ambiguous`: that
class names a write whose landing is unknown, and an observation cannot
have landed unseen.

### 2.3 Failure classes

Every remote operation returns one of:

| Outcome                                                                                                                                  | Meaning                                                       | Caller action                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `ok`                                                                                                                                     | Remote state satisfies the write (created or already matched) | Proceed                                                                    |
| `refused(reason: "already-pushed-different-target" \| "auth-expired" \| "rate-limited" \| "release-conflict" \| "changelog-unrecorded")` | Remote rejected the write with a named reason                 | Operator intervention for auth/rate-limit; conflict is a recorded decision |
| `transport-failure`                                                                                                                      | Remote unreachable or unexpected response                     | Retry                                                                      |
| `ambiguous`                                                                                                                              | Cannot determine whether write landed (timeout)               | Verify through a separate read                                             |

Refusals and conflicts are recorded decisions — the adapter never swallows
a failure and never retries silently past a refusal.

The classes were minted for the write units and the observation channel
reuses them narrowed (issue #66): an observation never returns
`ambiguous`, and a listing's `refused` carries only `auth-expired` and
`rate-limited` — the operator-intervention reasons. (`verifyRelease`
additionally refuses over recorded state — `changelog-unrecorded`,
`release-conflict`; those are comparison decisions, not provider
refusals, and a listing never carries them.) On the report, a listing's
`listed` is the read's `ok` — the comparison's rows; `absent` and
`verified` are the release read's determinate satisfactory outcomes.
The classification itself is one table shared by every unit that reads
the API transport (rate-limit on 429 or a 403 with the budget spent;
auth on 401 or any other 403; status 0 and every other non-200 status
the unit has not pinned a determinate read for — the release read's
404 is `absent` — → `transport-failure`).

### 2.4 Idempotency identity

Every remote write carries an idempotency key derived from the binding's
recorded state:

- Tag push: the tag ref's target commit is the key — pushing the same
  tag to the same target is a no-op.
- Release creation: the tag name + the changelog digest (the artifact's
  `contentDigest` from the binding's generation record) is the key.

The adapter verifies idempotency before write: if the remote already
satisfies the write, the adapter returns `ok` without making a remote
call.

### 2.5 Authentication boundary

```typescript
interface GitHubCredentials {
  readonly token: string; // GitHub API token (classic or fine-grained)
  readonly owner: string; // repository owner
  readonly repo: string; // repository name
}
```

Credentials are supplied at `openGitHubAdapter`, never ambient, never
stored by the adapter beyond the opened instance's lifetime. Token
expiry mid-operation returns `refused(reason: "auth-expired")` — the
adapter does not refresh tokens.

### 2.6 The barrel

```text
src/adapters/github/index.ts   // barrel; the tests' only entry
  export * from "./adapter-types.js";
  export * from "./adapter.js";   // openGitHubAdapter(binding, credentials, transport)
```

The barrel exports the factory — `openGitHubAdapter(binding,
credentials, transport)` per #65 — and the surface types (`GitHubAdapter`,
`GitHubCredentials`, `SyncReport`, `ReleaseOutcome`, `VerificationOutcome`,
`ReconciliationReport` with its per-listing outcome types — issue #66),
and nothing else. Tests import through the barrel
only (ADR-0001 decision 9's shape, extended).

### 2.7 The binding's read seam (#54)

`syncRemote()` and `reconcile()` read the binding's recorded state
(ADR-0010 decisions 3, 10), and the barrel-only rule (§2.1, ADR-0009
decision 8) forbids reaching the binding's internal modules to do it.
The binding's public surface therefore carries the read-only seam the
remote projection reads — proposed in #54, weighing three shapes:

- **The seam on the binding (this amendment).** `GitBinding.repo` (the
  opened configuration's own repository path) and `GitBinding.refs:
RefRead`, the recorded refs' read-only enumeration — `claims()`
  (every claim ref under the binding's claim-ref namespace, each with
  the register blob's oid — D24: a claim ref names a blob,
  nothing to peel; the per-line claim register of ADR-0011) and
  `tags()` (every tag within the configuration's
  declared namespaces — the mint door's namespace rule — each with its
  commit: the peeled commit for an annotated tag, the ref's own target
  for a lightweight one). Pure `for-each-ref` reads: no write, no `HEAD`
  resolution, no working-tree state (the mint door's discipline, read
  side). The adapter's transport-level git (`ls-remote`, `push`) runs
  against exactly this repository — structural, not conventional.
- **Rejected — a remote-operation door on the binding** (`ls-remote` /
  `push` behind `GitBinding`): it would move network I/O and
  credentials into the binding, rewriting ADR-0009 decision 7 ("no API
  calls, no environments") and spanning §2.5's authentication boundary
  across two layers.
- **Rejected — a caller-injected transport runner**: the caller
  supplies the runner the adapter pushes through, leaving the
  object-source bound by wiring convention instead of structure; a
  mismatched wiring pushes the binding's recorded ref names over
  another repository's objects.

§2.7's deferral is decided in §2.8: the changelog/generation lookup is its
own read seam, landed with the Phase 9.3 decision (issue #57).

### 2.8 The changelog seam (#57)

`publishRelease` and `verifyRelease` need the recorded changelog the
idempotency key is built from (§2.4; ADR-0010 decision 6: the attempt's
generation record, ADR-0008's artifact graph). The generation record holds
the artifact triple and `contentFingerprint` — not the bytes — and the
bytes live in the recorded tree the fingerprint names. The seam is reads,
not a body door: the binding's public surface gains `GitBinding.content`
(`ContentRead`), a read-only archive of state it already records:

- `content.claim(ref)` — a claim ref's canonical record (`ClaimRecord`:
  scope, token, holder), the D24 blob's content; enumerable through §2.7
  but not readable until now.
  Amendment proposed in #49 (ADR-0011; the implementation PR follows):
  a claim ref names a per-line register, so the read widens to the set
  the register holds — `content.claims(ref): readonly ClaimRecord[]`
  (an absent ref is the empty array), and the publication unit's
  tag→claim derivation iterates it.
- `content.tagFor(scope)` — the tag name the binding's own naming policy
  derives for a recorded scope: the mint door's derivation made a pure
  read.
- `content.tail(attemptId)` — the attempt's recorded record stream,
  read-only: the ledger's own read path re-exposed without its `append`.
  The adapter holds no writable port.
- `content.file(digest, path)` — one file out of the recorded tree the
  digest names (`git-tree:<oid>` is the binding's own scheme; the binding
  interprets it). Recorded content only — never the working tree, never
  `HEAD`. The tree holding no such path reads as `null` — and only
  git's own absence spelling produces that null (#108; D40): every
  other fault the read can produce, a broken object store behind a live
  tree entry included, propagates.

The adapter derives the projection — it owns the GitHub semantics, the
binding stays generic: the tag → its minting claim (the recorded claim
whose `tagFor(scope)` is the tag) → the holder attempt →
`content.tail(attemptId)` → the completed `artifact:changelog` generation
record → its `contentFingerprint` → `content.file(fingerprint,
"CHANGELOG.md")` as the release body, the fingerprint as §2.4's digest
half.

The tag→attempt linkage is nowhere recorded; it is derived from two
recorded facts — the claim records (`refs/release-craft/claims/*`, D24's
canonical blobs, read through `content.claims` — the per-line
registers of ADR-0011) and the mint door's own
naming derivation (the door mints at the name the claim's scope derives;
`content.tagFor` makes that derivation a pure read). The tag namespace is
global (invariant 6), so the derivation matches at most one claim.

- **Rejected — a caller-supplied body:** the idempotency key becomes
  caller-owned and the adapter can no longer verify what it published
  (§3's law and #57's silent failure).
- **Rejected — a fat changelog door on the binding:** the binding would
  own the adapter's artifact conventions; the derivation stays on the
  adapter.
- The attempt without a completed `artifact:changelog` record, or with
  the file absent from the recorded tree, is `refused(reason:
"changelog-unrecorded")` (§2.3 gains the reason): a release never
  publishes bytes the binding did not record.

## 3. Laws

- **The binding is the truth.** The adapter never writes to the binding,
  never creates claim state, and never modifies the binding's ref namespace.
  Every remote operation reads from the binding; nothing the adapter does
  on the remote feeds back into the binding's recorded state.
  (ADR-0010 decisions 3, 10)
- **Idempotency before write.** Before every remote mutation, the adapter
  checks whether the remote already satisfies the write. A retried write
  that already landed returns `ok`. (ADR-0010 decision 4)
- **No silent divergence.** Pre-existing remote state that does not match
  the binding's recorded state is reported as divergence, never silently
  resolved. (ADR-0010 decision 8)
- **Failures are values.** Every remote operation returns a discriminated
  union. No exception crosses the adapter's public surface.
  (ADR-0010 decision 7)
- **No ambient credentials.** Authentication is supplied at open and never
  refreshed. (ADR-0010 decision 2)
- **No ambient HEAD or wall-clock.** The adapter reads its input from the
  binding's recorded state — never from the working tree, `HEAD`, or the
  system clock. (ADR-0010 decision 4)

## 4. Test obligations

All adapter tests import through `src/adapters/github/index.js` only
(barrel-only). The git binding's tests remain the binding's own. Engine
tests never import the adapter. The one deliberate exception, landed in
the 9.5 assembly (#65): the failure classifier's stderr-to-refusal pins
(§4 scenarios 8–9, the git-transport half) live in a white-box suite that
imports `classifyGitFailure` directly — no public outcome can reach the
rate-limit or auth-expired phrases hermetically, since they arrive in
GitHub's own sideband or through a credential negotiation a local server
cannot reproduce determinately; the hermetically reachable public paths
(§4 scenario 7's transport failure through `syncRemote()`, §4 scenario
13's ambiguous through `publishRelease()`) stay pinned through the
public doors. The
suite declares the exception in its header.

The phase's named scenarios:

1. **Remote ref push** — the adapter pushes the binding's minted tag and
   claim refs to a remote; the remote has the expected refs at the expected
   targets; a retry returns `ok`.
2. **Idempotent retry** — after a successful push, the same push retries
   and returns `ok` without making a remote call.
3. **Remote already has tag at different target** — the adapter refuses
   with `refused(reason: "already-pushed-different-target")`.
4. **GitHub Release creation** — the adapter creates a release for a
   pushed tag; the release body matches the binding's recorded changelog.
5. **Idempotent release creation** — after a successful release creation,
   the same creation retries and returns `ok` (verifies match).
6. **Release conflict** — the remote has a release for the tag with a
   different body; the adapter returns `refused(reason: "release-conflict")`.
7. **Transport failure** — the remote is unreachable; the adapter returns
   `transport-failure`; the caller may retry.
8. **Rate-limit refusal** — the GitHub API returns a rate-limit response;
   the adapter returns `refused(reason: "rate-limited")` with the reset
   timestamp.
9. **Auth expiry** — the credential is invalid or expired; the adapter
   returns `refused(reason: "auth-expired")`.
10. **Reconciliation — clean** — the remote has the same tags and releases
    the binding recorded; the reconciliation report shows no divergence.
11. **Reconciliation — unadopted remote tag** — the remote has a tag the
    binding has no record of; the report lists it as `unadopted`.
12. **Reconciliation — unadopted remote release** — the remote has a
    release for a tag the binding has no record of; the report lists it.
13. **Ambiguous outcome** — a timeout returns `ambiguous`; the caller
    must verify through a separate read.
14. **Isolation** — the engine suite runs green with the adapter absent;
    no engine module imports the adapter (the isolation gate's new layer);
    the adapter suite never imports engine internals beyond the barrel.
15. **Reconciliation — unobserved listing** (issue #66) — a listing that
    never became a usable observation (unreachable remote, any other
    non-200 status, a body that is not a list, a row whose compared
    field is not a string); the report carries `transport-failure` for
    that listing and claims no comparison over it — no divergence, no
    verified tag.
16. **Reconciliation — refused listing** (issue #66) — a rate-limit or
    auth failure on a listing; the report carries `refused` with the
    reason and the refusal detail for that listing (decision 9's reset
    timestamp on `rate-limited`) and claims no comparison over it. Both
    listings are always requested: a refused or failed listing never
    preempts its sibling, and each outcome stands on its own.
17. **Reconciliation — truncated listing** (issue #68, D32) — a listing
    that exceeds one page is followed across its pagination (the
    response's `Link: rel="next"` headers) to the provider-declared end;
    a page that never becomes usable on any page of the chain — refused,
    an unexpected status, a body that is not a list, a lying row — makes
    the **whole** listing `transport-failure`, never a partial
    comparison, and the report claims nothing over the truncated surface.
    The `listed` outcome carries `listed` (the row count) and
    `pagination` (completeness); a truncated listing is never a passed
    comparison.
