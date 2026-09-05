/**
 * The planner's input-boundary door (§2.1) — `normalize` deep-validates a
 * `PlanningInput` and returns the same value unchanged.
 *
 * Posture: a malformed `PlanningInput` is a caller contract violation, not
 * a planning outcome — this throws {@link InvalidPlanningInputError} naming
 * every violation (field path + problem), never just the first, so a caller
 * fixes its fixture in one pass. Validation-only normalization: the closed
 * input is returned as-is — no default-filling (the planner invents
 * nothing), no copying, no freezing (caller-owned data stays caller-owned;
 * the planner mutates nothing, PL-08).
 *
 * Determinism: violations are collected in a fixed traversal order — policy
 * fields in declaration order, then commits, refs, tags, lines, intents,
 * input order within each — so identical inputs yield identical violation
 * lists and messages (ADR-0003's deterministic planner starts at its
 * boundary). Object key order for `tagFormats` is the input's own
 * insertion order, stable for identical input.
 *
 * Purity: no environment, clock, filesystem, or network (invariant 2). The
 * module is a pure predicate over its argument.
 *
 * Contract: docs/design/phase2-planner-contract.md §2.1 (the closed input
 * boundary); ADR docs/adr/0003-deterministic-release-planner.md.
 */

import type { NormalizeInput, PlanningInput } from "./types.js";

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
 * violation (all of them), else return the same closed value.
 */
export const normalize: NormalizeInput = (raw) => {
  const violations: InputViolation[] = [];
  validate(raw, violations);
  if (violations.length > 0) throw new InvalidPlanningInputError(violations);
  return raw;
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

  const lines: unknown = raw.lines;
  if (isArray(lines)) checkLines(lines, out);
  else out.push({ field: "lines", problem: "must be an array of line configurations" });

  const intents: unknown = raw.intents;
  if (intents === undefined) return;
  if (isArray(intents)) checkIntents(intents, out);
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
      if (!nonEmpty(tagFormats[lineId])) {
        out.push({
          field: `policy.tagFormats[${JSON.stringify(lineId)}]`,
          problem: "must be a non-empty tag format",
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

/** Line validation (§2.6): at least one line, unique ids, closed schema. */
function checkLines(lines: readonly unknown[], out: InputViolation[]): void {
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
  }
}

/** Intent validation (§2.1): the declared kinds, with their payloads. */
function checkIntents(intents: readonly unknown[], out: InputViolation[]): void {
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
      kind !== "release-as"
    ) {
      out.push({
        field: `intents[${String(i)}].kind`,
        problem: `unknown intent kind ${JSON.stringify(kind)} — the declared kinds are release, release-anyway, prerelease, release-as`,
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
        break;
      case "release-as":
        if (!nonEmpty(intent.version)) {
          out.push({
            field: `intents[${String(i)}].version`,
            problem: "must be a non-empty release-as version",
          });
        }
        break;
    }
  }
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
