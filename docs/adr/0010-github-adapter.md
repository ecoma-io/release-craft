---
id: 0010-github-adapter
status: proposed
created: 2026-09-07
updated: 2026-09-11
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
  that the authoritative tag record (ADR-0009 decision 4's tag door; D34)
  is visible on GitHub.
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
   Amendment proposed in #54 (phase 9.2): the binding's public surface
   gains the read-only remote-projection seam — `GitBinding.repo` (its
   own opened path) and `GitBinding.refs` (`RefRead`, the recorded
   claims and declared-namespace tags with the objects they name — the
   claims' canonical-record blobs, the tags' commits (peeled for
   annotated tags); the Phase 9
   contract §2.7). The law is unchanged: the factory still opens on a
   binding and a credential — the repository the adapter transports
   against is the binding's own, never a caller-supplied path or an
   ambient token.
   Amendment landed in #65 (phase 9.5): the factory is
   `openGitHubAdapter(binding, credentials, transport: GitHubTransport)` —
   the caller injects the HTTP transport at open, alongside the
   credentials. The API-path units (publication, reconciliation) consume
   the injected transport; the git-path unit (remote synchronization)
   never does. The injection is forced by the platform, not taste: Node
   has no synchronous HTTPS client, and every improvisation inside the
   factory (spawning `curl` with the token in argv, or a token-bearing
   temp file) breaks the credential discipline — the token would leave
   the process — or the sync discipline (§2.2, the units' synchronous
   shape). Injection at the composition root keeps the token's lifecycle
   entirely with the caller, like the credentials themselves.
   Amendment for #177 (D55): the factory owns the open-time identity
   agreement — before any door exists it reads the binding's origin the
   way the sync transports it (`git remote get-url origin`, the
   effective URL) and refuses to open (`GitFaultError`, naming both
   identities) unless the origin and the credentials name the same
   repository (the Phase 9 contract §2.9). The composition root is the
   one point every door crosses: a credential for a fork must never
   reach a factory that would sync to one repository and publish to
   another. A repository with no origin configured opens — one
   identity, no agreement to break — and the sync's own environmental
   fault stands at use time.

3. **Remote synchronization is push-only for writes, fetch-only for
   discovery.** The adapter pushes refs (the binding's claim refs under
   `refs/release-craft/`, minted tags under `refs/tags/`) to the configured
   remote (`origin` by default). It never fetches remote state into the local
   binding's claim or ledger namespace — the binding is the source of truth,
   and a fetch that introduces unverified claim refs would break that
   invariant. Discovery (pre-existing tags and releases) reads the remote
   through the API and compares against the binding's recorded state, never
   merging remote refs into the local namespace. Revised in #133: the
   binding's namespace is `refs/release-craft/` (product-neutral, invariant
   2.12) — the mapping's shape is unchanged.
   The never-fetch clause's scope consequence, recorded in #182: the
   binding itself never fetches `refs/release-craft/*` into a checkout —
   that is this decision's own hand, and the clause above stands — while
   which refs a checkout holds is also its caller's posture (a standard
   clone fetches only `refs/heads/*` and `refs/tags/*`; a caller may fetch
   the claim namespace itself, and the self-release caller does —
   decision-log D65). Where no caller fetch joins the checkouts onto the
   namespace — the bare-clone shape the negative capability test pins —
   the claim exclusion the binding enforces holds within one repository's
   ref space and exactly that far: two runs of one line in two separate
   checkouts each acquire, both mint, and the divergence surfaces at the
   consumer's push as a non-fast-forward rejection outside the engine's
   verdict vocabulary. A caller-side fetch changes which refs the writers
   share, never the exclusion's reach. ADR-0011 decision 2 records the
   declared scope; the GitHub Action's posture (phase 13 §2.9) states the
   precondition and the failure mode it inherits from this decision.
   Amendment for #177 (D55): the configured remote and the API doors'
   addressee are one repository by construction, not by convention —
   the open-time identity agreement (decision 2's amendment; the Phase
   9 contract §2.9) parses the origin by git's own URL grammar (the
   "GIT URLS" section of git's `Documentation/urls.adoc`: the URL
   forms, the scp-like form with its no-slash-before-the-first-colon
   recognition rule, the local forms) and opens only when it names the
   credentials' `owner/repo` on github.com — the credential shape
   carries no host, so any other host names a repository no expressible
   credential can be the same as. Push and discover therefore always
   address the repository the credentials were issued for; an origin
   that cannot be proven to name it refuses the open, never a door.

4. **Every remote write carries an idempotency identity derived from the
   binding's recorded state (the Phase 9 contract §2.4).** A tag push's
   key is the tag ref's target commit — pushing the same tag to the same
   target is a no-op — and a release creation's key is the tag name plus
   the recorded changelog digest (the generation record's
   `contentFingerprint`, contract §2.8). A retried write that has already
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
   Amendment proposed in #57 (phase 9.3): the release body is resolved
   from recorded state only, through the binding's changelog seam —
   `GitBinding.content` (`ContentRead`: `claim(ref)`, `tagFor(scope)`,
   `tail(attemptId)` read-only, `file(digest, path)`; the Phase 9
   contract §2.8): tag → minting claim → holder attempt → the attempt's
   recorded stream → the completed `artifact:changelog` generation record
   → `contentFingerprint` → the recorded tree's `CHANGELOG.md`. The
   adapter holds no writable port — the ledger's `append` never crosses
   the seam. The attempt without a completed changelog record, or with
   the file absent from the recorded tree, is `refused(reason:
  "changelog-unrecorded")` — a release never publishes bytes the binding
   did not record.
   Amendment proposed in #60 (phase 9.3): `verifyRelease` reports a
   release that does not exist for the recorded tag as `absent` — a
   determinate read, never a retryable transport failure and never a
   refusal of a write; the caller's action is the publication itself (the
   create path is idempotent).
   Amendment for #176 (D50): the `absent` verdict is discriminated
   before it is claimed — a release read's 404 also answers a repository
   the credential cannot observe (GitHub answers 404, not 403, for
   resources invisible to the caller), so the 404 read probes the
   repository itself (`GET /repos/{owner}/{repo}`): an observable
   repository makes the absence determinate; an unobservable one is
   `refused(reason: "unobservable-remote")`. The probe is the absence
   claim's discriminator alone — the create path pays no probe, and the
   create's own 404 is the same unobservable refusal (a determinate
   non-land, never a retryable failure).

7. **Failure classes are returned values, never exceptions.** Every remote
   operation returns a discriminated union:
   - `ok` — the remote state now satisfies the write (created or already
     satisfied).
   - `refused` — the remote refused the write with a reason
     (`already-pushed-different-target`, `auth-expired`, `rate-limited`,
     `release-conflict`, `changelog-unrecorded`).
   - `transport-failure` — the remote was unreachable or returned an
     unexpected response; the caller may retry.
   - `ambiguous` — the adapter cannot determine whether the write landed
     (e.g., timeout with no response); the caller must verify through a
     separate read.
     Amendment proposed in #66 (the implementation PR follows): the
     observation channel returns narrowed versions of the same classes.
     An observation never returns `ambiguous` — that class names a write
     whose landing is unknown, and a read cannot have landed unseen —
     and a listing's `refused` carries only `auth-expired` or
     `rate-limited`, the operator-intervention reasons (`verifyRelease`'s
     `changelog-unrecorded` and `release-conflict` refusals are
     comparison decisions over recorded state, not provider refusals; a
     listing never carries them). An observation that never became
     usable (unreachable, unexpected status, a body that is not a list,
     a compared field that is not a string) is `transport-failure` —
     never a thrown exception and never an empty listing, which would
     read as a clean observation.
     Amendment for #178 (D51): the operator-intervention reasons are
     `auth-expired`, `rate-limited`, `permission-denied`, and
     `unobservable-remote` — a 403 whose credential authenticated is
     the permission denial, never an expired credential, and a
     repo-scoped listing's 404 is the unobservable remote (#176),
     never a retryable failure.
     Amendment for #179 (D53): the law is enforced, not remembered —
     every `transport.request` call crosses one guarded boundary
     (`response.ts`'s `guardedRequest`) that converts a throwing
     transport into the status-0 response, whose reading is the
     existing classification (`transport-failure` on a read; §2.3's
     `ambiguous` window on a write whose response is lost mid-call —
     nothing the door can observe separates a thrown transport from a
     lost connection), and a conformance suite drives a hostile
     transport against every door to pin the no-escape shape.

8. **Pre-existing remote state is discovered through `reconcile()` and
   reconciled with the binding's recorded state.** Through the
   `reconcile()` door (the wording repaired from "at open time" by
   #179/D53 — the factory opens the doors; nothing reconciles at open
   time), the adapter lists the remote's tags (via `git ls-remote` or
   the API) and GitHub Releases (via the API), compares them against
   the binding's recorded claim records and tag refs, and reports any
   divergence:
   - Tags the remote has but the binding has no record of → `unadopted`
     (the adapter does not import them as claims; they are noted for
     human review).
   - Releases the remote has for tags the binding has minted → `verified`.
   - Releases the remote has for tags the binding has no record of →
     `unadopted`.
     Divergence is reported, never silently resolved. The adapter never
     writes to the binding based on remote discovery — the binding is the
     truth, the remote is checked against it.
     Amendment proposed in #66 (the implementation PR follows): the
     report claims its comparison only over the listings that are
     `listed` — each listing carries its own observation outcome
     (`listed`, `refused` with the operator-intervention reason and the
     refusal detail, `transport-failure`), and divergences and verified
     tags exist only on `listed`. Both listings are always requested; a
     failed listing never preempts its sibling. A report over an
     unobserved listing is inconclusive, never clean: over an unobserved
     remote, a comparison that never ran is unrepresentable as a passed
     one.
     Amendment proposed in #68 (D32, the implementation PR follows): the
     listing is the observation of the resource's **complete** surface —
     the adapter follows the listing's pagination (the response's
     `Link: <…>; rel="next"` header, RFC 8288) from the first page to
     the provider-declared end, so a remote past one page of tags or
     releases is compared in full. A listing that stops before the
     surface is complete is an unobserved listing: a page that never
     becomes usable on any link of the chain carries `transport-failure`
     for the whole listing, never a partial comparison over the pages
     already read. The `listed` outcome records the observation's row
     count (`listed`) and completeness (`pagination: "complete" |
"truncated"`); a truncated listing is never a passed comparison.
     Amendment for #179 (D53): the walk's honesty is completed in both
     directions. `complete` is claimed from **evidence** the chain
     ended — the requested page size is the most any page returns, so a
     final page under it with no `next` declared is the end's only
     observable proof — never from the header's absence, which a
     stripped `Link` header forges; the ambiguous case (a full-size
     final page, no `next`) reads `pagination: "truncated"`, an honest
     partial observation over the rows observed: the truncated listing
     claims the comparison its rows really earned, never a passed
     observation and never a discarded one (amending D32's
     fail-closed reading, which discarded the observed rows' real
     divergences and hid the ambiguity behind `transport-failure`;
     D32's unusable-page rule is unchanged). A chain with no honest end
     — a `next` target the walk already requested (a cycle), or a
     declared next whose target is no requestable API-relative path —
     faults the whole listing `transport-failure`: loud within the
     no-throw law, never a hang, never a silent stop that reads as the
     end, never a blind follow.

9. **Rate-limit and provider-failure semantics are documented, not
   silently swallowed.** If a GitHub API call returns a rate-limit
   response, the adapter returns `refused(reason: "rate-limited")` with
   the reset timestamp. The caller (the execution engine or operator)
   decides whether to retry. If the adapter's credential expires mid-
   operation, the adapter returns `refused(reason: "auth-expired")` and
   does not retry — the caller must supply a fresh credential.
   Amendment for #176/#178 (D50, D51): the semantics extend to the
   shapes the collapse had folded into those two classes — a secondary
   rate limit (a 403 with `Retry-After`, the primary budget standing)
   is the same `rate-limited` refusal with the `Retry-After` detail; a
   403 whose credential authenticated is
   `refused(reason: "permission-denied")` — grant the scope, rotating
   the token fixes nothing; a repo-level 404 is
   `refused(reason: "unobservable-remote")` — an observation that never
   happened, never a determinate absence and never a retryable failure
   (decision 6's probe amendment); and the create's determinate
   refusals (422 `already_exists`, 409) are
   `refused(reason: "release-conflict")` with the provider's own words,
   never the retryable class — a caller honouring
   "transport-failure is retryable" must never loop on a permanent
   refusal.

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
- **Promotion or channel semantics.** The channel-transition door
  (ADR-0012) is not implemented here — the adapter pushes and creates
  releases for the binding's recorded state only.
- **The per-line lock redesign.** The claim store's cross-scope exclusion
  is serial-only under the one-ref mapping (issue #47). The per-line lock
  redesign is tracked in issue #49 and lands through its own ADR, not
  this one.
- **Multiple remotes.** The adapter pushes to one configured remote
  (`origin` by default). Multi-remote support is not designed.
- **Non-GitHub remotes.** The adapter is GitHub-specific. A generic
  `RemoteAdapter` port is not designed — if another provider is needed,
  its contract is a separate ADR.
