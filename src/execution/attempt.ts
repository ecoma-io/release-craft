/**
 * The attempt state machine (contract §2.2; ADR-0005 decision 3) and the
 * abort/supersede semantics (§2.8; decisions 10). The machine is a closed,
 * total edge table: `planned → executing` starts; `executing` completes as
 * `published | satisfied-externally | failed`, loses as `superseded |
 * abandoned`, and suspends as `blocked(cause)`; `blocked` resumes to
 * `executing` on a recorded resolution. Every non-terminal state yields to
 * `superseded` and `abandoned` — a superseding relation and a human abort
 * are authoritative from any non-terminal state (E-09: "the abort is
 * honored as authoritative"). Terminal is terminal: the table has no edge
 * out of `published | satisfied-externally | failed | superseded |
 * abandoned`, so a revival is unrepresentable, and the doors here throw the
 * dedicated error on impossible requests — an invalid transition is a
 * programming error, like the kernel's `InvalidVersionError` (§1's split;
 * the record-path counterpart lives in outcome.ts's seven outcomes).
 *
 * Pure values only: an attempt is frozen, transitions build successors, and
 * nothing here reads a clock, the environment, or a store (§2.10).
 */
import { attemptIdentity } from "./identity.js";
import {
  CANONICAL_STAGES,
  isTerminalAttempt,
  type ArtifactStep,
  type AttemptState,
  type Attribution,
  type DeclaredMutation,
  type HookAnchorPosition,
  type HookStep,
  type PostconditionKind,
  type ReleaseAttempt,
  type StepRecordsView,
} from "./types.js";

/** The thrown contract violation (§1, §2.2): an impossible state-machine
 * edge, a terminal attempt asked to move or resume, an out-of-sequence
 * stage, a blank attribution or resolution. The message names the violated
 * clause — the dedicated error the invalid-transition fixture asserts. */
export class InvalidExecutionTransitionError extends Error {
  constructor(detail: string) {
    super(`invalid execution transition: ${detail} (contract §2.2/§2.5/§2.8, ADR-0005 decision 3)`);
    this.name = "InvalidExecutionTransitionError";
  }
}

/** The edge table — exactly the transitions §2.2 draws plus the two
 * authoritative moves (`superseded`, `abandoned`) that §2.8 extends to
 * every non-terminal state. Terminal rows are empty: no revival exists. */
const EDGES: Readonly<Record<AttemptState, readonly AttemptState[]>> = {
  planned: ["executing", "superseded", "abandoned"],
  executing: ["published", "satisfied-externally", "failed", "superseded", "abandoned", "blocked"],
  blocked: ["executing", "superseded", "abandoned"],
  published: [],
  "satisfied-externally": [],
  failed: [],
  superseded: [],
  abandoned: [],
};

const ANCHOR_POSITIONS: readonly HookAnchorPosition[] = ["before", "after"];
const POSTCONDITION_KINDS: readonly PostconditionKind[] = [
  "content-fingerprint-present",
  "evidence-present",
];

const nonEmpty = (value: string, what: string): string => {
  if (value.length === 0) {
    throw new InvalidExecutionTransitionError(`${what} must be a non-empty recorded value`);
  }
  return value;
};

/** Builds the successor attempt: `blockedCause` recorded only on `blocked`,
 * `terminalReason` only on terminal states — the optional fields are
 * omitted, never `undefined`-filled. */
const successor = (
  attempt: ReleaseAttempt,
  state: AttemptState,
  detail: { readonly blockedCause?: string; readonly terminalReason?: string },
): ReleaseAttempt => {
  // The declared hooks ride every edge; the conditional fields do not
  // survive past the state that carries them — destructured out first
  // (a spread cannot un-copy a field), re-added only for their state,
  // omitted never `undefined`-filled.
  const { blockedCause, terminalReason, ...carried } = attempt;
  const base: ReleaseAttempt = {
    ...carried,
    state,
    ...(state === "blocked" && (detail.blockedCause ?? blockedCause) !== undefined
      ? { blockedCause: detail.blockedCause ?? blockedCause }
      : {}),
    ...(isTerminalAttempt(state) && (detail.terminalReason ?? terminalReason) !== undefined
      ? { terminalReason: detail.terminalReason ?? terminalReason }
      : {}),
  };
  return base;
};

/** The throwing door (§2.2): moves the attempt along an edge of the table,
 * throwing on every impossible request. `blocked` demands its recorded
 * cause; `failed` demands its cause (E-01's `failed(unknown)` is the crash
 * classifier's, below). */
export const transition = (
  attempt: ReleaseAttempt,
  to: AttemptState,
  detail: { readonly blockedCause?: string; readonly terminalReason?: string } = {},
): ReleaseAttempt => {
  const allowed = EDGES[attempt.state];
  if (!allowed.includes(to)) {
    throw new InvalidExecutionTransitionError(
      `no edge ${attempt.state} → ${to}; terminal is terminal and the table is closed`,
    );
  }
  if (to === "blocked") {
    return successor(attempt, to, {
      blockedCause: nonEmpty(detail.blockedCause ?? "", "blockedCause"),
    });
  }
  if (to === "failed") {
    return successor(attempt, to, {
      terminalReason: nonEmpty(detail.terminalReason ?? "", "failed cause"),
    });
  }
  return successor(attempt, to, detail);
};

/** Starts the attempt: `planned → executing`. */
export const start = (attempt: ReleaseAttempt): ReleaseAttempt => transition(attempt, "executing");

/** Suspends the attempt (§2.2): `executing → blocked(cause)` — the cause is
 * recorded, nothing is consumed (E-04's `precondition-delta`, E-06's
 * `unattributed-state`, PR-03's `validation` arrive verbatim). */
export const block = (attempt: ReleaseAttempt, cause: string): ReleaseAttempt =>
  transition(attempt, "blocked", { blockedCause: cause });

/** Resumes a suspended attempt (§2.2): `blocked → executing`, only on a
 * recorded resolution — a closed gap (E-04, PR-03) or a human attribution
 * (E-06). The resolution is consumed as a value here; producing the durable
 * resolution record is the ledger's and hooks' (Phases 5–6). Throwing on a
 * non-blocked attempt is the no-silent-revival rule. */
export const resume = (attempt: ReleaseAttempt, resolution: string): ReleaseAttempt => {
  nonEmpty(resolution, "resolution");
  if (attempt.state !== "blocked") {
    throw new InvalidExecutionTransitionError(
      `resume demands a blocked attempt, got ${attempt.state}`,
    );
  }
  return transition(attempt, "executing");
};

/** The unclassified crash (E-01, §2.2): an attempt that dies mid-execution
 * without a recorded classification is `failed(unknown)` — the state exists
 * as data; classification into recovery paths is the ledger's (Phase 5). */
export const crashClassify = (attempt: ReleaseAttempt): ReleaseAttempt =>
  transition(attempt, "failed", { terminalReason: "unknown" });

/** The race loser's abandonment (E-07, §2.2): recorded as
 * `abandoned` with reason `follower-of:<winnerAttemptId>` — attributed,
 * never silent. */
export const abandonAsFollower = (
  attempt: ReleaseAttempt,
  winnerAttemptId: string,
): ReleaseAttempt =>
  transition(attempt, "abandoned", {
    terminalReason: `follower-of:${nonEmpty(winnerAttemptId, "winnerAttemptId")}`,
  });

/** The abort outcome (§2.8): the new attempt plus the attribution to
 * record — the attempt shape carries no actor, so the caller persists both
 * together (the durable record is Phase 5's; Phase 4 fixes the shape). */
export interface AbortOutcome {
  readonly attempt: ReleaseAttempt;
  readonly attribution: Attribution;
}

/** Aborts (§2.8, E-09): a human actor's word is authoritative — the
 * non-terminal attempt moves to `abandoned` with the actor recorded, and no
 * later transition, retry, or resume can complete it, because the table has
 * no edge out. */
export const abort = (attempt: ReleaseAttempt, actor: string, reason: string): AbortOutcome => {
  if (isTerminalAttempt(attempt.state)) {
    throw new InvalidExecutionTransitionError(`abort demands a non-terminal attempt`);
  }
  nonEmpty(actor, "actor");
  return {
    attempt: transition(attempt, "abandoned", {
      terminalReason: nonEmpty(reason, "abort reason"),
    }),
    attribution: { attemptId: attempt.attemptId, actor },
  };
};

/** The supersede outcome (§2.8): the old plan's non-terminal attempts
 * divide by the `tag` boundary — the voided move to `superseded` now, the
 * past-tag ones stand and only record the relation (the externally visible
 * step already happened; reconciliation is a Phase 5 human/policy decision,
 * never an automatic undo). Terminal attempts are untouched. Nothing is
 * deleted, rewritten, or re-tagged. */
export interface SupersedeOutcome {
  /** Non-terminal attempts before `tag`, moved to `superseded`. */
  readonly superseded: readonly ReleaseAttempt[];
  /** Non-terminal attempts past `tag` — unvoidable; the relation is
   * recorded for them, and they continue to a terminal state. */
  readonly pastTag: readonly ReleaseAttempt[];
}

/** Supersedes a plan (§2.8, invariant 5's execution half): the execution
 * side of the single recorded relation. `steps` is the step record view the
 * caller already holds — past-tag is read from completed `tag` records,
 * never recomputed or inferred from timestamps (§2.10). */
export const supersedePlan = (input: {
  readonly oldPlanId: string;
  readonly newPlanId: string;
  readonly attempts: readonly ReleaseAttempt[];
  readonly steps: Pick<StepRecordsView, "completed">;
}): SupersedeOutcome => {
  const superseded: ReleaseAttempt[] = [];
  const pastTag: ReleaseAttempt[] = [];
  for (const attempt of input.attempts) {
    if (attempt.planId !== input.oldPlanId || isTerminalAttempt(attempt.state)) {
      continue;
    }
    if (input.steps.completed(attempt.attemptId, "tag") !== null) {
      pastTag.push(attempt);
      continue;
    }
    superseded.push(
      transition(attempt, "superseded", {
        terminalReason: `superseded-by:${input.newPlanId}`,
      }),
    );
  }
  return { superseded, pastTag };
};

/** The declared hooks' protocol validation (phase 6 contract §2.1): ids
 * non-empty and unique (the ledger key is `hook:<id>`), anchors on the
 * canonical stages, postcondition kinds from the closed pair, guard names
 * non-empty. Returns the list frozen to the attempt's depth — the attempt
 * value never mutates, so neither may its declarations. */
const validateHooks = (hooks: readonly HookStep[]): readonly HookStep[] => {
  const seen = new Set<string>();
  for (const hook of hooks) {
    if (hook.id.length === 0) {
      throw new InvalidExecutionTransitionError(
        "a hook id must be a non-empty recorded value — the ledger key is hook:<id>",
      );
    }
    if (seen.has(hook.id)) {
      throw new InvalidExecutionTransitionError(
        `duplicate hook id "${hook.id}" — hook ledger keys are unique per attempt (contract §2.1)`,
      );
    }
    seen.add(hook.id);
    if (!CANONICAL_STAGES.includes(hook.anchor.stage)) {
      throw new InvalidExecutionTransitionError(
        `hook "${hook.id}" anchors at "${hook.anchor.stage}", which is not one of the canonical stages (contract §2.1)`,
      );
    }
    if (!ANCHOR_POSITIONS.includes(hook.anchor.position)) {
      throw new InvalidExecutionTransitionError(
        `hook "${hook.id}" anchors "${hook.anchor.position}"; the positions are before and after (contract §2.1)`,
      );
    }
    if (hook.guard.length === 0) {
      throw new InvalidExecutionTransitionError(
        `hook "${hook.id}" declares a blank guard name (contract §2.2)`,
      );
    }
    for (const postcondition of hook.postconditions) {
      if (!POSTCONDITION_KINDS.includes(postcondition)) {
        throw new InvalidExecutionTransitionError(
          `hook "${hook.id}" declares the unknown postcondition "${postcondition}" (contract §2.4)`,
        );
      }
    }
  }
  return Object.freeze(
    hooks.map((hook) =>
      Object.freeze({
        ...hook,
        anchor: Object.freeze({ ...hook.anchor }),
        postconditions: Object.freeze([...hook.postconditions]),
      }),
    ),
  );
};

/** The declared artifacts' protocol validation (phase 7 contract §2.1):
 * the hook rules plus the artifact door's own — ids non-empty and unique
 * (the ledger key is `artifact:<id>`), anchors on the canonical stages,
 * postcondition kinds from the closed pair, guard names non-empty,
 * `kind` and `coordinates` opaque non-empty unpadded (the domain artifact
 * door's rule, quoted not imported), and the declared `dependsOn` a
 * well-formed DAG: sibling ids only, no duplicates, acyclic — checked in
 * declaration order's depth-first walk. Returns the list frozen to the
 * attempt's depth. */
const validateArtifacts = (artifacts: readonly ArtifactStep[]): readonly ArtifactStep[] => {
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.id.length === 0) {
      throw new InvalidExecutionTransitionError(
        "an artifact id must be a non-empty recorded value — the ledger key is artifact:<id>",
      );
    }
    if (seen.has(artifact.id)) {
      throw new InvalidExecutionTransitionError(
        `duplicate artifact id "${artifact.id}" — artifact ledger keys are unique per attempt (contract §2.1)`,
      );
    }
    seen.add(artifact.id);
    for (const [label, value] of [
      ["kind", artifact.kind],
      ["coordinates", artifact.coordinates],
    ] as const) {
      if (value.length === 0 || value !== value.trim()) {
        throw new InvalidExecutionTransitionError(
          `artifact "${artifact.id}" declares a ${label} that is empty or padded — the domain artifact door's rule: opaque, non-empty, unpadded, validated never normalized (ADR-0008 decision 4)`,
        );
      }
    }
    if (!CANONICAL_STAGES.includes(artifact.anchor.stage)) {
      throw new InvalidExecutionTransitionError(
        `artifact "${artifact.id}" anchors at "${artifact.anchor.stage}", which is not one of the canonical stages (contract §2.1)`,
      );
    }
    if (!ANCHOR_POSITIONS.includes(artifact.anchor.position)) {
      throw new InvalidExecutionTransitionError(
        `artifact "${artifact.id}" anchors "${artifact.anchor.position}"; the positions are before and after (contract §2.1)`,
      );
    }
    if (artifact.guard.length === 0) {
      throw new InvalidExecutionTransitionError(
        `artifact "${artifact.id}" declares a blank guard name (contract §2.2)`,
      );
    }
    for (const postcondition of artifact.postconditions) {
      if (!POSTCONDITION_KINDS.includes(postcondition)) {
        throw new InvalidExecutionTransitionError(
          `artifact "${artifact.id}" declares the unknown postcondition "${postcondition}" (contract §2.4)`,
        );
      }
    }
  }
  // The DAG (§2.1): closed input, validated, never inferred. Edges name
  // declared sibling ids only, no duplicates, and the declaration-order
  // depth-first walk reports a cycle instead of scheduling one.
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: readonly string[]): void => {
    const mark = state.get(id);
    if (mark === "visiting") {
      throw new InvalidExecutionTransitionError(
        `artifact dependency cycle: ${[...path, id].join(" → ")} (contract §2.1)`,
      );
    }
    if (mark === "done") {
      return;
    }
    const declared = byId.get(id);
    if (declared === undefined) {
      throw new InvalidExecutionTransitionError(
        `artifact "${path[path.length - 1] ?? id}" depends on "${id}", which is not a declared sibling (contract §2.1)`,
      );
    }
    state.set(id, "visiting");
    for (const dependency of declared.dependsOn) {
      visit(dependency, [...path, id]);
    }
    state.set(id, "done");
  };
  for (const artifact of artifacts) {
    for (const dependency of artifact.dependsOn) {
      if (!byId.has(dependency)) {
        throw new InvalidExecutionTransitionError(
          `artifact "${artifact.id}" depends on "${dependency}", which is not a declared sibling (contract §2.1)`,
        );
      }
    }
  }
  for (const artifact of artifacts) {
    visit(artifact.id, []);
  }
  const duplicated = artifacts.find(
    (artifact) => new Set(artifact.dependsOn).size !== artifact.dependsOn.length,
  );
  if (duplicated !== undefined) {
    throw new InvalidExecutionTransitionError(
      `artifact "${duplicated.id}" declares a duplicated dependsOn edge (contract §2.1)`,
    );
  }
  return Object.freeze(
    artifacts.map((artifact) =>
      Object.freeze({
        ...artifact,
        anchor: Object.freeze({ ...artifact.anchor }),
        dependsOn: Object.freeze([...artifact.dependsOn]),
        postconditions: Object.freeze([...artifact.postconditions]),
      }),
    ),
  );
};

/** The declared updater mutations' protocol validation (issue #203):
 * ids non-empty and unique (the ledger key is `updater:<id>`), anchors
 * on the canonical stages, positions before/after, guard names
 * non-empty, postcondition kinds from the closed pair. Returns the list
 * frozen to the attempt's depth — the attempt value never mutates, so
 * neither may its declarations. */
const validateMutations = (mutations: readonly DeclaredMutation[]): readonly DeclaredMutation[] => {
  const seen = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.id.length === 0) {
      throw new InvalidExecutionTransitionError(
        "a mutation id must be a non-empty recorded value — the ledger key is updater:<id>",
      );
    }
    if (seen.has(mutation.id)) {
      throw new InvalidExecutionTransitionError(
        `duplicate mutation id "${mutation.id}" — updater ledger keys are unique per attempt (issue #203)`,
      );
    }
    seen.add(mutation.id);
    if (!CANONICAL_STAGES.includes(mutation.anchor.stage)) {
      throw new InvalidExecutionTransitionError(
        `mutation "${mutation.id}" anchors at "${mutation.anchor.stage}", which is not one of the canonical stages (issue #203)`,
      );
    }
    if (!ANCHOR_POSITIONS.includes(mutation.anchor.position)) {
      throw new InvalidExecutionTransitionError(
        `mutation "${mutation.id}" anchors "${mutation.anchor.position}"; the positions are before and after (issue #203)`,
      );
    }
    if (mutation.guard.length === 0) {
      throw new InvalidExecutionTransitionError(
        `mutation "${mutation.id}" declares a blank guard name (issue #203)`,
      );
    }
    for (const postcondition of mutation.postconditions) {
      if (!POSTCONDITION_KINDS.includes(postcondition)) {
        throw new InvalidExecutionTransitionError(
          `mutation "${mutation.id}" declares the unknown postcondition "${postcondition}" (issue #203)`,
        );
      }
    }
  }
  return Object.freeze(
    mutations.map((mutation) =>
      Object.freeze({
        ...mutation,
        anchor: Object.freeze({ ...mutation.anchor }),
        postconditions: Object.freeze([...mutation.postconditions]),
      }),
    ),
  );
};

/** Opens an attempt (§2.1): allocates the ordinal from the register,
 * derives the content-anchored id, and returns the frozen `planned` value.
 * The plan's fingerprint is carried, never recomputed (invariant 3's
 * execution mirror). The declared hooks, artifact steps, and updater
 * mutation steps ride the attempt as execution-side data — excluded from
 * `attemptIdentity` and the plan fingerprint (phase 6, phase 7, and the
 * updater layer's contracts §2.1; ADR-0007, ADR-0008 decision 3, and
 * issue #203's key space). */
export const openAttempt = (
  register: { nextOrdinal(planId: string): number },
  plan: { readonly planId: string; readonly planFingerprint: string },
  hooks?: readonly HookStep[],
  artifacts?: readonly ArtifactStep[],
  mutations?: readonly DeclaredMutation[],
): ReleaseAttempt => {
  const ordinal = register.nextOrdinal(plan.planId);
  return Object.freeze({
    attemptId: attemptIdentity(plan.planId, ordinal),
    planId: plan.planId,
    planFingerprint: plan.planFingerprint,
    state: "planned",
    ...(hooks === undefined ? {} : { hooks: validateHooks(hooks) }),
    ...(artifacts === undefined ? {} : { artifacts: validateArtifacts(artifacts) }),
    ...(mutations === undefined ? {} : { mutations: validateMutations(mutations) }),
  } satisfies ReleaseAttempt);
};
