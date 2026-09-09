/**
 * The certification fixture's byte-layer generator (phase 14 contract
 * §4.3, §4.4). It drives the SAME scenario doors the suites drive (every
 * one lives in `drive.ts` — one code path, so a drift in a door moves the
 * recorded bytes and the compared bytes together, and the suite's diff
 * catches any divergence), applies the recorded projection, and writes
 * `expected/<cell>.json`.
 *
 * THIS MODULE IS NEVER EXECUTED BY A GATED PATH. The vitest include
 * matches `*.test.ts` only; `pnpm check` and the moon graph never invoke
 * this file. The byte layer is generated ONCE, reviewed cell by cell, and
 * committed; regenerating is a deliberate, reviewed act (§5's amendment
 * protocol), never an automatic step:
 *
 *   1. create a throwaway `test/certification/gen.test.ts` containing
 *      `import { it } from "vitest"; import { generateAll } from "./generate.js";`
 *      and `it("generate", () => { generateAll(); });`
 *   2. `pnpm exec vitest run test/certification/gen.test.ts`
 *   3. delete the throwaway, review the `expected/` diff cell by cell,
 *      and commit the reviewed bytes with the manifest row's amendment.
 *
 * A generated file a suite compares against is data, not a snapshot: the
 * suites never write it, and a suite failing the diff is a filed defect,
 * never a re-run of this generator inside the gate.
 */

import {
  memoryPlanScenario,
  memoryRunScenario,
  memoryDenialScenario,
  writeExpected,
} from "./drive.js";

/** The boundary door values are recorded compact — the exact serialization
 * the process surface renders (the pass-through's byte form). */
const serialize = (value: unknown): string => JSON.stringify(value);

const generateMemory = (): void => {
  const plan = memoryPlanScenario();
  writeExpected("memory-01", {
    cell: "memory-01",
    projection: "none — the memory envelope is the zero-random assembly's",
    scenarios: [
      {
        label: "plan (first of the double)",
        exit: plan.status,
        stdout: plan.stdout,
        stderr: plan.stderr,
      },
    ],
  });

  const { child, direct } = memoryRunScenario();
  writeExpected("memory-02", {
    cell: "memory-02",
    projection: "none — the memory envelope is the zero-random assembly's",
    scenarios: [
      {
        label: "run (the process envelope)",
        exit: child.status,
        stdout: child.stdout,
        stderr: child.stderr,
      },
      { label: "run (the boundary door value)", exit: null, stdout: serialize(direct), stderr: "" },
    ],
  });

  const { loser } = memoryDenialScenario();
  writeExpected("memory-03", {
    cell: "memory-03",
    projection: "none — the memory envelope is the zero-random assembly's",
    scenarios: [
      {
        label: "promote loser (the denied door value)",
        exit: null,
        stdout: serialize(loser),
        stderr: "",
      },
    ],
  });
};

/** Regenerates every recorded byte cell. Each family's writer is added with
 * that family's suite (the build order: the suites and their recorded bytes
 * land together). */
export const generateAll = (): void => {
  generateMemory();
};
