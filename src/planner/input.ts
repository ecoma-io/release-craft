/**
 * The planner's input-boundary door (§2.1) — `normalize` deep-validates a
 * `PlanningInput` and returns it with one normalization: exact-duplicate
 * operator intents collapse to their first occurrence (m-6b — an operator
 * stating one intent twice has stated it once; intents differing in any
 * field stay, since contradictions like promote-over-pending are
 * decide-layer concerns, never input-layer ones).
 *
 * Posture: a malformed `PlanningInput` is a caller contract violation, not
 * a planning outcome — this throws {@link InvalidPlanningInputError} naming
 * every violation (field path + problem), never just the first, so a caller
 * fixes its fixture in one pass. Otherwise validation-only: the closed
 * input is returned as-is (the same reference when no intent duplicated) —
 * no default-filling (the planner invents nothing), no deep copying, no
 * freezing (caller-owned data stays caller-owned; the planner mutates
 * nothing, PL-08).
 *
 * Determinism: violations are collected in a fixed traversal order — policy
 * fields in declaration order, then commits, refs, tags, lines, components,
 * bootstrap, intents, input order within each — so identical inputs yield
 * identical violation lists and messages (ADR-0003's deterministic planner
 * starts at its boundary). Object key order for `tagFormats` is the input's
 * own insertion order, stable for identical input.
 *
 * Purity: no environment, clock, filesystem, or network (invariant 2). The
 * module is a pure function over its argument.
 *
 * Contract: docs/design/phase2-planner-contract.md §2.1 (the closed input
 * boundary); ADR docs/adr/0003-deterministic-release-planner.md.
 */

import { InvalidVersionError, Version } from "@ecoma-io/release-craft/domain";

import type { NormalizeInput, OperatorIntent, PlanningInput } from "./types.js";

/**
 * One reported violation: `field` is a path into the planning input (e.g.
 * `repository.commits[2].parents[0]`), `problem` says what is wrong with it.
 */
export interface InputViolation {
  readonly field: string;
  readonly problem: string;
}

/**
 * The one error `normalize` raises, for every rejected input — a summary
 * message naming every violated field, plus the full violation list in
 * deterministic order. `attribute.ts` reuses this error for range
 * validation: same posture, same door.
 */
export class InvalidPlanningInputError extends Error {
  /** Every violation, in fixed traversal order — never just the first. */
  public readonly violations: readonly InputViolation[];

  public constructor(violations: readonly InputViolation[]) {
    super(summarize(violations));
    this.name = "InvalidPlanningInputError";
    this.violations = violations;
  }
}

/** The message: one line, naming every field with its problem, in order. */
function summarize(violations: readonly InputViolation[]): string {
  const detail = violations
    .map((violation) => `${violation.field}: ${violation.problem}`)
    .join("; ");
  return violations.length === 1
    ? `invalid planning input — 1 violation: ${detail}`
    : `invalid planning input — ${String(violations.length)} violations: ${detail}`;
}

/**
 * The locked `NormalizeInput` implementation: validate deeply, throw on any
 * violation (all of them), else return the closed value with exact-duplicate
 * intents collapsed (m-6b) — the same reference when nothing was dropped.
 */
export const normalize: NormalizeInput = (raw) => {
  const violations: InputViolation[] = [];
  validate(raw, violations);
  if (violations.length > 0) throw new InvalidPlanningInputError(violations);
  if (raw.intents === undefined) return raw;
  const intents = dedupeIntents(raw.intents);
  return intents.length === raw.intents.length ? raw : { ...raw, intents };
};

/**
 * Validates `raw` deeply, appending one violation per defect to `out`. The
 * traversal order here is the reported order — keep it stable.
 */
function validate(raw: PlanningInput, out: InputViolation[]): void {
  if (!isObject(raw)) {
    out.push({ field: "input", problem: "must be a planning input object" });
    return;
  }

  const policy: unknown = raw.policy;
  if (isObject(policy)) checkPolicy(policy, out);
  else out.push({ field: "policy", problem: "must be a policy object" });

  // The observed sha universe is closed: parents, ref heads, and tag
  // bindings may only point into it, so it is built once up front — from
  // every well-formed sha, wherever the commits sit in the array (a
  // parent may be observed after its child). It stays empty when the
  // commit array itself is malformed: that defect is reported on its own
  // field, and every pointer into an empty universe is then rejected too.
  let shas: ReadonlySet<string> = new Set<string>();

  const repository: unknown = raw.repository;
  if (!isObject(repository)) {
    out.push({ field: "repository", problem: "must be a repository observations object" });
  } else {
    const commits: unknown = repository.commits;
    if (isArray(commits)) {
      shas = observedShas(commits);
      checkCommits(commits, shas, out);
    } else {
      out.push({ field: "repository.commits", problem: "must be an array of commit observations" });
    }

    const refs: unknown = repository.refs;
    if (isArray(refs)) checkRefs(refs, shas, out);
    else out.push({ field: "repository.refs", problem: "must be an array of ref observations" });
  }

  const history: unknown = raw.history;
  if (!isObject(history)) {
    out.push({ field: "history", problem: "must be a history object" });
  } else {
    const tags: unknown = history.tags;
    if (isArray(tags)) checkTags(tags, shas, out);
    else out.push({ field: "history.tags", problem: "must be an array of tag observations" });
  }

  // The declared line-id universe is closed: a lineId payload on an intent
  // may only name a line declared here (mirrors the sha universe — built
  // from every well-formed id wherever the lines sit in the array, empty
  // when the array itself is malformed; that defect is reported on its own
  // field, and every lineId pointing into the empty universe is rejected).
  let declaredLines: ReadonlySet<string> = new Set<string>();

  // The declared component-name universe is closed: a line's `publishes`
  // binding may only name a component declared here (ADR-0004 Decision 4;
  // mirrors the sha and line-id universes — built from every well-formed
  // name wherever the components sit in the array, empty when the array is
  // absent or malformed; that defect is reported on its own field, and
  // every `publishes` pointing into the empty universe is rejected).
  const components: unknown = raw.components;
  const declaredComponents: ReadonlySet<string> = isArray(components)
    ? declaredComponentNames(components)
    : new Set<string>();

  const lines: unknown = raw.lines;
  if (isArray(lines)) {
    declaredLines = declaredLineIds(lines);
    checkLines(lines, declaredComponents, out);
  } else {
    out.push({ field: "lines", problem: "must be an array of line configurations" });
  }

  if (components !== undefined) {
    if (isArray(components)) checkComponents(components, out);
    else out.push({ field: "components", problem: "must be an array of component metadata" });
  }

  const channels: unknown = raw.channels;
  if (channels !== undefined) {
    if (isArray(channels)) checkChannels(channels, out);
    else
      out.push({ field: "channels", problem: "must be an array of declared channel observations" });
  }

  const bootstrap: unknown = raw.bootstrap;
  if (bootstrap === undefined) {
    // S-02: absence is legal at this boundary — demanding the recorded
    // decision is a `blocked` record at the planning boundary, not a
    // violation here.
  } else if (!isObject(bootstrap)) {
    out.push({ field: "bootstrap", problem: "must be a bootstrap decision object" });
  } else if (!parsesAsVersion(bootstrap.version)) {
    // S-02: the recorded bootstrap is authoritative — D17 consumes it
    // verbatim as a line's first release target, so an unparseable version
    // can never be repaired downstream.
    out.push({
      field: "bootstrap.version",
      problem: `must parse as a kernel Version — ${JSON.stringify(bootstrap.version)} does not (strict SemVer 2.0.0)`,
    });
  }

  const intents: unknown = raw.intents;
  if (intents === undefined) return;
  if (isArray(intents)) checkIntents(intents, declaredLines, out);
  else out.push({ field: "intents", problem: "must be an array of operator intents" });
}

/** Policy validation (§2.1), fields in declaration order. */
function checkPolicy(policy: Record<string, unknown>, out: InputViolation[]): void {
  if (!nonEmpty(policy.digest)) {
    out.push({ field: "policy.digest", problem: "must be a non-empty policy digest" });
  } else if (policy.digest.trim() !== policy.digest) {
    // A digest is opaque content identity, stored verbatim (the kernel's
    // opaque-string door: a padded value is a data error, never trimmed).
    out.push({
      field: "policy.digest",
      problem: "must not be padded — a digest is stored verbatim",
    });
  }

  if (!nonEmpty(policy.bumpMappingId)) {
    out.push({
      field: "policy.bumpMappingId",
      problem: "must be a non-empty bump mapping identifier (§2.7)",
    });
  } else if (policy.bumpMappingId !== "default") {
    // m-1/m-2 (D17): Phase 2 declares exactly one mapping, keyed "default"
    // (§2.7). A policy may carry the id, but any other value has no mapping
    // behind it — refuse rather than resolve silently; the mapping itself
    // stays the default.
    out.push({
      field: "policy.bumpMappingId",
      problem: `must be exactly "default" — the only declared bump mapping in this phase, not ${JSON.stringify(policy.bumpMappingId)}`,
    });
  }

  const ladder: unknown = policy.prereleaseLadder;
  if (!isArray(ladder)) {
    out.push({
      field: "policy.prereleaseLadder",
      problem: "must be an array of prerelease rungs (§2.8)",
    });
  } else if (ladder.length === 0) {
    out.push({
      field: "policy.prereleaseLadder",
      problem: "must declare at least one prerelease rung (§2.8)",
    });
  } else {
    for (const [i, rung] of ladder.entries()) {
      if (!nonEmpty(rung)) {
        out.push({
          field: `policy.prereleaseLadder[${String(i)}]`,
          problem: "must be a non-empty rung name",
        });
      }
    }
  }

  const seed: unknown = policy.prereleaseSeed;
  if (seed !== "0" && seed !== "1") {
    out.push({
      field: "policy.prereleaseSeed",
      problem: `must be "0" or "1" — the declared seed policy for fresh streams, not ${JSON.stringify(seed)}`,
    });
  }

  const namespace: unknown = policy.selfReferenceNamespace;
  if (!nonEmpty(namespace)) {
    out.push({
      field: "policy.selfReferenceNamespace",
      problem: "must be a non-empty self-reference namespace (§2.12)",
    });
  } else if (!namespace.endsWith(":")) {
    // §2.12: a message line carries the namespace iff it starts exactly
    // with it — a prefix without its colon cannot close a marker.
    out.push({
      field: "policy.selfReferenceNamespace",
      problem:
        "must end with ':' — the namespace is the exact line prefix self-references carry (§2.12)",
    });
  }

  const tagFormats: unknown = policy.tagFormats;
  if (!isObject(tagFormats)) {
    out.push({ field: "policy.tagFormats", problem: "must be an object keyed by line id" });
  } else {
    for (const lineId of Object.keys(tagFormats)) {
      if (lineId.length === 0) {
        out.push({
          field: 'policy.tagFormats[""]',
          problem: "tag-format key must be a non-empty line id",
        });
      }
      const format: unknown = tagFormats[lineId];
      if (!nonEmpty(format)) {
        out.push({
          field: `policy.tagFormats[${JSON.stringify(lineId)}]`,
          problem: "must be a non-empty tag format",
        });
      } else if (!format.includes("{prerelease}")) {
        // D15/fork 11: a line publishes stable and prerelease versions under
        // one declared format — without the {prerelease} token the format
        // cannot name a prerelease mint, so it can never render the line's
        // full namespace.
        out.push({
          field: `policy.tagFormats[${JSON.stringify(lineId)}]`,
          problem:
            "must contain the {prerelease} token — a format without it cannot render prereleases (fork 11)",
        });
      }
    }
  }
}

/** The closed universe of observed commit identities. */
function observedShas(commits: readonly unknown[]): Set<string> {
  const shas = new Set<string>();
  for (const commit of commits) {
    const sha: unknown = isObject(commit) ? commit.sha : undefined;
    if (nonEmpty(sha)) shas.add(sha);
  }
  return shas;
}

/** Commit validation (§2.2): unique non-empty shas, closed parent sets. */
function checkCommits(
  commits: readonly unknown[],
  shas: ReadonlySet<string>,
  out: InputViolation[],
): void {
  const seen = new Set<string>();
  for (const [i, commit] of commits.entries()) {
    if (!isObject(commit)) {
      out.push({
        field: `repository.commits[${String(i)}]`,
        problem: "must be a commit observation",
      });
      continue;
    }
    const sha: unknown = commit.sha;
    if (!nonEmpty(sha)) {
      // No identity — downstream identity checks on this entry would
      // misreport, so its one violation is the sha itself.
      out.push({
        field: `repository.commits[${String(i)}].sha`,
        problem: "must be a non-empty commit sha",
      });
      continue;
    }
    if (seen.has(sha)) {
      out.push({
        field: `repository.commits[${String(i)}].sha`,
        problem: `duplicate commit sha ${sha} — each observed commit must appear exactly once`,
      });
    } else {
      seen.add(sha);
    }

    const parents: unknown = commit.parents;
    if (!isArray(parents)) {
      out.push({
        field: `repository.commits[${String(i)}].parents`,
        problem: "must be an array of parent shas",
      });
      continue;
    }
    for (const [j, parent] of parents.entries()) {
      if (!nonEmpty(parent) || !shas.has(parent)) {
        out.push({
          field: `repository.commits[${String(i)}].parents[${String(j)}]`,
          problem: `parent ${JSON.stringify(parent)} is not an observed commit — the input is closed: every referenced parent must be observed`,
        });
      }
    }
  }
}

/** Ref validation (§2.2): unique names, heads inside the closed sha set. */
function checkRefs(
  refs: readonly unknown[],
  shas: ReadonlySet<string>,
  out: InputViolation[],
): void {
  const seen = new Set<string>();
  for (const [i, ref] of refs.entries()) {
    if (!isObject(ref)) {
      out.push({ field: `repository.refs[${String(i)}]`, problem: "must be a ref observation" });
      continue;
    }
    const name: unknown = ref.name;
    if (!nonEmpty(name)) {
      out.push({
        field: `repository.refs[${String(i)}].name`,
        problem: "must be a non-empty ref name",
      });
    } else if (seen.has(name)) {
      out.push({
        field: `repository.refs[${String(i)}].name`,
        problem: `duplicate ref name ${name} — each observed ref must appear exactly once`,
      });
    } else {
      seen.add(name);
    }
    const head: unknown = ref.head;
    if (!nonEmpty(head) || !shas.has(head)) {
      out.push({
        field: `repository.refs[${String(i)}].head`,
        problem: `head ${JSON.stringify(head)} is not an observed commit — the input is closed`,
      });
    }
  }
}

/** Tag validation (§2.13): unique names, bindings inside the sha set. */
function checkTags(
  tags: readonly unknown[],
  shas: ReadonlySet<string>,
  out: InputViolation[],
): void {
  const seen = new Set<string>();
  for (const [i, tag] of tags.entries()) {
    if (!isObject(tag)) {
      out.push({ field: `history.tags[${String(i)}]`, problem: "must be a tag observation" });
      continue;
    }
    const name: unknown = tag.name;
    if (!nonEmpty(name)) {
      out.push({
        field: `history.tags[${String(i)}].name`,
        problem: "must be a non-empty tag name",
      });
    } else if (seen.has(name)) {
      out.push({
        field: `history.tags[${String(i)}].name`,
        problem: `duplicate tag name ${name} — each observed tag must appear exactly once`,
      });
    } else {
      seen.add(name);
    }
    const bound: unknown = tag.commit;
    if (!nonEmpty(bound) || !shas.has(bound)) {
      out.push({
        field: `history.tags[${String(i)}].commit`,
        problem: `bound commit ${JSON.stringify(bound)} is not an observed commit — the input is closed`,
      });
    }
  }
}

/** Line validation (§2.6): at least one line, unique ids, closed schema,
 * and the declared line policy (ADR-0004): the stream policy inside its
 * declared fork, withhold rules that can be explained, and a `publishes`
 * binding naming a declared component. */
function checkLines(
  lines: readonly unknown[],
  declaredComponents: ReadonlySet<string>,
  out: InputViolation[],
): void {
  if (lines.length === 0) {
    out.push({ field: "lines", problem: "must declare at least one release line" });
    return;
  }
  const seen = new Set<string>();
  for (const [i, line] of lines.entries()) {
    if (!isObject(line)) {
      out.push({ field: `lines[${String(i)}]`, problem: "must be a line configuration" });
      continue;
    }
    const id: unknown = line.id;
    if (!nonEmpty(id)) {
      // The stable line identity (invariant 7) — never a branch name, and
      // never empty: every record, range, and attribution keys on it.
      out.push({
        field: `lines[${String(i)}].id`,
        problem: "must be a non-empty line id — the stable line identity (invariant 7)",
      });
    } else if (seen.has(id)) {
      out.push({
        field: `lines[${String(i)}].id`,
        problem: `duplicate line id ${id} — line identity is unique (invariant 7)`,
      });
    } else {
      seen.add(id);
    }
    const feedRef: unknown = line.feedRef;
    if (!nonEmpty(feedRef)) {
      out.push({ field: `lines[${String(i)}].feedRef`, problem: "must be a non-empty feed ref" });
    }
    const lifecycle: unknown = line.lifecycle;
    if (lifecycle !== "active" && lifecycle !== "frozen" && lifecycle !== "retired") {
      out.push({
        field: `lines[${String(i)}].lifecycle`,
        problem: `must be one of "active", "frozen", "retired", not ${JSON.stringify(lifecycle)}`,
      });
    }
    const streams: unknown = line.streams;
    if (streams !== undefined) {
      if (!isObject(streams)) {
        out.push({
          field: `lines[${String(i)}].streams`,
          problem: "must be a stream policy object",
        });
      } else {
        checkLineStreams(`lines[${String(i)}].streams`, streams, out);
      }
    }
    const withhold: unknown = line.withhold;
    if (withhold !== undefined) {
      if (!isArray(withhold)) {
        out.push({
          field: `lines[${String(i)}].withhold`,
          problem: "must be an array of withhold rules",
        });
      } else {
        checkLineWithhold(`lines[${String(i)}].withhold`, withhold, out);
      }
    }
    const publishes: unknown = line.publishes;
    if (publishes !== undefined) {
      checkLinePublishes(`lines[${String(i)}].publishes`, publishes, declaredComponents, out);
    }
  }
}

/** Channel-registry validation (ADR-0012 decision 2): each entry names a
 * channel id and the line+version it currently points at. Every declared
 * id is unique — a registry naming one channel twice has no deterministic
 * observation order — and every target version parses through the kernel
 * grammar (the same posture as the bootstrap version: an unparseable
 * declaration can never be repaired downstream). */
function checkChannels(channels: readonly unknown[], out: InputViolation[]): void {
  const seen = new Set<string>();
  for (const [i, channel] of channels.entries()) {
    const field = `channels[${String(i)}]`;
    if (!isObject(channel)) {
      out.push({ field, problem: "must be a channel observation (id + target)" });
      continue;
    }
    if (!nonEmpty(channel.id)) {
      out.push({ field: `${field}.id`, problem: "must be a non-empty channel id" });
    } else if (seen.has(channel.id)) {
      out.push({
        field: `${field}.id`,
        problem: `duplicates channel ${JSON.stringify(channel.id)} — a declared registry names each channel once`,
      });
    } else {
      seen.add(channel.id);
    }
    const target: unknown = channel.target;
    if (!isObject(target)) {
      out.push({ field: `${field}.target`, problem: "must be a target (line + version)" });
      continue;
    }
    if (!nonEmpty(target.line)) {
      out.push({ field: `${field}.target.line`, problem: "must be a non-empty line id" });
    }
    if (!parsesAsVersion(target.version)) {
      out.push({
        field: `${field}.target.version`,
        problem: `must parse as a kernel Version — ${JSON.stringify(target.version)} does not (strict SemVer 2.0.0)`,
      });
    }
  }
}

/** Component validation (§2.15, D16): declared names are the graph's
 * identity universe — every name non-empty. A dependency edge naming an
 * undeclared component is D16's caller contract violation, surfaced by the
 * propagation planner naming the edge (`planPropagation`), not duplicated
 * here. */
function checkComponents(components: readonly unknown[], out: InputViolation[]): void {
  for (const [i, component] of components.entries()) {
    if (!isObject(component)) {
      out.push({
        field: `components[${String(i)}]`,
        problem: "must be a component metadata object",
      });
      continue;
    }
    if (!nonEmpty(component.name)) {
      out.push({
        field: `components[${String(i)}].name`,
        problem: "must be a non-empty component name",
      });
    }
  }
}

/** Stream-policy validation (§2.8, D18): `allow` is `"all"`, `"none"`, or a
 * list of stream identifiers — an opaque identifier is legal by declaration
 * (fork 4), the list names each identifier exactly once, and the empty list
 * is valid data (the line mints no streams). `seed` overrides
 * `policy.prereleaseSeed` per line and obeys the same declared fork. */
function checkLineStreams(
  field: string,
  streams: Record<string, unknown>,
  out: InputViolation[],
): void {
  const allow: unknown = streams.allow;
  if (allow !== undefined && allow !== "all" && allow !== "none") {
    if (!isArray(allow)) {
      out.push({
        field: `${field}.allow`,
        problem: `must be "all", "none", or a list of stream identifiers, not ${JSON.stringify(allow)}`,
      });
    } else {
      const seen = new Set<string>();
      for (const [j, identifier] of allow.entries()) {
        if (!nonEmpty(identifier)) {
          out.push({
            field: `${field}.allow[${String(j)}]`,
            problem: "must be a non-empty stream identifier",
          });
        } else if (seen.has(identifier)) {
          out.push({
            field: `${field}.allow[${String(j)}]`,
            problem: `duplicate stream identifier ${identifier} — the allow list must name each identifier exactly once`,
          });
        } else {
          seen.add(identifier);
        }
      }
    }
  }

  const seed: unknown = streams.seed;
  if (seed !== undefined && seed !== "0" && seed !== "1") {
    out.push({
      field: `${field}.seed`,
      problem: `must be "0" or "1" — the declared seed policy for fresh streams, not ${JSON.stringify(seed)}`,
    });
  }
}

/** Withhold-rule validation (§2.9, D18, PL-07): every rule names a
 * non-empty scope and carries a non-empty reason — the reason rides the
 * plan's explanation verbatim, so an empty one is a silent exclusion. */
function checkLineWithhold(field: string, rules: readonly unknown[], out: InputViolation[]): void {
  for (const [j, rule] of rules.entries()) {
    if (!isObject(rule)) {
      out.push({ field: `${field}[${String(j)}]`, problem: "must be a withhold rule" });
      continue;
    }
    if (!nonEmpty(rule.scope)) {
      out.push({
        field: `${field}[${String(j)}].scope`,
        problem: "must be a non-empty withhold scope",
      });
    }
    if (!nonEmpty(rule.reason)) {
      out.push({
        field: `${field}[${String(j)}].reason`,
        problem:
          "must be a non-empty withhold reason — the reason rides the plan's explanation verbatim",
      });
    }
  }
}

/** A `publishes` binding names the declared component the line's releases
 * publish through the door (ADR-0004 Decision 4) — naming an undeclared
 * component is D16's closed-universe rule on the line axis: the binding
 * has a gap, and an unfilled gap is a caller contract violation here, not
 * a fabricated release downstream. */
function checkLinePublishes(
  field: string,
  publishes: unknown,
  declaredComponents: ReadonlySet<string>,
  out: InputViolation[],
): void {
  if (!nonEmpty(publishes)) {
    out.push({ field, problem: "must be a non-empty component name" });
  } else if (!declaredComponents.has(publishes)) {
    out.push({
      field,
      problem: `names undeclared component ${JSON.stringify(publishes)} — the component binding has a gap: a line may only publish through a declared component (ADR-0004 Decision 4)`,
    });
  }
}

/** Intent validation (§2.1, D17): the declared kinds, their payloads
 * kernel-typed (a `release-as` version parses as a `Version` through the
 * kernel's grammar), and every `lineId` naming a declared line — an intent
 * on an undeclared line is a caller contract violation, since line identity
 * is invariant 7's closed universe. */
function checkIntents(
  intents: readonly unknown[],
  declaredLines: ReadonlySet<string>,
  out: InputViolation[],
): void {
  for (const [i, intent] of intents.entries()) {
    if (!isObject(intent)) {
      out.push({ field: `intents[${String(i)}]`, problem: "must be an operator intent" });
      continue;
    }
    const kind: unknown = "kind" in intent ? intent.kind : undefined;
    if (
      kind !== "release" &&
      kind !== "release-anyway" &&
      kind !== "prerelease" &&
      kind !== "release-as" &&
      kind !== "promote"
    ) {
      out.push({
        field: `intents[${String(i)}].kind`,
        problem: `unknown intent kind ${JSON.stringify(kind)} — the declared kinds are release, release-anyway, prerelease, release-as, promote`,
      });
      continue;
    }
    switch (intent.kind) {
      case "release":
      case "release-anyway":
        break;
      case "prerelease":
        if (!nonEmpty(intent.stream)) {
          out.push({
            field: `intents[${String(i)}].stream`,
            problem: "must be a non-empty prerelease stream",
          });
        }
        checkIntentLineId(`intents[${String(i)}].lineId`, intent.lineId, declaredLines, out);
        break;
      case "release-as":
        if (!nonEmpty(intent.version)) {
          out.push({
            field: `intents[${String(i)}].version`,
            problem: "must be a non-empty release-as version",
          });
        } else if (!parsesAsVersion(intent.version)) {
          out.push({
            field: `intents[${String(i)}].version`,
            problem: `must parse as a kernel Version — ${JSON.stringify(intent.version)} does not (strict SemVer 2.0.0)`,
          });
        }
        break;
      case "promote":
        checkIntentLineId(`intents[${String(i)}].lineId`, intent.lineId, declaredLines, out);
        break;
    }
  }
}

/** A `lineId` payload must name a line declared in the same input. */
function checkIntentLineId(
  field: string,
  lineId: unknown,
  declaredLines: ReadonlySet<string>,
  out: InputViolation[],
): void {
  if (!nonEmpty(lineId)) {
    out.push({ field, problem: "must be a non-empty line id" });
  } else if (!declaredLines.has(lineId)) {
    out.push({
      field,
      problem: `names undeclared line ${JSON.stringify(lineId)} — an intent may only target a declared line`,
    });
  }
}

/** The kernel-grammar door (§2.13's only way into a `Version`): strict
 * SemVer 2.0.0 parse; false on `InvalidVersionError`, anything else
 * re-thrown. */
function parsesAsVersion(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    Version.parse(value);
    return true;
  } catch (error) {
    if (!(error instanceof InvalidVersionError)) throw error;
    return false;
  }
}

/** The declared line-id universe intents may target — from every
 * well-formed id, wherever the lines sit in the array. */
function declaredLineIds(lines: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const line of lines) {
    const id: unknown = isObject(line) ? line.id : undefined;
    if (nonEmpty(id)) ids.add(id);
  }
  return ids;
}

/** The declared component-name universe a line's `publishes` binding may
 * target — from every well-formed name, wherever the components sit in
 * the array. */
function declaredComponentNames(components: readonly unknown[]): Set<string> {
  const names = new Set<string>();
  for (const component of components) {
    const name: unknown = isObject(component) ? component.name : undefined;
    if (nonEmpty(name)) names.add(name);
  }
  return names;
}

/** m-6b's exact identity: the kind plus every payload field, so only
 * intents equal in all fields collapse. */
function intentIdentity(intent: OperatorIntent): string {
  switch (intent.kind) {
    case "prerelease":
      return JSON.stringify([intent.kind, intent.stream, intent.lineId]);
    case "release-as":
      return JSON.stringify([intent.kind, intent.version]);
    case "promote":
      return JSON.stringify([intent.kind, intent.lineId]);
    default:
      return JSON.stringify([intent.kind]);
  }
}

/** m-6b: exact-duplicate intents collapse to their first occurrence, input
 * order preserved; distinct intents always survive. */
function dedupeIntents(intents: readonly OperatorIntent[]): readonly OperatorIntent[] {
  const seen = new Set<string>();
  const unique: OperatorIntent[] = [];
  for (const intent of intents) {
    const identity = intentIdentity(intent);
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(intent);
  }
  return unique;
}

/** A required non-empty string — the baseline for every named field. */
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Runtime shape guard: the closed boundary can still hand over non-objects. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Runtime shape guard for the arrays the traversal walks. */
function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}
