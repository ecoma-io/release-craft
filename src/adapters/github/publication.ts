/**
 * The release publication — the Phase 9 contract §2.2's `publishRelease()`
 * and `verifyRelease()` over the binding's content seam (§2.8). The
 * binding's recorded state is the truth; the release is a projection:
 *
 * - the body is resolved from recorded state only (D27): the tag's
 *   minting claim (the claim whose scope the declared naming derives the
 *   tag from — the tag namespaces are globally unique, so the derivation
 *   names at most one claim), the holding attempt's recorded stream, the
 *   completed `artifact:changelog` generation record, and the recorded
 *   tree's `CHANGELOG.md` behind the record's content fingerprint. An
 *   attempt without the record — or a recorded tree without the file —
 *   is `refused("changelog-unrecorded")`: the adapter never publishes
 *   bytes the binding did not record (ADR-0010 decision 6);
 * - the idempotency check runs before any write (§2.4): the remote's
 *   release for the tag is read first, and a body that already matches
 *   the recorded changelog is `ok` — no write is attempted. A body that
 *   differs is `refused("release-conflict")`, the recorded decision the
 *   caller owes the operator;
 * - the create is the one write, and a lost create response is
 *   `ambiguous` (§2.3): the write may have landed; verification is the
 *   caller's separate read. A failed read is `transport-failure` —
 *   nothing has landed to be ambiguous about;
 * - `verifyRelease` reports a release that does not exist as `absent`
 *   (issue #60; D28): a determinate read, and the caller's action is the
 *   publication itself.
 *
 * The unit is the phase-9.3 increment of the adapter surface: 9.5's
 * `openGitHubAdapter` composes it (with the sync and reconciliation
 * units) behind the ADR-0010 decision 2 factory, and this module's
 * barrel export is interim until that assembly lands. The transport is
 * caller-injected — the adapter owns no HTTP client (the no-runtime-
 * dependency house rule) and applies no credential of its own; the
 * transport speaks the credentials, the unit speaks the repository.
 */

import type { GitBinding } from "../git/index.js";
import type {
  GitHubCredentials,
  GitHubResponse,
  GitHubTransport,
  RefusalReason,
  ReleaseOutcome,
  VerificationOutcome,
} from "./adapter-types.js";

/** The step key the kernel records a changelog generation under (the
 *  artifact steps' `artifact:<id>` shape, ADR-0008 decision 5). The
 *  literal travels here because the adapter consumes the binding's
 *  barrel only — never the engine's modules. */
const CHANGELOG_STEP = "artifact:changelog";

/** The file the projection publishes as the release body (§2.8). */
const CHANGELOG_PATH = "CHANGELOG.md";

/** The changelog the recorded state projects for a tag: the body, with
 *  the digest that is §2.4's idempotency identity — or the refusal the
 *  projection owed instead. */
type RecordedChangelog =
  | { readonly ok: true; readonly digest: string; readonly body: string }
  | { readonly ok: false; readonly reason: RefusalReason; readonly detail: string };

/** The response classes every release call shares once the caller has
 *  the recorded changelog in hand. */
type FailureTail =
  | { readonly kind: "refused"; readonly reason: RefusalReason; readonly detail: string }
  | { readonly kind: "transport-failure" }
  | { readonly kind: "ambiguous" };

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

const failureTail = (response: GitHubResponse, wrote: boolean): FailureTail => {
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
  // Status 0 is the transport's "no determinate response": after a read
  // nothing has landed, so it is an ordinary failure; after the create
  // the write may have landed unseen (§2.3's ambiguous class).
  if (response.status === 0) {
    return wrote ? { kind: "ambiguous" } : { kind: "transport-failure" };
  }
  return { kind: "transport-failure" };
};

/** The release resource's browser URL, as the API reports it — the `ok`
 *  outcome's payload. */
const releaseUrl = (body: string): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    "html_url" in parsed &&
    typeof parsed.html_url === "string"
  ) {
    return (parsed as { html_url: string }).html_url;
  }
  return undefined;
};

const releaseBody = (body: string): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    "body" in parsed &&
    typeof parsed.body === "string"
  ) {
    return (parsed as { body: string }).body;
  }
  return undefined;
};

const releasePath = (credentials: GitHubCredentials, tag: string): string =>
  `/repos/${credentials.owner}/${credentials.repo}/releases/tags/${encodeURIComponent(tag)}`;

/** Projects the tag's changelog out of the binding's recorded state
 *  (§2.8): tag → minting claim → holding attempt → the completed
 *  changelog generation record → the recorded tree's file. */
const recordedChangelog = (binding: GitBinding, tag: string): RecordedChangelog => {
  for (const row of binding.refs.claims()) {
    const claim = binding.content.claim(row.ref);
    if (claim === null || binding.content.tagFor(claim.scope) !== tag) {
      continue;
    }
    for (const entry of binding.content.tail(claim.holder)) {
      if (entry.kind !== "step") {
        continue;
      }
      const record = entry.record;
      if (record.stepKey !== CHANGELOG_STEP || record.to !== "completed") {
        continue;
      }
      const digest = record.contentFingerprint ?? record.artifact?.digest;
      if (digest === undefined) {
        continue;
      }
      const body = binding.content.file(digest, CHANGELOG_PATH);
      if (body === null) {
        return {
          ok: false,
          reason: "changelog-unrecorded",
          detail: `the recorded tree ${digest} holds no ${CHANGELOG_PATH}`,
        };
      }
      return { ok: true, digest, body };
    }
    return {
      ok: false,
      reason: "changelog-unrecorded",
      detail: `the attempt ${claim.holder} holds no completed ${CHANGELOG_STEP} record`,
    };
  }
  return {
    ok: false,
    reason: "changelog-unrecorded",
    detail: `no recorded claim derives the tag ${tag}`,
  };
};

/**
 * Opens the release publication on an already-opened binding, the open
 * credentials (the API path's owner and repository), and the injected
 * transport. Synchronous, like every unit; refusals and conflicts are
 * returned decisions, never exceptions (§2.3).
 */
export function GitReleasePublication(
  binding: GitBinding,
  credentials: GitHubCredentials,
  transport: GitHubTransport,
): {
  publishRelease(tag: string): ReleaseOutcome;
  verifyRelease(tag: string): VerificationOutcome;
} {
  return {
    publishRelease(tag: string): ReleaseOutcome {
      const recorded = recordedChangelog(binding, tag);
      if (!recorded.ok) {
        return { kind: "refused", reason: recorded.reason, detail: recorded.detail };
      }
      // Idempotency before write (§2.4): a release whose body already
      // matches the recorded changelog satisfies the write — the URL is
      // the existing release's.
      const existing = transport.request(releasePath(credentials, tag));
      if (existing.status === 200) {
        const url = releaseUrl(existing.body);
        const remoteBody = releaseBody(existing.body);
        if (url === undefined || remoteBody === undefined) {
          return { kind: "transport-failure" };
        }
        return remoteBody === recorded.body
          ? { kind: "ok", url }
          : {
              kind: "refused",
              reason: "release-conflict",
              detail: `the remote release for ${tag} does not match the recorded changelog (${recorded.digest})`,
            };
      }
      if (existing.status !== 404) {
        return failureTail(existing, false);
      }
      // The create: the one write this unit performs. A lost response is
      // ambiguous, never a silent success (§2.3).
      const created = transport.request(
        `/repos/${credentials.owner}/${credentials.repo}/releases`,
        {
          method: "POST",
          body: JSON.stringify({ tag_name: tag, name: tag, body: recorded.body }),
          headers: { "Content-Type": "application/json" },
        },
      );
      if (created.status === 201) {
        const url = releaseUrl(created.body);
        return url === undefined ? { kind: "transport-failure" } : { kind: "ok", url };
      }
      return failureTail(created, true);
    },

    verifyRelease(tag: string): VerificationOutcome {
      const recorded = recordedChangelog(binding, tag);
      if (!recorded.ok) {
        return { kind: "refused", reason: recorded.reason, detail: recorded.detail };
      }
      const existing = transport.request(releasePath(credentials, tag));
      if (existing.status === 404) {
        // D28: absence is a determinate read — the publication has not
        // landed, and the caller's action is the idempotent create.
        return { kind: "absent" };
      }
      if (existing.status !== 200) {
        return failureTail(existing, false);
      }
      const remoteBody = releaseBody(existing.body);
      if (remoteBody === undefined) {
        return { kind: "transport-failure" };
      }
      return remoteBody === recorded.body
        ? { kind: "verified" }
        : {
            kind: "refused",
            reason: "release-conflict",
            detail: `the remote release for ${tag} does not match the recorded changelog (${recorded.digest})`,
          };
    },
  };
}
