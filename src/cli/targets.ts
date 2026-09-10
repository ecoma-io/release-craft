/**
 * Mint-target derivation (phase 12 contract §2.5): the CLI has no
 * `--target` flag. The target each line's tag is minted onto is derived
 * once from the same `--world` document the plan reads — the head of the
 * ref the line's `feedRef` names, taken from `repository.refs`. When the
 * document names the same ref more than once, the LAST occurrence wins,
 * matching the planner's own `deriveRanges` tie-break, so the CLI's
 * target and the planner's range head can never disagree about one
 * document.
 */

import type { PlanningInput } from "@ecoma-io/release-craft/planner";

/** The mint targets: keyed by line id, valued by the ref head commit sha. */
export const deriveTargets = (input: PlanningInput): Readonly<Record<string, string>> => {
  const headByRef: Record<string, string> = {};
  for (const ref of input.repository.refs) {
    headByRef[ref.name] = ref.head;
  }
  const targets: Record<string, string> = {};
  for (const line of input.lines) {
    const head = headByRef[line.feedRef];
    if (head !== undefined) {
      targets[line.id] = head;
    }
  }
  return targets;
};
