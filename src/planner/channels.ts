/**
 * ADR-0012 decision 2 — the planner's planned channel transitions.
 *
 * A promote (P-03, `decision.bump === null` over an in-flight prerelease)
 * plans, as pure plan content (invariant 2.2 — the planner never mutates a
 * channel, it only names the moves):
 *
 * - the declared channels' moves to the promoted stable (PR-01's promote
 *   vocabulary, verbatim: "channels `next`/`stable` move");
 * - the promoted-from edge (the prerelease → stable relation, PR-05's
 *   graph-with-timeline vocabulary);
 * - the promoted prerelease stream's close.
 *
 * The derivation is a pure function of the declared channel registry, the
 * line id, the in-flight pointer, and the promoted stable — no clock, no
 * randomness, no environment (invariant 2). Order is deterministic: moves
 * in declaration order, then the edge, then the close.
 */

import type { Version } from "@ecoma-io/release-craft/domain";

import type { ChannelObservation, PlannedChannelTransition } from "./types.js";

/** PR-01's promote vocabulary, verbatim: "channels `next`/`stable` move."
 * A declared channel participates in a promote's moves exactly when its id
 * is one of these — the canonical release channels. Channels tracking
 * prerelease streams (a channel whose id is a stream identifier) and other
 * lines' channels are untouched by this line's promotion. */
const PROMOTE_MOVED_CHANNEL_IDS: readonly string[] = ["stable", "next"];

/** Names the planned channel transitions for one promoting line: the moves
 * for the declared channels PR-01's vocabulary moves, then the promoted-from
 * edge, then the promoted stream's close. The caller guarantees the promote
 * posture — the decision is `release` with `bump: null`, the pointer is the
 * in-flight prerelease (the promote refusal guarantees a non-empty
 * prerelease), and `promoted` is the minted stable target (`bumpPatch` of
 * the pointer). */
export const plannedChannelTransitions = (
  declared: readonly ChannelObservation[],
  lineId: string,
  pointer: Version,
  promoted: Version,
): readonly PlannedChannelTransition[] => {
  const version = promoted.toString();
  const moves = declared
    .filter((channel) => channel.target.line === lineId)
    .filter((channel) => PROMOTE_MOVED_CHANNEL_IDS.includes(channel.id))
    .map((channel): PlannedChannelTransition => ({
      kind: "channel-move",
      channelId: channel.id,
      to: { line: lineId, version },
    }));
  // The stream's identifier is the pointer's leading prerelease identifier
  // — state.ts's own destructuring rule over the kernel prerelease. The
  // promote decision refuses a pointer with no prerelease, so the
  // identifier exists; reaching past that posture is a caller contract
  // violation, surfaced — never guessed.
  const [identifier] = pointer.prerelease;
  if (identifier === undefined) {
    throw new Error(
      `caller contract violation: the promote of line ${JSON.stringify(lineId)} names no prerelease identifier — ` +
        `the pointer ${pointer.toString()} carries no prerelease, which the promote decision refuses`,
    );
  }
  return [
    ...moves,
    { kind: "promoted-from", from: pointer.toString(), to: { line: lineId, version } },
    { kind: "stream-close", stream: identifier, target: version },
  ];
};
