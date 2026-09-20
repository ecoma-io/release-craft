#!/usr/bin/env node
/**
 * The CLI's bin entrypoint (phase 12 contract §2.1): argv in, exit code
 * out. The process touches nothing ambient — no environment read, no
 * working-directory default, no clock (§4) — except the one declared leg:
 * `--publish` (issue #336) opens the run's publication port with the live
 * GitHub adapter, and the two names that define that leg — `GITHUB_TOKEN`,
 * `GITHUB_API_URL` — are read at the one door that may (`github-transport.ts`),
 * gated on the operator's explicit flag. Every other door is untouched by
 * the name: the token never reaches a run the operator did not declare,
 * and the hermeticity law's amendment is exactly this scope (phase 12 §4).
 * The only other effectful steps are reading the `--world` document, the
 * git assembly's own repository access, and the two writes the contract
 * allows (one document on stdout for a returned outcome, diagnostics on
 * stderr otherwise).
 *
 * Exit bands (§3.2): 0–3 the door's proceed band, 10–17 its stop band —
 * both rendering the outcome on stdout — 64 a usage fault (with the
 * synopsis, on stderr, stdout empty), 70 an escaped throw (name and
 * message verbatim on stderr, stdout empty). An outcome is never
 * translated into a fault and a fault never renders as an outcome. The
 * one answer that is no door and no fault: `--help`/`-h` in the command
 * position prints the closed grammar (§2.2) on stdout and exits 0.
 */

import type { ArtifactStep, StepKey } from "@ecoma-io/release-craft/execution";
import { assemblePublicationBinding } from "@ecoma-io/release-craft/app";
import type { RunRequest } from "@ecoma-io/release-craft/app";
import { openGitBinding, openGitRun } from "@ecoma-io/release-craft/adapters/git";
import {
  CREDENTIALS_HOST,
  openGitHubAdapter,
  parseRemoteIdentity,
} from "@ecoma-io/release-craft/adapters/github";
import { EXIT_FAULT, EXIT_USAGE, exitCodeFor, type DoorOutcome } from "./exit-codes.js";
import { HELP_FLAGS, helpText, usageText } from "./grammar.js";
import { overlayIntents } from "./intents.js";
import { parseArgv, UsageFault, type Invocation } from "./parse.js";
import { renderHuman, renderJson } from "./render.js";
import { selectEngine } from "./selection.js";
import { deriveTargets } from "./targets.js";
import { readWorldDocument } from "./world.js";
import { openGitHubTransport, readPublishEnvironment } from "./github-transport.js";
import { declaredTagNaming } from "./naming.js";
/** The single changelog declaration behind `--changelog` (#327): exactly one
 * `artifact:changelog` step, anchored after the claim is held and before the
 * mint, answered by the binding's fallback `GitArtifactProducer` (no
 * producers map — the engine wires `declared?.get(step.id) ?? wired`). The
 * `id` is the one field `GitReleasePublication` matches (`publication.ts:65`),
 * so it must stay `changelog`. `dependsOn` is empty — the self-release runs
 * the empty declaration; the matrix's `package`/`binary` siblings do not
 * exist here. `content-fingerprint-present` only, never `evidence-present`:
 * the fallback producer returns no `evidence`, so `evidence-present` would
 * fail-closed block every leg. */
const CHANGELOG_DECLARATION: ArtifactStep = {
  id: "changelog",
  anchor: { stage: "tag", position: "after" },
  guard: "release-line",
  kind: "changelog",
  coordinates: "CHANGELOG.md",
  dependsOn: [],
  postconditions: ["content-fingerprint-present"],
};

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
  // The opt-in changelog declaration: `--changelog` declares exactly the one
  // artifact step; otherwise the empty declaration (the v1 posture, #327).
  // The declaration rides `RunRequest.declarations` — frozen onto the attempt
  // at open (`engine.ts:879`), walked by the artifact scheduler inside the run.
  const declarations = invocation.changelog ? { artifacts: [CHANGELOG_DECLARATION] } : undefined;
  const request = {
    input: document,
    lineIds: [invocation.line],
    // The run request's intents are an array by the engine port's own
    // contract; with none declared the empty list is that contract's
    // spelling of "no operator intents", and the planner's input
    // projection states it canonically (identity.ts, #319).
    intents: overlayIntents(document.intents, invocation.intents) ?? [],
    actor: invocation.actor,
    targets: deriveTargets(document),
    ...(declarations === undefined ? {} : { declarations }),
  };
  // The publish leg (issue #336): `--publish` runs the same request
  // through the publication driver — the same binding, the same config —
  // with the live GitHub adapter as the run's publication port. The
  // credentials' owner/repo derive from the git assembly's own origin
  // (the binding's repository names where the mint lands, so the release
  // must name the same place — never a flag, never a second identity);
  // the token and the API base are the declared ambient leg, read at the
  // one door that may. The adapter asserts the origin agreement the
  // self-release's own mint already holds.
  // The parser narrows the publish row to the run door alone (the grammar
  // refuses `--publish` beside any other command); here the narrowed
  // invocation already says "run", so the row is the flag alone.
  if (invocation.publish) {
    return publishRun(invocation, request, document.policy.tagFormats);
  }
  return engine.run(request);
};

/** The publish leg's composition (issue #336): the same repository the
 *  git assembly runs on, the same request, the publication port wired
 *  with the live GitHub adapter. The owner and repo of the API
 *  credentials come from the binding repository's own origin — the one
 *  place the mint and the release can ever agree — and the adapter's
 *  factory re-asserts that origin agreement before any door runs. Token
 *  and API base are the declared ambient leg's two names, read at their
 *  one door. Every failure here is a fault (exit 70) with a message that
 *  names the missing piece: a tokenless environment, an originless
 *  repository, an unparseable origin, a foreign host. */
const publishRun = (
  invocation: Extract<Invocation, { command: "run" }>,
  request: RunRequest,
  tagFormats: Readonly<Record<string, string>>,
): DoorOutcome => {
  const selection = invocation.selection;
  if (selection.assembly !== "git") {
    // The grammar refuses --publish on the memory assembly before any
    // door runs (parse.ts); this row is the type-carried twin, so a
    // future selection can never reach the adapter without a repository.
    throw new Error("the publish leg feeds the git assembly only");
  }
  const publish = readPublishEnvironment();
  // The binding's own hermetic runner: `remote get-url origin` is a
  // local read (the runner strips credential prompts and the ambient
  // config that could answer a different repository), and an exit
  const git = openGitRun(selection.repo);
  let origin: string;
  try {
    origin = git(["remote", "get-url", "origin"]).trim();
  } catch (error) {
    throw new Error(
      `the publish leg could not read the configured repository's origin: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  const identity = parseRemoteIdentity(origin);
  if (identity === null) {
    throw new Error(
      `the publish leg could not parse the configured repository's origin (${JSON.stringify(
        origin,
      )}) — it must name a ${CREDENTIALS_HOST} repository`,
    );
  }
  if (identity.host !== CREDENTIALS_HOST) {
    throw new Error(
      `the publish leg refuses the origin host "${identity.host}" — only ${CREDENTIALS_HOST} origins are published`,
    );
  }
  const binding = openGitBinding({
    repo: selection.repo,
    tagNaming: declaredTagNaming(selection.tagNamespaces, tagFormats),
  });
  const github = openGitHubAdapter(
    binding,
    { token: publish.token, owner: identity.owner, repo: identity.repo },
    openGitHubTransport(publish.baseUrl, publish.token),
  );
  // The same composition the package shell offers as `openPublicationDriver`
  // (publication-driver.ts) — inlined here because the CLI's boundary row
  // permits the app barrel, never the package front door (#155; the two
  // adapter openings above are the publish leg's one github edge, #336).
  return assemblePublicationBinding(
    binding,
    {
      publishRelease: (tag) => github.publishRelease(tag),
      verifyRelease: (tag) => github.verifyRelease(tag),
    },
    { maxRetries: invocation.selection.maxRetries },
  ).run(request);
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
