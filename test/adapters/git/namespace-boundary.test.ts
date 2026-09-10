import { describe, expect, it } from "vitest";

import {
  CHANNEL_REF_NAMESPACE,
  CLAIM_REF_NAMESPACE,
  channelRefFor,
  claimRegisterRefFor,
  ledgerRef,
  GitLedger,
  openGitBinding,
  type GitBinding,
  type GitRun,
  type GitTagNaming,
} from "../../../src/adapters/git/index.js";
import type {
  Attribution,
  Claim,
  ClaimDenied,
  LedgerRecord,
  ReleaseAttempt,
} from "../../../src/index.js";
import { withTempRepo } from "./temp-repo.js";

/**
 * The namespace boundary (invariant 2.12; product-boundary.md): every ref
 * the binding writes into a consumer repository lives under the declared
 * product-neutral namespace root — `refs/release-craft/` — and nowhere
 * else. A full walk over every writing port (register, ledger, claims,
 * channels, tag door) leaves the repository holding only the binding's
 * namespace, git's own branch namespace, and the minted tags: no
 * maintainer-product namespace (`refs/ecoma/`) ever appears, and the
 * constant exports agree with the observable refs.
 */

const naming: GitTagNaming = {
  namespaces: ["v"],
  tagFor: (scope) => (scope.kind === "stable-version" ? `v${scope.version}` : null),
};

const attempt = (): ReleaseAttempt => ({
  attemptId: "attempt_sha256:boundary",
  planId: "plan-boundary",
  planFingerprint: "plan_sha256:boundary",
  state: "executing",
});

const actor = (who: Attribution["actor"]): Attribution => ({
  attemptId: "attempt_sha256:boundary",
  actor: who,
});

const asClaim = (outcome: Claim | ClaimDenied): Claim => {
  if (outcome.kind !== "claim") {
    throw new Error(`expected a claim, got a denial by ${String(outcome.holder)}`);
  }
  return outcome;
};

const completedRecord = (): LedgerRecord => ({
  kind: "step",
  record: {
    attemptId: "attempt_sha256:boundary",
    stepKey: "plan",
    from: "started",
    to: "completed",
    guards: [],
    attribution: actor("automation"),
  },
});

/** All refs the repository holds after the walk, every namespace. */
const allRefNames = (git: GitRun): readonly string[] =>
  git(["for-each-ref", "--format=%(refname)", "refs/"])
    .split("\n")
    .filter((line) => line.length > 0);

/** The full walk: every port that writes a ref writes once. */
const fullWalk = (binding: GitBinding, git: GitRun): void => {
  // The register: the plan's ordinal counter.
  expect(binding.register.nextOrdinal("plan-boundary")).toBe(1);
  // The ledger: the write-ahead plan record, a completed step, and the
  // externally observed satisfaction's own stream (E-03) — written
  // through the concrete git ledger (the port exposes its read side).
  binding.ledger.appendStart(attempt(), "plan", actor("automation"), "content_sha256:boundary");
  binding.ledger.append(completedRecord());
  new GitLedger(git).noteExternal({
    attemptId: "attempt_sha256:boundary",
    stepKey: "plan",
    satisfaction: { attribution: actor("automation"), evidence: "ext:boundary" },
  });
  // The claims: one held claim on the line's register.
  const claim = asClaim(
    binding.claims.acquire(
      { kind: "stable-version", lineId: "line-main", version: "1.2.3" },
      "attempt_sha256:boundary",
    ),
  );
  // The channels: the deliverability pointer's first binding (hidden → held).
  const move = binding.channels.applyTransition({
    channelId: "channel-stable",
    from: null,
    to: { line: "1.x", version: "1.2.3" },
  });
  expect(move.kind).toBe("applied");
  // The tag door: the mint onto the repository's own root commit.
  const target = git(["rev-parse", "HEAD"]).trim();
  const minted = binding.mintTag({
    attemptId: "attempt_sha256:boundary",
    token: claim.token,
    tag: "v1.2.3",
    target,
  });
  expect(minted.kind).toBe("minted");
};

describe("the namespace boundary — refs/release-craft/ and nothing else (invariant 2.12)", () => {
  it("a full walk leaves only the binding's namespace, branches, and tags", () => {
    withTempRepo("namespace-boundary-full-walk", (_repo, git) => {
      const binding = openGitBinding({ repo: _repo, tagNaming: naming });
      fullWalk(binding, git);

      const refs = allRefNames(git);
      // The walk wrote something into every one of the binding's
      // namespaces — the assertion below is not vacuously green.
      expect(refs).toContain(ledgerRef("attempt_sha256:boundary"));
      expect(refs.some((ref) => ref.startsWith("refs/release-craft/ledger-external/"))).toBe(true);
      expect(refs).toContain(claimRegisterRefFor("line-main"));
      expect(refs).toContain(channelRefFor("channel-stable"));
      expect(refs.some((ref) => ref.startsWith("refs/release-craft/register/"))).toBe(true);
      expect(refs).toContain("refs/tags/v1.2.3");
      expect(refs.some((ref) => ref.startsWith("refs/heads/"))).toBe(true);

      // The boundary itself: every ref is git's own branch namespace, the
      // tag namespace the mint door targets, or the binding's declared
      // namespace root — never anything else, and never the maintainer's
      // product name.
      const foreign = refs.filter(
        (ref) =>
          !ref.startsWith("refs/heads/") &&
          !ref.startsWith("refs/tags/") &&
          !ref.startsWith("refs/release-craft/"),
      );
      expect(foreign).toEqual([]);
      expect(refs.some((ref) => ref.startsWith("refs/ecoma/"))).toBe(false);
    });
  });

  it("the exported namespace constants agree with the observable refs", () => {
    expect(CLAIM_REF_NAMESPACE).toBe("refs/release-craft/claims/");
    expect(CHANNEL_REF_NAMESPACE).toBe("refs/release-craft/channels/");
    expect(ledgerRef("attempt_sha256:x")).toBe("refs/release-craft/ledger/attempt_sha256%3Ax");
  });
});
