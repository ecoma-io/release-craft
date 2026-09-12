/**
 * The adopter page is machine-checked (issue #190). `docs/adopters.md` is
 * the consumer front door, and its examples are not decorative: the world
 * document fenced on the page is extracted and driven through the exact
 * doors an adopter's invocation reaches — the CLI's own world reader
 * (`readWorldDocument`, the module the `--world` value goes through, which
 * the Action's invoke step reaches by passing the path to the built bin)
 * and the planner over the memory assembly (the `plan` door, the same one
 * the page's transcripts show). The page's second JSON block is the
 * operator's first-version record — the two top-level keys the page says to
 * merge in — and the suite composes the page's own bytes exactly as the
 * prose instructs: world document plus the additions, read by the reader,
 * planned by the door. A drift between the page and the engine fails here —
 * a reshaped `PlanningInput`, a reworded refusal, a renamed decision cause,
 * or an Action reference that stopped being a full 40-character SHA — and
 * the fix is the page and the engine changing in the same commit.
 *
 * The transcripts (command output) on the page are not re-executed here —
 * the process surface has its own suites (`test/cli/`,
 * `test/action/invocation.test.ts`). What this file owns from them is the
 * content-derived identity a transcript quotes: every `plan_sha256:` digest
 * on the page is checked against the engine's own computed plan identity
 * over the page's world bytes (the plain plan, the composed plan, and the
 * release-intent plan the `run` door replans), and the run rendering's stop
 * row is checked against the engine's own renderer over the same world —
 * so the transcripts can still stale only word-for-word, never in their
 * digests or their stop row.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AssemblySelection } from "@ecoma-io/release-craft/__internal__/cli/parse.js";
import { renderHuman } from "@ecoma-io/release-craft/__internal__/cli/render.js";
import { selectEngine } from "@ecoma-io/release-craft/__internal__/cli/selection.js";
import { readWorldDocument } from "@ecoma-io/release-craft/__internal__/cli/world.js";
import type { LineDecision, PlanningInput, PlanningOutcome } from "../../src/index.js";

const ADOPTERS_DOC = join(import.meta.dirname, "..", "..", "docs", "adopters.md");

/** The fenced `json` blocks whose parsed shape is PlanningInput — the page
 * also fences one `decisions[]` record as json, which carries no `lines`. */
const worldBlocks = (markdown: string): PlanningInput[] => {
  const matches = [...markdown.matchAll(/```json\n([\s\S]*?)```/g)];
  const worlds: PlanningInput[] = [];
  for (const match of matches) {
    const text = match[1];
    if (text === undefined) {
      continue;
    }
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as Record<string, unknown>).lines)
    ) {
      worlds.push(parsed as PlanningInput);
    }
  }
  return worlds;
};

/** The page's merge-in additions block — a `json` fence carrying the
 * `components` and `bootstrap` keys (the page's one other json fence, a
 * `decisions[]` record, has neither), parsed here so the composed document
 * the adopter ends up with is built from page bytes. */
const additionsBlocks = (markdown: string): Record<string, unknown>[] => {
  const matches = [...markdown.matchAll(/```json\n([\s\S]*?)```/g)];
  const blocks: Record<string, unknown>[] = [];
  for (const match of matches) {
    const text = match[1];
    if (text === undefined) {
      continue;
    }
    const parsed: unknown = JSON.parse(text);
    const record = parsed as Record<string, unknown>;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Array.isArray(record.components) &&
      typeof record.bootstrap === "object" &&
      record.bootstrap !== null
    ) {
      blocks.push(record);
    }
  }
  return blocks;
};

/** The memory assembly the page's plan walkthroughs drive — the
 * zero-persistence bundle, no repository behind it. */
const memory: AssemblySelection = { assembly: "memory", maxRetries: 0 };

const planDocument = (document: PlanningInput): PlanningOutcome =>
  // The document verbatim — the same boundary input the entrypoint hands
  // the engine since #319's fix: absence stays absence, so the digest the
  // page quotes is the plan door's own, never a fabricated-intents variant.
  selectEngine(memory).plan(document);

/** The plan identity a planned outcome carries — the `plan_sha256:` digest
 * the plan door renders and the page's transcripts quote. */
const plannedPlanId = (outcome: PlanningOutcome): string => {
  if (outcome.kind !== "planned") {
    throw new Error(`expected a planned outcome, got "${outcome.kind}"`);
  }
  return outcome.plan.planId;
};

/** Every `plan_sha256:` digest the page quotes, in transcript order — the
 * content-derived plan identities the engine computed on the head the
 * transcripts were captured at. */
const pagePlanDigests = (markdown: string): string[] =>
  [...markdown.matchAll(/plan_sha256:([0-9a-f]{64})/g)]
    .map((match) => match[1])
    .filter((hex): hex is string => hex !== undefined)
    .map((hex) => `plan_sha256:${hex}`);

/** The reader is a filesystem door — the page's example reaches it as a
 * `--world <path>` value, so the test hands it a path too. */
const readThroughWorldReader = (document: PlanningInput): PlanningInput => {
  const dir = mkdtempSync(join(tmpdir(), "release-craft-adopters-"));
  try {
    const path = join(dir, "world.json");
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
    return readWorldDocument(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("docs/adopters.md — the adopter journey's world documents", () => {
  const markdown = readFileSync(ADOPTERS_DOC, "utf8");
  const worlds = worldBlocks(markdown);
  const additions = additionsBlocks(markdown);

  it("carries one world document and one merge-in additions block", () => {
    expect(worlds).toHaveLength(1);
    expect(worlds[0]?.bootstrap).toBeUndefined();
    expect(additions).toHaveLength(1);
    expect(Object.keys(additions[0] ?? {}).sort()).toStrictEqual(["bootstrap", "components"]);
  });

  it("the composed document — the page's world plus the page's additions — passes the CLI's own world reader", () => {
    const composed = { ...(worlds[0] as PlanningInput), ...(additions[0] as object) };
    expect(readThroughWorldReader(composed)).toStrictEqual(composed);
  });

  it("the world document alone plans into the expected bootstrap refusal, quoted verbatim on the page", () => {
    const first = worlds[0];
    expect(first).toBeDefined();
    const outcome = planDocument(first as PlanningInput);
    if (outcome.kind !== "planned") {
      throw new Error(`expected a planned outcome, got "${outcome.kind}"`);
    }
    expect(outcome.plan.lines).toHaveLength(0);
    expect(outcome.decisions).toHaveLength(1);
    const decision = outcome.decisions[0];
    expect(decision).toBeDefined();
    const decisionKind: unknown = decision?.kind;
    if (decisionKind !== "blocked") {
      throw new Error(`expected a blocked decision, got "${String(decisionKind)}"`);
    }
    const blocked: Extract<LineDecision, { readonly kind: "blocked" }> = decision as Extract<
      LineDecision,
      { readonly kind: "blocked" }
    >;
    expect(blocked.cause).toBe("bootstrap-required");
    expect(blocked.lineId).toBe("main");
    expect(blocked.detail).toBe(
      "the evaluated range starts at line birth, pending changes present, and no recorded bootstrap decision — the first version is the operator's call (S-02)",
    );
    // The page's quoted refusal is the engine's own detail string — a
    // planner rewording must reach this page in the same commit.
    expect(markdown).toContain(blocked.detail);
  });

  it("with the additions merged in — bootstrap recorded, component declared — the page's document plans 0.1.0", () => {
    const first = worlds[0];
    const additions = additionsBlocks(markdown)[0];
    expect(first).toBeDefined();
    expect(additions).toBeDefined();
    const composed = { ...(first as PlanningInput), ...(additions as object) };
    const outcome = planDocument(composed);
    if (outcome.kind !== "planned") {
      throw new Error(`expected a planned outcome, got "${outcome.kind}"`);
    }
    const line = outcome.plan.lines[0];
    expect(line?.lineId).toBe("main");
    expect(line?.stable?.version).toBe("0.1.0");
    expect(line?.stable?.tag).toBe("0.1.0");
  });

  it("every plan digest the page quotes is the engine's own computed plan identity over the page's world", () => {
    const first = worlds[0];
    expect(first).toBeDefined();
    const composed = { ...(first as PlanningInput), ...(additions[0] as object) };
    // The three plans the page's transcripts quote identities for: the
    // plain plan over the first document, the plan after the operator's
    // record, and the release-intent plan the `run` door replans under.
    const computed = [
      planDocument(first as PlanningInput),
      planDocument(composed),
      planDocument({ ...composed, intents: [{ kind: "release" }] }),
    ].map(plannedPlanId);
    expect([...new Set(pagePlanDigests(markdown))].sort()).toStrictEqual(computed.sort());
  });

  it("the run rendering's stop row is the engine's own, and the page quotes it verbatim", () => {
    const first = worlds[0];
    const additionsBlock = additions[0];
    expect(first).toBeDefined();
    expect(additionsBlock).toBeDefined();
    const composed = { ...(first as PlanningInput), ...(additionsBlock as object) };
    const who = (additionsBlock?.bootstrap as { who: unknown } | undefined)?.who;
    if (typeof who !== "string") {
      throw new Error("the page's additions block names no bootstrap `who` to run as");
    }
    const outcome = selectEngine(memory).run({
      input: composed,
      lineIds: ["main"],
      intents: [{ kind: "release" }],
      actor: who,
    });
    if (outcome.kind !== "published") {
      throw new Error(`expected a published run over the page's world, got "${outcome.kind}"`);
    }
    const stopRow = renderHuman(outcome)
      .split("\n")
      .find((line) => line.startsWith("stopped at "));
    // The engine's own renderer, over the page's own world — the same row
    // the page's `run` transcript quotes as its last line.
    expect(stopRow).toBe("stopped at verify (advance)");
    expect(markdown).toContain(stopRow);
  });

  it("every Action reference on the page is a full 40-character SHA", () => {
    const pins = [...markdown.matchAll(/uses: ecoma-io\/release-craft@([0-9a-f]+)/g)].map(
      (match) => match[1],
    );
    expect(pins.length).toBeGreaterThanOrEqual(1);
    for (const sha of pins) {
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});
