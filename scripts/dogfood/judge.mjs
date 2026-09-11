#!/usr/bin/env node
// The self-dogfood's judge — the CI half of the certification's four classes
// (phase 14 contract §7, issue #187). The workflow captures; until this script
// existed, nothing in CI judged, and a green dogfood run without a human
// reading the ledger was indistinguishable from a certified one — #139's
// certification was a manual log read of run 34470662759.
//
//     node scripts/dogfood/judge.mjs --repo <path> --actor <actor> \
//       --expect-kind <kind> [--ledger-prefix <prefix>]
//
// Two evidence names enter through the environment, never the script source:
//
//   RC_OUTCOME      the run door's `outcome` output — the --json envelope as
//                   the runner's preserving-write replay survived it (§3.1);
//   RC_CONCLUSION   the invoke step's conclusion (`steps.invoke.conclusion`).
//
// The rest is re-read from the substrate the run actually wrote: the ledger
// refs under `refs/release-craft/ledger/**` (each commit carries one `record`
// blob) and the tag namespace. Recorded evidence, not the process's own
// claims — that is what makes class 3 a certification row and not a smoke row.
//
// The boundary, stated so nobody mistakes a partial judge for a total one.
// What is machine-asserted here:
//
//   - class 2 (envelope), in full: the survivor parses and carries the pinned
//     shape inventory for the declared posture, plus §7-adjacent hygiene the
//     certification's own audit ran (invariant 2.12);
//   - class 3 (ledger projection), in full: the promote walk's projection —
//     the plan record, then started→completed pairs for the nine cells in
//     order, every guard passed, the claim chain on the claim-bearing cells —
//     cross-checked against the envelope's drives record for record;
//   - class 4's conclusion half: the step conclusion equals §3.2's row for
//     the observed kind (the proceed/stop partition is the table's whole
//     conclusion column), and the survivor's preserving-write signature (it
//     still ends in exactly the stdout's trailing newline);
//   - class 1 (exit code) at the certified posture's point: `published`
//     demands exit 0, and a `success` conclusion is exactly exit 0 for the
//     invoke shell — so on this workflow's single happy-path dispatch the
//     class holds with no residual. Any other kind reports the row as
//     NOT ASSERTED rather than passing it: a `failure` conclusion bounds a
//     stop-band exit only to nonzero, and the exact §3.2 value lives in the
//     runner's log line — the failure-path leg's judge to close (#187).
//
// What stays a human log read, and says so in the verdict:
//
//   - class 4's first half: the survivor versus the invoke step's verbatim
//     stdout relay, byte for byte. A running job cannot read its own step log
//     through the API; the byte equality is the one log-read row left on the
//     happy path, and closing it belongs to the scheduled failure-path leg's
//     log-reading judge.
//
// One mismatch fails this script (exit 1) and the step with it — §7's gate
// wording is the whole wording: a mismatch is a filed defect against the
// owning slice, never a waived row. Exit codes: 0 the declared posture's
// mechanically available classes hold · 1 a row failed · 64 usage fault.
//
// Caller-side tooling beside `close-world.mjs`, under the same law: it
// imports `node:` modules only — never the package it judges — and reads no
// ambient environment beyond the two evidence names above.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";

/** The usage fault's exit (phase 12 §3.2, inherited). */
const EXIT_USAGE = 64;

/**
 * The conclusion bands (phase 13 §3.2) — the run union partitioned by the
 * step conclusion each kind's row renders. Kept in step with
 * `action/invoke.mjs`'s CONCLUSION_TABLE; `judge.test.mjs` cross-pins the two
 * by reading the table's source, so the copy here cannot drift silently.
 *
 * @type {Readonly<{proceed: readonly string[], stop: readonly string[]}>}
 */
export const CONCLUSION_BANDS = {
  proceed: ["published", "satisfied-externally", "resolved", "abandoned"],
  stop: ["refused", "denied", "blocked", "failed", "conflict", "ambiguous", "stale", "escalate"],
};

/**
 * The kinds whose §3.2 row demands exit 0 — the point where the exit-code
 * class (§7 class 1) is machine-assertable from the step conclusion alone,
 * because a `success` conclusion is exactly exit 0 for the invoke shell. The
 * only member today is the certified posture's own kind. Every other kind's
 * exact exit (1, or 10–17) lives in the runner's log line, not in any
 * machine-readable output, and is reported NOT ASSERTED rather than passed.
 *
 * @type {ReadonlySet<string>}
 */
export const EXIT_ZERO_KINDS = new Set(["published"]);

/**
 * The promote walk's cells, in walk order — §7 class 3's projection shape
 * ("the promote walk's cells, `git-01`/`git-06`"); the order is cross-pinned
 * in `judge.test.mjs` against the fixture's own `git-01` expected stdout.
 *
 * @type {readonly string[]}
 */
export const PROMOTE_CELLS = [
  "plan",
  "claim",
  "prepare",
  "validate",
  "commit",
  "tag",
  "channel-transition",
  "publish",
  "verify",
];

/**
 * The cells whose completed records carry the claim token — every
 * claim-guarded cell of the walk. The `claim` cell itself mints the token and
 * carries only `claim-held`; the cells after it re-verify before recording
 * (`claim-verified`), which is the guard sequence below.
 *
 * @type {ReadonlySet<string>}
 */
const CLAIMED_CELLS = new Set([
  "claim",
  "prepare",
  "commit",
  "tag",
  "channel-transition",
  "publish",
]);

/**
 * The completed records' guard names, in order, per cell — the walk's guard
 * choreography, the stable contract vocabulary. A name ending in `:` matches
 * by prefix: the precondition guard's name embeds the precondition's own
 * bytes (`precondition:{"kind":"tag-absent",…}`), and the judge asserts the
 * precondition was guarded, not the tag's spelling. Guard `detail` strings
 * are never asserted — §7's class-shaped, not byte-shaped, standard.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const PROMOTE_COMPLETED_GUARDS = {
  plan: [],
  claim: ["claim-held"],
  prepare: ["claim-held", "claim-verified"],
  validate: ["precondition:"],
  commit: ["claim-held", "claim-verified"],
  tag: ["claim-held", "claim-verified"],
  "channel-transition": ["claim-held", "claim-verified"],
  publish: ["claim-held", "claim-verified"],
  verify: ["tag-boundary"],
};

/**
 * This script's argv protocol. Every flag takes exactly one value; the first
 * three are demanded on every invocation, the fourth keeps its default.
 *
 * @type {ReadonlyMap<string, string>}
 */
const DEMANDED = new Map([
  ["repo", "the repository whose recorded substrate is judged"],
  ["actor", "the declared actor the run's records must carry"],
  ["expect-kind", "the envelope kind the declared posture demands"],
]);

const DEFAULT_LEDGER_PREFIX = "refs/release-craft/ledger";

/**
 * Parses this script's argv: flags only, one value each, no repeats. A
 * protocol violation is a usage fault — the judge never invents evidence
 * from a malformed invocation.
 *
 * @param {readonly string[]} argv
 * @returns {Map<string, string>}
 */
function parseProtocol(argv) {
  /** @type {Map<string, string>} */
  const values = new Map();
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
    if (values.has(name)) {
      throw new Error(`flag --${name} is declared once`);
    }
    if (!DEMANDED.has(name) && name !== "ledger-prefix") {
      throw new Error(
        `unknown flag --${name} — the protocol is ${[...DEMANDED.keys()].join(", ")}, --ledger-prefix`,
      );
    }
    values.set(name, value);
    index += 1;
  }
  for (const name of DEMANDED.keys()) {
    if (!values.has(name)) {
      throw new Error(`missing --${name} — ${DEMANDED.get(name)}`);
    }
  }
  return values;
}

/**
 * One judged row. `pass` and `fail` are assertions; `note` records a row the
 * judge deliberately does NOT assert, with the reason — a note never
 * contributes to the verdict, but it is always printed, so the boundary
 * between "judged green" and "not judged here" is on every run page.
 *
 * @typedef {{ class: number, name: string, state: "PASS" | "FAIL" | "NOT ASSERTED", detail: string }}
 * Row
 */

/**
 * @param {Row[]} rows
 * @param {number} klass
 * @param {string} name
 * @param {string} detail
 * @returns {void}
 */
function pass(rows, klass, name, detail) {
  rows.push({ class: klass, name, state: "PASS", detail });
}

/**
 * @param {Row[]} rows
 * @param {number} klass
 * @param {string} name
 * @param {string} detail
 * @returns {void}
 */
function fail(rows, klass, name, detail) {
  rows.push({ class: klass, name, state: "FAIL", detail });
}

/**
 * @param {Row[]} rows
 * @param {number} klass
 * @param {string} name
 * @param {string} detail
 * @returns {void}
 */
function note(rows, klass, name, detail) {
  rows.push({ class: klass, name, state: "NOT ASSERTED", detail });
}

/**
 * Runs one read-only git command against the judged repository. The judge
 * reads; it never writes — every invocation below is a pure query.
 *
 * @param {string} repo
 * @param {string[]} args
 * @returns {{ ok: boolean, stdout: string, stderr: string }}
 */
function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.error !== undefined) {
    return { ok: false, stdout: "", stderr: String(result.error) };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Structural deep equality over parsed JSON — the drives cross-check
 * compares the envelope's claimed record against the recorded one, key order
 * irrelevant, arrays in order.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => deepEqual(item, b[index]))
    );
  }
  if (typeof a === "object") {
    const recordA = /** @type {Record<string, unknown>} */ (a);
    const recordB = /** @type {Record<string, unknown>} */ (b);
    const keysA = Object.keys(recordA);
    const keysB = Object.keys(recordB);
    return (
      keysA.length === keysB.length && keysA.every((key) => deepEqual(recordA[key], recordB[key]))
    );
  }
  return false;
}

/**
 * Decodes a ledger ref's final segment back to the attempt id it names — the
 * binding stores `attempt_sha256:…` with the colon percent-encoded, and the
 * envelope's handle names the attempt unencoded.
 *
 * @param {string} refname
 * @returns {string}
 */
function ledgerAttemptId(refname) {
  const segment = refname.slice(refname.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Reads one attempt's ledger tail, oldest record first. Each ledger commit
 * carries exactly one `record` blob; `--first-parent` from the tip is the
 * persistence order, newest first, so the walk reverses it.
 *
 * @param {string} repo
 * @param {string} ref
 * @returns {{ ok: true, records: object[] } | { ok: false, stderr: string }}
 */
function readTail(repo, ref) {
  const listed = git(repo, ["rev-list", "--first-parent", ref]);
  if (!listed.ok) {
    return { ok: false, stderr: listed.stderr.trim() };
  }
  /** @type {object[]} */
  const records = [];
  for (const sha of listed.stdout.split("\n").filter((line) => line !== "")) {
    const shown = git(repo, ["show", `${sha}:record`]);
    if (!shown.ok) {
      return { ok: false, stderr: shown.stderr.trim() };
    }
    try {
      const parsed = JSON.parse(shown.stdout);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, stderr: `${sha}: record is not a JSON object` };
      }
      records.push(parsed);
    } catch (error) {
      return { ok: false, stderr: `${sha}: record does not parse (${String(error)})` };
    }
  }
  return { ok: true, records: records.reverse() };
}

/**
 * Judges the whole capture. Every row lands in `rows`; the return value is
 * the verdict, the caller prints and exits.
 *
 * @param {Map<string, string>} options parsed argv
 * @returns {{ rows: Row[], certified: boolean }}
 */
export function judge(options) {
  /** @type {Row[]} */
  const rows = [];
  const repo = options.get("repo") ?? ".";
  const actor = options.get("actor") ?? "";
  const expectKind = options.get("expect-kind") ?? "";
  const ledgerPrefix = options.get("ledger-prefix") ?? DEFAULT_LEDGER_PREFIX;

  // — class 2: the envelope, as the preserving write survived it —
  const survivor = process.env.RC_OUTCOME ?? "";
  const conclusion = process.env.RC_CONCLUSION ?? "";

  if (survivor === "") {
    fail(
      rows,
      2,
      "survivor present",
      "RC_OUTCOME is empty — the run door's envelope never reached this step (a pre-invocation fault, or the wrong step wiring); there is nothing to judge",
    );
  } else {
    pass(rows, 2, "survivor present", `${Buffer.byteLength(survivor, "utf8")} bytes`);
  }

  /** @type {any} */
  let envelope = null;
  if (survivor !== "") {
    try {
      envelope = JSON.parse(survivor);
    } catch (error) {
      fail(rows, 2, "envelope parses", `the survivor is not JSON (${String(error)})`);
    }
    if (envelope !== null) {
      pass(rows, 2, "envelope parses", "the survivor is one JSON document");
    }
  }

  // The preserving write's signature on the surviving bytes: the replayed
  // value equals the child's stdout including its trailing newline (§3.1, and
  // run 34470662759's certified bytes end in exactly one newline). A
  // survivor that lost the newline is the malformed-write class phase 13 §6
  // fixture 3 exists for.
  if (survivor !== "") {
    if (survivor.endsWith("\n") && !survivor.endsWith("\n\n")) {
      pass(
        rows,
        4,
        "survivor's trailing newline survived",
        "the replayed value still ends in exactly the stdout's one trailing newline (§3.1)",
      );
    } else {
      fail(
        rows,
        4,
        "survivor's trailing newline survived",
        "the survivor does not end in exactly one trailing newline — the preserving write's replay lost or grew bytes",
      );
    }
    if (!survivor.toLowerCase().includes("ecoma")) {
      pass(
        rows,
        2,
        "product boundary (invariant 2.12)",
        "no Ecoma string anywhere in the envelope's bytes — the dogfood surface stays product-neutral",
      );
    } else {
      fail(
        rows,
        2,
        "product boundary (invariant 2.12)",
        "an Ecoma string reached the envelope — invariant 2.12's product-boundary law is broken on the dogfood surface",
      );
    }
  }

  const kind = /** @type {any} */ (envelope)?.kind;
  if (typeof kind !== "string" || kind === "") {
    fail(rows, 2, "kind present", "the envelope carries no kind string");
  } else if (!CONCLUSION_BANDS.proceed.includes(kind) && !CONCLUSION_BANDS.stop.includes(kind)) {
    fail(
      rows,
      2,
      "kind in the run union",
      `"${kind}" is outside the run union — engine drift, the no-verdict row's own subject`,
    );
  } else {
    pass(rows, 2, "kind in the run union", `"${kind}"`);
  }

  if (typeof kind === "string" && kind !== expectKind) {
    fail(
      rows,
      2,
      "kind is the declared posture's",
      `the run rendered "${kind}"; the dispatch declared "${expectKind}" — the certification posture did not land`,
    );
  } else if (typeof kind === "string" && kind === expectKind) {
    pass(rows, 2, "kind is the declared posture's", `"${kind}"`);
  }

  // The shape inventory for the certified posture: kind, its carrying
  // fields, and the planId/handle/drives context (§7 class 2). Other kinds'
  // inventories are the failure-path leg's to pin — asserted, not assumed.
  if (kind === "published") {
    const handle = /** @type {any} */ (envelope)?.handle;
    const drives = /** @type {any} */ (envelope)?.drives;
    const planId = /** @type {any} */ (envelope)?.planId;
    const tag = /** @type {any} */ (envelope)?.tag;
    if (typeof tag === "string" && tag !== "") {
      pass(rows, 2, "carrying field: tag", `"${tag}"`);
    } else {
      fail(
        rows,
        2,
        "carrying field: tag",
        "a published envelope must name the minted tag as a nonempty string",
      );
    }
    if (typeof planId === "string" && planId.startsWith("plan_sha256:")) {
      pass(rows, 2, "carrying field: planId", "a content-addressed plan id");
    } else {
      fail(rows, 2, "carrying field: planId", "the planId must be a plan_sha256: content address");
    }
    if (
      handle !== null &&
      typeof handle === "object" &&
      handle.planId === planId &&
      typeof handle.attemptId === "string" &&
      handle.attemptId.startsWith("attempt_sha256:") &&
      handle.actor === actor
    ) {
      pass(
        rows,
        2,
        "carrying field: handle",
        `the attempt handle names the declared actor "${actor}" and matches the plan id`,
      );
    } else {
      fail(
        rows,
        2,
        "carrying field: handle",
        `the handle must carry the plan id, an attempt_sha256: attempt id, and the declared actor "${actor}"`,
      );
    }
    if (Array.isArray(drives) && drives.length > 0) {
      pass(rows, 2, "carrying field: drives", `${drives.length} drives`);
    } else {
      fail(rows, 2, "carrying field: drives", "a published envelope must carry the drive sequence");
    }
  } else if (typeof kind === "string") {
    note(
      rows,
      2,
      "carrying fields",
      `the shape inventory is pinned for the certified posture (published) only; a "${kind}" posture's inventory is the failure-path leg's to pin`,
    );
  }

  // — class 4's conclusion half: §3.2's row for the observed kind —
  const kindKnown =
    typeof kind === "string" &&
    (CONCLUSION_BANDS.proceed.includes(kind) || CONCLUSION_BANDS.stop.includes(kind));
  if (conclusion === "") {
    fail(
      rows,
      4,
      "step conclusion is the kind's §3.2 row",
      "RC_CONCLUSION is empty — the invoke step's conclusion never reached this step",
    );
  } else if (kindKnown) {
    const expectedConclusion = CONCLUSION_BANDS.proceed.includes(kind) ? "success" : "failure";
    if (conclusion === expectedConclusion) {
      pass(
        rows,
        4,
        "step conclusion is the kind's §3.2 row",
        `"${kind}" concludes "${expectedConclusion}"; the step concluded "${conclusion}"`,
      );
    } else {
      fail(
        rows,
        4,
        "step conclusion is the kind's §3.2 row",
        `the step concluded "${conclusion}"; the kind's row demands "${expectedConclusion}"`,
      );
    }
  } else {
    fail(
      rows,
      4,
      "step conclusion is the kind's §3.2 row",
      `no run-union kind to judge the row against (the envelope offered ${JSON.stringify(kind) ?? "nothing"})`,
    );
  }

  // — class 1: the exit code, at the point it is machine-assertable —
  if (typeof kind === "string" && EXIT_ZERO_KINDS.has(kind)) {
    if (conclusion === "success") {
      pass(
        rows,
        1,
        "exit code is the kind's §3.2 entry",
        `"${kind}" demands exit 0, and a success conclusion is exactly exit 0 for the invoke shell`,
      );
    } else {
      fail(
        rows,
        1,
        "exit code is the kind's §3.2 entry",
        `"${kind}" demands exit 0; the step's "${conclusion}" conclusion is a nonzero exit`,
      );
    }
  } else if (typeof kind === "string") {
    note(
      rows,
      1,
      "exit code is the kind's §3.2 entry",
      `a "${kind}" run's exact §3.2 exit (the 1 or 10–17 band) lives in the runner's log line, not in any machine-readable output — the failure-path leg's judge to close`,
    );
  }

  // — class 3: the ledger projection, re-read from the substrate —
  const attemptId = /** @type {any} */ (envelope)?.handle?.attemptId;
  const envelopeReady = kind === "published" && typeof attemptId === "string";
  const refs = git(repo, ["for-each-ref", "--format=%(refname)", `${ledgerPrefix}/`]);
  if (!refs.ok) {
    fail(rows, 3, "ledger refs readable", refs.stderr.trim() || "git for-each-ref failed");
  } else if (!envelopeReady) {
    note(
      rows,
      3,
      "ledger projection",
      "no judged attempt handle — the projection class needs the certified posture's envelope",
    );
  } else {
    const refnames = refs.stdout.split("\n").filter((line) => line !== "");
    const attemptRefs = refnames.filter((refname) => ledgerAttemptId(refname) === attemptId);
    if (attemptRefs.length === 0) {
      fail(
        rows,
        3,
        "the attempt's ledger ref exists",
        `no ref under ${ledgerPrefix}/ names the envelope's attempt ${attemptId}`,
      );
    } else if (attemptRefs.length > 1) {
      fail(
        rows,
        3,
        "the attempt's ledger ref exists",
        `${attemptRefs.length} refs name the same attempt — a duplicated ledger is not recorded evidence`,
      );
    } else {
      const attemptRef = /** @type {string} */ (attemptRefs[0]);
      pass(rows, 3, "the attempt's ledger ref exists", attemptRef);
      const foreign = refnames.filter((refname) => ledgerAttemptId(refname) !== attemptId);
      if (foreign.length > 0) {
        fail(
          rows,
          3,
          "no attempt the posture did not declare",
          `the dispatch declares one attempt; the ledger also carries ${foreign.join(", ")}`,
        );
      } else {
        pass(
          rows,
          3,
          "no attempt the posture did not declare",
          "the ledger namespace holds exactly the declared attempt",
        );
      }
      const tail = readTail(repo, attemptRef);
      if (!tail.ok) {
        fail(rows, 3, "tail readable", tail.stderr);
      } else {
        judgeProjection(rows, tail.records, /** @type {any} */ (envelope), actor, attemptId);

        // The walk's product, at the tag boundary: the minted tag the
        // published kind names must exist in the judged repository. (That it
        // points at the certified commit is the evidence step's `git
        // for-each-ref` dump — a log-read row, not this one.)
        const tag = /** @type {any} */ (envelope)?.tag;
        const tags = git(repo, ["tag", "--list"]);
        if (
          tags.ok &&
          typeof tag === "string" &&
          tag !== "" &&
          tags.stdout.split("\n").includes(tag)
        ) {
          pass(rows, 3, "the minted tag exists", tag);
        } else {
          fail(
            rows,
            3,
            "the minted tag exists",
            `the envelope names "${String(tag)}" and the tag namespace does not carry it`,
          );
        }
      }
    }
  }

  // — class 4's first half, named where it stays —
  note(
    rows,
    4,
    "survivor equals the step's verbatim stdout",
    "byte-for-byte equality with the invoke step's log relay needs the step log, which a running job cannot read through the API — the one log-read row left on the happy path (the failure-path leg's log-reading judge closes it)",
  );

  const failed = rows.filter((row) => row.state === "FAIL").length;
  return { rows, certified: failed === 0 };
}

/**
 * Class 3's projection: the promote walk's recorded shape, oldest first —
 * the plan record, then started→completed pairs for the nine cells in walk
 * order — cross-checked against the envelope's drives.
 *
 * @param {Row[]} rows
 * @param {object[]} records chronological tail
 * @param {any} envelope the parsed envelope
 * @param {string} actor the declared actor
 * @param {string} attemptId the envelope's attempt id
 * @returns {void}
 */
function judgeProjection(rows, records, envelope, actor, attemptId) {
  const identityOk = records.every((entry) => {
    const record =
      /** @type {any} */ (entry).kind === "step" ? /** @type {any} */ (entry).record : entry;
    return (
      record?.attemptId === attemptId &&
      record?.attribution?.actor === actor &&
      record?.attribution?.attemptId === attemptId
    );
  });
  if (identityOk) {
    pass(
      rows,
      3,
      "every record carries the declared identity",
      `attempt ${attemptId}, actor "${actor}"`,
    );
  } else {
    fail(
      rows,
      3,
      "every record carries the declared identity",
      "a record names a foreign attempt or actor — recorded evidence from a run this dispatch did not declare",
    );
  }

  const expected = 1 + PROMOTE_CELLS.length * 2;
  if (records.length !== expected) {
    fail(
      rows,
      3,
      "tail length is the walk's",
      `${records.length} records; the promote walk projects ${expected} (the plan record + started/completed for ${PROMOTE_CELLS.length} cells)`,
    );
    return;
  }
  pass(rows, 3, "tail length is the walk's", `${records.length} records`);

  const plan = /** @type {any} */ (records[0]);
  if (
    plan?.kind === "plan" &&
    typeof plan.planFingerprint === "string" &&
    plan.planFingerprint !== ""
  ) {
    pass(
      rows,
      3,
      "the walk opens with the plan record",
      String(plan.planFingerprint).slice(0, 24) + "…",
    );
  } else {
    fail(
      rows,
      3,
      "the walk opens with the plan record",
      "the oldest record is not a plan record carrying a planFingerprint",
    );
  }

  /** @type {Map<string, any>} */
  const completed = new Map();
  let shapeHeld = true;
  for (let index = 0; index < PROMOTE_CELLS.length; index += 1) {
    const cell = /** @type {string} */ (PROMOTE_CELLS[index]);
    const started = /** @type {any} */ (records[1 + index * 2]);
    const done = /** @type {any} */ (records[2 + index * 2]);
    if (
      started?.kind !== "step" ||
      started.record?.stepKey !== cell ||
      started.record?.from !== "pending" ||
      started.record?.to !== "started" ||
      started.record?.guards?.length !== 0
    ) {
      fail(
        rows,
        3,
        "started record for " + cell,
        "expected a step record pending→started with no guards",
      );
      shapeHeld = false;
      continue;
    }
    const expectedGuards = PROMOTE_COMPLETED_GUARDS[cell] ?? [];
    const guards = done?.record?.guards;
    const guardNames = Array.isArray(guards)
      ? guards.map((guard) => /** @type {any} */ (guard).guard)
      : [];
    const guardsMatchShape =
      Array.isArray(guards) &&
      guards.every((guard) => /** @type {any} */ (guard).passed === true) &&
      guardNames.length === expectedGuards.length &&
      guardNames.every((name, guardIndex) => {
        // the lengths were checked equal, so the index is in range
        const wanted = /** @type {string} */ (expectedGuards[guardIndex]);
        return wanted.endsWith(":") ? String(name).startsWith(wanted) : name === wanted;
      });
    const claimHeld =
      CLAIMED_CELLS.has(cell) ===
      (typeof done?.record?.claim === "string" && done.record.claim !== "");
    if (
      done?.kind !== "step" ||
      done.record?.stepKey !== cell ||
      done.record?.from !== "started" ||
      done.record?.to !== "completed" ||
      typeof done.record?.contentFingerprint !== "string" ||
      !guardsMatchShape ||
      !claimHeld
    ) {
      fail(
        rows,
        3,
        "completed record for " + cell,
        "expected a step record started→completed with the cell's guard chain" +
          (CLAIMED_CELLS.has(cell) ? " and its claim token" : ""),
      );
      shapeHeld = false;
      continue;
    }
    completed.set(cell, done.record);
  }
  if (shapeHeld) {
    pass(
      rows,
      3,
      "the nine cells project started→completed in walk order",
      "every guard passed; the claim chain rides the claimed cells; validate under the tag-absent precondition; verify under the tag boundary",
    );
  }

  const drives = envelope?.drives;
  const drivesShape =
    Array.isArray(drives) &&
    drives.length === PROMOTE_CELLS.length &&
    drives.every(
      (drive, index) =>
        /** @type {any} */ (drive)?.stepKey === PROMOTE_CELLS[index] &&
        /** @type {any} */ (drive)?.outcome?.kind === "advance",
    );
  if (!drivesShape) {
    fail(
      rows,
      3,
      "the envelope drives the walk",
      "the drives sequence must carry one advance per cell, in walk order",
    );
    return;
  }
  pass(rows, 3, "the envelope drives the walk", `${PROMOTE_CELLS.length} advances in walk order`);

  const mismatched = drives.filter((drive) => {
    const recorded = completed.get(/** @type {any} */ (drive)?.stepKey);
    return (
      recorded === undefined || !deepEqual(/** @type {any} */ (drive)?.outcome?.record, recorded)
    );
  });
  if (mismatched.length === 0) {
    pass(
      rows,
      3,
      "every drive's claim is the recorded record",
      "each envelope drive deep-equals the tail's completed record for its cell — the process's claims are the recorded evidence",
    );
  } else {
    fail(
      rows,
      3,
      "every drive's claim is the recorded record",
      `${mismatched.length} drive(s) do not deep-equal the recorded record for their cell (${mismatched.map((drive) => /** @type {any} */ (drive)?.stepKey).join(", ")}) — the envelope claims what the tail does not carry`,
    );
  }
}

/**
 * @param {Row[]} rows
 * @param {boolean} certified
 * @returns {string}
 */
function render(rows, certified) {
  const lines = [
    "dogfood judge — the four classes over the mechanically available material (phase 14 §7, #187)",
    "",
  ];
  for (const row of rows) {
    const mark = row.state === "PASS" ? "PASS" : row.state;
    lines.push(`- class ${row.class} · ${row.name}: **${mark}** — ${row.detail}`);
  }
  lines.push("");
  lines.push(
    certified
      ? "verdict: CERTIFIED — the declared posture's mechanically available classes hold; the NOT ASSERTED rows above stay human log reads"
      : "verdict: NOT CERTIFIED — one mismatch is a filed defect against the owning slice, never a waived row (phase 14 §7)",
  );
  return lines.join("\n");
}

// The executable guard: run directly, the judge judges and exits; imported
// by the suite that proves it bites, the module exports its pieces and runs
// nothing — a main() at import time would exit the test worker before any
// assertion ran.
const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  /** @type {Map<string, string>} */
  let options;
  try {
    options = parseProtocol(process.argv.slice(2));
  } catch (error) {
    console.error(`dogfood judge: ${String(error instanceof Error ? error.message : error)}`);
    console.error(
      "usage: node scripts/dogfood/judge.mjs --repo <path> --actor <actor> --expect-kind <kind> [--ledger-prefix <prefix>]",
    );
    console.error(
      "evidence enters through the environment: RC_OUTCOME (the outcome output), RC_CONCLUSION (the invoke step's conclusion)",
    );
    process.exit(EXIT_USAGE);
  }
  const { rows, certified } = judge(options);
  console.log(render(rows, certified));
  process.exit(certified ? 0 : 1);
}
