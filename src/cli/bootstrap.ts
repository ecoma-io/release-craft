/**
 * The bootstrap door's CLI composition (issue #208, the surface of issue
 * #207's door): read the bootstrap document, propose the completed world,
 * run the first plan, and write the configuration document only after
 * that plan is `planned`. The write is the door's one effect and it is
 * ordered last on purpose: a proposal whose first plan refuses is
 * rendered as `refused` with the plan's own refusal and the un-written
 * proposal — "partial bootstrap left unreported" is unrepresentable,
 * because nothing is written unless the world it declares is usable.
 */

import { writeFileSync } from "node:fs";

import { proposeBootstrap } from "@ecoma-io/release-craft/app";

import type { BootstrapCliOutcome, DoorOutcome } from "./exit-codes.js";
import type { Invocation } from "./parse.js";
import { selectEngine } from "./selection.js";
import { readBootstrapDocument } from "./world.js";

/** The bootstrap invocation, narrowed to its command. */
export type BootstrapInvocation = Extract<Invocation, { command: "bootstrap" }>;

/** Run the bootstrap door for one parsed invocation. `--dry-run` renders
 * `proposed` (exit 0) and writes nothing; a real run writes the declared
 * `--out` document (two-space JSON, one trailing newline) and renders
 * `bootstrapped` (exit 0); the gaps render `refused` (exit 10) with
 * nothing written and nothing completed. */
export const executeBootstrap = (invocation: BootstrapInvocation): DoorOutcome => {
  const observations = readBootstrapDocument(invocation.world);
  const proposed = proposeBootstrap(observations);
  if ("gaps" in proposed) {
    const outcome: BootstrapCliOutcome = {
      kind: "refused",
      gaps: proposed.gaps,
      plan: null,
      proposed: null,
    };
    return outcome;
  }
  // The engine stands behind the PROPOSED policy: the git binding's tag
  // projection renders the plan's own tag through the proposal's declared
  // tag formats — the same document the door would write.
  const engine = selectEngine(invocation.selection, proposed.input.policy.tagFormats);
  const plan = engine.plan(proposed.input);
  if (plan.kind !== "planned") {
    const outcome: BootstrapCliOutcome = {
      kind: "refused",
      gaps: [],
      plan,
      proposed: proposed.input,
    };
    return outcome;
  }
  if (invocation.dryRun) {
    return { kind: "proposed", input: proposed.input, inferences: proposed.inferences, plan };
  }
  // The one write the door owns, reached only with a planned first plan.
  const document = `${JSON.stringify(proposed.input, null, 2)}\n`;
  writeFileSync(invocation.out, document, "utf8");
  return {
    kind: "bootstrapped",
    out: invocation.out,
    input: proposed.input,
    inferences: proposed.inferences,
    plan,
  };
};
