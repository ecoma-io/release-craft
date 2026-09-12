/**
 * The CLI's modules, in process. The §6 suite drives the built bin because
 * the process surface is the subject — but a child process's coverage never
 * lands in this suite's report, and a parser's refusal is typed state (the
 * thrown `UsageFault`, the parsed invocation's fields) that only exists in
 * process. These fixtures pin the closed grammar's accepted spellings as
 * typed invocations, every negative as the UsageFault it throws, the
 * intents overlay's never-merged law, the §2.5 target derivation's
 * last-occurrence tie-break, the §2.3 naming's filter semantics, the §2.4
 * structural check's rejections, and the two factories `selection.ts` may
 * build.
 */

import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { InvalidAssemblyConfigError } from "../../src/index.js";
import { overlayIntents, parseIntents } from "@ecoma-io/release-craft/__internal__/cli/intents.js";
import { declaredTagNaming } from "@ecoma-io/release-craft/__internal__/cli/naming.js";
import { parseArgv, UsageFault } from "@ecoma-io/release-craft/__internal__/cli/parse.js";
import { selectEngine } from "@ecoma-io/release-craft/__internal__/cli/selection.js";
import { deriveTargets } from "@ecoma-io/release-craft/__internal__/cli/targets.js";
import { readWorldDocument } from "@ecoma-io/release-craft/__internal__/cli/world.js";
import type { PlanningInput } from "../../src/index.js";
import { betaIntent, memoryDoc, withTempDir } from "./harness.js";

/** Runs `fn` and returns what it threw — `null` when it returned. The
 * tests assert on the result directly, so the assertions stay in the
 * test bodies where the vitest rules (and the reader) can see them. */
const caught = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

const faultMessage = (thrown: unknown): string => (thrown as UsageFault).message;

describe("parse — the accepted spellings, as typed invocations", () => {
  it("plan: the world, the intents in order, the memory selection, the json spelling", () => {
    const invocation = parseArgv([
      "plan",
      "--assembly",
      "memory",
      "--world",
      "-",
      "--json",
      "--intent",
      "release",
      "--intent",
      "prerelease:beta:main",
      "--max-retries",
      "2",
    ]);
    expect(invocation).toStrictEqual({
      command: "plan",
      world: "-",
      intents: [{ kind: "release" }, { kind: "prerelease", stream: "beta", lineId: "main" }],
      selection: { assembly: "memory", maxRetries: 2 },
      json: true,
    });
  });

  it("run over git: repo, namespace roots in order, no --json, zero retries by default", () => {
    const invocation = parseArgv([
      "run",
      "--assembly",
      "git",
      "--repo",
      "/tmp/somewhere",
      "--tag-namespace",
      "v",
      "--tag-namespace",
      "rc",
      "--world",
      "world.json",
      "--actor",
      "automation",
      "--line",
      "main",
    ]);
    expect(invocation).toStrictEqual({
      command: "run",
      world: "world.json",
      actor: "automation",
      line: "main",
      intents: [],
      selection: {
        assembly: "git",
        repo: "/tmp/somewhere",
        tagNamespaces: ["v", "rc"],
        maxRetries: 0,
      },
      json: false,
    });
  });

  it("an inline `=` value is one spelling of the same flag", () => {
    const invocation = parseArgv(["plan", "--assembly=memory", "--world=-", "--max-retries=1"]);
    expect(invocation).toMatchObject({ world: "-", selection: { maxRetries: 1 } });
  });

  it("resume: --line is optional and null when absent", () => {
    const base = [
      "resume",
      "--assembly",
      "memory",
      "--world",
      "-",
      "--actor",
      "operator",
      "--plan",
      "p",
      "--attempt",
      "a",
    ];
    expect(parseArgv(base)).toMatchObject({ command: "resume", line: null });
    expect(parseArgv([...base, "--line", "main"])).toMatchObject({
      command: "resume",
      line: "main",
    });
  });

  it("resolve: the two exclusive resolution spellings", () => {
    const base = [
      "resolve",
      "--assembly",
      "memory",
      "--actor",
      "operator",
      "--plan",
      "p",
      "--attempt",
      "a",
      "--step",
      "validate",
    ];
    expect(parseArgv([...base, "--resolution", "human", "--note", "fine"])).toMatchObject({
      command: "resolve",
      stepKey: "validate",
      resolution: { kind: "human", note: "fine" },
    });
    expect(
      parseArgv([...base, "--resolution", "revalidation", "--plan-fingerprint", "fp"]),
    ).toMatchObject({
      resolution: { kind: "revalidation", planFingerprint: "fp" },
    });
  });

  it("abort: the demanded reason is carried verbatim", () => {
    expect(
      parseArgv([
        "abort",
        "--assembly",
        "memory",
        "--actor",
        "operator",
        "--plan",
        "p",
        "--attempt",
        "a",
        "--reason",
        "stood down",
      ]),
    ).toStrictEqual({
      command: "abort",
      planId: "p",
      attemptId: "a",
      actor: "operator",
      reason: "stood down",
      selection: { assembly: "memory", maxRetries: 0 },
      json: false,
    });
  });

  it("show: attempt builds the handle query; channels builds the channels query", () => {
    const attempt = parseArgv([
      "show",
      "attempt",
      "--assembly",
      "git",
      "--repo",
      "/r",
      "--tag-namespace",
      "",
      "--plan",
      "p",
      "--attempt",
      "a",
      "--actor",
      "x",
      "--json",
    ]);
    expect(attempt).toStrictEqual({
      command: "show",
      query: { kind: "attempt", handle: { planId: "p", attemptId: "a", actor: "x" } },
      selection: { assembly: "git", repo: "/r", tagNamespaces: [""], maxRetries: 0 },
      json: true,
    });
    expect(parseArgv(["show", "channels", "--assembly", "memory"])).toStrictEqual({
      command: "show",
      query: { kind: "channels" },
      selection: { assembly: "memory", maxRetries: 0 },
      json: false,
    });
  });
});

describe("parse — every refusal is a UsageFault naming its cause", () => {
  /** One case of the negative inventory: the argv and the cause its
   * UsageFault must name. */
  interface Case {
    readonly argv: readonly string[];
    readonly fragment: string;
  }
  const negative = (argv: readonly string[], fragment: string): Case => ({ argv, fragment });

  /** Runs every case's parse and returns what each threw, in order —
   * the assertions stay in the test bodies below. */
  const refusalsOf = (cases: readonly Case[]): readonly unknown[] =>
    cases.map(({ argv }) => caught(() => parseArgv(argv)));

  it("no command, an unknown command, an unknown flag, an unexpected positional", () => {
    const cases = [
      negative([], "no command given"),
      negative(["release"], 'unknown command "release"'),
      negative(["plan", "--bogus", "x"], "unknown flag --bogus"),
      negative(
        ["run", "--assembly", "memory", "--world", "-", "--actor", "a", "--line", "main", "extra"],
        'unexpected positional "extra"',
      ),
    ];
    const verdicts = refusalsOf(cases);
    const messages = verdicts.map(faultMessage);
    expect(verdicts.every((thrown) => thrown instanceof UsageFault)).toBe(true);
    cases.forEach(({ fragment }, index) => {
      expect(messages[index]).toContain(fragment);
    });
  });

  it("a demanded flag missing, an empty value, a declared-twice flag, a valued boolean, a dangling value", () => {
    const cases = [
      negative(["plan", "--world", "-"], "missing --assembly"),
      negative(
        ["run", "--assembly", "memory", "--world", "-", "--actor", "", "--line", "main"],
        "flag --actor refuses the empty string as a value",
      ),
      negative(
        ["plan", "--assembly", "memory", "--world", "-", "--world", "-"],
        "flag --world is declared once",
      ),
      negative(
        ["plan", "--assembly", "memory", "--world", "-", "--json=true"],
        "flag --json takes no value",
      ),
      negative(["plan", "--assembly", "memory", "--world"], "flag --world demands a value"),
      negative(
        ["plan", "--assembly", "memory", "--world", ""],
        "flag --world refuses the empty string as a value",
      ),
    ];
    const verdicts = refusalsOf(cases);
    const messages = verdicts.map(faultMessage);
    expect(verdicts.every((thrown) => thrown instanceof UsageFault)).toBe(true);
    cases.forEach(({ fragment }, index) => {
      expect(messages[index]).toContain(fragment);
    });
  });

  it("the assembly's flag partition: memory refuses git-only flags, git demands them, the value is closed", () => {
    const cases = [
      negative(
        ["plan", "--assembly", "memory", "--world", "-", "--repo", "/r"],
        "--repo feeds the git assembly only",
      ),
      negative(
        ["plan", "--assembly", "memory", "--world", "-", "--tag-namespace", "v"],
        "--tag-namespace feeds the git assembly only",
      ),
      negative(["plan", "--assembly", "git", "--world", "-"], "missing --repo"),
      negative(
        ["plan", "--assembly", "git", "--world", "-", "--repo", "/r"],
        "missing --tag-namespace",
      ),
      negative(["plan", "--assembly", "redis", "--world", "-"], "--assembly must be memory | git"),
    ];
    const verdicts = refusalsOf(cases);
    const messages = verdicts.map(faultMessage);
    expect(verdicts.every((thrown) => thrown instanceof UsageFault)).toBe(true);
    cases.forEach(({ fragment }, index) => {
      expect(messages[index]).toContain(fragment);
    });
  });

  it("--max-retries demands a safe integer literal", () => {
    const cases = ["abc", "1.5", "1e3", "0x10", "Infinity", "9007199254740993"].map((bad) =>
      negative(
        ["plan", "--assembly", "memory", "--world", "-", "--max-retries", bad],
        `--max-retries "${bad}" is not an integer`,
      ),
    );
    const verdicts = refusalsOf(cases);
    const messages = verdicts.map(faultMessage);
    expect(verdicts.every((thrown) => thrown instanceof UsageFault)).toBe(true);
    cases.forEach(({ fragment }, index) => {
      expect(messages[index]).toContain(fragment);
    });
  });

  it("resolve's pairing and show's positionals", () => {
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
    const cases = [
      negative([...base, "--resolution", "vibes"], "must be human | revalidation"),
      negative(
        [...base, "--resolution", "human", "--note", "n", "--plan-fingerprint", "fp"],
        "--plan-fingerprint feeds the revalidation spelling only",
      ),
      negative(
        [...base, "--resolution", "revalidation", "--plan-fingerprint", "fp", "--note", "n"],
        "--note feeds the human spelling only",
      ),
      negative(["show", "--assembly", "memory"], "attempt | channels"),
      negative(
        ["show", "channels", "--assembly", "memory", "--actor", "op"],
        "--actor names an attempt's holder",
      ),
      negative(
        ["show", "attempt", "--assembly", "memory", "--plan", "p", "--attempt", "a"],
        "missing --actor",
      ),
    ];
    const verdicts = refusalsOf(cases);
    const messages = verdicts.map(faultMessage);
    expect(verdicts.every((thrown) => thrown instanceof UsageFault)).toBe(true);
    cases.forEach(({ fragment }, index) => {
      expect(messages[index]).toContain(fragment);
    });
  });

  it("the empty string is a value only where the grammar declares one: --tag-namespace", () => {
    const refused = caught(() =>
      parseArgv(["plan", "--assembly", "git", "--world", "-", "--repo", "/r"]),
    );
    const everyTag = parseArgv([
      "plan",
      "--assembly",
      "git",
      "--repo",
      "/r",
      "--tag-namespace",
      "",
      "--world",
      "-",
    ]);
    expect(faultMessage(refused)).toContain("missing --tag-namespace");
    expect(everyTag).toMatchObject({
      selection: { assembly: "git", tagNamespaces: [""] },
    });
  });
});

describe("intents — the five spellings and the never-merged overlay", () => {
  it("each declared spelling parses to its intent", () => {
    expect(parseIntents([])).toStrictEqual([]);
    expect(parseIntents(["release", "release-anyway"])).toStrictEqual([
      { kind: "release" },
      { kind: "release-anyway" },
    ]);
    expect(parseIntents(["prerelease:beta:main"])).toStrictEqual([
      { kind: "prerelease", stream: "beta", lineId: "main" },
    ]);
    expect(parseIntents(["release-as:1.2.3"])).toStrictEqual([
      { kind: "release-as", version: "1.2.3" },
    ]);
    expect(parseIntents(["promote:main"])).toStrictEqual([{ kind: "promote", lineId: "main" }]);
  });

  it("a colon-bearing id, an empty segment, and an unknown kind are refused at parse", () => {
    for (const bad of [
      "prerelease:beta:main:extra",
      "promote:main:extra",
      "release-as:1.0.0:extra",
      "release:extra",
      "prerelease:beta:",
      "promote:",
      "deploy",
      "",
    ]) {
      const thrown = caught(() => parseIntents([bad]));
      expect(thrown).toBeInstanceOf(UsageFault);
      expect(faultMessage(thrown)).toContain(`--intent "${bad}" is not an operator intent`);
    }
  });

  it("the overlay: flags win over the document, the document stands alone with no flags, never merged", () => {
    const document = [{ kind: "release" }] as never[];
    const flags = [{ kind: "promote", lineId: "main" }] as never[];
    expect(overlayIntents(document, flags)).toStrictEqual(flags);
    expect(overlayIntents(document, flags)).toHaveLength(1);
    expect(overlayIntents(document, [])).toStrictEqual(document);
  });

  it("the overlay passes absence through — a document that omits intents hands the door undefined, never a fabricated [] (#319)", () => {
    const flags = [{ kind: "promote", lineId: "main" }] as never[];
    expect(overlayIntents(undefined, [])).toBeUndefined();
    expect(overlayIntents(undefined, flags)).toStrictEqual(flags);
  });
});

describe("targets — derived from the document's refs, the last occurrence winning", () => {
  it("each line targets its feedRef's head; the last declaration of a ref wins; unknown feedRefs target nothing", () => {
    const input = {
      repository: {
        refs: [
          { name: "main", head: "stale" },
          { name: "other", head: "c" },
          { name: "main", head: "fresh" },
        ],
      },
      lines: [
        { id: "main", feedRef: "main" },
        { id: "ghost", feedRef: "nope" },
      ],
    } as unknown as PlanningInput;
    expect(deriveTargets(input)).toStrictEqual({ main: "fresh" });
  });

  it("the derivation agrees with the document the §6 fixtures feed the bin", () => {
    const doc = memoryDoc("main", [betaIntent]);
    const targets = deriveTargets(doc);
    for (const line of doc.lines) {
      const head = doc.repository.refs.find((ref) => ref.name === line.feedRef)?.head;
      expect(targets[line.id]).toBe(head);
    }
  });
});

describe("naming — the roots are a filter over the RENDERED tag, which the planner's own renderer produces", () => {
  const prerelease = {
    kind: "prerelease-sequence",
    lineId: "main",
    target: "5.0.0",
    streamId: "beta",
    sequence: 1,
  } as const;
  const stable = { kind: "stable-version", lineId: "main", version: "4.8.7" } as const;
  const prefixed = { main: "v{major}.{minor}.{patch}{prerelease}" };

  it("with no declared format the projection is the bare tag — the planner's undeclared default", () => {
    const naming = declaredTagNaming([""]);
    expect(naming.namespaces).toStrictEqual([""]);
    expect(naming.tagFor(prerelease)).toBe("5.0.0-beta.1");
    expect(naming.tagFor(stable)).toBe("4.8.7");
    expect(naming.tagFor({ kind: "release-line", lineId: "main" })).toBeNull();
  });

  it("a declared format renders through the planner's formatTag — the projection equals the plan's own spelling", () => {
    const everyTag = declaredTagNaming([""], prefixed);
    const vRoot = declaredTagNaming(["v"], prefixed);
    for (const naming of [everyTag, vRoot]) {
      // The prefix comes from the declared format, never from the root:
      // the filter claims or denies the rendered tag, it never renames.
      expect(naming.tagFor(prerelease)).toBe("v5.0.0-beta.1");
      expect(naming.tagFor(stable)).toBe("v4.8.7");
      expect(naming.tagFor({ kind: "release-line", lineId: "main" })).toBeNull();
    }
  });

  it("a root that claims only the bare spelling denies the prefixed scope, and never renames to fit", () => {
    const naming = declaredTagNaming(["5.0.0"], prefixed);
    // The BARE projection would be claimed by "5.0.0"; the RENDERED one
    // ("v5.0.0-beta.1") is not — the denial is the declared answer.
    expect(naming.tagFor(prerelease)).toBeNull();
    expect(naming.tagFor(stable)).toBeNull();
  });

  it("a prefix root claims only its own family and never renames a projection", () => {
    const naming = declaredTagNaming(["4.8"]);
    expect(naming.namespaces).toStrictEqual(["4.8"]);
    expect(naming.tagFor(stable)).toBe("4.8.7");
    expect(
      naming.tagFor({
        kind: "prerelease-sequence",
        lineId: "main",
        target: "5.0.0",
        streamId: "beta",
        sequence: 3,
      }),
    ).toBeNull();
    expect(naming.tagFor({ kind: "release-line", lineId: "main" })).toBeNull();
  });
});

describe("world — the structural check, not a semantic one", () => {
  /** Overwrites the fixture's document with the mutation applied and
   * returns what `readWorldDocument` threw — `null` when it accepted. */
  const rejected = (dir: string, mutate: (document: Record<string, unknown>) => void): unknown => {
    const path = `${dir}/world.json`;
    const doc = memoryDoc("main", [betaIntent]) as unknown as Record<string, unknown>;
    mutate(doc);
    writeFileSync(path, JSON.stringify(doc));
    return caught(() => readWorldDocument(path));
  };

  const firstLine = (document: Record<string, unknown>): Record<string, unknown> =>
    (document.lines as Record<string, unknown>[])[0] as Record<string, unknown>;

  it("a well-formed document parses to the value it declares, from a path", () => {
    withTempDir("world-accept", (dir) => {
      const path = `${dir}/world.json`;
      const doc = memoryDoc("main", [betaIntent]);
      writeFileSync(path, JSON.stringify(doc));
      expect(readWorldDocument(path)).toStrictEqual(doc);
    });
  });

  it("the top level and the four demanded sections are structurally checked", () => {
    withTempDir("world-sections", (dir) => {
      const cases: readonly {
        mutate: (document: Record<string, unknown>) => void;
        at: string;
      }[] = [
        {
          mutate: (document) => {
            document.policy = 5;
          },
          at: "policy must be a JSON object",
        },
        {
          mutate: (document) => {
            (document.policy as Record<string, unknown>).prereleaseSeed = "2";
          },
          at: 'policy.prereleaseSeed must be "0" or "1"',
        },
        {
          mutate: (document) => {
            (document.policy as Record<string, unknown>).tagFormats = { main: 5 };
          },
          at: 'policy.tagFormats["main"] must be a string',
        },
        {
          mutate: (document) => {
            document.repository = {};
          },
          at: "repository.commits must be a JSON array",
        },
        {
          mutate: (document) => {
            (document.repository as Record<string, unknown>).refs = "main";
          },
          at: "repository.refs must be a JSON array",
        },
        {
          mutate: (document) => {
            document.history = { tags: { "5.0.0": "m1" } };
          },
          at: "history.tags must be a JSON array",
        },
        {
          mutate: (document) => {
            document.lines = "main";
          },
          at: "lines must be a JSON array",
        },
        {
          mutate: (document) => {
            document.channels = [{ id: "stable", target: 5 }];
          },
          at: "channels[0].target must be a JSON object",
        },
      ];
      const verdicts = cases.map(({ mutate }) => rejected(dir, mutate));
      expect(verdicts.every((thrown) => thrown instanceof UsageFault)).toBe(true);
      verdicts.forEach((thrown, index) => {
        const at = cases[index]?.at ?? "(no case)";
        expect(faultMessage(thrown)).toContain(
          `${at} — the world document is not PlanningInput-shaped`,
        );
      });
    });
  });

  it("a line's lifecycle, band, streams, withhold and publishes are checked; a wrong intent kind is refused", () => {
    withTempDir("world-lines", (dir) => {
      const cases: readonly {
        mutate: (document: Record<string, unknown>) => void;
        at: string;
      }[] = [
        {
          mutate: (document) => {
            firstLine(document).lifecycle = "zombie";
          },
          at: 'lines[0].lifecycle must be "active" | "frozen" | "retired"',
        },
        {
          mutate: (document) => {
            firstLine(document).versionBand = { major: "5" };
          },
          at: "lines[0].versionBand.major must be a finite number",
        },
        {
          mutate: (document) => {
            firstLine(document).streams = { seed: "2" };
          },
          at: 'lines[0].streams.seed must be "0" or "1"',
        },
        {
          mutate: (document) => {
            firstLine(document).withhold = [{ scope: 5 }];
          },
          at: "lines[0].withhold[0].scope must be a string",
        },
        {
          mutate: (document) => {
            firstLine(document).publishes = 5;
          },
          at: "lines[0].publishes must be a string",
        },
        {
          mutate: (document) => {
            document.intents = [{ kind: "deploy", lineId: "main" }];
          },
          at: 'intents[0].kind is not an operator-intent kind ("deploy")',
        },
      ];
      const verdicts = cases.map(({ mutate }) => rejected(dir, mutate));
      expect(verdicts.every((thrown) => thrown instanceof UsageFault)).toBe(true);
      verdicts.forEach((thrown, index) => {
        const at = cases[index]?.at ?? "(no case)";
        expect(faultMessage(thrown)).toContain(
          `${at} — the world document is not PlanningInput-shaped`,
        );
      });
    });
  });

  it("invalid JSON and an unreadable location are usage, not faults", () => {
    withTempDir("world-broken", (dir) => {
      const path = `${dir}/broken.json`;
      writeFileSync(path, "{not json");
      const notJson = caught(() => readWorldDocument(path));
      expect(notJson).toBeInstanceOf(UsageFault);
      expect(faultMessage(notJson)).toContain("the world document is not valid JSON");
    });
    const missing = caught(() => readWorldDocument("/nonexistent/world.json"));
    expect(missing).toBeInstanceOf(UsageFault);
    expect(faultMessage(missing)).toBe(
      'the world document at "/nonexistent/world.json" could not be read',
    );
  });
});

describe("selection — the two factories and nothing else", () => {
  const DOORS = ["plan", "run", "resume", "resolve", "abort", "observe"] as const;

  it("memory builds an engine carrying every Engine door", () => {
    const engine = selectEngine({ assembly: "memory", maxRetries: 0 });
    for (const door of DOORS) {
      expect(typeof engine[door]).toBe("function");
    }
  });

  it("a negative retry bound is the assembly's own structural refusal — a fault, not an outcome", () => {
    expect(() => selectEngine({ assembly: "memory", maxRetries: -1 })).toThrow(
      InvalidAssemblyConfigError,
    );
  });

  it("git builds its binding lazily — construction opens nothing", () => {
    const engine = selectEngine({
      assembly: "git",
      repo: "/nonexistent/repository",
      tagNamespaces: ["v"],
      maxRetries: 0,
    });
    for (const door of DOORS) {
      expect(typeof engine[door]).toBe("function");
    }
  });
});
