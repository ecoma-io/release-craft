/**
 * The GitHub adapter's vocabulary (Phase 9 contract §2.3, §2.5; ADR-0010
 * decisions 2, 7). No new domain vocabulary, no second persistence store:
 * the binding is the truth, the remote is a projection. Every remote
 * operation returns one of the outcomes below — a returned value, never
 * an exception (ADR-0010 decision 7).
 */

/**
 * Credentials supplied at open, never ambient, never stored by the
 * adapter beyond the opened instance's lifetime (contract §2.5). Token
 * expiry mid-operation surfaces as `refused("auth-expired")` — the
 * adapter does not refresh tokens.
 */
export interface GitHubCredentials {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
}

/**
 * The refusal reasons a remote write can carry (contract §2.3). Each is a
 * recorded decision the caller observes: operator intervention for
 * `auth-expired`, `rate-limited`, `permission-denied`, and
 * `unobservable-remote`; a recorded conflict decision for
 * `already-pushed-different-target` and `release-conflict`.
 *
 * `permission-denied` (issue #178) — the credential authenticated and the
 * provider declined the request's authorization: the fine-grained-token
 * "resource not accessible" answer, the git path's "Permission to
 * `<repo>` denied to `<user>`". Distinct from `auth-expired` — rotating a
 * valid token fixes nothing; the operator grants the scope.
 *
 * `unobservable-remote` (issue #176) — the provider answered 404 for a
 * repo-scoped resource: the repository is private, missing, moved, or the
 * token lacks read scope, and GitHub answers 404 — not 403 — for
 * resources invisible to the caller. An observation that never happened
 * is never a determinate absence (`absent` is claimed only over a
 * repository the adapter observably reached).
 */
export type RefusalReason =
  | "already-pushed-different-target"
  | "changelog-unrecorded"
  | "auth-expired"
  | "rate-limited"
  | "permission-denied"
  | "unobservable-remote"
  | "release-conflict";

/**
 * The refusal reasons a listing's observation can carry (issue #66;
 * contract §2.3's read narrowing): the operator-intervention classes
 * only. The write-conflict and projection reasons name writes and
 * recorded-state decisions (`verifyRelease`'s `changelog-unrecorded` and
 * `release-conflict` are comparison decisions, not provider refusals) —
 * a listing never carries them. The read set widens with the vocabulary
 * split (issues #176, #178): a 403 whose credential authenticated is
 * `permission-denied`, and a repo-scoped listing's 404 is
 * `unobservable-remote` — the collection exists whenever the repository
 * is observable, so its 404 is the repository's invisibility.
 */
export type ReadRefusalReason =
  "auth-expired" | "rate-limited" | "permission-denied" | "unobservable-remote";

/** One ref the sync considered (contract §2.2): pushed, skipped (already
 *  satisfied), or refused. */
export interface SyncedRef {
  readonly ref: string;
  readonly target: string;
  readonly kind: "claim" | "tag";
  readonly outcome:
    | { readonly state: "pushed" }
    | { readonly state: "skipped" }
    | { readonly state: "refused"; readonly reason: RefusalReason }
    | { readonly state: "transport-failure" }
    | { readonly state: "ambiguous" };
}

/** The `syncRemote()` report (contract §2.2): every ref the binding
 *  recorded, with what the sync did to it. */
export interface SyncReport {
  readonly refs: readonly SyncedRef[];
}

/** The `publishRelease()` outcome (contract §2.2). */
export type ReleaseOutcome =
  | { readonly kind: "ok"; readonly url: string }
  | { readonly kind: "refused"; readonly reason: RefusalReason; readonly detail: string }
  | { readonly kind: "transport-failure" }
  | { readonly kind: "ambiguous" };

/** The `verifyRelease()` outcome (contract §2.2). A read carries no
 * `ambiguous` (issue #66): that class names a write whose landing is
 * unknown, and verification is never a write. */
export type VerificationOutcome =
  | { readonly kind: "verified" }
  | { readonly kind: "refused"; readonly reason: RefusalReason; readonly detail: string }
  | ReleaseAbsent
  | { readonly kind: "transport-failure" };

/** The `verifyRelease()` outcome for a release that does not exist for
 *  the recorded tag (issue #60; contract §2.2; D28): absence is a
 *  determinate read — never a retryable transport failure and never a
 *  refusal of a write. The caller's action is the publication itself
 *  (the create path is idempotent, §2.4). A release read's 404 alone
 *  does not carry the verdict (#176): it is discriminated by the
 *  repository probe first — `absent` is claimed only over a repository
 *  the adapter observably reached; an unobservable one is the
 *  `unobservable-remote` refusal. */
export interface ReleaseAbsent {
  readonly kind: "absent";
}

/** One divergence the reconciliation found (contract §2.2; ADR-0010
 *  decision 8): reported, never silently resolved. */
export interface Divergence {
  readonly kind: "unadopted-tag" | "unadopted-release";
  readonly tag: string;
  readonly detail: string;
}

/** The completeness of a listing's observation over pagination (issue
 *  #68; D32; issue #179; D53): the contract binds the observation to the
 *  resource's full surface, and the label is claimed from evidence,
 *  never from a header's absence. `complete` — the walk followed the
 *  page chain to a page that could not have a successor (fewer rows
 *  than the requested page size) with no `next` declared on it, and the
 *  comparison ran over every row. `truncated` — the chain ended on a
 *  full-size page with no `next`: end-of-chain and a stripped `Link`
 *  header are indistinguishable there, so the observation carries the
 *  comparison its rows really earned (divergences and verified tags
 *  over the rows observed are real) while the label denies the
 *  clean-bill reading over the rows it never saw. */
export type PaginationCompleteness = "complete" | "truncated";

/** The tag listing's observation outcome (issue #66; contract §2.2): the
 *  comparison's premise — `listed` claims its divergences and its
 *  verified tags, every unobserved state claims nothing. An empty
 *  listing is `listed` with no divergences: a determinate clean
 *  observation, the listing twin of `verifyRelease`'s `absent`. A
 *  refusal is the provider declining the observation, with the refusal
 *  detail (decision 9's rate-limit reset timestamp on `rate-limited`). */
export type TagsListingOutcome =
  | {
      readonly state: "listed";
      readonly listed: number;
      readonly pagination: PaginationCompleteness;
      readonly divergences: readonly Divergence[];
      readonly verifiedTags: readonly string[];
    }
  | { readonly state: "refused"; readonly reason: ReadRefusalReason; readonly detail: string }
  | { readonly state: "transport-failure" };

/** The release listing's observation outcome (issue #66; contract
 *  §2.2): the same premise over the remote's releases — `listed` claims
 *  the unadopted-release divergences, every unobserved state claims
 *  nothing. */
export type ReleasesListingOutcome =
  | {
      readonly state: "listed";
      readonly listed: number;
      readonly pagination: PaginationCompleteness;
      readonly divergences: readonly Divergence[];
    }
  | { readonly state: "refused"; readonly reason: ReadRefusalReason; readonly detail: string }
  | { readonly state: "transport-failure" };

/** The `reconcile()` report (contract §2.2): one observation outcome per
 *  listing. Comparison results exist only on `listed` — over an
 *  unobserved remote, a comparison that never ran is unrepresentable as
 *  a passed one, and a report with an unobserved listing is
 *  inconclusive, never clean. */
export interface ReconciliationReport {
  readonly tags: TagsListingOutcome;
  readonly releases: ReleasesListingOutcome;
}

/**
 * The GitHub adapter's surface (contract §2.2). Synchronous — the adapter
 * performs network I/O but returns a value, never a promise or callback,
 * consistent with the binding's synchronous discipline.
 */
export interface GitHubAdapter {
  syncRemote(): SyncReport;
  publishRelease(tag: string): ReleaseOutcome;
  verifyRelease(tag: string): VerificationOutcome;
  reconcile(): ReconciliationReport;
}

/**
 * The transport the adapter speaks to GitHub through — caller-injected at
 * open (ADR-0010 decision 2's credential boundary, extended: the no-
 * runtime-dependency house rule means the adapter owns no HTTP client of
 * its own). A synchronous request/response shape, matching the adapter's
 * synchronous discipline; the implementation supplies the fetch mechanics.
 */
export interface GitHubTransport {
  /** One GitHub REST call. `path` is API-relative (e.g.
   *  `/repos/{owner}/{repo}/releases`); the transport applies the
   *  credential and the base URL. Outcome is a returned value. */
  request(path: string, init?: GitHubRequestInit): GitHubResponse;
}

/** The request the transport receives. */
export interface GitHubRequestInit {
  readonly method?: "GET" | "POST";
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** The response the transport returns — always a value, never a throw. */
export interface GitHubResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
