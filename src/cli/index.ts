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
 * translated into a fault and a fault never renders as an outcome. The
 * one answer that is no door and no fault: `--help`/`-h` in the command
 * position prints the closed grammar (§2.2) on stdout and exits 0.
 */

import type { StepKey } from "@ecoma-io/release-craft/execution";
import { EXIT_FAULT, EXIT_USAGE, exitCodeFor, type DoorOutcome } from "./exit-codes.js";
import { HELP_FLAGS, helpText, usageText } from "./grammar.js";
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
  // The world-document doors build the engine from the document's own
  // declared tag formats: the git naming's projection must render the
  // plan's own tag (§2.3), and the plan renders through the same
  // document's `policy.tagFormats`.
  const engine = selectEngine(invocation.selection, document.policy.tagFormats);
  if (invocation.command === "resume") {
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
    // The overlay is the document's own intents under no `--intent` flags —
    // absent when the document omits the field, never a fabricated `[]`
    // (#319): the door's PlanningInput stays the world the caller wrote,
    // so both plan doors fingerprint identical worlds identically.
    const intents = overlayIntents(document.intents, invocation.intents);
    return engine.plan({
      ...document,
      ...(intents === undefined ? {} : { intents }),
    });
  }
  return engine.run({
    input: document,
    lineIds: [invocation.line],
    // The run request's intents are an array by the engine port's own
    // contract; with none declared the empty list is that contract's
    // spelling of "no operator intents", and the planner's input
    // projection states it canonically (identity.ts, #319).
    intents: overlayIntents(document.intents, invocation.intents) ?? [],
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
  // The whole-process question (§2.2): the closed grammar plus the intent
  // spellings on stdout, exit 0, nothing on stderr, no door reached. The
  // help spellings are answered in the command position only — anywhere
  // else one of them is the unknown flag it always was, and the usage
  // fault that answers prints the same synopsis.
  const first = argv[0];
  if (first !== undefined && HELP_FLAGS.includes(first)) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
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
