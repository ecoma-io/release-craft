/**
 * The API transport's one failure classification (the Phase 9 contract
 * §2.3, issue #66): every unit that reads the API transport classifies a
 * response through this module, so the failure classes mean the same
 * thing on every door — a rate limit is a rate limit, an expired
 * credential is an expired credential, and everything else that is not a
 * 200 is the same retryable failure. The git-path half of §2.3 (the
 * sync unit's stderr classification) lives beside it, not in it: that
 * path speaks git's sideband, not HTTP statuses.
 */

import type { GitHubResponse, ReadRefusalReason } from "./adapter-types.js";

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

/** The rate-limit shape GitHub answers with: a 429, or a 403 whose
 *  rate-limit budget is spent (the same limit arriving under the other
 *  status). */
const isRateLimited = (response: GitHubResponse): boolean => {
  if (response.status === 429) {
    return true;
  }
  if (response.status !== 403) {
    return false;
  }
  const remaining = headerValue(response.headers, "x-ratelimit-remaining");
  return remaining !== undefined && remaining.trim() === "0";
};

/** The failure a response carries once it is not the status the read
 *  wanted: a provider refusal with the operator-intervention reason, or
 *  the one retryable class. Reads have no `ambiguous`: nothing can have
 *  landed unseen (issue #66; contract §2.3's read narrowing). The write
 *  path's post-write window (status 0 after the create → `ambiguous`)
 *  stays the publication unit's own rule, layered on this one. */
export type ReadFailure =
  | { readonly kind: "refused"; readonly reason: ReadRefusalReason; readonly detail: string }
  | { readonly kind: "transport-failure" };

export const readFailure = (response: GitHubResponse): ReadFailure => {
  if (isRateLimited(response)) {
    const reset = headerValue(response.headers, "x-ratelimit-reset");
    return {
      kind: "refused",
      reason: "rate-limited",
      detail:
        reset === undefined
          ? "the API's rate limit is exhausted"
          : `the API's rate limit is exhausted; it resets at ${reset}`,
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      kind: "refused",
      reason: "auth-expired",
      detail: `the credential was rejected with HTTP ${String(response.status)}`,
    };
  }
  // Status 0 is the transport's "no determinate response"; on a read
  // nothing has landed, so it is the ordinary retryable failure.
  return { kind: "transport-failure" };
};

/** The API-relative path of the `Link` header's `rel="next"` target, when
 *  one is declared (RFC 8288 §3.3). The pagination walk (issue #68; D32)
 *  follows `next` links across pages; any other relation is a header value,
 *  never a request. A header with no `next` link — or a malformed one —
 *  reads as the end of the listing, and the walk stops there. The relation
 *  may be written `rel="next"` (RFC 8288's value form) or `rel=next` (the
 *  unquoted legacy form); both are accepted. */
export const nextLinkPath = (headers: Readonly<Record<string, string>>): string | undefined => {
  const link = headerValue(headers, "link");
  if (link === undefined) {
    return undefined;
  }
  for (const part of link.split(",")) {
    const trimmed = part.trim();
    const match = /<([^>]+)>[^,]*\brel\s*=\s*"?next"?/i.exec(trimmed);
    if (match !== null) {
      return match[1] ?? undefined;
    }
  }
  return undefined;
};
