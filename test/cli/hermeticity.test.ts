/**
 * §6 obligation 5 — hermeticity, pinned statically and behaviorally.
 *
 * Statically: the CLI's sources name no ambient source — no environment
 * read, no clock, no randomness, no network, no working-directory default.
 * The process's only inputs are argv and the `--world` document; the only
 * environment the process ever touches is the git assembly's own
 * `hermeticGitEnv()` floor, and the scan asserts the CLI's modules never
 * reach around it. The scan is honest the same way the boundary's own
 * isolation scan is: it also runs itself over a planted violation, so a
 * scanner that stops matching anything cannot pass silently.
 *
 * Behaviorally: a hostile environment — `GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_COUNT`, `GIT_TRACE`, a non-C locale —
 * must not leak past the binding's floor: the git assembly still plans and
 * publishes the same tag with clean stderr. And an actor-shaped ambient
 * value (`RELEASE_CRAFT_ACTOR`) with no `--actor` is a usage fault: an
 * identity is declared in argv, never inferred from the environment (§2.2).
 */

import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { betaIntent, cliJson, docBytes, gitDoc, runCli, withSeededRepo } from "./harness.js";

const CLI_SOURCES: readonly string[] = readdirSync(new URL("../../src/cli/", import.meta.url))
  .filter((name) => name.endsWith(".ts"))
  .map((name) => `../../src/cli/${name}`);

/** The ambient tokens the CLI's law forbids (§4). `process.argv`,
 * `process.stdout`, `process.stderr`, and `process.exitCode` are the
 * process surface itself and are allowed; everything that would let the
 * world in is not. The one exception is the declared one: `world.ts`'s
 * `readFileSync` IS the `--world` read (a path or stdin, §2.2) — the
 * filesystem-write rule below carries no exception, and no other file may
 * touch the filesystem at all. */
const FORBIDDEN: readonly {
  readonly name: string;
  readonly pattern: RegExp;
  readonly except?: (file: string) => boolean;
}[] = [
  { name: "process.env", pattern: /process\.env/ },
  { name: "wall clock", pattern: /\bDate\.now\(|\bnew Date\(|\bperformance\.now\(/ },
  { name: "randomness", pattern: /\bMath\.random\(|\bcrypto\.random/ },
  {
    name: "timers",
    pattern: /\bsetTimeout\(|\bsetInterval\(|\bsetImmediate\(|\bprocess\.hrtime\(/,
  },
  { name: "network", pattern: /\bfetch\(|\bhttp\.request\(|\bnet\.connect\(|XMLHttpRequest/ },
  { name: "console", pattern: /\bconsole\./ },
  { name: "working directory", pattern: /process\.cwd\(/ },
  {
    name: "filesystem writes",
    pattern: /\bwriteFileSync\(|\bappendFileSync\(|\bmkdirSync\(|\brmSync\(|\bunlinkSync\(/,
  },
  {
    name: "filesystem reads beyond the --world read",
    pattern: /\breadFileSync\(|\bexistsSync\(|\breaddirSync\(|\bstatSync\(/,
    except: (file) => file.endsWith("world.ts"),
  },
];

const scan = (source: string): string[] => {
  const violations: string[] = [];
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(source)) {
      violations.push(rule.name);
    }
  }
  return violations;
};

describe("§4 — the CLI names no ambient source (static)", () => {
  it("every src/cli module scans clean", () => {
    expect(CLI_SOURCES.length).toBeGreaterThanOrEqual(8);
    const findings: string[] = [];
    for (const relative of CLI_SOURCES) {
      const source = readFileSync(new URL(relative, import.meta.url), "utf8");
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(source) && !(rule.except?.(relative) ?? false)) {
          findings.push(`${relative}: ${rule.name}`);
        }
      }
    }
    expect(findings).toStrictEqual([]);
  });

  it("the scanner itself bites on a planted violation", () => {
    const planted =
      'const actor = process.env.RELEASE_CRAFT_ACTOR ?? "automation";\nconst at = new Date();';
    expect(scan(planted)).toStrictEqual(["process.env", "wall clock"]);
  });
});

describe("§4 — hostile environment must not leak past the floor (behavioral)", () => {
  const HOSTILE: NodeJS.ProcessEnv = {
    GIT_DIR: "/nonexistent/repository.git",
    GIT_WORK_TREE: "/nonexistent/worktree",
    GIT_CONFIG_GLOBAL: "/nonexistent/gitconfig",
    GIT_CONFIG_COUNT: "3",
    GIT_TRACE: "1",
    LC_ALL: "C.UTF-8",
    RELEASE_CRAFT_ACTOR: "ambient-actor",
  };

  it(
    "the git assembly still publishes through a hostile environment, with clean stderr",
    { timeout: 45_000 },
    () => {
      withSeededRepo("hermetic-git", (repo, _git, heads) => {
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
          { input: docBytes(gitDoc("main", [betaIntent], heads)), env: HOSTILE },
        );
        expect(child.status).toBe(0);
        expect(child.stderr).toBe("");
        expect(cliJson(child)).toMatchObject({ kind: "published", tag: "5.0.0-beta.1" });
      });
    },
  );

  it("the memory assembly is untouched by a hostile environment", () => {
    const child = runCli(
      [
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
      ],
      { input: docBytes(gitDoc("main", [betaIntent], { main: "0".repeat(40) })), env: HOSTILE },
    );
    // The memory assembly never opens the repository, so even a world
    // describing a repository nobody holds publishes: no ambient source
    // and no store reads the world behind the caller's back.
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    expect(cliJson(child)).toMatchObject({ kind: "published" });
  });

  it("an ambient actor value with no --actor is a usage fault, not an inferred identity", () => {
    const child = runCli(["run", "--assembly", "memory", "--world", "-", "--line", "main"], {
      input: docBytes(gitDoc("main", [betaIntent], { main: "0".repeat(40) })),
      env: HOSTILE,
    });
    expect(child.status).toBe(64);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("missing --actor");
  });
});
