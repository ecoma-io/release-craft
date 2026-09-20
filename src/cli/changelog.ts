/**
 * The changelog declaration behind `--changelog` (issue #381): the one
 * `artifact:changelog` step of the v1 posture (#327) plus the producer
 * that answers it — composed between the plan the run will walk and the
 * artifact scheduler.
 *
 * The producer's bytes are the run's own plan's changelog, rendered
 * deterministically: the engine plans the same closed input and intents
 * the run door is about to execute (exactly the driver's pre-walk mirror,
 * version-mutation-driver.ts — the plan is looked at, never stored, and
 * an input that would plan differently at the run refuses there, never
 * here), the change set renders through the planner's own projection
 * (issue #291: `changelogOf` over the plan line's recorded content, never
 * re-extracted), and the render carries no date, no repository links, and
 * no existing file — a no-clock, no-ambient-value document, byte-stable
 * across runs and machines (§4's law: no clock, no environment — the
 * release body must be computable before publication, whose URL and date
 * do not exist yet).
 *
 * The producer's digest is the tree holding exactly those bytes at the
 * changelog path and the content seal (issue #294) rides the observation
 * — the release body's read resolves the rendered changelog, and the
 * published body can be compared byte-for-byte against the seal. When the
 * pre-plan plans no release over the line (or plans none at all), the
 * declaration stands with the binding's identity fallback — the run
 * refuses the same way, and nothing walks, exactly the pre-fix posture.
 */

import { GitChangelogProducer } from "@ecoma-io/release-craft/adapters/git";
import type { Engine, RunDeclarations } from "@ecoma-io/release-craft/app";
import type { ArtifactStep } from "@ecoma-io/release-craft/execution";
import {
  changelogOf,
  renderChangelog,
  type OperatorIntent,
  type PlanningInput,
} from "@ecoma-io/release-craft/planner";

import type { AssemblySelection } from "./parse.js";

/** The single changelog declaration behind `--changelog` (#327): exactly
 * one `artifact:changelog` step, anchored after the claim is held and
 * before the mint, answered by the producer `changelogRunDeclarations`
 * wires when the plan carries the line (issue #381) — and by the binding's
 * fallback `GitArtifactProducer` alone (the engine wires
 * `declared?.get(step.id) ?? wired`) when it plans no release, which the
 * run refuses the same way. The `id` is the one field `GitReleasePublication`
 * matches (`publication.ts:65`), so it must stay `changelog`. `dependsOn`
 * is empty — the self-release runs the empty declaration; the matrix's
 * `package`/`binary` siblings do not exist here. `content-fingerprint-present`
 * only, never `evidence-present`: the producers return no `evidence`, so
 * `evidence-present` would fail-closed block every leg. */
export const CHANGELOG_DECLARATION: ArtifactStep = {
  id: "changelog",
  anchor: { stage: "tag", position: "after" },
  guard: "release-line",
  kind: "changelog",
  coordinates: "CHANGELOG.md",
  dependsOn: [],
  postconditions: ["content-fingerprint-present"],
};

/** The run door's changelog declarations: the declaration plus the
 * producers map that answers it when the run's plan carries the line.
 * `selection` is the invocation's own — the parser refuses `--changelog`
 * on the memory assembly before any door runs; the assembly check below
 * is the type-carried twin (the same row `publishRun` carries). */
export const changelogRunDeclarations = (
  engine: Engine,
  document: PlanningInput,
  intents: readonly OperatorIntent[],
  lineId: string,
  selection: AssemblySelection,
): RunDeclarations => {
  if (selection.assembly !== "git") {
    throw new Error("the changelog declaration feeds the git assembly only");
  }
  // The pre-plan mirror: the identical closed input and intents the run
  // door is about to execute (`run` plans over `{ ...input, intents }`),
  // so a release the pre-plan finds is the release the run walks, and a
  // refusal here is the run's own refusal.
  const planning = engine.plan({ ...document, intents });
  if (planning.kind !== "planned") {
    return { artifacts: [CHANGELOG_DECLARATION] };
  }
  const planLine = planning.plan.lines.find((candidate) => candidate.lineId === lineId);
  if (planLine === undefined) {
    return { artifacts: [CHANGELOG_DECLARATION] };
  }
  // The changelog's exact rendered bytes, derived once: the producer's
  // digest seals them through a tree, and the content seal (issue #294)
  // lets publication compare published content byte-for-byte without
  // dereferencing the tree.
  const bytes = renderChangelog(changelogOf([planLine]));
  const producers = new Map([["changelog", GitChangelogProducer(selection.repo, bytes)]]);
  return { artifacts: [CHANGELOG_DECLARATION], producers };
};
