import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  casAppendCommit,
  casCreateRef,
  claimRegisterRefFor,
  commitRecord,
  firstParentHistory,
  frozenParse,
  GitClaimStore,
  GitFaultError,
  hermeticGitEnv,
  readBlob,
  readRef,
  readRegister,
  refExists,
  writeBlob,
  type GitRun,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import { createTempRepo } from "./temp-repo.js";

/** Runs one test body over a real temporary repository, cleaning it up
 * whether the body passes or fails. */
const withRepo = (fn: (git: GitRun, repo: string) => void): void => {
  const temp = createTempRepo();
  try {
    fn(temp.git, temp.repo);
  } finally {
    temp.cleanup();
  }
};

/** Narrows the append outcome the way the later slices will: null is the
 * loser side, never an exception. */
const asOid = (oid: string | null): string => {
  if (oid === null) {
    throw new Error("expected an appended commit, got the loser outcome");
  }
  return oid;
};

/** Narrows a caught error to the fault type the runner raises. */
const asFault = (error: unknown): GitFaultError => {
  if (error instanceof GitFaultError) {
    return error;
  }
  throw new Error(`expected a GitFaultError, got ${String(error)}`);
};

const ZEROS = "0".repeat(40);

describe("the git binding's shared surface", () => {
  it("creates a ref exactly once and faults the second create — the loser is the caller's to map", () => {
    withRepo((git) => {
      const head = readRef(git, "HEAD");
      if (head === null) {
        throw new Error("the fixture's root commit is missing");
      }
      casCreateRef(git, "refs/heads/cas-create", head);
      expect(readRef(git, "refs/heads/cas-create")).toBe(head);
      expect(refExists(git, "refs/heads/cas-create")).toBe(true);
      expect(() => {
        casCreateRef(git, "refs/heads/cas-create", head);
      }).toThrow(GitFaultError);
      // The losing create moved nothing: the winner's ref stands.
      expect(readRef(git, "refs/heads/cas-create")).toBe(head);
    });
  });

  it("reads absence alone as null — a ref git cannot read faults (#95)", () => {
    withRepo((git, repo) => {
      const ref = "refs/heads/discriminate";
      const head = readRef(git, "HEAD");
      if (head === null) {
        throw new Error("the fixture's root commit is missing");
      }
      // The valid ref reads as its tip.
      casCreateRef(git, ref, head);
      expect(readRef(git, ref)).toBe(head);
      // The absence shape is the value: exit 1 with empty stderr reads as
      // null, and the total-read consumers report absence with it.
      expect(readRef(git, "refs/heads/never-written")).toBeNull();
      expect(refExists(git, "refs/heads/never-written")).toBe(false);
      expect(firstParentHistory(git, "refs/heads/never-written")).toStrictEqual([]);
      // The same exit 1 with a warning on stderr — a broken ref file — is
      // not absence: the fault propagates instead of reading as null.
      writeFileSync(join(repo, ".git", "refs", "heads", "discriminate"), "not-a-commit\n");
      let fault: GitFaultError | undefined;
      try {
        readRef(git, ref);
      } catch (error) {
        fault = asFault(error);
      }
      if (fault === undefined) {
        throw new Error("expected the broken ref to fault, not read as absent");
      }
      expect(fault.status).toBe(1);
      expect(fault.stderr).toContain("broken ref");
      // Every read-shaped primitive over the ref faults with it.
      expect(() => refExists(git, ref)).toThrow(GitFaultError);
      expect(() => firstParentHistory(git, ref)).toThrow(GitFaultError);
    });
  });

  it("stays silent under a leaked GIT_TRACE export — the absence shape survives the ambient env (#95)", () => {
    process.env.GIT_TRACE = "1";
    try {
      withRepo((git) => {
        // A trace export puts ~100 bytes of diagnostics on the stderr of
        // every invocation; the hermetic floor strips it, so the absent ref
        // still reads as the one shape absence is — exit 1, empty stderr.
        expect(readRef(git, "refs/heads/never-written")).toBeNull();
      });
    } finally {
      delete process.env.GIT_TRACE;
    }
  });

  it("appends root and chained commits, and returns the loser outcome on a stale base", () => {
    withRepo((git) => {
      const ref = "refs/heads/scope";
      const first = asOid(casAppendCommit(git, ref, '{"n":1}', null));
      expect(commitRecord(git, first)).toBe('{"n":1}');
      expect(firstParentHistory(git, ref)).toStrictEqual([first]);

      const second = asOid(casAppendCommit(git, ref, '{"n":2}', first));
      expect(commitRecord(git, second)).toBe('{"n":2}');
      expect(firstParentHistory(git, ref)).toStrictEqual([first, second]);

      // A stale base is the loser outcome: nothing moves, the tail stays
      // readable and classifiable.
      expect(casAppendCommit(git, ref, '{"n":9}', ZEROS)).toBeNull();
      expect(firstParentHistory(git, ref)).toStrictEqual([first, second]);

      // A non-null base over an absent ref is the loser outcome too.
      expect(casAppendCommit(git, "refs/heads/absent", '{"n":0}', ZEROS)).toBeNull();
      expect(refExists(git, "refs/heads/absent")).toBe(false);

      // The blob half of the mapping round-trips through the object store.
      expect(readBlob(git, writeBlob(git, '{"claim":"record"}'))).toBe('{"claim":"record"}');
    });
  });

  it("lands byte-identical appends over fresh repositories — no clock, no operator identity", () => {
    const tipOver = (): string => {
      const temp = createTempRepo();
      try {
        const ref = "refs/heads/determinism";
        const first = asOid(casAppendCommit(temp.git, ref, '{"n":1}', null));
        return asOid(casAppendCommit(temp.git, ref, '{"n":2}', first));
      } finally {
        temp.cleanup();
      }
    };
    expect(tipOver()).toBe(tipOver());
  });

  it("walks the first-parent history root-first, and reads an absent ref as empty", () => {
    withRepo((git) => {
      const ref = "refs/heads/history";
      expect(firstParentHistory(git, ref)).toStrictEqual([]);

      const first = asOid(casAppendCommit(git, ref, '{"n":1}', null));
      const second = asOid(casAppendCommit(git, ref, '{"n":2}', first));
      const third = asOid(casAppendCommit(git, ref, '{"n":3}', second));
      expect(firstParentHistory(git, ref)).toStrictEqual([first, second, third]);
    });
  });

  it("stays hermetic under a leaked GIT_NAMESPACE export — the claim mints at the real register, not a shadow namespace (#180)", () => {
    process.env.GIT_NAMESPACE = "hostile-probe";
    try {
      // The floor pin is the leg that bites on every git: the ambient
      // export never reaches a spawn. The behavioral legs below bite only
      // where git's plumbing still maps namespaces — the env-driven
      // namespace-prefixing of ref lookups vanished from refs.c between
      // v2.53.0 and v2.54.0 without a release-note entry (source
      // archaeology; the transport paths — upload-pack/receive-pack —
      // honor the variable on every version, 2.55.0 verified first-hand),
      // so on a modern git a leaked export does not move a local mint.
      // CI pins no git version (ubuntu-latest everywhere), so the
      // behavioral legs silently rot the day the runner image crosses
      // that plumbing break — the floor pin here and the dogfood world
      // pin are the teeth that survive it.
      expect(process.env.GIT_NAMESPACE).toBe("hostile-probe");
      expect(hermeticGitEnv().GIT_NAMESPACE).toBeUndefined();
      withRepo((git, repo) => {
        // A real binding write on the floor's own spawn: the claim mint.
        // Where the plumbing still maps namespaces (v2.53.0 and older),
        // an unstripped export lands the record under
        // `refs/namespaces/hostile-probe/...` — and the store's own reads
        // would resolve the same shadow and stay consistent with it,
        // which is why the assertions below also read the repository's
        // physical refs: the real register must exist on disk, and no
        // namespace shadow may.
        const store = new GitClaimStore(repo);
        const outcome = store.acquire(
          { kind: "stable-version", lineId: "line-namespace", version: "1.2.3" },
          "attempt_sha256:namespace",
        );
        if (outcome.kind !== "claim") {
          throw new Error(`expected a claim, got a denial by ${String(outcome.holder)}`);
        }
        // The record reads back from the real register, through the floor.
        const ref = claimRegisterRefFor("line-namespace");
        const register = readRegister(git, ref) ?? [];
        expect(register).toHaveLength(1);
        expect(register[0]?.holder).toBe("attempt_sha256:namespace");
        // The physical truth, env-independent: the real ref file exists,
        // the shadow namespace holds nothing (an env-carrying reader can be
        // consistent with its own shadow; the repository on disk cannot).
        expect(existsSync(join(repo, ".git", ref))).toBe(true);
        expect(existsSync(join(repo, ".git", "refs", "namespaces"))).toBe(false);
        // The token verifies through the store's all-register walk.
        expect(store.verify(outcome.token)).toMatchObject({ kind: "held" });
      });
    } finally {
      delete process.env.GIT_NAMESPACE;
    }
  });

  it("stays hermetic under a leaked hook environment", () => {
    // The hook runner's environment exports repository-context variables
    // around its own plumbing; a leaked GIT_DIR must not redirect a
    // fixture's or the binding's spawns away from their cwd — this is the
    // regression the pre-push hook pinned (fixture commits landing on the
    // invoking repository's refs).
    process.env.GIT_DIR = "/nonexistent/leaked-git-dir";
    process.env.GIT_INDEX_FILE = "/nonexistent/leaked-git-index";
    process.env.GIT_COMMON_DIR = "/nonexistent/leaked-git-common";
    // A leaked global gitconfig is as ambient as a leaked repository
    // context: the hermetic floor points GIT_CONFIG_GLOBAL at the empty
    // device, so a hostile core.hooksPath (the exact ambient execution the
    // class of leaks enables) never reaches a binding spawn.
    const poisonedConfig = join(tmpdir(), `hermetic-poison-${String(process.pid)}.gitconfig`);
    writeFileSync(poisonedConfig, "[core]\n\thooksPath = /nonexistent/hostile-hooks\n");
    process.env.GIT_CONFIG_GLOBAL = poisonedConfig;
    try {
      withRepo((git) => {
        expect(git(["rev-parse", "--git-dir"]).trim()).toBe(".git");
        expect(git(["rev-parse", "--git-path", "HEAD"]).trim()).toBe(".git/HEAD");
        expect(refExists(git, "HEAD")).toBe(true);
        // The poisoned global file is unread through the floor: the
        // global config reads empty — no hostile hooksPath ever reached a
        // spawn (an unset key would fault `config --global`, so the list
        // form is the assertion).
        expect(git(["config", "--global", "--list"]).trim()).toBe("");
      });
    } finally {
      rmSync(poisonedConfig, { force: true });
      delete process.env.GIT_DIR;
      delete process.env.GIT_INDEX_FILE;
      delete process.env.GIT_COMMON_DIR;
      delete process.env.GIT_CONFIG_GLOBAL;
    }
  });

  it("freezes parsed values all the way down — the reload path's discipline", () => {
    const value = frozenParse('{"outer":{"inner":[1,2],"text":"x"}}') as {
      outer: { inner: readonly number[]; text: string };
    };
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.outer)).toBe(true);
    expect(Object.isFrozen(value.outer.inner)).toBe(true);
    expect(value.outer.inner).toStrictEqual([1, 2]);
    expect(value.outer.text).toBe("x");
  });

  it("reports a corrupt invocation as a GitFaultError carrying args, status and stderr", () => {
    withRepo((git) => {
      let fault: GitFaultError | undefined;
      try {
        git(["cat-file", "blob", "not-an-object-name"]);
      } catch (error) {
        fault = asFault(error);
      }
      if (fault === undefined) {
        throw new Error("expected the corrupt invocation to fault");
      }
      expect(fault.name).toBe("GitFaultError");
      expect(fault.args).toStrictEqual(["cat-file", "blob", "not-an-object-name"]);
      expect(fault.status).not.toBeNull();
      expect(fault.status).not.toBe(0);
      expect(fault.stderr.toLowerCase()).toContain("not a valid object name");
      if (fault.status === null) {
        throw new Error("expected a non-null exit status");
      }
      expect(fault.message).toBe(
        `git cat-file blob not-an-object-name failed (exit ${String(fault.status)}): ${fault.stderr}`,
      );
    });
  });
});
