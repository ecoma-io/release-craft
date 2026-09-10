/**
 * The git runner — the binding's one spawn point for the `git` binary.
 * ADR-0009 decision 7 limits the binding to local git object and ref
 * operations, and the no-runtime-dependency house rule keeps the invocation
 * on node's own child_process. Every primitive in the layer speaks through a
 * `GitRun` opened on exactly one repository path, so no binding module names
 * a cwd, an environment, or a buffer ceiling of its own (contract §2.1: the
 * layer consumes, never re-owns).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * An environmental fault of the git invocation itself — the binary missing,
 * the repository corrupt, a ref lock lost. It is not domain vocabulary: the
 * binding's doors map domain outcomes to returned values (contract §2.2's
 * refusal is "never a thrown surprise outside the door") and let this error
 * stand for what it is — the substrate failed.
 */
export class GitFaultError extends Error {
  /** The argv that failed, exactly as handed to the runner. */
  readonly args: readonly string[];
  /** The exit status, or null when git could not be spawned at all. */
  readonly status: number | null;
  /** git's stderr for the failed invocation. */
  readonly stderr: string;

  constructor(args: readonly string[], status: number | null, stderr: string) {
    super(`git ${args.join(" ")} failed (exit ${String(status ?? "unknown")}): ${stderr}`);
    this.name = "GitFaultError";
    this.args = args;
    this.status = status;
    this.stderr = stderr;
  }
}

/**
 * One synchronous git invocation bound to the opened repository: `input` is
 * piped to stdin (hash-object and commit-tree need it), stdout is returned
 * as text. Synchronous because the ports the binding implements are
 * synchronous (the Phase 4/5 locks) and the CAS primitives below lean on
 * git's per-ref lockfile, not on any orchestration of our own.
 */
export type GitRun = (args: readonly string[], input?: string) => string;

/**
 * The fixed identity and clock every deterministic commit carries. Exported
 * for the test fixture, whose root commit must be exactly as deterministic
 * as the binding's own (contract §4's real-repository fixtures must produce
 * object ids that are a pure function of the test's writes).
 */
export const COMMIT_ENV = {
  GIT_AUTHOR_NAME: "release-craft",
  GIT_AUTHOR_EMAIL: "binding@release-craft.local",
  GIT_COMMITTER_NAME: "release-craft",
  GIT_COMMITTER_EMAIL: "binding@release-craft.local",
  GIT_AUTHOR_DATE: "@0 +0000",
  GIT_COMMITTER_DATE: "@0 +0000",
} as const;

/** Ledger tails and claim records are small; the ceiling exists so a runaway
 * rev-list fails loudly instead of truncating silently. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * The git process variables that would resolve a spawned git away from its
 * own `cwd`: repository, work tree, index, and object-database overrides
 * that hook runners and CI wrappers export around their own plumbing. A
 * spawned git's repository must come from the `cwd` alone — the binding
 * opens on one repository; the fixtures build their own — so these are
 * stripped before every spawn. This is the leak that let a fixture commit
 * land on the invoking repository's refs while the suite ran inside a
 * hook.
 */
const LEAKED_GIT_CONTEXT: ReadonlySet<string> = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_INTERNAL_SUPER_PREFIX",
  // GIT_NAMESPACE is repository context by the same law (#180): an export
  // rewrites the root of the ref namespace (gitnamespaces(7)) — the
  // transport paths honor it on every git checked, 2.55.0 included (a
  // namespaced upload-pack advertises only its namespace's refs, verified
  // first-hand), so the strip is live protection for any fetch posture the
  // binding or its callers grow. The plumbing half — namespace-prefixing
  // of ref lookups and iteration, which is what would shadow a local
  // mint — vanished from the env path without a release-note entry
  // between v2.53.0 and v2.54.0 (source archaeology: the "%srefs/"
  // prefixing in refs.c is present through v2.53.0, gone at v2.54.0),
  // which is why a local write under an ambient export lands at the
  // physical path on a modern git. Either way the namespace is part of
  // the repository's identity, and a spawned git's repository must come
  // from the `cwd` alone.
  "GIT_NAMESPACE",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG",
]);

/**
 * The hermetic floor every binding or fixture git spawn runs on: process
 * env minus the leaked repository context, plus no system gitconfig and
 * no credential prompts, plus the deterministic commit identity. Exported
 * for the test fixture, whose spawns must be as hermetic as the
 * binding's own.
 */
export function hermeticGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    // GIT_TRACE* is ambient too: any export makes git write diagnostics to
    // stderr, which would ride the exit-1 shape the ref read's absence
    // discrimination keys on (#95) — a healthy absent ref would read as
    // corruption — and leak operator debugging output into every fault line.
    Object.entries(process.env).filter(
      ([key]) => !LEAKED_GIT_CONTEXT.has(key) && !key.startsWith("GIT_TRACE"),
    ),
  );
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    // The user gitconfig is as ambient as the system one for the binding's
    // law (ADR-0009 decision 7: nothing beyond the repository) — GIT_CONFIG_
    // NOSYSTEM covers only /etc/gitconfig, so the global file is pointed at
    // the empty device and a leaked GIT_CONFIG_GLOBAL is stripped above.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    // The fault-shape discriminations key on byte-exact stderr (D39's
    // empty-stderr absence, D40's absence message pair), and those shapes
    // are stable only under git's own locale — pin the C locale so an
    // operator's translated environment can never reword a fault line
    // into, or out of, a shape the reads discriminate on.
    LC_ALL: "C",
    // Replace objects are disarmed on the floor (#181; D46): a
    // `refs/replace/*` entry substitutes whatever object it names for the
    // recorded one at every read — a record blob read back could hold
    // bytes nobody wrote, the one outcome the binding's byte-exact reload
    // guarantee cannot survive. With the variable set, every spawn reads
    // and walks the recorded objects themselves; the substitution is
    // never honored. (Verified first-hand: `git show <commit>:record`
    // returns the replacement's bytes without the variable, the recorded
    // bytes with it.)
    GIT_NO_REPLACE_OBJECTS: "1",
    ...COMMIT_ENV,
  };
}

/**
 * The substrate shapes a repository must not carry for the binding's
 * guarantees to hold, probed once per runner before its first command on a
 * live repository executes (#181; D45, D47, D48). The refusal is a declared
 * GitFaultError ahead of any door work — never a mid-walk surprise:
 *
 * - **Shallow (D45).** A truncated clone (the `fetch-depth: 1` CI posture)
 *   leaves `rev-list` exiting 0 at the shallow boundary, so a recorded
 *   stream's first-parent walk returns a *prefix* of the records and
 *   resume/planning run over missing history (verified first-hand: a
 *   3-commit stream reads as 1). The binding requires a complete history.
 * - **Grafts (D47).** An `info/grafts` file rewrites recorded parentage
 *   the same walk follows, and nothing disarms it — `GIT_NO_REPLACE_OBJECTS`
 *   does not cover the file channel (verified first-hand: the walk
 *   truncates identically with the variable set). The modern
 *   `git replace --graft` spelling is a replace ref and rides the floor's
 *   disarm (D46); the legacy file does not, so its presence refuses.
 * - **Object format (D48).** The binding is certified on the sha1 object
 *   format: the CAS's all-zero expected-old value is 40 digits wide, and
 *   on a sha256 repository every first write fails git-side with `not a
 *   valid old SHA1` — loud, but mislabeled as a substrate fault (#184).
 *   A sha256 repository refuses there instead; deriving the zero width
 *   from `--show-object-format` is the support path when a consumer needs
 *   it, its own reviewed change.
 *
 * The probe doubles as the repository detector: a first command on a path
 * that is not (yet) a repository — the `git init` a fixture or bootstrap
 * runs through a fresh runner — finds nothing to guard and returns false
 * with no refusal, and the probe re-arms, so the first command after the
 * substrate comes to exist is still guarded. Once a repository has been
 * probed clean the result holds for the runner's lifetime: a shape check
 * reads repository metadata that does not change under the binding's own
 * operations, and re-probing would tax every spawn. Only the object-format
 * probe's own failure is swallowed (as the detector), and only because the
 * requested command behind it faults on the same condition — no refusal
 * the guard owns is ever dropped.
 */
function probeSubstrateShape(repo: string, git: GitRun): boolean {
  let objectFormat: string;
  try {
    objectFormat = git(["rev-parse", "--show-object-format"]).trim();
  } catch {
    // Not a repository (yet): there is no shape to hold guarantees for,
    // and the command this probe fronts faults on exactly that condition
    // if it needs one — the guard adds no refusal of its own here.
    return false;
  }
  if (objectFormat !== "sha1") {
    throw new GitFaultError(
      ["rev-parse", "--show-object-format"],
      null,
      `the repository's object format is ${objectFormat} — the binding's substrate is the sha1 object format, and refusing ahead of the first write beats mislabeling every compare-and-swap as a git fault (#184; D48)`,
    );
  }
  const isShallow = git(["rev-parse", "--is-shallow-repository"]).trim();
  if (isShallow === "true") {
    throw new GitFaultError(
      ["rev-parse", "--is-shallow-repository"],
      null,
      "the repository is a shallow clone — git's walk of a recorded stream stops at the shallow boundary and reads a prefix of the recorded history, so the binding refuses rather than resume over missing records (#181; D45)",
    );
  }
  const graftsPath = git(["rev-parse", "--git-path", "info/grafts"]).trim();
  if (
    graftsPath.length > 0 &&
    existsSync(isAbsolute(graftsPath) ? graftsPath : join(repo, graftsPath))
  ) {
    throw new GitFaultError(
      ["rev-parse", "--git-path", "info/grafts"],
      null,
      `the repository carries a grafts file (${graftsPath}) — grafted parentage rewrites the history a recorded stream's first-parent walk reports, and no variable disarms the file channel, so the binding refuses rather than walk invented history (#181; D47)`,
    );
  }
  return true;
}

/**
 * Opens the binding's git runner on `repo`. The environment is process.env
 * plus the hermetic floor — no system gitconfig, no credential prompts
 * (ADR-0009 decision 7: the binding reads nothing beyond its repository) —
 * and COMMIT_ENV. Baking COMMIT_ENV in is the cleanest way to fix the commit
 * clock while keeping `GitRun`'s two-argument signature: commit dates have
 * no `-c` spelling, and the fixed identity is inert for every
 * non-committing invocation the binding makes (contract §3's law — no clock,
 * no operator identity in the binding). Opening itself spawns nothing — the
 * CLI builds the binding on paths it may never touch, and a fixture
 * bootstraps `git init` through a fresh runner — so the substrate guard
 * (`probeSubstrateShape`) rides the runner's first command instead, ahead
 * of it: a repository the guarantees cannot hold for — shallow, grafted,
 * or a foreign object format — refuses before any door work runs, as a
 * declared fault, never a mid-walk surprise (#181/#184; D45–D48).
 */
export function openGitRun(repo: string): GitRun {
  const env = hermeticGitEnv();
  const spawnGit = (args: readonly string[], input?: string): string => {
    const result = spawnSync("git", [...args], {
      cwd: repo,
      input,
      env,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER_BYTES,
    });
    if (result.error !== undefined || result.status !== 0) {
      // A spawn failure carries no stderr; the error's own message is the
      // honest content for the fault line.
      throw new GitFaultError(args, result.status, result.stderr || result.error?.message || "");
    }
    return result.stdout;
  };
  // The substrate guard runs once per runner, ahead of its first command
  // on a live repository: every entry point that reaches git goes through
  // here, so no door can work a shape the guarantees do not hold for
  // (#181). Until the probe has passed it re-arms on every command, so a
  // repository that comes to exist under a bootstrap runner is guarded
  // from its first real command on.
  let substrateProbed = false;
  const run: GitRun = (args, input) => {
    if (!substrateProbed && probeSubstrateShape(repo, spawnGit)) {
      substrateProbed = true;
    }
    return spawnGit(args, input);
  };
  return run;
}
