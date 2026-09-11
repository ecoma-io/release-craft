/**
 * The assembled adapter (the Phase 9 contract §2.6; ADR-0010 decision 2
 * as amended by #65): the factory composes the merged units behind the
 * §2.6 barrel, each door routed to its own unit, the injected transport
 * the only HTTP the adapter ever speaks. Since #177 (§2.9; D55) the
 * factory also owns the open-time identity agreement: it refuses to open
 * unless the binding's origin and the credentials name the same
 * repository — the pins here execute the issue's repro (the same-named
 * fork the token can write) as a refusal at open. The R-14 pin closes
 * the phase: the barrel's runtime surface is the factory and nothing
 * else. The composed sync door's pins live in `sync.test.ts`, whose
 * fixture origin now carries the credentials' identity.
 */

import * as github from "@ecoma-io/release-craft/__internal__/adapters/github/index.js";
import {
  openGitHubAdapter,
  type GitHubAdapter,
  type GitHubCredentials,
  type GitHubRequestInit,
  type GitHubResponse,
  type GitHubTransport,
} from "@ecoma-io/release-craft/__internal__/adapters/github/index.js";
import {
  GitFaultError,
  openGitBinding,
  type GitBinding,
  type GitRun,
  type GitTagNaming,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import type { Claim, ClaimDenied, ClaimScope } from "../../../src/index.js";
import { createTempRepo } from "../git/temp-repo.js";
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const credentials: GitHubCredentials = {
  owner: "ecoma-io",
  repo: "release-craft",
  token: "t0k3n",
};

const ATTEMPT = "attempt_sha256:assembly-a";

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

/** One transport call, exactly as the composed adapter issued it. */
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

const notFoundResponse = (): GitHubResponse => ({
  status: 404,
  headers: {},
  body: JSON.stringify({ message: "Not Found" }),
});

interface AdapterFixture {
  readonly repo: string;
  readonly git: GitRun;
  /** The memoized binding holding the attempt's claim. */
  binding(): GitBinding;
  /** Mints `v1.2.3` at `target` under the fixture's claim. */
  mint(target: string): void;
  adapter(transport: GitHubTransport): GitHubAdapter;
}

/** A fixture whose binding holds the claim for `1.2.3`; the tag and any
 *  changelog behind it are each test's own seed, on the same binding
 *  instance the doors then open over. */
const withAdapterRepo = (fn: (fixture: AdapterFixture) => void): void => {
  const temp = createTempRepo();
  try {
    let binding: GitBinding | undefined;
    const opened = (): GitBinding => {
      binding ??= openGitBinding({ repo: temp.repo, tagNaming: naming });
      return binding;
    };
    const claim = asClaim(
      opened().claims.acquire(
        { kind: "stable-version", lineId: "line-main", version: "1.2.3" },
        ATTEMPT,
      ),
    );
    fn({
      repo: temp.repo,
      git: temp.git,
      binding: opened,
      mint(target: string): void {
        const minted = opened().mintTag({
          attemptId: ATTEMPT,
          token: claim.token,
          tag: "v1.2.3",
          target,
        });
        if (minted.kind !== "minted") {
          throw new Error(`expected the mint to land, got ${minted.kind}`);
        }
      },
      adapter(transport: GitHubTransport) {
        return openGitHubAdapter(opened(), credentials, transport);
      },
    });
  } finally {
    temp.cleanup();
  }
};

/** The plain seed: an empty commit and the tag at it. */
const seedTag = (fixture: AdapterFixture): string => {
  fixture.git(["commit", "--allow-empty", "-m", "fixture: the release content"]);
  const target = fixture.git(["rev-parse", "HEAD"]).trim();
  fixture.mint(target);
  return target;
};

/** Records the changelog generation and the tag at its commit — the
 *  §2.8 derivation's whole chain, so the publication doors reach the
 *  transport instead of refusing on the recorded state alone. */
const seedChangelog = (fixture: AdapterFixture): string => {
  writeFileSync(join(fixture.repo, "CHANGELOG.md"), "# v1.2.3\n\n- the recorded changelog\n");
  fixture.git(["add", "CHANGELOG.md"]);
  fixture.git(["commit", "--allow-empty", "-m", "fixture: the release content"]);
  const digest = `git-tree:${fixture.git(["rev-parse", "HEAD^{tree}"]).trim()}`;
  const started = fixture.binding().ledger.appendStart(
    {
      attemptId: ATTEMPT,
      planId: "plan-publish",
      planFingerprint: "plan_sha256:publish",
      state: "executing",
    },
    "artifact:changelog",
    { attemptId: ATTEMPT, actor: "fixture" },
    digest,
  );
  fixture.binding().ledger.append({
    kind: "step",
    record: {
      ...started,
      to: "completed",
      contentFingerprint: digest,
      artifact: { kind: "changelog-notes", coordinates: "CHANGELOG.md", digest },
    },
  });
  const target = fixture.git(["rev-parse", "HEAD"]).trim();
  fixture.mint(target);
  return target;
};

describe("the assembled GitHub adapter (§2.6; #65)", () => {
  it("composes the publication doors: refusals precede the transport, verification reads it", () => {
    withAdapterRepo((fixture) => {
      seedChangelog(fixture);
      fixture.git(["remote", "add", "origin", "https://github.com/ecoma-io/release-craft.git"]);
      const { transport, calls } = fakeTransport((call) =>
        call.init?.method === "POST"
          ? { status: 201, headers: {}, body: "{}" }
          : call.path === "/repos/ecoma-io/release-craft"
            ? {
                status: 200,
                headers: {},
                body: JSON.stringify({ full_name: "ecoma-io/release-craft" }),
              }
            : notFoundResponse(),
      );
      // An unrecorded tag is refused from recorded state alone — no
      // remote read has anything to say about it.
      const refused = fixture.adapter(transport).publishRelease("v9.9.9");
      expect(refused).toMatchObject({ kind: "refused", reason: "changelog-unrecorded" });
      expect(calls).toHaveLength(0);
      // Verification of the recorded tag's absent release is a
      // determinate read through the transport (the D28 `absent`),
      // discriminated by the repository probe before it is claimed
      // (issue #176).
      const verified = fixture.adapter(transport).verifyRelease("v1.2.3");
      expect(verified).toEqual({ kind: "absent" });
      expect(calls.map((call) => call.path)).toEqual([
        "/repos/ecoma-io/release-craft/releases/tags/v1.2.3",
        "/repos/ecoma-io/release-craft",
      ]);
    });
  });

  it("composes the reconcile door: the drifted remote reads through both listings", () => {
    withAdapterRepo((fixture) => {
      const recordedTarget = seedTag(fixture);
      fixture.git(["remote", "add", "origin", "https://github.com/ecoma-io/release-craft.git"]);
      const { transport, calls } = fakeTransport((call) =>
        call.path.includes("/tags")
          ? listResponse([tagRow("v1.2.3", recordedTarget), tagRow("v9.9.9", "a".repeat(40))])
          : listResponse([releaseRow("v9.9.9")]),
      );
      const report = fixture.adapter(transport).reconcile();
      if (report.tags.state !== "listed") {
        throw new Error(`expected the tag listing to complete, got ${report.tags.state}`);
      }
      expect(report.tags.verifiedTags).toEqual(["v1.2.3"]);
      expect(
        report.tags.divergences.length +
          (report.releases.state === "listed" ? report.releases.divergences.length : 0),
      ).toBe(2);
      expect(calls.map((call) => call.path)).toEqual([
        "/repos/ecoma-io/release-craft/tags?per_page=100",
        "/repos/ecoma-io/release-craft/releases?per_page=100",
      ]);
    });
  });

  it("refuses to open when the origin names another repository — the same-named fork (#177)", () => {
    withAdapterRepo((fixture) => {
      seedTag(fixture);
      fixture.git(["remote", "add", "origin", "https://github.com/fork-owner/release-craft.git"]);
      const open = (): unknown =>
        fixture.adapter(fakeTransport(() => notFoundResponse()).transport);
      expect(open).toThrow(GitFaultError);
      expect(open).toThrow(/fork-owner\/release-craft/);
      expect(open).toThrow(/github\.com\/ecoma-io\/release-craft/);
    });
  });

  it("claims no exit status in the agreement's fault — the read itself succeeded (#177)", () => {
    withAdapterRepo((fixture) => {
      seedTag(fixture);
      fixture.git(["remote", "add", "origin", "https://github.com/fork-owner/release-craft.git"]);
      let fault: GitFaultError | undefined;
      try {
        fixture.adapter(fakeTransport(() => notFoundResponse()).transport);
      } catch (error) {
        fault = error as GitFaultError;
      }
      // The invocation succeeded (exit 0); the fault is the agreement's,
      // so no exit status is claimed — the message names both identities
      // and never dresses the refusal up as a failed read.
      expect(fault).toBeInstanceOf(GitFaultError);
      expect(fault?.status).toBeNull();
      expect(fault?.message).toContain("fork-owner/release-craft");
      expect(fault?.message).toContain("github.com/ecoma-io/release-craft");
      expect(fault?.message).not.toContain("exit 0");
    });
  });

  it("refuses to open when the origin names no github.com repository — a local path (#177)", () => {
    withAdapterRepo((fixture) => {
      seedTag(fixture);
      fixture.git(["remote", "add", "origin", fixture.repo]);
      const open = (): unknown =>
        fixture.adapter(fakeTransport(() => notFoundResponse()).transport);
      expect(open).toThrow(GitFaultError);
      expect(open).toThrow(/does not name a github\.com repository/);
    });
  });

  it("opens when the origin names the credentials' repository — no false refusal (#177)", () => {
    withAdapterRepo((fixture) => {
      seedChangelog(fixture);
      fixture.git(["remote", "add", "origin", "https://github.com/ecoma-io/release-craft.git"]);
      const { transport, calls } = fakeTransport((call) =>
        call.path === "/repos/ecoma-io/release-craft"
          ? {
              status: 200,
              headers: {},
              body: JSON.stringify({ full_name: "ecoma-io/release-craft" }),
            }
          : notFoundResponse(),
      );
      const adapter = fixture.adapter(transport);
      expect(adapter.verifyRelease("v1.2.3")).toEqual({ kind: "absent" });
      expect(calls.map((call) => call.path)).toEqual([
        "/repos/ecoma-io/release-craft/releases/tags/v1.2.3",
        "/repos/ecoma-io/release-craft",
      ]);
    });
  });

  it("opens over a differently cased spelling of the same repository (#177)", () => {
    withAdapterRepo((fixture) => {
      seedTag(fixture);
      fixture.git(["remote", "add", "origin", "https://GitHub.com/Ecoma-IO/Release-Craft.git"]);
      const { transport } = fakeTransport(() => notFoundResponse());
      expect(fixture.adapter(transport)).toBeDefined();
    });
  });

  it("opens with no origin configured — the sync's own fault stands at use time (#177)", () => {
    withAdapterRepo((fixture) => {
      seedChangelog(fixture);
      const { transport, calls } = fakeTransport(() => notFoundResponse());
      // Only one identity exists: the factory opens, the API doors read
      // the credentials' repository, and the unconfigured origin stays
      // the sync door's own GitFaultError (pinned in `sync.test.ts`).
      const outcome = fixture.adapter(transport).verifyRelease("v1.2.3");
      expect(outcome).toEqual({
        kind: "refused",
        reason: "unobservable-remote",
        detail: expect.any(String) as string,
      });
      expect(calls).toHaveLength(2);
    });
  });

  it("R-14 — the barrel's runtime surface is the factory and nothing else", () => {
    expect(Object.keys(github).sort()).toEqual(["openGitHubAdapter"]);
  });
});
