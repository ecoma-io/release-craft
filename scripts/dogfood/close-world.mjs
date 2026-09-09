// The self-dogfood's world closure — the CALLER's half of the `--world`
// document (phase 12 §2.4: "the caller closes the world; the CLI discovers
// nothing"). It observes this repository's checkout through git subprocesses
// and prints the closed PlanningInput on stdout; the workflow that feeds the
// run redirects it to a file.
//
// This is caller-side tooling for the self-dogfood slice (#139) and nothing
// more: it is NOT the world-reader product slice — phase 12 §7 reserves that
// read seam as its own reviewed change — so it must never grow a
// binding-shaped read (no HEAD, no working tree, no recorded-state reads:
// the world is the declared half below plus what this one git walk sees).
// It imports `node:` modules only, never the package it feeds; the CLI and
// the planner own every validation past the shape this document carries.
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
// The declared half is fixed and cited below: the policy block the planner
// normalizes, the single-component posture (D17(8)), and the recorded
// bootstrap decision (S-02) that carries the run across the empty-tag
// runway. Everything is deterministic: no clock, no randomness, no ambient
// environment reads — the bootstrap `when` is a recorded constant, not a
// clock read.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
 * Runs git in the checkout this script stands in and returns stdout. A
 * failing git call is a closure fault, not an empty observation: a world
 * that silently under-observes is a declared lie.
 *
 * @param {readonly string[]} args git's argv
 * @returns {string} the command's stdout
 */
function git(args) {
  const child = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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
 * @param {string} pattern the for-each-ref pattern (`refs` for everything)
 * @returns {{ name: string, head: string }[]}
 */
function observeRefs(pattern) {
  return git(["for-each-ref", "--format=%(refname)%00%(*objectname)%00%(objectname)", pattern])
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
 * @returns {{ sha: string, parents: string[], message: string, committedAt: string }[]}
 */
function observeCommits() {
  // \x1e opens a record; \x00 separates the fields; %B rides last, so any
  // separator bytes inside a message body stay inside the last field.
  const output = git(["log", FEED_REF, "--format=%x1e%H%x00%P%x00%cI%x00%B"]);
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
 * @param {{ name: string, head: string }[]} refs
 * @returns {Map<string, string[]>} commit sha → ref names, in ref order
 */
function containingRefsByCommit(refs) {
  /** @type {Map<string, string[]>} */
  const byCommit = new Map();
  for (const ref of refs) {
    for (const sha of git(["rev-list", ref.name]).split("\n")) {
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
 * @returns {string} the manifest's declared version
 */
const manifestVersion = () => {
  const manifest = /** @type {{ version?: unknown }} */ (
    JSON.parse(readFileSync("package.json", "utf8"))
  );
  const version = manifest.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package.json carries no version — the component's projection is undeclared");
  }
  return version;
};

function main() {
  const commits = observeCommits();
  // The closed sha universe: ref heads and tag bindings may only point into
  // the observed commits (the normalization's closure law — a pointer
  // outside it is a refused world, so the caller declares none).
  const universe = new Set(commits.map((commit) => commit.sha));
  const refs = observeRefs("refs").filter((ref) => universe.has(ref.head));
  const containingRefs = containingRefsByCommit(refs);
  const observed = commits.map((commit) => ({
    ...commit,
    containingRefs: containingRefs.get(commit.sha) ?? [],
  }));
  const world = {
    policy: POLICY,
    repository: { commits: observed, refs },
    history: {
      tags: observeRefs("refs/tags").map((tag) => ({ name: tag.name, commit: tag.head })),
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
        manifestVersion: manifestVersion(),
        paths: ["package.json"],
      },
    ],
    bootstrap: BOOTSTRAP,
  };
  process.stdout.write(`${JSON.stringify(world, null, 2)}\n`);
}

main();
