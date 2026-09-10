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

/**
 * The all-zero object id — update-ref's "expected old value: absent".
 * Deliberately the sha1 width: the runner's open guard refuses any other
 * object format before a CAS can run (#184; D48), so this constant is
 * total over every substrate a runner can open on.
 */
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
 * The bounded patience the contended-ref-lock window gets (#183; D52): when
 * `update-ref` dies on a held ref lock and the re-read cannot yet
 * discriminate, the whole compare-and-swap re-spawns at most this many
 * times before the fault fails closed. Every spawn carries git's own lock
 * retry (`core.filesRefLockTimeout`, 100ms by default — documented from
 * v2.29.0 through v2.55.0), so the budget is a fraction of a second of
 * lock-wait — far past any live winner's critical section (a lock-hold
 * git's own retry already absorbs, verified first-hand: a 50ms hold loses
 * no race on git 2.55.0) — and never an unbounded wait on a stale lock,
 * which is why the window is bounded here rather than mapped to a plain
 * loss: the acquire and channel loops above `casAppendCommit` are
 * unbounded, and a stale lock fed to them as a loss would spin forever.
 */
const MAX_LOCK_ATTEMPTS = 3;

/**
 * Whether a failed `update-ref` died on the ref's own lock file: the
 * byte-exact first line git's files backend prints when the lock's
 * exclusive create finds the file already there — `cannot lock ref
 * '<ref>': Unable to create '<path>.lock': File exists.` (the EEXIST
 * branch of `unable_to_lock_message`, `strerror(EEXIST)` under the
 * runner's pinned C locale; verified in git's source at v2.34.0 and
 * v2.55.0 and first-hand on this machine's git). The advisory text that
 * follows the first line varies across git versions and `core.lockfilePid`
 * states, so the shape keys on the first line alone. Everything else — a
 * permission denial (`…lock': Permission denied`, no trailing period), the
 * old-value refusals (`is at … but expected …`, `reference already
 * exists`), a foreign lock file's path — does not match and fails closed.
 */
const isRefLockContention = (ref: string, stderr: string): boolean => {
  const marker = `cannot lock ref '${ref}': Unable to create '`;
  const start = stderr.indexOf(marker);
  return start >= 0 && /^[^'\n]+\.lock': File exists\.\n/.test(stderr.slice(start + marker.length));
};

/**
 * Appends one commit holding `content` as the scope's record: the blob is
 * written first (content in, oid out), wrapped in a one-entry tree, committed
 * with the fixed identity and clock, and the ref is moved only if its current
 * value still is `base` — the append is a pure extension of the recorded
 * history, the forward-only guarantee made physical (contract §2.2). Returns
 * the new tip; returns null without moving anything when the ref's current
 * value is not `base` — the loser side, decided here so callers never map a
 * race to an exception. A refused `update-ref` is classified here too
 * (#183; D52): the re-read decides the loss (a ref that moved is the loser
 * outcome, whatever the failure's spelling); the one window the re-read
 * cannot yet discriminate — the winner still holding the ref lock — is
 * positively identified by the lock-contention stderr shape and retried
 * with bounded patience; every other shape faults loudly, so a real
 * substrate failure is never downgraded to a silent loss.
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
    if (error instanceof GitFaultError) {
      // The read-check above passed but the ref lock refused. The re-read
      // decides first, whatever the failure's spelling: a ref that moved
      // inside the race window is the loser outcome — a concurrent
      // winner's fact, never a fault.
      if (readRef(git, ref) !== current) {
        return null;
      }
      // The window the re-read cannot discriminate (#183): the winner still
      // holds the ref lock and has not yet moved the ref, so a benign
      // loser's failure reads byte-identically to a stuck one. The shape
      // decides — only the byte-exact lock-contention spelling retries,
      // with bounded patience: each retry re-runs the whole
      // compare-and-swap, so a released lock lands (the retry's own
      // old-value check re-verifies `base` in git), a ref that moved under
      // the retries classifies as the loss, and a lock that never frees
      // exhausts the budget and fails closed. Every other spelling — a
      // permission denial, a corrupt repository, the ref vanished —
      // propagates immediately, still a fault.
      if (isRefLockContention(ref, error.stderr)) {
        let last = error;
        for (let attempt = 1; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
          try {
            git(["update-ref", ref, commit, base ?? ZERO_OID]);
            return commit;
          } catch (retry) {
            if (retry instanceof GitFaultError) {
              if (readRef(git, ref) !== current) {
                return null;
              }
              if (isRefLockContention(ref, retry.stderr)) {
                last = retry;
              } else {
                throw retry;
              }
            } else {
              throw retry;
            }
          }
        }
        throw last;
      }
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
