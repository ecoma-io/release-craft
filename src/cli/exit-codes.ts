/**
 * The process exit table (phase 12 contract §3.2, extended by issue #208's
 * surface), as one exhaustive `Record` over every outcome kind the doors
 * can return — exhaustiveness is what makes a new kind a compile error
 * here instead of a mislabeled process status in production. Every door
 * consults this one table; there is no second mapping anywhere in the
 * surface.
 *
 * The bands: 0–3 are the proceed band (0 planned/published/bootstrapped/
 * proposed/projection, 1 satisfied-externally, 2 resolved, 3 abandoned),
 * 10–17 the stop band (refused, denied, blocked, failed, conflict,
 * ambiguous, stale, escalate), 64 usage, 65 unsupported, 70 an escaped
 * throw. A non-zero status is information, never an error display: the
 * outcome renders verbatim on stdout (§3.1) and the status tells the
 * caller whether to proceed.
 */

import type {
  BootstrapGap,
  BootstrapInference,
  Observation,
  RunOutcome,
} from "@ecoma-io/release-craft/app";
import type { PlanLine, PlanningInput, PlanningOutcome } from "@ecoma-io/release-craft/planner";

/** The release-pr door's identity triple — the component the projection
 * names, the release line it targets, and the branch a merged projection
 * lands on. The CLI carries it verbatim from argv; the door it feeds
 * (issue #202's Release PR lifecycle) validates the claim. */
export interface ReleasePRIdentity {
  readonly component: string;
  readonly releaseLine: string;
  readonly targetBranch: string;
}

/** The rendered pull-request projection: the title, the body, the labels,
 * and the files a merged gate would write — pure data derived from a
 * planned release plan, nothing minted, nothing sent. */
export interface ReleasePRProjection {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

/** The release-pr door's own outcomes (issue #208): the projection with
 * the plan it derives from, or the explicit nothing-pending row for a
 * plan whose every line is already current — "nothing to do" is a
 * proceed-band answer, never a silent zero-file render. The plan's own
 * `refused` row renders verbatim as a `PlanningOutcome` (10) and is no
 * member here. */
export type ReleasePRCliOutcome =
  | {
      readonly kind: "projection";
      readonly identity: ReleasePRIdentity;
      readonly planId: string;
      readonly projection: ReleasePRProjection;
      readonly pendingLines: readonly PlanLine[];
    }
  | {
      readonly kind: "nothing-pending";
      readonly identity: ReleasePRIdentity;
      readonly planId: string;
    };

/** The bootstrap door's own outcomes (issue #208): `proposed` — the
 * completed world plus its inference ledger, nothing written;
 * `bootstrapped` — the configuration document written to the declared
 * path after the first plan is `planned`; `refused` — the gaps the
 * evidence cannot carry (`plan`/`proposed` null: nothing was completed,
 * nothing written) or a first plan that refused (`plan`/`proposed`
 * carrying the refusal and the un-written proposal). The write-only-
 * after-planned rule is what makes "partial bootstrap left unreported"
 * unrepresentable (issue #207). */
export type BootstrapCliOutcome =
  | {
      readonly kind: "proposed";
      readonly input: PlanningInput;
      readonly inferences: readonly BootstrapInference[];
      readonly plan: Extract<PlanningOutcome, { kind: "planned" }>;
    }
  | {
      readonly kind: "bootstrapped";
      readonly out: string;
      readonly input: PlanningInput;
      readonly inferences: readonly BootstrapInference[];
      readonly plan: Extract<PlanningOutcome, { kind: "planned" }>;
    }
  | {
      readonly kind: "refused";
      readonly gaps: readonly BootstrapGap[];
      readonly plan: PlanningOutcome | null;
      readonly proposed: PlanningInput | null;
    };

/** Every door value the CLI renders — the three engine unions verbatim
 * plus the two CLI doors' own unions. */
export type DoorOutcome =
  PlanningOutcome | RunOutcome | Observation | ReleasePRCliOutcome | BootstrapCliOutcome;

/** §3.2's table, pinned kind by kind. */
export const EXIT_CODES: Readonly<Record<DoorOutcome["kind"], number>> = {
  // — the proceed band —
  planned: 0,
  published: 0,
  "satisfied-externally": 1,
  resolved: 2,
  abandoned: 3,
  projection: 0,
  "nothing-pending": 0,
  proposed: 0,
  bootstrapped: 0,
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

/** The unsupported band (issue #208): a well-formed invocation naming a
 * capability this surface cannot serve — the grammar accepts it, the door
 * refuses it by name. It is not 64 (nothing about the invocation is
 * malformed) and not 10 (no world was read, no plan refused: the
 * capability itself is absent). The message names the door that carries
 * the wiring. */
export const EXIT_UNSUPPORTED = 65;

/** The escaped-throw band. */
export const EXIT_FAULT = 70;

/** The exit code for a door value. */
export const exitCodeFor = (outcome: DoorOutcome): number => EXIT_CODES[outcome.kind];
