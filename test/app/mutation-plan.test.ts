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

import type { DeclaredMutation, MutationIntent, PlanLine } from "../../src/index.js";
import { bindMutationsToPlan, plannedVersionBump } from "../../src/index.js";
import { liveWorld } from "../vertical/matrix.js";
import { beta, freshAssembly, runRequest } from "./harness.js";

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
