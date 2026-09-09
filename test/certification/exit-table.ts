/**
 * The certification fixture's recorded copy of the process exit table
 * (phase 14 contract §4.2, the exit-codes class: "the fixture's own copy
 * of the §3.2 table"). Hand-derived from phase 12 §3.2.
 *
 * The copy is pinned equal to the CLI's `EXIT_CODES` record by a cross-pin
 * in the CLI's own suite (`test/cli/exit-codes.test.ts`) — one table, no
 * second mapping. The cross-pin lives there and only there because the
 * fixture's import law (phase 14 §8) bars the fixture from `src/cli/`,
 * where this equality's other side lives.
 *
 * This module is pure recorded data: it imports the package barrel's types
 * for the record's key union and nothing else.
 */

import type { Observation, PlanningOutcome, RunOutcome } from "../../src/index.js";

/** Every door value the process renders — the three outcome unions. */
type DoorOutcome = PlanningOutcome | RunOutcome | Observation;

/** §3.2's table, the fixture's recorded copy. */
export const RECORDED_EXIT_TABLE: Readonly<Record<DoorOutcome["kind"], number>> = {
  // — the proceed band —
  planned: 0,
  published: 0,
  "satisfied-externally": 1,
  resolved: 2,
  abandoned: 3,
  // — the stop band —
  refused: 10,
  denied: 11,
  blocked: 12,
  failed: 13,
  conflict: 14,
  ambiguous: 15,
  stale: 16,
  escalate: 17,
  // — the observation doors —
  attempt: 0,
  channels: 0,
};
