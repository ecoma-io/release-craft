/**
 * The failure classifier's own pins (the Phase 9 contract §4, as
 * amended by the 9.5 assembly): the git-transport half of scenarios 8–9
 * — which stderr pattern reads as which refusal reason. This suite is
 * the one deliberate exception to the barrel-only rule, and it is
 * scoped to a mapping no public outcome can reach hermetically: the
 * rate-limit phrase arrives in GitHub's own sideband, so no local
 * fixture can produce it through `syncRemote()`, and the
 * rejected-credential phrase arrives through a credential negotiation a
 * local server cannot reproduce determinately. The hermetically
 * reachable public paths (transport failure, ambiguous) stay pinned in
 * the public suites (`sync.test.ts`, `publication.test.ts`).
 */
import { classifyGitFailure } from "@ecoma-io/release-craft/__internal__/adapters/github/remote-git.js";

import { describe, expect, it } from "vitest";

describe("the failure classifier (§2.3 rows 8–9)", () => {
  it("reads a rate limit as rate-limited before the 403 pattern (R-08)", () => {
    expect(classifyGitFailure("remote: Rate limit exceeded (HTTP 403)")).toBe("rate-limited");
    expect(classifyGitFailure("you have exceeded a secondary rate limit")).toBe("rate-limited");
  });

  it("reads a rejected credential as auth-expired (R-09)", () => {
    expect(
      classifyGitFailure("fatal: Authentication failed for 'https://github.com/ecoma-io/x.git/'"),
    ).toBe("auth-expired");
    expect(classifyGitFailure("remote: Invalid username or password")).toBe("auth-expired");
  });

  it("never reads a status substring out of git's progress lines (issue #178)", () => {
    // The old classifier matched a bare `403`/`401` anywhere in the
    // stderr — a push's own progress counters ("Total 403 (delta 0)")
    // wore an authentication fault. Statuses classify only where the
    // transport prints them structurally.
    expect(classifyGitFailure("Total 403 (delta 0), reused 401 (delta 0), pack-reused 0")).toBe(
      "transport-failure",
    );
    expect(classifyGitFailure("Total 401 (delta 0), reused 0 (delta 0)")).toBe("transport-failure");
  });

  it("reads GitHub's valid-credential push denial as permission-denied, never auth-expired (issue #178)", () => {
    expect(
      classifyGitFailure("remote: Permission to ecoma-io/release-craft.git denied to johnitvn."),
    ).toBe("permission-denied");
    expect(classifyGitFailure("ERROR: Permission to org/repo.git denied to user.")).toBe(
      "permission-denied",
    );
  });

  it("reads the http transport's structured 403 as permission-denied (issue #178)", () => {
    expect(
      classifyGitFailure(
        "fatal: unable to access 'https://github.com/ecoma-io/x.git/': The requested URL returned error: 403",
      ),
    ).toBe("permission-denied");
    expect(
      classifyGitFailure(
        "error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403",
      ),
    ).toBe("permission-denied");
  });

  it("reads the http transport's structured 401 as auth-expired", () => {
    expect(
      classifyGitFailure(
        "fatal: unable to access 'https://github.com/ecoma-io/x.git/': The requested URL returned error: 401",
      ),
    ).toBe("auth-expired");
  });

  it("reads anything else as transport-failure", () => {
    expect(classifyGitFailure("fatal: the remote end hung up unexpectedly")).toBe(
      "transport-failure",
    );
  });
});
