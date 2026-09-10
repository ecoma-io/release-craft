/**
 * The reconciliation over a real repository and a test-owned transport
 * (the Phase 9 contract §4, scenarios 10–17; ADR-0010 decision 8 as
 * amended by issues #66 / D30 and #68 / D32): the remote is compared
 * against the binding's recorded state — a matching tag is verified, an
 * unrecorded tag or release is a reported divergence, a listing that
 * never became usable claims nothing, a listing is observed across its
 * pagination to the provider-declared end — and nothing the remote
 * holds is ever resolved into the binding (the binding is the truth).
 */

import { describe, expect, it } from "vitest";

import {
  openGitHubAdapter,
  type GitHubCredentials,
  type GitHubRequestInit,
  type GitHubResponse,
  type GitHubTransport,
  type ReconciliationReport,
} from "@ecoma-io/release-craft/__internal__/adapters/github/index.js";
import {
  openGitBinding,
  type GitTagNaming,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import type { Claim, ClaimDenied, ClaimScope } from "../../../src/index.js";
import { createTempRepo } from "../git/temp-repo.js";

const credentials: GitHubCredentials = {
  owner: "ecoma-io",
  repo: "release-craft",
  token: "t0k3n",
};

const ATTEMPT = "attempt_sha256:reconcile-a";

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

const tagRow = (name: string, sha: string): unknown => ({ name, commit: { sha } });
const releaseRow = (tagName: string): unknown => ({ tag_name: tagName });

const listResponse = (rows: readonly unknown[]): GitHubResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(rows),
});

const rawResponse = (
  status: number,
  headers: Readonly<Record<string, string>>,
  body: string,
): GitHubResponse => ({
  status,
  headers,
  body,
});

/** A fixture whose binding has minted `v1.2.3` at a deterministic
 *  commit; `tags` hands the recorded target for building remote
 *  listings that match or drift from it. */
interface ReconcileFixture {
  readonly recordedTarget: string;
  reconcile(transport: GitHubTransport): ReconciliationReport;
  recordedRefs(): readonly string[];
}

const withReconcileRepo = (_name: string, fn: (fixture: ReconcileFixture) => void): void => {
  const temp = createTempRepo();
  try {
    let binding: ReturnType<typeof openGitBinding> | undefined;
    const opened = (): ReturnType<typeof openGitBinding> => {
      binding ??= openGitBinding({ repo: temp.repo, tagNaming: naming });
      return binding;
    };
    temp.git(["commit", "--allow-empty", "-m", "fixture: the recorded release"]);
    const target = temp.git(["rev-parse", "HEAD"]).trim();
    const claim = asClaim(
      opened().claims.acquire(
        { kind: "stable-version", lineId: "line-main", version: "1.2.3" },
        ATTEMPT,
      ),
    );
    const minted = opened().mintTag({
      attemptId: ATTEMPT,
      token: claim.token,
      tag: "v1.2.3",
      target,
    });
    if (minted.kind !== "minted") {
      throw new Error(`expected the mint to land, got ${minted.kind}`);
    }
    fn({
      recordedTarget: target,
      reconcile(transport) {
        return openGitHubAdapter(opened(), credentials, transport).reconcile();
      },
      recordedRefs() {
        return [...opened().refs.claims(), ...opened().refs.tags()].map(
          (row) => `${row.ref} ${row.target}`,
        );
      },
    });
  } finally {
    temp.cleanup();
  }
};

describe("the release reconciliation (§4 scenarios 10–16; ADR-0010 decision 8, D30)", () => {
  it("R-10 — a remote that matches the binding's records shows no divergence", () => {
    withReconcileRepo("clean", (fixture) => {
      const { transport, calls } = fakeTransport((call) =>
        call.path.includes("/tags")
          ? listResponse([tagRow("v1.2.3", fixture.recordedTarget)])
          : listResponse([releaseRow("v1.2.3")]),
      );
      const report = fixture.reconcile(transport);
      expect(report.tags).toEqual({
        state: "listed",
        listed: 1,
        pagination: "complete",
        divergences: [],
        verifiedTags: ["v1.2.3"],
      });
      expect(report.releases).toEqual({
        state: "listed",
        listed: 1,
        pagination: "complete",
        divergences: [],
      });
      expect(calls.map((call) => call.path)).toEqual([
        "/repos/ecoma-io/release-craft/tags?per_page=100",
        "/repos/ecoma-io/release-craft/releases?per_page=100",
      ]);
    });
  });

  it("R-11 — a remote tag the binding has no record of is unadopted", () => {
    withReconcileRepo("unadopted-tag", (fixture) => {
      const { transport } = fakeTransport((call) =>
        call.path.includes("/tags")
          ? listResponse([
              tagRow("v1.2.3", fixture.recordedTarget),
              tagRow("v9.9.9", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            ])
          : listResponse([]),
      );
      const report = fixture.reconcile(transport);
      expect(report.tags).toEqual({
        state: "listed",
        listed: 2,
        pagination: "complete",
        verifiedTags: ["v1.2.3"],
        divergences: [
          {
            kind: "unadopted-tag",
            tag: "v9.9.9",
            detail: expect.any(String) as string,
          },
        ],
      });
      expect(report.releases).toEqual({
        state: "listed",
        listed: 0,
        pagination: "complete",
        divergences: [],
      });
    });
  });

  it("R-12 — a remote release for an unrecorded tag is unadopted", () => {
    withReconcileRepo("unadopted-release", (fixture) => {
      const { transport } = fakeTransport((call) =>
        call.path.includes("/tags")
          ? listResponse([tagRow("v1.2.3", fixture.recordedTarget)])
          : listResponse([releaseRow("v1.2.3"), releaseRow("v3.1.4")]),
      );
      const report = fixture.reconcile(transport);
      expect(report.tags).toEqual({
        state: "listed",
        listed: 1,
        pagination: "complete",
        divergences: [],
        verifiedTags: ["v1.2.3"],
      });
      expect(report.releases).toEqual({
        state: "listed",
        listed: 2,
        pagination: "complete",
        divergences: [
          {
            kind: "unadopted-release",
            tag: "v3.1.4",
            detail: expect.any(String) as string,
          },
        ],
      });
    });
  });

  it("a remote tag at a target the binding does not record is a divergence, never a silent match", () => {
    withReconcileRepo("drifted-target", (fixture) => {
      const drifted = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const { transport } = fakeTransport((call) =>
        call.path.includes("/tags") ? listResponse([tagRow("v1.2.3", drifted)]) : listResponse([]),
      );
      const report = fixture.reconcile(transport);
      if (report.tags.state !== "listed") {
        throw new Error(`expected the tag listing to complete, got ${report.tags.state}`);
      }
      expect(report.tags.verifiedTags).toEqual([]);
      expect(report.tags.divergences).toHaveLength(1);
      expect(report.tags.divergences[0]?.kind).toBe("unadopted-tag");
      expect(report.tags.divergences[0]?.detail).toContain(drifted);
      expect(report.tags.divergences[0]?.detail).toContain(fixture.recordedTarget);
    });
  });

  it("reconcile resolves nothing into the binding — the refs survive a drifted remote unchanged", () => {
    withReconcileRepo("no-write", (fixture) => {
      const before = fixture.recordedRefs();
      const { transport } = fakeTransport((call) =>
        call.path.includes("/tags")
          ? listResponse([
              tagRow("v1.2.3", fixture.recordedTarget),
              tagRow("v9.9.9", "cccccccccccccccccccccccccccccccccccccccc"),
            ])
          : listResponse([releaseRow("v9.9.9")]),
      );
      const report = fixture.reconcile(transport);
      if (report.tags.state !== "listed" || report.releases.state !== "listed") {
        throw new Error("expected both listings to complete");
      }
      expect(report.tags.divergences).toHaveLength(1);
      expect(report.releases.divergences).toHaveLength(1);
      expect(fixture.recordedRefs()).toEqual(before);
    });
  });

  it("R-15 — an unreachable remote (status 0) is a transport failure that claims no comparison", () => {
    withReconcileRepo("unreachable", (fixture) => {
      const { transport } = fakeTransport((call) =>
        call.path.includes("/tags") ? rawResponse(0, {}, "") : listResponse([releaseRow("v9.9.9")]),
      );
      const report = fixture.reconcile(transport);
      expect(report.tags).toEqual({ state: "transport-failure" });
      // The sibling's completed observation stands — one listing's
      // failure never demotes the other's comparison.
      expect(report.releases).toEqual({
        state: "listed",
        listed: 1,
        pagination: "complete",
        divergences: [
          {
            kind: "unadopted-release",
            tag: "v9.9.9",
            detail: expect.any(String) as string,
          },
        ],
      });
    });
  });

  it("R-15 — a status the read did not want is a transport failure, on either listing", () => {
    withReconcileRepo("server-error", (fixture) => {
      const { transport } = fakeTransport((call) =>
        call.path.includes("/tags")
          ? listResponse([tagRow("v1.2.3", fixture.recordedTarget)])
          : rawResponse(500, {}, "{}"),
      );
      const report = fixture.reconcile(transport);
      expect(report.tags).toEqual({
        state: "listed",
        listed: 1,
        pagination: "complete",
        divergences: [],
        verifiedTags: ["v1.2.3"],
      });
      expect(report.releases).toEqual({ state: "transport-failure" });
    });
  });

  it("R-15 — a body that is not a list is an unexpected response, never an empty listing", () => {
    withReconcileRepo("not-a-list", (fixture) => {
      const { transport } = fakeTransport((call) =>
        call.path.includes("/tags")
          ? rawResponse(200, {}, '{"message":"moved"}')
          : listResponse([]),
      );
      const report = fixture.reconcile(transport);
      expect(report.tags).toEqual({ state: "transport-failure" });
    });
  });

  it("R-15 — a body that is not JSON is an unexpected response", () => {
    withReconcileRepo("not-json", (fixture) => {
      const { transport } = fakeTransport((call) =>
        call.path.includes("/tags") ? rawResponse(200, {}, "<html>oops</html>") : listResponse([]),
      );
      const report = fixture.reconcile(transport);
      expect(report.tags).toEqual({ state: "transport-failure" });
    });
  });

  it("R-15 — a lying row (a compared field that is not a string) unclaims the whole listing", () => {
    withReconcileRepo("lying-row", (fixture) => {
      const { transport } = fakeTransport((call) =>
        call.path.includes("/tags")
          ? listResponse([
              tagRow("v1.2.3", fixture.recordedTarget),
              { name: 42, commit: { sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" } },
            ])
          : listResponse([{ tag_name: 7 }]),
      );
      const report = fixture.reconcile(transport);
      // No partial comparison: the listing is unclaimed entire, so the
      // matched first row claims no verification either.
      expect(report.tags).toEqual({ state: "transport-failure" });
      expect(report.releases).toEqual({ state: "transport-failure" });
    });
  });

  it("R-15 — a row that is not an object is a transport failure, never a throw", () => {
    withReconcileRepo("null-row", (fixture) => {
      const { transport } = fakeTransport((call) =>
        call.path.includes("/tags")
          ? listResponse([tagRow("v1.2.3", fixture.recordedTarget), null])
          : listResponse([null, releaseRow("v9.9.9")]),
      );
      const report = fixture.reconcile(transport);
      expect(report.tags).toEqual({ state: "transport-failure" });
      expect(report.releases).toEqual({ state: "transport-failure" });
    });
  });

  it("R-16 — a rate-limited listing is a refusal carrying the reset timestamp (decision 9)", () => {
    withReconcileRepo("rate-limited", (fixture) => {
      const { transport } = fakeTransport((call) =>
        call.path.includes("/tags")
          ? rawResponse(
              429,
              { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" },
              "{}",
            )
          : listResponse([]),
      );
      const report = fixture.reconcile(transport);
      expect(report.tags).toEqual({
        state: "refused",
        reason: "rate-limited",
        detail: expect.stringContaining("resets at 1700000000") as string,
      });
      expect(report.releases).toEqual({
        state: "listed",
        listed: 0,
        pagination: "complete",
        divergences: [],
      });
    });
  });

  it("R-16 — a 403 with the rate-limit budget spent is rate-limited, the same limit under the other status", () => {
    withReconcileRepo("rate-limited-403", (fixture) => {
      const { transport } = fakeTransport((call) =>
        call.path.includes("/tags")
          ? listResponse([])
          : rawResponse(403, { "x-ratelimit-remaining": " 0" }, "{}"),
      );
      const report = fixture.reconcile(transport);
      expect(report.tags).toEqual({
        state: "listed",
        listed: 0,
        pagination: "complete",
        divergences: [],
        verifiedTags: [],
      });
      expect(report.releases).toEqual({
        state: "refused",
        reason: "rate-limited",
        detail: "the API's rate limit is exhausted",
      });
    });
  });

  it("R-16 — a rejected credential is an auth-expired refusal on the listing", () => {
    withReconcileRepo("auth-expired", (fixture) => {
      const { transport } = fakeTransport((call) =>
        call.path.includes("/tags") ? listResponse([]) : rawResponse(401, {}, "{}"),
      );
      const report = fixture.reconcile(transport);
      expect(report.tags).toEqual({
        state: "listed",
        listed: 0,
        pagination: "complete",
        divergences: [],
        verifiedTags: [],
      });
      expect(report.releases).toEqual({
        state: "refused",
        reason: "auth-expired",
        detail: expect.stringContaining("401") as string,
      });
    });
  });

  it("an empty listing is a determinate clean observation, not a failure (D28's listing twin)", () => {
    withReconcileRepo("empty", (fixture) => {
      const { transport } = fakeTransport((call) =>
        call.path.includes("/tags") ? listResponse([]) : listResponse([]),
      );
      const report = fixture.reconcile(transport);
      expect(report.tags).toEqual({
        state: "listed",
        listed: 0,
        pagination: "complete",
        divergences: [],
        verifiedTags: [],
      });
      expect(report.releases).toEqual({
        state: "listed",
        listed: 0,
        pagination: "complete",
        divergences: [],
      });
    });
  });

  it("R-17 — a listing exceeding one page is followed across its pagination, never truncated at page one (issue #68)", () => {
    withReconcileRepo("paginated-tags", (fixture) => {
      const { transport, calls } = fakeTransport((call) =>
        call.path.includes("/tags")
          ? call.path.includes("page=2")
            ? listResponse([tagRow("v9.9.9", "cccccccccccccccccccccccccccccccccccccccc")])
            : rawResponse(
                200,
                {
                  link: `</repos/ecoma-io/release-craft/tags?per_page=100&page=2>; rel="next"`,
                },
                JSON.stringify([tagRow("v1.2.3", fixture.recordedTarget)]),
              )
          : listResponse([releaseRow("v1.2.3")]),
      );
      const report = fixture.reconcile(transport);
      // Both pages of the tag listing were followed; the second page's
      // unadopted tag is reported — never silently truncated away.
      expect(report.tags).toEqual({
        state: "listed",
        listed: 2,
        pagination: "complete",
        verifiedTags: ["v1.2.3"],
        divergences: [
          {
            kind: "unadopted-tag",
            tag: "v9.9.9",
            detail: expect.any(String) as string,
          },
        ],
      });
      expect(report.releases).toEqual({
        state: "listed",
        listed: 1,
        pagination: "complete",
        divergences: [],
      });
      expect(calls.map((call) => call.path)).toContain(
        "/repos/ecoma-io/release-craft/tags?per_page=100&page=2",
      );
    });
  });

  it("R-17 — a paginated release listing is followed across its pages", () => {
    withReconcileRepo("paginated-releases", (fixture) => {
      const { transport, calls } = fakeTransport((call) =>
        call.path.includes("/tags")
          ? listResponse([tagRow("v1.2.3", fixture.recordedTarget)])
          : call.path.includes("page=2")
            ? listResponse([releaseRow("v3.1.4")])
            : rawResponse(
                200,
                {
                  link: `</repos/ecoma-io/release-craft/releases?per_page=100&page=2>; rel="next"`,
                },
                JSON.stringify([releaseRow("v1.2.3"), releaseRow("v9.9.9")]),
              ),
      );
      const report = fixture.reconcile(transport);
      expect(report.releases).toEqual({
        state: "listed",
        listed: 3,
        pagination: "complete",
        divergences: [
          {
            kind: "unadopted-release",
            tag: "v3.1.4",
            detail: expect.any(String) as string,
          },
          {
            kind: "unadopted-release",
            tag: "v9.9.9",
            detail: expect.any(String) as string,
          },
        ],
      });
      expect(calls.map((call) => call.path)).toContain(
        "/repos/ecoma-io/release-craft/releases?per_page=100&page=2",
      );
    });
  });

  it("R-17 — a follow-up page that fails unclaims the whole listing, never a partial comparison (issue #68)", () => {
    withReconcileRepo("fail-on-page-two", (fixture) => {
      const { transport, calls } = fakeTransport((call) =>
        call.path.includes("/tags")
          ? call.path.includes("page=2")
            ? rawResponse(500, {}, "{}")
            : rawResponse(
                200,
                {
                  link: `</repos/ecoma-io/release-craft/tags?per_page=100&page=2>; rel="next"`,
                },
                JSON.stringify([tagRow("v1.2.3", fixture.recordedTarget)]),
              )
          : listResponse([releaseRow("v1.2.3")]),
      );
      const report = fixture.reconcile(transport);
      // Page one matched; page two failed. The listing never became a
      // complete usable observation — it claims nothing.
      expect(report.tags).toEqual({ state: "transport-failure" });
      expect(report.releases).toEqual({
        state: "listed",
        listed: 1,
        pagination: "complete",
        divergences: [],
      });
      expect(calls.map((call) => call.path)).toContain(
        "/repos/ecoma-io/release-craft/tags?per_page=100&page=2",
      );
    });
  });
});
