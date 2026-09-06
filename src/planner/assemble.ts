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
 * Four frozen-shape readings this assembly pins, per the contract's wording:
 *
 * 1. **Component mapping (§2.15, D17(8) → D18 Decision 4, PL-01's seam).**
 *    `planPropagation` is called once per plan. The door refuses to
 *    fabricate the line↔component release mapping: each releasing line's
 *    release entry binds to the component its declared `publishes` names;
 *    where the declaration is absent, the D17(8) single-component posture
 *    stands — the one declared component carries the release. A releasing
 *    line without the declaration in any other world, or two releasing
 *    lines binding the same component, is the caller contract violation
 *    naming the gap (a binding naming an undeclared component is closed
 *    out at the input seam's component universe). A
 *    zero-release plan needs no binding and propagates honestly over an
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
 * 4. **The refusal records (§2.9, D18/M-08).** A prerelease demand a
 *    line's declared admission posture refuses is composed into
 *    `refusedIntents` from the same predicate `planStreams` omits the
 *    demand with — one record per refused intent, in input order, never a
 *    stable fallback: the refusing line's own release still mints, and
 *    allowed requests plan as today.
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
import { formatTag, isStreamAllowed, planStreams, planTargets } from "./plan.js";
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
  RefusedIntent,
  WithheldCommit,
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

/** A refused demand's reason (§2.8, D18): the declared posture named — the
 * stable-only knob, or the allow list the identifier sits outside — with
 * the refused identifier. It rides the fingerprinted plan, so it is pure
 * data of the input. */
function refusedStreamReason(line: LineConfig, identifier: string): string {
  const allow = line.streams?.allow;
  if (allow === "none") {
    return `line ${line.id} is stable-only — the line's declared stream policy admits no prerelease streams (D18)`;
  }
  if (allow === undefined || allow === "all") {
    return `line ${line.id} admits prerelease stream ${JSON.stringify(identifier)} — no declared posture refuses it`;
  }
  return (
    `line ${line.id}'s declared allow list (` +
    allow.map((name) => JSON.stringify(name)).join(", ") +
    `) does not admit prerelease stream ${JSON.stringify(identifier)} (D18)`
  );
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
    // D18: a refused or withheld line contributes no plan line — no
    // targets, no streams, no release entry (§2.9's amendment): the
    // decision record is the line's whole presence in the pass. Every
    // other non-birth decision keeps the P-07 posture (streams mint for
    // the line even when the stable does not move).
    const targets: TargetPlan =
      decision.kind === "refused" || decision.kind === "withheld"
        ? { stable: null, streams: [] }
        : decision.kind === "release" && state.pointer === null
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

  // M-11, plan level: the tag namespace is global (invariant 6) — two
  // lines minting the same tag in one pass is a self-conflicting plan,
  // each line's tag-absent precondition falsifying the other's. The door
  // refuses before assembly, naming the colliding tag, both lines, and
  // both decisions' head commits. Per-package tag formats keep distinct-
  // namespace worlds (one tag shape per component) legal; identical
  // formats colliding on the same next version is the operator's repair.
  const tagOwner = new Map<string, string>();
  for (const minted of planned) {
    const tags = [
      ...(minted.stable === null ? [] : [minted.stable.tag]),
      ...minted.streams.map((stream) => stream.tag),
    ];
    for (const tag of tags) {
      const priorLineId = tagOwner.get(tag);
      if (priorLineId !== undefined) {
        const prior = requireFound(
          planned.find((candidate) => candidate.lineId === priorLineId),
          `lines.${priorLineId}`,
          "collision check named a line the planned set does not carry",
        );
        return {
          kind: "refused",
          refusal: {
            kind: "refused",
            cause: "version-collision",
            commits: [prior.decision.range.head, minted.decision.range.head],
            policyDigest: input.policy.digest,
            detail:
              `version collision: tag ${JSON.stringify(tag)} is minted by both ` +
              `line ${JSON.stringify(priorLineId)} (head ${prior.decision.range.head}) ` +
              `and line ${JSON.stringify(minted.lineId)} (head ${minted.decision.range.head}) — ` +
              "one tag in the global namespace cannot carry two bodies (M-11): " +
              "give the lines distinct per-package tag formats or distinct targets",
          },
        };
      }
      tagOwner.set(tag, minted.lineId);
    }
  }

  // §2.15 releases (reading 1 in the module header), behind D18 Decision 4's
  // declared binding: each releasing line's release entry binds to the
  // component its `publishes` names — the mapping becomes closed input, the
  // anti-fabrication posture stands around it. Where the declaration is
  // absent, the D17(8) single-component posture carries the release; a
  // releasing line without the declaration in any other world, or two
  // releasing lines binding the same component, is the caller contract
  // violation naming the gap (an undeclared binding name cannot reach
  // here — input normalization's component universe rejects it first). A
  // release decision publishes the component at its stable target — or,
  // when an admissible prerelease intent suppressed the co-mint (D17(3)),
  // at the streams' highest-precedence target: the stream IS the
  // publication there (P-04/P-05/P-07/M-08).
  const components = input.components ?? [];
  const releasing = planned.filter((minted) => minted.decision.kind === "release");
  const boundReleases: { readonly minted: PlannedLine; readonly component: string }[] = [];
  const firstBoundLine = new Map<string, string>();
  for (const minted of releasing) {
    const config = requireFound(
      configById[minted.lineId],
      `lines.${minted.lineId}`,
      "attribution produced a line the input does not declare",
    );
    let component = config.publishes;
    if (component === undefined) {
      if (components.length !== 1) {
        throw new InvalidPlanningInputError([
          {
            field: `lines.${minted.lineId}.publishes`,
            problem:
              `${String(components.length)} component(s) declared (` +
              components.map((candidate) => JSON.stringify(candidate.name)).join(", ") +
              `) but line "${minted.lineId}" releases without declaring publishes ` +
              "— the door refuses to fabricate the line↔component release mapping " +
              "(decision-log D17(8), PL-01): declare publishes on every releasing line " +
              "the one-component posture cannot carry (D18 decision 4, ADR-0004)",
          },
        ]);
      }
      const sole = requireFound(
        components[0],
        "components",
        "the single-component posture carries the release, but no component is declared",
      );
      component = sole.name;
    }
    const first = firstBoundLine.get(component);
    if (first !== undefined) {
      throw new InvalidPlanningInputError([
        {
          field: `lines.${minted.lineId}.publishes`,
          problem:
            `lines "${first}" and "${minted.lineId}" both bind their releases to component ` +
            `${JSON.stringify(component)} — a declared component carries one release per ` +
            "pass, so the mapping is ambiguous (D18 decision 4, ADR-0004): give each " +
            "releasing line its own component",
        },
      ]);
    }
    firstBoundLine.set(component, minted.lineId);
    boundReleases.push({ minted, component });
  }
  const releases: ReleaseEntry[] = boundReleases.map(({ minted, component }) => {
    const stable = minted.stable;
    if (stable !== null) {
      return { component, version: stable.version };
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
    return { component, version: publication.version };
  });
  const propagation = planPropagation(components, releases);

  // D18/M-08 (ADR-0004 decision 1): the prerelease demands the lines'
  // declared admission postures refuse — one record per refused intent, in
  // input order, from the same predicate planStreams omits the demand with.
  // A refusal is a fingerprinted record, never a stable fallback: the
  // refusing line's own release still mints, an allowed request plans as
  // today, and an intent naming an undeclared line stays inert — no
  // declared posture exists to refuse it.
  const refusedIntents: RefusedIntent[] = [];
  for (const intent of intents) {
    if (intent.kind !== "prerelease") {
      continue;
    }
    const config = configById[intent.lineId];
    if (config === undefined || isStreamAllowed(config, intent.stream)) {
      continue;
    }
    refusedIntents.push({
      intent,
      lineId: intent.lineId,
      reason: refusedStreamReason(config, intent.stream),
    });
  }

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
  // D18 (PL-07): the withhold-deferred set, curated onto the plan's
  // explanation — the decision records carry the raw commits; here each
  // deferral names its line, matched scope, and the rule's reason, so a
  // stored plan shows what is waiting inside the un-released span
  // (recoverable after an unfreeze — deferral is never deletion).
  const withheldOnPlan: WithheldCommit[] = [];
  for (const decision of decisions) {
    const deferred =
      decision.kind === "withheld"
        ? decision.withheld
        : decision.kind === "release"
          ? (decision.withheld ?? [])
          : [];
    if (deferred.length === 0) {
      continue;
    }
    const rules = configById[decision.lineId]?.withhold ?? [];
    for (const parsed of deferred) {
      // decide defers only rule-matched commits, so this is a tripwire,
      // not a filter: a deferred commit may never disappear from the
      // persisted explanation (excluded is not invisible).
      const rule = requireFound(
        rules.find((candidate) => candidate.scope === parsed.scope),
        `lines.${decision.lineId}.withhold`,
        `a deferred commit (${parsed.sha}) matches no declared withhold rule — the decision and the plan explanation disagree`,
      );
      withheldOnPlan.push({
        lineId: decision.lineId,
        sha: parsed.sha,
        scope: rule.scope,
        reason: rule.reason,
      });
    }
  }
  const planBody = {
    supersedes: null,
    policyDigest: input.policy.digest,
    inputsFingerprint: inputsFingerprint(input),
    lines,
    // D18/M-08: the requested streams the lines' declared postures refused —
    // composed above from the same predicate planStreams omits demands
    // with; the empty default is the fingerprinted record "nothing was
    // refused".
    refusedIntents,
    explanation: {
      foreignTags: history.lines.flatMap((line) => line.foreign),
      conflicts: extraction.conflicts,
      excluded: extraction.excluded,
      withheld: withheldOnPlan,
    },
  };
  return {
    kind: "planned",
    plan: { ...planBody, planId: planFingerprint(planBody) },
    decisions,
  };
};
