/**
 * The Release PR lifecycle's vocabulary (issue #202): the identity
 * semantics, the remote PR port the lifecycle consumes, and the outcome
 * types returned by detect/create/update/refuse.
 *
 * Identity is component + release line + target branch — claim-based,
 * never a mutable label (the issue §11.5 refusal). A label-based
 * identity masquerading as state is a hard refusal: the lifecycle
 * never reads or writes labels as identity.
 *
 * The remote port is injected at the composition root, consistent with
 * the adapters' injection discipline (ADR-0010
 * decision 2 amendment in #65). The lifecycle imports nothing from the
 * adapter — the port is this module's own interface.
 */

import type { ReleasePlan } from "@ecoma-io/release-craft/planner";

// ---------------------------------------------------------------------------
// §2.1 — release PR identity (issue #202: component + line + target)
// ---------------------------------------------------------------------------

/** The deterministic identity of a Release PR: the component that owns
 * the release, the release line the plan targets, and the branch the PR
 * merges into. This triplet is stable — never a mutable label — and
 * determines which PR the lifecycle updates in place. */
export interface ReleasePRIdentity {
  /** The component (package) the release applies to. */
  readonly component: string;
  /** The release line id (stable, per ADR-0003 invariant 7). */
  readonly releaseLine: string;
  /** The branch the PR targets. */
  readonly targetBranch: string;
}

// ---------------------------------------------------------------------------
// §2.2 — the remote PR port (injected, never ambient)
// ---------------------------------------------------------------------------

/** A remote pull request the lifecycle discovered by identity search. */
export interface ExistingPR {
  /** The PR's number. */
  readonly number: number;
  /** The PR's current title. */
  readonly title: string;
  /** The PR's current body. */
  readonly body: string;
  /** The PR's head branch name. */
  readonly headRef: string;
  /** Whether the PR is a draft. */
  readonly draft: boolean;
  /** The PR's labels (for diagnostic output, never used as identity). */
  readonly labels: readonly string[];
}

/** The port the Release PR lifecycle consumes for remote PR operations.
 * Injected at composition — never ambient, never stored. Follows the
 * adapter's injection discipline (ADR-0010 decision 2). */
export interface ReleasePRPort {
  /** Discover an existing PR matching the given identity. Returns null
   * when no PR matches — the lifecycle creates one. */
  findPR(identity: ReleasePRIdentity): ExistingPR | null;

  /** Create a new PR with the given title, body, and labels. Draft
   * flag is respected. The head branch is derived from the identity
   * by the port. */
  createPR(params: {
    readonly identity: ReleasePRIdentity;
    readonly title: string;
    readonly body: string;
    readonly labels: readonly string[];
    readonly draft: boolean;
    readonly files: readonly ReleasePRFile[];
  }): ExistingPR;

  /** Update an existing PR's title, body, and labels in place. The PR
   * number identifies which PR to update. */
  updatePR(params: {
    readonly prNumber: number;
    readonly title: string;
    readonly body: string;
    readonly labels: readonly string[];
    readonly draft: boolean;
    readonly files: readonly ReleasePRFile[];
  }): ExistingPR;
}

// ---------------------------------------------------------------------------
// §2.3 — the projected PR content (pure render of the plan)
// ---------------------------------------------------------------------------

/** A file the Release PR proposes to add or modify. */
export interface ReleasePRFile {
  /** The file path relative to the repository root. */
  readonly path: string;
  /** The file's new content (the release manifest projection). */
  readonly content: string;
}

/** The deterministic projection of a ReleasePlan onto PR content:
 * title, body, labels, and file tree. The same render is used at
 * create and update so the body can never drift from the plan
 * (issue #202: "the body must be a pure render of the recorded plan,
 * never ambient state"). */
export interface ReleasePRProjection {
  /** The PR title — deterministic from the plan. */
  readonly title: string;
  /** The PR body — markdown render of the plan's lines and changes. */
  readonly body: string;
  /** Labels the PR carries. Identity labels are never mutable labels. */
  readonly labels: readonly string[];
  /** Files the PR proposes (manifest projections). */
  readonly files: readonly ReleasePRFile[];
}

// ---------------------------------------------------------------------------
// §2.4 — lifecycle outcomes (returned values, never exceptions)
// ---------------------------------------------------------------------------

/** The lifecycle detected a pending release but no existing PR.
 * The caller should invoke create. */
export interface ReleasePRDetected {
  readonly kind: "detected";
  /** The identity that was searched for. */
  readonly identity: ReleasePRIdentity;
  /** The plan to project. */
  readonly plan: ReleasePlan;
}

/** The lifecycle found an existing PR that matches the identity. */
export interface ReleasePRFound {
  readonly kind: "found";
  /** The existing PR. */
  readonly pr: ExistingPR;
  /** The plan to project. */
  readonly plan: ReleasePlan;
}

/** The lifecycle created a new PR. */
export interface ReleasePRCreated {
  readonly kind: "created";
  /** The newly created PR. */
  readonly pr: ExistingPR;
  /** The projection that was applied. */
  readonly projection: ReleasePRProjection;
}

/** The lifecycle updated an existing PR in place. */
export interface ReleasePRUpdated {
  readonly kind: "updated";
  /** The updated PR. */
  readonly pr: ExistingPR;
  /** The projection that was applied. */
  readonly projection: ReleasePRProjection;
}

/** The existing PR already carries this exact projection (plan id,
 * body, title, labels all byte-identical) — no write was needed. The
 * update path is idempotent: re-running the gate on an unchanged plan
 * is a no-op, not a rewrite. */
export interface ReleasePRCurrent {
  readonly kind: "current";
  /** The already-current PR. */
  readonly pr: ExistingPR;
  /** The projection the PR already carries. */
  readonly projection: ReleasePRProjection;
}

/** The lifecycle refused to update: the identity changed between the
 * recorded plan and the recomputed plan — a new PR is required, never
 * an in-place rewrite (issue #202: "a changed identity is a new PR,
 * never an in-place rewrite"). */
export interface ReleasePRIdentityMismatch {
  readonly kind: "identity-mismatch";
  /** The identity the existing PR was found under. */
  readonly existingIdentity: ReleasePRIdentity;
  /** The identity the new plan targets. */
  readonly newIdentity: ReleasePRIdentity;
}

/** The lifecycle refused to update: the recorded plan and the
 * recomputed plan disagree beyond the recorded supersession relation
 * (issue #202: "refuse the update when the recorded plan and the
 * recomputed plan disagree beyond the recorded supersession relation"). */
export interface ReleasePRPlanConflict {
  readonly kind: "plan-conflict";
  /** The recorded plan fingerprint on the existing PR, or `null` when
   * the body carries no verifiable release-craft identity claim at all
   * (a foreign PR or a body whose claim was removed). */
  readonly recordedPlanId: string | null;
  /** The human-readable refusal reason — the recorded conflict's own
   * statement of what disagreed. */
  readonly detail: string;
  /** The recomputed plan's fingerprint. */
  readonly recomputedPlanId: string;
  /** The existing PR. */
  readonly pr: ExistingPR;
}

/** No pending release was found — the planner produced a no-op or
 * refusal, not a plan. */
export interface ReleasePRNothingPending {
  readonly kind: "nothing-pending";
}

/** A transport error prevented the operation. */
export interface ReleasePRTransportFailure {
  readonly kind: "transport-failure";
  readonly detail: string;
}

/** The union of all lifecycle outcomes. */
export type ReleasePROutcome =
  | ReleasePRDetected
  | ReleasePRFound
  | ReleasePRCreated
  | ReleasePRUpdated
  | ReleasePRCurrent
  | ReleasePRIdentityMismatch
  | ReleasePRPlanConflict
  | ReleasePRNothingPending
  | ReleasePRTransportFailure;
