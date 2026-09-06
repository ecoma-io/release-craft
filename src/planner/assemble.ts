/**
 * `assemble.ts` — the planner's single entry (§2.6 of
 * docs/design/phase2-planner-contract.md): one pure function from the closed
 * input boundary to the planning outcome. The composition is the fixed order
 * the contract names — normalize (§2.1) → extract (§2.3/§2.12) → tag history
 * (§2.13) → range derivation (§2.5) → attribution (§2.4) → decide (§2.9) →
 * state rebuild (§2.13) → target/stream planning (§2.6–§2.8) → propagation
 * (§2.15) → plan assembly and fingerprint (§2.10–§2.11) — each stage a landed
 * module, composed and never re-implemented here. The kernel is reached only
 * through `@ecoma-io/release-craft/domain` types (ADR-0001's import rule).
 *
 * Three frozen-shape readings this assembly pins, per the contract's wording:
 *
 * 1. **Component mapping (§2.15, D17(8), PL-01's declared-future seam).**
 *    `planPropagation` is called once per plan. The door refuses to
 *    fabricate the line↔component release mapping: with releases pending,
 *    exactly one declared component must meet exactly one releasing line —
 *    mapping every declared component to the release would invent releases.
 *    A zero-release plan needs no binding and propagates honestly over an
 *    empty release list (negative evidence per declared component).
 *
 * 2. **Propagation attachment (§2.11's tuple wording).** The fingerprint
 *    tuple lists "propagation edges" among the per-line members, and the
 *    frozen `PlanLine.propagation` carries a whole `PropagationPlan`. There
 *    is exactly one propagation plan per release plan — it is one plan, not
 *    one per line — so every assembled line carries that same plan-level
 *    value verbatim: the most literal reading of the tuple (the per-line
 *    member IS the plan-level propagation plan), with no invented per-line
 *    sub-setting that §2.11 nowhere defines.
 *
 * 3. **The birth target, the member bumps, and the explanation (D17(1),
 *    D17(6), reviewer m-3).** The first release of a line targets the
 *    operator's recorded bootstrap version verbatim — the frozen targets
 *    layer cannot see the input's bootstrap record and refuses the shape,
 *    so the door composes it. Change entries carry each member's own
 *    resolved bump, never the decision's group winner. The plan's
 *    `explanation` data — foreign tags, identity conflicts, excluded
 *    commits — is aggregated verbatim from the tag-history and extraction
 *    stages into the fingerprint tuple.
 *
 * §2.9: negative outcomes are records. An attribution refusal IS the
 * outcome — nothing else leaks — while a plan whose lines all no-op is
 * still a plan (§2.10's no-op successor shape, `lines: []`). §2.14: the
 * door is pure — no clock, environment, randomness, filesystem, or
 * network; identical inputs produce identical outcomes, double-run equal.
 */

import { Version } from "@ecoma-io/release-craft/domain";

import { attribute } from "./attribute.js";
import { decideLine, resolveBump } from "./decide.js";
import { extract } from "./extract.js";
import { deriveRanges, loadTagHistory } from "./history.js";
import { inputsFingerprint, planFingerprint } from "./identity.js";
import { InvalidPlanningInputError, normalize } from "./input.js";
import { formatTag, planStreams, planTargets } from "./plan.js";
import { planPropagation } from "./propagate.js";
import { rebuildLineState } from "./state.js";
import type {
  LineConfig,
  LineDecision,
  OperatorIntent,
  PlannedStream,
  Plan,
  PlanLine,
  PlanningInput,
  PolicyInput,
  PropagationPlan,
  TargetPlan,
} from "./types.js";

/** One release entry of `planPropagation`'s frozen signature, named locally —
 * structurally identical to the alias's anonymous parameter (propagate.ts's
 * own posture). */
interface ReleaseEntry {
  readonly component: string;
  readonly version: Version;
}

/** One line's fully planned outputs, awaiting plan assembly: the decision
 * record, the stable target when the decision releases, and the streams the
 * operator's prerelease intents demand. */
interface PlannedLine {
  readonly lineId: string;
  readonly decision: LineDecision;
  readonly stable: TargetPlan["stable"];
  readonly streams: readonly PlannedStream[];
}

/** A stage output the preceding doors guarantee for every declared line —
 * the §2.5 range derivation, the §2.13 history projection, §2.4's
 * attribution. A miss is a caller contract violation, surfaced the way the
 * landed modules surface theirs — never a silent default. All three lookups
 * report the identical violation shape in lockstep. */
function requireFound<T>(found: T | undefined, field: string, problem: string): T {
  if (found === undefined) {
    throw new InvalidPlanningInputError([{ field, problem }]);
  }
  return found;
}

/**
 * D17(1)'s birth target, composed by the door because the frozen targets
 * layer cannot see the input's bootstrap record: the first release of a
 * line targets the operator's recorded version verbatim, rendered through
 * the line's declared tag format — "either is valid, silently derived is
 * not", so no bump is applied over a synthesized base. A prerelease intent
 * naming the line still suppresses the stable co-mint (D17(3)): the streams
 * carry the target alone. The record itself is decideLine's gate
 * (bootstrap-required), so a missing record reaching here is a caller
 * contract violation, surfaced as such — never a derived fallback.
 */
function birthStable(
  input: PlanningInput,
  config: LineConfig,
  intents: readonly OperatorIntent[],
): TargetPlan["stable"] {
  const bootstrap = input.bootstrap;
  if (bootstrap === undefined) {
    throw new InvalidPlanningInputError([
      {
        field: "bootstrap",
        problem: `line "${config.id}" releases without a recorded bootstrap decision — the first release targets the recorded bootstrap version verbatim (decision-log D17(1), S-02)`,
      },
    ]);
  }
  const suppressed = intents.some(
    (intent) => intent.kind === "prerelease" && intent.lineId === config.id,
  );
  if (suppressed) {
    return null;
  }
  const version = Version.parse(bootstrap.version);
  return { version, tag: formatTag(version, input.policy.tagFormats[config.id]) };
}

/** The §2.11 change entries: the release decision's contributing pending set,
 * each member carrying id, recorded lineage, type, and its OWN resolved bump
 * (reviewer m-3): the decision's group winner (§2.7) records the line's
 * release class, while each entry re-resolves that member alone under the
 * declared mapping — a fix inside a minor-graded group is a patch, not the
 * winner's minor. Identity is the kernel change id when the member carries
 * one, the commit sha otherwise; lineage records the provenance the
 * extraction wrote (`originCommit`), falling back to the member's own sha.
 * Non-release decisions contribute no change set. A member whose bump does
 * not resolve is a caller contract violation — the decision graded the line,
 * so the member must grade too; surfacing null would fake a resolvable
 * mapping. */
function changesOf(decision: LineDecision, policy: PolicyInput): PlanLine["changes"] {
  if (decision.kind !== "release") {
    return [];
  }
  return decision.changes.map((parsed) => {
    const bump = resolveBump([parsed], policy);
    if (bump === undefined) {
      throw new InvalidPlanningInputError([
        {
          field: `changes.${parsed.change?.id ?? parsed.sha}`,
          problem: `release-worthy commit ${parsed.sha} does not resolve under the declared bump mapping "${policy.bumpMappingId}" — the decision graded it, so the member must grade too`,
        },
      ]);
    }
    return {
      id: parsed.change?.id ?? parsed.sha,
      lineage: [parsed.change?.lineage.originCommit ?? parsed.sha],
      type: parsed.type ?? "untyped",
      bump,
    };
  });
}

/** Every tag the line's plan mints — the stable target first, then the
 * streams, in mint order, deduplicated by name. One minted tag is one
 * precondition and one artifact even when a declared format (fork 11)
 * renders two mints to the same label. */
function mintedTagsOf(stable: TargetPlan["stable"], streams: readonly PlannedStream[]): string[] {
  const tags: string[] = [];
  if (stable !== null) {
    tags.push(stable.tag);
  }
  for (const stream of streams) {
    tags.push(stream.tag);
  }
  return [...new Set(tags)];
}

/** One §2.11 line tuple. The plan-level propagation plan rides verbatim
 * (reading 2 in the module header); the stable version is recorded as its
 * string; the streams are the planned streams verbatim. */
function assembleLine(
  minted: PlannedLine,
  propagation: PropagationPlan,
  policy: PolicyInput,
): PlanLine {
  const tags = mintedTagsOf(minted.stable, minted.streams);
  const stable =
    minted.stable === null
      ? null
      : { version: minted.stable.version.toString(), tag: minted.stable.tag };
  return {
    lineId: minted.lineId,
    stable,
    streams: minted.streams,
    changes: changesOf(minted.decision, policy),
    propagation,
    preconditions: tags.map((tag) => ({ kind: "tag-absent" as const, tag })),
    artifacts: tags,
  };
}

export const plan: Plan = (raw) => {
  // §2.6's fixed order, stage by stage through the landed doors.
  const input = normalize(raw);
  const extraction = extract(input.repository.commits, input.policy);
  const history = loadTagHistory(input.history.tags, input.lines, input.policy);
  const ranges = deriveRanges(history, input.repository.refs, input.lines);
  const attribution = attribute(extraction, input, ranges);

  // §2.9 + §2.4: the refusal IS the outcome — fail closed, nothing else
  // leaks: no plan, no decisions, no partial attribution.
  if (attribution.kind === "refused") {
    return { kind: "refused", refusal: attribution.refusal };
  }

  // Per line, in input order: decide (§2.9 — ALL decisions are collected,
  // the no-ops and blocks included), rebuild the line's state from its own
  // projected history (§2.13), then plan the stable target (§2.6/§2.7) and
  // the prerelease streams the input's intents demand (§2.8). A line whose
  // plan mints nothing — no stable target, no streams — assembles no
  // PlanLine: the all-no-op plan is §2.10's no-op successor, `lines: []`.
  const configById: Record<string, LineConfig> = Object.fromEntries(
    input.lines.map((config) => [config.id, config]),
  );
  const intents: readonly OperatorIntent[] = input.intents ?? [];
  const decisions: LineDecision[] = [];
  const planned: PlannedLine[] = [];

  for (const line of attribution.lines) {
    const range = requireFound(
      ranges.find((candidate) => candidate.lineId === line.lineId),
      `lines.${line.lineId}`,
      "attribution produced a line the range derivation did not cover",
    );
    const decision = decideLine(line, input, range);
    decisions.push(decision);
    const config = requireFound(
      configById[line.lineId],
      `lines.${line.lineId}`,
      "attribution produced a line the input does not declare",
    );
    const lineHistory = requireFound(
      history.lines.find((candidate) => candidate.lineId === line.lineId),
      `lines.${line.lineId}`,
      "attribution produced a line the history projection did not cover",
    );
    const state = rebuildLineState(lineHistory);
    // D17(1): the first release of a line targets the recorded bootstrap
    // version verbatim — the frozen targets layer cannot see the input's
    // bootstrap record and refuses the shape (planTargets throws here by
    // design), so the door composes the birth target itself and plans the
    // streams directly; everywhere else the targets layer plans both.
    const targets: TargetPlan =
      decision.kind === "release" && state.pointer === null
        ? {
            stable: birthStable(input, config, intents),
            streams: planStreams(intents, decision, state, config, input.policy),
          }
        : planTargets(intents, decision, state, config, input.policy);
    if (targets.stable !== null || targets.streams.length > 0) {
      planned.push({
        lineId: line.lineId,
        decision,
        stable: targets.stable,
        streams: targets.streams,
      });
    }
  }

  // §2.15 releases (reading 1 in the module header), behind D17(8)/PL-01's
  // gate: the caller declares the line↔component release binding — exactly
  // one declared component meets exactly one releasing line — and the door
  // refuses to fabricate it. A plan with no releasing lines needs no
  // binding and propagates honestly over the empty release list. A release
  // decision publishes the component at its stable target — or, when a
  // prerelease intent suppressed the co-mint (D17(3)), at the streams'
  // highest-precedence target: the stream IS the publication there
  // (P-04/P-05/P-07/M-08).
  const components = input.components ?? [];
  const releasing = planned.filter((minted) => minted.decision.kind === "release");
  if (releasing.length > 0 && (components.length !== 1 || releasing.length !== 1)) {
    throw new InvalidPlanningInputError([
      {
        field: components.length === 1 ? "lines" : "components",
        problem:
          `${String(components.length)} component(s) declared but ${String(releasing.length)} line(s) release ` +
          `(${releasing.map((minted) => minted.lineId).join(", ")}) — the door refuses to fabricate the ` +
          "line↔component release mapping (decision-log D17(8), PL-01): declare exactly one component " +
          "for the single releasing line",
      },
    ]);
  }
  const releases: ReleaseEntry[] = [];
  for (const minted of releasing) {
    for (const component of components) {
      const stable = minted.stable;
      if (stable !== null) {
        releases.push({ component: component.name, version: stable.version });
        continue;
      }
      const publication = [...minted.streams].sort((left, right) =>
        right.version.compare(left.version),
      )[0];
      if (publication === undefined) {
        throw new InvalidPlanningInputError([
          {
            field: `lines.${minted.lineId}`,
            problem:
              "a releasing line published neither a stable target nor a stream — target planning produced nothing to map",
          },
        ]);
      }
      releases.push({ component: component.name, version: publication.version });
    }
  }
  const propagation = planPropagation(components, releases);

  // §2.10/§2.11/§2.14: assemble the closed tuple and fingerprint it.
  // `supersedes` is always null from the pure door — threading a prior
  // plan's id is the persistence layer's adjacent concern (§6, D14).
  const lines = planned.map((minted) => assembleLine(minted, propagation, input.policy));
  // D17(6)/§2.13/E-06: the explanation data rides the plan — the foreign
  // tags the history projection surfaced, the identity conflicts the
  // extraction recorded, the commits the extraction excluded — verbatim,
  // in stage order, always present so excluded is never invisible. It is
  // part of the fingerprint tuple (§2.11), so an explanation-only
  // difference changes the planId.
  const planBody = {
    supersedes: null,
    policyDigest: input.policy.digest,
    inputsFingerprint: inputsFingerprint(input),
    lines,
    explanation: {
      foreignTags: history.lines.flatMap((line) => line.foreign),
      conflicts: extraction.conflicts,
      excluded: extraction.excluded,
    },
  };
  return {
    kind: "planned",
    plan: { ...planBody, planId: planFingerprint(planBody) },
    decisions,
  };
};
