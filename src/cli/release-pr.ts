/**
 * The release-pr door's CLI composition (issue #208): the door's surface
 * is the contract — the grammar accepts `release-pr`, and the door
 * refuses, by name, until the Release PR lifecycle door it renders
 * (issue #202) is wired. The refusal is the unsupported band (65): the
 * invocation is well-formed, no world is read, and no plan is run —
 * release-please-shaped inputs never reach a silent default here.
 */

import type { DoorOutcome } from "./exit-codes.js";
import { UnsupportedFault } from "./parse.js";
import type { Invocation } from "./parse.js";

/** The release-pr invocation, narrowed to its command. */
export type ReleasePRInvocation = Extract<Invocation, { command: "release-pr" }>;

/** Run the release-pr door for one parsed invocation. Until the Release
 * PR lifecycle door lands, every spelling — dry or not — refuses loudly
 * with the exit-65 band and a message naming the carrier issue. */
export const executeReleasePr = (_invocation: ReleasePRInvocation): DoorOutcome => {
  throw new UnsupportedFault(
    "release-pr — the pull-request projection rides the Release PR lifecycle door (issue #202); its CLI surface is contracted by issue #208 and not wired on this build",
  );
};
