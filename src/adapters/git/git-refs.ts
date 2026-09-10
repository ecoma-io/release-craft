/**
 * The compare-and-swap ref primitives the binding's scopes are built from.
 * The reference mapping (contract §2.2): each scope anchors to exactly one
 * ref whose first-parent history is the append sequence — every append one
 * commit holding one new blob in canonical form — and the read path
 * reconstructs the tail by walking that history from the tip. Every CAS runs
 * through `git update-ref`'s old-value argument; git's per-ref lockfile
 * makes the check-and-set atomic locally, which is the physical half of the
 * one-winner discipline (E-07; ADR-0009 decision 4).
 */

import { GitFaultError, type GitRun } from "./git-run.js";

/** The all-zero object id — update-ref's "expected old value: absent". */
const ZERO_OID = "0".repeat(40);

/**
 * Reads a ref's tip, or null when the ref is absent. `--verify --quiet`
 * reports absence by exit 1 with empty stderr, so the runner raises
 * GitFaultError either way and this is the one place the binding reports a
 * fault as a value — and the discrimination is exact (#95): only that
 * shape is absence. Every other fault a ref read can produce — a ref git
 * cannot read (a broken ref file, empty or holding garbage, exits 1 with
 * a warning on stderr), an unexpected exit status, a spawn failure —
 * propagates, so each consuming scope's own fault contract applies to it:
 * a broken ref is never read as an absent one. The discrimination reaches
 * exactly as far as git can spell: a ref file the process cannot read (a
 * permission denial) and a directory sitting at the ref's path produce the
 * same exit 1 with empty stderr as absence and still read as absent — no
 * rev-parse spelling separates them, and D39 records the residual.
 */
export function readRef(git: GitRun, ref: string): string | null {
  try {
    return git(["rev-parse", "--verify", "--quiet", ref]).trim();
  } catch (error) {
    if (error instanceof GitFaultError && error.status === 1 && error.stderr === "") {
      return null;
    }
    throw error;
  }
}

/** Whether the ref exists. */
export function refExists(git: GitRun, ref: string): boolean {
  return readRef(git, ref) !== null;
}

/**
 * Creates the ref if and only if it is absent: update-ref's expected old
 * value is the all-zero id, which only matches a missing ref. When the ref
 * exists the update fails under git's ref lock and GitFaultError propagates
 * — the loser side is decided by callers, who read first and map the fault
 * to their own outcomes (contract §2.3's recorded-refusal discipline).
 */
export function casCreateRef(git: GitRun, ref: string, target: string): void {
  git(["update-ref", ref, target, ZERO_OID]);
}

/**
 * Appends one commit holding `content` as the scope's record: the blob is
 * written first (content in, oid out), wrapped in a one-entry tree, committed
 * with the fixed identity and clock, and the ref is moved only if its current
 * value still is `base` — the append is a pure extension of the recorded
 * history, the forward-only guarantee made physical (contract §2.2). Returns
 * the new tip; returns null without moving anything when the ref's current
 * value is not `base` — the loser side, decided here so callers never map a
 * race to an exception.
 */
export function casAppendCommit(
  git: GitRun,
  ref: string,
  content: string,
  base: string | null,
): string | null {
  const current = readRef(git, ref);
  if (current !== base) {
    return null;
  }
  const blob = git(["hash-object", "-w", "--stdin"], content).trim();
  const tree = git(["mktree"], `100644 blob ${blob}\trecord\n`).trim();
  const commit = (
    base === null
      ? git(["commit-tree", tree, "-m", "release-craft: append"])
      : git(["commit-tree", tree, "-p", base, "-m", "release-craft: append"])
  ).trim();
  try {
    git(["update-ref", ref, commit, base ?? ZERO_OID]);
  } catch (error) {
    // The read-check above passed but the ref lock refused: a concurrent
    // writer moved the ref inside the race window — the loser outcome, not
    // a fault. A genuine fault (corrupt repository) still propagates.
    if (error instanceof GitFaultError && readRef(git, ref) !== current) {
      return null;
    }
    throw error;
  }
  return commit;
}

/**
 * The scope's history, root-first — the read path that reconstructs the
 * tail (contract §2.2). rev-list prints tip-first, so the lines reverse;
 * an absent ref reads as an empty history.
 */
export function firstParentHistory(git: GitRun, ref: string): readonly string[] {
  if (readRef(git, ref) === null) {
    return [];
  }
  return git(["rev-list", "--first-parent", ref])
    .split("\n")
    .filter((line) => line.length > 0)
    .reverse();
}

/** The scope record a commit holds — the canonical form exactly as written. */
export function commitRecord(git: GitRun, commit: string): string {
  return git(["show", `${commit}:record`]);
}

/** Reads a blob by oid. */
export function readBlob(git: GitRun, oid: string): string {
  return git(["cat-file", "blob", oid]);
}

/** Writes a blob and returns its oid. */
export function writeBlob(git: GitRun, content: string): string {
  return git(["hash-object", "-w", "--stdin"], content).trim();
}
