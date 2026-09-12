import { describe, expect, it } from "vitest";

import {
  commitRecord,
  GitFaultError,
  readRef,
  type GitRun,
  type GitTagNaming,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import {
  claimRegisterRefFor,
  GitClaimStore,
  GitTagDoor,
  openGitBinding,
  type TagMint,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import {
  canonicalJson,
  type Claim,
  type ClaimDenied,
  type ClaimScope,
} from "../../../src/index.js";
import type { TagMintResult } from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import { withTempRepo } from "./temp-repo.js";

/**
 * Contract fixtures 3–4 over real repositories (contract §4; ADR-0009
 * decisions 4–5): the tag-push CAS's one-ref accept and the mint door that
 * follows it — the winner named, the namespace enforced, the token
 * verified, and the tag ref created if and only if it is absent.
 */

/** The declared tag naming the fixtures open the door with: stable
 * versions derive into the `v` namespace; every other scope maps outside
 * it — the non-tag scopes fixture 4 refuses. */
const naming: GitTagNaming = {
  namespaces: ["v"],
  tagFor: (scope: ClaimScope): string | null => {
    if (scope.kind !== "stable-version") {
      return null;
    }
    return `v${scope.version}`;
  },
};

/** Runs one test body against a fresh temporary repository with the store
 * and the mint door opened on it, cleaning up either way. */
const withStore = (fn: (store: GitClaimStore, mint: TagMint, git: GitRun) => void): void => {
  withTempRepo("claims-mint", (repo, git) => {
    fn(new GitClaimStore(repo), GitTagDoor(git, naming), git);
  });
};

const stableVersion = (version: string, lineId = "line-main"): ClaimScope => {
  return { kind: "stable-version", lineId, version };
};

const prerelease = (sequence: number): ClaimScope => {
  return {
    kind: "prerelease-sequence",
    lineId: "line-main",
    target: "1.3.0-rc",
    streamId: "rc",
    sequence,
  };
};

const releaseLine = (lineId: string): ClaimScope => {
  return { kind: "release-line", lineId };
};

const asClaim = (outcome: Claim | ClaimDenied): Claim => {
  if (outcome.kind !== "claim") {
    throw new Error(`expected a claim, got a denial by ${String(outcome.holder)}`);
  }
  return outcome;
};

const asDenied = (outcome: Claim | ClaimDenied): ClaimDenied => {
  if (outcome.kind !== "denied") {
    throw new Error("expected a denial");
  }
  return outcome;
};

type ConflictResult = Extract<TagMintResult, { kind: "conflict" }>;

const asConflict = (result: TagMintResult): ConflictResult => {
  if (result.kind !== "conflict") {
    throw new Error(`expected a conflict, got ${result.kind}`);
  }
  return result;
};

type RefusedResult = Extract<TagMintResult, { kind: "refused" }>;

const asRefused = (result: TagMintResult): RefusedResult => {
  if (result.kind !== "refused") {
    throw new Error(`expected a refusal, got ${result.kind}`);
  }
  return result;
};

/** Narrows a caught error to the fault type the runner raises. */
const asFault = (error: unknown): GitFaultError => {
  if (error instanceof GitFaultError) {
    return error;
  }
  throw new Error(`expected a GitFaultError, got ${String(error)}`);
};

const refNames = (git: GitRun, pattern: string): readonly string[] => {
  return git(["for-each-ref", "--format=%(refname)", pattern])
    .split("\n")
    .filter((line) => line.length > 0);
};

const firstRef = (refs: readonly string[]): string => {
  const ref = refs[0];
  if (ref === undefined) {
    throw new Error("expected at least one ref");
  }
  return ref;
};

const asTip = (tip: string | null): string => {
  if (tip === null) {
    throw new Error("expected the ref to exist");
  }
  return tip;
};

/** The fixture's deterministic root commit — the recorded base the tests
 * supply as the mint target. */
const rootCommit = (git: GitRun): string => {
  return git(["rev-parse", "HEAD"]).trim();
};

/** A second real commit, child of the root, for elsewhere-targets. */
const nextCommit = (git: GitRun, parent: string): string => {
  const tree = git(["rev-parse", "HEAD^{tree}"]).trim();
  return git(["commit-tree", tree, "-p", parent, "-m", "ecoma: second"]).trim();
};

describe("the git-backed claim store (fixture 3)", () => {
  it("accepts through the line's register and denies the loser naming the winner", () => {
    withStore((store, _mint, git) => {
      const winner = asClaim(store.acquire(stableVersion("1.2.3"), "attempt_winner"));
      expect(winner.holder).toBe("attempt_winner");
      expect(winner.token).not.toBe("");

      const loser = store.acquire(stableVersion("1.2.3"), "attempt_loser");
      expect(loser).toEqual({
        kind: "denied",
        scope: stableVersion("1.2.3"),
        holder: "attempt_winner",
      });
      // A lost race is a winner's denial, never a policy refusal: no
      // namespace marker on the store's own shape.
      expect(Object.hasOwn(loser, "refusal")).toBe(false);

      // One line, one register ref — the sha256 of the lineId — whose
      // tip's blob is the register envelope holding the claim record in
      // canonical form.
      const refs = refNames(git, "refs/release-craft/claims/");
      expect(refs).toEqual([claimRegisterRefFor("line-main")]);
      const tip = asTip(readRef(git, firstRef(refs)));
      expect(commitRecord(git, tip)).toBe(
        `{"claims":[${canonicalJson({
          kind: "claim",
          scope: stableVersion("1.2.3"),
          token: winner.token,
          holder: "attempt_winner",
        })}]}`,
      );
    });
  });

  it("re-admits the holder idempotently and never writes a second register", () => {
    withStore((store, _mint, git) => {
      const first = asClaim(store.acquire(stableVersion("1.2.3"), "attempt_a"));
      const again = asClaim(store.acquire(stableVersion("1.2.3"), "attempt_a"));
      expect(again).toEqual(first);
      expect(refNames(git, "refs/release-craft/claims/")).toHaveLength(1);
    });
  });

  it("carries the winner's sequence on a denied prerelease-sequence (E-08)", () => {
    withStore((store) => {
      asClaim(store.acquire(prerelease(7), "attempt_winner"));
      const denial = asDenied(store.acquire(prerelease(7), "attempt_loser"));
      expect(denial).toEqual({
        kind: "denied",
        scope: prerelease(7),
        holder: "attempt_winner",
        holderSequence: 7,
      });
    });
  });

  it("enforces the line exclusion law through the line registers (§2.3)", () => {
    withStore((store, _mint, git) => {
      const held = asClaim(store.acquire(stableVersion("1.2.3"), "attempt_a"));
      expect(asDenied(store.acquire(releaseLine("line-main"), "attempt_b")).holder).toBe(
        "attempt_a",
      );

      const lineHolder = asClaim(store.acquire(releaseLine("line-other"), "attempt_d"));
      expect(
        asDenied(store.acquire(stableVersion("1.0.0", "line-other"), "attempt_e")).holder,
      ).toBe("attempt_d");

      // Disjoint keys on the same line coexist in one register: stable
      // versions are not excluded by each other, only by a held
      // release-line.
      const coexisting = asClaim(store.acquire(stableVersion("9.9.9"), "attempt_c"));
      expect(coexisting.token).not.toBe(held.token);
      expect(lineHolder.token).not.toBe(held.token);
      // Two lines, two registers — the claims of a line live together.
      expect(refNames(git, "refs/release-craft/claims/")).toEqual([
        claimRegisterRefFor("line-main"),
        claimRegisterRefFor("line-other"),
      ]);
    });
  });

  it("verifies the token through the registers and loses released leases (§2.3)", () => {
    withStore((store, _mint, git) => {
      const claim = asClaim(store.acquire(prerelease(7), "attempt_a"));
      expect(store.verify(claim.token)).toEqual({ kind: "held", claim });
      expect(store.verify("no-such-token")).toEqual({ kind: "lost" });

      store.release(claim.token);
      expect(store.verify(claim.token)).toEqual({ kind: "lost" });
      // The empty register persists — the ref is never deleted, so the
      // write path stays one primitive (ADR-0011 decision 4).
      const refs = refNames(git, "refs/release-craft/claims/");
      expect(refs).toEqual([claimRegisterRefFor("line-main")]);
      expect(commitRecord(git, asTip(readRef(git, refs[0] ?? "")))).toBe('{"claims":[]}');
    });
  });

  it("keeps a stable-version claim as a record — its release is a no-op (ADR-0009 decision 4)", () => {
    withStore((store, _mint, git) => {
      const claim = asClaim(store.acquire(stableVersion("1.2.3"), "attempt_a"));
      store.release(claim.token);
      expect(store.verify(claim.token)).toEqual({ kind: "held", claim });
      expect(refNames(git, "refs/release-craft/claims/")).toHaveLength(1);
    });
  });
});

describe("the tag mint door (fixtures 3 and 4)", () => {
  it("mints the winner's tag at its supplied target (fixture 3)", () => {
    withStore((store, mint, git) => {
      const claim = asClaim(store.acquire(stableVersion("1.2.3"), "attempt_a"));
      const base = rootCommit(git);
      expect(
        mint({ attemptId: "attempt_a", token: claim.token, tag: "v1.2.3", target: base }),
      ).toEqual({
        kind: "minted",
        tag: "v1.2.3",
        target: base,
      });
      expect(readRef(git, "refs/tags/v1.2.3")).toBe(base);
    });
  });

  it("re-mints the same target idempotently and never rewrites the ref", () => {
    withStore((store, mint, git) => {
      const claim = asClaim(store.acquire(stableVersion("1.2.3"), "attempt_a"));
      const base = rootCommit(git);
      const input = { attemptId: "attempt_a", token: claim.token, tag: "v1.2.3", target: base };
      expect(mint(input)).toEqual({ kind: "minted", tag: "v1.2.3", target: base });
      expect(mint(input)).toEqual({ kind: "minted", tag: "v1.2.3", target: base });
      expect(refNames(git, "refs/tags/")).toHaveLength(1);
      expect(readRef(git, "refs/tags/v1.2.3")).toBe(base);
    });
  });

  it("conflicts when the tag already points elsewhere — the existing ref wins (fixtures 3–4)", () => {
    withStore((store, mint, git) => {
      const first = asClaim(store.acquire(stableVersion("1.2.3"), "attempt_a"));
      const base = rootCommit(git);
      expect(
        mint({ attemptId: "attempt_a", token: first.token, tag: "v1.2.3", target: base }).kind,
      ).toBe("minted");
      const elsewhere = nextCommit(git, base);
      const replay = asConflict(
        mint({ attemptId: "attempt_a", token: first.token, tag: "v1.2.3", target: elsewhere }),
      );
      expect(replay.tag).toBe("v1.2.3");
      expect(readRef(git, "refs/tags/v1.2.3")).toBe(base);

      // Two scopes racing one global namespace resolve through the same
      // CAS: both accepts land in their own lines' registers, but the tag
      // ref has one value and the second mint's target loses.
      const second = asClaim(store.acquire(stableVersion("1.2.3", "line-b"), "attempt_b"));
      expect(refNames(git, "refs/release-craft/claims/")).toHaveLength(2);
      const raced = asConflict(
        mint({ attemptId: "attempt_b", token: second.token, tag: "v1.2.3", target: elsewhere }),
      );
      expect(raced.detail).toContain("v1.2.3");
      expect(readRef(git, "refs/tags/v1.2.3")).toBe(base);
    });
  });

  it("refuses a foreign token, never a mint (§2.6 — conflict names a tag ref)", () => {
    withStore((store, mint, git) => {
      asClaim(store.acquire(stableVersion("1.2.3"), "attempt_a"));
      const stranger = asClaim(store.acquire(stableVersion("2.0.0"), "attempt_c"));
      const foreign = asRefused(
        mint({
          attemptId: "attempt_a",
          token: stranger.token,
          tag: "v1.2.3",
          target: rootCommit(git),
        }),
      );
      expect(foreign.reason).toBe("foreign-token");
      expect(foreign.tag).toBe("v1.2.3");
      expect(readRef(git, "refs/tags/v1.2.3")).toBeNull();
    });
  });

  it("refuses a mint for a scope the naming maps to no tag (fixture 4)", () => {
    withStore((store, mint, git) => {
      const held = asClaim(store.acquire(prerelease(7), "attempt_a"));
      const refused = asRefused(
        mint({ attemptId: "attempt_a", token: held.token, tag: "rc7", target: rootCommit(git) }),
      );
      // The policy refusal names the tag and the declared namespaces.
      expect(refused.kind).toBe("refused");
      expect(refused.reason).toBe("namespace");
      expect(refused.tag).toBe("rc7");
      expect(refused.detail).toContain("rc7");
      expect(refused.detail).toContain("v");
      // The policy refusal left nothing behind: no tag ref, and the claim
      // ref is exactly where the accept put it.
      expect(refNames(git, "refs/tags/")).toHaveLength(0);
      expect(refNames(git, "refs/release-craft/claims/")).toHaveLength(1);
    });
  });

  it("refuses an out-of-namespace tag before any claim is read (§2.4)", () => {
    withStore((store, mint, git) => {
      const claim = asClaim(store.acquire(stableVersion("1.2.3"), "attempt_a"));
      const refused = asRefused(
        mint({
          attemptId: "attempt_a",
          token: claim.token,
          tag: "release-1.2.3",
          target: rootCommit(git),
        }),
      );
      // An in-namespace held claim deriving v1.2.3 cannot make an
      // out-of-namespace mint `unclaimed`: the class is the tag's, not the
      // claim state's.
      expect(refused.reason).toBe("namespace");
      expect(refused.detail).toContain("release-1.2.3");
      expect(refused.detail).toContain("v");
      expect(refNames(git, "refs/tags/")).toHaveLength(0);
    });
  });

  it("reports unclaimed for an in-namespace tag no held claim derives (§2.6)", () => {
    withStore((store, mint, git) => {
      asClaim(store.acquire(stableVersion("1.2.3"), "attempt_a"));
      const refused = asRefused(
        mint({
          attemptId: "attempt_a",
          token: "claim:none",
          tag: "v9.9.9",
          target: rootCommit(git),
        }),
      );
      expect(refused.reason).toBe("unclaimed");
      expect(refused.detail).toContain("v9.9.9");
      expect(refNames(git, "refs/tags/")).toHaveLength(0);
    });
  });

  it("refuses the freeze-window mint naming the recorded takeover (§2.4 item 6; ADR-0011 decision 9)", () => {
    // A naming that admits prerelease scopes, so the taken lease's own
    // derived tag is mintable — the freeze window the door closes.
    const fenceNaming: GitTagNaming = {
      namespaces: ["v"],
      tagFor: (scope: ClaimScope): string | null =>
        scope.kind === "prerelease-sequence" ? `v${scope.target}.${String(scope.sequence)}` : null,
    };
    withTempRepo("claims-mint-freeze", (repo, git) => {
      const store = new GitClaimStore(repo);
      const mint = GitTagDoor(git, fenceNaming);
      const holder = asClaim(store.acquire(prerelease(1), "attempt_holder"));
      const taker = asClaim(store.acquire(prerelease(2), "attempt_taker"));
      // The holder's lease verifies superseded; the mint the holder's walk
      // reaches after the takeover answers with the same evidence — the
      // recorded takeover refuses the mint, naming the taker.
      expect(store.verify(holder.token).kind).toBe("superseded");
      const refused = asRefused(
        mint({
          attemptId: "attempt_holder",
          token: holder.token,
          tag: "v1.3.0-rc.1",
          target: rootCommit(git),
        }),
      );
      expect(refused.reason).toBe("unclaimed");
      expect(refused.tag).toBe("v1.3.0-rc.1");
      expect(refused.detail).toContain("was superseded by attempt attempt_taker");
      expect(refused.detail).toContain("the recorded takeover refuses the mint");
      // No tag ref moved.
      expect(refNames(git, "refs/tags/")).toHaveLength(0);
      expect(taker.token).not.toBe("");
    });
  });

  it("refuses the freeze-window mint beside an unrelated held claim, on the taken lease's derived name (§2.4 item 6)", () => {
    const fenceNaming: GitTagNaming = {
      namespaces: ["v"],
      tagFor: (scope: ClaimScope): string | null => {
        if (scope.kind === "stable-version") {
          return `v${scope.version}`;
        }
        return scope.kind === "prerelease-sequence"
          ? `v${scope.target}.${String(scope.sequence)}`
          : null;
      },
    };
    withTempRepo("claims-mint-freeze-mixed", (repo, git) => {
      const store = new GitClaimStore(repo);
      const mint = GitTagDoor(git, fenceNaming);
      // The holder carries one unrelated held lease (its own record) and
      // one taken lease; the taken lease's derived tag is the mint the
      // frozen walk asks for.
      asClaim(store.acquire(stableVersion("1.2.0"), "attempt_holder"));
      asClaim(store.acquire(prerelease(1), "attempt_holder"));
      asClaim(store.acquire(prerelease(2), "attempt_taker"));
      const refused = asRefused(
        mint({
          attemptId: "attempt_holder",
          token: "claim:none",
          tag: "v1.3.0-rc.1",
          target: rootCommit(git),
        }),
      );
      expect(refused.reason).toBe("unclaimed");
      expect(refused.detail).toContain("was superseded by attempt attempt_taker");
      expect(refNames(git, "refs/tags/")).toHaveLength(0);
    });
  });

  it("denies the acquisition of a scope the naming maps to no tag — before git sees it (§2.4)", () => {
    withTempRepo("claims-acquire-door", (repo, git) => {
      const binding = openGitBinding({ repo, tagNaming: naming });
      const denied = asDenied(binding.claims.acquire(prerelease(7), "attempt_a"));
      expect(denied.kind).toBe("denied");
      expect(denied.refusal).toBe("namespace");
      expect(denied.holder).toBeUndefined();
      // The claim state never moved: no claim ref was written.
      expect(refNames(git, "refs/release-craft/claims/")).toHaveLength(0);
      // And the binding's own naming still admits the scopes it maps.
      const held = binding.claims.acquire(stableVersion("1.2.3"), "attempt_a");
      expect(held.kind).toBe("claim");
    });
  });

  it("mints a non-canonical target spelling at its resolved commit, never a false conflict", () => {
    withStore((store, mint, git) => {
      const claim = asClaim(store.acquire(stableVersion("1.2.3"), "attempt_a"));
      const base = rootCommit(git);
      const short = base.slice(0, 7);
      const minted = mint({
        attemptId: "attempt_a",
        token: claim.token,
        tag: "v1.2.3",
        target: short,
      });
      expect(minted).toStrictEqual({ kind: "minted", tag: "v1.2.3", target: base });
      expect(readRef(git, "refs/tags/v1.2.3")).toBe(base);
      // The idempotent re-mint through a different spelling of the same
      // commit is still the same outcome.
      const again = mint({
        attemptId: "attempt_a",
        token: claim.token,
        tag: "v1.2.3",
        target: base,
      });
      expect(again).toStrictEqual({ kind: "minted", tag: "v1.2.3", target: base });
    });
  });

  it("refuses a mint under no held claim or an unmatched tag, fail-closed (fixture 3)", () => {
    withStore((store, mint, git) => {
      const ghost = asRefused(
        mint({
          attemptId: "attempt_ghost",
          token: "no-such-token",
          tag: "v1.2.3",
          target: rootCommit(git),
        }),
      );
      expect(ghost.reason).toBe("unclaimed");

      const claim = asClaim(store.acquire(stableVersion("1.2.3"), "attempt_a"));
      const unmatched = asRefused(
        mint({
          attemptId: "attempt_a",
          token: claim.token,
          tag: "v9.9.9",
          target: rootCommit(git),
        }),
      );
      expect(unmatched.reason).toBe("unclaimed");
      expect(readRef(git, "refs/tags/v9.9.9")).toBeNull();
    });
  });

  it("faults its own classified error when the target resolves to no commit — never the raw rev-parse fault (#184; D49)", () => {
    withStore((store, mint, git) => {
      const claim = asClaim(store.acquire(stableVersion("1.2.3"), "attempt_a"));
      const absentBase = "0".repeat(40);
      // Pre-fix, the quiet verification's raw fault escaped before the
      // door's classification could run: a GitFaultError with git's exit 1
      // and an empty stderr — cryptic and unclassified. The door catches
      // that one shape and raises its own declared fault.
      let thrown: unknown;
      try {
        mint({
          attemptId: "attempt_a",
          token: claim.token,
          tag: "v1.2.3",
          target: absentBase,
        });
      } catch (error) {
        thrown = error;
      }
      const fault = asFault(thrown);
      expect(fault.status).toBeNull();
      expect(fault.args).toStrictEqual(["rev-parse", "--verify", `${absentBase}^{commit}`]);
      expect(fault.stderr).toBe(`the mint target ${absentBase} does not resolve to a commit`);
      // The declared-lie posture stays a fault, never a returned refusal
      // class (phase 12 §2.4; phase 13 §2.8's mismatch site, exit 70).
      expect(fault.message).toContain("does not resolve to a commit");
      // Nothing a faulting mint refused left state behind.
      expect(refNames(git, "refs/tags/")).toHaveLength(0);
    });
  });

  it("never creates a tag at HEAD or any caller-named ref", () => {
    withStore((store, mint, git) => {
      const claim = asClaim(store.acquire(stableVersion("1.2.3"), "attempt_a"));
      const base = rootCommit(git);
      // Both spellings lie outside the fixture's declared root ("v") —
      // the namespace door refuses them before any claim is read (§2.4).
      const atHead = asRefused(
        mint({ attemptId: "attempt_a", token: claim.token, tag: "HEAD", target: base }),
      );
      expect(atHead.reason).toBe("namespace");
      const atBranch = asRefused(
        mint({ attemptId: "attempt_a", token: claim.token, tag: "refs/heads/main", target: base }),
      );
      expect(atBranch.reason).toBe("namespace");

      // The repository holds exactly what it held before the hostile
      // mints: the fixture's root branch and the one claim ref — no tag
      // ref, no caller-named ref of any other shape.
      expect(refNames(git, "refs/tags/")).toHaveLength(0);
      expect(refNames(git, "refs/heads/")).toHaveLength(1);
      expect(refNames(git, "refs/")).toHaveLength(2);
    });
  });
});
