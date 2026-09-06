/**
 * §2.7 + §2.9 — bump resolution and per-line decision records.
 *
 * The commit-type → `Bump` mapping is policy data, never kernel state (§2.7,
 * ADR-0003 decision 6): `resolveBump` looks the declared mapping up by
 * `policy.bumpMappingId` — only `"default"` exists in Phase 2, and an
 * unknown id is a caller contract violation that throws, the same posture as
 * `input.ts` and `attribute.ts` — then folds `Bump.max` over the pending
 * commits in input order. A breaking marker dominates any type, even one
 * absent from the mapping (PL-05), so a breaking chore is release-triggering
 * and major. An empty release-worthy set resolves to `undefined`, the no-op
 * cause (§2.9); the empty group mints nothing and `ChangeSet.empty`'s
 * neutral `"patch"` level is never read as a decision (PL-06, S-01).
 *
 * `decideLine` turns one line's attribution into exactly one record, in
 * contract precedence: `blocked` on a missing bootstrap decision (S-02,
 * ADR-0003 decision 13 — the first version is the operator's call, never
 * invented), `refused` on an operator contradiction (§2.9, S-01: an explicit
 * `release-as` demand against a runway with nothing release-worthy), the
 * recorded no-op with the ignored commits enumerated in input order (§2.9,
 * PL-06), or the `release` record whose kernel change set is constructed
 * through `ChangeSet.of` — a kernel construction rejection surfaces as a
 * `refused` record and is never re-thrown (§2.9, ADR-0003 decision 1).
 *
 * Two negative records have no Phase 2 producer and are deliberately never
 * emitted here: `withheld`/`policy-filter` (PL-07's change filter is a
 * Phase 3 line-policy input; D14) and `blocked`/`stale-plan` (staleness is
 * recognized against a stored plan, §2.10). The remaining `refused` causes
 * are produced upstream by `attribute.ts`.
 *
 * Pure and deterministic (invariant 2): no clock, environment, randomness,
 * filesystem, or network; every enumeration stays in input order (E-10).
 */

import {
  Bump,
  ChangeSet,
  InvalidChangeSetError,
  type Change,
} from "@ecoma-io/release-craft/domain";

import { InvalidPlanningInputError } from "./input.js";
import type {
  BumpMapping,
  DecideLine,
  OperatorIntent,
  ParsedCommit,
  PolicyInput,
  ResolveBump,
} from "./types.js";

/**
 * The `default` commit-type → `Bump` mapping (§2.7, ADR-0003 decision 6):
 * `feat` → minor, `fix`/`perf`/`refactor` → patch. `chore`, `docs`, `ci` and
 * `test` are deliberately absent — a non-breaking commit of those types is
 * not release-triggering (S-01, PL-06) and surfaces in the no-op record's
 * `ignored` enumeration. Absence never hides a breaking change: the marker
 * dominates filtering, so a breaking commit of an unlisted type is still
 * release-triggering (PL-05).
 */
const DEFAULT_BUMP_MAPPING: BumpMapping = Object.freeze({
  feat: "minor",
  fix: "patch",
  perf: "patch",
  refactor: "patch",
});

/**
 * The declared mapping for one policy (§2.7). Only the `default` mapping is
 * declared in Phase 2; anything else never entered the policy vocabulary, so
 * it is a caller contract violation — thrown with the input field path, as
 * `input.ts` records violations — not a planning outcome.
 */
function mappingFor(policy: PolicyInput): BumpMapping {
  if (policy.bumpMappingId !== "default") {
    throw new InvalidPlanningInputError([
      {
        field: "policy.bumpMappingId",
        problem: `unknown bump mapping id "${policy.bumpMappingId}" — only "default" is declared in Phase 2`,
      },
    ]);
  }
  return DEFAULT_BUMP_MAPPING;
}

/**
 * One commit's bump contribution (§2.7): a breaking marker dominates any
 * type — including a type absent from the mapping (PL-05) — then the
 * declared mapping decides; `undefined` when the commit is not
 * release-triggering (S-01, PL-06). Absence is data here, never a default.
 * With `noUncheckedIndexedAccess`, an unlisted type reads `undefined`
 * directly — exactly the not-release-triggering answer.
 */
function commitBump(mapping: BumpMapping, parsed: ParsedCommit): Bump | undefined {
  if (parsed.breaking) return "major";
  if (parsed.type === undefined) return undefined;
  return mapping[parsed.type];
}

export const resolveBump: ResolveBump = (pending, policy) => {
  const mapping = mappingFor(policy);
  // §2.7: `Bump.max` over the release-triggering commits. The fold order is
  // input order (deterministic, invariant 2), and `Bump.max` is total, so
  // the result is order-independent anyway; `undefined` only when no commit
  // qualifies — the no-op cause (§2.9).
  let resolved: Bump | undefined;
  for (const parsed of pending) {
    const perCommit = commitBump(mapping, parsed);
    if (perCommit === undefined) continue;
    resolved = resolved === undefined ? perCommit : Bump.max(resolved, perCommit);
  }
  return resolved;
};

export const decideLine: DecideLine = (line, input, range) => {
  // Caller-contract posture first (mirrors attribute.ts validating its
  // ranges at entry): the declared mapping is resolved before any record is
  // produced (§2.7).
  const mapping = mappingFor(input.policy);

  // Precedence 1 — unmet precondition (§2.9, S-02, ADR-0003 decision 13): a
  // line with no released history and pending work demands the recorded
  // bootstrap decision; the planner never invents the first version. An
  // empty pending set needs no bootstrap and falls through to the no-op.
  if (line.released.length === 0 && line.pending.length > 0 && input.bootstrap === undefined) {
    return {
      kind: "blocked",
      cause: "bootstrap-required",
      lineId: line.lineId,
      range,
      policyDigest: input.policy.digest,
      detail:
        "no released history on this line, pending changes present, and no recorded bootstrap decision — the first version is the operator's call (S-02)",
    };
  }

  const bump = resolveBump(line.pending, input.policy);

  // Precedence 2 — operator contradiction (§2.9, S-01): an explicit
  // `release-as` demand against a runway with nothing release-worthy. The
  // intent is recorded in the detail and the line refuses — the conflict is
  // surfaced, never resolved by silently releasing. This is the only
  // contradiction rule in Phase 2; `release-as` carries no lineId (§2.1), so
  // the demand is evaluated against every line decided here. A release-as
  // on a release-worthy runway is honored by the ordinary release below.
  const releaseAs = input.intents?.find(
    (intent): intent is Extract<OperatorIntent, { kind: "release-as" }> =>
      intent.kind === "release-as",
  );
  if (bump === undefined && releaseAs !== undefined) {
    return {
      kind: "refused",
      cause: "operator-contradiction",
      lineId: line.lineId,
      range,
      policyDigest: input.policy.digest,
      detail: `operator demanded release-as ${releaseAs.version}, but this line has no release-worthy changes — the demand cannot be honored (S-01)`,
    };
  }

  // Precedence 3 — the recorded no-op (§2.9, PL-06, S-01): with no
  // release-worthy commit, every pending entry was excluded by policy, so
  // the `ignored` enumeration is the whole pending set, in input order —
  // recorded, never silently dropped. The empty group mints nothing.
  if (bump === undefined) {
    return {
      kind: "no-op",
      cause: "no-release-worthy-changes",
      ignored: line.pending,
      lineId: line.lineId,
      range,
      policyDigest: input.policy.digest,
      detail:
        line.pending.length === 0
          ? "no pending changes on the evaluated range"
          : `no release-worthy changes; ignored as not release-triggering, in input order: ${line.pending
              .map((parsed) => `${parsed.sha} (${parsed.type ?? "untyped"})`)
              .join(", ")}`,
    };
  }

  // Precedence 4 — the release (§2.7, §2.9): the contributing commits are
  // the release-triggering ones, and the kernel change set is constructed
  // through `ChangeSet.of`. Pending entries are change-classified by
  // attribution (§2.4), so the `change` narrowing below is defensive only,
  // mirroring attribute.ts's released-id fallback.
  const contributing: ParsedCommit[] = [];
  const members: Change[] = [];
  for (const parsed of line.pending) {
    if (commitBump(mapping, parsed) === undefined) continue;
    if (parsed.change === undefined) continue;
    contributing.push(parsed);
    members.push(parsed.change);
  }
  // A kernel construction rejection surfaces as a record and is never
  // re-thrown (§2.9, ADR-0003 decision 1). The door validates the group —
  // every member a `Change`, identities unique, the bump a level — and plan
  // assembly takes its value; the record surface carries the decided
  // inputs. Any other error is not a kernel construction rejection and
  // propagates: swallowing defects would fake determinism.
  try {
    ChangeSet.of(members, bump);
  } catch (error: unknown) {
    if (error instanceof InvalidChangeSetError) {
      return {
        kind: "refused",
        cause: "kernel-rejection",
        lineId: line.lineId,
        range,
        policyDigest: input.policy.digest,
        detail: `the kernel rejected this line's change set: ${error.reason}`,
      };
    }
    throw error;
  }

  return {
    kind: "release",
    bump,
    changes: contributing,
    lineId: line.lineId,
    range,
    policyDigest: input.policy.digest,
    detail: `${String(contributing.length)} release-worthy change(s) imply a ${bump} bump`,
  };
};
