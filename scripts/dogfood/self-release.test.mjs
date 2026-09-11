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
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
 * main — the dispatch's checkout shape at the smallest it can be. The root is
 * the caller's to remove, and the root is what the caller removes: it holds
 * both the working clone and origin.git, so nothing of the fixture survives
 * the test's finally.
 *
 * @returns {{ root: string, repo: string, origin: string, git: (args: string[]) => string }}
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
  return { root, repo, origin, git };
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
 * @param {{ outcome?: string, rcToken?: string, env?: Record<string, string> }} evidence
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function runScript(script, args, repo, { outcome, rcToken, env: extra = {} } = {}) {
  /** @type {Record<string, string | undefined>} */
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  if (outcome !== undefined) {
    env.RC_OUTCOME = outcome;
  }
  if (rcToken !== undefined) {
    env.RC_TOKEN = rcToken;
  }
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...env, ...extra },
  });
}

describe("publish-mint", () => {
  it("pushes exactly the minted pairs, atomically, for a published verdict", () => {
    const { root, repo, git } = buildCheckout();
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pushes nothing for a stop-band verdict — origin stays untouched", () => {
    const { root, repo, git } = buildCheckout();
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a published verdict whose mint is empty", () => {
    const { root, repo, git } = buildCheckout();
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a published verdict whose named tag is not in the mint", () => {
    const { root, repo, git } = buildCheckout();
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never forces a push: a ref origin already holds is a loud rejection, not an overwrite", () => {
    const { root, repo, git } = buildCheckout();
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an empty envelope loudly — nothing claimed is not a publish", () => {
    const { root, repo, git } = buildCheckout();
    try {
      writeFileSync(
        join(repo, "local-refs-before.txt"),
        git(["for-each-ref", "--format=%(refname) %(objectname)"]),
      );
      const run = runScript(PUBLISH, ["--local-before", "local-refs-before.txt"], repo, {});
      assert.equal(run.status, 1);
      assert.match(run.stderr, /RC_OUTCOME is empty/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a survivor that is not JSON", () => {
    const { root, repo, git } = buildCheckout();
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a protocol violation is a usage fault — exit 64", () => {
    const { root, repo } = buildCheckout();
    try {
      const run = runScript(PUBLISH, [], repo, { outcome: ENVELOPE_PUBLISHED });
      assert.equal(run.status, 64);
      assert.match(run.stderr, /missing --local-before/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pushes behind the empty-helper reset — an ambient helper never rides in", () => {
    const { root, repo, git } = buildCheckout();
    // The reset's own proof: a hostile ambient helper configured in the
    // spawn's HOME, and the argv git actually receives, read back through a
    // logging shim ahead of the real git on PATH. The filesystem transport
    // never queries a helper, so the load-bearing assertions are the argv's
    // shape — the reset first, the inline helper second, the token in
    // neither — which is exactly the shape an http transport would obey.
    const shimDir = join(root, "bin");
    const home = join(root, "home");
    const argvLog = join(root, "git-argv.log");
    const marker = join(root, "ambient-helper-ran.txt");
    mkdirSync(shimDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    assert.match(realGit, /git$/);
    writeFileSync(
      join(shimDir, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$@" >> "$GIT_ARGV_LOG"\nexec ${realGit} "$@"\n`,
    );
    chmodSync(join(shimDir, "git"), 0o755);
    writeFileSync(
      join(home, ".gitconfig"),
      // consulted, it would land the marker and answer the wrong password
      `[credential]\n\thelper = !f(){ printf 'consulted\\n' >> ${marker}; echo username=ambient; echo password=wrong; }; f\n`,
    );
    try {
      writeFileSync(
        join(repo, "local-refs-before.txt"),
        git(["for-each-ref", "--format=%(refname) %(objectname)"]),
      );
      mintLocally(git);
      const run = runScript(PUBLISH, ["--local-before", "local-refs-before.txt"], repo, {
        outcome: ENVELOPE_PUBLISHED,
        rcToken: "suite-token",
        env: {
          PATH: `${shimDir}:${String(process.env.PATH)}`,
          HOME: home,
          GIT_ARGV_LOG: argvLog,
        },
      });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(remoteRefs(git), /refs\/tags\/0\.1\.0/);
      assert.equal(existsSync(marker), false, "the ambient helper must never be consulted");
      const argv = readFileSync(argvLog, "utf8")
        .split("\n")
        .filter((line) => line !== "");
      const push = argv.indexOf("push");
      assert.notEqual(push, -1, "the push invocation must pass through the shim");
      assert.equal(argv[push + 1], "--atomic");
      const helper =
        "credential.helper=!f(){ echo username=x-access-token; echo password=$RC_TOKEN; }; f";
      const helperAt = argv.indexOf(helper);
      assert.notEqual(helperAt, -1, "the inline helper must ride the push's argv");
      assert.equal(argv[helperAt - 1], "-c");
      assert.equal(
        argv[helperAt - 2],
        "credential.helper=",
        "the reset must precede the inline helper",
      );
      assert.equal(argv[helperAt - 3], "-c");
      assert.ok(!argv.includes("suite-token"), "the token rides no process listing");
    } finally {
      rmSync(root, { recursive: true, force: true });
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
    const { root, repo, git } = buildCheckout();
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("breaks when a minted ref never reached origin — the green-but-unminted class", () => {
    const { root, repo, git } = buildCheckout();
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("breaks when origin carries the tag at a different object", () => {
    const { root, repo, git } = buildCheckout();
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails by the object when the tag sits at a wrong sha among correctly landed refs", () => {
    const { root, repo, git } = buildCheckout();
    try {
      const snapshots = writeSnapshots(git, repo);
      mintLocally(git);
      // every recorded namespace lands exactly right; only the tag's object
      // is wrong — so the row's failure is attributable to the sha alone,
      // and a refname-only comparison could never see it
      git(["push", "-q", "origin", `HEAD:refs/release-craft/ledger/${"b".repeat(64)}`]);
      git(["push", "-q", "origin", "HEAD:refs/release-craft/claims/scope"]);
      git(["push", "-q", "origin", "HEAD:refs/release-craft/register/plan"]);
      git(["checkout", "-q", "-b", "side"]);
      git(["commit", "-q", "--allow-empty", "-m", "feat: not the minted object"]);
      const other = git(["rev-parse", "HEAD"]).trim();
      git(["checkout", "-q", "main"]);
      git(["branch", "-q", "-D", "side"]);
      git(["push", "-q", "origin", `${other}:refs/tags/0.1.0`]);
      writeFileSync(join(repo, "remote-after.txt"), remoteRefs(git));
      const run = runScript(
        VERIFY,
        [...snapshots, "--expect-kind", "published", "--expect-origin", originUrl(git)],
        repo,
        { outcome: ENVELOPE_PUBLISHED },
      );
      assert.equal(run.status, 1);
      assert.match(run.stdout, /verdict: BROKEN/);
      // the failing row names the mismatch: one of four, the tag, present
      // but at a different object — not an absent ref
      assert.match(
        run.stdout,
        /1 of 4 minted ref\(s\) absent from or different on origin: refs\/tags\/0\.1\.0/,
      );
      assert.match(run.stdout, /the envelope's tag is on origin: \*\*FAIL\*\*/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("holds for a stop-band verdict over an unchanged origin", () => {
    const { root, repo, git } = buildCheckout();
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("breaks when origin moved under a verdict that claims no mint", () => {
    const { root, repo, git } = buildCheckout();
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an envelope that never arrived claims nothing — the unchanged band, asserted", () => {
    const { root, repo, git } = buildCheckout();
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an unexpected origin is a broken leg — the credentials-origin cross-check", () => {
    const { root, repo, git } = buildCheckout();
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an expect-kind outside the run union is a usage fault naming the union", () => {
    const { root, repo, git } = buildCheckout();
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a missing demanded flag is a usage fault — exit 64", () => {
    const { root, repo, git } = buildCheckout();
    try {
      writeSnapshots(git, repo);
      const run = runScript(VERIFY, ["--before", "remote-before.txt"], repo, {
        outcome: ENVELOPE_PUBLISHED,
      });
      assert.equal(run.status, 64);
      assert.match(run.stderr, /missing --after/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
