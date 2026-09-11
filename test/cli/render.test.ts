/**
 * The renderers and the rows the process surface cannot reach (§3.1, §3.2).
 * A one-shot CLI process with empty declarations can never return
 * satisfied-externally, resolved, abandoned, blocked, failed, stale, or
 * escalate — those rows need replayed evidence, a blocked loop, or a human
 * abort against a carried attempt. Their exit statuses are pinned in
 * `exit-codes.test.ts` through the exhaustive table; this suite pins their
 * stdout half: the JSON document is the value verbatim, the human text
 * names the kind and its payload, and `exitCodeFor` maps each rendered
 * value to its §3.2 row. The rows the process CAN reach are additionally
 * pinned end-to-end through the built bin, human spelling included.
 */

import { describe, expect, it } from "vitest";

import { exitCodeFor } from "@ecoma-io/release-craft/__internal__/cli/exit-codes.js";
import { renderHuman, renderJson } from "@ecoma-io/release-craft/__internal__/cli/render.js";
import type { Observation, PlanningInput, RunOutcome } from "../../src/index.js";
import { betaIntent, docBytes, memoryDoc, runCli } from "./harness.js";

const HANDLE = {
  planId: "plan_sha256:" + "1".repeat(64),
  attemptId: "attempt_sha256:" + "2".repeat(64),
  actor: "automation",
};

const context = {
  planId: HANDLE.planId,
  handle: HANDLE,
  drives: [
    { stepKey: "commit", outcome: { kind: "advance", record: { stepKey: "commit" } } },
    { stepKey: "publish", outcome: { kind: "blocked", stepKey: "publish", cause: "c" } },
  ],
};

const row = (kind: string, extra: Record<string, unknown> = {}): RunOutcome =>
  ({ kind, ...context, ...extra }) as unknown as RunOutcome;

const stopRows: readonly { readonly kind: string; readonly line: string }[] = [
  { kind: "satisfied-externally", line: "satisfied-externally" },
  { kind: "resolved", line: "resolved" },
  { kind: "abandoned", line: "reason stood down" },
  { kind: "blocked", line: "cause c" },
  { kind: "failed", line: "cause c" },
  { kind: "conflict", line: "detail d" },
  { kind: "ambiguous", line: "detail d" },
  { kind: "stale", line: "detail d" },
  { kind: "escalate", line: "detail d" },
];

describe("§3.1 — the JSON document is the door's value, verbatim", () => {
  it("a rendered document parses back to the exact value", () => {
    const outcome = row("published", { tag: "5.0.0" });
    expect(JSON.parse(renderJson(outcome))).toStrictEqual(outcome);
  });

  it("one document, one trailing newline, nothing else on the line", () => {
    const rendered = renderJson(row("escalate", { detail: "d" }));
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.trimStart().startsWith("{")).toBe(true);
    expect(rendered.split("\n")).toHaveLength(2);
  });
});

describe("§3.1 — the human projection names the kind and the payload", () => {
  it("every stop row's text names its kind and payload, and maps to its §3.2 status", () => {
    const expected: Record<string, number> = {
      "satisfied-externally": 1,
      resolved: 2,
      abandoned: 3,
      blocked: 12,
      failed: 13,
      conflict: 14,
      ambiguous: 15,
      stale: 16,
      escalate: 17,
    };
    for (const spec of stopRows) {
      const outcome =
        spec.kind === "abandoned"
          ? row("abandoned", { reason: "stood down" })
          : spec.kind === "blocked" || spec.kind === "failed"
            ? row(spec.kind, { cause: "c" })
            : spec.kind === "satisfied-externally" || spec.kind === "resolved"
              ? row(spec.kind)
              : row(spec.kind, { detail: "d" });
      const human = renderHuman(outcome);
      expect(human.startsWith(outcome.kind)).toBe(true);
      expect(human).toContain(spec.line);
      // The kind first, the plan and attempt after, the stopping step last.
      const lines = human.trimEnd().split("\n");
      expect(lines[0]).toBe(outcome.kind);
      expect(lines).toContain(`plan ${HANDLE.planId}`);
      expect(lines).toContain(`attempt ${HANDLE.attemptId} (actor automation)`);
      expect(lines[lines.length - 1]).toBe("stopped at publish (blocked)");
      expect(exitCodeFor(outcome)).toBe(expected[spec.kind]);
    }
  });

  it("the observation kinds map to the proceed band and render their reads", () => {
    const attempt: Observation = {
      kind: "attempt",
      handle: HANDLE,
      state: "published",
      claim: null,
      tags: ["5.0.0-beta.1"],
      channels: null,
      tail: [],
      steps: [],
    };
    const human = renderHuman(attempt);
    expect(human).toContain("attempt attempt_sha256:");
    expect(human).toContain("state published");
    expect(human).toContain("claim none");
    expect(human).toContain("tags 5.0.0-beta.1");
    expect(human).toContain("channels not wired");
    expect(exitCodeFor(attempt)).toBe(0);

    const channels: Observation = {
      kind: "channels",
      channels: [
        { id: "stable", target: { line: "main", version: "5.0.0" } },
        { id: "quiet", target: null },
      ],
    };
    const channelsHuman = renderHuman(channels);
    expect(channelsHuman).toContain("stable -> main@5.0.0");
    expect(channelsHuman).toContain("quiet hidden");
    expect(exitCodeFor(channels)).toBe(0);
  });

  it("the refused row renders per union: the planning refusal cites its cause, the observation refusal its detail", () => {
    const planning = renderHuman({
      kind: "refused",
      refusal: {
        kind: "refused",
        cause: "ambiguous-attribution",
        commits: ["m4"],
        policyDigest: "sha256:x",
        detail: "the rewrite is ambiguous",
      },
    });
    expect(planning).toContain("refused");
    expect(planning).toContain("cause ambiguous-attribution");
    expect(exitCodeFor({ kind: "refused", refusal: {} } as never)).toBe(10);

    const observation = renderHuman({ kind: "refused", detail: "no channel store is wired" });
    expect(observation).toContain("detail no channel store is wired");
  });
});

describe("§3.1 — the human spelling through the built bin", () => {
  it("a published run's human text names the kind, the tag, and the attempt", () => {
    const child = runCli(
      ["run", "--assembly", "memory", "--world", "-", "--actor", "automation", "--line", "main"],
      { input: docBytes(memoryDoc("main", [betaIntent])) },
    );
    expect(child.status).toBe(0);
    const lines = child.stdout.split("\n");
    expect(lines[0]).toBe("published");
    expect(lines).toContain("tag 5.0.0-beta.1");
    expect(lines.some((line) => line.startsWith("attempt attempt_sha256:"))).toBe(true);
    expect(child.stderr).toBe("");
  });
});

// ---------------------------------------------------------------------------
// §3.1 as amended (#191) — the plan door's stop-shaped decision records ride
// the human text. A blocked or refused line contributes no plan line (D18),
// so without these rows the door exits 0 and the human text names nothing
// while `--json`'s `decisions[]` carries the operator's next move.
// ---------------------------------------------------------------------------

/** A one-line world whose pending fix demands a bootstrap decision the
 * document does not record (S-02's shape), or whose line is frozen — the
 * two decision records a `planned` outcome can carry with `lines: []`. */
const decisionWorld = (lifecycle: "active" | "frozen"): PlanningInput => ({
  policy: {
    digest: "render-decision-digest",
    bumpMappingId: "default",
    selfReferenceNamespace: "self:",
    prereleaseLadder: ["alpha", "beta", "rc"],
    prereleaseSeed: "1",
    pre10Dampening: true,
    tagFormats: {},
  },
  repository: {
    commits: [
      {
        sha: "r1",
        message: "chore: branch for the line",
        committedAt: "2026-01-01T00:00:00Z",
        parents: [],
        containingRefs: ["main"],
      },
      {
        sha: "r2",
        message: "fix: the first pending fix",
        committedAt: "2026-01-02T00:00:00Z",
        parents: ["r1"],
        containingRefs: ["main"],
      },
    ],
    refs: [{ name: "main", head: "r2" }],
  },
  history: { tags: [] },
  lines: [{ id: "main", feedRef: "main", lifecycle, declared: true }],
  components: [{ name: "app", manifestVersion: "1.0.0", paths: ["package.json"] }],
});

describe("§3.1 — the human projection carries the stop-shaped decision records", () => {
  it("a blocked decision rides its cause and the operator's detail sentence", () => {
    const result = runCli(["plan", "--assembly", "memory", "--world", "-"], {
      input: docBytes(decisionWorld("active")),
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("planned");
    expect(lines).toContain("decision main blocked bootstrap-required");
    expect(lines).toContain(
      "detail the evaluated range starts at line birth, pending changes present, " +
        "and no recorded bootstrap decision — the first version is the operator's call (S-02)",
    );
    // The decision records read last, like the stopping step in runLines.
    expect(lines[lines.length - 1]?.startsWith("detail ")).toBe(true);
  });

  it("a refused decision rides its cause and detail the same way", () => {
    const result = runCli(["plan", "--assembly", "memory", "--world", "-"], {
      input: docBytes(decisionWorld("frozen")),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("decision main refused line-frozen");
    expect(result.stdout).toContain('detail line "main" is frozen');
  });

  it("the machine document is unchanged: --json still renders the value verbatim", () => {
    const result = runCli(["plan", "--assembly", "memory", "--world", "-", "--json"], {
      input: docBytes(decisionWorld("active")),
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(result.stdout) as {
      kind: string;
      decisions: { kind: string; cause: string; detail: string }[];
    };
    expect(parsed.kind).toBe("planned");
    expect(parsed.decisions[0]).toMatchObject({
      kind: "blocked",
      cause: "bootstrap-required",
    });
    expect(parsed.decisions[0]?.detail).toContain("the operator's call (S-02)");
  });
});
