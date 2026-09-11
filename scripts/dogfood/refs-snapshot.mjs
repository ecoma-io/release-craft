// The minted-refs snapshot shared by the self-release's two caller-side
// scripts (#259): `publish-mint.mjs` diffs against it to choose what to
// push, `verify-origin.mjs` diffs against it to know what must have
// landed. Caller-side tooling beside `close-world.mjs` and `judge.mjs`,
// under the same law: `node:` imports only — never the package it serves.
//
// The snapshot is a refname → object id map read from one of two spellings:
//
//   - `git for-each-ref --format="%(refname) %(objectname)"` — the LOCAL
//     substrate, before and after the run;
//   - `git ls-remote <remote>` — the REMOTE's refs, `<sha>\t<refname>`,
//     whose `^{}`-suffixed peeled rows (annotated tags) are dropped: the
//     engine's mint is a lightweight tag (`git tag --no-sign`, phase 13
//     §2.8), so a peeled row never carries a mint, and keeping it out of
//     the map is what lets the (refname, sha) pair be compared exactly.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Parses `git for-each-ref --format="%(refname) %(objectname)"` output.
 *
 * @param {string} text the command's stdout
 * @returns {Map<string, string>} refname → object id
 */
export function parseForEachRef(text) {
  const refs = new Map();
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const at = line.indexOf(" ");
    if (at === -1) {
      throw new Error(`for-each-ref line carries no object id: "${line}"`);
    }
    refs.set(line.slice(0, at), line.slice(at + 1));
  }
  return refs;
}

/**
 * Parses `git ls-remote` output into the same shape, dropping the
 * `^{}`-suffixed peeled rows (see the module comment).
 *
 * @param {string} text the command's stdout
 * @returns {Map<string, string>} refname → object id
 */
export function parseLsRemote(text) {
  const refs = new Map();
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const at = line.indexOf("\t");
    if (at === -1) {
      throw new Error(`ls-remote line carries no refname: "${line}"`);
    }
    const name = line.slice(at + 1);
    if (name.endsWith("^{}")) {
      continue;
    }
    refs.set(name, line.slice(0, at));
  }
  return refs;
}

/**
 * Reads a snapshot file written by one of the parsers' own commands.
 *
 * @param {string} path the snapshot file
 * @param {(text: string) => Map<string, string>} parse the matching parser
 * @returns {Map<string, string>} refname → object id
 */
export function readSnapshot(path, parse) {
  return parse(readFileSync(path, "utf8"));
}

/**
 * Runs `git for-each-ref` over the repository and parses it — the live
 * local substrate, read at the moment of the call.
 *
 * @param {string} repo the repository to read
 * @returns {Map<string, string>} refname → object id
 */
export function currentRefs(repo) {
  const result = spawnSync(
    "git",
    ["-C", repo, "for-each-ref", "--format=%(refname) %(objectname)"],
    { encoding: "utf8" },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`git for-each-ref failed: ${String(result.error ?? result.stderr)?.trim()}`);
  }
  return parseForEachRef(result.stdout ?? "");
}

/**
 * The refs the run minted: every refname whose (refname, sha) pair the
 * after-snapshot does not carry identically in the before-snapshot — a
 * created ref or a moved one. The pair, not the name alone, is the claim:
 * the push and the origin verification both assert the exact object the
 * engine left under the name.
 *
 * @param {Map<string, string>} before the local substrate before the run
 * @param {Map<string, string>} after the local substrate after the run
 * @returns {{ ref: string, sha: string }[]} the minted pairs
 */
export function mintedPairs(before, after) {
  const minted = [];
  for (const [ref, sha] of after) {
    if (before.get(ref) !== sha) {
      minted.push({ ref, sha });
    }
  }
  return minted;
}
