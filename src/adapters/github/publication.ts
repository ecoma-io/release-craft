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
 *   (`already_exists` is the duplicate-create answer observed on the
 *   wire — the reference page documents the endpoint's 422 only as
 *   "Validation failed, or the endpoint has been spammed" — the benign
 *   race-loss the idempotent re-run resolves; issue #178), and
 *   the create's 404 is the unobservable repository (#176) — a
 *   determinate non-land, never the retryable class;
 * - the create's precondition (issue #338): the remote git ref for the
 *   tag is read before any write — a ref origin does not hold is
 *   `refused("release-tag-missing")` over an observable repository (the
 *   create-release API otherwise creates a missing tag at the default
 *   branch's HEAD, the wrong-commit hazard), a ref answering a
 *   different object is `refused("release-tag-mismatch")`, and the
 *   create carries the recorded target as `target_commitish` — the
 *   create never fires unverified;
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
  GitHubRequestInit,
  GitHubResponse,
  GitHubTransport,
  RefusalReason,
  ReleaseOutcome,
  VerificationOutcome,
} from "./adapter-types.js";
import { bodyMessage, guardedRequest, readFailure } from "./response.js";

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
  | { readonly kind: "transport-failure"; readonly detail?: string };

const failureTail = (response: GitHubResponse): FailureTail => {
  const failure = readFailure(response);
  return failure.kind === "refused"
    ? { kind: "refused", reason: failure.reason, detail: failure.detail }
    : failure;
};

/** Whether the create refusal is the duplicate-create answer: the
 *  `already_exists` code rides the body's `errors` array (the REST
 *  contract's shape) or the message itself. The anchor is the observed
 *  wire shape, not the reference page — which documents the endpoint's
 *  422 only as "Validation failed, or the endpoint has been spammed". */
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
 *  the provider's own words. `already_exists` is the duplicate-create
 *  answer observed on the wire: the write raced another publisher (or
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

/** Every transport call this unit makes crosses the one guarded
 *  boundary (issue #179; D53): the transport is caller-injected — the
 *  one component the adapter does not own — so its exception must never
 *  escape the doors past the no-throw law (ADR-0010 decision 7). A
 *  thrown transport arrives as status 0, whose reading is this unit's
 *  existing classification: `transport-failure` on a read (nothing has
 *  landed), `ambiguous` on the create (a response lost mid-write may
 *  have landed — §2.3). */
const request = (
  transport: GitHubTransport,
  path: string,
  init?: GitHubRequestInit,
): GitHubResponse => guardedRequest(transport, path, init);
const refPath = (credentials: GitHubCredentials, tag: string): string =>
  `/repos/${credentials.owner}/${credentials.repo}/git/refs/tags/${encodeURIComponent(tag)}`;

/** The git-ref response's object sha — what origin holds the tag at.
 *  The engine mints lightweight tags (the mint door's `--no-sign`), so
 *  the ref's object is the commit itself, and the sha compares directly
 *  against the binding's recorded target; a response without it is no
 *  observation (the transport-failure class, like a release read's
 *  unreadable body). */
const tagRefSha = (body: string): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    "object" in parsed &&
    typeof parsed.object === "object" &&
    parsed.object !== null &&
    "sha" in parsed.object &&
    typeof parsed.object.sha === "string"
  ) {
    return parsed.object.sha.length > 0 ? parsed.object.sha : undefined;
  }
  return undefined;
};

/** The verdict the create's precondition reads (issue #338): the remote
 *  git ref for the tag is observed against the binding's recorded
 *  target before any write — a release may only be created over the tag
 *  origin already holds at the recorded commit (GitHub's create-release
 *  API otherwise creates a missing tag at the default branch's HEAD).
 *  `proceed` is exactly "200 naming the recorded target". The ref's 404
 *  is discriminated before it is claimed (#176's discipline): the
 *  repository probe decides the determinate `release-tag-missing` over
 *  an observable repository, the probe's own refusal otherwise. Any
 *  other status is the read tail's one taxonomy. */
type TagRefVerdict =
  | { readonly kind: "proceed" }
  | { readonly kind: "refused"; readonly reason: RefusalReason; readonly detail: string }
  | { readonly kind: "transport-failure"; readonly detail?: string };

const tagRefVerdict = (
  transport: GitHubTransport,
  credentials: GitHubCredentials,
  tag: string,
  recordedTarget: string,
): TagRefVerdict => {
  const ref = request(transport, refPath(credentials, tag));
  if (ref.status === 200) {
    const sha = tagRefSha(ref.body);
    if (sha === undefined) {
      return { kind: "transport-failure" };
    }
    return sha === recordedTarget
      ? { kind: "proceed" }
      : {
          kind: "refused",
          reason: "release-tag-mismatch",
          detail: `origin holds the tag ${tag} at ${sha}, not the recorded target ${recordedTarget}`,
        };
  }
  if (ref.status === 404) {
    const probe = request(transport, repoPath(credentials));
    if (probe.status === 200) {
      return {
        kind: "refused",
        reason: "release-tag-missing",
        detail: `origin holds no tag ${tag} — the recorded target ${recordedTarget} is unpushed`,
      };
    }
    return failureTail(probe);
  }
  return failureTail(ref);
};

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
/** The binding's recorded target for the tag (issue #338): the commit
 *  the recorded mint names — the truth the remote git ref is asserted
 *  against, the sync's own push its resolution. A tag the binding
 *  records no ref for is the recorded-state gap class
 *  (`changelog-unrecorded`): unreachable through the engine, whose
 *  doors mint before publishing, but a determinate refusal at the
 *  boundary all the same. */
const recordedTagTarget = (
  binding: GitBinding,
  tag: string,
):
  | { readonly ok: true; readonly target: string }
  | { readonly ok: false; readonly reason: RefusalReason; readonly detail: string } => {
  for (const row of binding.refs.tags()) {
    if (row.ref === `refs/tags/${tag}`) {
      return { ok: true, target: row.target };
    }
  }
  return {
    ok: false,
    reason: "changelog-unrecorded",
    detail: `the binding records no tag ref refs/tags/${tag}`,
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
      const existing = request(transport, releasePath(credentials, tag));
      if (existing.status === 200) {
        const url = releaseUrl(existing.body);
        const remoteBody = releaseBody(existing.body);
        if (url === undefined || remoteBody === undefined) {
          return { kind: "transport-failure" };
        }
        if (remoteBody !== recorded.body) {
          return {
            kind: "refused",
            reason: "release-conflict",
            detail: `the remote release for ${tag} does not match the recorded changelog (${recorded.digest})`,
          };
        }
        // The satisfied-release path re-asserts the recorded tag before
        // returning ok (audit §10 ground truth 2b): a release whose tag
        // no longer answers the binding's recorded target is not the
        // recorded publication — the ok the engine would refuse at the
        // verify half anyway, refused here so the port's ok stands
        // alone. A moved or deleted tag is this gate's own refusal,
        // never a silent acceptance.
        const reassertTarget = recordedTagTarget(binding, tag);
        if (!reassertTarget.ok) {
          return {
            kind: "refused",
            reason: reassertTarget.reason,
            detail: reassertTarget.detail,
          };
        }
        const reassert = tagRefVerdict(transport, credentials, tag, reassertTarget.target);
        if (reassert.kind !== "proceed") {
          return reassert;
        }
        return { kind: "ok", url };
      }
      if (existing.status !== 404) {
        return failureTail(existing);
      }
      // The create's precondition (issue #338): the release may only be
      // created over a tag origin already holds at the recorded commit —
      // GitHub's create-release API otherwise creates the missing tag at
      // the default branch's HEAD, the wrong-commit hazard. The binding's
      // recorded target is the truth the sync pushes; the remote git ref
      // must answer exactly it, or the create never fires.
      const recordedTarget = recordedTagTarget(binding, tag);
      if (!recordedTarget.ok) {
        return { kind: "refused", reason: recordedTarget.reason, detail: recordedTarget.detail };
      }
      const gate = tagRefVerdict(transport, credentials, tag, recordedTarget.target);
      if (gate.kind !== "proceed") {
        return gate;
      }
      // The create: the one write this unit performs. A lost response is
      // ambiguous, never a silent success (§2.3) — status 0 after the
      // write is that class. A determinate answer classifies: a 404 is
      // the unobservable repository (#176) — the write landed nothing;
      // a 422 or 409 is the provider's determinate refusal of the
      // create (#178) — `already_exists` is its duplicate-create
      // answer, observed on the wire, the benign race-loss the
      // idempotent re-run resolves;
      // the credential and rate-limit shapes are the read tail's.
      const created = request(
        transport,
        `/repos/${credentials.owner}/${credentials.repo}/releases`,
        {
          method: "POST",
          body: JSON.stringify({
            tag_name: tag,
            name: tag,
            body: recorded.body,
            target_commitish: recordedTarget.target,
          }),
          headers: { "Content-Type": "application/json" },
        },
      );
      if (created.status === 201) {
        const url = releaseUrl(created.body);
        if (url === undefined) {
          return { kind: "transport-failure" };
        }
        // The post-create re-assert (audit §10 ground truth 2a): the
        // gate's read and the create's POST are separate requests, and a
        // tag moved between them mints the release over the moved commit
        // — the wrong-commit hazard #338 closed, reachable once more
        // through this window. The create returned 201, so the write
        // determinately landed; whether it landed over the recorded tag
        // is now re-read before ok. A determinate divergence is the
        // refusal naming it (the release exists — the operator sees
        // both sides); an unreadable re-assert is the ambiguous window
        // (201 seen, tag state unknown — the idempotent re-run's
        // satisfied-path gate resolves it on resume).
        const reassert = tagRefVerdict(transport, credentials, tag, recordedTarget.target);
        if (reassert.kind === "proceed") {
          return { kind: "ok", url };
        }
        if (reassert.kind === "refused") {
          return {
            kind: "refused",
            reason: reassert.reason,
            detail: `the release for ${tag} was created, but ${reassert.detail}`,
          };
        }
        return reassert.detail === undefined
          ? { kind: "ambiguous" }
          : { kind: "ambiguous", detail: reassert.detail };
      }
      if (created.status === 0) {
        // The ambiguous window stays the class (the write may have
        // landed unseen); the thrown transport's words — a synthesized
        // status 0 carries them — ride the outcome's detail for the
        // debugging operator (issue #179; round-1 review minor 3).
        const thrown = bodyMessage(created.body);
        return thrown === undefined ? { kind: "ambiguous" } : { kind: "ambiguous", detail: thrown };
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
      const existing = request(transport, releasePath(credentials, tag));
      if (existing.status === 404) {
        // D28's absence, discriminated before it is claimed (#176): a
        // 404 also answers a repository this credential cannot observe.
        // The repository probe decides — over an observable repository
        // the absence is the determinate read (the publication has not
        // landed; the caller's action is the idempotent create); over
        // an unobservable one nothing was observed, and the probe's own
        // refusal (`unobservable-remote` on its 404) says so.
        const probe = request(transport, repoPath(credentials));
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
      if (remoteBody !== recorded.body) {
        return {
          kind: "refused",
          reason: "release-conflict",
          detail: `the remote release for ${tag} does not match the recorded changelog (${recorded.digest})`,
        };
      }
      // The verification asserts the tag too (issue #338): a release
      // whose body matches while origin holds the tag elsewhere (or not
      // at all) is not the recorded publication verified — the same
      // precondition the create's gate ran, the same verdicts.
      const recordedTarget = recordedTagTarget(binding, tag);
      if (!recordedTarget.ok) {
        return { kind: "refused", reason: recordedTarget.reason, detail: recordedTarget.detail };
      }
      const gate = tagRefVerdict(transport, credentials, tag, recordedTarget.target);
      if (gate.kind !== "proceed") {
        return gate;
      }
      return { kind: "verified" };
    },
  };
}
