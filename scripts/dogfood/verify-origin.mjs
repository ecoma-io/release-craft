// The self-release's origin leg (#259) — the post-run verification that
// the run's claims are origin's state, judged in-job like the dogfood's
// four classes (phase 14 §7) and printed in the judge's row shape. The
// issue's first silent-failure class is exactly this: a dispatch that
// looks green while the mint never reached origin — a token without write
// scope, a push refused, a ref namespace mismatch, a remote that is not
// the repository the dispatch ran on.
//
//     node scripts/dogfood/verify-origin.mjs --before <file> --after <file> \
//       --local-before <file> --expect-kind <kind> [--expect-origin <url>]
//
//   --before / --after  `git ls-remote origin` captured before the run and
//                       after the publish step (the workflow writes both)
//   --local-before      the `for-each-ref` snapshot captured before the run
//   --expect-kind       the kind the dispatch declared (a workflow_dispatch
//                       input) — the band decides what origin must look like
//   --expect-origin     the repository the dispatch ran on, as a remote URL
//                       (the #177 credentials-origin cross-check's spirit at
//                       the caller layer: the run's credential authenticates
//                       one repository, and the mint's "origin" must be it)
//
//   RC_OUTCOME          the run door's `outcome` output — the --json envelope
//
// The band is decided by the envelope's rendered kind — reality, not the
// dispatch's word (a disagreement between the two is the judge's own
// failing row, this script's rows stay readable beside it):
//
//   - a `published` verdict claims a mint: every (refname, sha) pair the
//     run minted locally must be present on origin after the publish
//     step, the envelope's named tag among them, and the mint must be
//     nonempty;
//   - any other verdict claims nothing: origin must be byte-identical to
//     its before-state — the replay posture's own assertion. The failed
//     attempt's local claim ref (the walk acquires before it validates)
//     stays local evidence; it must NOT ride origin;
//   - an envelope that never arrived claims nothing either: the same
//     unchanged assertion, with the reason named — no run, no writes.
//
// What a running job cannot read stays explicit rather than passed: the
// push's own exit is the publish step's row, not this script's; here the
// origin state is read back and compared. Exit codes: 0 the band's rows
// hold · 1 a row failed · 64 usage fault. Imports `node:` modules and the
// judge's exported bands — one conclusion-table copy, cross-pinned by the
// judge's own suite — never the package it serves.
import { spawnSync } from "node:child_process";

import { CONCLUSION_BANDS } from "./judge.mjs";
import {
  currentRefs,
  mintedPairs,
  parseForEachRef,
  parseLsRemote,
  readSnapshot,
} from "./refs-snapshot.mjs";

/** The usage fault's exit (phase 12 §3.2, inherited). */
const EXIT_USAGE = 64;

/**
 * One judged row, the judge's own shape so the two verdicts read alike on
 * the run page and in the job summary.
 *
 * @typedef {{ name: string, state: "PASS" | "FAIL", detail: string }} Row
 */

/** @type {Row[]} */
const rows = [];

/**
 * @param {string} name
 * @param {string} detail
 * @returns {void}
 */
function pass(name, detail) {
  rows.push({ name, state: "PASS", detail });
}

/**
 * @param {string} name
 * @param {string} detail
 * @returns {void}
 */
function fail(name, detail) {
  rows.push({ name, state: "FAIL", detail });
}

/**
 * Normalizes a remote URL for the origin-agreement row: protocol and
 * credential spellings vary (`https://github.com/o/r`, `git@github.com:o/r`);
 * the repository path does not.
 *
 * @param {string} url
 * @returns {string}
 */
function normalizeRemote(url) {
  return url
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

/**
 * Parses this script's argv: flags only, one value each, no repeats;
 * `--expect-origin` keeps its optional default.
 *
 * @param {readonly string[]} argv this script's argv
 * @returns {Map<string, string>}
 */
function parseProtocol(argv) {
  /** @type {Map<string, string>} */
  const values = new Map();
  const known = new Set(["before", "after", "local-before", "expect-kind", "expect-origin"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) {
      throw new Error(`unexpected argument "${String(token)}" — the protocol is flags only`);
    }
    const name = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`flag --${name} demands a value`);
    }
    if (!known.has(name)) {
      throw new Error(
        `unknown flag --${name} — the protocol is --before, --after, --local-before, --expect-kind, --expect-origin`,
      );
    }
    if (values.has(name)) {
      throw new Error(`flag --${name} is declared once`);
    }
    values.set(name, value);
    index += 1;
  }
  for (const name of ["before", "after", "local-before", "expect-kind"]) {
    if (!values.has(name)) {
      throw new Error(`missing --${name}`);
    }
  }
  return values;
}

/**
 * Runs one read-only git command. The verify step reads; it never writes.
 *
 * @param {readonly string[]} args git's argv
 * @returns {string} the command's stdout
 */
function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${String(result.error ?? result.stderr)?.trim()}`,
    );
  }
  return result.stdout ?? "";
}

/**
 * @param {readonly string[]} declared the run union, for the fault line
 * @returns {never}
 */
function usageFault(declared) {
  process.stderr.write(
    `verify-origin: --expect-kind is not a kind of the run union — the union is ${declared.join(", ")}\n`,
  );
  return process.exit(EXIT_USAGE);
}

/**
 * @param {Map<string, string>} options parsed argv
 * @param {readonly string[]} declaredUnion the run union, for the fault line
 * @returns {boolean} the verdict
 */
function verify(options, declaredUnion) {
  const expectKind = /** @type {string} */ (options.get("expect-kind"));
  if (
    !CONCLUSION_BANDS.proceed.includes(expectKind) &&
    !CONCLUSION_BANDS.stop.includes(expectKind)
  ) {
    usageFault(declaredUnion);
  }

  const beforeRemote = readSnapshot(/** @type {string} */ (options.get("before")), parseLsRemote);
  const afterRemote = readSnapshot(/** @type {string} */ (options.get("after")), parseLsRemote);
  const beforeLocal = readSnapshot(
    /** @type {string} */ (options.get("local-before")),
    parseForEachRef,
  );
  const afterLocal = currentRefs(".");

  // The band: the envelope's rendered kind. A missing or unparseable
  // envelope claims nothing — the unchanged band, the reason named (the
  // judge owns the envelope's own rows).
  const survivor = process.env.RC_OUTCOME ?? "";
  let kind = "";
  let tag = "";
  let envelopeReadable = false;
  if (survivor !== "") {
    try {
      const envelope = /** @type {any} */ (JSON.parse(survivor));
      if (envelope !== null && typeof envelope === "object" && typeof envelope.kind === "string") {
        kind = envelope.kind;
        tag = typeof envelope.tag === "string" ? envelope.tag : "";
        envelopeReadable = true;
      }
    } catch {
      // left unreadable — the band below states so
    }
  }
  const publishedBand = envelopeReadable && kind === "published";
  pass(
    "the band is the envelope's rendered kind",
    envelopeReadable
      ? `"${kind}" → origin must ${publishedBand ? "carry the mint" : "be unchanged"}`
      : "no readable envelope — no claimed mint, origin must be unchanged (the envelope's own rows are the judge's)",
  );

  // The origin-agreement row: the remote the mint landed on is the
  // repository the dispatch ran on.
  const expectOrigin = options.get("expect-origin");
  if (expectOrigin === undefined) {
    fail(
      "origin is the dispatching repository",
      "--expect-origin was not declared — the cross-check this row exists for ran nowhere; declare the dispatching repository",
    );
  } else {
    const actual = git(["remote", "get-url", "origin"]).trim();
    if (normalizeRemote(actual) === normalizeRemote(expectOrigin)) {
      pass("origin is the dispatching repository", normalizeRemote(actual));
    } else {
      fail(
        "origin is the dispatching repository",
        `origin is "${normalizeRemote(actual)}"; the dispatch ran on "${normalizeRemote(expectOrigin)}" — the mint must not ride another repository`,
      );
    }
  }

  if (!publishedBand) {
    const unchanged =
      beforeRemote.size === afterRemote.size &&
      [...beforeRemote].every(([ref, sha]) => afterRemote.get(ref) === sha);
    if (unchanged) {
      pass(
        "origin is unchanged",
        `${afterRemote.size} refs before, the same ${afterRemote.size} after — the ${kind === "" ? "absent" : `"${kind}"`} verdict minted nothing on origin`,
      );
    } else {
      const changed = [...afterRemote]
        .filter(([ref, sha]) => beforeRemote.get(ref) !== sha)
        .map(([ref]) => ref);
      const removed = [...beforeRemote.keys()].filter((ref) => !afterRemote.has(ref));
      fail(
        "origin is unchanged",
        `origin moved under a verdict that claims no mint — new or moved: ${changed.join(", ") || "none"}; removed: ${removed.join(", ") || "none"}`,
      );
    }
  } else {
    const minted = mintedPairs(beforeLocal, afterLocal);
    if (minted.length === 0) {
      fail(
        "the mint is nonempty",
        "the run rendered published and minted no local ref — the publish step's own fault row repeats here",
      );
    } else {
      pass("the mint is nonempty", `${minted.length} ref(s) minted locally`);
      const missing = minted.filter((pair) => afterRemote.get(pair.ref) !== pair.sha);
      if (missing.length === 0) {
        pass(
          "every minted ref reached origin",
          minted.map((pair) => `${pair.ref} ${pair.sha.slice(0, 12)}`).join(", "),
        );
      } else {
        fail(
          "every minted ref reached origin",
          `${missing.length} of ${minted.length} minted ref(s) absent from or different on origin: ${missing
            .map((pair) => pair.ref)
            .join(
              ", ",
            )} — the mint did not land (token scope, a refused push, or a namespace mismatch)`,
        );
      }
      const tagPair = minted.find((pair) => pair.ref === `refs/tags/${tag}`);
      if (tag !== "" && tagPair !== undefined && afterRemote.get(tagPair.ref) === tagPair.sha) {
        pass("the envelope's tag is on origin", `refs/tags/${tag} ${tagPair.sha.slice(0, 12)}`);
      } else {
        fail(
          "the envelope's tag is on origin",
          `the envelope names "${tag}" and the mint does not carry it — a published verdict without its tag is not a release`,
        );
      }
    }
  }

  const failed = rows.filter((row) => row.state === "FAIL").length;
  return failed === 0;
}

/** Declared here so the usage fault's message carries the union it means. */
const DECLARED_UNION = [...CONCLUSION_BANDS.proceed, ...CONCLUSION_BANDS.stop];

/** @type {Map<string, string>} */
let options;
try {
  options = parseProtocol(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `verify-origin: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.stderr.write(
    "usage: node scripts/dogfood/verify-origin.mjs --before <file> --after <file> --local-before <file> --expect-kind <kind> [--expect-origin <url>]\n",
  );
  process.exit(EXIT_USAGE);
}

const certified = verify(/** @type {Map<string, string>} */ (options), DECLARED_UNION);

const lines = ["self-release origin leg — the run's claims read back against origin (#259)", ""];
for (const row of rows) {
  lines.push(`- origin · ${row.name}: **${row.state}** — ${row.detail}`);
}
lines.push("");
lines.push(
  certified
    ? "verdict: HOLD — origin's state is exactly the run's claim"
    : "verdict: BROKEN — the origin leg failed; a green judge over an un-landed mint is the silent failure this leg exists to catch",
);
console.log(lines.join("\n"));
process.exit(certified ? 0 : 1);
