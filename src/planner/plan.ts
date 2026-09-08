/**
 * The planner's target computation (§2.6 + §2.7 + §2.8) — one line's stable
 * target and prerelease streams, deterministic over the frozen inputs.
 *
 * Bump arithmetic rides the kernel's doors (`bumpMajor`/`bumpMinor`/
 * `bumpPatch` — core-only results; prerelease and build stripped). §2.7's
 * pre-1.0 dampening (breaking bumps minor while the bumped base sits below
 * `1.0.0`; the compatibility table's `bumpMinorPreMajor` knob, row 3) is
 * `policy.pre10Dampening` and keys on the bumped base's major; line birth is
 * exempt — there is no base below `1.0.0` yet, and the birth major lands at
 * exactly `1.0.0`.
 *
 * The stable target follows the PR-5 review wave (decision-log D17, ADR-0003
 * decision 18): a promotion (`bump: null`, P-03) targets the pointed-at
 * release (`bumpPatch` of the pointer); while a prerelease holds the pointer
 * the in-flight-target rule governs (P-04 vs P-05) — the candidate recomputed
 * from `LineState.stableBase` against the in-flight target (`bumpPatch` of
 * the pointer), higher precedence winning, so a joining change at or under
 * the in-flight class keeps the target and its sequence and a heavier one
 * moves it; a `release-as` intent's exact version overrides the computed
 * target (compatibility boundary row 2, first intent in input order). Birth —
 * a release decision over a line with no released versions — has no
 * computable target at this layer: the first release targets the recorded
 * bootstrap version verbatim (D17(1)/S-02), input `PlanTargets` does not
 * receive, so `planTargets` refuses the shape and the planning door composes
 * it; no layer invents a derived fallback. A `prerelease` intent naming the
 * line suppresses the stable co-mint (D17(3)) — the streams carry the target
 * — so `planStreams` reads the would-be target through `stableTarget` (never
 * suppressed) and falls back to the §2.8 pointer patch when the line does not
 * release. A promotion-shaped decision never carries a stream extension
 * (D38, #90): the P-03 promotion resolves the very stream a prerelease
 * demand would extend — the streams run toward the promotion's own mint — so
 * the sibling demands for the line are subsumed: the stable co-mint stands
 * and no sequence entry is planned, and the decision record names the
 * subsumption. D17(3)'s suppression keeps its single-intent posture — a
 * release decision's content flows to the stream; a promotion is subsumed
 * by rule (D38), not by content: the demand names the stream the promotion
 * performs.
 *
 * Streams are keyed by (target, identifier) over the rebuilt `LineState`
 * (§2.13): an observed key continues at `sequence + 1`; a fresh key — a new
 * target (P-05) or a new identifier on the same target (P-02's
 * per-identifier reset) — starts at the declared seed: the line's
 * `streams.seed` override when it declares one, else `policy.prereleaseSeed`
 * (fork 17 resolved as declared seed policy, decision-log D13: `.0` is the
 * kernel default, `.1` by explicit declaration; §2.8/D18 for the override).
 * Which seed the plan ran under is recorded per stream.
 * The mint composes `target-identifier.sequence` through `Version.parse` — the
 * same composition the kernel's `streamVersion` performs. The kernel's
 * `advanceStream` cannot serve directly: it always seeds fresh keys at 0
 * and replays no history gaps, while the seed is line policy the kernel
 * deliberately leaves outside the value (D13).
 *
 * Released-pointer convention (§2.8, decision-log D10): `pointerBase`
 * records the pointer the plan computed from; a mint above the pointer by
 * precedence moves it (M-08, `movesPointer`); a mint below the pointer is
 * legal only as explicit declared ladder-override policy, which Phase 2's
 * `PolicyInput` does not carry — so planning throws
 * `InvalidPlanningInputError` naming the line and both versions. The
 * planner never invents the override (D10).
 *
 * Tags follow the declared per-line format (`policy.tagFormats`, fork 11's
 * naming knob): the tokens `{major}`, `{minor}`, `{patch}`, `{prerelease}`
 * render from the version — `{prerelease}` renders `-` plus the identifiers
 * joined on `.` for a prerelease and empty for a stable, one declared format
 * naming both kinds (input.ts requires the token). An absent format is the
 * bare `toString()`. The kernel-parsed value stays the bare version (PL-01 —
 * the `v`-prefix ban is on the value, not the tag name).
 *
 * Determinism (invariant 2): pure over its arguments — no clock, env,
 * filesystem, network, or randomness. Streams plan in input order of the
 * demanded intents; sequencing reads the rebuilt state, never mutation.
 *
 * Contract: docs/design/phase2-planner-contract.md §2.6–§2.8;
 * docs/adr/0003-deterministic-release-planner.md decisions 7–8 and 18;
 * docs/design/decision-log.md D10, D13, D17.
 */

import { Version } from "@ecoma-io/release-craft/domain";
import type { Bump } from "@ecoma-io/release-craft/domain";

import { InvalidPlanningInputError } from "./input.js";
import type {
  LineConfig,
  LineDecision,
  LineState,
  OperatorIntent,
  PlannedStream,
  PlanTargets,
  PolicyInput,
} from "./types.js";

/** A prerelease intent — the only intent kind that demands a stream (§2.1). */
type PrereleaseIntent = Extract<OperatorIntent, { readonly kind: "prerelease" }>;

/** A release-as intent — the exact-version override (compatibility row 2). */
type ReleaseAsIntent = Extract<OperatorIntent, { readonly kind: "release-as" }>;

/**
 * The promotion shape (P-03): a release decision whose change set is the
 * stream's — `bump: null`. D38 (#90): such a decision never carries a stream
 * extension. The sibling prerelease demands for the line are subsumed by the
 * promotion — the streams they would extend run toward the promotion's own
 * mint (`stableTarget`'s P-03 branch) — so the stable co-mint stands and no
 * sequence entry is planned. `decideLine`'s promotion record names the
 * subsumed demand(s); this layer enforces the rule.
 */
function isPromotion(decision: LineDecision): boolean {
  return decision.kind === "release" && decision.bump === null;
}

/** Line birth's implicit base (§2.7): a null pointer or null stable base bumps from zero. */
const BIRTH_BASE = Version.parse("0.0.0");

/**
 * The `PlanTargets` implementation (§2.6, §2.7, §2.8): the line's stable
 * target under the D17 rules plus every prerelease stream the intents
 * demand. A release decision over a line with no released versions is a
 * caller contract error here — the first release targets the recorded
 * bootstrap version (D17(1)/S-02), input this layer does not receive; the
 * door composes it, so no derived fallback is ever minted. An ADMISSIBLE
 * `prerelease` demand suppresses the stable co-mint (D17(3)): the streams
 * carry the target, the stable stays `null`. A refused demand does not
 * suppress (§2.8, D18) — the stable-only line still releases its own change
 * set (M-08's stable half), while assemble composes the `refusedIntents`
 * record from the same predicate (`isStreamAllowed`). A promotion-shaped
 * decision suppresses nothing (D38, #90): its own mint is the target the
 * streams would run toward, so the sibling demands are subsumed — the stable
 * stands and no stream is planned.
 */
export const planTargets: PlanTargets = (intents, decision, state, line, policy) => {
  if (decision.kind === "release" && state.pointer === null) {
    throw new InvalidPlanningInputError([
      {
        field: `stable.${line.id}`,
        problem:
          `release decision on line ${line.id} with no released versions — the first release ` +
          "targets the recorded bootstrap version verbatim (decision-log D17(1), S-02), which " +
          "PlanTargets cannot see; the planning door composes it, never a derived fallback",
      },
    ]);
  }
  // D17(3)'s suppression keys on an admissible demand (§2.8, D18): a
  // refused demand leaves the stable target standing — the stable-only
  // line still releases its own change set (M-08's stable half). A
  // promotion-shaped decision suppresses nothing (D38, #90): the stream it
  // would release through is resolved by the promotion itself, never
  // extended — the sibling demand is subsumed and the mint stands.
  const promotion = isPromotion(decision);
  const suppressed =
    !promotion &&
    intents.some(
      (candidate) =>
        candidate.kind === "prerelease" &&
        candidate.lineId === line.id &&
        isStreamAllowed(line, candidate.stream),
    );
  return {
    stable: suppressed ? null : stableTarget(intents, decision, state, line, policy),
    streams: planStreams(intents, decision, state, line, policy),
  };
};

/**
 * §2.8 (D18) — the line's declared admission posture; assemble composes
 * `refusedIntents` from the same predicate. Absent `streams` is the
 * defaults-as-data posture (ADR-0004): every demanded identifier is
 * allowed, and the global `policy.prereleaseSeed` governs fresh keys.
 */
export const isStreamAllowed = (line: LineConfig, identifier: string): boolean => {
  const allow = line.streams?.allow;
  if (allow === undefined || allow === "all") {
    return true;
  }
  if (allow === "none") {
    return false;
  }
  return allow.includes(identifier);
};

/**
 * Plans every prerelease stream the operator's intents demand for `line`
 * (§2.8). The target the streams run toward is the line's would-be stable
 * version when the line releases — computed without D17(3)'s suppression,
 * because suppression is exactly the case where the streams carry the target
 * — or, on any other decision (P-07's first mint on a line with no release
 * in play), the pointer's own next patch. `bumpPatch` over a prerelease
 * pointer is the release that pointer already points at, the kernel's
 * documented convention.
 * A demanded identifier the line's declared posture refuses (§2.8, D18) is
 * not minted and not an error — it is omitted here; assemble composes the
 * refusal record from the same predicate (`isStreamAllowed`). A
 * promotion-shaped decision plans no stream at all (D38, #90): the sibling
 * prerelease demands are subsumed by the promotion.
 */
export const planStreams = (
  intents: readonly OperatorIntent[],
  decision: LineDecision,
  state: LineState,
  line: LineConfig,
  policy: PolicyInput,
): PlannedStream[] => {
  const stable = stableTarget(intents, decision, state, line, policy);
  const target = stable !== null ? stable.version : (state.pointer ?? BIRTH_BASE).bumpPatch();
  const pointerBase = state.pointer?.toString() ?? null;

  // D38 (#90): a promotion-shaped decision never carries a stream extension —
  // the sibling prerelease demands are subsumed by the promotion, so the
  // demand filter never admits one for it.
  const promotion = isPromotion(decision);
  const demands = intents.filter(
    (candidate): candidate is PrereleaseIntent =>
      candidate.kind === "prerelease" &&
      candidate.lineId === line.id &&
      !promotion &&
      isStreamAllowed(line, candidate.stream),
  );
  // Input order — the plan's stream list is stable for identical input.
  return demands.map((demand) => planStream(demand, target, state, line, policy, pointerBase));
};

/** One stream's plan: sequence, composition, pointer verdict, tag. */
function planStream(
  demand: PrereleaseIntent,
  target: Version,
  state: LineState,
  line: LineConfig,
  policy: PolicyInput,
  pointerBase: string | null,
): PlannedStream {
  // An observed key continues at sequence + 1; a fresh key starts at the
  // declared seed (fork 17/D13). The reset is per identifier — P-02's
  // alpha → beta → rc walks three keys over one target.
  const observed = state.streams.find(
    (key) => key.identifier === demand.stream && key.target.equals(target),
  );
  // The line's declared seed override (§2.8, D18): streams.seed wins over
  // the global policy seed for this line's fresh keys.
  const seed = line.streams?.seed ?? policy.prereleaseSeed;
  const sequence = observed !== undefined ? observed.sequence + 1 : Number(seed);
  const minted = Version.parse(`${target.toString()}-${demand.stream}.${String(sequence)}`);

  // §2.8's released-pointer convention: the pointer stands unless the mint
  // exceeds it by precedence (D10's recorded convention; M-08 moves it). A
  // mint below the pointer is the ladder-override branch — legal only as
  // explicit declared policy, which PolicyInput does not carry, so it is a
  // caller contract violation naming the line and both versions, never a
  // silently regressing plan (D10; P-02's expected failure behavior).
  const pointer = state.pointer;
  let movesPointer = false;
  if (pointer !== null) {
    const byPrecedence = minted.compare(pointer);
    if (byPrecedence < 0) {
      throw new InvalidPlanningInputError([
        {
          field: `streams.${line.id}.${demand.stream}`,
          problem:
            `planned ${minted.toString()} sorts below line ${line.id}'s released pointer ` +
            `${pointer.toString()} — publishing below the pointer is legal only as explicit ` +
            "declared policy (contract §2.8, decision-log D10), which this input does not declare",
        },
      ]);
    }
    movesPointer = byPrecedence > 0;
  }

  return {
    identifier: demand.stream,
    version: minted,
    tag: formatTag(minted, policy.tagFormats[line.id]),
    // The seed the plan ran under, recorded per stream (fork 17/D13) —
    // the line's declared override when it declares one (§2.8, D18).
    seed,
    pointerBase,
    movesPointer,
  };
}

/**
 * The line's would-be stable target, computed without D17(3)'s suppression
 * (planTargets applies it; the streams read this to carry the target):
 * `null` for a non-release decision and for line birth — the birth target is
 * the recorded bootstrap version, input this layer does not receive
 * (D17(1)/S-02), so no target is computed and no fallback is invented here.
 */
function stableTarget(
  intents: readonly OperatorIntent[],
  decision: LineDecision,
  state: LineState,
  line: LineConfig,
  policy: PolicyInput,
): { readonly version: Version; readonly tag: string } | null {
  if (decision.kind !== "release" || state.pointer === null) {
    return null;
  }
  // P-03's promotion: `bump: null` targets the pointed-at release — the
  // pointer is the in-flight rc and its `bumpPatch` is that stable.
  if (decision.bump === null) {
    return namedTag(state.pointer.bumpPatch(), intents, line, policy);
  }
  if (state.pointer.prerelease.length > 0) {
    // D17(2)'s in-flight-target rule (P-04 vs P-05): the candidate recomputed
    // from the line's stable base — §2.7's birth base when the line never
    // released stable — against the in-flight target (`bumpPatch` of the
    // pointer), higher precedence winning. Equal or lighter keeps the
    // in-flight target and its sequence (P-04); a heavier join moves the
    // target (P-05), whose fresh key resets the sequence. The candidate's
    // bump carries §2.7's dampening keyed on the recomputed base.
    const base = state.stableBase ?? BIRTH_BASE;
    const inFlight = state.pointer.bumpPatch();
    const dampened =
      policy.pre10Dampening && decision.bump === "major" && base.major === 0
        ? "minor"
        : decision.bump;
    const candidate = applyBump(base, dampened);
    return namedTag(candidate.compare(inFlight) > 0 ? candidate : inFlight, intents, line, policy);
  }
  // §2.7's dampening keys on the bumped base — the stable pointer itself.
  const dampened =
    policy.pre10Dampening && decision.bump === "major" && state.pointer.major === 0
      ? "minor"
      : decision.bump;
  return namedTag(applyBump(state.pointer, dampened), intents, line, policy);
}

/**
 * The release-as override (compatibility boundary row 2): the first intent in
 * input order names the exact version — input.ts validated the parse, plan.ts
 * trusts it — and the tag renders from the final version either way.
 */
function namedTag(
  computed: Version,
  intents: readonly OperatorIntent[],
  line: LineConfig,
  policy: PolicyInput,
): { readonly version: Version; readonly tag: string } {
  const override = intents.find(
    (candidate): candidate is ReleaseAsIntent => candidate.kind === "release-as",
  );
  const version = override !== undefined ? Version.parse(override.version) : computed;
  return { version, tag: formatTag(version, policy.tagFormats[line.id]) };
}

/** The kernel's bump doors — core-only results; a prerelease base's `bumpPatch` is the release it points at. */
function applyBump(base: Version, bump: Bump): Version {
  switch (bump) {
    case "major":
      return base.bumpMajor();
    case "minor":
      return base.bumpMinor();
    case "patch":
      return base.bumpPatch();
  }
}

/**
 * Fork 11's naming knob: the declared template names the tag; the version
 * parsed back out of it stays the bare value (PL-01). The `{prerelease}`
 * token renders `-` plus the identifiers joined on `.` for a prerelease and
 * empty for a stable — one declared format names both kinds (input.ts
 * requires the token, so a stable mint renders no dangling separator).
 */
export function formatTag(version: Version, format: string | undefined): string {
  if (format === undefined) {
    return version.toString();
  }
  return format.replace(/\{major\}|\{minor\}|\{patch\}|\{prerelease\}/g, (token): string => {
    switch (token) {
      case "{major}":
        return String(version.major);
      case "{minor}":
        return String(version.minor);
      case "{patch}":
        return String(version.patch);
      default:
        return version.prerelease.length === 0 ? "" : `-${version.prerelease.join(".")}`;
    }
  });
}
