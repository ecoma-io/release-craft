/**
 * The operator-intent spellings (phase 12 contract §2.2): kind-first,
 * colon-delimited, exactly as `planner` serializes them. The segment
 * counts are strict — an id that itself carries a colon (the planner's
 * reserved separator) is refused at parse time, exit 64, before any
 * engine sees it (§2.2's law: reserved characters are refused at the
 * boundary, not by a fault the engine discovers later).
 */

import type { OperatorIntent } from "../index.js";

import { UsageFault } from "./parse.js";

/** Parse one `--intent` occurrence into the boundary's intent union. */
export const parseIntents = (values: readonly string[]): readonly OperatorIntent[] =>
  values.map((value) => parseIntent(value));

/** The intents overlay (§2.6's law, carried through the surface): the
 * request's intents win over any intents inside the world document —
 * explicit `--intent` occurrences are the request's; with none, the
 * document's `intents` is the run's. The two are never merged. */
export const overlayIntents = (
  documentIntents: readonly OperatorIntent[],
  flagIntents: readonly OperatorIntent[],
): readonly OperatorIntent[] => (flagIntents.length > 0 ? flagIntents : documentIntents);

const parseIntent = (value: string): OperatorIntent => {
  const segments = value.split(":");
  const kind = segments[0];
  if (kind === "release" && segments.length === 1) {
    return { kind: "release" };
  }
  if (kind === "release-anyway" && segments.length === 1) {
    return { kind: "release-anyway" };
  }
  if (kind === "prerelease" && segments.length === 3) {
    const stream = segments[1];
    const lineId = segments[2];
    if (stream !== undefined && lineId !== undefined && stream.length > 0 && lineId.length > 0) {
      return { kind: "prerelease", stream, lineId };
    }
  }
  if (kind === "release-as" && segments.length === 2) {
    const version = segments[1];
    if (version !== undefined && version.length > 0) {
      return { kind: "release-as", version };
    }
  }
  if (kind === "promote" && segments.length === 2) {
    const lineId = segments[1];
    if (lineId !== undefined && lineId.length > 0) {
      return { kind: "promote", lineId };
    }
  }
  throw new UsageFault(
    `--intent "${value}" is not an operator intent — the declared spellings are` +
      " release, release-anyway, prerelease:<stream>:<lineId>," +
      " release-as:<version>, promote:<lineId>; an id may not carry the `:` separator itself",
  );
};
