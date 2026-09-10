/**
 * Close-out adversarial pass (issue #25), attacks 9 and 10, through the door
 * `plan()` (src/planner/assemble.ts): the declaration edge of the input
 * boundary.
 *
 * Attack 9 sends a declared `publishes` binding into an EMPTY component
 * universe — the `components` array empty or absent — and the door refuses
 * at normalization (D18 decision 4): an undeclared binding name cannot
 * reach here, because input normalization's component universe rejects it
 * first. The refusal names the declaration's field (`lines[<index>].publishes`)
 * and the missing component — the door refuses a binding-to-nothing rather
 * than silently dropping the declaration.
 *
 * Attack 10 pins the zero-declaration equivalence: one world planned twice,
 * the lines carrying no `streams` declaration versus the same lines
 * carrying the spelled-out default posture (`allow: "all"`, the policy's
 * `prereleaseSeed`), with identical everything-else. The computed outcome —
 * the plan body and the decision records — deep-equals: an absent
 * declaration computes exactly what the explicit default computes, and no
 * hidden third behavior exists. The identity stamps differ by design: the
 * input fingerprint hashes the declared lines verbatim (E-04's staleness
 * recognition), so the declaration text itself is input identity.
 *
 * Fixture posture:
 * - Digest letters a–z, 0–9 and uppercase A–L are claimed by the sibling
 *   suites; this suite claims M (attack 9) and N (attack 10).
 * - Attack 10's world is the single-component posture: one line, one
 *   component, no `publishes` — nothing beyond what the world requires —
 *   with an rc prerelease demand on the line so the stream posture
 *   genuinely participates: the demand mints under the default posture,
 *   and a stable-only reading would refuse it instead, so the equality is
 *   load-bearing, not vacuous.
 */
import { describe, expect, it } from "vitest";

import { plan } from "@ecoma-io/release-craft/__internal__/planner/assemble.js";
import { InvalidPlanningInputError } from "@ecoma-io/release-craft/__internal__/planner/input.js";
import type {
  BootstrapDecision,
  CommitObservation,
  ComponentMeta,
  LineConfig,
  LineDecision,
  OperatorIntent,
  PlanningInput,
  PlanningOutcome,
  PlanLine,
  PolicyInput,
  RefObservation,
  TagObservation,
} from "@ecoma-io/release-craft/__internal__/planner/types.js";

// ---------------------------------------------------------------------------
// Fixture builders — deterministic, closed inputs per §2.1, mirroring the
// sibling suites' idiom. Digest letters: every lowercase a–z, digit 0–9 and
// uppercase A–L is already claimed by the sibling suites, so this suite
// claims M and N.
// ---------------------------------------------------------------------------

const COMMITTED_AT = "2026-01-01T00:00:00Z";

/** One fixed digest per attack — opaque content identity (invariant 4). */
const DIGEST_ATK9 = "sha256:" + "M".repeat(64);
const DIGEST_ATK10 = "sha256:" + "N".repeat(64);

function policy(digest: string, tagFormats: Readonly<Record<string, string>> = {}): PolicyInput {
  return {
    digest,
    bumpMappingId: "default",
    prereleaseLadder: ["alpha", "beta", "rc"],
    prereleaseSeed: "0",
    pre10Dampening: true,
    selfReferenceNamespace: "Release-Craft:",
    tagFormats,
  };
}

function commit(
  sha: string,
  message: string,
  opts: {
    readonly parents?: readonly string[];
    readonly containingRefs?: readonly string[];
  } = {},
): CommitObservation {
  return {
    sha,
    parents: opts.parents ?? [],
    message,
    committedAt: COMMITTED_AT,
    containingRefs: opts.containingRefs ?? [],
  };
}

function ref(name: string, head: string): RefObservation {
  return { name, head };
}

function tag(name: string, sha: string): TagObservation {
  return { name, commit: sha };
}

function line(
  id: string,
  feedRef: string,
  versionBand?: { readonly major: number; readonly minor?: number },
  declared = true,
): LineConfig {
  const config: LineConfig = { id, feedRef, lifecycle: "active", declared };
  if (versionBand === undefined) {
    return config;
  }
  return { ...config, versionBand };
}

function component(
  name: string,
  manifestVersion: string,
  dependencies?: readonly { readonly name: string; readonly range: string }[],
): ComponentMeta {
  return dependencies === undefined
    ? { name, manifestVersion, paths: ["package.json"] }
    : { name, manifestVersion, paths: ["package.json"], dependencies };
}

interface FixtureOptions {
  readonly digest: string;
  readonly lines: readonly LineConfig[];
  readonly commits: readonly CommitObservation[];
  readonly refs: readonly RefObservation[];
  readonly tags?: readonly TagObservation[];
  readonly components?: readonly ComponentMeta[];
  readonly bootstrap?: BootstrapDecision;
  readonly intents?: readonly OperatorIntent[];
  readonly policy?: PolicyInput;
}

/** The closed §2.1 input a scenario's stated initial state reconstructs. */
function buildInput(opts: FixtureOptions): PlanningInput {
  return {
    policy: opts.policy ?? policy(opts.digest),
    repository: { commits: opts.commits, refs: opts.refs },
    history: { tags: opts.tags ?? [] },
    lines: opts.lines,
    ...(opts.components === undefined ? {} : { components: opts.components }),
    ...(opts.bootstrap === undefined ? {} : { bootstrap: opts.bootstrap }),
    ...(opts.intents === undefined ? {} : { intents: opts.intents }),
  };
}

// ---------------------------------------------------------------------------
// Narrowing helpers — every assertion runs against the planned branch
// ---------------------------------------------------------------------------

/** §2.9: the refusal is an outcome, not an exception — tests that expect a
 * plan narrow here, and anything else fails the fixture, not an expect. */
function plannedOf(outcome: PlanningOutcome): Extract<PlanningOutcome, { kind: "planned" }> {
  if (outcome.kind !== "planned") {
    throw new Error(`fixture broken: expected a planned outcome, got ${outcome.kind}`);
  }
  return outcome;
}

/** One line's decision record, found by id among the collected decisions. */
function decisionFor(outcome: PlanningOutcome, lineId: string): LineDecision {
  const found = plannedOf(outcome).decisions.find((candidate) => candidate.lineId === lineId);
  if (found === undefined) {
    throw new Error(`fixture broken: line ${lineId} has no decision record`);
  }
  return found;
}

/** One line's assembled plan line, found by id among the plan's lines. */
function planLineFor(outcome: PlanningOutcome, lineId: string): PlanLine {
  const found = plannedOf(outcome).plan.lines.find((entry) => entry.lineId === lineId);
  if (found === undefined) {
    throw new Error(`fixture broken: line ${lineId} assembles no plan line`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Attack 9 — a declared publishes pointing outside an EMPTY component
// universe: the declaration binds to nothing, and the door refuses at the
// input boundary (D18 decision 4) rather than dropping the declaration —
// the refusal names the declaration's field and the missing component
// ---------------------------------------------------------------------------

function atk9Input(opts: { readonly components?: readonly ComponentMeta[] } = {}): PlanningInput {
  return buildInput({
    digest: DIGEST_ATK9,
    lines: [{ ...line("2.x", "main", { major: 2 }), publishes: "app" }],
    commits: [
      commit("atk9-base", "feat: the 2.x line", { containingRefs: ["main"] }),
      commit("atk9-fix", "fix: the pending fix", {
        parents: ["atk9-base"],
        containingRefs: ["main"],
      }),
    ],
    refs: [ref("main", "atk9-fix")],
    tags: [tag("2.0.0", "atk9-base")],
    ...(opts.components === undefined ? {} : { components: opts.components }),
    intents: [{ kind: "release" }],
  });
}

describe("the empty-universe attack through the door — a declared publishes binds to nothing", () => {
  it("refuses a publishes into an empty component array, naming the field and the missing component", () => {
    const attempt = (): PlanningOutcome => plan(atk9Input({ components: [] }));
    expect(attempt).toThrow(InvalidPlanningInputError);
    expect(attempt).toThrow(/lines\[0\]\.publishes/);
    expect(attempt).toThrow(/names undeclared component "app"/);
    expect(attempt).toThrow(/the component binding has a gap/);
  });

  it("refuses the same declaration with components absent — the universe is empty either way", () => {
    const attempt = (): PlanningOutcome => plan(atk9Input());
    expect(attempt).toThrow(InvalidPlanningInputError);
    expect(attempt).toThrow(/lines\[0\]\.publishes/);
    expect(attempt).toThrow(/names undeclared component "app"/);
  });
});

// ---------------------------------------------------------------------------
// Attack 10 — zero-declaration ≡ explicit-defaults: one world planned
// twice, the line carrying no streams declaration versus the spelled-out
// default posture (allow: "all", the policy's prereleaseSeed) — the entire
// PlanningOutcome deep-equals, so the absent declaration computes exactly
// what the explicit default computes
// ---------------------------------------------------------------------------

function atk10Input(opts: { readonly explicitStreams?: boolean } = {}): PlanningInput {
  const base = line("main", "main", { major: 1 });
  return buildInput({
    digest: DIGEST_ATK10,
    lines: [
      // The spelled-out world pins the kernel default posture verbatim:
      // `allow: "all"` admits every declared-or-ladder identifier and the
      // seed is the policy's own prereleaseSeed ("0" — the helper policy's
      // fixed seed), spelled rather than inherited.
      opts.explicitStreams ? { ...base, streams: { allow: "all", seed: "0" } } : base,
    ],
    commits: [
      commit("atk10-base", "feat: the main line", { containingRefs: ["main"] }),
      commit("atk10-f", "fix: the pending fix on main", {
        parents: ["atk10-base"],
        containingRefs: ["main"],
      }),
    ],
    refs: [ref("main", "atk10-f")],
    tags: [tag("1.0.0", "atk10-base")],
    components: [component("app", "1.0.0")],
    intents: [{ kind: "release" }, { kind: "prerelease", stream: "rc", lineId: "main" }],
  });
}

describe("the zero-declaration attack through the door — absent streams compute the explicit default", () => {
  it("mints the rc stream under the implicit posture — the equality's load-bearing half", () => {
    const outcome = plan(atk10Input());
    // The fix resolves to a patch, and the rc demand rides the default
    // stream posture: the admissible demand suppresses the stable co-mint
    // (D17(3)) — the stream is the publication, minted at the policy's
    // seed "0" (P-02 posture: a fresh key starts at the seed).
    expect(decisionFor(outcome, "main")).toMatchObject({
      kind: "release",
      bump: "patch",
      policyDigest: DIGEST_ATK10,
    });
    const mainLine = planLineFor(outcome, "main");
    expect(mainLine.stable).toBeNull();
    expect(mainLine.streams).toHaveLength(1);
    const stream = mainLine.streams[0];
    if (stream === undefined) {
      throw new Error("fixture broken: the rc stream must be planned");
    }
    expect(stream).toMatchObject({
      identifier: "rc",
      tag: "1.0.1-rc.0",
      seed: "0",
    });
    expect(stream.version.toString()).toBe("1.0.1-rc.0");
  });

  it("deep-equals the explicit-default run's computed outcome; only the declared-text stamps differ", () => {
    const implicit = plannedOf(plan(atk10Input()));
    const explicit = plannedOf(plan(atk10Input({ explicitStreams: true })));
    // The identity stamps are the one difference, and it is deliberate:
    // `inputsFingerprint` hashes the declared lines verbatim (D17(7),
    // E-04's staleness recognition) — the declaration text is input
    // identity, so spelling the default stamps differently while computing
    // nothing new. A stored plan from either declaration must re-judge
    // against the other.
    expect(explicit.plan.inputsFingerprint).not.toBe(implicit.plan.inputsFingerprint);
    expect(explicit.plan.planId).not.toBe(implicit.plan.planId);
    // Stripping the stamps, the whole computed outcome — the plan body
    // (lines, streams, refusedIntents, explanation) and the decision
    // records — deep-equals: the absent declaration computes exactly what
    // the explicit default computes, no hidden third behavior.
    const {
      planId: _implicitPlanId,
      inputsFingerprint: _implicitInputs,
      ...implicitComputed
    } = implicit.plan;
    const {
      planId: _explicitPlanId,
      inputsFingerprint: _explicitInputs,
      ...explicitComputed
    } = explicit.plan;
    expect(explicitComputed).toEqual(implicitComputed);
    expect(explicit.decisions).toEqual(implicit.decisions);
  });
});
