/**
 * The world document (phase 12 contract §2.4): the CLI's `--world` value
 * is a verbatim `PlanningInput` in JSON — the same value the direct
 * boundary caller would have constructed, with `intents` present or
 * absent exactly as the document declares. The check here is structural
 * only: field names, shapes, and kinds — never semantics (a semantically
 * wrong document is the caller's declared lie and is executed as
 * declared, which is how the exit-70 mint fault is reachable through
 * public grammar). A document that fails the shape check is a usage
 * fault, exit 64, before any engine sees it. A missing file or invalid
 * JSON is likewise usage — the boundary value was never delivered.
 */

import { readFileSync } from "node:fs";

import type { PlanningInput } from "../index.js";

import { UsageFault } from "./parse.js";

const notShaped = (at: string, problem: string): UsageFault =>
  new UsageFault(
    `${at} ${problem} — the world document is not PlanningInput-shaped (phase 12 contract §2.4)`,
  );

const asObject = (value: unknown, at: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw notShaped(at, "must be a JSON object");
  }
  return value as Record<string, unknown>;
};

const asArray = (value: unknown, at: string): readonly unknown[] => {
  if (!Array.isArray(value)) {
    throw notShaped(at, "must be a JSON array");
  }
  return value;
};

const asString = (value: unknown, at: string): string => {
  if (typeof value !== "string") {
    throw notShaped(at, "must be a string");
  }
  return value;
};

const asNumber = (value: unknown, at: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw notShaped(at, "must be a finite number");
  }
  return value;
};

const asBoolean = (value: unknown, at: string): boolean => {
  if (typeof value !== "boolean") {
    throw notShaped(at, "must be a boolean");
  }
  return value;
};

const asStrings = (value: unknown, at: string): readonly string[] =>
  asArray(value, at).map((item, index) => asString(item, `${at}[${String(index)}]`));

const asOptional = (value: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(value, key) ? value[key] : undefined;

const checkPolicy = (value: unknown): void => {
  const at = "policy";
  const policy = asObject(value, at);
  asString(policy.digest, `${at}.digest`);
  asString(policy.bumpMappingId, `${at}.bumpMappingId`);
  asString(policy.selfReferenceNamespace, `${at}.selfReferenceNamespace`);
  asStrings(policy.prereleaseLadder, `${at}.prereleaseLadder`);
  const seed = asString(policy.prereleaseSeed, `${at}.prereleaseSeed`);
  if (seed !== "0" && seed !== "1") {
    throw notShaped(`${at}.prereleaseSeed`, 'must be "0" or "1"');
  }
  asBoolean(policy.pre10Dampening, `${at}.pre10Dampening`);
  const tagFormats = asObject(policy.tagFormats, `${at}.tagFormats`);
  for (const lineId of Object.keys(tagFormats)) {
    asString(tagFormats[lineId], `${at}.tagFormats["${lineId}"]`);
  }
};

const checkCommits = (value: unknown): void => {
  const commits = asArray(value, "repository.commits");
  commits.forEach((item, index) => {
    const at = `repository.commits[${String(index)}]`;
    const commit = asObject(item, at);
    asString(commit.sha, `${at}.sha`);
    asString(commit.message, `${at}.message`);
    asString(commit.committedAt, `${at}.committedAt`);
    asStrings(commit.parents, `${at}.parents`);
    asStrings(commit.containingRefs, `${at}.containingRefs`);
  });
};

const checkRefs = (value: unknown): void => {
  const refs = asArray(value, "repository.refs");
  refs.forEach((item, index) => {
    const at = `repository.refs[${String(index)}]`;
    const ref = asObject(item, at);
    asString(ref.name, `${at}.name`);
    asString(ref.head, `${at}.head`);
  });
};

const checkTags = (value: unknown): void => {
  const tags = asArray(value, "history.tags");
  tags.forEach((item, index) => {
    const at = `history.tags[${String(index)}]`;
    const tag = asObject(item, at);
    asString(tag.name, `${at}.name`);
    asString(tag.commit, `${at}.commit`);
  });
};

const checkLines = (value: unknown): void => {
  const lines = asArray(value, "lines");
  lines.forEach((item, index) => {
    const at = `lines[${String(index)}]`;
    const line = asObject(item, at);
    asString(line.id, `${at}.id`);
    asString(line.feedRef, `${at}.feedRef`);
    const lifecycle = asString(line.lifecycle, `${at}.lifecycle`);
    if (lifecycle !== "active" && lifecycle !== "frozen" && lifecycle !== "retired") {
      throw notShaped(`${at}.lifecycle`, 'must be "active" | "frozen" | "retired"');
    }
    asBoolean(line.declared, `${at}.declared`);
    const versionBand = asOptional(line, "versionBand");
    if (versionBand !== undefined) {
      const band = asObject(versionBand, `${at}.versionBand`);
      asNumber(band.major, `${at}.versionBand.major`);
      const minor = asOptional(band, "minor");
      if (minor !== undefined) {
        asNumber(minor, `${at}.versionBand.minor`);
      }
    }
    const streams = asOptional(line, "streams");
    if (streams !== undefined) {
      const streamPolicy = asObject(streams, `${at}.streams`);
      const allow = asOptional(streamPolicy, "allow");
      if (allow !== undefined && allow !== "all" && allow !== "none") {
        asStrings(allow, `${at}.streams.allow`);
      }
      const seed = asOptional(streamPolicy, "seed");
      if (seed !== undefined) {
        const streamSeed = asString(seed, `${at}.streams.seed`);
        if (streamSeed !== "0" && streamSeed !== "1") {
          throw notShaped(`${at}.streams.seed`, 'must be "0" or "1"');
        }
      }
    }
    const withhold = asOptional(line, "withhold");
    if (withhold !== undefined) {
      asArray(withhold, `${at}.withhold`).forEach((item, ruleIndex) => {
        const ruleAt = `${at}.withhold[${String(ruleIndex)}]`;
        const rule = asObject(item, ruleAt);
        asString(rule.scope, `${ruleAt}.scope`);
        asString(rule.reason, `${ruleAt}.reason`);
      });
    }
    const publishes = asOptional(line, "publishes");
    if (publishes !== undefined) {
      asString(publishes, `${at}.publishes`);
    }
  });
};

const checkComponents = (value: unknown): void => {
  const components = asArray(value, "components");
  components.forEach((item, index) => {
    const at = `components[${String(index)}]`;
    const component = asObject(item, at);
    asString(component.name, `${at}.name`);
    asString(component.manifestVersion, `${at}.manifestVersion`);
    asStrings(component.paths, `${at}.paths`);
    const dependencies = asOptional(component, "dependencies");
    if (dependencies !== undefined) {
      asArray(dependencies, `${at}.dependencies`).forEach((item, edgeIndex) => {
        const edgeAt = `${at}.dependencies[${String(edgeIndex)}]`;
        const edge = asObject(item, edgeAt);
        asString(edge.name, `${edgeAt}.name`);
        asString(edge.range, `${edgeAt}.range`);
      });
    }
  });
};

const checkBootstrap = (value: unknown): void => {
  const bootstrap = asObject(value, "bootstrap");
  asString(bootstrap.version, "bootstrap.version");
  asString(bootstrap.who, "bootstrap.who");
  asString(bootstrap.when, "bootstrap.when");
};

const checkIntents = (value: unknown): void => {
  const intents = asArray(value, "intents");
  intents.forEach((item, index) => {
    const at = `intents[${String(index)}]`;
    const intent = asObject(item, at);
    const kind = asString(intent.kind, `${at}.kind`);
    switch (kind) {
      case "release":
      case "release-anyway":
        return;
      case "prerelease":
        asString(intent.stream, `${at}.stream`);
        asString(intent.lineId, `${at}.lineId`);
        return;
      case "release-as":
        asString(intent.version, `${at}.version`);
        return;
      case "promote":
        asString(intent.lineId, `${at}.lineId`);
        return;
      default:
        throw notShaped(`${at}.kind`, `is not an operator-intent kind ("${kind}")`);
    }
  });
};

const checkChannels = (value: unknown): void => {
  const channels = asArray(value, "channels");
  channels.forEach((item, index) => {
    const at = `channels[${String(index)}]`;
    const channel = asObject(item, at);
    asString(channel.id, `${at}.id`);
    const target = asObject(channel.target, `${at}.target`);
    asString(target.line, `${at}.target.line`);
    asString(target.version, `${at}.target.version`);
  });
};

/** Read the `--world` value: a filesystem path, or `-` for stdin
 * (§2.2). Returns the parsed, structurally-checked boundary value. */
export const readWorldDocument = (location: string): PlanningInput => {
  let text: string;
  try {
    text = readFileSync(location === "-" ? 0 : location, "utf8");
  } catch {
    throw new UsageFault(
      location === "-"
        ? "the world document on stdin could not be read"
        : `the world document at "${location}" could not be read`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new UsageFault("the world document is not valid JSON");
  }
  const document = asObject(parsed, "the world document");
  checkPolicy(document.policy);
  const repository = asObject(document.repository, "repository");
  checkCommits(repository.commits);
  checkRefs(repository.refs);
  const history = asObject(document.history, "history");
  checkTags(history.tags);
  checkLines(document.lines);
  const components = asOptional(document, "components");
  if (components !== undefined) {
    checkComponents(components);
  }
  const bootstrap = asOptional(document, "bootstrap");
  if (bootstrap !== undefined) {
    checkBootstrap(bootstrap);
  }
  const intents = asOptional(document, "intents");
  if (intents !== undefined) {
    checkIntents(intents);
  }
  const channels = asOptional(document, "channels");
  if (channels !== undefined) {
    checkChannels(channels);
  }
  return document as unknown as PlanningInput;
};
