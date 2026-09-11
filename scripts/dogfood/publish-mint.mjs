// The self-release's publish half (#259) — the CALLER's transport for the
// mint the run door left in the runner's copy of the repository. Phase 13
// §2.8 decided the Action's own token journey empty: the mint is a local
// `git tag --no-sign`, the records are local CAS ref appends, and nothing
// in the engine names a remote. This script is the workflow's own next
// step, not an Action surface: it pushes exactly the refs the run minted
// locally — the pairs of the snapshot diff — and nothing else.
//
//     node scripts/dogfood/publish-mint.mjs --local-before <file>
//
//   --local-before  the `for-each-ref` snapshot captured before the run
//                   (the workflow's snapshot step writes it)
//
//   RC_OUTCOME      the run door's `outcome` output — the --json envelope
//                   (the same evidence name the judge reads)
//   RC_TOKEN        the credential, already step-scoped by the workflow's
//                   `env:` block (the workflow gate's own law: secrets
//                   travel through `env:`, never a `run:` interpolation)
//
// The authority to publish is the envelope's rendered kind, never the
// dispatch's declaration: a `published` verdict is the engine's own mint
// and is pushed; any other kind minted no release, so nothing is pushed
// and origin stays untouched — the replay posture's own evidence. A
// published verdict that minted no ref, or one whose named tag is absent
// from the mint, is a fault: an envelope claiming a mint the substrate
// does not carry is never published over.
//
// The credential travels exactly the in-tree precedent's class (phase 13
// §2.8, `src/adapters/github/remote-git.ts`): an inline credential helper
// answering from the spawned git's own child environment, behind the
// empty helper that resets any inherited helper list — never persisted to
// config or disk, never an argument (visible in process listings), never
// inside the URL (which git echoes in errors) — with
// `GIT_TERMINAL_PROMPT=0` so a remote that would prompt fails instead of
// hanging. Imports `node:` modules only.
import { spawnSync } from "node:child_process";

import { currentRefs, mintedPairs, readSnapshot, parseForEachRef } from "./refs-snapshot.mjs";

/** The usage fault's exit (phase 12 §3.2, inherited). */
const EXIT_USAGE = 64;

/** The inline credential helper — the precedent's own shape, verbatim:
 * one `argv` entry (git runs helpers through a shell; no shell quoting
 * crosses the spawn), the token read from the child's environment. */
const CREDENTIAL_HELPER = "!f(){ echo username=x-access-token; echo password=$RC_TOKEN; }; f";

/**
 * Runs git in the current working directory and returns stdout. A failing
 * git call is a fault: a push that did not happen is never reported as a
 * publish.
 *
 * @param {readonly string[]} args git's argv
 * @returns {string} the command's stdout
 */
function git(args) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error !== undefined) {
    throw new Error(`git ${args.join(" ")} could not be spawned: ${String(result.error)}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} exited ${String(result.status)}: ${(result.stderr ?? "").trim()}`,
    );
  }
  return result.stdout ?? "";
}

/**
 * Parses this script's argv: `--local-before` demanded once, one value.
 *
 * @param {readonly string[]} argv this script's argv
 * @returns {string} the before-snapshot's path
 */
function localBeforeFromArgv(argv) {
  let path;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--local-before") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new UsageFault("--local-before demands a path");
      }
      if (path !== undefined) {
        throw new UsageFault("--local-before is declared once");
      }
      path = value;
      index += 1;
      continue;
    }
    throw new UsageFault(
      `unexpected argument "${String(argv[index])}" — the protocol is --local-before <path>`,
    );
  }
  if (path === undefined) {
    throw new UsageFault("missing --local-before — the snapshot captured before the run");
  }
  return path;
}

/** The usage fault — protocol violations are loud, never empty pushes.
 * Declared before the try below: a class declared after it would sit in
 * its temporal dead zone on the first throw. */
class UsageFault extends Error {}

try {
  const localBeforePath = localBeforeFromArgv(process.argv.slice(2));

  const survivor = process.env.RC_OUTCOME ?? "";
  if (survivor === "") {
    throw new Error(
      "RC_OUTCOME is empty — the run door's envelope never reached this step; there is nothing to publish and nothing claimed",
    );
  }
  const envelope = /** @type {any} */ (JSON.parse(survivor));

  if (envelope.kind !== "published") {
    // The replay posture: the engine refused, blocked, or otherwise did
    // not mint — origin stays untouched, and the workflow's verify step
    // asserts exactly that. Nothing here is a failure; the declared
    // posture's judgment is the judge's row.
    process.stdout.write(
      `publish-mint: the run rendered "${String(envelope.kind)}" — no release minted, origin untouched\n`,
    );
  } else {
    const tag = envelope.tag;
    if (typeof tag !== "string" || tag === "") {
      throw new Error("a published envelope must name the minted tag as a nonempty string");
    }
    const before = readSnapshot(localBeforePath, parseForEachRef);
    const minted = mintedPairs(before, currentRefs("."));
    if (minted.length === 0) {
      throw new Error(
        "the run rendered published and minted no ref — a publish without a substrate is not a publish",
      );
    }
    const tagPair = minted.find((pair) => pair.ref === `refs/tags/${tag}`);
    if (tagPair === undefined) {
      throw new Error(
        `the envelope names tag "${tag}" and the mint does not carry refs/tags/${tag} — refusing to publish a partial mint`,
      );
    }
    // The exact pairs, object ids included: `sha:ref` pushes the minted
    // object under the minted name, and --atomic makes the set
    // all-or-nothing. The push is never forced: a non-fast-forward
    // rejection (a ref moved on origin under us — two dispatches racing
    // past the concurrency group) fails loudly here, phase 13 §2.9's
    // named divergence, not a silent overwrite.
    git([
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=${CREDENTIAL_HELPER}`,
      "push",
      "--atomic",
      "origin",
      ...minted.map((pair) => `${pair.sha}:${pair.ref}`),
    ]);
    for (const pair of minted) {
      process.stdout.write(`publish-mint: pushed ${pair.ref} ${pair.sha.slice(0, 12)}\n`);
    }
  }
} catch (error) {
  if (error instanceof UsageFault) {
    process.stderr.write(`publish-mint: ${error.message}\n`);
    process.exitCode = EXIT_USAGE;
  } else {
    process.stderr.write(
      `publish-mint: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
