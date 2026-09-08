/**
 * §6 obligation 4 — the grammar is the closed inventory. The §2.2 flag
 * table is pinned as executable data (GRAMMAR), the deliberately absent
 * flags are asserted absent, and every negative below drives the built
 * binary: an argv the grammar does not name is a usage fault — exit 64,
 * the synopsis on stderr, stdout empty — never an ignored token and never
 * a rendered outcome.
 */

import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { COMMANDS, GRAMMAR, usageText } from "../../src/cli/grammar.js";
import { betaIntent, cliJson, docBytes, memoryDoc, runCli, withTempDir } from "./harness.js";

const ABSENT_FLAGS = ["target", "naming-module", "declarations", "help", "h", "version"] as const;

const expectUsageFault = (args: readonly string[], input?: string) => {
  const result = runCli(args, input === undefined ? {} : { input });
  expect(result.status).toBe(64);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("usage:");
  expect(result.stderr).toContain(usageText());
  return result;
};

describe("§2.2 — the grammar as executable data", () => {
  it("one command per Engine door, no sixth command", () => {
    expect(COMMANDS).toStrictEqual(["plan", "run", "resume", "resolve", "abort", "show"]);
  });

  it("every command's flag inventory is exactly its §2.2 row", () => {
    expect(GRAMMAR.plan.flags).toStrictEqual([
      "assembly",
      "repo",
      "tag-namespace",
      "max-retries",
      "json",
      "world",
      "intent",
    ]);
    expect(GRAMMAR.run.flags).toStrictEqual([
      "assembly",
      "repo",
      "tag-namespace",
      "max-retries",
      "json",
      "world",
      "intent",
      "actor",
      "line",
    ]);
    expect(GRAMMAR.resume.flags).toStrictEqual([
      "assembly",
      "repo",
      "tag-namespace",
      "max-retries",
      "json",
      "world",
      "actor",
      "plan",
      "attempt",
      "line",
    ]);
    expect(GRAMMAR.resolve.flags).toStrictEqual([
      "assembly",
      "repo",
      "tag-namespace",
      "max-retries",
      "json",
      "actor",
      "plan",
      "attempt",
      "step",
      "resolution",
      "note",
      "plan-fingerprint",
    ]);
    expect(GRAMMAR.abort.flags).toStrictEqual([
      "assembly",
      "repo",
      "tag-namespace",
      "max-retries",
      "json",
      "actor",
      "plan",
      "attempt",
      "reason",
    ]);
    expect(GRAMMAR.show.flags).toStrictEqual([
      "assembly",
      "repo",
      "tag-namespace",
      "max-retries",
      "json",
      "actor",
      "plan",
      "attempt",
    ]);
  });

  it("the §2.2 demands: mutating doors demand --actor, run demands --line, plan does not", () => {
    expect(GRAMMAR.plan.demanded).toStrictEqual(["assembly", "world"]);
    expect(GRAMMAR.run.demanded).toStrictEqual(["assembly", "world", "actor", "line"]);
    expect(GRAMMAR.resume.demanded).toStrictEqual([
      "assembly",
      "world",
      "actor",
      "plan",
      "attempt",
    ]);
    expect(GRAMMAR.resolve.demanded).toStrictEqual([
      "assembly",
      "actor",
      "plan",
      "attempt",
      "step",
      "resolution",
    ]);
    expect(GRAMMAR.abort.demanded).toStrictEqual([
      "assembly",
      "actor",
      "plan",
      "attempt",
      "reason",
    ]);
    expect(GRAMMAR.show.demanded).toStrictEqual(["assembly"]);
  });

  it("the deliberately absent flags are absent from every command's inventory", () => {
    for (const grammar of Object.values(GRAMMAR)) {
      for (const absent of ABSENT_FLAGS) {
        expect(grammar.flags).not.toContain(absent);
      }
      // No positional selector anywhere but show's attempt|channels.
      expect(grammar.positionals).toStrictEqual(
        grammar === GRAMMAR.show ? ["attempt", "channels"] : [],
      );
    }
    expect(GRAMMAR.show.positionals).toStrictEqual(["attempt", "channels"]);
  });
});

describe("§2.2 — the negative inventory, through the built bin (exit 64)", () => {
  it("an unknown command", () => {
    const result = expectUsageFault(["release"]);
    expect(result.stderr).toContain('unknown command "release"');
  });

  it("no command at all", () => {
    const result = expectUsageFault([]);
    expect(result.stderr).toContain("no command given");
  });

  it("an unknown flag is a usage fault on every command", () => {
    for (const command of COMMANDS) {
      const result = expectUsageFault([command, "--bogus", "x"]);
      expect(result.stderr).toContain("unknown flag --bogus");
    }
  });

  it("--target is not in the inventory (targets are derived, never passed)", () => {
    const result = expectUsageFault([
      "run",
      "--assembly",
      "memory",
      "--world",
      "-",
      "--actor",
      "automation",
      "--line",
      "main",
      "--target",
      "m5",
    ]);
    expect(result.stderr).toContain("unknown flag --target");
  });

  it("--naming-module is not in the inventory (naming is declared, never coded)", () => {
    const result = expectUsageFault([
      "run",
      "--assembly",
      "git",
      "--repo",
      "/tmp/x",
      "--tag-namespace",
      "",
      "--naming-module",
      "./my-naming.js",
    ]);
    expect(result.stderr).toContain("unknown flag --naming-module");
  });

  it("--declarations is not in the inventory (v1 runs declare nothing)", () => {
    const result = expectUsageFault([
      "run",
      "--assembly",
      "memory",
      "--declarations",
      "hooks.json",
    ]);
    expect(result.stderr).toContain("unknown flag --declarations");
  });

  it("a demanded flag missing is a usage fault naming the flag", () => {
    const result = expectUsageFault([
      "run",
      "--assembly",
      "memory",
      "--world",
      "-",
      "--line",
      "main",
    ]);
    expect(result.stderr).toContain("missing --actor");
  });

  it("run demands --line; plan refuses it", () => {
    expectUsageFault(["run", "--assembly", "memory", "--world", "-", "--actor", "automation"]);
    const planned = expectUsageFault([
      "plan",
      "--assembly",
      "memory",
      "--world",
      "-",
      "--line",
      "main",
    ]);
    expect(planned.stderr).toContain("unknown flag --line");
  });

  it("an empty flag value is refused", () => {
    const result = expectUsageFault([
      "run",
      "--assembly",
      "memory",
      "--world",
      "-",
      "--actor",
      "",
      "--line",
      "main",
    ]);
    expect(result.stderr).toContain("flag --actor refuses the empty string");
  });

  it("a flag declared twice is refused", () => {
    const result = expectUsageFault([
      "run",
      "--assembly",
      "memory",
      "--world",
      "-",
      "--world",
      "-",
      "--actor",
      "automation",
      "--line",
      "main",
    ]);
    expect(result.stderr).toContain("flag --world is declared once");
  });

  it("a value-less flag given a value is refused", () => {
    const result = expectUsageFault([
      "plan",
      "--assembly",
      "memory",
      "--world",
      "-",
      "--json=true",
    ]);
    expect(result.stderr).toContain("flag --json takes no value");
  });

  it("a dangling flag value is refused", () => {
    const result = expectUsageFault([
      "run",
      "--assembly",
      "memory",
      "--world",
      "-",
      "--actor",
      "automation",
      "--line",
    ]);
    expect(result.stderr).toContain("flag --line demands a value");
  });

  it("the memory assembly refuses git-only flags; the git assembly demands them", () => {
    const withRepo = expectUsageFault([
      "plan",
      "--assembly",
      "memory",
      "--world",
      "-",
      "--repo",
      "/tmp/somewhere",
    ]);
    expect(withRepo.stderr).toContain("--repo feeds the git assembly only");
    const withNamespace = expectUsageFault([
      "plan",
      "--assembly",
      "memory",
      "--world",
      "-",
      "--tag-namespace",
      "v",
    ]);
    expect(withNamespace.stderr).toContain("--tag-namespace feeds the git assembly only");
    const noRepo = expectUsageFault([
      "plan",
      "--assembly",
      "git",
      "--world",
      "-",
      "--tag-namespace",
      "v",
    ]);
    expect(noRepo.stderr).toContain("missing --repo");
    const noNamespace = expectUsageFault([
      "plan",
      "--assembly",
      "git",
      "--world",
      "-",
      "--repo",
      "/tmp/somewhere",
    ]);
    expect(noNamespace.stderr).toContain("missing --tag-namespace");
  });

  it("the assembly value itself is closed: memory | git", () => {
    const result = expectUsageFault(["plan", "--assembly", "redis", "--world", "-"]);
    expect(result.stderr).toContain("--assembly must be memory | git");
  });

  it("--max-retries demands an integer literal", () => {
    for (const bad of ["abc", "1.5", "1e3", "0x10", "Infinity"]) {
      const result = expectUsageFault([
        "plan",
        "--assembly",
        "memory",
        "--world",
        "-",
        "--max-retries",
        bad,
      ]);
      expect(result.stderr).toContain(`--max-retries "${bad}" is not an integer`);
    }
  });

  it("an --intent that is not one of the five spellings is a usage fault", () => {
    const result = expectUsageFault([
      "plan",
      "--assembly",
      "memory",
      "--world",
      "-",
      "--intent",
      "deploy",
    ]);
    expect(result.stderr).toContain('--intent "deploy" is not an operator intent');
  });

  it("an id carrying the reserved `:` separator is refused at parse time, exit 64", () => {
    for (const bad of [
      "prerelease:beta:main:extra",
      "promote:main:extra",
      "release-as:1.0.0:extra",
      "release:extra",
    ]) {
      const result = expectUsageFault([
        "plan",
        "--assembly",
        "memory",
        "--world",
        "-",
        "--intent",
        bad,
      ]);
      expect(result.stderr).toContain('--intent "' + bad + '" is not an operator intent');
    }
  });

  it("resolve's resolution pairing is exclusive and demanded", () => {
    const base = [
      "resolve",
      "--assembly",
      "memory",
      "--actor",
      "op",
      "--plan",
      "p",
      "--attempt",
      "a",
      "--step",
      "validate",
    ];
    const noNote = expectUsageFault([...base, "--resolution", "human"]);
    expect(noNote.stderr).toContain("missing --note");
    const both = expectUsageFault([
      ...base,
      "--resolution",
      "human",
      "--note",
      "n",
      "--plan-fingerprint",
      "fp",
    ]);
    expect(both.stderr).toContain("--plan-fingerprint feeds the revalidation spelling only");
    const humanWithFingerprintOnly = expectUsageFault([
      ...base,
      "--resolution",
      "human",
      "--plan-fingerprint",
      "fp",
    ]);
    expect(humanWithFingerprintOnly.stderr).toContain("missing --note");
    const revalidationWithNote = expectUsageFault([
      ...base,
      "--resolution",
      "revalidation",
      "--plan-fingerprint",
      "fp",
      "--note",
      "n",
    ]);
    expect(revalidationWithNote.stderr).toContain("--note feeds the human spelling only");
    const missingFingerprint = expectUsageFault([...base, "--resolution", "revalidation"]);
    expect(missingFingerprint.stderr).toContain("missing --plan-fingerprint");
    const unknown = expectUsageFault([...base, "--resolution", "vibes"]);
    expect(unknown.stderr).toContain('--resolution "vibes" must be human | revalidation');
  });

  it("show takes exactly one positional: attempt | channels", () => {
    const none = expectUsageFault(["show", "--assembly", "memory"]);
    expect(none.stderr).toContain("attempt | channels");
    const unknown = expectUsageFault(["show", "--assembly", "memory", "everything"]);
    expect(unknown.stderr).toContain('unknown positional "everything"');
    const attemptWithoutHandle = expectUsageFault(["show", "--assembly", "memory", "attempt"]);
    expect(attemptWithoutHandle.stderr).toContain("missing --plan");
    const attemptWithoutActor = expectUsageFault([
      "show",
      "--assembly",
      "memory",
      "attempt",
      "--plan",
      "p",
      "--attempt",
      "a",
    ]);
    expect(attemptWithoutActor.stderr).toContain("missing --actor");
    const channelsWithHandle = expectUsageFault([
      "show",
      "--assembly",
      "memory",
      "channels",
      "--actor",
      "op",
    ]);
    expect(channelsWithHandle.stderr).toContain("--actor names an attempt's holder");
  });

  it("a malformed world document is a usage fault, not a fault band exit", () => {
    const notJson = expectUsageFault(["plan", "--assembly", "memory", "--world", "-"], "{not json");
    expect(notJson.stderr).toContain("not valid JSON");
    const wrongShape = expectUsageFault(
      ["plan", "--assembly", "memory", "--world", "-"],
      JSON.stringify({ policy: 5, repository: {}, history: {}, lines: [] }),
    );
    expect(wrongShape.stderr).toContain("not PlanningInput-shaped");
    const missing = expectUsageFault([
      "plan",
      "--assembly",
      "memory",
      "--world",
      "/nonexistent/world.json",
    ]);
    expect(missing.stderr).toContain(
      'the world document at "/nonexistent/world.json" could not be read',
    );
  });
});

describe("§2.2 — the accepted spellings", () => {
  it("the world document reads from a file path", () => {
    withTempDir("world-path", (dir) => {
      const path = `${dir}/world.json`;
      writeFileSync(path, docBytes(memoryDoc("main", [betaIntent])));
      const result = runCli(["plan", "--assembly", "memory", "--world", path, "--json"]);
      expect(result.status).toBe(0);
      expect((cliJson(result) as { kind: string }).kind).toBe("planned");
    });
  });

  it("without --json the outcome renders as human text on stdout", () => {
    const result = runCli(["plan", "--assembly", "memory", "--world", "-"], {
      input: docBytes(memoryDoc("main", [betaIntent])),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^planned\nplan /);
    expect(result.stdout).not.toContain("{");
    expect(result.stderr).toBe("");
  });
});
