/**
 * The Release PR gate (issue #202): detect a pending release, project the
 * recorded plan onto PR content, create the PR, and on later recomputes
 * update the same PR in place — or refuse loudly. The gate is the door
 * that keeps a release PR a pure render of a plan: the body embeds the
 * identity claim and the plan fingerprint, every re-render is
 * deterministic over the plan alone, and a PR whose claim disagrees with
 * the recomputed world is a recorded refusal, never a silent rewrite.
 *
 * Architecture (ADR-0003/ADR-0010): the gate composes behind the planner
 * seam — it consumes a computed `ReleasePlan` and never plans itself —
 * and rides the execution ledger's write-ahead discipline (ADR-0006, as
 * `scheduleHooks`/`scheduleArtifacts` perform it): a `gate-start` record
 * is appended before any port mutation and a `gate-outcome` record after,
 * so a crash mid-mutation is visible in the sink. Remote PR operations
 * enter only as the injected `ReleasePRPort` — the app layer's boundary
 * (type-app → domain/planner/execution/adapters-git, judged by the
 * archkeep gate via module-boundaries.config.mjs) never imports a remote
 * adapter; remote concerns bind at adapters.
 *
 * Identity is the component + release line + target branch triplet,
 * carried in the body's marker. Labels are organizational only: the gate
 * never reads a label as identity (issue #202 §11.5 — a mutable label
 * masquerading as identity is the defect this gate exists to prevent).
 */

import type { PlanLine, ReleasePlan } from "@ecoma-io/release-craft/planner";
import type {
  ExistingPR,
  ReleasePRFile,
  ReleasePRIdentity,
  ReleasePRPort,
  ReleasePRProjection,
  ReleasePROutcome,
  ReleasePRTransportFailure,
} from "./release-pr-types.js";

// ---------------------------------------------------------------------------
// §1 — the identity claim marker (the body's embedded claim)
// ---------------------------------------------------------------------------

/**
 * The claim marker lives in an HTML comment so it never renders. The
 * fields are whitespace-free tokens (planner line ids and component names
 * are identifiers; branch names may carry slashes but no spaces). The
 * encoded form is produced inside `renderBody` below; this pattern is the
 * parse half of the same format.
 */
const MARKER_PATTERN =
  /<!--\s*release-craft:\s*identity\s+component=([^\s>]+)\s+line=([^\s>]+)\s+target=([^\s>]+)\s+plan=([^\s>]+)\s*-->/;

/** The parsed claim: the identity the PR was created (or last updated)
 * under, and the plan fingerprint its body renders. */
export interface ParsedIdentityClaim {
  readonly component: string;
  readonly releaseLine: string;
  readonly targetBranch: string;
  readonly planId: string;
}

/** Parse the claim from a PR body. Returns `null` when the body carries
 * no well-formed marker — a foreign PR, or a body whose claim was edited
 * away. The gate treats `null` as unverifiable and refuses. */
export const parseIdentityClaim = (body: string): ParsedIdentityClaim | null => {
  const match = MARKER_PATTERN.exec(body);
  if (match === null) return null;
  const [, component, releaseLine, targetBranch, planId] = match;
  if (
    component === undefined ||
    releaseLine === undefined ||
    targetBranch === undefined ||
    planId === undefined
  ) {
    return null;
  }
  return { component, releaseLine, targetBranch, planId };
};

// ---------------------------------------------------------------------------
// §2 — the projection: a pure render of the recorded plan
// ---------------------------------------------------------------------------

/** The scope option: render only the named lines. Unknown line ids are
 * a caller error thrown at the door (the closed-set discipline the
 * assembly config check performs) — a silently-dropped id would project
 * a PR missing a line. */
export class ReleasePRScopeError extends Error {
  /** The scope ids no plan line declares. */
  readonly unknownLineIds: readonly string[];

  constructor(unknownLineIds: readonly string[]) {
    super(
      `release-pr scope names unknown line ids ${unknownLineIds.map((id) => JSON.stringify(id)).join(", ")}`,
    );
    this.name = "ReleasePRScopeError";
    this.unknownLineIds = unknownLineIds;
  }
}

/** The render's result: the projection plus the pending lines it was
 * rendered from (the gate's own pending-release detection output). */
export interface ReleasePRRender {
  readonly projection: ReleasePRProjection;
  readonly pendingLines: readonly PlanLine[];
}

/** Resolve the scope against the plan's known lines, throwing
 * `ReleasePRScopeError` for unknown ids. */
const resolveScopedLines = (
  plan: ReleasePlan,
  scope: readonly string[] | undefined,
): readonly PlanLine[] => {
  if (scope === undefined) return plan.lines;
  const unknown = scope.filter((id) => !plan.lines.some((line) => line.lineId === id));
  if (unknown.length > 0) throw new ReleasePRScopeError(unknown);
  return plan.lines.filter((line) => scope.includes(line.lineId));
};

/** The deterministic title: one token per target, stable first. */
const renderTitle = (pending: readonly PlanLine[]): string => {
  const tokens: string[] = [];
  for (const line of pending) {
    if (line.stable !== null) tokens.push(`${line.lineId} v${line.stable.version}`);
    for (const stream of line.streams) tokens.push(`${line.lineId} ${stream.tag}`);
  }
  return `chore(release): ${tokens.join(", ")}`;
};

/** The deterministic body: the claim marker (the encoded identity and
 * plan fingerprint — the parse half lives in `parseIdentityClaim`), then
 * one section per pending line with its targets, streams, and changes. */
const renderBody = (
  identity: ReleasePRIdentity,
  plan: ReleasePlan,
  pending: readonly PlanLine[],
): string => {
  const marker = `<!-- release-craft: identity component=${identity.component} line=${identity.releaseLine} target=${identity.targetBranch} plan=${plan.planId} -->`;
  const sections: string[] = [];
  sections.push(marker);
  sections.push("", `## Release plan \`${plan.planId}\``);
  if (plan.supersedes !== null) sections.push("", `Supersedes: \`${plan.supersedes}\`.`);
  for (const line of pending) {
    sections.push("", `### \`${line.lineId}\``);
    if (line.stable !== null) {
      sections.push(
        "",
        `- Stable target: \`v${line.stable.version}\` (tag \`${line.stable.tag}\`).`,
      );
    }
    for (const stream of line.streams) {
      sections.push(
        `- Stream \`${stream.identifier}\`: \`${stream.version.toString()}\` (tag \`${stream.tag}\`, seed \`${stream.seed}\`).`,
      );
    }
    if (line.changes.length > 0) {
      sections.push("", "Changes:");
      for (const change of line.changes) {
        sections.push(`- ${change.type}: ${change.id} (${change.bump})`);
      }
    }
  }
  return `${sections.join("\n")}\n`;
};

/** The constant organizational label. Identity never rides a label —
 * the label set is deliberately state-free. */
const PROJECTION_LABELS: readonly string[] = ["release-craft"];

/** The deterministic file tree: the changelog projection of the pending
 * lines — the recorded plan's human-readable file form. */
const renderFiles = (pending: readonly PlanLine[]): readonly ReleasePRFile[] => {
  const lines: string[] = ["# Changelog", ""];
  for (const line of pending) {
    const heading =
      line.stable !== null
        ? `## ${line.stable.tag} (${line.lineId})`
        : `## ${line.lineId} (prerelease)`;
    lines.push(heading, "");
    for (const change of line.changes) {
      lines.push(`- ${change.type}: ${change.id} (${change.bump})`);
    }
    lines.push("");
  }
  return [{ path: "CHANGELOG.md", content: lines.join("\n") }];
};

/** Render the projection from the recorded plan — pure, deterministic:
 * the same plan, identity, and scope always render byte-identical
 * content, at create and at update, so the PR body can never drift from
 * the plan. Returns `null` when no pending release remains after
 * scoping (a line is pending when the plan targets a stable version or
 * any prerelease stream for it). Throws `ReleasePRScopeError` for
 * unknown scope ids. */
export const renderReleasePRProjection = (
  identity: ReleasePRIdentity,
  plan: ReleasePlan,
  scope?: { readonly lines?: readonly string[] },
): ReleasePRRender | null => {
  const scoped = resolveScopedLines(plan, scope?.lines);
  const pending = scoped.filter((line) => line.stable !== null || line.streams.length > 0);
  if (pending.length === 0) return null;
  return {
    pendingLines: pending,
    projection: {
      title: renderTitle(pending),
      body: renderBody(identity, plan, pending),
      labels: PROJECTION_LABELS,
      files: renderFiles(pending),
    },
  };
};

// ---------------------------------------------------------------------------
// §3 — the write-ahead sink (the ledger's discipline, ADR-0006)
// ---------------------------------------------------------------------------

/** Which door the record belongs to: `gate-start` records belong to a
 * mutating door (create, update); `gate-outcome` records a verdict of
 * any door — a read-only `detect` records only when its port lookup
 * itself fails. */
export type ReleasePRGateAction = "create" | "update" | "detect";

/** A gate record: the write-ahead `gate-start` appended before a port
 * mutation, and the `gate-outcome` appended after — for mutations, for
 * recorded refusals, and for recorded transport failures alike. A
 * `gate-start` with no matching outcome is a crash mid-mutation,
 * visible in the sink. */
export type ReleasePRRecord =
  | {
      readonly kind: "gate-start";
      readonly action: ReleasePRGateAction;
      readonly identity: ReleasePRIdentity;
      readonly planId: string;
    }
  | {
      readonly kind: "gate-outcome";
      readonly action: ReleasePRGateAction;
      readonly identity: ReleasePRIdentity;
      readonly planId: string;
      readonly outcome: ReleasePROutcome;
    };

/** The append-only sink the gate records into (the ledger port's
 * discipline: append-only, frozen on append, ordered by insertion). */
export interface ReleasePRRecordSink {
  append(record: ReleasePRRecord): ReleasePRRecord;
}

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
};

/** The in-memory reference sink (the `MemoryLedger` of this gate). */
export class MemoryRecordSink implements ReleasePRRecordSink {
  readonly #records: ReleasePRRecord[] = [];

  append(record: ReleasePRRecord): ReleasePRRecord {
    const frozen = deepFreeze(record);
    this.#records.push(frozen);
    return frozen;
  }

  /** The records so far, oldest first — a copy, so the sink stays
   * append-only through the read seam. */
  tail(): readonly ReleasePRRecord[] {
    return [...this.#records];
  }
}

// ---------------------------------------------------------------------------
// §4 — the gate door (composition behind a factory, ADR-0010 decision 2)
// ---------------------------------------------------------------------------

/** The gate's options: the lines scope (§2), and the draft flag a
 * create honors (issue #202: draft PRs supported). */
export interface ReleasePRGateOptions {
  readonly draft?: boolean;
  readonly lines?: readonly string[];
}

/** The gate door: detect, create, update. Every method returns an
 * outcome — refusals are values, never exceptions; only an invalid
 * scope throws at the door. */
export interface ReleasePRGate {
  /** Detect a pending release and any existing PR for the identity.
   * Read-only — it never mutates and writes no records on the happy
   * path; a port transport failure is the one recorded verdict. */
  detect(
    identity: ReleasePRIdentity,
    plan: ReleasePlan,
    options?: ReleasePRGateOptions,
  ): ReleasePROutcome;

  /** Create the PR for a pending release. When a PR already matches the
   * identity the door returns `found` rather than duplicating it. */
  create(
    identity: ReleasePRIdentity,
    plan: ReleasePlan,
    options?: ReleasePRGateOptions,
  ): ReleasePROutcome;

  /** Update the existing PR in place for a recomputed plan — or refuse
   * loudly: a changed identity, a body that lost its claim, a body
   * drifted from its recorded plan's render, and a recomputed plan that
   * does not supersede the recorded one are all recorded conflicts. */
  update(
    identity: ReleasePRIdentity,
    plan: ReleasePlan,
    options?: ReleasePRGateOptions,
  ): ReleasePROutcome;
}

/** The identity lookup's result: the found PR, none, or a recorded
 * transport failure — the lookup never throws across the door. */
type FoundExistingPR =
  | { readonly kind: "existing"; readonly pr: ExistingPR }
  | { readonly kind: "none" }
  | ReleasePRTransportFailure;

/** Open the gate over an injected port (and optionally a record sink).
 * The door wires; it owns nothing — consistent with the assembled
 * adapter's injection discipline. */
export const openReleasePRGate = (
  port: ReleasePRPort,
  sink?: ReleasePRRecordSink,
): ReleasePRGate => {
  const recordOutcome = (
    action: ReleasePRGateAction,
    identity: ReleasePRIdentity,
    planId: string,
    outcome: ReleasePROutcome,
  ): void => {
    sink?.append({ kind: "gate-outcome", action, identity, planId, outcome });
  };

  /** The identity lookup, wrapped like every other port call: a
   * transport error is a recorded `transport-failure` verdict, never a
   * raw exception crossing the door (the outcomes-only contract). */
  const findExistingPR = (
    identity: ReleasePRIdentity,
    plan: ReleasePlan,
    action: ReleasePRGateAction,
  ): FoundExistingPR => {
    try {
      const existing = port.findPR(identity);
      return existing === null ? { kind: "none" } : { kind: "existing", pr: existing };
    } catch (error) {
      const outcome: ReleasePRTransportFailure = {
        kind: "transport-failure",
        detail: error instanceof Error ? error.message : String(error),
      };
      recordOutcome(action, identity, plan.planId, outcome);
      return outcome;
    }
  };

  const performCreate = (
    identity: ReleasePRIdentity,
    plan: ReleasePlan,
    projection: ReleasePRProjection,
    draft: boolean,
  ): ReleasePROutcome => {
    sink?.append({ kind: "gate-start", action: "create", identity, planId: plan.planId });
    try {
      const pr = port.createPR({
        identity,
        title: projection.title,
        body: projection.body,
        labels: projection.labels,
        draft,
        files: projection.files,
      });
      const outcome: ReleasePROutcome = { kind: "created", pr, projection };
      recordOutcome("create", identity, plan.planId, outcome);
      return outcome;
    } catch (error) {
      const outcome: ReleasePROutcome = {
        kind: "transport-failure",
        detail: error instanceof Error ? error.message : String(error),
      };
      recordOutcome("create", identity, plan.planId, outcome);
      return outcome;
    }
  };

  const performUpdate = (
    identity: ReleasePRIdentity,
    plan: ReleasePlan,
    projection: ReleasePRProjection,
    existing: ExistingPR,
  ): ReleasePROutcome => {
    sink?.append({ kind: "gate-start", action: "update", identity, planId: plan.planId });
    try {
      const pr = port.updatePR({
        prNumber: existing.number,
        title: projection.title,
        body: projection.body,
        labels: projection.labels,
        draft: existing.draft,
        files: projection.files,
      });
      const outcome: ReleasePROutcome = { kind: "updated", pr, projection };
      recordOutcome("update", identity, plan.planId, outcome);
      return outcome;
    } catch (error) {
      const outcome: ReleasePROutcome = {
        kind: "transport-failure",
        detail: error instanceof Error ? error.message : String(error),
      };
      recordOutcome("update", identity, plan.planId, outcome);
      return outcome;
    }
  };

  const refuse = (
    identity: ReleasePRIdentity,
    plan: ReleasePlan,
    outcome: ReleasePROutcome,
  ): ReleasePROutcome => {
    recordOutcome("update", identity, plan.planId, outcome);
    return outcome;
  };

  return {
    detect: (identity, plan, options) => {
      const rendered = renderReleasePRProjection(identity, plan, options);
      if (rendered === null) return { kind: "nothing-pending" };
      const found = findExistingPR(identity, plan, "detect");
      if (found.kind === "transport-failure") return found;
      if (found.kind === "none") return { kind: "detected", identity, plan };
      return { kind: "found", pr: found.pr, plan };
    },

    create: (identity, plan, options) => {
      const rendered = renderReleasePRProjection(identity, plan, options);
      if (rendered === null) return { kind: "nothing-pending" };
      const found = findExistingPR(identity, plan, "create");
      if (found.kind === "transport-failure") return found;
      if (found.kind === "existing") return { kind: "found", pr: found.pr, plan };
      return performCreate(identity, plan, rendered.projection, options?.draft ?? false);
    },

    update: (identity, plan, options) => {
      const rendered = renderReleasePRProjection(identity, plan, options);
      if (rendered === null) return { kind: "nothing-pending" };
      const found = findExistingPR(identity, plan, "update");
      if (found.kind === "transport-failure") return found;
      if (found.kind === "none") return { kind: "detected", identity, plan };
      const existing = found.pr;

      const claim = parseIdentityClaim(existing.body);
      if (claim === null) {
        return refuse(identity, plan, {
          kind: "plan-conflict",
          recordedPlanId: null,
          recomputedPlanId: plan.planId,
          pr: existing,
          detail: "the existing PR body carries no release-craft identity claim to verify against",
        });
      }

      const recordedIdentity: ReleasePRIdentity = {
        component: claim.component,
        releaseLine: claim.releaseLine,
        targetBranch: claim.targetBranch,
      };
      const identityHolds =
        recordedIdentity.component === identity.component &&
        recordedIdentity.releaseLine === identity.releaseLine &&
        recordedIdentity.targetBranch === identity.targetBranch;
      if (!identityHolds) {
        return refuse(identity, plan, {
          kind: "identity-mismatch",
          existingIdentity: recordedIdentity,
          newIdentity: identity,
        });
      }

      const projection = rendered.projection;
      if (claim.planId !== plan.planId) {
        // A different plan fingerprint: legal only as the recorded
        // supersession relation (the plan's own `supersedes` edge —
        // invariant 5, never an edit).
        if (plan.supersedes !== claim.planId) {
          return refuse(identity, plan, {
            kind: "plan-conflict",
            recordedPlanId: claim.planId,
            recomputedPlanId: plan.planId,
            pr: existing,
            detail: `the recomputed plan ${plan.planId} does not supersede the recorded plan ${claim.planId}`,
          });
        }
        return performUpdate(identity, plan, projection, existing);
      }

      // Same plan fingerprint: the body IS the plan record — byte-identical
      // means intact, any drift is a human edit the gate refuses to
      // override silently. A stale title is repaired by a re-render (the
      // plan is unchanged); label drift is cosmetic — labels are not
      // identity and humans add them freely.
      if (existing.body === projection.body) {
        if (existing.title === projection.title) {
          const outcome: ReleasePROutcome = { kind: "current", pr: existing, projection };
          recordOutcome("update", identity, plan.planId, outcome);
          return outcome;
        }
        return performUpdate(identity, plan, projection, existing);
      }
      return refuse(identity, plan, {
        kind: "plan-conflict",
        recordedPlanId: claim.planId,
        recomputedPlanId: plan.planId,
        pr: existing,
        detail: "the existing PR body has drifted from the pure render of the plan it records",
      });
    },
  };
};
