/**
 * The bootstrap door (issue #207): take the closed-observation half of a
 * world — the planning observations (`repository`, `history`) plus any
 * declarations the operator already made — and complete it into a usable
 * `PlanningInput`, proposing the baseline policy and the line/tag
 * declarations it can, naming every inference and its evidence, and
 * refusing — never guessing — everything the evidence cannot carry
 * ("anything uninferrable is asked, never guessed").
 *
 * The door is pure: it proposes, it never writes. The one effect bootstrap
 * owns — emitting the configuration document — is the calling surface's
 * declared write, performed only after the first plan is `planned` (a
 * bootstrap whose first plan refuses writes nothing: "partial bootstrap
 * left unreported" is the failure mode, and a written config whose plan
 * cannot run is exactly that).
 *
 * The inference vocabulary is deliberately small, and each row says what it
 * did:
 *
 * - `policy`: the declared fields ride verbatim (kind `declared`); the
 *   absent fields take the baseline values this repository's own fixtures
 *   declare (kind `baseline`, "the declared defaults; override them in the
 *   declared policy"). `policy.digest` is never defaulted — it is the
 *   effective policy's content identity (invariant 4), an opaque value the
 *   operator records; an absent digest is a gap, not a synthesized string.
 * - `lines`: declared lines ride verbatim. An absent line list is a gap:
 *   the stable line identity (invariant 7) is never inferred from tag
 *   names, and the line's `feedRef` is a declared ref name the operator
 *   owns. Nothing guesses either.
 * - tag formats: when exactly one line is declared, its format is not
 *   declared, and the observed tags carry exactly one distinct static
 *   prefix before a kernel-parsed version (e.g. tag `lib-a-v1.2.3` →
 *   prefix `lib-a-v`), the door proposes
 *   `policy.tagFormats[line.id] = prefix + "{major}.{minor}.{patch}{prerelease}"`
 *   (kind `inferred`, the observed tags quoted as evidence). Any ambiguity
 *   — several lines, several prefixes, a declared format — proposes
 *   nothing; the planner's own history projection then surfaces the tags it
 *   cannot admit as foreign (E-06), never silently drops them.
 */

import { InvalidVersionError, Version } from "@ecoma-io/release-craft/domain";
import {
  type BootstrapDecision,
  type ChannelObservation,
  type ComponentMeta,
  type LineConfig,
  type OperatorIntent,
  type PlanningInput,
} from "@ecoma-io/release-craft/planner";

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/** One uninferrable fact — the "asked, never guessed" refusal:
 * the field that must be declared and why the evidence cannot supply it. */
export interface BootstrapGap {
  /** The input field the operator must declare (e.g. `lines`). */
  readonly field: string;
  /** Why the evidence cannot infer it — the refusal's own words. */
  readonly problem: string;
}

/** One proposed completion of the world: the field, what supplied it, and
 * the evidence that names the provenance. */
export interface BootstrapInference {
  /** The completed input field this row concerns. */
  readonly field: string;
  /** `declared` — the operator's own word, proposed verbatim;
   * `baseline` — the declared default, named as such;
   * `inferred` — derived from the observations, with the evidence quoted. */
  readonly kind: "declared" | "baseline" | "inferred";
  /** The provenance statement — the evidence for an inference, the
   * declaration's own words for a declaration, the baseline's name for a
   * default. */
  readonly evidence: string;
}

/** The bootstrap door's input: the closed observations (`repository`,
 * `history`) plus whatever the operator already chose to declare. Every
 * part present is proposed verbatim; every absent part is either completed
 * by a named inference or refused as a gap. */
export interface BootstrapObservations {
  readonly repository: PlanningInput["repository"];
  readonly history: PlanningInput["history"];
  readonly policy?: {
    readonly digest?: string;
    readonly bumpMappingId?: string;
    readonly prereleaseLadder?: readonly string[];
    readonly prereleaseSeed?: "0" | "1";
    readonly pre10Dampening?: boolean;
    readonly selfReferenceNamespace?: string;
    readonly tagFormats?: Readonly<Record<string, string>>;
  };
  readonly lines?: readonly LineConfig[];
  readonly components?: readonly ComponentMeta[];
  readonly bootstrap?: BootstrapDecision;
  readonly intents?: readonly OperatorIntent[];
  readonly channels?: readonly ChannelObservation[];
}

/** The completed world plus the inference ledger — what the door proposes
 * and why. */
export interface BootstrapProposal {
  readonly input: PlanningInput;
  readonly inferences: readonly BootstrapInference[];
}

/** The door's refusal: the gaps, in declaration order. Nothing was
 * completed and nothing may be written — a partial bootstrap that cannot
 * plan is the failure mode the refusal makes unrepresentable. */
export interface BootstrapRefusal {
  readonly gaps: readonly BootstrapGap[];
}

export type BootstrapProposeResult = BootstrapProposal | BootstrapRefusal;

// ---------------------------------------------------------------------------
// The baseline policy — the declared defaults, named as such
// ---------------------------------------------------------------------------

/** The baseline policy rows (the values this repository's own fixtures
 * declare): every absent declared field takes these, and the inference
 * ledger names them `baseline`. `digest` is deliberately absent — it is
 * the operator's recorded content identity, never a default. */
export const BOOTSTRAP_BASELINE_POLICY: Readonly<{
  bumpMappingId: string;
  prereleaseLadder: readonly string[];
  prereleaseSeed: "0" | "1";
  pre10Dampening: boolean;
  selfReferenceNamespace: string;
  tagFormats: Readonly<Record<string, string>>;
}> = {
  bumpMappingId: "default",
  prereleaseLadder: ["alpha", "beta", "rc"],
  prereleaseSeed: "0",
  pre10Dampening: true,
  selfReferenceNamespace: "Release-Craft:",
  tagFormats: {},
};

// ---------------------------------------------------------------------------
// The tag-format inference — one line, one prefix, all evidence quoted
// ---------------------------------------------------------------------------

/**
 * The longest version-shaped suffix of a tag name, parsed through the
 * kernel grammar: `lib-a-v1.2.3` → prefix `lib-a-v`, version `1.2.3`;
 * `v1.2.4-rc.0` → prefix `v`, version `1.2.4-rc.0`; `1.2.3` → prefix ``,
 * version `1.2.3`. `null` when no suffix parses — the tag is not version
 * evidence for any format. Kernel rejections (`InvalidVersionError`) are
 * caught and treated as "this suffix is not a version", never propagated —
 * the planning-boundary posture of ADR-0003 decision 1.
 */
const versionSuffixOf = (
  name: string,
): { readonly prefix: string; readonly version: Version } | null => {
  for (let index = 0; index < name.length; index += 1) {
    let parsed: Version;
    try {
      parsed = Version.parse(name.slice(index));
    } catch (error) {
      if (!(error instanceof InvalidVersionError)) {
        throw error;
      }
      continue;
    }
    return { prefix: name.slice(0, index), version: parsed };
  }
  return null;
};

// ---------------------------------------------------------------------------
// The door
// ---------------------------------------------------------------------------

/** Complete the observations into a `PlanningInput`, proposing every
 * completion and refusing the gaps. Pure: no reads, no writes, no clock —
 * identical observations propose identical worlds (invariant 2, inherited). */
export const proposeBootstrap = (observations: BootstrapObservations): BootstrapProposeResult => {
  const gaps: BootstrapGap[] = [];
  const inferences: BootstrapInference[] = [];

  // -- the policy ---------------------------------------------------------
  const declaredPolicy = observations.policy ?? {};
  const declaredTagFormats: Readonly<Record<string, string>> = declaredPolicy.tagFormats ?? {};
  const digest = declaredPolicy.digest;
  if (digest === undefined || digest.length === 0) {
    gaps.push({
      field: "policy.digest",
      problem:
        "the effective policy's content identity (invariant 4) — record it; no inference computes it, and every record and plan binds to it",
    });
  } else {
    inferences.push({
      field: "policy.digest",
      kind: "declared",
      evidence: "declared by the operator — proposed verbatim",
    });
  }

  /** The ledger row for one policy field, plus the field's completed
   * value: the operator's word verbatim, or the named baseline. Four
   * fields call this; the lockstep ledger row is the whole point. */
  const policyField = <T>(field: string, declared: T | undefined, baseline: T): T => {
    if (declared !== undefined) {
      inferences.push({
        field: `policy.${field}`,
        kind: "declared",
        evidence: "declared by the operator — proposed verbatim",
      });
      return declared;
    }
    inferences.push({
      field: `policy.${field}`,
      kind: "baseline",
      evidence: `the declared baseline (${JSON.stringify(baseline)}) — override it in the declared policy`,
    });
    return baseline;
  };

  // -- the lines ----------------------------------------------------------
  const declaredLines = observations.lines;
  if (declaredLines === undefined) {
    gaps.push({
      field: "lines",
      problem:
        "no line declaration — declare the first line (its stable id and its declared feed ref); the stable line identity (invariant 7) is never inferred from tag names",
    });
  } else if (declaredLines.length === 0) {
    gaps.push({
      field: "lines",
      problem: "an empty line list cannot bootstrap — declare at least one release line",
    });
  } else {
    inferences.push({
      field: "lines",
      kind: "declared",
      evidence: "declared by the operator — proposed verbatim",
    });
  }

  // -- the tag-format inference -------------------------------------------
  // Collect the distinct static prefixes the observed tags carry before
  // their kernel-parsed versions. Only the unambiguous case proposes
  // anything: exactly one declared line, no declared format for it, and
  // exactly one non-empty prefix. Everything else proposes nothing — the
  // planner's history projection surfaces what it cannot admit as foreign
  // (E-06), never silently dropped, and no namespace is ever guessed.
  const prefixes = new Map<string, string[]>();
  for (const tag of observations.history.tags) {
    const suffix = versionSuffixOf(tag.name);
    if (suffix === null || suffix.prefix.length === 0) {
      continue;
    }
    const carried = prefixes.get(suffix.prefix) ?? [];
    carried.push(tag.name);
    prefixes.set(suffix.prefix, carried);
  }
  const soleLine =
    declaredLines !== undefined && declaredLines.length === 1 ? declaredLines[0] : undefined;
  let inferredFormat: string | undefined;
  const first = prefixes.entries().next();
  if (
    soleLine !== undefined &&
    prefixes.size === 1 &&
    !first.done &&
    declaredTagFormats[soleLine.id] === undefined
  ) {
    const [prefix, carried] = first.value;
    inferredFormat = `${prefix}{major}.{minor}.{patch}{prerelease}`;
    inferences.push({
      field: `policy.tagFormats[${JSON.stringify(soleLine.id)}]`,
      kind: "inferred",
      evidence:
        `the observed tags ${carried.map((name) => JSON.stringify(name)).join(", ")} carry exactly one ` +
        `static prefix before their kernel-parsed version; the proposed format ` +
        `${JSON.stringify(inferredFormat)} renders them verbatim. Re-declare the policy digest over ` +
        `the proposed policy when you accept it — the inferred format changes the effective ` +
        `policy's identity`,
    });
  }
  const tagFormats: Record<string, string> = { ...declaredTagFormats };
  if (soleLine !== undefined && inferredFormat !== undefined) {
    tagFormats[soleLine.id] = inferredFormat;
  }

  const policy: PlanningInput["policy"] = {
    digest: digest ?? "",
    bumpMappingId: policyField(
      "bumpMappingId",
      declaredPolicy.bumpMappingId,
      BOOTSTRAP_BASELINE_POLICY.bumpMappingId,
    ),
    prereleaseLadder: policyField(
      "prereleaseLadder",
      declaredPolicy.prereleaseLadder,
      BOOTSTRAP_BASELINE_POLICY.prereleaseLadder,
    ),
    prereleaseSeed: policyField(
      "prereleaseSeed",
      declaredPolicy.prereleaseSeed,
      BOOTSTRAP_BASELINE_POLICY.prereleaseSeed,
    ),
    pre10Dampening: policyField(
      "pre10Dampening",
      declaredPolicy.pre10Dampening,
      BOOTSTRAP_BASELINE_POLICY.pre10Dampening,
    ),
    selfReferenceNamespace: policyField(
      "selfReferenceNamespace",
      declaredPolicy.selfReferenceNamespace,
      BOOTSTRAP_BASELINE_POLICY.selfReferenceNamespace,
    ),
    tagFormats,
  };

  // -- the completed world -------------------------------------------------
  // Absent declaration halves stay absent — the planner's own input rules
  // decide what each half means (an absent `intents` is "no intents", an
  // absent `channels` is "no channels").
  const input: PlanningInput = {
    policy,
    repository: observations.repository,
    history: observations.history,
    lines: declaredLines ?? [],
    ...(observations.components !== undefined ? { components: observations.components } : {}),
    ...(observations.bootstrap !== undefined ? { bootstrap: observations.bootstrap } : {}),
    ...(observations.intents !== undefined ? { intents: observations.intents } : {}),
    ...(observations.channels !== undefined ? { channels: observations.channels } : {}),
  };

  if (gaps.length > 0) {
    return { gaps };
  }
  return { input, inferences };
};
