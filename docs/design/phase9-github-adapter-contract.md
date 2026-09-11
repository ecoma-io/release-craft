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
path is idempotent (§2.4). A release read's 404 alone does not carry
that verdict (issue #176): the same 404 answers a repository the
credential cannot observe — a private or missing repository, a moved
one, a token without read scope (GitHub answers 404, not 403, for
resources invisible to the caller). The verdict is discriminated
before it is claimed: the 404 read probes the repository itself
(`GET /repos/{owner}/{repo}`), and only an observable repository makes
the absence determinate — over an unobservable one the probe's own
refusal (`unobservable-remote` on its 404, `auth-expired` on a rejected
credential, `permission-denied` on a denial 403, the rate-limit shapes
`rate-limited`, the rest `transport-failure` — the one shared table)
stands, and the caller's action is the credential/owner/repo review. The probe is the absence claim's
discriminator alone: `publishRelease` pays no probe — its create path
never claims absence, and the create's own 404 answers the
unobservable repository determinately (below).

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
completeness (`pagination: "complete" | "truncated"`).
Amendment for #179 (D53): `complete` is claimed from **evidence** the
chain ended, never from a header's absence — the requested page size is
the most any page returns, so a final page under it with no `next`
declared is the end's only observable proof. A final page at full size
with no `next` is ambiguous (the pagination reference: "if all results
fit on a single page, the link header will be omitted" — byte-identical
to a transport or proxy stripping the header), so it reads `truncated`:
an honest partial observation that still claims the comparison its rows
really earned, its `pagination` denying the clean-bill reading over the
rows it never saw — the truncated listing is never a passed
observation, and never a discarded one either. Two readings are declared
permanent (D53; round-1 review minor 2): a row count that is an exact
multiple of the page size ends on a full page with no `next` on **every**
reconciliation and reads `truncated` each time — the honest label, and
one nothing retries on; a page returning **more** than the requested size
also reads `truncated`, the conservative direction. Two chain shapes have no
honest end and fault the whole listing `transport-failure` — the
fail-closed class, the loudest signal the no-throw law leaves: a `next`
target the walk already requested (a cycle — the walk must never hang),
and a declared `next` whose target is no requestable API-relative path
(the header says more pages follow; a blind follow is the request-error
shape).

- `listed` — the observation is determinate: the comparison over that
  resource ran, and its divergences (and, for tags, its verified tags)
  are claimed. An empty listing is a determinate clean observation —
  absence, not failure (the listing shape's twin of `verifyRelease`'s
  `absent`).
- `refused` — the provider declined the observation, with the reason
  and the refusal detail (decision 9's rate-limit reset timestamp on
  `rate-limited`). A listing's refusal carries only the
  operator-intervention reasons — `auth-expired`, `rate-limited`,
  `permission-denied`, and `unobservable-remote` (the widening of
  issues #176/#178: a 403 whose credential authenticated is the
  permission denial, and a repo-scoped listing's 404 is the repository's
  invisibility — the collection exists whenever the repository is
  observable); the write-conflict and projection reasons
  (`release-conflict`, `changelog-unrecorded`,
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

| Outcome                                                                                                                                                                                  | Meaning                                                       | Caller action                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ok`                                                                                                                                                                                     | Remote state satisfies the write (created or already matched) | Proceed                                                                                            |
| `refused(reason: "already-pushed-different-target" \| "auth-expired" \| "rate-limited" \| "permission-denied" \| "unobservable-remote" \| "release-conflict" \| "changelog-unrecorded")` | Remote rejected the write with a named reason                 | Operator intervention for auth/rate-limit/permission/unobservable; conflict is a recorded decision |
| `transport-failure`                                                                                                                                                                      | Remote unreachable or unexpected response                     | Retry                                                                                              |
| `ambiguous`                                                                                                                                                                              | Cannot determine whether write landed (timeout)               | Verify through a separate read                                                                     |

Refusals and conflicts are recorded decisions — the adapter never swallows
a failure and never retries silently past a refusal. Refused vs
`transport-failure` is the load-bearing boundary (issues #178): a
refusal is determinate and non-retryable — retrying it repeats it; the
transport failure is the one retryable class. The refusal reasons split
the operator's interventions: `auth-expired` — the credential itself
was rejected, rotate it; `permission-denied` (issue #178) — the
credential authenticated and the request is not authorized (the
fine-grained-token "resource not accessible" answer, the git path's
"Permission to `<repo>` denied to `<user>`"), grant the scope, rotating
fixes nothing; `rate-limited` — the primary or the secondary limit,
wait; `unobservable-remote` (issue #176) — the resource is invisible to
this credential (a private or missing repository, a token without read
scope), review the credential and the owner/repo.

The no-throw law is enforced, not remembered (issue #179, D53): every
`transport.request` call crosses one guarded boundary
(`response.ts`'s `guardedRequest`) that converts a throwing transport
into the status-0 response — a read's status 0 classifies
`transport-failure` through the one table; a write whose response is
lost mid-call (a throw is indistinguishable from a lost connection) is
the `ambiguous` window — and conformance tests drive a hostile
transport against every door.

The classes were minted for the write units and the observation channel
reuses them narrowed (issue #66): an observation never returns
`ambiguous`, and a listing's `refused` carries only the
operator-intervention reasons (`auth-expired`, `rate-limited`,
`permission-denied`, `unobservable-remote`). (`verifyRelease`
additionally refuses over recorded state — `changelog-unrecorded`,
`release-conflict`; those are comparison decisions, not provider
refusals, and a listing never carries them.) On the report, a listing's
`listed` is the read's `ok` — the comparison's rows; `absent` and
`verified` are the release read's determinate satisfactory outcomes.

The classification itself is one table shared by every unit that reads
the API transport (issues #176/#178; the shapes GitHub answers with):

| Response shape                                                                                      | Class                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `429`; a 403 with `x-ratelimit-remaining: 0`                                                        | `refused("rate-limited")` — the primary limit; the detail carries `x-ratelimit-reset` (decision 9)                                                                                                                                                                                                                                                     |
| a 403 with `Retry-After`, or whose message names the secondary/abuse limit, and the budget standing | `refused("rate-limited")` — the secondary limit (issue #178); the detail carries `Retry-After`, or the wait-at-least-one-minute guidance when the header is absent                                                                                                                                                                                     |
| 404 on a repo-scoped listing; the create's 404                                                      | `refused("unobservable-remote")` (issue #176) — a listing's collection and a create's target exist whenever the repository is observable                                                                                                                                                                                                               |
| the release read's 404                                                                              | the repository probe (§2.2): probe `200` → `absent`; otherwise the probe's own class                                                                                                                                                                                                                                                                   |
| `401`                                                                                               | `refused("auth-expired")`                                                                                                                                                                                                                                                                                                                              |
| any other 403                                                                                       | `refused("permission-denied")` (issue #178) — the credential authenticated; the detail carries the provider's `message`                                                                                                                                                                                                                                |
| status `0`                                                                                          | reads → `transport-failure`; the post-write window → `ambiguous`                                                                                                                                                                                                                                                                                       |
| the create's `422` / `409`                                                                          | `refused("release-conflict")` (issue #178) — a determinate refusal, never the retryable class; `already_exists` (the duplicate-create answer observed on the wire — the reference page documents the endpoint's 422 only as "Validation failed, or the endpoint has been spammed" — the benign race-loss) and the provider's `message` ride the detail |
| every other non-200 status (5xx included)                                                           | `transport-failure` — the retryable class                                                                                                                                                                                                                                                                                                              |

The git-path half (the sync unit's stderr classification) anchors on
the same vocabulary, structured: the rate-limit phrases first; GitHub's
valid-credential push denial ("Permission to `<repo>` denied to
`<user>`") and the http transport's structured 403 ("The requested URL
returned error: 403", "HTTP 403") → `permission-denied`; the
rejected-credential phrases and the structured 401 → `auth-expired`.
Statuses classify only where git prints them structurally — a bare
status substring in git's progress lines ("Total 403 (delta 0)") is
bytes moved, not a status, and classifies nothing (issue #178).

A named residual (the round-1 review of this slice, issue #176): the
table's 404 branch applies to any page of a listing's pagination walk,
so a mid-chain 404 — page two or later, after an observable page one —
reads `unobservable-remote` although page one proved the repository
observable. GitHub-issued `next` links make the shape unlikely, and the
class stays the safe reading (operator intervention over the
repository's visibility); it is recorded here rather than narrowed
away.

### 2.4 Idempotency identity

Every remote write carries an idempotency key derived from the binding's
recorded state:

- Tag push: the tag ref's target commit is the key — pushing the same
  tag to the same target is a no-op.
- Release creation: the tag name + the changelog digest (the binding's
  generation record holds it as `contentFingerprint`, §2.8) is the key.

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
adapter does not refresh tokens. The shape is closed — token, owner,
repo, no host — so the only repository an expressible credential
addresses is a path on github.com; that closed shape is what the
open-time identity agreement (§2.9) compares the binding's origin
against.

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
  the register ref's tip commit — under the per-line claim register of
  ADR-0011 the register grows one commit per mutation and its envelope
  blob rides that commit's tree, so the ref names a commit, not the
  blob; the D24-era "names a blob" wording described the superseded
  per-scope mapping and is corrected here, #184) and
  `tags()` (every tag within the configuration's
  declared namespaces — the mint door's namespace rule — each with its
  commit: the peeled commit for an annotated tag, the ref's own target
  for a lightweight one). Pure `for-each-ref` reads: no write, no `HEAD`
  resolution, no working-tree state (the mint door's discipline, read
  side). The adapter's transport-level git (`ls-remote`, `push`) runs
  against exactly this repository — structural, not conventional —
  through its own transport runner (`remote-git.ts`), which carries no
  substrate probe, deliberately: `ls-remote` and `push` perform no
  recorded-history walks and no recorded-content reads — the operations
  the guard exists for — and git fails loudly, in its own transport
  vocabulary, on a shape it cannot transport (phase 8 §2.7 guards the
  binding's doors, not the adapter's transport).
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

### 2.9 The open-time identity agreement (#177)

The composed adapter speaks to two remote identities: the
synchronization transports git-level against the binding's `origin`
(ADR-0010 decision 3), while the API doors address the repository the
§2.5 credentials name — `owner/repo` on github.com. Before #177 nothing
compared them, so a credential for a fork (or any same-named repository
the token can write) passed every classification, the synchronization
pushed to one repository while the API doors published and verified
against another, and every `verified` outcome was true of a remote that
is not the binding's — the silent-divergence law's (§3) blind spot at
the composition root itself.

The factory therefore refuses to open unless the two identities agree.
At `openGitHubAdapter` — the one point every door crosses, and the only
place the check can stand without living inside the publication and
reconciliation units (their interiors are contract §2.3/§2.4
territory) — it reads the origin through the same transport runner the
synchronization uses (`git remote get-url origin`), which is the
**effective** URL: the string git itself rewrites `insteadOf`
configuration into, the exact address the sync's `ls-remote`/`push`
transport against. One source of truth, shared with the sync; a remote
configured under an alias and a remote configured under the canonical
URL are indistinguishable to the check, deliberately.

The origin URL is parsed by **git's own grammar, not an invented one**
— the "GIT URLS" section of git's `Documentation/urls.adoc`: the URL
forms `ssh://[<user>@]<host>[:<port>]/<path>`, `git://`, `http[s]://`
and `ftp[s]://`; the scp-like `[<user>@]<host>:/<path>` form, which
the section's own recognition rule confines — "This syntax is only
recognized if there are no slashes before the first colon"; and the
local forms `/path/to/repo.git/` and `file:///path/to/repo.git/`
(plus the remote-helper `<transport>::<address>` colon form). The
parsed identity is normalized to host + owner + repo: one trailing
`.git` stripped (GitHub refuses repository names ending in `.git`, so
one strip cannot eat a real name), surrounding slashes trimmed, and
the comparison is case-insensitive across host, owner and repo — a
differently cased spelling of the same repository is the same
repository. Exactly two path segments read as an identity; anything
else does not.

**Fail-closed is the check's whole point.** An origin that cannot be
_proven_ to name the credentials' repository refuses the open: local
paths, `file:` URLs, the ssh `~` home expansions, paths of any depth
other than `owner/repo`, remote-helper forms, unknown schemes,
malformed URLs, and the empty string. Likewise any origin on a host
other than `github.com` — GitHub Enterprise origins included — because
the §2.5 credential shape carries no host: the only repository any
expressible credential addresses is a path on github.com, and an
origin elsewhere names a repository no expressible credential can be
the same as. GitHub Enterprise support is the credential type's
amendment to make (a host field on `GitHubCredentials`, compared the
same way), never this check's guess; the same holds for GitHub's own
ssh-over-443 alias (`ssh.github.com`), which the hostless credential
cannot vouch for. A port qualification (`github.com:8443`) is not part
of a repository identity and does not refuse a same-host match.

- **The refusal is the environmental fault, thrown** —
  `GitFaultError` at open, naming both identities (the origin's and
  the credentials') and the remedy — not a new outcome class:
  decision 7's classes are remote-operation outcomes, and no door has
  run; the fault is the repository's own misconfiguration, the same
  family as the sync door's missing-origin fault (§2.2). It is loud:
  no warning, no degradation, no publish-elsewhere.
- **A repository with no origin configured opens.** Only one identity
  exists (the credentials'), the API doors are consistent with it, and
  the missing origin stays the sync door's own environmental fault at
  use time — moved no earlier than the evidence exists.
- **Rejected — the check in each door:** fragmented four ways, silent
  for the doors that forget, and inside units whose interiors this
  contract assigns elsewhere.
- **Rejected — comparing only at sync time:** the API doors would keep
  publishing and verifying against the credentials' repository while
  the sync refuses — the divergence half-fixed, and still silent for
  every caller that never syncs.
- **Rejected — rejecting unknown URL shapes leniently** (assume
  github.com, warn and continue): the check would be a no-op for
  exactly the origins most likely to be wrong; fail-closed is the
  point.

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
  union. No exception crosses the adapter's public surface — the law is
  enforced at one guarded boundary around the injected transport, which
  converts a throwing transport into the status-0 response, and pinned
  by conformance tests that drive a hostile transport against the doors
  (ADR-0010 decision 7; issue #179, D53).
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
    comparison. (Amended by issue #179, D53: the completeness verdict
    reads from evidence — the final page's size against the requested
    one — and the chain faults are scenarios 22–23.)
18. **Permission denial** (issue #178) — a 403 with a valid credential
    (the budget standing, no `Retry-After`) — the fine-grained-token
    "resource not accessible" answer, or the git path's "Permission to
    `<repo>` denied to `<user>`" — is `refused("permission-denied")`,
    never `auth-expired`; the git-path classifier reads the http
    transport's structured 403 the same way, and never reads a status
    substring out of a progress line.
19. **Secondary rate limit** (issue #178) — a 403 with `Retry-After`, or
    whose message names the secondary/abuse limit (the rate-limits
    reference's documented signal — "a `403` or `429` response and an
    error message that indicates that you exceeded a secondary rate
    limit", the header only conditionally present), while the primary
    budget stands is `refused("rate-limited")`, on every door that reads
    the transport; a documented secondary response carrying
    `x-ratelimit-remaining: 0`, or arriving as a `429`, reads through
    the primary leg — the same class, the primary-worded detail.
20. **Unobservable remote** (issue #176) — the release read's 404
    probes the repository: an observable repository makes the absence
    determinate (`absent`); an unobservable one is
    `refused("unobservable-remote")`, on `verifyRelease` and on the
    create path alike; a repo-scoped listing's 404 is
    `refused("unobservable-remote")` directly.
21. **Determinate create refusals** (issue #178) — the create's 422
    (`already_exists`, the duplicate-create answer observed on the
    wire, the benign race-loss) and its 409 are `refused("release-conflict")`
    with the provider's own words in the detail — never the detail-less
    retryable class; the idempotent re-run resolves a raced duplicate.
22. **Completeness evidence** (issue #179, D53) — a listing whose walk
    ends on a page at the requested full size with no `next` link reads
    `pagination: "truncated"`: the header's absence is byte-identical
    between the provider's end-of-chain and a transport or proxy
    stripping the header, so `complete` is claimed only from a final
    page **under** the requested size with no `next` declared. The
    truncated observation claims the comparison its rows really earned
    — the observed divergences and verified tags stand — and its label
    denies the clean bill; a full page that _declares_ a `next` is
    still followed, and the walk reads the final page only. The reading
    is permanent, not a corner: an exact multiple of the page size reads
    `truncated` on every reconciliation, and a page over the requested
    size reads `truncated` too — the conservative direction (D53). The
    follow trusts the header as given within the API-relative shape: the
    walk pins no endpoint prefix, the `Link` header arriving through the
    same trusted transport as the rows it paginates (D53).
23. **The chain's faults and the no-throw law** (issue #179, D53) — a
    `next` chain that cycles (a target the walk already requested) and
    a declared `next` whose target is no requestable API-relative path
    (empty, whitespace/control characters, an absolute URL) fault the
    whole listing `transport-failure` — loud, never a silent stop that
    reads as the chain's end, never a hang, never a blind follow — and
    every door returns its failure value when the transport throws: the
    guarded boundary converts the escape into status 0 (a read:
    `transport-failure`; the create: `ambiguous`).
24. **Open-time identity agreement** (issue #177, D55, §2.9) — the
    factory refuses to open (`GitFaultError`, naming both identities)
    whenever the binding's origin and the credentials name different
    repositories: the issue's repro (a same-named fork the token can
    write), a different repository on the same owner, and every other
    host (GitHub Enterprise origins, the ssh-over-443 alias). Every
    spelling of the agreeing origin opens with no false refusal —
    `https`/`scp`-like/`ssh://`, with and without `.git`, with and
    without a trailing slash, userinfo and ports, and case variants —
    and an origin no git grammar reads as a github.com repository (a
    local path, `file:`, a `~` expansion, a remote-helper form, a
    malformed URL) refuses the same loud way. A repository with no
    origin opens, and the sync's own environmental fault stands at use
    time.
