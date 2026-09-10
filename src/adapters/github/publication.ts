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
 *   nothing has landed to be ambiguous about. A determinate answer
 *   classifies: the provider's 422/409 refusals of the create are
 *   `refused("release-conflict")` with the provider's own words
 *   (`already_exists` is the documented duplicate-create answer — the
 *   benign race-loss the idempotent re-run resolves; issue #178), and
 *   the create's 404 is the unobservable repository (#176) — a
 *   determinate non-land, never the retryable class;
 * - `verifyRelease` reports a release that does not exist as `absent`
 *   (issue #60; D28): a determinate read, and the caller's action is the
 *   publication itself. The verdict is discriminated before it is
 *   claimed (issue #176): a release read's 404 also answers a repository
 *   the credential cannot observe, so the 404 read probes the repository
 *   itself — `absent` only over an observable repository, the probe's
 *   own refusal (`unobservable-remote`) otherwise.
 *
 * The unit is the phase-9.3 increment of the adapter surface: 9.5's
 * `openGitHubAdapter` composes it (with the sync and reconciliation
 * units) behind the ADR-0010 decision 2 factory, and this module's
 * barrel export is interim until that assembly lands. The transport is
 * caller-injected — the adapter owns no HTTP client (the no-runtime-
 * dependency house rule) and applies no credential of its own; the
 * transport speaks the credentials, the unit speaks the repository.
 */

import type { GitBinding } from "@ecoma-io/release-craft/adapters/git";
import type {
  GitHubCredentials,
  GitHubResponse,
  GitHubTransport,
  RefusalReason,
  ReleaseOutcome,
  VerificationOutcome,
} from "./adapter-types.js";
import { bodyMessage, readFailure } from "./response.js";

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
 *  the recorded changelog in hand. Reads carry no `ambiguous` (issue
 *  #66; D30): only the post-write window can, so the tail the reads
 *  share is the refused/transport pair, and the create maps its own
 *  status 0 to `ambiguous` (§2.3) before classifying the rest. */
type FailureTail =
  | { readonly kind: "refused"; readonly reason: RefusalReason; readonly detail: string }
  | { readonly kind: "transport-failure" };

const failureTail = (response: GitHubResponse): FailureTail => {
  const failure = readFailure(response);
  return failure.kind === "refused"
    ? { kind: "refused", reason: failure.reason, detail: failure.detail }
    : failure;
};

/** Whether the create refusal is GitHub's documented duplicate-create
 *  answer: the `already_exists` code rides the body's `errors` array
 *  (the REST contract's shape) or the message itself. */
const isAlreadyExists = (body: string): boolean => {
  const message = bodyMessage(body);
  if (message !== undefined && message.includes("already_exists")) {
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || !("errors" in parsed)) {
    return false;
  }
  const errors: unknown = parsed.errors;
  if (!Array.isArray(errors)) {
    return false;
  }
  const entries = errors as readonly { code?: unknown }[];
  return entries.some((entry) => entry.code === "already_exists");
};

/** The determinate create refusal's detail (issue #178): the provider
 *  answered the write — nothing landed unseen — so the refusal carries
 *  the provider's own words. `already_exists` is GitHub's documented
 *  answer to a duplicate create: the write raced another publisher (or
 *  the release pre-exists), the remote now holds a release for the tag,
 *  and the idempotent re-run resolves whose it is — the same recorded
 *  conflict decision a diverged release carries. */
const createConflictDetail = (tag: string, response: GitHubResponse): string => {
  const message = bodyMessage(response.body);
  if (isAlreadyExists(response.body)) {
    return (
      `the provider refused the create: a release for ${tag} already exists ` +
      "(the write raced another publisher, or the release pre-exists); " +
      "re-run the publication — the idempotency read resolves it"
    );
  }
  return `the provider refused the create (HTTP ${String(response.status)}${
    message === undefined ? "" : `: ${message}`
  })`;
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

/** The repository resource itself — the probe the absence verdict reads
 *  (issue #176): a release read's 404 is ambiguous between the release's
 *  absence and the repository's invisibility, and only the repository
 *  read tells them apart. */
const repoPath = (credentials: GitHubCredentials): string =>
  `/repos/${credentials.owner}/${credentials.repo}`;

/** Projects the tag's changelog out of the binding's recorded state
 *  (§2.8): tag → minting claim → holding attempt → the completed
 *  changelog generation record → the recorded tree's file. A claim ref
 *  holds the line's whole register (ADR-0011), so the derivation iterates
 *  each register's set — the first recorded claim deriving the tag wins,
 *  exactly as the single-record read's first ref won before it. */
const recordedChangelog = (binding: GitBinding, tag: string): RecordedChangelog => {
  for (const row of binding.refs.claims()) {
    for (const claim of binding.content.claims(row.ref)) {
      if (binding.content.tagFor(claim.scope) !== tag) {
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
        return failureTail(existing);
      }
      // The create: the one write this unit performs. A lost response is
      // ambiguous, never a silent success (§2.3) — status 0 after the
      // write is that class. A determinate answer classifies: a 404 is
      // the unobservable repository (#176) — the write landed nothing;
      // a 422 or 409 is the provider's determinate refusal of the
      // create (#178) — `already_exists` is its documented duplicate
      // answer, the benign race-loss the idempotent re-run resolves;
      // the credential and rate-limit shapes are the read tail's.
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
      if (created.status === 0) {
        return { kind: "ambiguous" };
      }
      if (created.status === 404) {
        return failureTail(created);
      }
      if (created.status === 422 || created.status === 409) {
        return {
          kind: "refused",
          reason: "release-conflict",
          detail: createConflictDetail(tag, created),
        };
      }
      return failureTail(created);
    },

    verifyRelease(tag: string): VerificationOutcome {
      const recorded = recordedChangelog(binding, tag);
      if (!recorded.ok) {
        return { kind: "refused", reason: recorded.reason, detail: recorded.detail };
      }
      const existing = transport.request(releasePath(credentials, tag));
      if (existing.status === 404) {
        // D28's absence, discriminated before it is claimed (#176): a
        // 404 also answers a repository this credential cannot observe.
        // The repository probe decides — over an observable repository
        // the absence is the determinate read (the publication has not
        // landed; the caller's action is the idempotent create); over
        // an unobservable one nothing was observed, and the probe's own
        // refusal (`unobservable-remote` on its 404) says so.
        const probe = transport.request(repoPath(credentials));
        if (probe.status === 200) {
          return { kind: "absent" };
        }
        return failureTail(probe);
      }
      if (existing.status !== 200) {
        return failureTail(existing);
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
