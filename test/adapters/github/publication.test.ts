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
} from "../../../src/adapters/github/index.js";
import {
  openGitBinding,
  type GitBinding,
  type GitRun,
  type GitTagNaming,
} from "../../../src/adapters/git/index.js";
import type { Claim, ClaimDenied, ClaimScope } from "../../../src/index.js";
import { createTempRepo } from "../git/temp-repo.js";

const CHANGELOG_BODY = "# v1.2.3\n\n- the recorded changelog\n";
const TAG = "v1.2.3";
const ATTEMPT = "attempt_sha256:publish-a";
const RELEASE_URL = "https://github.com/ecoma-io/release-craft/releases/tags/v1.2.3";

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

  it("reports a release that does not exist as absent (row 60 / D28)", () => {
    withPublicationRepo("verify-absent", (fixture) => {
      seed(fixture);
      const { transport } = fakeTransport(() => notFoundResponse());
      const outcome = fixture.adapter(transport).verifyRelease(TAG);
      expect(outcome).toEqual({ kind: "absent" });
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
});
