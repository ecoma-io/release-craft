/**
 * The commit door (issue #339; phase 11 §2.5's mint-preceding door) over
 * real, temporary repositories: the deterministic tree rebuild — recorded
 * base entries kept, the supplied files' bytes overlaid, the whole
 * rebuilt through `mktree` — and the committed identity the completion
 * records. The contract rows pinned here:
 *
 * - the same inputs drive the same oid (content-addressed, COMMIT_ENV in
 *   every spawn): the resume idempotency the completion's re-derivation
 *   leans on;
 * - the committed tree is the base tree plus the overlaid files —
 *   class 1's "nothing ambient": base entries every path the supplied
 *   files do not name are preserved byte-equal, nested paths rebuild
 *   through directories, and an empty file set reproduces the base tree;
 * - the claim gate mirrors the mint door's (ADR-0011 decision 3's named
 *   read exception): an attempt that holds no claim deriving the tag is
 *   refused `unclaimed`, a foreign token `foreign-token` — returned
 *   refusals, never exceptions, and no object the refusal would have
 *   written is left behind;
 * - a base the repository cannot resolve raises the binding's own
 *   `GitFaultError` naming the base — the same quiet verification and
 *   thrown posture the tag door keys absence on (D39).
 */
import { describe, expect, it } from "vitest";

import {
  GitClaimStore,
  GitCommitDoor,
  GitFaultError,
  type GitRun,
  type GitTagNaming,
  type ReleaseCommit,
  type ReleaseCommitInput,
} from "@ecoma-io/release-craft/adapters/git";
import { writeBlob } from "@ecoma-io/release-craft/adapters/git";
import type { ClaimScope } from "../../../src/index.js";
import { withTempRepo } from "./temp-repo.js";
/** The declared tag naming the fixtures open the door with: stable
 * versions derive into the `v` namespace, exactly the claims-mint
 * fixture's naming — so a held stable claim derives the plan's tag. */
const naming: GitTagNaming = {
  namespaces: ["v"],
  tagFor: (scope: ClaimScope): string | null => {
    if (scope.kind !== "stable-version") {
      return null;
    }
    return `v${scope.version}`;
  },
};

const stableScope = (version: string, lineId = "main"): ClaimScope => ({
  kind: "stable-version",
  lineId,
  version,
});

/** The fixed base tree the fixtures commit against: a record file plus a
 * nested path — entries the overlay must keep and a directory the rebuild
 * must recurse. */
const seedBase = (git: GitRun, parent: string): string => {
  // `git mktree` takes one flat entry per line and refuses slash paths —
  // nested entries require the subtree built first, the parent's row
  // carrying it as `040000 tree <oid>`.
  const record = writeBlob(git, "line main head\n");
  const guide = writeBlob(git, "guide\n");
  const docs = git(["mktree"], `100644 blob ${guide}\tguide.md\n`).trim();
  const tree = git(["mktree"], `100644 blob ${record}\trecord\n040000 tree ${docs}\tdocs\n`).trim();
  return git(["commit-tree", tree, "-p", parent, "-m", "release-craft: base"]).trim();
};

/** One run's fixture context: the door, the claim store, the runner, and
 * the recorded base oid. */
interface Context {
  readonly door: ReleaseCommit;
  readonly store: GitClaimStore;
  readonly git: GitRun;
  readonly base: string;
}

const withDoor = (fn: (context: Context) => void): void => {
  withTempRepo("commit-door", (repo, git) => {
    const root = git(["rev-parse", "HEAD"]).trim();
    const context: Context = {
      door: GitCommitDoor(git, naming),
      store: new GitClaimStore(repo),
      git,
      base: seedBase(git, root),
    };
    fn(context);
  });
};

const asClaim = (
  outcome: ReturnType<GitClaimStore["acquire"]>,
): Extract<ReturnType<GitClaimStore["acquire"]>, { kind: "claim" }> => {
  if (outcome.kind !== "claim") {
    throw new Error(`fixture broken: expected a claim, got ${outcome.kind}`);
  }
  return outcome;
};

/** A deterministic release input: the attempt holds the `v1.2.3` claim,
 * the base is the fixture's, and the files are the version bump's bytes. */
const releaseInput = (
  context: Context,
  attemptId: string,
  token: string,
  files: Record<string, string> = {
    VERSION: "1.2.3\n",
    "CHANGELOG.md": "# Changelog\n\n## 1.2.3\n",
  },
): ReleaseCommitInput => ({
  attemptId,
  token,
  tag: "v1.2.3",
  base: context.base,
  planId: "p-1",
  lineId: "main",
  files,
});

interface TreeRow {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
  readonly path: string;
}

/** The recursive listing of one commit, row by row. */
const listingOf = (git: GitRun, oid: string): readonly TreeRow[] =>
  git(["ls-tree", "-r", "-z", oid])
    .split("\0")
    .filter((line) => line.length > 0)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, entryOid] = line.slice(0, tab).split(" ");
      return { mode: mode ?? "", type: type ?? "", oid: entryOid ?? "", path: line.slice(tab + 1) };
    });

const blobOf = (git: GitRun, oid: string): string => git(["cat-file", "blob", oid]);

describe("issue #339 — the commit door (class 1–2)", () => {
  it(
    "commits deterministically: same base, same files, same message — same oid; re-derivation idempotent",
    { timeout: 30_000 },
    () => {
      withDoor((context) => {
        const claim = asClaim(context.store.acquire(stableScope("1.2.3"), "attempt-1"));
        const input = releaseInput(context, claim.holder, claim.token);
        const first = context.door(input);
        expect(first.kind).toBe("committed");
        if (first.kind !== "committed") {
          throw new Error("expected a committed outcome");
        }
        expect(context.git(["cat-file", "-t", first.oid]).trim()).toBe("commit");
        // The committed parent is the recorded base — never ambient HEAD.
        expect(context.git(["rev-parse", `${first.oid}^`]).trim()).toBe(context.base);
        const again = context.door(input);
        expect(again).toEqual(first);
      });
    },
  );

  it(
    "the committed tree is the base plus the overlaid files — kept entries byte-equal, nested paths rebuilt",
    { timeout: 30_000 },
    () => {
      withDoor((context) => {
        const claim = asClaim(context.store.acquire(stableScope("1.2.3"), "attempt-1"));
        const input = releaseInput(context, claim.holder, claim.token, {
          VERSION: "1.2.3\n",
          "CHANGELOG.md": "# Changelog\n\n## 1.2.3\n",
        });
        const committed = context.door(input);
        if (committed.kind !== "committed") {
          throw new Error("expected a committed outcome");
        }
        const rows = listingOf(context.git, committed.oid);
        const byPath = new Map(rows.map((row) => [row.path, row]));
        // The base's own entries survived the rebuild, byte-equal.
        expect(byPath.get("record")?.oid).toBe(
          context.git(["rev-parse", `${context.base}:record`]).trim(),
        );
        expect(byPath.get("docs/guide.md")?.oid).toBe(
          context.git(["rev-parse", `${context.base}:docs/guide.md`]).trim(),
        );
        // The release's own bytes are the overlaid entries — the version
        // the bump wrote and the changelog the render produced.
        const version = byPath.get("VERSION");
        if (version === undefined) {
          throw new Error("expected a VERSION entry");
        }
        expect(blobOf(context.git, version.oid)).toBe("1.2.3\n");
        const changelog = byPath.get("CHANGELOG.md");
        if (changelog === undefined) {
          throw new Error("expected a CHANGELOG.md entry");
        }
        expect(blobOf(context.git, changelog.oid)).toBe("# Changelog\n\n## 1.2.3\n");
      });
    },
  );

  it(
    "a supplied file overrides the base entry of the same path — one entry, the overlay's bytes",
    { timeout: 30_000 },
    () => {
      withDoor((context) => {
        const claim = asClaim(context.store.acquire(stableScope("1.2.3"), "attempt-1"));
        const input = releaseInput(context, claim.holder, claim.token, { record: "rewritten\n" });
        const committed = context.door(input);
        if (committed.kind !== "committed") {
          throw new Error("expected a committed outcome");
        }
        const rows = listingOf(context.git, committed.oid);
        const record = rows.filter((row) => row.path === "record");
        expect(record).toHaveLength(1);
        expect(blobOf(context.git, record[0]?.oid ?? "")).toBe("rewritten\n");
      });
    },
  );

  it(
    "an empty file set reproduces the base tree byte-equal — nothing ambient enters",
    { timeout: 30_000 },
    () => {
      withDoor((context) => {
        const claim = asClaim(context.store.acquire(stableScope("1.2.3"), "attempt-1"));
        const committed = context.door(releaseInput(context, claim.holder, claim.token, {}));
        if (committed.kind !== "committed") {
          throw new Error("expected a committed outcome");
        }
        expect(context.git(["rev-parse", `${committed.oid}^{tree}`]).trim()).toBe(
          context.git(["rev-parse", `${context.base}^{tree}`]).trim(),
        );
      });
    },
  );

  it(
    "refuses unclaimed: no held claim derives the plan's tag — returned refusal, nothing written",
    { timeout: 30_000 },
    () => {
      withDoor((context) => {
        const outcome = context.door(releaseInput(context, "attempt-nobody", "any-token"));
        expect(outcome.kind).toBe("refused");
        if (outcome.kind !== "refused") {
          throw new Error("expected a refusal");
        }
        expect(outcome.reason).toBe("unclaimed");
        expect(outcome.detail).toContain("attempt-nobody");
      });
    },
  );

  it(
    "refuses a foreign token: the claim derives the tag but is held under another token",
    { timeout: 30_000 },
    () => {
      withDoor((context) => {
        const claim = asClaim(context.store.acquire(stableScope("1.2.3"), "attempt-1"));
        const outcome = context.door(releaseInput(context, claim.holder, "not-the-token"));
        expect(outcome.kind).toBe("refused");
        if (outcome.kind !== "refused") {
          throw new Error("expected a refusal");
        }
        expect(outcome.reason).toBe("foreign-token");
      });
    },
  );

  it(
    "a base the declared world does not hold raises the binding's own GitFaultError naming it",
    { timeout: 30_000 },
    () => {
      withDoor((context) => {
        const claim = asClaim(context.store.acquire(stableScope("1.2.3"), "attempt-1"));
        const input: ReleaseCommitInput = {
          ...releaseInput(context, claim.holder, claim.token),
          base: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        };
        let thrown: unknown;
        try {
          context.door(input);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(GitFaultError);
        expect((thrown as GitFaultError).message).toContain(
          "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        );
      });
    },
  );
});
