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
 * `auth-expired` and `rate-limited`, a recorded conflict decision for
 * `already-pushed-different-target` and `release-conflict`.
 */
export type RefusalReason =
  "already-pushed-different-target" | "auth-expired" | "rate-limited" | "release-conflict";

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

/** The remote synchronization unit's surface (contract §2.2; the phase
 *  9.2 increment): the one operation this PR ships. 9.5's
 *  `openGitHubAdapter` composes the units behind the factory. */
export interface RemoteSync {
  syncRemote(): SyncReport;
}

/** The `publishRelease()` outcome (contract §2.2). */
export type ReleaseOutcome =
  | { readonly kind: "ok"; readonly url: string }
  | { readonly kind: "refused"; readonly reason: RefusalReason; readonly detail: string }
  | { readonly kind: "transport-failure" }
  | { readonly kind: "ambiguous" };

/** The `verifyRelease()` outcome (contract §2.2). */
export type VerificationOutcome =
  | { readonly kind: "verified" }
  | { readonly kind: "refused"; readonly reason: RefusalReason; readonly detail: string }
  | { readonly kind: "transport-failure" }
  | { readonly kind: "ambiguous" };

/** One divergence the reconciliation found (contract §2.2; ADR-0010
 *  decision 8): reported, never silently resolved. */
export interface Divergence {
  readonly kind: "unadopted-tag" | "unadopted-release";
  readonly tag: string;
  readonly detail: string;
}

/** The `reconcile()` report (contract §2.2): the remote's state compared
 *  against the binding's recorded state. */
export interface ReconciliationReport {
  readonly divergences: readonly Divergence[];
  readonly verifiedTags: readonly string[];
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
