/**
 * §2.4 — attribution: extracted changes mapped onto release lines by
 * ancestry, failing closed.
 *
 * The parent graph is the sole authority for span membership: a commit is
 * pending on a line exactly when it is reachable from the line's range head
 * and not reachable from (or equal to) its `releasedUpTo` bound (§2.2, §2.5)
 * — the released bound itself is never pending. `CommitObservation`
 * .containingRefs is input evidence and never decides membership
 * (invariant 15); no branch or ref name ever becomes a line identity
 * (invariant 7). When a commit sits inside two lines' pending spans with no
 * `lineage.originLine` tiebreaker, attribution fails closed with a `refused`
 * record naming the ambiguous commits (M-01, PL-05a, invariant 4) — never a
 * guess, never a "latest branch" shortcut. A change released on one line is
 * not thereby released on another (M-04, M-06, M-09): releasedness is
 * computed per line from that line's own released span.
 *
 * Refusals are checked in contract order: a malformed self-reference marker
 * inside any pending span fails toward explicit review before ambiguity is
 * considered (§2.12, PL-04).
 *
 * Ordering is stable everywhere (E-10, §2.14): lines in `input.lines` order,
 * commits and excluded entries in extraction order, released ids in
 * first-appearance order. The function is pure — no clock, no randomness, no
 * environment, no filesystem, no network (invariant 2).
 */

import { InvalidPlanningInputError } from "./input.js";
import type {
  AttributeChanges,
  ExcludedCommit,
  LineAttribution,
  LineRange,
  ParsedCommit,
  PlanningInput,
} from "./types.js";

/** The empty span, shared by lines without a supplied range (§2.4). */
const EMPTY_SPAN: ReadonlySet<string> = new Set<string>();

/** One caller-contract violation, as `input.ts`'s error records them. */
interface RangeProblem {
  readonly field: string;
  readonly problem: string;
}

/** Range malformation is a caller contract violation, not a planning
 * outcome (§2.2): every violation is collected — in `ranges` order — and
 * thrown at once, so a caller fixes its whole fixture in one pass. */
function validateRanges(ranges: readonly LineRange[], input: PlanningInput): void {
  const observed = new Set<string>();
  for (const commit of input.repository.commits) observed.add(commit.sha);
  const declared = new Set<string>();
  for (const line of input.lines) declared.add(line.id);

  const problems: RangeProblem[] = [];
  const ranged = new Set<string>();
  ranges.forEach((range, index) => {
    const at = `ranges[${String(index)}]`;
    if (ranged.has(range.lineId)) {
      // The duplicate occurrence reports only the duplication — the first
      // occurrence already reported an undeclared line id, and one root
      // cause yields one problem.
      problems.push({
        field: `${at}.lineId`,
        problem: `duplicate range for line "${range.lineId}"`,
      });
    } else {
      ranged.add(range.lineId);
      if (!declared.has(range.lineId)) {
        problems.push({
          field: `${at}.lineId`,
          problem: `line "${range.lineId}" is not declared in input.lines`,
        });
      }
    }
    if (!observed.has(range.head)) {
      problems.push({
        field: `${at}.head`,
        problem: `head "${range.head}" is not an observed commit sha`,
      });
    }
    if (range.releasedUpTo !== null && !observed.has(range.releasedUpTo)) {
      problems.push({
        field: `${at}.releasedUpTo`,
        problem: `releasedUpTo "${range.releasedUpTo}" is not an observed commit sha`,
      });
    }
  });
  if (problems.length > 0) throw new InvalidPlanningInputError(problems);
}

/** Ancestor sets over the observed parent graph, memoized per start sha:
 * `reachable(sha)` is `{sha}` plus every transitive parent. A parent sha
 * that was never observed is treated as a leaf — the planner invents no
 * observation (§2.1's closed input). */
function ancestryOf(
  commits: PlanningInput["repository"]["commits"],
): (sha: string) => ReadonlySet<string> {
  const parents = new Map<string, readonly string[]>();
  for (const commit of commits) parents.set(commit.sha, commit.parents);
  const cache = new Map<string, ReadonlySet<string>>();
  return (sha: string) => {
    const cached = cache.get(sha);
    if (cached !== undefined) return cached;
    const span = new Set<string>();
    const stack: string[] = [sha];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || span.has(current)) continue;
      span.add(current);
      for (const parent of parents.get(current) ?? []) {
        if (!span.has(parent)) stack.push(parent);
      }
    }
    cache.set(sha, span);
    return span;
  };
}

/** One line's evaluated spans (§2.4): pending = reachable(head) minus
 * reachable-or-equal(releasedUpTo); released = that reachable set. */
interface LineSpans {
  readonly pending: ReadonlySet<string>;
  readonly released: ReadonlySet<string>;
}

function spansFor(range: LineRange, ancestry: (sha: string) => ReadonlySet<string>): LineSpans {
  const released = range.releasedUpTo === null ? EMPTY_SPAN : ancestry(range.releasedUpTo);
  const pending = new Set<string>();
  for (const sha of ancestry(range.head)) {
    if (!released.has(sha)) pending.add(sha);
  }
  return { pending, released };
}

export const attribute: AttributeChanges = (extraction, input, ranges) => {
  validateRanges(ranges, input);

  const ancestry = ancestryOf(input.repository.commits);
  const pendingByLine = new Map<string, ReadonlySet<string>>();
  const releasedByLine = new Map<string, ReadonlySet<string>>();
  for (const range of ranges) {
    const spans = spansFor(range, ancestry);
    pendingByLine.set(range.lineId, spans.pending);
    releasedByLine.set(range.lineId, spans.released);
  }

  const inAnyPendingSpan = (sha: string): boolean => {
    for (const range of ranges) {
      if (pendingByLine.get(range.lineId)?.has(sha) === true) return true;
    }
    return false;
  };

  // Refusal check (a), before ambiguity (§2.12, PL-04): a malformed marker
  // inside any pending span fails toward explicit review. Shas stay in
  // extraction order.
  const malformed: string[] = [];
  for (const entry of extraction.excluded) {
    if (entry.rule !== "malformed-marker") continue;
    if (inAnyPendingSpan(entry.sha)) malformed.push(entry.sha);
  }
  if (malformed.length > 0) {
    // §2.9: the refusal is a record — cause, the commits it names, and the
    // policy digest that produced it (invariant 4, amendment A1). The frozen
    // surface carries `kind: "refused"` on both levels.
    return {
      kind: "refused",
      refusal: {
        kind: "refused",
        cause: "malformed-self-reference-marker",
        commits: malformed,
        policyDigest: input.policy.digest,
        detail: `malformed self-reference marker inside a pending span; explicit review required: ${malformed.join(", ")}`,
      },
    };
  }

  // Claiming: which lines' pending spans contain each sha (§2.4). A sha can
  // only be claimed once per line — range line ids are unique (validated).
  const claimsBySha = new Map<string, string[]>();
  for (const range of ranges) {
    for (const sha of pendingByLine.get(range.lineId) ?? EMPTY_SPAN) {
      const claims = claimsBySha.get(sha);
      if (claims === undefined) claimsBySha.set(sha, [range.lineId]);
      else if (!claims.includes(range.lineId)) claims.push(range.lineId);
    }
  }

  // Refusal check (b): a change inside two or more pending spans is
  // attributed where its lineage origin names a claiming line; otherwise the
  // planner fails closed, naming the lines that claim it. Ambiguity is a
  // pending-change question (§2.4): excluded commits never join a change set
  // (§2.12), so they surface per line below and cannot be ambiguous.
  // Ambiguous shas stay in extraction order.
  const lineOfTiebreak = new Map<string, string>();
  const ambiguous: string[] = [];
  for (const commit of extraction.commits) {
    if (commit.classification !== "change") continue;
    const claims = claimsBySha.get(commit.sha);
    if (claims === undefined || claims.length < 2) continue;
    const originLine = commit.change?.lineage.originLine;
    if (originLine !== undefined && claims.includes(originLine)) {
      lineOfTiebreak.set(commit.sha, originLine);
    } else {
      ambiguous.push(commit.sha);
    }
  }
  if (ambiguous.length > 0) {
    const perCommit = ambiguous.map((sha) => {
      const claims = claimsBySha.get(sha) ?? [];
      return `commit ${sha} is pending on lines [${claims.join(", ")}] with no lineage originLine tiebreak`;
    });
    return {
      kind: "refused",
      refusal: {
        kind: "refused",
        cause: "ambiguous-attribution",
        commits: ambiguous,
        policyDigest: input.policy.digest,
        detail: `ambiguous attribution: ${perCommit.join("; ")}`,
      },
    };
  }

  // Per-line assembly in input.lines order (§2.4, E-10). A line without a
  // supplied range contributes the empty attribution triple — attribution
  // covers every line, inventing no range for the un-ranged ones.
  const lines: LineAttribution[] = input.lines.map((line) => {
    const pendingSpan = pendingByLine.get(line.id);
    const releasedSpan = releasedByLine.get(line.id);
    if (pendingSpan === undefined || releasedSpan === undefined) {
      return { lineId: line.id, pending: [], released: [], excluded: [] };
    }
    const pending: ParsedCommit[] = [];
    const released: string[] = [];
    const seenReleased = new Set<string>();
    for (const commit of extraction.commits) {
      if (commit.classification !== "change") continue;
      if (pendingSpan.has(commit.sha)) {
        // A lineage tiebreak moves a multi-span commit to exactly one
        // claiming line (§2.4); everywhere else it is not pending.
        const tiebreak = lineOfTiebreak.get(commit.sha);
        if (tiebreak !== undefined && tiebreak !== line.id) continue;
        pending.push(commit);
      } else if (releasedSpan.has(commit.sha)) {
        // Released ids are distinct and first-appearance (extraction) order;
        // identity conflicts (M-05) collapse here by design — releasedness
        // is per (line, identity). The sha fallback is defensive only:
        // extraction guarantees `change` on entries classified `"change"`
        // (§2.3, invariant 9).
        const id = commit.change?.id ?? commit.sha;
        if (!seenReleased.has(id)) {
          seenReleased.add(id);
          released.push(id);
        }
      }
    }
    // Excluded commits inside the pending span surface per line, never
    // pending (§2.12, PL-04).
    const excluded: ExcludedCommit[] = [];
    for (const entry of extraction.excluded) {
      if (pendingSpan.has(entry.sha)) excluded.push(entry);
    }
    return { lineId: line.id, pending, released, excluded };
  });

  return { kind: "attributed", lines };
};
