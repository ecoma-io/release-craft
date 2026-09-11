// Tests for the dogfood judge: the certification's judgement step must BITE —
// §7's gate wording is the whole wording, so the suite plants a synthetic bad
// capture for every class the judge claims to assert and shows the judge
// refuses it, runs one good capture through clean, and cross-pins the judge's
// contract copies (the §3.2 bands, the exit-0 point, the promote walk's cell
// order) against the sources they copy — action/invoke.mjs's table and the
// fixture's own git-01 expected stdout. The ledger is real: every capture is
// judged against a temporary git repository whose ledger ref carries the
// records as one `record` blob per commit, the substrate shape the workflow's
// evidence step dumps and the judge re-reads.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { CONCLUSION_BANDS, EXIT_ZERO_KINDS, PROMOTE_CELLS } from "./judge.mjs";

const JUDGE = fileURLToPath(new URL("./judge.mjs", import.meta.url));

/**
 * A deterministic 64-hex content address — the ids' shape, never their bytes.
 *
 * @param {string} seed
 * @returns {string}
 */
function hex(seed) {
  let out = "";
  for (let index = 0; index < 64; index += 1) {
    out += ((seed.charCodeAt(index % seed.length) + index) % 16).toString(16);
  }
  return out;
}

const ACTOR = "judge-fixture";
const TAG = "9.9.9";
const PLAN_ID = `plan_sha256:${hex("plan")}`;
const ATTEMPT_ID = `attempt_sha256:${hex("attempt")}`;
const CLAIM = hex("claim");

/**
 * The promote walk's guard choreography, as the judge pins it (the same
 * sequence run 34470662759's certified tail carried).
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const GUARDS = {
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
 * Builds one honest capture: the 19-record tail (chronological) and the
 * published envelope whose drives deep-equal the tail's completed records.
 * The guards carry detail strings on purpose — the judge is class-shaped, not
 * byte-shaped, and detail bytes must never judge a run.
 *
 * @param {string} detailSeed the guards' detail bytes — varying them must never move a verdict
 * @returns {{ tail: object[], envelope: object }}
 */
function honestCapture(detailSeed = "detail bytes the judge must stay blind to") {
  /** @type {object[]} */
  const tail = [];
  const attribution = { actor: ACTOR, attemptId: ATTEMPT_ID };
  /** @type {object[]} */
  const completed = [];
  tail.push({ kind: "plan", attemptId: ATTEMPT_ID, attribution, planFingerprint: PLAN_ID });
  for (const cell of PROMOTE_CELLS) {
    tail.push({
      kind: "step",
      record: {
        attemptId: ATTEMPT_ID,
        attribution,
        contentFingerprint: `content:${cell}:${ATTEMPT_ID}`,
        from: "pending",
        guards: [],
        stepKey: cell,
        to: "started",
      },
    });
    const claimed = cell !== "plan" && cell !== "validate" && cell !== "verify";
    const record = {
      attemptId: ATTEMPT_ID,
      attribution,
      contentFingerprint: `content:${cell}:${ATTEMPT_ID}`,
      from: "started",
      guards: (GUARDS[cell] ?? []).map((guard) => ({
        guard: guard.endsWith(":")
          ? `${guard}${JSON.stringify({ kind: "tag-absent", tag: TAG })}`
          : guard,
        passed: true,
        detail: `${detailSeed} (${cell})`,
      })),
      stepKey: cell,
      to: "completed",
      ...(claimed ? { claim: CLAIM } : {}),
    };
    tail.push({ kind: "step", record });
    completed.push(record);
  }
  const envelope = {
    kind: "published",
    tag: TAG,
    planId: PLAN_ID,
    handle: { planId: PLAN_ID, attemptId: ATTEMPT_ID, actor: ACTOR },
    drives: PROMOTE_CELLS.map((cell) => ({
      stepKey: cell,
      outcome: { kind: "advance", record: completed[PROMOTE_CELLS.indexOf(cell)] },
    })),
  };
  return { tail, envelope };
}

/**
 * Commits the tail into a real temporary repository — one `record` blob per
 * commit under the ledger ref the binding writes (colons percent-encoded) —
 * and mints the envelope's tag.
 *
 * @param {object[]} tail chronological records
 * @param {{ mintTag?: boolean, extraAttempt?: boolean }} options
 * @returns {string} the repository path
 */
function buildLedgerRepo(tail, { mintTag = true, extraAttempt = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "rc-judge-"));
  /** @param {string[]} args */
  const git = (args) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        "-c",
        "tag.forceSignAnnotated=false",
        "-c",
        "user.name=judge-test",
        "-c",
        "user.email=judge@test",
        ...args,
      ],
      {
        cwd: repo,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, `fixture git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout;
  };
  git(["init", "-q"]);
  for (const entry of tail) {
    writeFileSync(join(repo, "record"), JSON.stringify(entry));
    git(["add", "record"]);
    git(["commit", "-q", "-m", "record"]);
  }
  const attemptSegment = encodeURIComponent(ATTEMPT_ID);
  git(["update-ref", `refs/release-craft/ledger/${attemptSegment}`, "HEAD"]);
  if (extraAttempt) {
    const foreign = `refs/release-craft/ledger/${encodeURIComponent(`attempt_sha256:${hex("foreign")}`)}`;
    git(["update-ref", foreign, "HEAD"]);
  }
  if (mintTag) {
    git(["tag", TAG]);
  }
  return repo;
}

/**
 * Drives the judge as a subprocess over a capture, the way the workflow's
 * step does — the evidence through the environment, the posture through
 * argv — with the ambient environment held out.
 *
 * @param {string} repo
 * @param {string} survivorBytes the RC_OUTCOME bytes ("" reads as missing)
 * @param {string} conclusion
 * @param {{ actor?: string, expectKind?: string }} options
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function runJudge(
  repo,
  survivorBytes,
  conclusion,
  { actor = ACTOR, expectKind = "published" } = {},
) {
  return spawnSync(
    process.execPath,
    [JUDGE, "--repo", repo, "--actor", actor, "--expect-kind", expectKind],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        RC_OUTCOME: survivorBytes,
        RC_CONCLUSION: conclusion,
      },
    },
  );
}

/** @param {string} stdout @param {string} name @returns {string} the row's rendered state */
function rowState(stdout, name) {
  const line = stdout.split("\n").find((candidate) => candidate.includes(`· ${name}:`));
  assert.notEqual(line, undefined, `no row named "${name}" in the judge's output:\n${stdout}`);
  const row = /** @type {string} */ (line);
  return row.includes("**PASS**") ? "PASS" : row.includes("**FAIL**") ? "FAIL" : "NOT ASSERTED";
}

/** @param {object} envelope @returns {string} the survivor's exact bytes */
const survivorOf = (envelope) => `${JSON.stringify(envelope)}\n`;

describe("the honest capture", () => {
  const { tail, envelope } = honestCapture();
  const repo = buildLedgerRepo(tail);
  const survivor = survivorOf(envelope);

  after(() => rmSync(repo, { recursive: true, force: true }));

  it("passes every row the judge asserts — the certified posture lands", () => {
    const run = runJudge(repo, survivor, "success");
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /verdict: CERTIFIED/);
    assert.equal(rowState(run.stdout, "kind is the declared posture's"), "PASS");
    assert.equal(rowState(run.stdout, "step conclusion is the kind's §3.2 row"), "PASS");
    assert.equal(rowState(run.stdout, "exit code is the kind's §3.2 entry"), "PASS");
    assert.equal(rowState(run.stdout, "every drive's claim is the recorded record"), "PASS");
    assert.equal(rowState(run.stdout, "the minted tag exists"), "PASS");
  });

  it("names the boundary on every run: the log-read rows report NOT ASSERTED", () => {
    const run = runJudge(repo, survivor, "success");
    assert.equal(run.status, 0);
    assert.equal(
      rowState(run.stdout, "survivor equals the step's verbatim stdout"),
      "NOT ASSERTED",
    );
  });

  it("stays blind to guard detail bytes — class-shaped, not byte-shaped", () => {
    const regenerated = honestCapture("regenerated detail bytes, a second run's own");
    const other = buildLedgerRepo(regenerated.tail);
    try {
      const run = runJudge(other, survivorOf(regenerated.envelope), "success");
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /verdict: CERTIFIED/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("the judge bites — the planted bad captures", () => {
  const { tail, envelope } = honestCapture();
  const survivor = survivorOf(envelope);

  it("refuses a stop-band kind under a success conclusion — the wrong-class plant", () => {
    const refused = { kind: "refused", detail: "the grammar refused the world" };
    const repo = buildLedgerRepo(tail);
    try {
      const run = runJudge(repo, survivorOf(refused), "success");
      assert.equal(run.status, 1);
      assert.match(run.stdout, /verdict: NOT CERTIFIED/);
      assert.equal(rowState(run.stdout, "kind is the declared posture's"), "FAIL");
      assert.equal(rowState(run.stdout, "step conclusion is the kind's §3.2 row"), "FAIL");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a published envelope under a failure conclusion — the wrong-conclusion plant", () => {
    const repo = buildLedgerRepo(tail);
    try {
      const run = runJudge(repo, survivor, "failure");
      assert.equal(run.status, 1);
      assert.equal(rowState(run.stdout, "step conclusion is the kind's §3.2 row"), "FAIL");
      assert.equal(rowState(run.stdout, "exit code is the kind's §3.2 entry"), "FAIL");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a survivor that is not JSON", () => {
    const repo = buildLedgerRepo(tail);
    try {
      const run = runJudge(repo, "outcome=<<ghadelimiter_broken\n", "success");
      assert.equal(run.status, 1);
      assert.equal(rowState(run.stdout, "envelope parses"), "FAIL");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a survivor that lost its trailing newline — the preserving write's own signature", () => {
    const repo = buildLedgerRepo(tail);
    try {
      const run = runJudge(repo, JSON.stringify(envelope), "success");
      assert.equal(run.status, 1);
      assert.equal(rowState(run.stdout, "survivor's trailing newline survived"), "FAIL");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses an empty survivor — nothing to judge is not a pass", () => {
    const repo = buildLedgerRepo(tail);
    try {
      const run = runJudge(repo, "", "success");
      assert.equal(run.status, 1);
      assert.equal(rowState(run.stdout, "survivor present"), "FAIL");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses an envelope whose drive claims a record the tail does not carry", () => {
    const mutated = /** @type {any} */ (structuredClone(envelope));
    mutated.drives[4].outcome.record.contentFingerprint = `content:commit:${hex("forged")}`;
    const repo = buildLedgerRepo(tail);
    try {
      const run = runJudge(repo, survivorOf(mutated), "success");
      assert.equal(run.status, 1);
      assert.equal(rowState(run.stdout, "every drive's claim is the recorded record"), "FAIL");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a tail missing a walk cell", () => {
    const short = tail.filter(
      (entry) =>
        /** @type {any} */ (entry).record?.stepKey !== "verify" ||
        /** @type {any} */ (entry).record.from !== "started",
    );
    const repo = buildLedgerRepo(short);
    try {
      const run = runJudge(repo, survivor, "success");
      assert.equal(run.status, 1);
      assert.equal(rowState(run.stdout, "tail length is the walk's"), "FAIL");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a tail carrying a record the walk did not project", () => {
    const extra = structuredClone(tail);
    extra.push(structuredClone(/** @type {object} */ (extra[1])));
    const repo = buildLedgerRepo(extra);
    try {
      const run = runJudge(repo, survivor, "success");
      assert.equal(run.status, 1);
      assert.equal(rowState(run.stdout, "tail length is the walk's"), "FAIL");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a failed guard riding a completed record", () => {
    const wounded = structuredClone(tail);
    const tagCompleted = wounded.find(
      (entry) =>
        /** @type {any} */ (entry).record?.stepKey === "tag" &&
        /** @type {any} */ (entry).record.from === "started",
    );
    /** @type {any} */ (tagCompleted).record.guards[0].passed = false;
    const repo = buildLedgerRepo(wounded);
    try {
      const run = runJudge(repo, survivor, "success");
      assert.equal(run.status, 1);
      assert.equal(rowState(run.stdout, "completed record for tag"), "FAIL");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a claimed cell whose record lost the claim token", () => {
    const robbed = structuredClone(tail);
    const publishCompleted = robbed.find(
      (entry) =>
        /** @type {any} */ (entry).record?.stepKey === "publish" &&
        /** @type {any} */ (entry).record.from === "started",
    );
    delete (/** @type {any} */ (publishCompleted).record.claim);
    const repo = buildLedgerRepo(robbed);
    try {
      const run = runJudge(repo, survivor, "success");
      assert.equal(run.status, 1);
      assert.equal(rowState(run.stdout, "completed record for publish"), "FAIL");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses recorded evidence from a foreign attempt", () => {
    const foreign = structuredClone(tail);
    for (const entry of foreign) {
      const record = /** @type {any} */ (entry).record;
      if (record !== undefined) {
        record.attemptId = `attempt_sha256:${hex("other")}`;
      }
    }
    const repo = buildLedgerRepo(foreign);
    try {
      const run = runJudge(repo, survivor, "success");
      assert.equal(run.status, 1);
      assert.equal(rowState(run.stdout, "every record carries the declared identity"), "FAIL");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a posture whose minted tag never landed", () => {
    const repo = buildLedgerRepo(tail, { mintTag: false });
    try {
      const run = runJudge(repo, survivor, "success");
      assert.equal(run.status, 1);
      assert.equal(rowState(run.stdout, "the minted tag exists"), "FAIL");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a ledger namespace carrying an attempt the dispatch did not declare", () => {
    const repo = buildLedgerRepo(tail, { extraAttempt: true });
    try {
      const run = runJudge(repo, survivor, "success");
      assert.equal(run.status, 1);
      assert.equal(rowState(run.stdout, "no attempt the posture did not declare"), "FAIL");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a kind outside the run union — the no-verdict drift", () => {
    const drifted = { kind: "resolved-now", planId: PLAN_ID };
    const repo = buildLedgerRepo(tail);
    try {
      const run = runJudge(repo, survivorOf(drifted), "success");
      assert.equal(run.status, 1);
      assert.equal(rowState(run.stdout, "kind in the run union"), "FAIL");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("the honest boundary", () => {
  it("a usage fault exits 64 and invents no evidence", () => {
    const run = spawnSync(process.execPath, [JUDGE, "--repo", ".", "--expect-kind", "published"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    assert.equal(run.status, 64);
    assert.match(run.stderr, /missing --actor/);
  });

  it("a non-published posture degrades to named NOT ASSERTED rows, never to invented passes", () => {
    const { tail } = honestCapture();
    const repo = buildLedgerRepo(tail);
    try {
      const resolved = {
        kind: "resolved",
        planId: PLAN_ID,
        handle: { planId: PLAN_ID, attemptId: ATTEMPT_ID, actor: ACTOR },
      };
      const run = runJudge(repo, survivorOf(resolved), "success", { expectKind: "resolved" });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal(rowState(run.stdout, "carrying fields"), "NOT ASSERTED");
      assert.equal(rowState(run.stdout, "exit code is the kind's §3.2 entry"), "NOT ASSERTED");
      assert.equal(rowState(run.stdout, "ledger projection"), "NOT ASSERTED");
      assert.match(run.stdout, /verdict: CERTIFIED/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("the judge's contract copies are cross-pinned", () => {
  const invokeSource = fileURLToPath(new URL("../../action/invoke.mjs", import.meta.url));
  const table = readFileSync(invokeSource, "utf8");
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../test/certification/expected/git-01.json", import.meta.url)),
      "utf8",
    ),
  );

  it("the conclusion bands equal action/invoke.mjs's CONCLUSION_TABLE column", () => {
    for (const kind of [...CONCLUSION_BANDS.proceed, ...CONCLUSION_BANDS.stop]) {
      const row = new RegExp(
        `^  "?${kind}"?: \\{ exit: (\\d+), conclusion: "(success|failure)"`,
        "m",
      ).exec(table);
      assert.notEqual(row, null, `${kind} is not a row of invoke.mjs's table`);
      assert.equal(
        /** @type {RegExpExecArray} */ (row)[2],
        CONCLUSION_BANDS.proceed.includes(kind) ? "success" : "failure",
        `${kind}'s band disagrees with the table`,
      );
    }
  });

  it("the exit-0 point is published, and only published, per the table", () => {
    const row = /^ {2}published: \{ exit: (\d+)/m.exec(table);
    assert.notEqual(row, null);
    assert.equal(/** @type {RegExpExecArray} */ (row)[1], "0");
    assert.deepEqual([...EXIT_ZERO_KINDS], ["published"]);
  });

  it("the promote walk's cell order is the fixture's git-01 drive order", () => {
    const stdout = /** @type {any} */ (JSON.parse(fixture.scenarios[0].stdout));
    assert.deepEqual(
      PROMOTE_CELLS,
      stdout.drives.map(/** @param {any} drive */ (drive) => drive.stepKey),
    );
  });
});
