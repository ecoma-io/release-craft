/**
 * §6 obligation 6 — determinism through the process surface. The plan is
 * a pure function of the world document, and the identities derived from
 * it (planId, then the engine's attempt ordinal → attemptId) are
 * content-derived, so two fresh processes given the same bytes answer with
 * byte-identical stdout. Across git repositories the outcomes are equal
 * modulo the binding's one intentionally random value (the claim token),
 * projected the same way the pass-through suite projects it.
 */

import { describe, expect, it } from "vitest";

import {
  betaIntent,
  cliJson,
  docBytes,
  gitDoc,
  memoryDoc,
  projectRepo,
  runCli,
  withSeededRepo,
  type CliResult,
} from "./harness.js";

const planArgs = (): string[] => ["plan", "--assembly", "memory", "--world", "-", "--json"];

const runArgs = (): string[] => [
  "run",
  "--assembly",
  "memory",
  "--world",
  "-",
  "--actor",
  "automation",
  "--line",
  "main",
  "--json",
];

describe("§6 obligation 6 — determinism", () => {
  it("two processes planning the same world document emit byte-identical stdout", () => {
    const doc = docBytes(memoryDoc("main", [betaIntent]));
    const first = runCli(planArgs(), { input: doc });
    const second = runCli(planArgs(), { input: doc });
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    // The plan identity is content-derived: the same document plans the
    // same planId, which is what makes cross-process doors nameable.
    const planId = (cliJson(first) as { plan: { planId: string } }).plan.planId;
    expect((cliJson(second) as { plan: { planId: string } }).plan.planId).toBe(planId);
  });

  it("two processes running the same request over fresh memory stores emit byte-identical stdout", () => {
    const doc = docBytes(memoryDoc("main", [betaIntent]));
    const first = runCli(runArgs(), { input: doc });
    const second = runCli(runArgs(), { input: doc });
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  });

  it(
    "two identically seeded repositories run the same request to byte-identical stdout, modulo the claim token",
    { timeout: 45_000 },
    () => {
      const docs: string[] = [];
      const outputs: CliResult[] = [];
      const scenario = (name: string): void => {
        withSeededRepo(name, (repo, _git, heads) => {
          const doc = docBytes(gitDoc("main", [betaIntent], heads));
          docs.push(doc);
          const child = runCli(
            [
              "run",
              "--assembly",
              "git",
              "--repo",
              repo,
              "--tag-namespace",
              "",
              "--world",
              "-",
              "--actor",
              "automation",
              "--line",
              "main",
              "--json",
            ],
            { input: doc },
          );
          expect(child.status).toBe(0);
          outputs.push(child);
        });
      };
      scenario("determinism-git-one");
      scenario("determinism-git-two");
      // The two scenarios described the same repository byte-for-byte.
      expect(docs[1]).toBe(docs[0]);
      const [first, second] = outputs as [CliResult, CliResult];
      expect(projectRepo(first)).toStrictEqual(projectRepo(second));
    },
  );

  it("the same attempt ordinal derives the same attemptId in a fresh process", () => {
    const doc = docBytes(memoryDoc("main", [betaIntent]));
    const first = JSON.parse(runCli(runArgs(), { input: doc }).stdout) as {
      handle: { attemptId: string; planId: string };
    };
    const second = JSON.parse(runCli(runArgs(), { input: doc }).stdout) as {
      handle: { attemptId: string; planId: string };
    };
    expect(second.handle.planId).toBe(first.handle.planId);
    expect(second.handle.attemptId).toBe(first.handle.attemptId);
  });
});
