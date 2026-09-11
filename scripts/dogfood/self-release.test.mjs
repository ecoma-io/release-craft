// Tests for the self-release's two caller-side scripts (#259):
// `publish-mint.mjs` (the workflow's transport for the run's local mint)
// and `verify-origin.mjs` (the origin leg that reads origin back against
// the run's claims). Each drives its script as a subprocess over a real
// temporary repository whose "origin" is a local bare clone — the push is
// real, the transport is a filesystem path, so the inline credential
// helper is never queried (the helper's mechanism class is the github
// adapter's own, pinned there; what is pinned HERE is the ref selection,
// the push's all-or-nothing no-force posture, and every row's bite).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const PUBLISH = new URL("./publish-mint.mjs", import.meta.url).pathname;
const VERIFY = new URL("./verify-origin.mjs", import.meta.url).pathname;

const ENVELOPE_PUBLISHED = JSON.stringify({
  kind: "published",
  tag: "0.1.0",
  planId: "plan_sha256:" + "a".repeat(64),
  handle: {
    planId: "plan_sha256:" + "a".repeat(64),
    attemptId: "attempt_sha256:" + "b".repeat(64),
    actor: "suite",
  },
});

const ENVELOPE_DENIED = JSON.stringify({
  kind: "denied",
  holder: "attempt_sha256:" + "b".repeat(64),
  planId: "plan_sha256:" + "a".repeat(64),
});

/**
 * A temporary repository with a bare "origin" beside it and one commit on
 * main — the dispatch's checkout shape at the smallest it can be.
 *
 * @returns {{ repo: string, origin: string, git: (args: string[]) => string }}
 */
function buildCheckout() {
  const root = mkdtempSync(join(tmpdir(), "rc-self-release-"));
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  mkdirSync(repo, { recursive: true }); // spawnSync's cwd must exist
  /**
   * @param {string[]} args
   * @returns {string}
   */
  const git = (args) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        "-c",
        "user.name=suite",
        "-c",
        "user.email=suite@test",
        ...args,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        // The ambient environment is held out the way every git fixture in
        // this repository holds it out: an exported GIT_DIR (a hook's
        // environment) would redirect the fixture's own writes.
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      },
    );
    assert.equal(result.status, 0, `fixture git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout;
  };
  git(["init", "-q", "--initial-branch=main", "."]);
  writeFileSync(join(repo, "package.json"), '{"version":"0.1.0"}\n');
  git(["add", "package.json"]);
  git(["commit", "-q", "-m", "feat: seed"]);
  git(["clone", "-q", "--bare", ".", origin]);
  git(["remote", "add", "origin", origin]);
  return { repo, origin, git };
}

/**
 * Simulates the run's local mint: the lightweight tag and the recorded
 * namespaces the walk appends — all pointing at the seeded head.
 *
 * @param {(args: string[]) => string} git
 * @param {{ tag?: string, extraClaim?: string }} options
 */
function mintLocally(git, { tag = "0.1.0", extraClaim = "" } = {}) {
  git(["tag", tag]);
  git(["update-ref", `refs/release-craft/ledger/${"b".repeat(64)}`, "HEAD"]);
  git(["update-ref", `refs/release-craft/claims/scope`, "HEAD"]);
  git(["update-ref", `refs/release-craft/register/plan`, "HEAD"]);
  if (extraClaim !== "") {
    git(["update-ref", `refs/release-craft/claims/${extraClaim}`, "HEAD"]);
  }
}

/**
 * @param {(args: string[]) => string} git
 * @returns {string} `git ls-remote origin` over the fixture's bare remote
 */
const remoteRefs = (git) => git(["ls-remote", "origin"]);

/**
 * The fixture's own origin URL — what `--expect-origin` receives unless a
 * test is deliberately breaking the origin-agreement row.
 *
 * @param {(args: string[]) => string} git
 * @returns {string}
 */
const originUrl = (git) => git(["remote", "get-url", "origin"]).trim();

/**
 * Drives one script as a subprocess, the way the workflow's steps do —
 * evidence through the environment, posture through argv, the ambient
 * environment held out (the scripts never read it).
 *
 * @param {string} script the script's path
 * @param {string[]} args the script's argv
 * @param {string} repo the checkout to stand in
 * @param {{ outcome?: string, rcToken?: string }} evidence
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function runScript(script, args, repo, { outcome, rcToken } = {}) {
  /** @type {Record<string, string | undefined>} */
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  if (outcome !== undefined) {
    env.RC_OUTCOME = outcome;
  }
  if (rcToken !== undefined) {
    env.RC_TOKEN = rcToken;
  }
  return spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: "utf8", env });
}

describe("publish-mint", () => {
  it("pushes exactly the minted pairs, atomically, for a published verdict", () => {
    const { repo, git } = buildCheckout();
    try {
      const before = git(["for-each-ref", "--format=%(refname) %(objectname)"]);
      writeFileSync(join(repo, "local-refs-before.txt"), before);
      mintLocally(git);
      const run = runScript(PUBLISH, ["--local-before", "local-refs-before.txt"], repo, {
        outcome: ENVELOPE_PUBLISHED,
      });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const refs = remoteRefs(git);
      assert.match(refs, /refs\/tags\/0\.1\.0/);
      assert.match(refs, /refs\/release-craft\/ledger\//);
      assert.match(refs, /refs\/release-craft\/claims\//);
      assert.match(refs, /refs\/release-craft\/register\//);
      // the pairs are exact: the origin object is the minted one
      const localTag = git(["rev-parse", "refs/tags/0.1.0"]).trim();
      assert.match(refs, new RegExp(`${localTag}\\s+refs/tags/0\\.1\\.0`));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("pushes nothing for a stop-band verdict — origin stays untouched", () => {
    const { repo, git } = buildCheckout();
    try {
      writeFileSync(
        join(repo, "local-refs-before.txt"),
        git(["for-each-ref", "--format=%(refname) %(objectname)"]),
      );
      const remoteBefore = remoteRefs(git);
      // the replay's local evidence: a claim ref the failed attempt minted
      git(["update-ref", "refs/release-craft/claims/replay", "HEAD"]);
      const run = runScript(PUBLISH, ["--local-before", "local-refs-before.txt"], repo, {
        outcome: ENVELOPE_DENIED,
      });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /no release minted, origin untouched/);
      assert.equal(remoteRefs(git), remoteBefore);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a published verdict whose mint is empty", () => {
    const { repo, git } = buildCheckout();
    try {
      writeFileSync(
        join(repo, "local-refs-before.txt"),
        git(["for-each-ref", "--format=%(refname) %(objectname)"]),
      );
      const run = runScript(PUBLISH, ["--local-before", "local-refs-before.txt"], repo, {
        outcome: ENVELOPE_PUBLISHED,
      });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /minted no ref/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a published verdict whose named tag is not in the mint", () => {
    const { repo, git } = buildCheckout();
    try {
      writeFileSync(
        join(repo, "local-refs-before.txt"),
        git(["for-each-ref", "--format=%(refname) %(objectname)"]),
      );
      const remoteBefore = remoteRefs(git);
      git(["tag", "9.9.9"]); // the mint carries a tag the envelope does not name
      const run = runScript(PUBLISH, ["--local-before", "local-refs-before.txt"], repo, {
        outcome: ENVELOPE_PUBLISHED,
      });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /partial mint/);
      assert.equal(remoteRefs(git), remoteBefore);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("never forces a push: a ref origin already holds is a loud rejection, not an overwrite", () => {
    const { repo, git } = buildCheckout();
    try {
      // origin already carries the tag at the seeded head; the run minted
      // it at a different object — a plain push refuses, and --atomic keeps
      // the rest of the mint from riding in half-pushed
      git(["push", "-q", "origin", "HEAD:refs/tags/0.1.0"]);
      git(["checkout", "-q", "-b", "side"]);
      git(["commit", "-q", "--allow-empty", "-m", "feat: the object the moved mint names"]);
      const movedObject = git(["rev-parse", "HEAD"]).trim();
      git(["checkout", "-q", "main"]);
      git(["branch", "-q", "-D", "side"]);
      writeFileSync(
        join(repo, "local-refs-before.txt"),
        git(["for-each-ref", "--format=%(refname) %(objectname)"]),
      );
      mintLocally(git);
      git(["update-ref", "refs/tags/0.1.0", movedObject]);
      const run = runScript(PUBLISH, ["--local-before", "local-refs-before.txt"], repo, {
        outcome: ENVELOPE_PUBLISHED,
      });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /rejected|clobber|failed to push/i);
      // and nothing rode in half-pushed: the recorded namespaces are absent
      assert.doesNotMatch(remoteRefs(git), /refs\/release-craft\//);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses an empty envelope loudly — nothing claimed is not a publish", () => {
    const { repo, git } = buildCheckout();
    try {
      writeFileSync(
        join(repo, "local-refs-before.txt"),
        git(["for-each-ref", "--format=%(refname) %(objectname)"]),
      );
      const run = runScript(PUBLISH, ["--local-before", "local-refs-before.txt"], repo, {});
      assert.equal(run.status, 1);
      assert.match(run.stderr, /RC_OUTCOME is empty/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a survivor that is not JSON", () => {
    const { repo, git } = buildCheckout();
    try {
      writeFileSync(
        join(repo, "local-refs-before.txt"),
        git(["for-each-ref", "--format=%(refname) %(objectname)"]),
      );
      const run = runScript(PUBLISH, ["--local-before", "local-refs-before.txt"], repo, {
        outcome: "outcome=<<ghadelimiter_broken\n",
      });
      assert.equal(run.status, 1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("a protocol violation is a usage fault — exit 64", () => {
    const { repo } = buildCheckout();
    try {
      const run = runScript(PUBLISH, [], repo, { outcome: ENVELOPE_PUBLISHED });
      assert.equal(run.status, 64);
      assert.match(run.stderr, /missing --local-before/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("verify-origin", () => {
  /** Writes the three snapshot files a verify run reads, from live state.
   *
   * @param {(args: string[]) => string} git
   * @param {string} repo
   * @returns {string[]} the argv suffix naming them
   */
  function writeSnapshots(git, repo) {
    writeFileSync(join(repo, "remote-before.txt"), remoteRefs(git));
    writeFileSync(join(repo, "remote-after.txt"), remoteRefs(git));
    writeFileSync(
      join(repo, "local-refs-before.txt"),
      git(["for-each-ref", "--format=%(refname) %(objectname)"]),
    );
    return [
      "--before",
      "remote-before.txt",
      "--after",
      "remote-after.txt",
      "--local-before",
      "local-refs-before.txt",
    ];
  }

  it("holds for a published verdict whose whole mint is on origin", () => {
    const { repo, git } = buildCheckout();
    try {
      const snapshots = writeSnapshots(git, repo);
      mintLocally(git);
      const pushed = runScript(PUBLISH, ["--local-before", "local-refs-before.txt"], repo, {
        outcome: ENVELOPE_PUBLISHED,
      });
      assert.equal(pushed.status, 0, pushed.stdout + pushed.stderr);
      writeFileSync(join(repo, "remote-after.txt"), remoteRefs(git));
      const run = runScript(
        VERIFY,
        [...snapshots, "--expect-kind", "published", "--expect-origin", originUrl(git)],
        repo,
        { outcome: ENVELOPE_PUBLISHED },
      );
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /verdict: HOLD/);
      for (const row of [
        "every minted ref reached origin",
        "the envelope's tag is on origin",
        "the mint is nonempty",
        "origin is the dispatching repository",
      ]) {
        assert.match(run.stdout, new RegExp(`${row}: \\*\\*PASS\\*\\*`));
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("breaks when a minted ref never reached origin — the green-but-unminted class", () => {
    const { repo, git } = buildCheckout();
    try {
      const snapshots = writeSnapshots(git, repo);
      mintLocally(git);
      // the publish step never ran: origin stays empty while the mint is local
      const run = runScript(
        VERIFY,
        [...snapshots, "--expect-kind", "published", "--expect-origin", originUrl(git)],
        repo,
        { outcome: ENVELOPE_PUBLISHED },
      );
      assert.equal(run.status, 1);
      assert.match(run.stdout, /verdict: BROKEN/);
      assert.match(run.stdout, /every minted ref reached origin: \*\*FAIL\*\*/);
      assert.match(run.stdout, /the envelope's tag is on origin: \*\*FAIL\*\*/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("breaks when origin carries the tag at a different object", () => {
    const { repo, git } = buildCheckout();
    try {
      const snapshots = writeSnapshots(git, repo);
      mintLocally(git);
      // push a DIFFERENT object under the tag's name — a namespace
      // mismatch or a moved ref must not read as the mint
      git(["checkout", "-q", "-b", "side"]);
      git(["commit", "-q", "--allow-empty", "-m", "feat: not the minted object"]);
      const other = git(["rev-parse", "HEAD"]).trim();
      git(["checkout", "-q", "main"]);
      git(["branch", "-q", "-D", "side"]);
      git(["push", "-q", "origin", `${other}:refs/tags/0.1.0`]);
      const run = runScript(
        VERIFY,
        [...snapshots, "--expect-kind", "published", "--expect-origin", originUrl(git)],
        repo,
        { outcome: ENVELOPE_PUBLISHED },
      );
      assert.equal(run.status, 1);
      assert.match(run.stdout, /every minted ref reached origin: \*\*FAIL\*\*/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("holds for a stop-band verdict over an unchanged origin", () => {
    const { repo, git } = buildCheckout();
    try {
      const snapshots = writeSnapshots(git, repo);
      git(["update-ref", "refs/release-craft/claims/replay", "HEAD"]); // local evidence only
      const run = runScript(
        VERIFY,
        [...snapshots, "--expect-kind", "denied", "--expect-origin", originUrl(git)],
        repo,
        { outcome: ENVELOPE_DENIED },
      );
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /origin is unchanged: \*\*PASS\*\*/);
      assert.match(run.stdout, /verdict: HOLD/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("breaks when origin moved under a verdict that claims no mint", () => {
    const { repo, git } = buildCheckout();
    try {
      const snapshots = writeSnapshots(git, repo);
      // something landed on origin despite the denied verdict
      git(["push", "-q", "origin", "HEAD:refs/tags/0.1.0"]);
      writeFileSync(join(repo, "remote-after.txt"), remoteRefs(git));
      const run = runScript(
        VERIFY,
        [...snapshots, "--expect-kind", "denied", "--expect-origin", originUrl(git)],
        repo,
        { outcome: ENVELOPE_DENIED },
      );
      assert.equal(run.status, 1);
      assert.match(run.stdout, /origin is unchanged: \*\*FAIL\*\*/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("an envelope that never arrived claims nothing — the unchanged band, asserted", () => {
    const { repo, git } = buildCheckout();
    try {
      const snapshots = writeSnapshots(git, repo);
      const run = runScript(
        VERIFY,
        [...snapshots, "--expect-kind", "published", "--expect-origin", originUrl(git)],
        repo,
        {},
      );
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /no readable envelope/);
      assert.match(run.stdout, /origin is unchanged: \*\*PASS\*\*/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("an unexpected origin is a broken leg — the credentials-origin cross-check", () => {
    const { repo, git } = buildCheckout();
    try {
      const snapshots = writeSnapshots(git, repo);
      const run = runScript(
        VERIFY,
        [
          ...snapshots,
          "--expect-kind",
          "denied",
          "--expect-origin",
          "https://github.com/ecoma-io/other-repo",
        ],
        repo,
        { outcome: ENVELOPE_DENIED },
      );
      assert.equal(run.status, 1);
      assert.match(run.stdout, /origin is the dispatching repository: \*\*FAIL\*\*/);
      assert.match(run.stdout, /the mint must not ride another repository/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("an expect-kind outside the run union is a usage fault naming the union", () => {
    const { repo, git } = buildCheckout();
    try {
      const snapshots = writeSnapshots(git, repo);
      const run = runScript(
        VERIFY,
        [...snapshots, "--expect-kind", "released-now", "--expect-origin", originUrl(git)],
        repo,
        { outcome: ENVELOPE_PUBLISHED },
      );
      assert.equal(run.status, 64);
      assert.match(run.stderr, /not a kind of the run union/);
      assert.match(run.stderr, /published, satisfied-externally, resolved, abandoned/);
      assert.match(run.stderr, /denied, blocked/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("a missing demanded flag is a usage fault — exit 64", () => {
    const { repo, git } = buildCheckout();
    try {
      writeSnapshots(git, repo);
      const run = runScript(VERIFY, ["--before", "remote-before.txt"], repo, {
        outcome: ENVELOPE_PUBLISHED,
      });
      assert.equal(run.status, 64);
      assert.match(run.stderr, /missing --after/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
