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

  it("reads anything else as transport-failure", () => {
    expect(classifyGitFailure("fatal: the remote end hung up unexpectedly")).toBe(
      "transport-failure",
    );
  });
});
