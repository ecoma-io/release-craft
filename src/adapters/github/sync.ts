/**
 * The remote synchronization — the Phase 9 contract §2.2's `syncRemote()`
 * over the binding's read seam (§2.7). The binding's recorded state (its
 * claim refs and declared-namespace tags, each with the object it names)
 * is the truth; the remote is a projection this unit brings up to date:
 *
 * - one `ls-remote` listing verifies idempotency before any write (§2.4)
 *   — a ref the remote already holds at the recorded target is `skipped`,
 *   and no push is attempted for it;
 * - a ref the remote holds at a *different* target is the recorded
 *   conflict `already-pushed-different-target` — the remote's ref is
 *   someone else's history, never silently overwritten;
 * - a push that lands reports `pushed`; a push rejected as non-fast-
 *   forward (a write that raced this one) is re-listed once and decided
 *   from what the remote actually holds — same target is `skipped`,
 *   different is the conflict, still absent is `transport-failure`;
 * - a push that outlives the spawn timeout reports `ambiguous` — the
 *   write may have landed; verification is the caller's separate read.
 *
 * The assembly composes it (with the release and reconciliation units)
 * behind the `openGitHubAdapter` factory — implementation, never a
 * public crossing: the §2.6 barrel exports the factory and the surface
 * types only.
 */

import { GitFaultError, type GitBinding } from "../git/index.js";
import type { GitHubCredentials, SyncReport, SyncedRef } from "./adapter-types.js";
import {
  classifyGitFailure,
  openRemoteGit,
  type RemoteGitOutcome,
  type RemoteGitRun,
} from "./remote-git.js";

/** The remote's refs as `ls-remote` reports them: ref → object. A tag
 *  entry's `^{}` peel line overwrites the tag object's own oid, so every
 *  value here is comparable against the binding's recorded targets (the
 *  commit for tags, the record's blob for claim refs). */
type RemoteListing = ReadonlyMap<string, string>;

/** One listing's outcome: the refs, or the raw failure. */
type RemoteListOutcome =
  | { readonly ok: true; readonly refs: RemoteListing }
  | { readonly ok: false; readonly raw: RemoteGitOutcome };

/** The recorded state one sync row projects. */
type RecordedRef = {
  readonly ref: string;
  readonly target: string;
  readonly kind: "claim" | "tag";
};

/** Maps a failed remote call onto the outcome vocabulary: the classifier
 *  names a refusal, and its "unknown" verdict is the outcome state
 *  itself — no cast, no invented fields. */
const failureOutcome = (stderr: string): SyncedRef["outcome"] => {
  const reason = classifyGitFailure(stderr);
  return reason === "transport-failure"
    ? { state: "transport-failure" }
    : { state: "refused", reason };
};

const listRemote = (git: RemoteGitRun, url: string): RemoteListOutcome => {
  const listing = git(["ls-remote", url]);
  if (listing.code !== 0) {
    return { ok: false, raw: listing };
  }
  const refs = new Map<string, string>();
  for (const line of listing.stdout.split("\n")) {
    const at = line.indexOf("\t");
    if (at < 0) {
      continue;
    }
    const oid = line.slice(0, at);
    const ref = line.slice(at + 1);
    if (ref.endsWith("^{}")) {
      refs.set(ref.slice(0, -3), oid);
    } else {
      refs.set(ref, oid);
    }
  }
  return { ok: true, refs };
};

/** One push, and the outcome its raw result maps to. A non-zero exit
 *  whose stderr names the remote's rejection is the raced-write path —
 *  reported back as `rejected` so the sync re-lists and decides from the
 *  remote's actual state; a timeout is `ambiguous`; every other failure
 *  classifies from the stderr. */
const pushRef = (
  git: RemoteGitRun,
  url: string,
  ref: string,
):
  { kind: "pushed" } | { kind: "rejected" } | { kind: "failed"; outcome: SyncedRef["outcome"] } => {
  const pushed = git(["push", url, `${ref}:${ref}`]);
  if (pushed.code === 0) {
    return { kind: "pushed" };
  }
  if (pushed.stderr.includes("[rejected]") || pushed.stderr.includes("[remote rejected]")) {
    return { kind: "rejected" };
  }
  if (pushed.timedOut) {
    return { kind: "failed", outcome: { state: "ambiguous" } };
  }
  return { kind: "failed", outcome: failureOutcome(pushed.stderr) };
};

const syncOneRef = (
  git: RemoteGitRun,
  url: string,
  remote: RemoteListing,
  recorded: RecordedRef,
): SyncedRef => {
  const remoteTarget = remote.get(recorded.ref);
  if (remoteTarget === recorded.target) {
    return { ...recorded, outcome: { state: "skipped" } };
  }
  if (remoteTarget !== undefined) {
    return {
      ...recorded,
      outcome: { state: "refused", reason: "already-pushed-different-target" },
    };
  }
  const attempt = pushRef(git, url, recorded.ref);
  if (attempt.kind === "pushed") {
    return { ...recorded, outcome: { state: "pushed" } };
  }
  if (attempt.kind === "failed") {
    return { ...recorded, outcome: attempt.outcome };
  }
  // The push raced another writer. One re-list decides from what the
  // remote actually holds — never a silent retry of the write (§2.3).
  const raced = listRemote(git, url);
  if (raced.ok) {
    const racedTarget = raced.refs.get(recorded.ref);
    if (racedTarget === recorded.target) {
      return { ...recorded, outcome: { state: "skipped" } };
    }
    if (racedTarget !== undefined) {
      return {
        ...recorded,
        outcome: { state: "refused", reason: "already-pushed-different-target" },
      };
    }
  }
  return { ...recorded, outcome: { state: "transport-failure" } };
};

/**
 * Opens the remote synchronization on an already-opened binding and
 * supplied credentials. The transport target is the binding repository's
 * own configured remote — `origin`, ADR-0010 decision 3's default; the
 * credentials carry the token the push authenticates through. No `origin`
 * configured is an environmental misconfiguration of the repository
 * itself and throws, like a missing git binary — it is not a remote
 * outcome.
 */
export function GitRemoteSync(
  binding: GitBinding,
  credentials: GitHubCredentials,
): { syncRemote(): SyncReport } {
  const git: RemoteGitRun = openRemoteGit({ repoPath: binding.repo, token: credentials.token });
  return {
    syncRemote(): SyncReport {
      const origin = git(["remote", "get-url", "origin"]);
      if (origin.code !== 0) {
        throw new GitFaultError(
          ["remote", "get-url", "origin"],
          origin.code,
          origin.stderr.trim() || "no origin remote is configured",
        );
      }
      const url = origin.stdout.trim();
      const remote = listRemote(git, url);
      if (!remote.ok) {
        // The listing is a read: a timeout is a read failure, not an
        // ambiguous write — nothing has landed to be ambiguous about.
        const outcome = remote.raw.timedOut
          ? ({ state: "transport-failure" } as const)
          : failureOutcome(remote.raw.stderr);
        return {
          refs: [...binding.refs.claims(), ...binding.refs.tags()].map((recorded) => ({
            ...recorded,
            outcome,
          })),
        };
      }
      return {
        refs: [...binding.refs.claims(), ...binding.refs.tags()].map((recorded) =>
          syncOneRef(git, url, remote.refs, recorded),
        ),
      };
    },
  };
}
