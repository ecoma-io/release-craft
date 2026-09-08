#!/usr/bin/env node
/**
 * The CLI's bin entrypoint (phase 12 contract §2.1): argv in, exit code
 * out. The process touches nothing ambient — no environment read, no
 * working-directory default, no clock (§4); the only effectful steps are
 * reading the `--world` document, the git assembly's own repository
 * access, and the two writes the contract allows (one document on stdout
 * for a returned outcome, diagnostics on stderr otherwise).
 *
 * Exit bands (§3.2): 0–3 the door's proceed band, 10–17 its stop band —
 * both rendering the outcome on stdout — 64 a usage fault (with the
 * synopsis, on stderr, stdout empty), 70 an escaped throw (name and
 * message verbatim on stderr, stdout empty). An outcome is never
 * translated into a fault and a fault never renders as an outcome.
 */

import type { StepKey } from "../index.js";
import { EXIT_FAULT, EXIT_USAGE, exitCodeFor, type DoorOutcome } from "./exit-codes.js";
import { usageText } from "./grammar.js";
import { overlayIntents } from "./intents.js";
import { parseArgv, UsageFault, type Invocation } from "./parse.js";
import { renderHuman, renderJson } from "./render.js";
import { selectEngine } from "./selection.js";
import { deriveTargets } from "./targets.js";
import { readWorldDocument } from "./world.js";

/** The doors, one command per door (§2.2). Cross-process doors
 * (`resume`/`resolve`/`abort`/`show`) render whatever the engine returns —
 * including the `refused` row for a plan this engine does not carry
 * (§2.7): the surface runs no capability gate, it passes values through. */
const execute = (invocation: Invocation): DoorOutcome => {
  if (invocation.command === "resolve") {
    const engine = selectEngine(invocation.selection);
    return engine.resolve(
      { planId: invocation.planId, attemptId: invocation.attemptId, actor: invocation.actor },
      invocation.stepKey as StepKey, // the door validates the step key; the grammar carries it verbatim
      invocation.resolution,
    );
  }
  if (invocation.command === "abort") {
    const engine = selectEngine(invocation.selection);
    return engine.abort(
      { planId: invocation.planId, attemptId: invocation.attemptId, actor: invocation.actor },
      invocation.actor,
      invocation.reason,
    );
  }
  if (invocation.command === "show") {
    const engine = selectEngine(invocation.selection);
    return engine.observe(invocation.query);
  }
  const document = readWorldDocument(invocation.world);
  if (invocation.command === "resume") {
    const engine = selectEngine(invocation.selection);
    return engine.resume(
      { planId: invocation.planId, attemptId: invocation.attemptId, actor: invocation.actor },
      {
        input: document,
        lineIds: invocation.line === null ? [] : [invocation.line],
        intents: [],
        actor: invocation.actor,
        targets: deriveTargets(document),
      },
    );
  }
  if (invocation.command === "plan") {
    const engine = selectEngine(invocation.selection);
    return engine.plan({
      ...document,
      intents: overlayIntents(document.intents ?? [], invocation.intents),
    });
  }
  const engine = selectEngine(invocation.selection);
  return engine.run({
    input: document,
    lineIds: [invocation.line],
    intents: overlayIntents(document.intents ?? [], invocation.intents),
    actor: invocation.actor,
    targets: deriveTargets(document),
  });
};

const faultOrUsage = (error: unknown): number => {
  if (error instanceof UsageFault) {
    process.stderr.write(`usage: ${error.message}\n\n${usageText()}\n`);
    return EXIT_USAGE;
  }
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${name}: ${message}\n`);
  return EXIT_FAULT;
};

const main = (argv: readonly string[]): number => {
  let invocation: Invocation;
  try {
    invocation = parseArgv(argv);
  } catch (error) {
    return faultOrUsage(error);
  }
  try {
    const outcome = execute(invocation);
    process.stdout.write(invocation.json ? renderJson(outcome) : renderHuman(outcome));
    return exitCodeFor(outcome);
  } catch (error) {
    return faultOrUsage(error);
  }
};

process.exitCode = main(process.argv.slice(2));
