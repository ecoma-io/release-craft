/**
 * The publish leg's live wire, through the built bin (issue #336): a
 * stateful HTTP stub answers the GitHub adapter's sequence behind
 * `GITHUB_API_URL`, and a run declaring `--publish` — a github.com
 * origin, `GITHUB_TOKEN` in the child env — mints the tag locally,
 * creates the GitHub Release over the recorded changelog bytes, and
 * verifies it, landing the release URL on the published envelope.
 *
 * Nothing here touches a real network: the two ambient names the
 * transport may read both point at the stub. The stub is stateful the
 * way the API is — the release read answers 404 before the create, the
 * created body after — and the test asserts the wire order the
 * adapter's read-before-write design demands, plus the created
 * release's tag/target against the recorded mint and the minted
 * tag@SHA observable in the seeded repository. The stub lives in its
 * own process: a harness worker blocks its own event loop while
 * `spawnSync` (runCli) runs, so an in-process stub would never serve
 * its own socket; in its own process it answers normally, and the
 * readiness and the created/played relays arrive as real events —
 * promises resolved by the parser, never guessed waits.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GitChannelStore } from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import { changelogOf, renderChangelog } from "@ecoma-io/release-craft/planner";

import { createTempRepo } from "../adapters/git/temp-repo.js";
import { standingChannelStates } from "../vertical/matrix.js";
import { seedLineHeads } from "../vertical/matrix-git.js";
import {
  betaIntent,
  cliJson,
  directPlan,
  docBytes,
  gitDoc,
  gitSelection,
  runCli,
} from "./harness.js";

const OWNER = "ecoma-io";
const REPO = "release-craft";
const ORIGIN = `https://github.com/${OWNER}/${REPO}.git`;
const TAG = "5.0.0-beta.1";
const RELEASE_URL = `https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`;
const PLAYED = 6; // the wire's full length — every request the sequence names
/** The stub script, run as its own process (see the header): the
 *  controller tells it the ref head each test seeds — the seeded head is
 *  only known once the repository exists — and reads back the played
 *  wire and the created release over the control pipe. */
const STUB_SCRIPT = fileURLToPath(new URL("./publish-stub.mjs", import.meta.url));

/** The stateful wire process: the release read answers 404 until the
 *  create lands, then echoes the created body back with the resource's
 *  URL; the git-ref read answers the recorded head. `ready` settles on
 *  the stub's READY line (the ephemeral port); `created` settles on the
 *  create's relayed body; `played` settles once the full wire played. */
interface PublicationStub {
  readonly ready: Promise<number>;
  readonly created: Promise<Record<string, unknown>>;
  readonly played: Promise<void>;
  readonly players: readonly string[];
  setRefHead(sha: string): void;
  /** Arm the stub's missing-tag mode: the git-ref read answers 404
   *  until the create lands — the wire of a tag the origin does not
   *  hold yet, where the create itself mints it at the sent commitish. */
  setMissing(): void;
  close(): Promise<number>;
}

/** Open the wire process. `expected` is the full played length for the
 *  armed mode (6 — issue #351's read-before-write sequence) unless the
 *  test arms `setMissing()`, which adds the repository probe and lands
 *  a 7-request wire (release, refs, repo, POST, refs, release, refs). */
const openStub = (expected = PLAYED): PublicationStub => {
  const child: ChildProcess = spawn(process.execPath, [STUB_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const players: string[] = [];
  let createdResolve: (value: Record<string, unknown>) => void = () => undefined;
  let playedResolve: () => void = () => undefined;
  let readyResolve: (port: number) => void = () => undefined;
  let readyReject: (reason: Error) => void = () => undefined;
  let exitResolve: (code: number) => void = () => undefined;
  const ready = new Promise<number>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const created = new Promise<Record<string, unknown>>((resolve) => {
    createdResolve = resolve;
  });
  const played = new Promise<void>((resolve) => {
    playedResolve = resolve;
  });
  const exit = new Promise<number>((resolve) => {
    exitResolve = resolve;
  });
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout === null || stderr === null) {
    throw new Error("the stub opened no stdio pipe");
  }
  let stderrText = "";
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      const readyMatch = line.match(/^READY (\d+)$/);
      if (readyMatch !== null) {
        readyResolve(Number(readyMatch[1]));
      }
      const playedMatch = line.match(/^PLAY (.+)$/);
      const played = playedMatch?.[1];
      if (played !== undefined) {
        players.push(played);
        if (players.length === expected) {
          playedResolve();
        }
      }
      const createdMatch = line.match(/^CREATED (.+)$/);
      const created = createdMatch?.[1];
      if (created !== undefined) {
        createdResolve(JSON.parse(created) as Record<string, unknown>);
      }
    }
  });
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => {
    stderrText += chunk;
  });
  child.on("exit", (code) => {
    readyReject(new Error(`the stub exited before ready (exit ${String(code)}): ${stderrText}`));
    exitResolve(code ?? 0);
  });
  // The controller's own writes must never crash the harness if the stub
  // already died — the exit promise is the authority on that.
  child.stdin?.on("error", () => undefined);
  return {
    ready,
    created,
    played,
    get players() {
      return [...players];
    },
    setRefHead(sha: string) {
      child.stdin?.write(`ref ${sha}\n`);
    },
    setMissing() {
      child.stdin?.write("missing\n");
    },
    async close() {
      if (child.exitCode === null) {
        child.stdin?.end("bye\n");
      }
      return await exit;
    },
  };
};

describe("§2.8 — the publish leg's live wire (issue #336)", () => {
  it(
    "a --publish run creates the GitHub Release and verifies it",
    { timeout: 45_000 },
    async () => {
      const stub = openStub();
      const port = await stub.ready;
      const fixture = createTempRepo();
      try {
        const git = fixture.git;
        // The seeded world: the matrix's five channels and line heads,
        // exactly as the git-assembly fixtures establish them.
        const heads = seedLineHeads(git);
        const channels = new GitChannelStore(fixture.repo);
        for (const channel of standingChannelStates()) {
          const outcome = channels.applyTransition({
            channelId: channel.id,
            from: null,
            to: { line: channel.target.line, version: channel.target.version },
          });
          if (outcome.kind !== "applied") {
            throw new Error(`fixture broken: seeding channel ${channel.id} got ${outcome.kind}`);
          }
        }
        // The changelog artifact's producer records `HEAD^{tree}`, so
        // the run's head tree must actually hold CHANGELOG.md — commit
        // one on the working HEAD (never just `update-ref`: the producer
        // reads the HEAD ref itself) and re-arm the stub with the new
        // head, the recorded target the release is created over.
        writeFileSync(join(fixture.repo, "CHANGELOG.md"), "# Changelog\n");
        git(["add", "CHANGELOG.md"]);
        git(["commit", "-m", "ecoma: changelog"]);
        const head = git(["rev-parse", "HEAD"]).trim();
        const headsWithChangelog = { ...heads, main: head };
        stub.setRefHead(head);
        git(["remote", "add", "origin", ORIGIN]);
        // The direct side's own plan over the same document: the changelog
        // the run itself plans and walks — the bytes the release body must
        // carry (issue #381), never the fixture's committed header.
        const doc = gitDoc("main", [betaIntent], headsWithChangelog);
        const docText = docBytes(doc);
        const planning = directPlan(gitSelection(fixture.repo), docText);
        expect(planning.kind).toBe("planned");
        if (planning.kind !== "planned") {
          throw new Error("fixture world refused to plan");
        }
        const planLine = planning.plan.lines.find((candidate) => candidate.lineId === "main");
        if (planLine === undefined) {
          throw new Error("fixture world plans no main line");
        }
        const expected = renderChangelog(changelogOf([planLine]));
        const child = runCli(
          [
            "run",
            "--assembly",
            "git",
            "--repo",
            fixture.repo,
            "--tag-namespace",
            "",
            "--world",
            "-",
            "--actor",
            "automation",
            "--line",
            "main",
            "--changelog",
            "--publish",
            "--json",
          ],
          {
            input: docText,
            env: {
              GITHUB_TOKEN: "test-token",
              GITHUB_API_URL: `http://127.0.0.1:${String(port)}`,
              PATH: process.env.PATH ?? "",
              HOME: process.env.HOME ?? "",
            },
          },
        );
        // The relays land on the worker's event loop only after runCli's
        // blocking spawnSync returns — await the real events, never a
        // guessed wait (the stub process keeps answering on its own loop).
        const release = await stub.created;
        await stub.played;
        expect(child.status).toBe(0);
        expect(child.stderr).toBe("");
        expect(cliJson(child)).toStrictEqual(
          expect.objectContaining({
            kind: "published",
            tag: TAG,
            releaseUrl: RELEASE_URL,
          }),
        );
        expect(release.tag_name).toBe(TAG);
        expect(release.target_commitish).toBe(head);
        // The published body is the recorded changelog's bytes — the run's
        // own planned changelog, rendered byte-for-byte; the committed
        // header template the fixture holds is never the body (#381).
        expect(release.body).toBe(expected);
        expect(git(["rev-parse", `refs/tags/${TAG}`]).trim()).toBe(head);
        // The wire order: precondition read (404), git-ref assert, create,
        // the create's own ref re-assert, then the verify leg's release
        // read-back and ref re-assert. No request may arrive out of this
        // sequence.
        expect(stub.players).toStrictEqual([
          `GET /repos/${OWNER}/${REPO}/releases/tags/${TAG}`,
          `GET /repos/${OWNER}/${REPO}/git/refs/tags/${TAG}`,
          `POST /repos/${OWNER}/${REPO}/releases`,
          `GET /repos/${OWNER}/${REPO}/git/refs/tags/${TAG}`,
          `GET /repos/${OWNER}/${REPO}/releases/tags/${TAG}`,
          `GET /repos/${OWNER}/${REPO}/git/refs/tags/${TAG}`,
        ]);
      } finally {
        fixture.cleanup();
        await stub.close();
      }
    },
  );

  it(
    "a --publish run creates the tag with the release when origin holds none — the missing tag is the create's own to make",
    { timeout: 45_000 },
    async () => {
      const stub = openStub(7);
      stub.setMissing();
      const port = await stub.ready;
      const fixture = createTempRepo();
      try {
        const git = fixture.git;
        const heads = seedLineHeads(git);
        const channels = new GitChannelStore(fixture.repo);
        for (const channel of standingChannelStates()) {
          const outcome = channels.applyTransition({
            channelId: channel.id,
            from: null,
            to: { line: channel.target.line, version: channel.target.version },
          });
          if (outcome.kind !== "applied") {
            throw new Error(`fixture broken: seeding channel ${channel.id} got ${outcome.kind}`);
          }
        }
        writeFileSync(join(fixture.repo, "CHANGELOG.md"), "# Changelog\n");
        git(["add", "CHANGELOG.md"]);
        git(["commit", "-m", "ecoma: changelog"]);
        const head = git(["rev-parse", "HEAD"]).trim();
        const headsWithChangelog = { ...heads, main: head };
        // The stub answers 404 here until the create lands; arming the
        // recorded head still matters — the post-create ref re-assert
        // and the verify leg read it back, and the tag GitHub mints must
        // answer the recorded SHA, or the re-assert refuses.
        stub.setRefHead(head);
        git(["remote", "add", "origin", ORIGIN]);
        // The direct side's own plan over the same document: the changelog
        // the run itself plans and walks — the bytes the release body must
        // carry (issue #381), never the fixture's committed header.
        const doc = gitDoc("main", [betaIntent], headsWithChangelog);
        const docText = docBytes(doc);
        const planning = directPlan(gitSelection(fixture.repo), docText);
        expect(planning.kind).toBe("planned");
        if (planning.kind !== "planned") {
          throw new Error("fixture world refused to plan");
        }
        const planLine = planning.plan.lines.find((candidate) => candidate.lineId === "main");
        if (planLine === undefined) {
          throw new Error("fixture world plans no main line");
        }
        const expected = renderChangelog(changelogOf([planLine]));
        const child = runCli(
          [
            "run",
            "--assembly",
            "git",
            "--repo",
            fixture.repo,
            "--tag-namespace",
            "",
            "--world",
            "-",
            "--actor",
            "automation",
            "--line",
            "main",
            "--changelog",
            "--publish",
            "--json",
          ],
          {
            input: docText,
            env: {
              GITHUB_TOKEN: "test-token",
              GITHUB_API_URL: `http://127.0.0.1:${String(port)}`,
              PATH: process.env.PATH ?? "",
              HOME: process.env.HOME ?? "",
            },
          },
        );
        const release = await stub.created;
        await stub.played;
        expect(child.status).toBe(0);
        expect(child.stderr).toBe("");
        expect(cliJson(child)).toStrictEqual(
          expect.objectContaining({
            kind: "published",
            tag: TAG,
            releaseUrl: RELEASE_URL,
          }),
        );
        expect(release.tag_name).toBe(TAG);
        expect(release.target_commitish).toBe(head);
        // The published body is the recorded changelog's bytes — the run's
        // own planned changelog, rendered byte-for-byte; the committed
        // header template the fixture holds is never the body (#381).
        expect(release.body).toBe(expected);
        expect(git(["rev-parse", `refs/tags/${TAG}`]).trim()).toBe(head);
        // The wire: release read 404, git-ref read 404 (a tag origin
        // does not hold), the repository probe (issue #176 — what makes
        // the miss determinate), the create minting tag and release
        // together, then the post-create re-assert, the verify leg's
        // release read-back, and its own ref re-assert.
        expect(stub.players).toStrictEqual([
          `GET /repos/${OWNER}/${REPO}/releases/tags/${TAG}`,
          `GET /repos/${OWNER}/${REPO}/git/refs/tags/${TAG}`,
          `GET /repos/${OWNER}/${REPO}`,
          `POST /repos/${OWNER}/${REPO}/releases`,
          `GET /repos/${OWNER}/${REPO}/git/refs/tags/${TAG}`,
          `GET /repos/${OWNER}/${REPO}/releases/tags/${TAG}`,
          `GET /repos/${OWNER}/${REPO}/git/refs/tags/${TAG}`,
        ]);
      } finally {
        fixture.cleanup();
        await stub.close();
      }
    },
  );
});
