/**
 * The renderers (phase 12 contract §3.1): a door's value crosses stdout
 * verbatim — either the machine contract's single JSON document
 * (`--json`) or a short human text naming the kind and the stopping step.
 * Neither renderer translates an outcome: `--json` is the door's returned
 * value serialized with no reshaping, and the human text is a projection
 * of the same value, never a different verdict. Diagnostics (usage
 * faults, escaped throws) render on stderr only; a faulted process puts
 * nothing on stdout (phase 12 §3.3's fault-band law — the bands never
 * render as outcomes).
 */

import type { PlanningOutcome, RunOutcome } from "../index.js";

import type { DoorOutcome } from "./exit-codes.js";

/** One JSON document, one trailing newline, compact — byte-stable for
 * determinism pins and trivially parseable by the next process. */
export const renderJson = (outcome: DoorOutcome): string => `${JSON.stringify(outcome)}\n`;

const planningLines = (outcome: PlanningOutcome): string[] => {
  if (outcome.kind === "refused") {
    return [
      "refused",
      `cause ${outcome.refusal.cause}`,
      `detail ${outcome.refusal.detail}`,
      `commits ${outcome.refusal.commits.join(", ") || "none"}`,
    ];
  }
  const lines = ["planned", `plan ${outcome.plan.planId}`, `policy ${outcome.plan.policyDigest}`];
  for (const line of outcome.plan.lines) {
    lines.push(
      line.stable === null
        ? `line ${line.lineId} (no stable target)`
        : `line ${line.lineId} ${line.stable.version} (tag ${line.stable.tag})`,
    );
  }
  return lines;
};

const runLines = (outcome: RunOutcome): string[] => {
  const lines: string[] = [outcome.kind];
  if (outcome.planId !== null) {
    lines.push(`plan ${outcome.planId}`);
  }
  if (outcome.handle !== null) {
    lines.push(`attempt ${outcome.handle.attemptId} (actor ${outcome.handle.actor})`);
  }
  switch (outcome.kind) {
    case "published":
      lines.push(`tag ${outcome.tag ?? "none"}`);
      break;
    case "refused":
    case "conflict":
    case "ambiguous":
    case "stale":
    case "escalate":
      lines.push(`detail ${outcome.detail}`);
      break;
    case "denied":
      lines.push(`holder ${outcome.holder ?? "unknown"}`);
      break;
    case "blocked":
    case "failed":
      lines.push(`cause ${outcome.cause}`);
      break;
    case "abandoned":
      lines.push(`reason ${outcome.reason}`);
      break;
    case "satisfied-externally":
    case "resolved":
      break;
  }
  const stopping = outcome.drives[outcome.drives.length - 1];
  if (stopping !== undefined) {
    lines.push(`stopped at ${stopping.stepKey} (${stopping.outcome.kind})`);
  }
  return lines;
};

const attemptLines = (outcome: Extract<DoorOutcome, { kind: "attempt" }>): string[] => {
  const lines = [
    "attempt",
    `attempt ${outcome.handle.attemptId} (actor ${outcome.handle.actor})`,
    `plan ${outcome.handle.planId}`,
    `state ${outcome.state}`,
    `claim ${outcome.claim === null ? "none" : outcome.claim.token}`,
    `tags ${outcome.tags.join(", ") || "none"}`,
    `channels ${outcome.channels === null ? "not wired" : String(outcome.channels.length)}`,
    `tail ${String(outcome.tail.length)} record(s)`,
  ];
  if (outcome.blockedCause !== undefined) {
    lines.push(`blocked cause ${outcome.blockedCause}`);
  }
  if (outcome.terminalReason !== undefined) {
    lines.push(`terminal reason ${outcome.terminalReason}`);
  }
  return lines;
};

/** The human projection: a few short lines naming the kind, the plan, the
 * attempt, and the step that stopped the run — enough to read a process
 * transcript, never a re-translation of the verdict. */
export const renderHuman = (outcome: DoorOutcome): string => {
  let lines: string[];
  switch (outcome.kind) {
    case "planned":
      lines = planningLines(outcome);
      break;
    case "published":
    case "satisfied-externally":
    case "denied":
    case "blocked":
    case "failed":
    case "conflict":
    case "ambiguous":
    case "stale":
    case "escalate":
    case "resolved":
    case "abandoned":
      lines = runLines(outcome);
      break;
    case "attempt":
      lines = attemptLines(outcome);
      break;
    case "channels":
      lines = [
        "channels",
        ...outcome.channels.map((channel) =>
          channel.target === null
            ? `${channel.id} hidden`
            : `${channel.id} -> ${channel.target.line}@${channel.target.version}`,
        ),
      ];
      break;
    case "refused":
      // `refused` exists on all three unions; the payload discriminates.
      if ("refusal" in outcome) {
        lines = planningLines(outcome);
      } else if ("planId" in outcome) {
        lines = runLines(outcome);
      } else {
        lines = ["refused", `detail ${outcome.detail}`];
      }
      break;
  }
  return `${lines.join("\n")}\n`;
};
