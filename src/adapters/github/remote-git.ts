/**
 * The adapter's transport-level git (the Phase 9 contract §2.7): the
 * `ls-remote` and `push` the remote synchronization runs against the
 * binding's own repository — `-C binding.repo` is the structural tie, so
 * the pushed objects can only come from the binding's repository. The
 * invocation is node's own `spawnSync` (the no-runtime-dependency house
 * rule), synchronous like every door.
 *
 * The child's environment is the binding's own hermetic floor — the
 * ambient process environment never reaches git — plus the token the
 * credential helper reads. The credential crosses to git as that
 * environment variable, never as an argument (visible in process
 * listings) and never in the URL (which git echoes in errors). The
 * empty-string helper first resets the helper list, so no ambient
 * credential store can authenticate the push (the no-ambient-credentials
 * law, §3): the supplied token is the only credential this process has.
 */

import { spawnSync } from "node:child_process";

import { GitFaultError, hermeticGitEnv } from "../git/index.js";
import type { RefusalReason } from "./adapter-types.js";

/** Ledger tails and claim records are small; the ceiling exists so a
 *  runaway remote listing fails loudly instead of truncating silently —
 *  the binding runner's own ceiling. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** The wall every remote git call runs against. A push that outlives it
 *  returns `ambiguous` — the write may have landed; a listing that
 *  outlives it is a read failure (`transport-failure`), there is no write
 *  to be ambiguous about. */
const GIT_TIMEOUT_MS = 30_000;

/** The helper the push authenticates through: answers git's credential
 *  query with the x-access-token username and the token from the child's
 *  own environment. Git runs helpers through a shell; the argument here
 *  is a single `argv` entry, so no shell quoting crosses the spawn. */
const CREDENTIAL_HELPER =
  "!f(){ echo username=x-access-token; echo password=$RELEASE_CRAFT_GITHUB_TOKEN; }; f";

/** The child's environment: the binding's hermetic floor plus the
 *  prompt-proof switch (a remote that would ask for credentials must
 *  fail the invocation, not hang it). */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...hermeticGitEnv(),
  GIT_TERMINAL_PROMPT: "0",
};

/**
 * One synchronous remote git invocation's raw result. `timedOut` is the
 * spawn timeout (the child was killed before exiting) — the distinction
 * `syncRemote` maps to `ambiguous` on writes.
 */
export interface RemoteGitOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** The adapter's git runner: one opened repository (the binding's), one
 *  credential in the child environment, `ls-remote` and `push` only. */
export type RemoteGitRun = (args: readonly string[]) => RemoteGitOutcome;

/** Node attaches the errno to a spawn failure as an ad-hoc `code`
 *  property; this reads it without widening `Error`. */
const errorCode = (error: Error | undefined): string | undefined => {
  if (error !== undefined && "code" in error) {
    return String(error.code);
  }
  return undefined;
};

/** Opens the transport-level git runner on the binding's repository. The
 *  missing `git` binary is an environmental fault, not a remote outcome —
 *  it throws here, like the binding's own runner does, and never crosses
 *  a sync outcome. */
export function openRemoteGit(config: {
  readonly repoPath: string;
  readonly token: string;
}): RemoteGitRun {
  return (args) => {
    const result = spawnSync(
      "git",
      [
        "-C",
        config.repoPath,
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=${CREDENTIAL_HELPER}`,
        ...args,
      ],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        encoding: "utf8",
        env: { ...GIT_ENV, RELEASE_CRAFT_GITHUB_TOKEN: config.token },
        windowsHide: true,
      },
    );
    const code = errorCode(result.error);
    if (code === "ENOENT") {
      throw new GitFaultError(args, null, "git is not available (spawn ENOENT)");
    }
    return {
      code: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.signal === "SIGTERM" || code === "ETIMEDOUT",
    };
  };
}

/**
 * Maps a failed remote git call's stderr onto the contract's refusal
 * vocabulary (§2.3): the rate-limit check runs first (GitHub reports rate
 * limits over HTTP 403, which would otherwise read as an auth failure),
 * then the authentication patterns — a rejected credential is
 * `auth-expired`, the one refusal an expired token can produce. Anything
 * else is `transport-failure`: the remote's own state is unknown, the
 * caller retries.
 */
export function classifyGitFailure(stderr: string): RefusalReason | "transport-failure" {
  const text = stderr.toLowerCase();
  if (text.includes("rate limit") || text.includes("secondary rate")) {
    return "rate-limited";
  }
  if (
    /authentication|401|403|access denied|could not read username|invalid credentials|invalid username|permission to .* denied/.test(
      text,
    )
  ) {
    return "auth-expired";
  }
  return "transport-failure";
}
