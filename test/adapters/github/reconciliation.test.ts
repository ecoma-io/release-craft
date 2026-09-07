/**
 * The reconciliation over a real repository and a test-owned transport
 * (the Phase 9 contract §4, scenarios 10–12; ADR-0010 decision 8): the
 * remote is compared against the binding's recorded state — a matching
 * tag is verified, an unrecorded tag or release is a reported
 * divergence, and nothing the remote holds is ever resolved into the
 * binding (the binding is the truth).
 */

import { describe, expect, it } from "vitest";

import {
  openGitHubAdapter,
  type GitHubCredentials,
  type GitHubRequestInit,
  type GitHubResponse,
  type GitHubTransport,
  type ReconciliationReport,
} from "../../../src/adapters/github/index.js";
import { openGitBinding, type GitTagNaming } from "../../../src/adapters/git/index.js";
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

describe("the release reconciliation (§4 scenarios 10–12; ADR-0010 decision 8)", () => {
  it("R-10 — a remote that matches the binding's records shows no divergence", () => {
    withReconcileRepo("clean", (fixture) => {
      const { transport, calls } = fakeTransport((call) =>
        call.path.includes("/tags")
          ? listResponse([tagRow("v1.2.3", fixture.recordedTarget)])
          : listResponse([releaseRow("v1.2.3")]),
      );
      const report = fixture.reconcile(transport);
      expect(report.divergences).toEqual([]);
      expect(report.verifiedTags).toEqual(["v1.2.3"]);
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
      expect(report.verifiedTags).toEqual(["v1.2.3"]);
      expect(report.divergences).toEqual([
        {
          kind: "unadopted-tag",
          tag: "v9.9.9",
          detail: expect.any(String) as string,
        },
      ]);
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
      expect(report.verifiedTags).toEqual(["v1.2.3"]);
      expect(report.divergences).toEqual([
        {
          kind: "unadopted-release",
          tag: "v3.1.4",
          detail: expect.any(String) as string,
        },
      ]);
    });
  });

  it("a remote tag at a target the binding does not record is a divergence, never a silent match", () => {
    withReconcileRepo("drifted-target", (fixture) => {
      const drifted = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const { transport } = fakeTransport((call) =>
        call.path.includes("/tags") ? listResponse([tagRow("v1.2.3", drifted)]) : listResponse([]),
      );
      const report = fixture.reconcile(transport);
      expect(report.verifiedTags).toEqual([]);
      expect(report.divergences).toHaveLength(1);
      expect(report.divergences[0]?.kind).toBe("unadopted-tag");
      expect(report.divergences[0]?.detail).toContain(drifted);
      expect(report.divergences[0]?.detail).toContain(fixture.recordedTarget);
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
      expect(report.divergences).toHaveLength(2);
      expect(fixture.recordedRefs()).toEqual(before);
    });
  });
});
