import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  casAppendCommit,
  casCreateRef,
  casDeleteRef,
  commitRecord,
  firstParentHistory,
  frozenParse,
  GitFaultError,
  readBlob,
  readRef,
  refExists,
  writeBlob,
  type GitRun,
} from "../../../src/adapters/git/index.js";
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

  it("deletes a ref only from the expected value", () => {
    withRepo((git) => {
      const head = readRef(git, "HEAD");
      if (head === null) {
        throw new Error("the fixture's root commit is missing");
      }
      const ref = "refs/heads/lease";
      casCreateRef(git, ref, head);

      // A wrong expectation deletes nothing and is not a fault.
      expect(casDeleteRef(git, ref, ZEROS)).toBe(false);
      expect(refExists(git, ref)).toBe(true);

      // The expected value deletes, and a second release reads lost.
      expect(casDeleteRef(git, ref, head)).toBe(true);
      expect(refExists(git, ref)).toBe(false);
      expect(casDeleteRef(git, ref, head)).toBe(false);
    });
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
