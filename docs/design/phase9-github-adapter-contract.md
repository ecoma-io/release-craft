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
- Promotion or channel semantics (PR-04's door).
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

- The layer opens on an already-opened `GitBinding` (ADR-0009's
  `openGitBinding`) and a credential value, never on an ambient token
  (ADR-0010 decision 2). It takes no repository path from its caller
  either: the repository it transports against is the binding's own,
  read through the binding's seam (§2.7) — the adapter layers over the
  binding's repository, never one chosen independently. (#54 proposes
  this amendment: the bullet first barred the repository path outright,
  which left ADR-0010 decision 10's read unimplementable through the
  barrel-only rule.)
- Layering: nothing under `core/domain/` reaches the layer (structural,
  ADR-0001); `src/execution/` does not import it; the package gains no
  runtime dependency (the house rule — how the adapter calls the GitHub
  API is the implementation PR's choice under that rule).
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
   *  against the binding's recorded state. Returns any divergence. */
  reconcile(): ReconciliationReport;
}
```

Every method is synchronous — the adapter may perform network I/O (the
Phase 8 contract's "no network" rule is binding-local; the adapter
deliberately reaches the network) but returns a value, never a promise
or callback, consistent with the binding's synchronous discipline.

### 2.3 Failure classes

Every remote operation returns one of:

| Outcome                                            | Meaning                                                       | Caller action                  |
| -------------------------------------------------- | ------------------------------------------------------------- | ------------------------------ |
| `ok`                                               | Remote state satisfies the write (created or already matched) | Proceed                        |
| `refused(reason: "already-pushed-different-target" | "auth-expired"                                                | "rate-limited"                 | "release-conflict")` | Remote rejected the write with a named reason | Operator intervention for auth/rate-limit; conflict is a recorded decision |
| `transport-failure`                                | Remote unreachable or unexpected response                     | Retry                          |
| `ambiguous`                                        | Cannot determine whether write landed (timeout)               | Verify through a separate read |

Refusals and conflicts are recorded decisions — the adapter never swallows
a failure and never retries silently past a refusal.

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
  export * from "./adapter.js";
```

The barrel re-exports the adapter factory, the surface types (`GitHubAdapter`,
`GitHubCredentials`, `SyncReport`, `ReleaseOutcome`, `VerificationOutcome`,
`ReconciliationReport`), and nothing else. Tests import through the barrel
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
  the canonical record's blob oid — D24: a claim ref names a blob,
  nothing to peel) and `tags()` (every tag within the configuration's
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

`repo` crosses to the adapter as read-only configuration data — no
credential, no network, no environment enters the binding (ADR-0009
decision 7 stands). The changelog/generation lookup that
`publishRelease`/`verifyRelease` will need is NOT part of this seam; it
gets its own decision when Phase 9.3 starts.

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
tests never import the adapter.

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
