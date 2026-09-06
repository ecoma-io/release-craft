/**
 * The planner's target computation (§2.6 + §2.7 + §2.8) — one line's stable
 * target and prerelease streams, deterministic over the frozen inputs.
 *
 * Bump arithmetic rides the kernel's doors (`bumpMajor`/`bumpMinor`/
 * `bumpPatch` — core-only results; prerelease and build stripped). A null
 * pointer is line birth: the bump applies to zero, so patch → `0.0.1`,
 * minor → `0.1.0`, major → `1.0.0`. §2.7's pre-1.0 dampening (breaking
 * bumps minor before `1.0.0`; the compatibility table's `bumpMinorPreMajor`
 * knob, row 3) is `policy.pre10Dampening` and keys on the pointer's major:
 * line birth is not dampened, because nothing is below `1.0.0` yet and the
 * birth major lands at exactly `1.0.0`.
 *
 * Streams are keyed by (target, identifier) over the rebuilt `LineState`
 * (§2.13): an observed key continues at `sequence + 1`; a fresh key — a new
 * target (P-05) or a new identifier on the same target (P-02's
 * per-identifier reset) — starts at the declared seed, `policy.prereleaseSeed`
 * (fork 17 resolved as declared seed policy, decision-log D13: `.0` is the
 * kernel default, `.1` by explicit declaration). Which seed the plan ran
 * under is recorded per stream. The mint composes
 * `target-identifier.sequence` through `Version.parse` — the same
 * composition the kernel's `streamVersion` performs. The kernel's
 * `advanceStream` cannot serve directly: it always seeds fresh keys at 0
 * and replays no history gaps, while the seed is line policy the kernel
 * deliberately leaves outside the value (D13).
 *
 * Released-pointer convention (§2.8, decision-log D9): `pointerBase`
 * records the pointer the plan computed from; a mint above the pointer by
 * precedence moves it (M-08, `movesPointer`); a mint below the pointer is
 * legal only as explicit declared ladder-override policy, which Phase 2's
 * `PolicyInput` does not carry — so planning throws
 * `InvalidPlanningInputError` naming the line and both versions. The
 * planner never invents the override (D9).
 *
 * Tags follow the declared per-line format (`policy.tagFormats`, fork 11's
 * naming knob): the tokens `{major}`, `{minor}`, `{patch}`, `{prerelease}`
 * render from the version; an absent format is the bare `toString()`. The
 * kernel-parsed value stays the bare version (PL-01 — the `v`-prefix ban is
 * on the value, not the tag name).
 *
 * Determinism (invariant 2): pure over its arguments — no clock, env,
 * filesystem, network, or randomness. Streams plan in input order of the
 * demanded intents; sequencing reads the rebuilt state, never mutation.
 *
 * Contract: docs/design/phase2-planner-contract.md §2.6–§2.8;
 * docs/adr/0003-deterministic-release-planner.md decisions 7–8;
 * docs/design/decision-log.md D9, D13.
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

/** Line birth's implicit base (§2.7): a null pointer bumps from zero. */
const BIRTH_BASE = Version.parse("0.0.0");

/**
 * The locked `PlanTargets` implementation (§2.6, §2.7, §2.8).
 *
 * Signature note (frozen): `PlanTargets` receives no intents, so this
 * targets-only view plans no streams — `planStreams` below is the exported
 * seam that takes the input's prerelease intents; the orchestrator composes
 * the two over the same semantics.
 */
export const planTargets: PlanTargets = (decision, state, line, policy) => ({
  stable: stableTarget(decision, state, line, policy),
  streams: planStreams([], decision, state, line, policy),
});

/**
 * Plans every prerelease stream the operator's intents demand for `line`
 * (§2.8). The target the streams run toward is the release decision's own
 * stable version when the line releases; on any other decision a stream can
 * still mint (P-07's first mint on a line with no release in play), keyed
 * on the pointer's own next patch — and `bumpPatch` over a prerelease
 * pointer is the release that pointer already points at, the kernel's
 * documented convention.
 */
export const planStreams = (
  intents: readonly OperatorIntent[],
  decision: LineDecision,
  state: LineState,
  line: LineConfig,
  policy: PolicyInput,
): PlannedStream[] => {
  const stable = stableTarget(decision, state, line, policy);
  const target = stable !== null ? stable.version : (state.pointer ?? BIRTH_BASE).bumpPatch();
  const pointerBase = state.pointer?.toString() ?? null;

  const demands = intents.filter(
    (candidate): candidate is PrereleaseIntent =>
      candidate.kind === "prerelease" && candidate.lineId === line.id,
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
  const sequence = observed !== undefined ? observed.sequence + 1 : Number(policy.prereleaseSeed);
  const minted = Version.parse(`${target.toString()}-${demand.stream}.${String(sequence)}`);

  // §2.8's released-pointer convention: the pointer stands unless the mint
  // exceeds it by precedence (D9's recorded convention; M-08 moves it). A
  // mint below the pointer is the ladder-override branch — legal only as
  // explicit declared policy, which PolicyInput does not carry, so it is a
  // caller contract violation naming the line and both versions, never a
  // silently regressing plan (D9; P-02's expected failure behavior).
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
            "declared policy (contract §2.8, decision-log D9), which this input does not declare",
        },
      ]);
    }
    movesPointer = byPrecedence > 0;
  }

  return {
    identifier: demand.stream,
    version: minted,
    tag: formatTag(minted, policy.tagFormats[line.id]),
    // The seed the plan ran under, recorded per stream (fork 17/D13).
    seed: policy.prereleaseSeed,
    pointerBase,
    movesPointer,
  };
}

/** The stable target: the decision's bump through the kernel doors, or `null` for a line whose plan mints only prereleases (§2.6). */
function stableTarget(
  decision: LineDecision,
  state: LineState,
  line: LineConfig,
  policy: PolicyInput,
): { readonly version: Version; readonly tag: string } | null {
  if (decision.kind !== "release") {
    return null;
  }
  // §2.7's pre-1.0 dampening: a major bump on a line still below `1.0.0`
  // (pointer major 0) becomes a minor, when the declared knob allows. Line
  // birth is exempt — there is no pointer below `1.0.0`, and the birth
  // major lands at exactly `1.0.0`.
  let bump = decision.bump;
  if (
    policy.pre10Dampening &&
    decision.bump === "major" &&
    state.pointer !== null &&
    state.pointer.major === 0
  ) {
    bump = "minor";
  }
  const version = applyBump(state.pointer ?? BIRTH_BASE, bump);
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

/** Fork 11's naming knob: the declared template names the tag; the version parsed back out of it stays the bare value (PL-01). A stable version renders `{prerelease}` empty. */
function formatTag(version: Version, format: string | undefined): string {
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
        return version.prerelease.join(".");
    }
  });
}
