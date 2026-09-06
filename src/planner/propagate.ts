/**
 * §2.15 dependency propagation (D16, PL-01–PL-03; ADR-0003 decision 17):
 * from the declared component graph and the release decisions, this computes
 * the `PropagationPlan` — the range-widening edges in topological order, the
 * topological order of every affected component, and the negative evidence
 * for everything that did not move (invariant 14: declared content,
 * provable in the negative).
 *
 * Scope discipline (the frozen `PlanPropagation` signature forces it, and
 * §2.15 agrees): propagation records EDGES, ORDER, and NEGATIVE EVIDENCE —
 * never target versions. A dependent's widened version is `plan.ts`'s
 * computation (its current version lives in the line history, not in
 * `ComponentMeta`); this module proves which declared relationships break
 * and in what order the widens must execute (PL-02 case 2: `lib-a` →
 * `lib-b` → `app`).
 *
 * Semantics (ADR-0003 decision 17): a release forces a dependent bump
 * exactly when the new version falls outside the dependent's declared range
 * expression; dependents widen transitively, in topological order; every
 * component that did not move carries negative evidence —
 * `no-reverse-dependency` when no declared path leads to a releasing
 * component (PL-03), `range-compatible` when the component sits in the
 * affected closure with no broken range. A closure member related only
 * transitively (none of its own dependencies released here) still did not
 * move: every range it declares still accepts the post-release world —
 * proven for ranges tested against released versions, vacuous for the rest;
 * when this plan's widened targets later release, the next propagation
 * re-tests them. Edges are only ever the directly testable failures —
 * derivable, recorded, never implied (invariant 14).
 *
 * Range math (PL-02's row; the declared grammar is exactly caret, tilde, and
 * exact — anything else is a caller violation):
 * - `^x.y.z` — the leftmost nonzero component holds: `^1.2.0` is
 *   `[1.2.0, 2.0.0)` (same major); `^0.2.3` is `[0.2.3, 0.3.0)` (same
 *   minor); `^0.0.3` is `[0.0.3, 0.0.4)` (same patch).
 * - `~x.y.z` — same minor: `~1.2.3` is `[1.2.3, 1.3.0)`; `~0.2.3` is
 *   `[0.2.3, 0.3.0)`; `~0.0.3` holds its patch: `[0.0.3, 0.0.4)`.
 * - `x.y.z` — precedence equality; the kernel's `compare` is the authority
 *   and build metadata plays no part in it.
 * Bounds compare through kernel SemVer precedence, so a prerelease candidate
 * participates by precedence alone: below the floor or at/after the ceiling
 * it is out of range, inside the interval it is in. The declared grammar has
 * no prerelease comparators, so no npm-style prerelease exclusion exists
 * here — precedence is the whole rule.
 *
 * Determinism (invariant 2, §2.14): no clock, environment, filesystem,
 * network, or randomness. Violations report in fixed traversal order
 * (component order, then dependency order, then release order — input.ts's
 * posture: every violation, never just the first). Edges sort by topological
 * position of `from`, then `to`; `order` is Kahn's algorithm over the
 * declared graph with ASCII (code-unit) tie-breaks; `notMoved` is declared
 * component order.
 *
 * Caller contract (D16, ADR-0003 decision 17): a dependency naming an
 * undeclared component, an unknown release component, or a range outside
 * the declared grammar throws `InvalidPlanningInputError`; so does a cyclic
 * declared graph — no topological order exists for it.
 *
 * Contract: docs/design/phase2-planner-contract.md §2.15;
 * docs/design/decision-log.md D16; docs/adr/0003 decision 17;
 * docs/design/release-scenarios.md PL-02, PL-03.
 */

import { InvalidVersionError, Version } from "@ecoma-io/release-craft/domain";

import { InvalidPlanningInputError } from "./input.js";
import type { InputViolation } from "./input.js";
import type { ComponentMeta, NotMovedEvidence, PlanPropagation, PropagationEdge } from "./types.js";

/** One release entry of the frozen signature, named for the helper
 * signatures below — structurally identical to the alias's parameter. */
interface Release {
  readonly component: string;
  readonly version: Version;
}

/** One parsed range expression: the declared kind and its floor version. */
interface ParsedRange {
  readonly kind: "caret" | "tilde" | "exact";
  readonly base: Version;
}

/**
 * The locked `PlanPropagation` implementation (§2.15, D16).
 */
export const planPropagation: PlanPropagation = (components, releases) => {
  const violations = callerViolations(components, releases);
  if (violations.length > 0) throw new InvalidPlanningInputError(violations);

  const positions = topologicalPositions(components);
  const affected = affectedClosure(components, releases);
  const edges = wideningEdges(components, releases);
  // §2.15: the edges ride in topological order — `from` first, then `to`.
  // The sort is stable, so ties keep discovery order (release input order,
  // then declared component order).
  edges.sort((left, right) => {
    const fromLeft = positions.get(left.from) ?? 0;
    const fromRight = positions.get(right.from) ?? 0;
    if (fromLeft !== fromRight) return fromLeft - fromRight;
    return (positions.get(left.to) ?? 0) - (positions.get(right.to) ?? 0);
  });
  // The closure members, scheduled: dependencies before dependents, ASCII
  // among independents.
  const order = [...affected].sort(
    (left, right) => (positions.get(left) ?? 0) - (positions.get(right) ?? 0),
  );
  return { edges, order, notMoved: negativeEvidence(components, releases, affected, edges) };
};

/**
 * Every caller contract violation of the declared graph and the releases,
 * in fixed traversal order — component order, dependency order, then
 * release order (input.ts's posture: all of them, never just the first).
 */
function callerViolations(
  components: readonly ComponentMeta[],
  releases: readonly Release[],
): InputViolation[] {
  const violations: InputViolation[] = [];
  const declared = new Set<string>();
  for (const component of components) declared.add(component.name);

  for (const [componentIndex, component] of components.entries()) {
    for (const [dependencyIndex, dependency] of (component.dependencies ?? []).entries()) {
      if (!declared.has(dependency.name)) {
        violations.push({
          field: `components[${String(componentIndex)}].dependencies[${String(dependencyIndex)}].name`,
          problem: `names undeclared component ${JSON.stringify(dependency.name)} (edge ${JSON.stringify(component.name)} -> ${JSON.stringify(dependency.name)})`,
        });
        continue;
      }
      // The range grammar is checked here so identical inputs report
      // identical (complete) violation lists; wideningEdges re-parses only
      // after this pass has guaranteed every expression parses.
      try {
        parseRange(dependency.range);
      } catch (error: unknown) {
        if (error instanceof InvalidVersionError) {
          violations.push({
            field: `components[${String(componentIndex)}].dependencies[${String(dependencyIndex)}].range`,
            problem: `malformed range expression ${JSON.stringify(dependency.range)} — ${error.message}`,
          });
          continue;
        }
        throw error;
      }
    }
  }

  for (const [releaseIndex, release] of releases.entries()) {
    if (!declared.has(release.component)) {
      violations.push({
        field: `releases[${String(releaseIndex)}].component`,
        problem: `names undeclared component ${JSON.stringify(release.component)}`,
      });
    }
  }
  return violations;
}

/**
 * Kahn's algorithm over the WHOLE declared graph: the positions double as
 * the cycle check (a cyclic graph has no topo order — caller violation
 * naming the stuck members) and as the sort key for both `edges` and
 * `order`. Tie-breaks are ASCII (default code-unit `.sort()`), so identical
 * graphs yield identical positions (invariant 2).
 */
function topologicalPositions(components: readonly ComponentMeta[]): Map<string, number> {
  const inDegree = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const component of components) {
    inDegree.set(component.name, 0);
    successors.set(component.name, []);
  }
  for (const component of components) {
    // A duplicated declaration of the same dependency is one graph edge.
    const declared = new Set<string>();
    for (const dependency of component.dependencies ?? []) {
      if (declared.has(dependency.name)) continue;
      declared.add(dependency.name);
      inDegree.set(component.name, (inDegree.get(component.name) ?? 0) + 1);
      successors.get(dependency.name)?.push(component.name);
    }
  }

  const ready: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) ready.push(name);
  }
  ready.sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const current = ready.shift();
    if (current === undefined) break;
    order.push(current);
    for (const next of successors.get(current) ?? []) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
    ready.sort();
  }

  if (order.length !== components.length) {
    const stuck = components
      .map((component) => component.name)
      .filter((name) => !order.includes(name))
      .sort();
    throw new InvalidPlanningInputError([
      {
        field: "components",
        problem: `declared dependency graph is cyclic among: ${stuck.join(", ")}`,
      },
    ]);
  }

  const positions = new Map<string, number>();
  order.forEach((name, index) => positions.set(name, index));
  return positions;
}

/**
 * The affected closure: the releasing components plus every transitive
 * dependent (declared reverse edges, range-independent). This is the
 * blast radius the plan schedules; whether a member actually moves is each
 * range test's verdict, not closure membership.
 */
function affectedClosure(
  components: readonly ComponentMeta[],
  releases: readonly Release[],
): Set<string> {
  const dependentsOf = new Map<string, string[]>();
  for (const component of components) {
    for (const dependency of component.dependencies ?? []) {
      const known = dependentsOf.get(dependency.name);
      if (known === undefined) {
        dependentsOf.set(dependency.name, [component.name]);
      } else if (!known.includes(component.name)) {
        known.push(component.name);
      }
    }
  }

  const affected = new Set<string>();
  const queue: string[] = [];
  for (const release of releases) {
    if (!affected.has(release.component)) {
      affected.add(release.component);
      queue.push(release.component);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (current === undefined) break;
    for (const dependent of dependentsOf.get(current) ?? []) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return affected;
}

/**
 * The range-widening edges: every direct dependent whose declared range on
 * a released component rejects that release's new version. Discovery order
 * is release input order, then declared component order; duplicates (the
 * same pair via several releases or several declarations) collapse to the
 * first. A component that itself releases can still take an edge — its
 * broken range is declared content worth recording (invariant 14).
 */
function wideningEdges(
  components: readonly ComponentMeta[],
  releases: readonly Release[],
): PropagationEdge[] {
  const edges: PropagationEdge[] = [];
  const seen = new Set<string>();
  for (const release of releases) {
    for (const component of components) {
      for (const dependency of component.dependencies ?? []) {
        if (dependency.name !== release.component) continue;
        // callerViolations already proved every expression parses.
        const parsed = parseRange(dependency.range);
        if (accepts(parsed, release.version)) continue;
        const key = `${release.component}->${component.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from: release.component, to: component.name, reason: "range-widening" });
      }
    }
  }
  return edges;
}

/**
 * The negative evidence (§2.15, PL-03): every component without an edge,
 * in declared order — `no-reverse-dependency` outside the affected closure,
 * `range-compatible` inside it. Releasing components and edge targets
 * moved, so they never appear here.
 */
function negativeEvidence(
  components: readonly ComponentMeta[],
  releases: readonly Release[],
  affected: ReadonlySet<string>,
  edges: readonly PropagationEdge[],
): NotMovedEvidence[] {
  const moved = new Set<string>();
  for (const release of releases) moved.add(release.component);
  for (const edge of edges) moved.add(edge.to);

  const evidence: NotMovedEvidence[] = [];
  for (const component of components) {
    if (moved.has(component.name)) continue;
    evidence.push({
      component: component.name,
      why: affected.has(component.name) ? "range-compatible" : "no-reverse-dependency",
    });
  }
  return evidence;
}

/**
 * Parses one declared range expression: an optional kind prefix, then a
 * strict kernel version as the floor. Throws `InvalidVersionError` for
 * anything outside the grammar (`^x.y.z`, `~x.y.z`, exact `x.y.z`) — the
 * caller decides whether that is a reported violation or an impossibility.
 */
function parseRange(expression: string): ParsedRange {
  const kind = expression.startsWith("^")
    ? "caret"
    : expression.startsWith("~")
      ? "tilde"
      : "exact";
  const floor = Version.parse(kind === "exact" ? expression : expression.slice(1));
  return { kind, base: floor };
}

/** The declared range accepts the candidate: at or above the floor (every
 * kind) and below the kind's ceiling — precedence equality for exact. */
function accepts(range: ParsedRange, candidate: Version): boolean {
  if (candidate.compare(range.base) < 0) return false;
  if (range.kind === "exact") return candidate.compare(range.base) === 0;
  return candidate.compare(ceiling(range)) < 0;
}

/**
 * The exclusive upper bound for a caret or tilde range (§2.15's math, as
 * read from PL-02's row): tilde holds the minor — except `~0.0.x`, which
 * holds its patch; caret holds its leftmost nonzero component. On a
 * `0.0.x` floor both kinds land here, and `bumpPatch` must NOT build the
 * bound: on a prerelease floor it returns the release being pointed at
 * (`0.0.3-rc.1` bumps to `0.0.3`, not `0.0.4`), while a ceiling must be
 * the untouched `patch + 1`.
 */
function ceiling(range: ParsedRange): Version {
  const base = range.base;
  if (base.major === 0 && base.minor === 0) {
    return Version.parse(`${String(base.major)}.${String(base.minor)}.${String(base.patch + 1)}`);
  }
  if (range.kind === "tilde") return base.bumpMinor();
  if (base.major > 0) return base.bumpMajor();
  return base.bumpMinor();
}
