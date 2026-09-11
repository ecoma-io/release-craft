/**
 * §6 obligation 2 — the exit-code table pinned kind by kind. Each row is
 * pinned twice: the process status AND the `--json` kind on stdout. The
 * rows reachable through the pure process grammar (one-shot processes,
 * empty declarations) are driven through the built bin — planned,
 * published, refused, denied, conflict, ambiguous — plus the two fault
 * exits, each pinned to render as a fault (stderr names the thrown error,
 * stdout stays empty) and never as a `refused` outcome.
 *
 * The rows a one-shot CLI process cannot reach — satisfied-externally,
 * resolved, abandoned, failed, stale, escalate, and the two observation
 * kinds' statuses — are pinned against the exit-codes module itself, whose
 * `Record` is exhaustive over the outcome unions: a new kind fails to
 * compile, and this suite fails if the number drifts. The renderer suite
 * pins those rows' stdout half. `blocked` left that list in #263: the
 * released-version replay makes a planning-boundary block reachable
 * through the pure process grammar, and its row is driven through the
 * built bin below.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  EXIT_CODES,
  EXIT_FAULT,
  EXIT_USAGE,
} from "@ecoma-io/release-craft/__internal__/cli/exit-codes.js";
import { RECORDED_EXIT_TABLE } from "../certification/exit-table.js";
import { COMMITTED_AT, liveWorld, runInput } from "../vertical/matrix.js";
import {
  betaIntent,
  cliJson,
  docBytes,
  gitDoc,
  lockChannelRefs,
  memoryDoc,
  promoteIntent,
  runCli,
  withSeededRepo,
} from "./harness.js";

const gitRunArgs = (repo: string): string[] => [
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
];

describe("§3.2 — the table, exhaustively", () => {
  it("every outcome kind maps to its §3.2 row — the certification fixture's recorded copy, cross-pinned here", () => {
    // The phase 14 certification fixture records its own copy of this
    // table (test/certification/exit-table.ts, hand-derived from phase 12
    // §3.2). §4.2 of that contract pins the two equal BY a cross-pin in
    // this suite — one table, no second mapping — because the fixture's
    // import law bars it from src/cli/, where the other side of the
    // equality lives. Amending the table (phase 12 §8 question 8) edits
    // the recorded copy and this suite's verdict moves with it.
    expect(EXIT_CODES).toStrictEqual(RECORDED_EXIT_TABLE);
  });

  it("the fault bands are the two named constants", () => {
    expect(EXIT_USAGE).toBe(64);
    expect(EXIT_FAULT).toBe(70);
  });
});

describe("§3.2 — the rows the process surface can reach, through the built bin", () => {
  it("planned → exit 0, kind planned", () => {
    const child = runCli(["plan", "--assembly", "memory", "--world", "-", "--json"], {
      input: docBytes(memoryDoc("main", [betaIntent])),
    });
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    expect(cliJson(child)).toMatchObject({ kind: "planned" });
  });

  it("published → exit 0, kind published", () => {
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
      { input: docBytes(memoryDoc("main", [betaIntent])) },
    );
    expect(child.status).toBe(0);
    expect(cliJson(child)).toMatchObject({ kind: "published", tag: "5.0.0-beta.1" });
  });

  it("refused → exit 10, kind refused (twice: a post-planning refusal and an observation refusal)", () => {
    const promoteDoc = docBytes(memoryDoc("main", [promoteIntent]));
    const first = runCli(
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
      { input: promoteDoc },
    );
    expect(first.status).toBe(10);
    expect(first.stderr).toBe("");
    expect(cliJson(first)).toMatchObject({ kind: "refused" });
    const second = runCli(["show", "channels", "--assembly", "memory", "--json"]);
    expect(second.status).toBe(10);
    expect(second.stderr).toBe("");
    expect(cliJson(second)).toMatchObject({ kind: "refused" });
  });

  it("blocked → exit 12, kind blocked — the planning boundary's own record, in both transports (#263)", () => {
    // The hosted replay (#263): the world observes the released tag under
    // its full git refname at main's unchanged head, the recorded
    // bootstrap rides the document, and the document's release demand
    // re-arrives. The plan blocks the line; the process renders the
    // boundary's own blocked record and exits 12.
    const world = liveWorld();
    world.tags.push({ name: "refs/tags/5.0.0", commit: "m5" });
    const doc = docBytes({
      ...runInput(world, "main", [{ kind: "release" }]),
      bootstrap: { version: "5.0.0", who: "the operator", when: COMMITTED_AT },
    });
    const args = [
      "run",
      "--assembly",
      "memory",
      "--world",
      "-",
      "--actor",
      "automation",
      "--line",
      "main",
    ];
    const jsonRun = runCli([...args, "--json"], { input: doc });
    expect(jsonRun.status).toBe(12);
    expect(jsonRun.stderr).toBe("");
    const envelope = cliJson(jsonRun) as {
      kind: string;
      cause: string;
      handle: unknown;
      drives: unknown[];
    };
    expect(envelope.kind).toBe("blocked");
    expect(envelope.cause).toContain("released-version-observed");
    expect(envelope.cause).toContain("refs/tags/5.0.0");
    expect(envelope.handle).toBeNull();
    expect(envelope.drives).toStrictEqual([]);
    // The human transcript carries the same record verbatim — the cause
    // line is the projection, never a re-translation.
    const human = runCli(args, { input: doc });
    expect(human.status).toBe(12);
    expect(human.stderr).toBe("");
    expect(human.stdout).toContain("blocked\n");
    expect(human.stdout).toContain("plan ");
    expect(human.stdout).toContain("cause released-version-observed: ");
    expect(human.stdout).toContain("refs/tags/5.0.0");
  });

  it(
    "denied → exit 11, kind denied, naming the holder (git: the claim survives the first process's publish)",
    { timeout: 45_000 },
    () => {
      withSeededRepo("exit-denied", (repo, _git, heads) => {
        const args = [
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
          "4.8.x",
          "--json",
        ];
        const first = runCli(args, { input: docBytes(gitDoc("4.8.x", [], heads)) });
        expect(first.status).toBe(0);
        const holder = (cliJson(first) as { handle: { attemptId: string } }).handle.attemptId;
        const second = runCli(args, { input: docBytes(gitDoc("4.8.x", [], heads)) });
        expect(second.status).toBe(11);
        expect(second.stderr).toBe("");
        expect(cliJson(second)).toMatchObject({ kind: "denied", holder });
      });
    },
  );

  it(
    "conflict → exit 14, kind conflict (git: the E-08 retry bound is the declared 0)",
    { timeout: 45_000 },
    () => {
      withSeededRepo("exit-conflict", (repo, _git, heads) => {
        const args = gitRunArgs(repo);
        const first = runCli(args, { input: docBytes(gitDoc("main", [betaIntent], heads)) });
        expect(first.status).toBe(0);
        const second = runCli(args, { input: docBytes(gitDoc("main", [betaIntent], heads)) });
        expect(second.status).toBe(14);
        expect(second.stderr).toBe("");
        expect(cliJson(second)).toMatchObject({ kind: "conflict" });
      });
    },
  );

  it(
    "ambiguous → exit 15, kind ambiguous, pinned twice (once per fresh repository)",
    { timeout: 45_000 },
    () => {
      const scenario = (name: string): void => {
        withSeededRepo(name, (repo, _git, heads) => {
          const first = runCli(gitRunArgs(repo), {
            input: docBytes(gitDoc("main", [betaIntent], heads)),
          });
          expect(first.status).toBe(0);
          const promoteDoc = docBytes(
            gitDoc("main", [promoteIntent], heads, [
              { name: "5.0.0-beta.1", commit: heads["main"] as string },
            ]),
          );
          lockChannelRefs(repo, ["stable", "next"]);
          const child = runCli(gitRunArgs(repo), { input: promoteDoc });
          expect(child.status).toBe(15);
          expect(child.stderr).toBe("");
          expect(cliJson(child)).toMatchObject({ kind: "ambiguous" });
        });
      };
      scenario("exit-ambiguous-one");
      scenario("exit-ambiguous-two");
    },
  );

  it(
    "observation doors → exit 0 (the channels read over a wired store)",
    { timeout: 45_000 },
    () => {
      withSeededRepo("exit-channels", (repo, _git, _heads) => {
        const child = runCli([
          "show",
          "channels",
          "--assembly",
          "git",
          "--repo",
          repo,
          "--tag-namespace",
          "",
          "--json",
        ]);
        expect(child.status).toBe(0);
        expect(cliJson(child)).toMatchObject({ kind: "channels" });
      });
    },
  );
});

describe("§3.2 — the fault band: an escaped throw is 70 and never renders as refused", () => {
  it("a structurally invalid assembly config is the assembly's own error, exit 70", () => {
    const child = runCli(["plan", "--assembly", "memory", "--world", "-", "--max-retries", "-1"], {
      input: docBytes(memoryDoc("main", [])),
    });
    expect(child.status).toBe(70);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("InvalidAssemblyConfigError");
    expect(child.stderr).toContain("maxRetries");
    expect(child.stderr).not.toMatch(/"kind"\s*:\s*"refused"/);
    expect(child.stderr).not.toContain("kind refused");
  });

  it(
    "the declared lie the world cannot honor is a fault, exit 70 — never a refused outcome",
    { timeout: 45_000 },
    () => {
      withSeededRepo("exit-fault-mint", (repo, _git, _heads) => {
        // §2.4's check is structural only: a document whose ref head names
        // a commit the world declares but the repository does not hold is
        // executed as declared — the walk completes, and the mint's
        // rev-parse cannot resolve the target. The binding's GitFaultError
        // escapes: name and message verbatim on stderr, nothing on stdout.
        const lyingDoc = docBytes(gitDoc("main", [betaIntent], { main: "e".repeat(40) }));
        const child = runCli(gitRunArgs(repo), { input: lyingDoc });
        expect(child.status).toBe(70);
        expect(child.stdout).toBe("");
        expect(child.stderr).toContain("GitFaultError");
        expect(child.stderr).not.toMatch(/"kind"\s*:\s*"refused"/);
      });
    },
  );

  it(
    "a document the planner's closed input refuses is the planner's own contract violation, exit 70",
    { timeout: 45_000 },
    () => {
      withSeededRepo("exit-fault-planner", (repo, _git, heads) => {
        // A ref head that is not an observed commit: the planner throws
        // (caller contract violation), the surface renders the throw.
        const lyingDoc = docBytes({
          ...gitDoc("main", [betaIntent], heads),
          repository: {
            commits: gitDoc("main", [betaIntent], heads).repository.commits,
            refs: [{ name: "main", head: "0".repeat(40) }],
          },
        });
        const child = runCli(gitRunArgs(repo), { input: lyingDoc });
        expect(child.status).toBe(70);
        expect(child.stdout).toBe("");
        expect(child.stderr).toContain("InvalidPlanningInputError");
        expect(child.stderr).not.toMatch(/"kind"\s*:\s*"refused"/);
      });
    },
  );

  it("an absent feed ref classifies at planning, not at the target check: exit 70, never the pre-walk refused", () => {
    // §2.5 as amended: the planner's range derivation refuses an
    // unobserved feedRef (InvalidPlanningInputError) BEFORE the engine's
    // pre-walk target check can fire, so the process renders the fault —
    // the pre-walk `refused` remains the hand-built-request path, not a
    // rendering this surface performs.
    const ghostDoc = docBytes({
      ...memoryDoc("main", [betaIntent]),
      lines: memoryDoc("main", [betaIntent]).lines.map((line) =>
        line.id === "main" ? { ...line, feedRef: "no-such-ref" } : line,
      ),
    });
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
      { input: ghostDoc },
    );
    expect(child.status).toBe(70);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("InvalidPlanningInputError");
    expect(child.stderr).toContain("no observed ref named");
    expect(child.stderr).not.toMatch(/"kind"\s*:\s*"refused"/);
  });
});

describe("§3.2 — the usage band: 64 never renders as an outcome", () => {
  it("every usage fault exits 64 with stdout empty and the synopsis on stderr", () => {
    for (const args of [
      ["bogus"],
      ["run", "--assembly", "memory", "--world", "-"],
      ["plan", "--assembly", "memory", "--world", "-", "--target", "m5"],
    ]) {
      const child = runCli(args);
      expect(child.status).toBe(EXIT_USAGE);
      expect(child.stdout).toBe("");
      expect(child.stderr).toContain("usage:");
    }
  });
});

describe("§3.2 — one table, consulted by the one entrypoint", () => {
  it("the exit-codes module is the only place a status number is chosen", () => {
    // The entrypoint maps the outcome through exitCodeFor and nothing else:
    // reading its source, every status decision routes through the module
    // this suite pins above.
    const entry = readFileSync(new URL("../../src/cli/index.ts", import.meta.url), "utf8");
    expect(entry).toContain("exitCodeFor(outcome)");
    expect(entry).toContain("EXIT_USAGE");
    expect(entry).toContain("EXIT_FAULT");
  });
});
