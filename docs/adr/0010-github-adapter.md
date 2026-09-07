---
id: "0010"
title: "The GitHub adapter — remote synchronization, tag publication, and release publication"
status: Proposed
implements: "https://github.com/ecoma-io/release-craft/issues/50"
created: 2026-09-07
updated: 2026-09-07
---

# ADR-0010: The GitHub adapter — remote synchronization, tag publication, and release publication

## Context

The git binding (Phase 8, ADR-0009) provides local persistence over a
repository — the ledger, the attempt register, the claim store, the tag
door, and the artifact producer — all synchronous, all local to the
repository path the binding is opened on. The binding deliberately owns no
provider behavior: "no API calls, no environments, no registry interactions,
no scheduling — the GitHub adapter (Phase 9) consumes this binding and stays
its own phase, its own ADR" (ADR-0009 decision 7).

What the binding does not do — and what Phase 9 must — is the remote half:

- **Remote synchronization**: pushing the binding's recorded state (ledger
  tail, attempt ordinals, claim records) to a remote so that another
  instance or a human can observe the same history.
- **Tag publication**: pushing the binding's minted tags to the remote so
  that the authoritative tag record (P-01's "tags are the authoritative
  record") is visible on GitHub.
- **GitHub Release creation**: creating and verifying GitHub Releases
  corresponding to published tags, as the human-facing publication surface.
- **E2E reconciliation**: discovering pre-existing remote state (tags,
  releases) and reconciling it with the local binding's recorded state.

The adapter must not become a second persistence store. The binding's
ledger and claim store are the source of truth; the remote is a projection.
No remote write creates a durable decision that the binding cannot verify
from its own recorded state. Idempotency is required: a retried remote
write must not create duplicates.

## Decision

1. **The GitHub adapter is a new layer under `src/adapters/github/`,
   consuming the git binding's barrel only.** The adapter imports from
   `../git/index.js` (the binding's barrel — ADR-0009 decision 8) and
   never from the binding's internal modules, `src/execution/`, or
   `core/domain/`. The adapter's own barrel (`src/adapters/github/index.ts`)
   exports only the opened adapter factory and the types the assembly needs.
   No runtime dependency enters (the house rule).

2. **The adapter opens on a `GitBinding` and a credential, not on a
   repository path.** The factory is `openGitHubAdapter(binding: GitBinding,
credentials: GitHubCredentials): GitHubAdapter`. The binding is already
   opened on its repository; the adapter adds the remote layer over the
   same binding. Credentials (token or app installation) are supplied at
   open, never ambient, never stored by the adapter — the caller retains
   lifecycle control.

3. **Remote synchronization is push-only for writes, fetch-only for
   discovery.** The adapter pushes refs (the binding's claim refs under
   `refs/ecoma/`, minted tags under `refs/tags/`) to the configured remote
   (`origin` by default). It never fetches remote state into the local
   binding's claim or ledger namespace — the binding is the source of truth,
   and a fetch that introduces unverified claim refs would break that
   invariant. Discovery (pre-existing tags and releases) reads the remote
   through the API and compares against the binding's recorded state, never
   merging remote refs into the local namespace.

4. **Every remote write carries an idempotency identity.** Tag pushes and
   GitHub Release creations include the attempt's `attemptId` or the
   claim's `token` as an idempotency key. A retried write that has already
   landed on the remote returns success (the remote state matches) rather
   than error or duplicate. Idempotency is verified before write: the
   adapter checks whether the remote already satisfies the write before
   attempting it.

5. **Tag publication is a push of the binding's minted tag ref to the
   remote.** The adapter reads the tag ref the binding's mint door created
   (`refs/tags/<tag>`, a lightweight tag pointing to the recorded base),
   and pushes it to the remote. No tag is invented by the adapter — it
   pushes only what the binding recorded. If the remote already has the
   tag at the same target, the push is a no-op (idempotent). If the remote
   has the tag at a different target, the push is refused — the adapter
   records a `conflict` outcome and does not overwrite.

6. **GitHub Release creation is a separate step after tag publication.**
   The adapter creates a GitHub Release for the pushed tag, with body
   sourced from the binding's recorded changelog artifact (the attempt's
   generation record — ADR-0008's artifact graph). If the release already
   exists for that tag (idempotency check), the adapter verifies that the
   existing release's body matches the recorded changelog and reports
   `verified` or `conflict`. Release creation is not a substitute for the
   binding's recorded state — it is a human-facing projection.

7. **Failure classes are returned values, never exceptions.** Every remote
   operation returns a discriminated union:
   - `ok` — the remote state now satisfies the write (created or already
     satisfied).
   - `refused` — the remote refused the write with a reason
     (`already-pushed-different-target`, `auth-expired`, `rate-limited`,
     `release-conflict`).
   - `transport-failure` — the remote was unreachable or returned an
     unexpected response; the caller may retry.
   - `ambiguous` — the adapter cannot determine whether the write landed
     (e.g., timeout with no response); the caller must verify through a
     separate read.

8. **Pre-existing remote state is discovered at open time and reconciled
   with the binding's recorded state.** On `openGitHubAdapter`, the adapter
   lists the remote's tags (via `git ls-remote` or the API) and GitHub
   Releases (via the API), compares them against the binding's recorded
   claim records and tag refs, and reports any divergence:
   - Tags the remote has but the binding has no record of → `unadopted`
     (the adapter does not import them as claims; they are noted for
     human review).
   - Releases the remote has for tags the binding has minted → `verified`.
   - Releases the remote has for tags the binding has no record of →
     `unadopted`.
     Divergence is reported, never silently resolved. The adapter never
     writes to the binding based on remote discovery — the binding is the
     truth, the remote is checked against it.

9. **Rate-limit and provider-failure semantics are documented, not
   silently swallowed.** If a GitHub API call returns a rate-limit
   response, the adapter returns `refused(reason: "rate-limited")` with
   the reset timestamp. The caller (the execution engine or operator)
   decides whether to retry. If the adapter's credential expires mid-
   operation, the adapter returns `refused(reason: "auth-expired")` and
   does not retry — the caller must supply a fresh credential.

10. **The adapter owns no second claim or ledger state.** Every remote
    write is driven by the binding's recorded state. The adapter reads
    the binding to determine what to push, creates nothing on the
    binding, and never writes to the binding's ref namespace. The
    binding's one-ref mapping (ADR-0009 decision 4) is unchanged.

## Amendments this ADR makes (loud, in this PR)

- [decision-log.md](../design/decision-log.md): D25 records the decision
  set above.
- [matrix-coverage.md](../design/matrix-coverage.md): the Phase 9 rows
  (remote synchronization, tag publication, GitHub Release, E2E
  reconciliation) are assigned.
- [phase8-git-binding-contract.md](../design/phase8-git-binding-contract.md):
  §1's non-goals reference is updated — "the GitHub adapter (Phase 9,
  ADR-0010)" — to point to this ADR.

## Non-decisions (explicitly out of scope)

- **Release-please compatibility.** The adapter does not implement
  release-please's GitHub Release format, body template, or lifecycle.
  The baseline's release-please compatibility boundary
  ([release-model.md §18](../design/release-model.md#release-please-compatibility-boundary))
  is unchanged.
- **Promotion or channel semantics.** PR-04's door (channels, promotion)
  is not implemented here — the adapter pushes and creates releases for
  the binding's recorded state only.
- **The per-line lock redesign.** The claim store's cross-scope exclusion
  is serial-only under the one-ref mapping (issue #47). The per-line lock
  redesign is tracked in issue #49 and lands through its own ADR, not
  this one.
- **Multiple remotes.** The adapter pushes to one configured remote
  (`origin` by default). Multi-remote support is not designed.
- **Non-GitHub remotes.** The adapter is GitHub-specific. A generic
  `RemoteAdapter` port is not designed — if another provider is needed,
  its contract is a separate ADR.
