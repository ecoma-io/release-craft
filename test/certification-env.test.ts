/**
 * The certification process transport's environment law, guarded from
 * OUTSIDE the fixture directory. The fixture's own modules name no ambient
 * source — phase 14 §8's law, enforced by the isolation probe as a token
 * scan over every fixture module, suites included — so the guard that
 * PLANTS a hostile worker ambient to prove the construction starves it
 * cannot live inside the scanned set: the probe fails (it did, live, on
 * this law's introduction) the very file that pins the law. This suite is
 * that guard. It reads and writes `process.env` ONLY to plant and restore
 * a hostile ambient — the same posture the CLI's hermeticity suite takes
 * outside its own static scan (`test/cli/hermeticity.test.ts`, whose
 * behavioral leg hands the hostile values to the spawn).
 *
 * The law guarded: `runBin` constructs the subprocess's environment as the
 * invocation script's two-name outer line (phase 13 §4, `action/invoke.mjs`
 * — "allowlist, never blocklist"): exactly `PATH` and `HOME`, so no worker
 * ambient — `NODE_OPTIONS`, locale variables, agent markers, `GIT_*`
 * context — can move the envelope bytes the fixture certifies (the
 * determinism residue #189 records). Two independent facts carry it here;
 * the construction's exact key set is pinned structurally in
 * `census.test.ts`, and the coupling of `runBin` to its construction with
 * it:
 *
 * 1. the plant is lethal — a child that receives it dies before the CLI
 *    runs (node reads `NODE_OPTIONS` at startup and refuses the unknown
 *    flag, exit 9). Without this leg the law would be vacuous: a
 *    construction that stopped starving the ambient would fail nothing,
 *    because the ambient carries nothing lethal on any honest machine;
 * 2. the constructed run publishes clean UNDER the planted ambient — the
 *    starved child never sees the plant, the marker, or the git context.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { hermeticGitEnv } from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import {
  CLI_BIN,
  docBytes,
  gitBetaDocument,
  gitRunArgs,
  runBin,
  withSeededRepo,
} from "./certification/drive.js";

/** The hostile worker ambient: a node-runtime plant (the lethal channel),
 * an agent marker, and a leaked git context — the classes of ambient value
 * the wholesale inheritance carried and the construction starves. */
const HOSTILE = {
  NODE_OPTIONS: "--bogus-release-craft-pin",
  AI_AGENT: "hostile-agent",
  GIT_DIR: "/evil/.git",
} as const;

/** Plants `HOSTILE` into the worker's ambient for the body's duration and
 * restores whatever each key held — absence included — whether the body
 * passes or fails. The keys are spelled statically: this suite exists
 * because a textual law is part of the fixture's contract, so the plant is
 * written out, not computed. */
const withPlantedAmbient = (body: () => void): void => {
  const saved = {
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    AI_AGENT: process.env.AI_AGENT,
    GIT_DIR: process.env.GIT_DIR,
  };
  process.env.NODE_OPTIONS = HOSTILE.NODE_OPTIONS;
  process.env.AI_AGENT = HOSTILE.AI_AGENT;
  process.env.GIT_DIR = HOSTILE.GIT_DIR;
  try {
    body();
  } finally {
    if (saved.NODE_OPTIONS === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = saved.NODE_OPTIONS;
    }
    if (saved.AI_AGENT === undefined) {
      delete process.env.AI_AGENT;
    } else {
      process.env.AI_AGENT = saved.AI_AGENT;
    }
    if (saved.GIT_DIR === undefined) {
      delete process.env.GIT_DIR;
    } else {
      process.env.GIT_DIR = saved.GIT_DIR;
    }
  }
};

describe("the certification process transport's environment law", () => {
  it(
    "the plant is lethal — a child that receives it dies before the CLI runs",
    { timeout: 45_000 },
    () => {
      withSeededRepo("cert-env-lethal", (repo, _git, heads) => {
        // The same spawn `runBin` makes, with ONE delta: the plant rides
        // the two-name construction. The exit is node's own refusal, not a
        // CLI verdict — the channel's lethality, observed.
        const child = spawnSync(process.execPath, [CLI_BIN, ...gitRunArgs(repo, "main")], {
          encoding: "utf8",
          env: {
            PATH: hermeticGitEnv().PATH ?? "",
            HOME: mkdtempSync(join(tmpdir(), "release-craft-home-")),
            NODE_OPTIONS: HOSTILE.NODE_OPTIONS,
          },
          input: docBytes(gitBetaDocument(heads)),
        });
        expect(child.status).toBe(9);
        expect(child.stderr).toContain("is not allowed in NODE_OPTIONS");
        expect(child.stdout).toBe("");
      });
    },
  );

  it(
    "the constructed run is untouched by the planted ambient — clean publish, empty stderr",
    { timeout: 45_000 },
    () => {
      withPlantedAmbient(() => {
        withSeededRepo("cert-env-plant", (repo, _git, heads) => {
          const child = runBin(gitRunArgs(repo, "main"), {
            input: docBytes(gitBetaDocument(heads)),
          });
          expect(child.status).toBe(0);
          expect(child.stderr).toBe("");
          expect(JSON.parse(child.stdout)).toMatchObject({ kind: "published" });
        });
      });
    },
  );
});
