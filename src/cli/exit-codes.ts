/**
 * The process exit table (phase 12 contract §3.2), as one exhaustive
 * `Record` over every outcome kind the doors can return — exhaustiveness
 * is what makes a new kind a compile error here instead of a mislabeled
 * process status in production. Every door consults this one table; there
 * is no second mapping anywhere in the surface.
 *
 * The bands: 0–3 are the proceed band (0 planned/published, 1
 * satisfied-externally, 2 resolved, 3 abandoned), 10–17 the stop band
 * (refused, denied, blocked, failed, conflict, ambiguous, stale,
 * escalate), 64 usage, 70 an escaped throw. A non-zero status is
 * information, never an error display: the outcome renders verbatim on
 * stdout (§3.1) and the status tells the caller whether to proceed.
 */

import type { Observation, RunOutcome } from "@ecoma-io/release-craft/app";
import type { PlanningOutcome } from "@ecoma-io/release-craft/planner";

/** Every door value the CLI renders — the three outcome unions, verbatim. */
export type DoorOutcome = PlanningOutcome | RunOutcome | Observation;

/** §3.2's table, pinned kind by kind. */
export const EXIT_CODES: Readonly<Record<DoorOutcome["kind"], number>> = {
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

/** The usage band. */
export const EXIT_USAGE = 64;

/** The escaped-throw band. */
export const EXIT_FAULT = 70;

/** The exit code for a door value. */
export const exitCodeFor = (outcome: DoorOutcome): number => EXIT_CODES[outcome.kind];
