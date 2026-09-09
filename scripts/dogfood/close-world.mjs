// The self-dogfood's world closure — the CALLER's half of the `--world`
// document (phase 12 §2.4: "the caller closes the world; the CLI discovers
// nothing"). It observes one repository through git subprocesses and prints
// the closed PlanningInput on stdout; the workflow that feeds the run
// redirects it to a file.
//
//     node scripts/dogfood/close-world.mjs [--repo <path>]
//
// `--repo` names the repository to observe; the default is `.` — the
// workflow's own posture, the checkout the dispatch materialized. The
// self-dogfood's own suite passes the flag explicitly: it seeds a real
// temporary repository and closes THAT, so the green is over a controlled
// tree and never over whatever checkout the suite happened to stand in (a
// pull-request checkout is a detached merge ref holding no `refs/heads/main`
// — the vacuous green this flag exists to make impossible).
//
// This is caller-side tooling for the self-dogfood slice (#139) and nothing
// more: it is NOT the world-reader product slice — phase 12 §7 reserves that
// read seam as its own reviewed change — so it must never grow a
// binding-shaped read: no HEAD, no recorded-state reads, and no working-tree
// observations are asserted into the world. The ONE file read is the
// component's own declared manifest field (`paths[0]`), taken at closure
// time as the projection it is (invariant 6) — never an observation the
// document claims about the repository. It imports `node:` modules only,
// never the package it feeds; the CLI and the planner own every validation
// past the shape this document carries.
//
// The observed half: the commits reachable from `refs/heads/main` (the one
// line's feed ref) — sha, parents, full body, committed date, and the
// containing refs computed from a rev-list set per declared ref (cheap at
// this repository's size) — plus the tags (empty today: this repository has
// never tagged a release). The world is the LINE's, and the planner's closed
// input is the closure law that shapes it (the normalization this document
// must survive): every ref head, tag binding, and parent points into the
// observed commit universe, so the refs declared here are the checkout's
// refs whose heads live inside `refs/heads/main`'s ancestry — the rest of
// the checkout's refs (squash-merged branch tips, merge-queue group refs)
// are observations this world does not assert, and refusing to declare them
// keeps plan identity a function of the line's state rather than of
// unrelated branch tips. The tags are declared as observed, unfiltered: a
// tag the line's universe cannot bind is a closure fault, loudly — a
// silently dropped tag would be the declared lie §2.4 warns about.
//
// The feed ref must exist in the observed repository, and its absence faults
// the closure loudly — a world whose line is unobservable is never silently
// empty. On the dispatch run this holds by construction, not by luck:
// actions/checkout materializes a branch ref with `git checkout --force -B
// <branch> refs/remotes/origin/<branch>` (ref-helper's branch row), so the
// local `refs/heads/main` the line names exists; any other materialization
// shape is a closure fault, which is the honest outcome.
//
// The declared half is fixed and cited below: the policy block the planner
// normalizes, the single-component posture (D17(8)), and the recorded
// bootstrap decision (S-02) that carries the run across the empty-tag
// runway. Everything is deterministic: no clock, no randomness, no ambient
// environment reads — the bootstrap `when` is a recorded constant, not a
// clock read.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The one release line the dogfood runs (phase 12 §2.4: the world document
 * is one document; this repository's line rides `refs/heads/main`). */
const FEED_REF = "refs/heads/main";

/**
 * The policy block, declared and fixed. The digest is an opaque constant,
 * non-empty and unpadded: it is a label the planner carries verbatim into
 * the plan's and every record's identity (invariant 4), never a value the
 * planner interprets — and the dogfood's policy block is itself a fixed
 * declared block, so its identity is a fixed declared label rather than a
 * content hash no surface was ever asked to compute. The rest mirrors the
 * planner's own defaults-as-data posture: the `default` bump mapping, the
 * standard ladder at seed `0`, pre-1.0 dampening, the reserved
 * self-reference namespace, and no declared per-line tag formats (fork 11:
 * the bare default rendering).
 */
const POLICY = {
  digest: "release-craft-self-dogfood-policy-1",
  bumpMappingId: "default",
  prereleaseLadder: ["alpha", "beta", "rc"],
  prereleaseSeed: "0",
  pre10Dampening: true,
  selfReferenceNamespace: "Release-Craft:",
  tagFormats: {},
};

/**
 * The recorded bootstrap decision (S-02) — required over the empty-tag
 * runway: without it the run stops as a `blocked` record at the planning
 * boundary instead of publishing. The values are FIXED RECORDED CONSTANTS,
 * frozen from the repository's initialization commit (5312f25, `chore:
 * initialize release-craft`, John Martin): that commit is the moment the
 * 0.1.0 decision was made and recorded, and the script reads no clock to
 * re-derive what history already records. The version matches package.json's
 * own `version` field — the manifest and the recorded decision agree — but
 * it is deliberately not read from there: the bootstrap is the line's birth
 * record, not the manifest's current state.
 */
const BOOTSTRAP = {
  version: "0.1.0",
  who: "John Martin <john.itvn@gmail.com>",
  when: "2026-09-05T11:13:25+07:00",
};

/**
 * The one declared argument: `--repo <path>`, the repository to observe.
 * The default is the script's own working directory — the workflow's
 * posture, the checkout the dispatch materialized. Anything else on argv is
 * a usage fault, loudly: a closure run over the wrong tree must never look
 * like a green one.
 *
 * @param {readonly string[]} argv this script's argv
 * @returns {string} the repository path
 */
function repoFromArgv(argv) {
  let repo = ".";
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--repo") {
      const path = argv[index + 1];
      if (path === undefined) {
        throw new Error("--repo demands a path");
      }
      if (repo !== ".") {
        throw new Error("--repo is declared once");
      }
      repo = path;
      index += 1;
      continue;
    }
    throw new Error(`unexpected argument "${String(argv[index])}" — the protocol is --repo <path>`);
  }
  return repo;
}

/**
 * Runs git in the observed repository and returns stdout. A failing git
 * call is a closure fault, not an empty observation: a world that silently
 * under-observes is a declared lie.
 *
 * @param {string} repo the repository the command stands in
 * @param {readonly string[]} args git's argv
 * @returns {string} the command's stdout
 */
function git(repo, args) {
  const child = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.error !== undefined) {
    throw new Error(`git ${args.join(" ")} could not be spawned: ${String(child.error)}`);
  }
  if (child.status !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${String(child.status)}: ${child.stderr.trim()}`);
  }
  return child.stdout;
}

/**
 * Observes the refs under one for-each-ref pattern: name plus the commit it
 * heads — an annotated tag's peeled object, a lightweight tag's or branch's
 * own object.
 *
 * @param {string} repo the repository to observe
 * @param {string} pattern the for-each-ref pattern (`refs` for everything)
 * @returns {{ name: string, head: string }[]}
 */
function observeRefs(repo, pattern) {
  return git(repo, [
    "for-each-ref",
    "--format=%(refname)%00%(*objectname)%00%(objectname)",
    pattern,
  ])
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, peeled, object] = line.split("\x00");
      return {
        name: name ?? "",
        head: peeled !== "" && peeled !== undefined ? peeled : (object ?? ""),
      };
    });
}

/**
 * Observes the commits reachable from the line's feed ref, in git's own walk
 * order (newest first): sha, parents, full body (%B), committed date (%cI).
 *
 * @param {string} repo the repository to observe
 * @returns {{ sha: string, parents: string[], message: string, committedAt: string }[]}
 */
function observeCommits(repo) {
  // \x1e opens a record; \x00 separates the fields; %B rides last, so any
  // separator bytes inside a message body stay inside the last field.
  const output = git(repo, ["log", FEED_REF, "--format=%x1e%H%x00%P%x00%cI%x00%B"]);
  return output
    .split("\x1e")
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const at = record.indexOf("\x00");
      const sha = record.slice(0, at).trim();
      const rest = record.slice(at + 1);
      const end = rest.indexOf("\x00");
      const parents = rest.slice(0, end).trim();
      const remainder = rest.slice(end + 1);
      const date = remainder.slice(0, remainder.indexOf("\x00"));
      // The newlines after the body are the record's own framing (%B ends
      // with its terminator newline, the format adds one more); the body's
      // bytes are forwarded verbatim beneath them.
      const message = remainder.slice(remainder.indexOf("\x00") + 1).replace(/\n+$/, "");
      return {
        sha,
        parents: parents.length > 0 ? parents.split(/\s+/) : [],
        message,
        committedAt: date,
      };
    });
}

/**
 * The containing refs per commit, computed from a rev-list set per declared
 * ref — input evidence for attribution, never the ancestry itself (the
 * parent graph stays the authoritative ancestry on the planner's side).
 *
 * @param {string} repo the repository to observe
 * @param {{ name: string, head: string }[]} refs
 * @returns {Map<string, string[]>} commit sha → ref names, in ref order
 */
function containingRefsByCommit(repo, refs) {
  /** @type {Map<string, string[]>} */
  const byCommit = new Map();
  for (const ref of refs) {
    for (const sha of git(repo, ["rev-list", ref.name]).split("\n")) {
      if (sha.length === 0) {
        continue;
      }
      const names = byCommit.get(sha) ?? [];
      byCommit.set(sha, [...names, ref.name]);
    }
  }
  return byCommit;
}

/**
 * The component manifest's version — a projection, never computation truth
 * (invariant 6), read from the manifest the component declares as its path.
 *
 * @param {string} repo the repository whose manifest is read
 * @returns {string} the manifest's declared version
 */
const manifestVersion = (repo) => {
  const manifest = /** @type {{ version?: unknown }} */ (
    JSON.parse(readFileSync(join(repo, "package.json"), "utf8"))
  );
  const version = manifest.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package.json carries no version — the component's projection is undeclared");
  }
  return version;
};

function main() {
  const repo = repoFromArgv(process.argv.slice(2));
  const commits = observeCommits(repo);
  // The closed sha universe: ref heads and tag bindings may only point into
  // the observed commits (the normalization's closure law — a pointer
  // outside it is a refused world, so the caller declares none).
  const universe = new Set(commits.map((commit) => commit.sha));
  const refs = observeRefs(repo, "refs").filter((ref) => universe.has(ref.head));
  const containingRefs = containingRefsByCommit(repo, refs);
  const observed = commits.map((commit) => ({
    ...commit,
    containingRefs: containingRefs.get(commit.sha) ?? [],
  }));
  const world = {
    policy: POLICY,
    repository: { commits: observed, refs },
    history: {
      tags: observeRefs(repo, "refs/tags").map((tag) => ({ name: tag.name, commit: tag.head })),
    },
    lines: [
      {
        id: "main",
        feedRef: FEED_REF,
        lifecycle: "active",
        declared: true,
      },
    ],
    // D17(8)'s single-component posture: exactly one declared component meets
    // exactly one releasing line, so no publishes binding is declared.
    components: [
      {
        name: "@ecoma-io/release-craft",
        manifestVersion: manifestVersion(repo),
        paths: ["package.json"],
      },
    ],
    bootstrap: BOOTSTRAP,
  };
  process.stdout.write(`${JSON.stringify(world, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  // A closure fault — an unobservable line, a failing git call, a protocol
  // violation — is loud, never an empty world: the failing step's own log
  // and conclusion are the evidence.
  process.stderr.write(`close-world: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
