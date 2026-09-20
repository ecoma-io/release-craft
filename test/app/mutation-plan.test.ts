/**
 * Issue #289's middle term: the plan's recorded version is the only
 * authority a plan-bound `version-bump` mutation answers to. The rows
 * pinned here:
 *
 * - the value: `plannedVersionBump` reads the line's stable version, else
 *   its first stream's, else nothing — null over a versionless line;
 * - the bind: a faithful declaration passes, a declared intent whose
 *   produced bytes contradict the plan refuses, a plan-bound declaration
 *   over a versionless line refuses, and a plan-bound id with no intent
 *   to check refuses — while a declaration under any other id stays
 *   host-domain, untouched by the bind;
 * - the walk: the contradiction refuses before the attempt opens — a
 *   refused outcome naming the mutation, never a record.
 *
 * The driver's own corridor (the same id, the same derivation) passes the
 * bind by construction and its vertical suite
 * (`test/app/version-driver.test.ts`) runs it through this same pre-walk —
 * the faithful side of the middle term is proven end-to-end there.
 */
import { describe, expect, it } from "vitest";

import type {
  DeclaredMutation,
  MutationIntent,
  PlanLine,
  RunDeclarations,
} from "../../src/index.js";
import { bindMutationsToPlan, plannedVersionBump, plannedChangelog } from "../../src/index.js";
import { beta, freshAssembly, runRequest } from "./harness.js";
import { liveWorld } from "../vertical/matrix.js";

const lineId = "main";

/** A plan line fixture shorn to the fields the middle term reads — the
 * recorded version shape, not a full assembled line. */
const planLine = (stable: string | null, streams: readonly string[]): PlanLine =>
  ({
    lineId,
    stable: stable === null ? null : { version: stable, tag: `v${stable}` },
    streams: streams.map((version) => ({
      version: { toString: () => version },
      tag: `v${version}`,
    })),
    changes: [],
  }) as unknown as PlanLine;

const versionBump = (id: string): DeclaredMutation => ({
  id,
  anchor: { stage: "commit", position: "before" },
  guard: "release-line",
  postconditions: [],
});

const intentsOf = (
  entries: ReadonlyArray<readonly [string, string]>,
): ReadonlyMap<string, MutationIntent> =>
  new Map(
    entries.map(([id, bytes]) => [
      id,
      { path: "VERSION", produce: () => bytes, expectedDigest: "" },
    ]),
  );

/** The declared `version-bump` mutation whose intent produces `bytes`. */
const bumpDeclaration = (bytes: string) => ({
  mutations: [versionBump("version-bump")],
  mutationIntents: intentsOf([["version-bump", bytes]]),
});

describe("the plan→mutation middle term (issue #289)", () => {
  it("reads the recorded target: stable first, else the first stream — the shared derivation the driver closes over", () => {
    expect(plannedVersionBump(planLine("5.0.0", ["5.0.0"]))?.bytes).toBe("5.0.0\n");
    expect(plannedVersionBump(planLine(null, ["9.9.9"]))?.version).toBe("9.9.9");
    expect(plannedVersionBump(planLine(null, []))).toBeNull();
  });

  it("passes the faithful, refuses the contradiction — the plan decides WHAT", () => {
    const line = planLine("5.0.0-beta.1", ["5.0.0-beta.1"]);
    expect(
      bindMutationsToPlan(
        line,
        [versionBump("version-bump")],
        intentsOf([["version-bump", "5.0.0-beta.1\n"]]),
      ),
    ).toBeNull();

    const refusal = bindMutationsToPlan(
      line,
      [versionBump("version-bump")],
      intentsOf([["version-bump", "9.9.9\n"]]),
    );
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("version-bump");
    expect(refusal).toContain("5.0.0-beta.1");
    expect(refusal).toContain("9.9.9");
    expect(refusal).toContain("issue #289");
  });

  it("refuses the plan-bound id over a versionless line and the missing intent — nothing to bind, nothing to check", () => {
    const noTarget = bindMutationsToPlan(
      planLine(null, []),
      [versionBump("version-bump")],
      intentsOf([["version-bump", "anything\n"]]),
    );
    expect(noTarget).not.toBeNull();
    expect(noTarget).toContain("version-bump");
    expect(noTarget).toContain("no version target");

    const noIntent = bindMutationsToPlan(
      planLine("5.0.0-beta.1", ["5.0.0-beta.1"]),
      [versionBump("version-bump")],
      new Map(),
    );
    expect(noIntent).not.toBeNull();
    expect(noIntent).toContain("no intent");
  });

  it("leaves unbound ids alone — a host's own mutation never answers to the plan", () => {
    expect(
      bindMutationsToPlan(
        planLine("5.0.0-beta.1", ["5.0.0-beta.1"]),
        [versionBump("host-docs")],
        intentsOf([["host-docs", "anything at all"]]),
      ),
    ).toBeNull();
    expect(
      bindMutationsToPlan(planLine("5.0.0-beta.1", ["5.0.0-beta.1"]), undefined, undefined),
    ).toBeNull();
  });

  it("refuses the contradiction before the attempt opens — a refused outcome naming the mutation, never a record", () => {
    const assembly = freshAssembly();
    const outcome = assembly.engine.run(
      runRequest(liveWorld(), lineId, [beta], bumpDeclaration("9.9.9\n")),
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("expected a refused outcome");
    expect(outcome.planId).toBeTruthy();
    expect(outcome.handle).toBeNull();
    expect(outcome.detail).toContain("version-bump");
    expect(outcome.detail).toContain("5.0.0-beta.1");
  });
});

// ---------------------------------------------------------------------------
// Issue #291's changelog-render row: the plan's recorded change set is the
// WHAT of the `changelog-render` mutation — the declaration's produced
// bytes must equal the plan-derived render under the caller's declared
// options, faithful passes, contradiction refuses before the walk opens.
// ---------------------------------------------------------------------------

describe("the changelog-render bind (issue #291)", () => {
  /** A plan line carrying the recorded change words. */
  const changeLine: PlanLine = {
    lineId,
    stable: { version: "5.0.0-beta.1", tag: "v5.0.0-beta.1" },
    streams: [],
    changes: [
      {
        id: "abc1234def5678",
        lineage: ["abc1234def5678"],
        type: "feat",
        subject: "add the bar widget",
        breaking: false,
        bump: "minor",
      },
      {
        id: "chg-fix",
        lineage: ["chg-fix"],
        type: "fix",
        scope: "cli",
        subject: "fix the foo rendering",
        breaking: false,
        bump: "patch",
      },
    ],
  } as unknown as PlanLine;

  const changelogRender = (id: string): DeclaredMutation => ({
    id,
    anchor: { stage: "commit", position: "before" },
    guard: "release-line",
    postconditions: [],
  });

  const renderDeclaration = (bytes: string): RunDeclarations => ({
    mutations: [changelogRender("changelog-render")],
    mutationIntents: intentsOf([["changelog-render", bytes]]),
  });

  it("passes the faithful render — the plan's recorded change set, the caller's declared options", () => {
    const options = { date: "2026-09-20", sections: [{ type: "feat", section: "Features" }] };
    const planned = plannedChangelog(changeLine, options);
    expect(planned).toContain("## 5.0.0-beta.1 (2026-09-20)");
    expect(planned).toContain("* add the bar widget");
    expect(planned).toContain("* **cli:** fix the foo rendering");
    expect(
      bindMutationsToPlan(
        changeLine,
        [changelogRender("changelog-render")],
        intentsOf([["changelog-render", planned]]),
        options,
      ),
    ).toBeNull();
  });

  it("refuses the contradiction — produce not the plan's recorded words", () => {
    const refusal = bindMutationsToPlan(
      changeLine,
      [changelogRender("changelog-render")],
      intentsOf([["changelog-render", "something the plan never recorded\n"]]),
    );
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("changelog-render");
    expect(refusal).toContain("issue #291");
  });

  it("refuses a plan-bound changelog-render with no intent to check", () => {
    const refusal = bindMutationsToPlan(
      changeLine,
      [changelogRender("changelog-render")],
      new Map(),
    );
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("changelog-render");
    expect(refusal).toContain("no intent");
  });

  it("binds under absent options — the plan-derived defaults are the declared bytes", () => {
    const planned = plannedChangelog(changeLine);
    expect(
      bindMutationsToPlan(
        changeLine,
        [changelogRender("changelog-render")],
        intentsOf([["changelog-render", planned]]),
      ),
    ).toBeNull();
  });

  it("refuses the contradiction before the attempt opens — a refused outcome naming the mutation, never a record", () => {
    const assembly = freshAssembly();
    const outcome = assembly.engine.run(
      runRequest(liveWorld(), lineId, [beta], renderDeclaration("the wrong bytes\n")),
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("expected a refused outcome");
    expect(outcome.handle).toBeNull();
    expect(outcome.detail).toContain("changelog-render");
    expect(outcome.detail).toContain("#291");
  });
});
