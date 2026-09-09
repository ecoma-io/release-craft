/**
 * §6 obligation 2's conclusion-table fixture and obligation 4's no-verdict
 * posture (phase 13 contract §3.2, §3.3): one row per `RunOutcome` kind —
 * keyed on the envelope's kind, total over the union, the exit code checked
 * as the kind's integrity pin — driven through the invocation script's whole
 * pipeline as a subprocess.
 *
 * The rows the declarations-less one-shot `run` door cannot produce today
 * (`satisfied-externally`, `resolved`, `abandoned`, and the remaining stop
 * kinds) are driven through the harness's outcome-injection seam: a stand-in
 * bin prints the chosen envelope and exits with the chosen code, so the
 * SCRIPT's rendering — spawn, capture, relay, preserving write, annotate,
 * exit — is the subject, never a backdoor in the product. The rows the door
 * does produce are also driven against the REAL bin over real temp repos.
 *
 * The killed/no-envelope rows are OUTSIDE §3.2's table on purpose (its
 * folded NOTE): a run that renders no verdict gets no verdict — the
 * annotation is the recorded evidence, the step's own conclusion fails the
 * job, and nothing is invented in either direction.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXIT_CODES } from "../../src/cli/exit-codes.js";
import { betaIntent, docBytes, gitDoc, promoteIntent } from "../cli/harness.js";
import {
  ARGV_ECHO_BIN,
  INVOKE_SCRIPT,
  SIGKILL_BIN,
  annotationOf,
  envelopeBinSource,
  replayOutcome,
  runInvoke,
  withActionRepo,
  withScratchDir,
  type InvokeInputs,
} from "./harness.js";

/** The run union's kinds, derived from the compiled exit table: every door
 * kind minus the plan and observation doors' — the twelve rows §3.2's table
 * is total over. */
type RunKind = Exclude<keyof typeof EXIT_CODES, "planned" | "attempt" | "channels">;

const RUN_KINDS = (Object.keys(EXIT_CODES) as (keyof typeof EXIT_CODES)[])
  .filter((kind) => kind !== "planned" && kind !== "attempt" && kind !== "channels")
  .sort() as RunKind[];

/** §3.2's decided table, as the fixture's expectation: the proceed band
 * concludes success (annotating nothing), the stop band concludes failure
 * (the annotation quoting the row's own field verbatim). */
const CONCLUSIONS: Readonly<
  Record<RunKind, { exit: number; conclusion: "success" | "failure"; field: string | null }>
> = {
  published: { exit: 0, conclusion: "success", field: null },
  "satisfied-externally": { exit: 1, conclusion: "success", field: null },
  resolved: { exit: 2, conclusion: "success", field: null },
  abandoned: { exit: 3, conclusion: "success", field: null },
  refused: { exit: 10, conclusion: "failure", field: "detail" },
  denied: { exit: 11, conclusion: "failure", field: "holder" },
  blocked: { exit: 12, conclusion: "failure", field: "cause" },
  failed: { exit: 13, conclusion: "failure", field: "cause" },
  conflict: { exit: 14, conclusion: "failure", field: "detail" },
  ambiguous: { exit: 15, conclusion: "failure", field: "detail" },
  stale: { exit: 16, conclusion: "failure", field: "detail" },
  escalate: { exit: 17, conclusion: "failure", field: "detail" },
};

/** The stop band's quoted field, by kind (null for the proceed rows). */
const FIELDS: Readonly<Record<RunKind, string | null>> = Object.fromEntries(
  Object.entries(CONCLUSIONS).map(([kind, row]) => [kind, row.field]),
) as Readonly<Record<RunKind, string | null>>;

/** The `denied` value the injected envelopes quote. */
const HOLDER = "plan-x:attempt-7";
const DETAIL = "assembles no line";

const envelope = (kind: RunKind): string => {
  const field = FIELDS[kind];
  if (kind === "denied") {
    return JSON.stringify({ kind, holder: HOLDER });
  }
  if (kind === "published") {
    return JSON.stringify({ kind, tag: "5.0.0-beta.1" });
  }
  if (field === null) {
    return JSON.stringify({ kind });
  }
  return JSON.stringify({ kind, [field]: DETAIL });
};

const injectInputs = (bin: string): InvokeInputs => ({
  world: "/unused/world.json",
  line: "main",
  actor: "the-release-author",
  tagNamespaces: "\n",
  bin,
});

/** The default transport inputs for a real drive over an action repo. */
const realInputs = (worldPath: string, overrides: Partial<InvokeInputs> = {}): InvokeInputs => ({
  world: worldPath,
  line: "main",
  actor: "the-release-author",
  tagNamespaces: "\n",
  ...overrides,
});

describe("fixture: the conclusion table is total over the run union", () => {
  it("the twelve run kinds are exactly the table's keys", () => {
    expect(RUN_KINDS).toHaveLength(12);
    expect(Object.keys(CONCLUSIONS).sort()).toStrictEqual(RUN_KINDS);
  });

  it("the script's own table carries every kind, at the compiled exit table's code", () => {
    const script = readFileSync(INVOKE_SCRIPT, "utf8");
    for (const kind of RUN_KINDS) {
      const row = new RegExp(`^  "?${kind}"?: \\{ exit: (\\d+), conclusion: "(\\w+)"`, "m").exec(
        script,
      );
      expect(row, `the script's table has no row for ${kind}`).not.toBeNull();
      expect(Number(row?.[1])).toBe(EXIT_CODES[kind]);
      expect(row?.[2]).toBe(CONCLUSIONS[kind].conclusion);
    }
  });
});

describe("fixture: every kind renders its row through the whole pipeline", () => {
  for (const kind of RUN_KINDS) {
    const expected = CONCLUSIONS[kind];
    it(`${kind}: exit ${String(expected.exit)} → ${expected.conclusion}`, () => {
      withScratchDir((dir) => {
        const bin = join(dir, "envelope-bin.mjs");
        writeFileSync(bin, envelopeBinSource(`${envelope(kind)}\n`, expected.exit));
        const drive = runInvoke(injectInputs(bin));
        // The proceed band annotates nothing; the stop band quotes its
        // field verbatim (`denied` with no holder recorded would quote the
        // kind alone — nothing invented).
        const wantedStatus = expected.conclusion === "success" ? 0 : 1;
        const wantedAnnotation =
          expected.conclusion === "success"
            ? ""
            : `::error::${kind}: ${FIELDS[kind] === "holder" ? HOLDER : DETAIL}`;
        expect(drive.status).toBe(wantedStatus);
        expect(annotationOf(drive.stdout)).toBe(wantedAnnotation);
        // The one output carries the relayed envelope byte-for-byte (§3.1)
        // — the annotation line is the step log's, never the output's.
        const relayed = drive.stdout
          .toString("utf8")
          .split("\n")
          .filter((line) => !line.startsWith("::error::"))
          .join("\n");
        expect(replayOutcome(drive.outputs)).toBe(relayed);
        expect(relayed).toBe(`${envelope(kind)}\n`);
      });
    });
  }

  it("the three non-zero-exit success rows are spelled out — the step conclusion is not the exit code", () => {
    for (const kind of ["satisfied-externally", "resolved", "abandoned"] as const) {
      withScratchDir((dir) => {
        const bin = join(dir, "envelope-bin.mjs");
        writeFileSync(bin, envelopeBinSource(`${envelope(kind)}\n`, EXIT_CODES[kind]));
        const drive = runInvoke(injectInputs(bin));
        expect(EXIT_CODES[kind]).not.toBe(0);
        expect(drive.status).toBe(0);
        expect(annotationOf(drive.stdout)).toBe("");
      });
    }
  });

  it("a multi-line field rides one annotation line — the log protocol's escaping, not truncation", () => {
    withScratchDir((dir) => {
      const bin = join(dir, "envelope-bin.mjs");
      const detail = "first line\nsecond 50% line\rthird";
      writeFileSync(
        bin,
        envelopeBinSource(`${JSON.stringify({ kind: "escalate", detail })}\n`, 17),
      );
      const drive = runInvoke(injectInputs(bin));
      expect(drive.status).toBe(1);
      expect(annotationOf(drive.stdout)).toBe(
        "::error::escalate: first line%0Asecond 50%25 line%0Dthird",
      );
      expect(drive.stdout.toString("utf8")).not.toContain("\nsecond");
    });
  });

  it("a denied envelope with no holder recorded quotes the kind alone", () => {
    withScratchDir((dir) => {
      const bin = join(dir, "envelope-bin.mjs");
      writeFileSync(bin, envelopeBinSource(`${JSON.stringify({ kind: "denied" })}\n`, 11));
      const drive = runInvoke(injectInputs(bin));
      expect(drive.status).toBe(1);
      expect(annotationOf(drive.stdout)).toBe("::error::denied");
    });
  });
});

describe("fixture: the no-verdict rows — a run that renders no verdict gets no verdict", () => {
  it("a kind/exit disagreement is `no verdict: exit N`, never a guessed verdict", () => {
    withScratchDir((dir) => {
      const bin = join(dir, "envelope-bin.mjs");
      writeFileSync(bin, envelopeBinSource(`${envelope("published")}\n`, 7));
      const drive = runInvoke(injectInputs(bin));
      expect(drive.status).toBe(1);
      expect(annotationOf(drive.stdout)).toBe("::error::no verdict: exit 7");
    });
  });

  it("a kind outside the run table (an observation door's kind) is no verdict, not success", () => {
    withScratchDir((dir) => {
      const bin = join(dir, "envelope-bin.mjs");
      writeFileSync(bin, envelopeBinSource(`${JSON.stringify({ kind: "channels" })}\n`, 0));
      const drive = runInvoke(injectInputs(bin));
      expect(drive.status).toBe(1);
      expect(annotationOf(drive.stdout)).toBe("::error::no verdict: exit 0");
    });
  });

  it("stdout that is not an envelope and carries no fault code is `no verdict: exit N`", () => {
    withScratchDir((dir) => {
      const bin = join(dir, "envelope-bin.mjs");
      writeFileSync(bin, envelopeBinSource("not json at all\n", 5));
      const drive = runInvoke(injectInputs(bin));
      expect(drive.status).toBe(1);
      expect(annotationOf(drive.stdout)).toBe("::error::no verdict: exit 5");
      expect(replayOutcome(drive.outputs)).toBe("not json at all\n");
    });
  });

  it("killed by a signal: `no verdict: signal NAME`, the output still written (empty), never green", () => {
    withScratchDir((dir) => {
      const bin = join(dir, "sigkill-bin.mjs");
      writeFileSync(bin, SIGKILL_BIN);
      const drive = runInvoke(injectInputs(bin));
      expect(drive.status).toBe(1);
      expect(annotationOf(drive.stdout)).toBe("::error::no verdict: signal SIGKILL");
      expect(replayOutcome(drive.outputs)).toBe("");
    });
  });

  it("a usage fault whose stderr is somehow empty falls to the no-verdict row, not to an invented verdict", () => {
    withScratchDir((dir) => {
      const bin = join(dir, "silent-fault-bin.mjs");
      writeFileSync(bin, envelopeBinSource("", 64));
      const drive = runInvoke(injectInputs(bin));
      expect(drive.status).toBe(1);
      expect(annotationOf(drive.stdout)).toBe("::error::no verdict: exit 64");
    });
  });
});

describe("fixture: the fault bands quote the first stderr line, verbatim, and leak no synopsis", () => {
  it("the usage band: exit 64 quotes `usage: <message>` only", () => {
    withScratchDir((dir) => {
      const bin = join(dir, "usage-bin.mjs");
      const stderr =
        "usage: flag --actor refuses the empty string as a value\n\nrelease-craft run …\n";
      writeFileSync(
        bin,
        envelopeBinSource("", 64) + `process.stderr.write(${JSON.stringify(stderr)});\n`,
      );
      const drive = runInvoke(injectInputs(bin));
      expect(drive.status).toBe(1);
      expect(annotationOf(drive.stdout)).toBe(
        "::error::usage: flag --actor refuses the empty string as a value",
      );
      // The synopsis is relayed to stderr for the step log, never into the
      // annotation.
      expect(drive.stderr.toString("utf8")).toContain("release-craft run");
      expect(annotationOf(drive.stdout)).not.toContain("release-craft run");
    });
  });

  it("the escaped-throw band: exit 70 quotes the throw's name and message", () => {
    withScratchDir((dir) => {
      const bin = join(dir, "fault-bin.mjs");
      writeFileSync(
        bin,
        envelopeBinSource("", 70) +
          'process.stderr.write("GitFaultError: fatal: cannot lock ref\\n");\n',
      );
      const drive = runInvoke(injectInputs(bin));
      expect(drive.status).toBe(1);
      expect(annotationOf(drive.stdout)).toBe("::error::GitFaultError: fatal: cannot lock ref");
    });
  });
});

describe("fixture: this program's own pre-invocation faults annotate nothing", () => {
  it("a bin that does not exist fails closed — the child's own failure is no verdict, never green", () => {
    // The bin runs under the same node interpreter, so a missing bin file is
    // the CHILD's module-not-found (exit 1, nothing on stdout): the script
    // relays the evidence, renders no verdict, and still fails the step.
    const drive = runInvoke(injectInputs("/no/such/bin.mjs"));
    expect(drive.status).toBe(1);
    expect(annotationOf(drive.stdout)).toBe("::error::no verdict: exit 1");
    expect(drive.stderr.toString("utf8")).toContain("Cannot find module");
    expect(replayOutcome(drive.outputs)).toBe("");
  });

  it("a protocol violation (a missing flag) never reaches the bin", () => {
    const result = spawnSync(process.execPath, [INVOKE_SCRIPT, "--bin", ARGV_ECHO_BIN], {
      encoding: "buffer",
    });
    expect(result.status).toBe(1);
    expect(result.stdout.toString("utf8")).toBe("");
    expect(result.stderr.toString("utf8")).toContain("missing --outputs-file");
  });
});

// ---------------------------------------------------------------------------
// The real rows — the built bin over real temp repositories
// ---------------------------------------------------------------------------

describe("fixture: the real conclusion rows, over real repositories", () => {
  it(
    "published: exit 0, success, no annotation, the tag minted in the caller's copy",
    { timeout: 45_000 },
    () => {
      withActionRepo("action-published", (repo, git, worldPath) => {
        const drive = runInvoke(realInputs(worldPath), { cwd: repo });
        expect(drive.status).toBe(0);
        expect(annotationOf(drive.stdout)).toBe("");
        const outcome = JSON.parse(replayOutcome(drive.outputs)) as {
          kind: string;
          tag: string | null;
          handle: { attemptId: string } | null;
        };
        expect(outcome.kind).toBe("published");
        expect(outcome.tag).toBe("5.0.0-beta.1");
        expect(outcome.handle).not.toBeNull();
        expect(git(["tag", "--list"]).trim()).toBe("5.0.0-beta.1");
      });
    },
  );

  it(
    "refused: exit 10, failure, the detail quoted — a promote on a line with no in-flight prerelease",
    { timeout: 45_000 },
    () => {
      withActionRepo("action-refused", (repo, _git, _worldPath, heads) => {
        const promoteWorld = join(repo, "promote-world.json");
        writeFileSync(promoteWorld, docBytes(gitDoc("main", [promoteIntent], heads)));
        const drive = runInvoke(realInputs(promoteWorld), { cwd: repo });
        expect(drive.status).toBe(1);
        const outcome = JSON.parse(replayOutcome(drive.outputs)) as {
          kind: string;
          detail: string;
        };
        expect(outcome.kind).toBe("refused");
        expect(outcome.detail).toContain("assembles no line");
        expect(annotationOf(drive.stdout)).toBe(`::error::refused: ${outcome.detail}`);
      });
    },
  );

  it(
    "denied: exit 11, failure, the holder quoted — the second stable run on a published line",
    { timeout: 45_000 },
    () => {
      withActionRepo("action-denied", (repo, _git, _worldPath, heads) => {
        const stableWorld = join(repo, "stable-world.json");
        writeFileSync(stableWorld, docBytes(gitDoc("4.8.x", [], heads)));
        const first = runInvoke(realInputs(stableWorld, { line: "4.8.x" }), { cwd: repo });
        expect(first.status).toBe(0);
        const firstOutcome = JSON.parse(replayOutcome(first.outputs)) as {
          kind: string;
          handle: { attemptId: string } | null;
        };
        expect(firstOutcome.kind).toBe("published");
        const second = runInvoke(realInputs(stableWorld, { line: "4.8.x" }), { cwd: repo });
        expect(second.status).toBe(1);
        const secondOutcome = JSON.parse(replayOutcome(second.outputs)) as {
          kind: string;
          holder: string | null;
        };
        expect(secondOutcome.kind).toBe("denied");
        expect(secondOutcome.holder).toBe(firstOutcome.handle?.attemptId ?? null);
        expect(annotationOf(second.stdout)).toBe(
          `::error::denied: ${String(secondOutcome.holder)}`,
        );
      });
    },
  );

  it(
    "conflict: exit 14, failure — the beta ladder twice, the retry bound exhausted",
    { timeout: 45_000 },
    () => {
      withActionRepo("action-conflict", (repo, _git, worldPath) => {
        const first = runInvoke(realInputs(worldPath), { cwd: repo });
        expect(first.status).toBe(0);
        const second = runInvoke(realInputs(worldPath), { cwd: repo });
        expect(second.status).toBe(1);
        const outcome = JSON.parse(replayOutcome(second.outputs)) as {
          kind: string;
          detail: string;
        };
        expect(outcome.kind).toBe("conflict");
        expect(annotationOf(second.stdout)).toBe(`::error::conflict: ${outcome.detail}`);
      });
    },
  );

  it(
    "the usage band, really: an empty actor input is the CLI's exit 64, quoted verbatim — the grammar is the validation",
    { timeout: 45_000 },
    () => {
      withActionRepo("action-usage", (repo, _git, worldPath) => {
        const drive = runInvoke(realInputs(worldPath, { actor: "" }), { cwd: repo });
        expect(drive.status).toBe(1);
        expect(annotationOf(drive.stdout)).toBe(
          "::error::usage: flag --actor refuses the empty string as a value",
        );
        expect(replayOutcome(drive.outputs)).toBe("");
      });
    },
  );

  it(
    "the escaped-throw band, really: a mint target the repository does not hold is exit 70, never a verdict",
    { timeout: 45_000 },
    () => {
      withActionRepo("action-fault", (repo, _git, _worldPath) => {
        const lyingWorld = join(repo, "lying-world.json");
        writeFileSync(lyingWorld, docBytes(gitDoc("main", [betaIntent], { main: "e".repeat(40) })));
        const drive = runInvoke(realInputs(lyingWorld), { cwd: repo });
        expect(drive.status).toBe(1);
        const annotation = annotationOf(drive.stdout);
        expect(annotation.startsWith("::error::GitFaultError: ")).toBe(true);
        expect(replayOutcome(drive.outputs)).toBe("");
      });
    },
  );
});
