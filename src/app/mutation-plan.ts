/**
 * The plan→mutation middle term (issue #289): the version the line's bump
 * writes is a plan-recorded value, and a mutation that claims the plan's
 * own version bump must produce exactly that value — checked against the
 * recorded plan, never accepted from the host as an independent authority
 * (PR #217's WHAT/HOW boundary; the audit's §6 D5 row names the gap this
 * closes). The check runs before the attempt opens, so a contradiction
 * never reaches any record: no start, no claim, no ledger row names a
 * mutation the plan did not sanction, and the half-mutated tree is never
 * committed beside it.
 *
 * The binding is by id, not by declaration shape: `version-bump` is the
 * reserved name of the plan's own version mutation, and any declaration
 * using the id answers to the plan — the driver's derived mutations are
 * the same names, so the driver's own corridor is bound by construction
 * while a foreign declaration contradicting the plan is refused. An
 * unbound id (a host's own mutation name) stays host-domain exactly as
 * the updater contract declares it. The check verifies, it never
 * invents: the produced bytes are compared to the plan's recorded value,
 * never to a value the engine derives at run time (ADR-0007 decision 2),
 * and the walk still re-derives and write-verifies the bytes at its own
 * seam — the binding refuses before any record, the updater's
 * verification remains the recorded proof.
 *
 * The changelog-render mutation is deliberately NOT bound here: the plan
 * record carries no renderer fields (subject/scope/breaking — the
 * `planLine.changes` projection drops them at assemble; issue #291's
 * change-shape binding is its own slice, audit §9), so no plan-recorded
 * value exists to check the rendered bytes against. The version is the
 * plan-recorded value this middle term binds today.
 */
import type { DeclaredMutation, MutationIntent } from "@ecoma-io/release-craft/execution";
import type { PlanLine } from "@ecoma-io/release-craft/planner";

/** The reserved, plan-bound mutation id — the plan's own version bump. A
 * declaration using the id binds to the recorded plan; any other id stays
 * host-domain. */
export const VERSION_BUMP_MUTATION_ID = "version-bump";

/** The plan's projection of its own version bump: the recorded value and
 * the release's own version bytes — the derived version, newline-
 * terminated, exactly the bytes the version-carrying driver's version
 * file carries. */
export interface PlannedVersionBump {
  readonly id: typeof VERSION_BUMP_MUTATION_ID;
  /** The plan-recorded version string — the line's stable version, else
   * its first stream's. */
  readonly version: string;
  /** The release's own version bytes: `${version}\n` — the bytes the
   * plan-bound mutation must produce. */
  readonly bytes: string;
}

/** The version the line's bump writes — the plan's recorded target: the
 * line's stable version, else its first stream's (the canonical derivation
 * the version-carrying driver renders). Null when the line plans no
 * version target: nothing to bump. */
export const plannedVersionBump = (line: PlanLine): PlannedVersionBump | null => {
  const version =
    line.stable?.version ??
    (line.streams[0] !== undefined ? line.streams[0].version.toString() : undefined);
  if (version === undefined) {
    return null;
  }
  return { id: VERSION_BUMP_MUTATION_ID, version, bytes: `${version}\n` };
};

/** The pre-walk binding (issue #289): a declared mutation that reserves
 * the plan-bound id must produce exactly the plan's recorded version
 * bytes, and the id over a line that plans no version has nothing to
 * bind. Returns the refusal detail naming the contradiction, or null
 * when every plan-bound declaration is faithful. Unbound ids are
 * untouched. The check runs each bound mutation's producer exactly once —
 * pure per the `MutationIntent` contract — and the walk still re-derives
 * the bytes at its own write-verify seam. */
export const bindMutationsToPlan = (
  line: PlanLine,
  mutations: readonly DeclaredMutation[] | undefined,
  intents: ReadonlyMap<string, MutationIntent> | undefined,
): string | null => {
  const bound = (mutations ?? []).filter((mutation) => mutation.id === VERSION_BUMP_MUTATION_ID);
  if (bound.length === 0) {
    return null;
  }
  const planned = plannedVersionBump(line);
  if (planned === null) {
    return (
      `line ${line.lineId}'s plan records no version target, but the run declares a ` +
      `${VERSION_BUMP_MUTATION_ID} mutation — the plan-bound id names the release's own ` +
      `version bump, so the run refuses before the walk starts (issue #289)`
    );
  }
  for (const mutation of bound) {
    const intent = intents?.get(mutation.id);
    if (intent === undefined) {
      return (
        `the ${VERSION_BUMP_MUTATION_ID} mutation declares no intent to check against ` +
        `line ${line.lineId}'s recorded version ${planned.version} — the run refuses ` +
        `before the walk starts (issue #289)`
      );
    }
    const produced = intent.produce();
    if (produced !== planned.bytes) {
      return (
        `the ${VERSION_BUMP_MUTATION_ID} mutation produces ` +
        `${JSON.stringify(produced)}, but line ${line.lineId}'s plan records ` +
        `${JSON.stringify(planned.bytes)} (version ${planned.version}) — the plan decides ` +
        `WHAT, so the run refuses before the walk starts (issue #289)`
      );
    }
  }
  return null;
};
