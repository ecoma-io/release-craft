/**
 * The `channel-transition` stage's application half (phase 11 contract
 * §2.4; ADR-0012 decisions 3–7) — the wiring point ADR-0012 decision 6
 * assigns and nothing owned before this layer. The kernel names the step
 * and consumes no store (invariant 2.1); the boundary executes the
 * recorded plan's moves through the wired store at exactly one place in
 * the walk — between the ledger's write-ahead `started` record and the
 * advancing completion, in ADR-0012 decision 3's order:
 *
 * ```text
 * ledger.appendStart(attempt, "channel-transition", attribution, …)  // the walk, durable first
 * ledgerRequestStep(attempt, request, claimView, ledger) → advance   // the walk, the claim guard —
 *                                                                    // only a rule-6-verified
 *                                                                    // advance proceeds to the
 *                                                                    // store; a completed stage's
 *                                                                    // noop is walked past with no
 *                                                                    // CAS; any other verdict stops
 *                                                                    // the walk before a CAS runs
 * for each planned move: channels.applyTransition(move)              // here, on that advance —
 *                                                                    // the store's CAS (the
 *                                                                    // crash-window replay's
 *                                                                    // idempotent re-apply), each
 *                                                                    // move record carrying the
 *                                                                    // claim verdict a check
 *                                                                    // actually performed; the
 *                                                                    // completion appends after the
 *                                                                    // moves (decision 3)
 * ```
 *
 * The move assumes the prior target the store's own read observes — never
 * a trusted `from` from the plan (ADR-0012 decision 2: the plan names `to`,
 * never `from`). Every decided move appends one `channel-transition` ledger
 * record whose `contentFingerprint` is the store outcome's — the record's
 * idempotency key is what the store observed deciding, never what the plan
 * assumed (decision 4). `applied` proceeds; `noop` is an ADVANCING stage's
 * own replay case — the crash window between the moves and the completion,
 * where the verified claim stands and each already-landed move answers
 * `noop`; a COMPLETED channel stage is never re-executed at all (the walk's
 * CAS gate is the verified advance alone), so this function never runs over
 * one and an out-of-band drifted ref is never re-pointed here — the silent
 * second move the replay ladder forbids. A `conflict` or `ambiguous` stops
 * the walk as a returned outcome — never a throw, never a quiet second
 * move: a half-moved promotion is never reported green (invariants 2.5/2.6),
 * and the recorded `started` record is what a resume re-judges. The
 * `promoted-from` edge and the stream close are line-level facts needing no
 * store — no move exists for a channel that was never declared (ADR-0012's
 * walk; decision-log D36).
 *
 * No clock, no environment, no randomness (§3's law).
 */
import type {
  ChannelApplyOutcome,
  ChannelStore,
  ExecutionLedger,
  ReleaseAttempt,
} from "@ecoma-io/release-craft/execution";
import type { PlannedChannelMove, PlanLine } from "@ecoma-io/release-craft/planner";
import type { AppliedChannelMove, ChannelStageResult } from "./types.js";

/**
 * The plan line's declared channel moves, in declaration order — the only
 * planned channel content a store move exists for.
 */
export const plannedChannelMoves = (planLine: PlanLine): readonly PlannedChannelMove[] =>
  (planLine.channels ?? []).filter(
    (planned): planned is PlannedChannelMove => planned.kind === "channel-move",
  );

/**
 * Executes the recorded plan's moves through the wired store (§2.4's
 * point, above). The caller gates this on the stage guard's verified
 * advance — a completed stage's noop replay never reaches here, so the
 * `claim` row below is always a check the guard actually performed.
 * Returns the moves that landed with the outcomes the store returned, or
 * the first undecidable move as the `conflict`/`ambiguous` row that stops
 * the walk — that move records nothing, and the stage's completion never
 * appends after it.
 */
export const applyPlannedChannelTransitions = (application: {
  readonly attempt: ReleaseAttempt;
  readonly planLine: PlanLine;
  /** The attribution the stage's records carry — the run's own. */
  readonly actor: string;
  /** The held claim token the stage's guards verified — carried like every
   * mutating record (§2.9). */
  readonly claim?: string;
  readonly channels: ChannelStore;
  readonly ledger: ExecutionLedger;
}): ChannelStageResult => {
  const moves = plannedChannelMoves(application.planLine);
  const applied: AppliedChannelMove[] = [];
  for (const move of moves) {
    const observed = application.channels.read(move.channelId);
    const to = { line: move.to.line, version: move.to.version };
    const outcome: ChannelApplyOutcome = application.channels.applyTransition({
      channelId: move.channelId,
      from: observed.target,
      to,
    });
    if (outcome.kind === "conflict") {
      return {
        kind: "conflict",
        channelId: move.channelId,
        detail:
          `the channel store refused the planned move of ${JSON.stringify(move.channelId)}: the ` +
          `observed prior target ${JSON.stringify(outcome.observed)} matches neither the move's ` +
          `prior nor its target — a divergent promotion fails closed (invariant 2.5)`,
      };
    }
    if (outcome.kind === "ambiguous") {
      return {
        kind: "ambiguous",
        channelId: move.channelId,
        detail:
          `the channel store cannot determine whether the move of ${JSON.stringify(move.channelId)} ` +
          `landed: ${outcome.detail} — the promotion does not race forward on uncertainty ` +
          `(invariant 2.6, ADR-0012 decision 7)`,
      };
    }
    applied.push({ channelId: move.channelId, from: observed.target, to, outcome: outcome.kind });
    application.ledger.append({
      kind: "channel-transition",
      record: {
        attemptId: application.attempt.attemptId,
        stepKey: "channel-transition",
        channelId: move.channelId,
        from: observed.target,
        to,
        attribution: { attemptId: application.attempt.attemptId, actor: application.actor },
        guards: [{ guard: "claim-held", passed: application.claim !== undefined }],
        ...(application.claim === undefined ? {} : { claim: application.claim }),
        contentFingerprint: outcome.contentFingerprint,
      },
    });
  }
  return { kind: "applied", moves: applied };
};
