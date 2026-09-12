/**
 * The Release-PR live-legs harness's own pins (issue #202; decision-log D80).
 * The harness (`e2e/release-pr-e2e.mjs`) drives the six gate legs against the
 * real target when the coordinator executes it; this suite pins the harness's
 * testable half so the live run inherits pins, not hopes: the leg plan's
 * safety gating (the mutation posture, the token refusal, the subset rules),
 * the argv protocol, the per-leg outcome assertions (a leg may not bless an
 * outcome it did not declare), the evidence serialization's token redaction,
 * the transport child's classified-failure contract, and the
 * world→plan→identity chain over a real temporary repository. The mutant
 * proof rides the create leg's draft pin — the harness's own safety law —
 * and is recorded in the decision-log row.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import {
  MUTATING_LEGS,
  LEG_NAMES,
  TRANSPORT_CHILD,
  closeWorld,
  computePlan,
  deriveIdentity,
  helpText,
  judgeLeg,
  judgeStillResolves,
  loadWorld,
  originOwnerRepo,
  parseArgv,
  readWorldDocument,
  requirePendingRelease,
  resolveLegPlan,
  serializeEvidenceLine,
} from "../e2e/release-pr-e2e.mjs";
import { createTempRepo, type TempRepo } from "./adapters/git/temp-repo.js";
import type { ReleasePRIdentity, ReleasePROutcome } from "@ecoma-io/release-craft/app";
import type { PlanningInput, ReleasePlan } from "@ecoma-io/release-craft/planner";

/** Casts a minimal literal onto the gate's outcome union — the judging is
 * structural over the fields the harness reads, and the fixtures below carry
 * exactly those. */
const asOutcome = (value: object): ReleasePROutcome => value as unknown as ReleasePROutcome;

const asPlan = (value: object): ReleasePlan => value as unknown as ReleasePlan;

/** Casts a partial world literal onto the closed-world document — the
 * identity pins read only the lines and the components. */
const asWorld = (value: object): PlanningInput => value as unknown as PlanningInput;

const identity: ReleasePRIdentity = {
  component: "@ecoma-io/release-craft",
  releaseLine: "main",
  targetBranch: "main",
};

const existingPR = (number: number, draft = true) => ({
  number,
  title: "the title",
  body: "the body",
  headRef: "the-head",
  draft,
  labels: [],
});

/** Narrows a parse to its fault — every argv pin reads the fault's words. */
const faultOf = (parsed: ReturnType<typeof parseArgv>): string => {
  if (!("fault" in parsed)) throw new Error("expected a fault parse");
  return parsed.fault;
};

/** Narrows a parse to the run posture — `--help` and faults never reach a
 * pin that reads the legs. */
const runOf = (parsed: ReturnType<typeof parseArgv>): { legs: string[] } => {
  if ("fault" in parsed || parsed.help) {
    throw new Error("expected a run parse");
  }
  return { legs: parsed.legs };
};

/** Narrows a parse to the help posture. */
const helpOf = (parsed: ReturnType<typeof parseArgv>): { help: boolean } => {
  if ("fault" in parsed) throw new Error("expected the help posture");
  return parsed;
};

describe("the leg vocabulary (declared, never guessed)", () => {
  it("names exactly the six campaign legs, in canonical order", () => {
    expect([...LEG_NAMES]).toEqual([
      "detect-empty",
      "create",
      "detect-adopts",
      "update-in-place",
      "tampered-claim-refusal",
      "transport-failure",
    ]);
  });

  it("declares the mutating set as exactly the legs that drive create or update", () => {
    expect([...MUTATING_LEGS]).toEqual(["create", "update-in-place", "tampered-claim-refusal"]);
  });

  it("declares non-empty expected kinds for every leg, and the tamper leg demands the conflict alone", () => {
    for (const leg of LEG_NAMES) {
      const verdict = judgeLeg(leg, asOutcome({ kind: "nothing-pending" }), null);
      expect(verdict.failures[0]).toMatch(/expected outcome kind/);
    }
    // A silent rewrite where the recorded conflict belongs is THE failure the
    // tamper leg exists to catch — the kind pin alone must red it.
    const tampered = judgeLeg(
      "tampered-claim-refusal",
      asOutcome({ kind: "updated", pr: existingPR(7) }),
      7,
    );
    expect(tampered.pass).toBe(false);
    expect(tampered.failures[0]).toContain("expected outcome kind plan-conflict, observed updated");
  });
});

describe("the argv protocol", () => {
  it("prints the help posture and runs nothing", () => {
    expect(helpOf(parseArgv(["--help"])).help).toBe(true);
  });

  it("refuses a run without an evidence path — unnamed evidence is unreadable evidence", () => {
    expect(faultOf(parseArgv([]))).toContain("--evidence <path> is required");
  });

  it("refuses unknown legs and unknown flags, naming the protocol", () => {
    expect(faultOf(parseArgv(["--evidence", "e.jsonl", "--legs", "no-such-leg"]))).toContain(
      'unknown leg "no-such-leg"',
    );
    expect(faultOf(parseArgv(["--evidence", "e.jsonl", "--wat"]))).toContain(
      'unexpected argument "--wat"',
    );
  });

  it("demands the tamper posture be declared for the tamper leg", () => {
    expect(
      faultOf(parseArgv(["--evidence", "e.jsonl", "--legs", "tampered-claim-refusal"])),
    ).toContain("--expect-tampered");
  });

  it("canonicalizes a subset into the canonical order", () => {
    const parsed = parseArgv([
      "--evidence",
      "e.jsonl",
      "--legs",
      "transport-failure,create,detect-empty",
    ]);
    expect(runOf(parsed).legs).toEqual(["detect-empty", "create", "transport-failure"]);
  });

  it("carries the caller-closed world path and defaults it to the self-dogfood closure", () => {
    const withWorld = parseArgv([
      "--evidence",
      "e.jsonl",
      "--world",
      "/tmp/world.json",
      "--legs",
      "detect-empty",
    ]);
    if ("fault" in withWorld || withWorld.help) throw new Error("expected a run parse");
    expect(withWorld.world).toBe("/tmp/world.json");
    const withoutWorld = parseArgv(["--evidence", "e.jsonl", "--legs", "detect-empty"]);
    if ("fault" in withoutWorld || withoutWorld.help) throw new Error("expected a run parse");
    expect(withoutWorld.world).toBeUndefined();
  });

  it("refuses a --world that demands a value, by name", () => {
    expect(faultOf(parseArgv(["--evidence", "e.jsonl", "--world"]))).toContain(
      "--world demands a value",
    );
  });
});

describe("the caller-closed world document (--world, the foreign-consumer posture D83)", () => {
  it("reads a well-formed world document verbatim — the harness never authors a world", () => {
    const fixture: TempRepo = createTempRepo();
    try {
      const document = {
        policy: { digest: "pin-world-policy-1" },
        repository: { commits: [], refs: [] },
        history: { tags: [] },
        lines: [{ id: "main", feedRef: "refs/heads/main", lifecycle: "active", declared: true }],
        components: [
          { name: "foreign-consumer", manifestVersion: "1.2.3", paths: ["package.json"] },
        ],
      };
      const path = `${fixture.repo}/world.json`;
      writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
      const world = readWorldDocument(path);
      expect(world.components).toHaveLength(1);
      expect(world.components?.[0]?.name).toBe("foreign-consumer");
      // The identity derivation runs over the caller's document unchanged.
      expect(deriveIdentity(world)).toEqual({
        component: "foreign-consumer",
        releaseLine: "main",
        targetBranch: "main",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses a document that is not JSON, not an object, or declares no lines or components", () => {
    const fixture: TempRepo = createTempRepo();
    try {
      const notJson = `${fixture.repo}/not-json.json`;
      writeFileSync(notJson, "{oops");
      expect(() => readWorldDocument(notJson)).toThrow(/is not JSON/);

      const array = `${fixture.repo}/array.json`;
      writeFileSync(array, "[]\n");
      expect(() => readWorldDocument(array)).toThrow(/is not a JSON object/);

      const noLines = `${fixture.repo}/no-lines.json`;
      writeFileSync(noLines, `${JSON.stringify({ components: [] })}\n`);
      expect(() => readWorldDocument(noLines)).toThrow(/declares no lines/);

      const noComponents = `${fixture.repo}/no-components.json`;
      writeFileSync(
        noComponents,
        `${JSON.stringify({ lines: [{ id: "main", feedRef: "refs/heads/main" }] })}\n`,
      );
      expect(() => readWorldDocument(noComponents)).toThrow(/declares no components/);

      expect(() => readWorldDocument(`${fixture.repo}/absent.json`)).toThrow(/could not be read/);
    } finally {
      fixture.cleanup();
    }
  });

  it("selects the caller's document when named and the self-dogfood closure otherwise", () => {
    const fixture: TempRepo = createTempRepo();
    try {
      writeFileSync(
        `${fixture.repo}/package.json`,
        `${JSON.stringify({ name: "fixture", version: "0.1.0" })}\n`,
      );
      fixture.git(["add", "package.json"]);
      fixture.git(["commit", "-m", "fix: a defect worth a birth release"]);
      fixture.git(["branch", "-M", "main"]);

      // No --world: the closure observes the named repository (the
      // self-dogfood posture, D80's law unchanged).
      const closed = loadWorld(fixture.repo, undefined);
      expect(closed.components?.[0]?.name).toBe("@ecoma-io/release-craft");

      // --world: the caller's document is read, the closure never spawns.
      const document = {
        policy: { digest: "pin-load-world-policy-1" },
        repository: { commits: [], refs: [] },
        history: { tags: [] },
        lines: [{ id: "main", feedRef: "refs/heads/main", lifecycle: "active", declared: true }],
        components: [{ name: "declared-consumer", manifestVersion: "0.2.0", paths: [] }],
      };
      const path = `${fixture.repo}/world.json`;
      writeFileSync(path, `${JSON.stringify(document)}\n`);
      expect(loadWorld(fixture.repo, path).components?.[0]?.name).toBe("declared-consumer");
    } finally {
      fixture.cleanup();
    }
  });
});

describe("the leg plan's safety gating", () => {
  it("runs every leg under the full posture", () => {
    const resolved = resolveLegPlan([...LEG_NAMES], { mutate: true, hasToken: true });
    expect(resolved.fault).toBeNull();
    expect(resolved.plan.every((entry) => entry.run)).toBe(true);
  });

  it("skips the mutating legs, by name, without the mutation posture — the default is safe", () => {
    const resolved = resolveLegPlan([...LEG_NAMES], { mutate: false, hasToken: true });
    expect(resolved.fault).toBeNull();
    const skipped = resolved.plan.filter((entry) => !entry.run);
    expect(skipped.map((entry) => entry.leg)).toEqual([
      "create",
      "update-in-place",
      "tampered-claim-refusal",
    ]);
    expect(skipped[0]?.reason).toContain("RELEASE_PR_E2E_MUTATE=1");
    // The read-only legs still run.
    expect(resolved.plan.filter((entry) => entry.run).map((entry) => entry.leg)).toEqual([
      "detect-empty",
      "detect-adopts",
      "transport-failure",
    ]);
  });

  it("refuses a mutating leg that cannot authenticate — loud, named", () => {
    const resolved = resolveLegPlan(["create"], { mutate: true, hasToken: false });
    expect(resolved.fault).toContain(
      'the mutating leg "create" demands RELEASE_CRAFT_GITHUB_TOKEN',
    );
  });

  it("refuses the adoption and in-place legs without the same run's create", () => {
    for (const leg of ["detect-adopts", "update-in-place"]) {
      const resolved = resolveLegPlan([leg], { mutate: true, hasToken: true });
      expect(resolved.fault).toContain(`the leg "${leg}" pins the number`);
    }
  });
});

describe("the per-leg outcome assertions", () => {
  it("pins the created PR as a DRAFT with a positive number — the harness's own safety law", () => {
    const draft = judgeLeg(
      "create",
      asOutcome({ kind: "created", pr: existingPR(11, true) }),
      null,
    );
    expect(draft.pass).toBe(true);
    expect(draft.prNumber).toBe(11);

    const ready = judgeLeg(
      "create",
      asOutcome({ kind: "created", pr: existingPR(11, false) }),
      null,
    );
    expect(ready.pass).toBe(false);
    expect(ready.failures.join(" ")).toContain("is not a draft");
  });

  it("pins adoption and in-place update to the number the same run created", () => {
    const adopted = judgeLeg("detect-adopts", asOutcome({ kind: "found", pr: existingPR(11) }), 11);
    expect(adopted.pass).toBe(true);
    const drifted = judgeLeg("detect-adopts", asOutcome({ kind: "found", pr: existingPR(12) }), 11);
    expect(drifted.pass).toBe(false);
    expect(drifted.failures[0]).toContain(
      "must resolve the number the same run created (11), observed 12",
    );

    const current = judgeLeg(
      "update-in-place",
      asOutcome({ kind: "current", pr: existingPR(11) }),
      11,
    );
    expect(current.pass).toBe(true);
    const rewrittenElsewhere = judgeLeg(
      "update-in-place",
      asOutcome({ kind: "updated", pr: existingPR(13) }),
      11,
    );
    expect(rewrittenElsewhere.pass).toBe(false);
  });

  it("lets detect-empty fail loudly on a dirty slate — an existing claim turns it found", () => {
    const dirty = judgeLeg("detect-empty", asOutcome({ kind: "found", pr: existingPR(11) }), null);
    expect(dirty.pass).toBe(false);
    expect(dirty.failures[0]).toContain("expected outcome kind detected, observed found");
  });

  it("pins the recorded conflict's own words — a refusal without words is a shrug", () => {
    const wordless = judgeLeg(
      "tampered-claim-refusal",
      asOutcome({
        kind: "plan-conflict",
        recordedPlanId: null,
        recomputedPlanId: "p2",
        pr: existingPR(11),
      }),
      11,
    );
    expect(wordless.pass).toBe(false);
    expect(wordless.failures[0]).toContain("names no detail");
    const spoken = judgeLeg(
      "tampered-claim-refusal",
      asOutcome({ kind: "plan-conflict", detail: "the body has drifted", pr: existingPR(11) }),
      11,
    );
    expect(spoken.pass).toBe(true);
  });

  it("pins the still-resolves follow-up of the in-place leg", () => {
    const resolves = judgeStillResolves(asOutcome({ kind: "found", pr: existingPR(11) }), 11);
    expect(resolves.pass).toBe(true);
    const vanished = judgeStillResolves(asOutcome({ kind: "detected" }), 11);
    expect(vanished.pass).toBe(false);
    expect(vanished.failures[0]).toContain("still resolve as found, observed detected");
    const otherPR = judgeStillResolves(asOutcome({ kind: "found", pr: existingPR(12) }), 11);
    expect(otherPR.pass).toBe(false);
  });
});

describe("the evidence serialization's token redaction", () => {
  const line = {
    timestamp: "2026-09-12T00:00:00.000Z",
    leg: "create",
    run: true,
    reason: null,
    argv: ["--evidence", "e.jsonl", "--token", "t0k3n"],
    expected: ["created"],
    observed: { kind: "created", prNumber: 11, failures: [] },
    sinkTail: [{ kind: "gate-outcome", identity: { token: "t0k3n" } }],
  };

  it("redacts the token wherever it appears in the line — argv, sink tail, anywhere", () => {
    const serialized = serializeEvidenceLine(line, "t0k3n");
    expect(serialized).not.toContain("t0k3n");
    expect(serialized).toContain("[redacted]");
    expect(serialized.endsWith("\n")).toBe(true);
  });

  it("writes the line unchanged when no real token exists", () => {
    const serialized = serializeEvidenceLine(line, undefined);
    expect(serialized).toContain("t0k3n");
    expect(serialized).not.toContain("[redacted]");
  });
});

describe("the origin parse", () => {
  it("reads https and ssh GitHub URLs, with or without the .git suffix", () => {
    expect(originOwnerRepo("https://github.com/ecoma-io/release-craft.git")).toEqual({
      owner: "ecoma-io",
      repo: "release-craft",
    });
    expect(originOwnerRepo("https://github.com/ecoma-io/release-craft")).toEqual({
      owner: "ecoma-io",
      repo: "release-craft",
    });
    expect(originOwnerRepo("git@github.com:ecoma-io/release-craft.git")).toEqual({
      owner: "ecoma-io",
      repo: "release-craft",
    });
  });

  it("refuses a non-GitHub origin — the harness is the org's dogfood, not a general client", () => {
    expect(originOwnerRepo("https://gitlab.com/ecoma-io/release-craft.git")).toBeNull();
  });
});

describe("the transport child's classified-failure contract", () => {
  it("answers the classified status 0 — never a throw — when the socket refuses", () => {
    // A port the kernel just released: nothing listens on it, so the child's
    // own fetch rejects — the exact failure class the classification folds
    // into the adapter's retryable status 0. Hermetic: no network leaves the
    // process.
    const server = createServer();
    const port = new Promise<number>((resolve) => {
      server.once("listening", () => {
        resolve((server.address() as AddressInfo).port);
      });
    });
    server.listen(0, "127.0.0.1");
    const closedPort = port.then((value) => {
      server.close();
      return value;
    });

    return closedPort.then((value) => {
      const child = spawnSync(process.execPath, ["--input-type=commonjs", "-e", TRANSPORT_CHILD], {
        input: JSON.stringify({
          url: `http://127.0.0.1:${String(value)}/repos/x/y/pulls?state=open&per_page=100`,
          method: "GET",
          headers: { authorization: "Bearer t" },
          body: undefined,
        }),
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      const answer = JSON.parse(child.stdout) as { status: number; headers: object; body: string };
      expect(answer.status).toBe(0);
      expect(answer.headers).toEqual({});
      expect(answer.body.length).toBeGreaterThan(0);
    });
  });
});

describe("the world → plan → identity chain (a real temporary repository)", () => {
  it("closes, plans the birth release, and derives the identity — loudly on every tier", () => {
    const fixture: TempRepo = createTempRepo();
    try {
      writeFileSync(
        `${fixture.repo}/package.json`,
        `${JSON.stringify({ name: "fixture", version: "0.1.0" })}\n`,
      );
      fixture.git(["add", "package.json"]);
      fixture.git(["commit", "-m", "fix: a defect worth a birth release"]);
      fixture.git(["branch", "-M", "main"]); // the closure reads the line's feed ref
      const world = closeWorld(fixture.repo);
      const plan = computePlan(world);
      const derived = deriveIdentity(world);
      expect(derived).toEqual({
        component: "@ecoma-io/release-craft",
        releaseLine: "main",
        targetBranch: "main",
      });
      expect(plan.lines).toHaveLength(1);
      expect(plan.lines[0]?.lineId).toBe("main");
      expect(plan.lines[0]?.stable?.version).toBe("0.1.0");
      expect(() => {
        requirePendingRelease(plan, derived);
      }).not.toThrow();
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses a plan that renders nothing pending — a vacuous world cannot run the legs", () => {
    expect(() => {
      requirePendingRelease(asPlan({ lines: [] }), identity);
    }).toThrow(/plans no pending release/);
  });

  it("refuses a multi-component world — the identity is never guessed", () => {
    expect(() =>
      deriveIdentity(
        asWorld({
          lines: [{ id: "main", feedRef: "refs/heads/main", lifecycle: "active", declared: true }],
          components: [
            { name: "a", manifestVersion: "0.1.0", paths: [] },
            { name: "b", manifestVersion: "0.1.0", paths: [] },
          ],
        }),
      ),
    ).toThrow(/declares 2 components/);
  });

  it("refuses a line whose feed ref does not name a branch", () => {
    expect(() =>
      deriveIdentity(
        asWorld({
          lines: [{ id: "main", feedRef: "refs/tags/main", lifecycle: "active", declared: true }],
          components: [{ name: "a", manifestVersion: "0.1.0", paths: [] }],
        }),
      ),
    ).toThrow(/does not name a branch/);
  });
});

describe("the help", () => {
  it("documents the two-run sequence, the mutation posture, and the token law", () => {
    expect(helpText).toContain("RELEASE_PR_E2E_MUTATE=1");
    expect(helpText).toContain("RELEASE_CRAFT_GITHUB_TOKEN");
    expect(helpText).toContain("--expect-tampered");
    expect(helpText).toContain("gh pr edit");
    expect(helpText).toContain("NEVER merges the Release PR and NEVER pushes branches");
  });

  it("documents the caller-closed world flag and the closure instrument it pairs with", () => {
    expect(helpText).toContain("--world <path>");
    expect(helpText).toContain("the caller closes the world, the engine");
    expect(helpText).toContain("e2e/shadow/close-window-world.mjs");
  });
});
