/**
 * The release publication over a real repository and a test-owned
 * transport (the Phase 9 contract §2.2, rows 4–6 and 8–9, 13; §2.8): a
 * release is created with the binding's recorded changelog body, a
 * retry verifies the match and writes nothing, a diverged remote is the
 * recorded `release-conflict` decision — and every failure class
 * arrives as a returned outcome, never an exception.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  openGitHubAdapter,
  type GitHubAdapter,
  type GitHubCredentials,
  type GitHubRequestInit,
  type GitHubResponse,
  type GitHubTransport,
  type ReleaseOutcome,
  type VerificationOutcome,
} from "@ecoma-io/release-craft/__internal__/adapters/github/index.js";
import {
  openGitBinding,
  type GitBinding,
  type GitRun,
  type GitTagNaming,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import type { Claim, ClaimDenied, ClaimScope } from "../../../src/index.js";
import { createTempRepo } from "../git/temp-repo.js";

const CHANGELOG_BODY = "# v1.2.3\n\n- the recorded changelog\n";
const TAG = "v1.2.3";
const ATTEMPT = "attempt_sha256:publish-a";
const RELEASE_URL = "https://github.com/ecoma-io/release-craft/releases/tags/v1.2.3";
const RELEASE_PATH = "/repos/ecoma-io/release-craft/releases/tags/v1.2.3";
const REPO_PATH = "/repos/ecoma-io/release-craft";

const credentials: GitHubCredentials = {
  owner: "ecoma-io",
  repo: "release-craft",
  token: "t0k3n",
};

const naming: GitTagNaming = {
  namespaces: ["v"],
  tagFor: (scope: ClaimScope): string | null => {
    if (scope.kind !== "stable-version") {
      return null;
    }
    return `v${scope.version}`;
  },
};

const asClaim = (outcome: Claim | ClaimDenied): Claim => {
  if (outcome.kind !== "claim") {
    throw new Error(`expected a claim, got a denial by ${String(outcome.holder)}`);
  }
  return outcome;
};

/** One transport call, exactly as the unit issued it. */
interface Call {
  readonly path: string;

  readonly init?: GitHubRequestInit;
}
/** The vitest asymmetric matcher arrives typed `any`; routing it
 *  through this helper keeps the refusal expectations lint-clean. */
const detailContaining = (fragment: string): string => expect.stringContaining(fragment) as string;

/** The transport the tests own: canned responses per GET/POST, with the
 *  call log the assertions read (the no-write claims are about calls,
 *  so the log is the evidence). */
const fakeTransport = (
  handler: (call: Call) => GitHubResponse,
): { transport: GitHubTransport; calls: Call[] } => {
  const calls: Call[] = [];
  return {
    calls,
    transport: {
      request(path, init) {
        const call: Call = init === undefined ? { path } : { path, init };
        calls.push(call);
        return handler(call);
      },
    },
  };
};

const okResponse = (remoteBody: string): GitHubResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify({ html_url: RELEASE_URL, body: remoteBody }),
});

const notFoundResponse = (): GitHubResponse => ({
  status: 404,
  headers: {},
  body: JSON.stringify({ message: "Not Found" }),
});

const observableRepoResponse = (): GitHubResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify({ full_name: "ecoma-io/release-craft" }),
});

const createdResponse = (): GitHubResponse => ({
  status: 201,
  headers: {},
  body: JSON.stringify({ html_url: RELEASE_URL }),
});

interface PublicationRepo {
  readonly repo: string;
  readonly git: GitRun;
  binding(): GitBinding;
  adapter(transport: GitHubTransport): GitHubAdapter;
}

const withPublicationRepo = (_name: string, fn: (fixture: PublicationRepo) => void): void => {
  const temp = createTempRepo();
  try {
    let opened: GitBinding | undefined;
    fn({
      repo: temp.repo,
      git: temp.git,
      binding() {
        opened ??= openGitBinding({ repo: temp.repo, tagNaming: naming });
        return opened;
      },
      adapter(transport: GitHubTransport): GitHubAdapter {
        return openGitHubAdapter(this.binding(), credentials, transport);
      },
    });
  } finally {
    temp.cleanup();
  }
};

/** Records the claim, the changelog generation, and the minted tag —
 *  the §2.8 derivation's whole chain. `withChangelog: false` records
 *  the generation over a tree that holds no CHANGELOG.md. */
const seed = (fixture: PublicationRepo, withChangelog = true): void => {
  const binding = fixture.binding();
  const claim = asClaim(
    binding.claims.acquire(
      { kind: "stable-version", lineId: "line-main", version: "1.2.3" },
      ATTEMPT,
    ),
  );
  if (withChangelog) {
    writeFileSync(join(fixture.repo, "CHANGELOG.md"), CHANGELOG_BODY);
    fixture.git(["add", "CHANGELOG.md"]);
  }
  fixture.git(["commit", "--allow-empty", "-m", "fixture: the release content"]);
  const digest = `git-tree:${fixture.git(["rev-parse", "HEAD^{tree}"]).trim()}`;
  const attribution = { attemptId: ATTEMPT, actor: "fixture" };
  const started = binding.ledger.appendStart(
    {
      attemptId: ATTEMPT,
      planId: "plan-publish",
      planFingerprint: "plan_sha256:publish",
      state: "executing",
    },
    "artifact:changelog",
    attribution,
    digest,
  );
  binding.ledger.append({
    kind: "step",
    record: {
      ...started,
      to: "completed",
      contentFingerprint: digest,
      artifact: { kind: "changelog-notes", coordinates: "CHANGELOG.md", digest },
    },
  });
  const minted = binding.mintTag({
    attemptId: ATTEMPT,
    token: claim.token,
    tag: TAG,
    target: fixture.git(["rev-parse", "HEAD"]).trim(),
  });
  if (minted.kind !== "minted") {
    throw new Error(`expected the mint to land, got ${minted.kind}`);
  }
};

/** Records only the claim and the tag — the derivation's front half
 *  with no generation behind it. */
const seedWithoutGeneration = (fixture: PublicationRepo): void => {
  const binding = fixture.binding();
  const claim = asClaim(
    binding.claims.acquire(
      { kind: "stable-version", lineId: "line-main", version: "1.2.3" },
      ATTEMPT,
    ),
  );
  fixture.git(["commit", "--allow-empty", "-m", "fixture: no changelog"]);
  const minted = binding.mintTag({
    attemptId: ATTEMPT,
    token: claim.token,
    tag: TAG,
    target: fixture.git(["rev-parse", "HEAD"]).trim(),
  });
  if (minted.kind !== "minted") {
    throw new Error(`expected the mint to land, got ${minted.kind}`);
  }
};

describe("the release publication (§2.2 rows 4–6, 8–9, 13; §2.8)", () => {
  it("creates the release with the recorded changelog body (R-04)", () => {
    withPublicationRepo("create", (fixture) => {
      seed(fixture);
      const { transport, calls } = fakeTransport((call) =>
        call.init?.method === "POST" ? createdResponse() : notFoundResponse(),
      );
      const outcome: ReleaseOutcome = fixture.adapter(transport).publishRelease(TAG);
      expect(outcome).toEqual({ kind: "ok", url: RELEASE_URL });
      const posts = calls.filter((call) => call.init?.method === "POST");
      expect(posts).toHaveLength(1);
      const payload = JSON.parse(posts[0]?.init?.body ?? "{}") as {
        tag_name: string;
        body: string;
      };
      expect(payload.tag_name).toBe(TAG);
      expect(payload.body).toBe(CHANGELOG_BODY);
    });
  });

  it("retries as ok through the verify, writing nothing further (R-05)", () => {
    withPublicationRepo("retry", (fixture) => {
      seed(fixture);
      const { transport, calls } = fakeTransport(() => okResponse(CHANGELOG_BODY));
      const outcome = fixture.adapter(transport).publishRelease(TAG);
      expect(outcome).toEqual({ kind: "ok", url: RELEASE_URL });
      expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(0);
    });
  });

  it("refuses a remote release with a different body as the recorded conflict (R-06)", () => {
    withPublicationRepo("conflict", (fixture) => {
      seed(fixture);
      const { transport, calls } = fakeTransport(() =>
        okResponse("# v1.2.3\n\n- someone else's body\n"),
      );
      const outcome = fixture.adapter(transport).publishRelease(TAG);
      expect(outcome).toEqual({
        kind: "refused",
        reason: "release-conflict",
        detail: detailContaining("does not match the recorded changelog"),
      });
      expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(0);
    });
  });

  it("refuses a tag no recorded claim derives (§2.8)", () => {
    withPublicationRepo("no-claim", (fixture) => {
      seed(fixture);
      const { transport, calls } = fakeTransport(() => {
        throw new Error("the transport must not be reached");
      });
      const outcome = fixture.adapter(transport).publishRelease("v9.9.9");
      expect(outcome).toEqual({
        kind: "refused",
        reason: "changelog-unrecorded",
        detail: detailContaining("no recorded claim derives"),
      });
      expect(calls).toHaveLength(0);
    });
  });

  it("refuses when the holding attempt holds no completed changelog record (§2.8)", () => {
    withPublicationRepo("no-record", (fixture) => {
      seedWithoutGeneration(fixture);
      const { transport, calls } = fakeTransport(() => {
        throw new Error("the transport must not be reached");
      });
      const outcome = fixture.adapter(transport).publishRelease(TAG);
      expect(outcome).toEqual({
        kind: "refused",
        reason: "changelog-unrecorded",
        detail: detailContaining("holds no completed artifact:changelog record"),
      });
      expect(calls).toHaveLength(0);
    });
  });

  it("refuses when the recorded tree holds no CHANGELOG.md (§2.8)", () => {
    withPublicationRepo("no-file", (fixture) => {
      seed(fixture, false);
      const { transport, calls } = fakeTransport(() => {
        throw new Error("the transport must not be reached");
      });
      const outcome = fixture.adapter(transport).publishRelease(TAG);
      expect(outcome).toEqual({
        kind: "refused",
        reason: "changelog-unrecorded",
        detail: detailContaining("holds no CHANGELOG.md"),
      });
      expect(calls).toHaveLength(0);
    });
  });

  it("refuses a rate-limited read with the reset timestamp (row 8)", () => {
    withPublicationRepo("rate-limit", (fixture) => {
      seed(fixture);
      const { transport } = fakeTransport(() => ({
        status: 403,
        headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1757200000" },
        body: "",
      }));
      const outcome = fixture.adapter(transport).publishRelease(TAG);
      expect(outcome).toEqual({
        kind: "refused",
        reason: "rate-limited",
        detail: detailContaining("1757200000"),
      });
    });
  });

  it("refuses a secondary rate limit — a 403 with Retry-After and budget standing — as rate-limited, never auth-expired (#178)", () => {
    withPublicationRepo("secondary-rate-limit", (fixture) => {
      seed(fixture);
      const { transport } = fakeTransport(() => ({
        status: 403,
        headers: { "Retry-After": "57", "X-RateLimit-Remaining": "4998" },
        body: "",
      }));
      const outcome = fixture.adapter(transport).publishRelease(TAG);
      expect(outcome).toEqual({
        kind: "refused",
        reason: "rate-limited",
        detail: detailContaining("secondary rate limit is engaged; retry after 57 seconds"),
      });
    });
  });

  it("refuses a secondary rate limit that names itself in the body, with no Retry-After, as rate-limited (#178, review minor 2)", () => {
    // The rate-limits reference ("Exceeding the rate limit") documents
    // the secondary answer as "a `403` or `429` response and an error
    // message that indicates that you exceeded a secondary rate limit",
    // with `Retry-After` only conditionally present — the body's phrase
    // is the shape's other anchor, and its absence of a header must not
    // read as a permission denial.
    withPublicationRepo("secondary-rate-limit-phrase", (fixture) => {
      seed(fixture);
      const { transport } = fakeTransport(() => ({
        status: 403,
        headers: { "X-RateLimit-Remaining": "4998" },
        body: JSON.stringify({
          message:
            "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
        }),
      }));
      const outcome = fixture.adapter(transport).publishRelease(TAG);
      expect(outcome).toEqual({
        kind: "refused",
        reason: "rate-limited",
        detail: detailContaining(
          "secondary rate limit is engaged; wait at least one minute before retrying",
        ),
      });
    });
  });

  it("classifies a documented secondary response that carries a spent budget as rate-limited, primary-worded (review minor 1)", () => {
    // The reference documents a secondary response with
    // `x-ratelimit-remaining: 0`; the primary predicate reads it first —
    // the class is unchanged, and the detail names the spent budget.
    withPublicationRepo("secondary-with-spent-budget", (fixture) => {
      seed(fixture);
      const { transport } = fakeTransport(() => ({
        status: 403,
        headers: {
          "Retry-After": "57",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": "1757200000",
        },
        body: JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
      }));
      const outcome = fixture.adapter(transport).publishRelease(TAG);
      expect(outcome).toEqual({
        kind: "refused",
        reason: "rate-limited",
        detail: "the API's rate limit is exhausted; it resets at 1757200000",
      });
    });
  });

  it("classifies a secondary limit arriving as a 429 as rate-limited, primary-worded (review minor 1)", () => {
    // The reference documents the secondary answer as "a `403` or `429`
    // response"; a 429 reads through the primary predicate regardless of
    // its body's phrasing — the class and detail stay rate-limit ones.
    withPublicationRepo("secondary-as-429", (fixture) => {
      seed(fixture);
      const { transport } = fakeTransport(() => ({
        status: 429,
        headers: { "Retry-After": "30" },
        body: JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
      }));
      const outcome = fixture.adapter(transport).publishRelease(TAG);
      expect(outcome).toEqual({
        kind: "refused",
        reason: "rate-limited",
        detail: "the API's rate limit is engaged; retry after 30 seconds",
      });
    });
  });

  // The negative control for the phrase predicate: a 403 whose body
  // carries neither the secondary phrasing nor `Retry-After` — a
  // permission denial, never a rate limit (#178).
  it("refuses a valid credential's permission denial as permission-denied, never auth-expired (#178)", () => {
    withPublicationRepo("permission-denied", (fixture) => {
      seed(fixture);
      const { transport } = fakeTransport(() => ({
        status: 403,
        headers: { "X-RateLimit-Remaining": "4998" },
        body: JSON.stringify({ message: "Resource not accessible by personal access token" }),
      }));
      const outcome = fixture.adapter(transport).publishRelease(TAG);
      expect(outcome).toEqual({
        kind: "refused",
        reason: "permission-denied",
        detail: detailContaining("Resource not accessible by personal access token"),
      });
    });
  });

  it("refuses the raced create — 422 already_exists — as the recorded conflict, and the idempotent re-run resolves it (#178)", () => {
    withPublicationRepo("create-raced", (fixture) => {
      seed(fixture);
      let raced = false;
      const { transport, calls } = fakeTransport((call) => {
        if (call.init?.method === "POST") {
          raced = true;
          return {
            status: 422,
            headers: {},
            body: JSON.stringify({
              message: "Validation Failed",
              errors: [{ resource: "Release", code: "already_exists", field: "tag_name" }],
            }),
          };
        }
        return raced ? okResponse(CHANGELOG_BODY) : notFoundResponse();
      });
      const first = fixture.adapter(transport).publishRelease(TAG);
      expect(first).toEqual({
        kind: "refused",
        reason: "release-conflict",
        detail: detailContaining("already exists"),
      });
      if (first.kind !== "refused") {
        throw new Error(`expected a refusal, got ${first.kind}`);
      }
      expect(first.detail).toContain("raced another publisher");
      // The recorded conflict decision's caller action — the idempotent
      // re-run — resolves the race: the read finds the remote satisfied,
      // the bodies match, and no second create is ever issued.
      const second = fixture.adapter(transport).publishRelease(TAG);
      expect(second).toEqual({ kind: "ok", url: RELEASE_URL });
      expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(1);
    });
  });

  it("refuses any other determinate create refusal with the provider's own words, never the detail-less retryable class (#178)", () => {
    withPublicationRepo("create-validation", (fixture) => {
      seed(fixture);
      const { transport } = fakeTransport((call) =>
        call.init?.method === "POST"
          ? {
              status: 422,
              headers: {},
              body: JSON.stringify({
                message: "Validation Failed",
                errors: [{ resource: "Release", code: "missing_field", field: "tag_name" }],
              }),
            }
          : notFoundResponse(),
      );
      const outcome = fixture.adapter(transport).publishRelease(TAG);
      expect(outcome).toEqual({
        kind: "refused",
        reason: "release-conflict",
        detail: detailContaining("the provider refused the create (HTTP 422: Validation Failed)"),
      });
    });
  });

  it("refuses a create the provider answers 409 with as the conflict it is (#178)", () => {
    withPublicationRepo("create-conflict-409", (fixture) => {
      seed(fixture);
      const { transport } = fakeTransport((call) =>
        call.init?.method === "POST"
          ? { status: 409, headers: {}, body: JSON.stringify({ message: "Conflict" }) }
          : notFoundResponse(),
      );
      const outcome = fixture.adapter(transport).publishRelease(TAG);
      expect(outcome).toEqual({
        kind: "refused",
        reason: "release-conflict",
        detail: detailContaining("HTTP 409: Conflict"),
      });
    });
  });

  it("refuses an expired credential (row 9)", () => {
    withPublicationRepo("auth", (fixture) => {
      seed(fixture);
      const { transport } = fakeTransport(() => ({ status: 401, headers: {}, body: "" }));
      const outcome = fixture.adapter(transport).publishRelease(TAG);
      expect(outcome).toEqual({
        kind: "refused",
        reason: "auth-expired",
        detail: expect.any(String) as string,
      });
    });
  });

  it("reports a failed read as a transport failure (row 7)", () => {
    withPublicationRepo("read-failure", (fixture) => {
      seed(fixture);
      const { transport } = fakeTransport(() => ({ status: 0, headers: {}, body: "" }));
      const outcome = fixture.adapter(transport).publishRelease(TAG);
      expect(outcome).toEqual({ kind: "transport-failure" });
    });
  });

  it("reports a lost create response as ambiguous — the write may have landed (row 13)", () => {
    withPublicationRepo("ambiguous", (fixture) => {
      seed(fixture);
      const { transport } = fakeTransport((call) =>
        call.init?.method === "POST" ? { status: 0, headers: {}, body: "" } : notFoundResponse(),
      );
      const outcome = fixture.adapter(transport).publishRelease(TAG);
      expect(outcome).toEqual({ kind: "ambiguous" });
    });
  });

  it("verifies a matching remote release (R-05's verify half)", () => {
    withPublicationRepo("verify-ok", (fixture) => {
      seed(fixture);
      const { transport } = fakeTransport(() => okResponse(CHANGELOG_BODY));
      const outcome: VerificationOutcome = fixture.adapter(transport).verifyRelease(TAG);
      expect(outcome).toEqual({ kind: "verified" });
    });
  });

  it("refuses verification of a diverged release (R-06's verify half)", () => {
    withPublicationRepo("verify-conflict", (fixture) => {
      seed(fixture);
      const { transport } = fakeTransport(() => okResponse("# diverged\n"));
      const outcome = fixture.adapter(transport).verifyRelease(TAG);
      expect(outcome).toEqual({
        kind: "refused",
        reason: "release-conflict",
        detail: detailContaining("does not match the recorded changelog"),
      });
    });
  });

  it("reports a release that does not exist as absent, over a repository the read observed (row 60 / D28, #176)", () => {
    withPublicationRepo("verify-absent", (fixture) => {
      seed(fixture);
      const { transport, calls } = fakeTransport((call) =>
        call.path === REPO_PATH ? observableRepoResponse() : notFoundResponse(),
      );
      const outcome = fixture.adapter(transport).verifyRelease(TAG);
      expect(outcome).toEqual({ kind: "absent" });
      // The absence verdict is discriminated on the wire: the release
      // read 404'd, and the repository probe answered before `absent`
      // was claimed (issue #176).
      expect(calls.map((call) => call.path)).toEqual([RELEASE_PATH, REPO_PATH]);
    });
  });

  it("refuses a 404 the repository probe confirms as unobservable — never a determinate absence (#176)", () => {
    withPublicationRepo("verify-unobservable", (fixture) => {
      seed(fixture);
      const { transport, calls } = fakeTransport(() => notFoundResponse());
      const outcome = fixture.adapter(transport).verifyRelease(TAG);
      expect(outcome).toEqual({
        kind: "refused",
        reason: "unobservable-remote",
        detail: detailContaining("not visible to this credential"),
      });
      expect(calls.map((call) => call.path)).toEqual([RELEASE_PATH, REPO_PATH]);
    });
  });

  it("classifies the probe's own failures by the one table — an expired credential is auth-expired, not absence (#176)", () => {
    withPublicationRepo("verify-unobservable-auth", (fixture) => {
      seed(fixture);
      const { transport } = fakeTransport((call) =>
        call.path === REPO_PATH ? { status: 401, headers: {}, body: "" } : notFoundResponse(),
      );
      const outcome = fixture.adapter(transport).verifyRelease(TAG);
      expect(outcome).toEqual({
        kind: "refused",
        reason: "auth-expired",
        detail: expect.any(String) as string,
      });
    });
  });

  it("refuses a create against a repository the credential cannot observe — a determinate non-land, never a retryable loop (#176)", () => {
    withPublicationRepo("create-unobservable", (fixture) => {
      seed(fixture);
      const { transport } = fakeTransport(() => notFoundResponse());
      const outcome = fixture.adapter(transport).publishRelease(TAG);
      expect(outcome).toEqual({
        kind: "refused",
        reason: "unobservable-remote",
        detail: detailContaining("not visible to this credential"),
      });
    });
  });

  it("reports a failed verification read as a transport failure", () => {
    withPublicationRepo("verify-failure", (fixture) => {
      seed(fixture);
      const { transport } = fakeTransport(() => ({ status: 0, headers: {}, body: "" }));
      const outcome = fixture.adapter(transport).verifyRelease(TAG);
      expect(outcome).toEqual({ kind: "transport-failure" });
    });
  });

  it("treats an idempotency read that answers 200 with a non-release body as a transport failure, never an ok (row 7)", () => {
    withPublicationRepo("idempotency-malformed", (fixture) => {
      seed(fixture);
      const { transport, calls } = fakeTransport(() => ({
        status: 200,
        headers: {},
        body: JSON.stringify({ message: "moved" }),
      }));
      const outcome = fixture.adapter(transport).publishRelease(TAG);
      expect(outcome).toEqual({ kind: "transport-failure" });
      expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(0);
    });
  });

  it("never decides ok or conflict over a release whose URL the API did not deliver (§2.3)", () => {
    withPublicationRepo("url-missing", (fixture) => {
      seed(fixture);
      const { transport, calls } = fakeTransport(() => ({
        status: 200,
        headers: {},
        body: JSON.stringify({ body: CHANGELOG_BODY }),
      }));
      const outcome = fixture.adapter(transport).publishRelease(TAG);
      expect(outcome).toEqual({ kind: "transport-failure" });
      expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(0);
    });
  });

  it("treats a 200 read without a readable body as a transport failure, never verified", () => {
    withPublicationRepo("verify-malformed", (fixture) => {
      seed(fixture);
      const { transport } = fakeTransport(() => ({
        status: 200,
        headers: {},
        body: "<html>oops</html>",
      }));
      const outcome = fixture.adapter(transport).verifyRelease(TAG);
      expect(outcome).toEqual({ kind: "transport-failure" });
    });
  });

  it("reports a create that landed without a URL as a transport failure, never a silent ok (R-04's lie)", () => {
    withPublicationRepo("create-no-url", (fixture) => {
      seed(fixture);
      const { transport } = fakeTransport((call) =>
        call.init?.method === "POST"
          ? { status: 201, headers: {}, body: "{}" }
          : notFoundResponse(),
      );
      const outcome = fixture.adapter(transport).publishRelease(TAG);
      expect(outcome).toEqual({ kind: "transport-failure" });
    });
  });
});
