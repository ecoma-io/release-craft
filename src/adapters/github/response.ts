/**
 * The API transport's one failure classification (the Phase 9 contract
 * §2.3, issue #66; the vocabulary split of issues #176/#178): every unit
 * that reads the API transport classifies a response through this
 * module, so the failure classes mean the same thing on every door — a
 * rate limit (primary or secondary) is a rate limit, an expired
 * credential is an expired credential, a credential that authenticated
 * but may not act is a permission denial, an invisible repository is an
 * unobservable remote, and only what the provider did not answer for is
 * the retryable failure. The git-path half of §2.3 (the sync unit's
 * stderr classification) lives beside it, not in it: that path speaks
 * git's sideband, not HTTP statuses.
 */

import type {
  GitHubRequestInit,
  GitHubResponse,
  GitHubTransport,
  ReadRefusalReason,
} from "./adapter-types.js";

const headerValue = (
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined => {
  const direct = headers[name];
  if (direct !== undefined) {
    return direct;
  }
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      return headers[key];
    }
  }
  return undefined;
};

/** The body's `message` field, when the response carries one — the
 *  provider's own words for the refusal detail. A body that is not JSON,
 *  or carries no string message, reads as no message. */
export const bodyMessage = (body: string): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    "message" in parsed &&
    typeof parsed.message === "string"
  ) {
    return parsed.message;
  }
  return undefined;
};

/** The primary rate limit's shape: a 429, or a 403 whose rate-limit
 *  budget is spent (the same limit arriving under the other status). */
const isPrimaryRateLimit = (response: GitHubResponse): boolean => {
  if (response.status === 429) {
    return true;
  }
  if (response.status !== 403) {
    return false;
  }
  const remaining = headerValue(response.headers, "x-ratelimit-remaining");
  return remaining !== undefined && remaining.trim() === "0";
};

/** The secondary rate limit's shape (issue #178): a 403 that names the
 *  secondary limit — by the `Retry-After` header or by its own words —
 *  while the primary budget stands. The rate-limits reference
 *  ("Exceeding the rate limit",
 *  docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
 *  documents the answer as "a `403` or `429` response and an error
 *  message that indicates that you exceeded a secondary rate limit",
 *  with the `Retry-After` header only conditionally present ("If the
 *  `retry-after` response header is present …"), so the header alone is
 *  not the shape — the body's secondary/abuse phrasing is the other
 *  documented signal, the git path's phrase keying mirrored on the API
 *  side. The reference also documents a secondary response carrying
 *  `x-ratelimit-remaining: 0` (and arriving as a `429`): those shapes
 *  read through the primary predicate first — the same `rate-limited`
 *  class, the primary-worded detail. */
const SECONDARY_RATE_LIMIT_PHRASE = /secondary rate limit|abuse detection mechanism/i;

const isSecondaryRateLimit = (response: GitHubResponse): boolean => {
  if (response.status !== 403) {
    return false;
  }
  if (headerValue(response.headers, "retry-after") !== undefined) {
    return true;
  }
  const message = bodyMessage(response.body);
  return message !== undefined && SECONDARY_RATE_LIMIT_PHRASE.test(message);
};

/** The rate-limit refusal's detail, per the limit the headers name: the
 *  primary limit's reset timestamp (ADR-0010 decision 9), or the
 *  secondary limit's `Retry-After`. A 403 carries `x-ratelimit-*`
 *  headers even with budget standing, so the primary/secondary split is
 *  decided by the same predicates the classification used — never by
 *  the reset header's mere presence. */
const rateLimitDetail = (response: GitHubResponse): string => {
  const reset = headerValue(response.headers, "x-ratelimit-reset");
  const retryAfter = headerValue(response.headers, "retry-after");
  if (!isPrimaryRateLimit(response)) {
    return retryAfter === undefined
      ? "the API's secondary rate limit is engaged; wait at least one minute before retrying"
      : `the API's secondary rate limit is engaged; retry after ${retryAfter} seconds`;
  }
  if (reset !== undefined) {
    return `the API's rate limit is exhausted; it resets at ${reset}`;
  }
  if (retryAfter !== undefined) {
    return `the API's rate limit is engaged; retry after ${retryAfter} seconds`;
  }
  return "the API's rate limit is exhausted";
};

/** The failure a response carries once it is not the status the read
 *  wanted: a provider refusal with the operator-intervention reason, or
 *  the one retryable class. Reads have no `ambiguous`: nothing can have
 *  landed unseen (issue #66; contract §2.3's read narrowing). The write
 *  path's post-write window (status 0 after the create → `ambiguous`)
 *  stays the publication unit's own rule, layered on this one.
 *
 * The one table (contract §2.3; issue #178's split):
 * - 429, a 403 with the budget spent, or a 403 naming the secondary
 *   limit (`Retry-After`, or the body's secondary/abuse phrasing) —
 *   `rate-limited` (primary or secondary, per the same predicates);
 * - 404 on a repo-scoped read — `unobservable-remote` (issue #176): the
 *   resource is invisible to this credential, and an observation that
 *   never happened is never a determinate absence. The one 404 with a
 *   narrower reading — the release-tag read, where the release's own
 *   absence is the common case — is intercepted by the publication unit
 *   (the repository probe) before this table sees it;
 * - 401 — `auth-expired`: the credential itself was rejected;
 * - any other 403 — `permission-denied`: the credential authenticated
 *   and the request is not authorized (rotating it fixes nothing);
 * - status 0 and every other non-200 — `transport-failure`, the one
 *   retryable class. */
export type ReadFailure =
  | { readonly kind: "refused"; readonly reason: ReadRefusalReason; readonly detail: string }
  | { readonly kind: "transport-failure" };

export const readFailure = (response: GitHubResponse): ReadFailure => {
  if (isPrimaryRateLimit(response) || isSecondaryRateLimit(response)) {
    return {
      kind: "refused",
      reason: "rate-limited",
      detail: rateLimitDetail(response),
    };
  }
  if (response.status === 404) {
    return {
      kind: "refused",
      reason: "unobservable-remote",
      detail:
        "the remote answered 404 — the repository or resource is not visible to this credential; " +
        "the owner, repository, or token scope may be wrong",
    };
  }
  if (response.status === 401) {
    return {
      kind: "refused",
      reason: "auth-expired",
      detail: "the credential was rejected with HTTP 401",
    };
  }
  if (response.status === 403) {
    const message = bodyMessage(response.body);
    return {
      kind: "refused",
      reason: "permission-denied",
      detail: `the credential is not authorized for this request (HTTP 403${
        message === undefined ? "" : `: ${message}`
      })`,
    };
  }
  // Status 0 is the transport's "no determinate response"; on a read
  // nothing has landed, so it is the ordinary retryable failure.
  return { kind: "transport-failure" };
};

/** The one reading the pagination walk takes of a response's `Link`
 *  header (issue #68; D32; issue #179; D53). The three are distinct on
 *  purpose:
 *
 * - `absent` — no `rel="next"` is declared (no header, or other
 *   relations only). This is the header's *claim* that the chain ended —
 *   never by itself the walk's evidence of it; the listing's
 *   completeness is decided by the final page's size against the
 *   requested one (reconciliation.ts's walk).
 * - `next` — a declared next whose target is a usable API-relative
 *   path, handed to the walk for its follow-up request.
 * - `malformed` — a declared next whose target conveys no requestable
 *   page: an empty target (RFC 8288 §3.1 "Link Target": the link-value
 *   conveys one target IRI inside the angle brackets — an empty pair
 *   conveys none), or one that is no API-relative path (whitespace or
 *   control characters, or an absolute URL — the transport contract's
 *   "`path` is API-relative; the transport applies the credential and
 *   the base URL", so a header written in the transport's own absolute
 *   form belongs to the transport's side of that boundary, and a blind
 *   follow is the request-error shape issue #179 refuses). A malformed
 *   next is a *fault*, loudly reported by the walk — never a silent
 *   stop that reads as the chain's end, and never a request the
 *   transport never agreed to speak. */
export type NextLink =
  | { readonly kind: "absent" }
  | { readonly kind: "next"; readonly path: string }
  | { readonly kind: "malformed"; readonly target: string };

/** The target as a usable API-relative request path, or undefined:
 *  anchored at the API root, and free of the whitespace and control
 *  characters that would corrupt the request. The characters are
 *  screened by code point rather than by one regex so the control
 *  range never appears as a pattern. */
const asApiRelativePath = (target: string): string | undefined => {
  if (!target.startsWith("/")) {
    return undefined;
  }
  for (const character of target) {
    const code = character.codePointAt(0) ?? 0;
    if (/\s/u.test(character) || code <= 0x1f || code === 0x7f) {
      return undefined;
    }
  }
  return target;
};

/** The `Link` header's `rel="next"` link, parsed for the pagination
 *  walk (RFC 8288 §3 "Link Serialisation in HTTP Headers": the field
 *  serialises one or more links, each `"<" URI-Reference ">" *( OWS ";"
 *  OWS link-param )`). The walk follows `next` links across pages; any
 *  other relation is a header value, never a request — a header
 *  carrying only `rel="first"`/`rel="last"` is the absent reading, not
 *  a fault. The relation may be written `rel="next"` (the quoted form)
 *  or `rel=next` (the token form — RFC 8288 §3: "recipients MUST be
 *  able to parse both forms"); both are accepted. */
export const nextLink = (headers: Readonly<Record<string, string>>): NextLink => {
  const link = headerValue(headers, "link");
  if (link === undefined) {
    return { kind: "absent" };
  }
  for (const part of link.split(",")) {
    const trimmed = part.trim();
    const match = /<([^>]*)>[^,]*\brel\s*=\s*"?next"?/i.exec(trimmed);
    if (match !== null) {
      const target = (match[1] ?? "").trim();
      const path = asApiRelativePath(target);
      return path === undefined ? { kind: "malformed", target } : { kind: "next", path };
    }
  }
  return { kind: "absent" };
};

/** The transport's request, taken at the boundary the no-throw law
 *  names (ADR-0010 decision 7; the Phase 9 contract §3's "Failures are
 *  values"): the transport is caller-injected — the one component the
 *  adapter does not own — so a transport that throws, however hostile
 *  or broken, must never carry its exception past the adapter's doors.
 *  The guard converts an escape into the transport's own "no
 *  determinate response" shape (status 0), whose reading is the
 *  callers' existing one: on a read, §2.3's `transport-failure` through
 *  the one table; on a write whose response is lost mid-call, §2.3's
 *  `ambiguous` window — the write may have landed unseen. Nothing the
 *  door can observe separates a thrown transport from a lost
 *  connection, so both read through status 0 (issue #179; D53). */
export const guardedRequest = (
  transport: GitHubTransport,
  path: string,
  init?: GitHubRequestInit,
): GitHubResponse => {
  try {
    return transport.request(path, init);
  } catch {
    return { status: 0, headers: {}, body: "" };
  }
};
