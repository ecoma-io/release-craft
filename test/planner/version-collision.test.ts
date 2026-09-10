/**
 * M-11 through the door — the plan-level tag collision gate
 * (src/planner/assemble.ts): two lines minting the same tag in one pass is
 * a self-conflicting plan — each line's tag-absent precondition would
 * falsify the other's — so the door refuses BEFORE assembly, naming the
 * colliding tag, both lines, and both decisions' head commits (M-11: "the
 * error names the colliding version, both commits, and both lines"; "no
 * release"). The tag namespace is global (invariant 6): the gate watches
 * stable tags and stream tags alike. Distinct per-package tag formats give
 * two components the same next version without collision — the operator's
 * named repair, pinned as the negative.
 */
import { describe, expect, it } from "vitest";

import { plan } from "@ecoma-io/release-craft/__internal__/planner/assemble.js";
import type {
  CommitObservation,
  ComponentMeta,
  LineConfig,
  PlanningOutcome,
  PolicyInput,
  RefObservation,
  TagObservation,
} from "@ecoma-io/release-craft/__internal__/planner/index.js";

const COMMITTED_AT = "2026-01-01T00:00:00Z";

function policy(digest: string, tagFormats: Readonly<Record<string, string>> = {}): PolicyInput {
  return {
    digest,
    bumpMappingId: "default",
    prereleaseLadder: ["rc"],
    prereleaseSeed: "0",
    pre10Dampening: true,
    selfReferenceNamespace: "Release-Craft:",
    tagFormats,
  };
}

function commit(
  sha: string,
  message: string,
  opts: {
    readonly parents?: readonly string[];
    readonly containingRefs?: readonly string[];
  } = {},
): CommitObservation {
  return {
    sha,
    parents: opts.parents ?? [],
    message,
    committedAt: COMMITTED_AT,
    containingRefs: opts.containingRefs ?? [],
  };
}

function ref(name: string, head: string): RefObservation {
  return { name, head };
}

function tag(name: string, sha: string): TagObservation {
  return { name, commit: sha };
}

function line(id: string, feedRef: string, publishes: string, tagFormat?: string): LineConfig {
  return {
    id,
    feedRef,
    lifecycle: "active",
    declared: true,
    publishes,
    ...(tagFormat === undefined ? {} : { tagFormat }),
  };
}

function component(name: string, manifestVersion: string): ComponentMeta {
  return { name, manifestVersion, paths: ["package.json"] };
}

/** The collision world: two lines over two components, both pending a fix
 * that maps to the same next version under the shared (default) tag
 * format. `tagFormats` varies the per-package tag shape per case. */
function collisionInput(
  digest: string,
  tagFormats: Readonly<Record<string, string>>,
): Parameters<typeof plan>[0] {
  return {
    policy: policy(digest, tagFormats),
    repository: {
      commits: [
        commit("c1", "feat: base", { containingRefs: ["feed/a", "feed/b"] }),
        commit("f1", "fix(app): fix on a", { parents: ["c1"], containingRefs: ["feed/a"] }),
        commit("f2", "fix(web): fix on b", { parents: ["c1"], containingRefs: ["feed/b"] }),
      ],
      refs: [ref("feed/a", "f1"), ref("feed/b", "f2")],
    },
    history: { tags: [tag("1.0.0", "c1")] },
    lines: [line("a", "feed/a", "app"), line("b", "feed/b", "web")],
    components: [component("app", "1.0.0"), component("web", "1.0.0")],
    intents: [{ kind: "release" }],
  };
}

describe("M-11 through the door — one tag in the global namespace cannot carry two bodies", () => {
  it("refuses the pass naming the colliding tag, both lines, and both head commits", () => {
    const outcome: PlanningOutcome = plan(collisionInput("sha256:" + "0".repeat(64), {}));

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") {
      throw new Error("expected the collision refusal outcome");
    }
    expect(outcome.refusal.cause).toBe("version-collision");
    expect(outcome.refusal.commits).toEqual(["f1", "f2"]);
    expect(outcome.refusal.detail).toContain('"1.0.1"');
    expect(outcome.refusal.detail).toContain('"a"');
    expect(outcome.refusal.detail).toContain('"b"');
    expect(outcome.refusal.detail).toContain("f1");
    expect(outcome.refusal.detail).toContain("f2");
  });
  it("keeps the same versions releasable once the tag formats split the namespace", () => {
    const outcome: PlanningOutcome = plan(
      collisionInput("sha256:" + "1".repeat(64), {
        a: "app@{major}.{minor}.{patch}{prerelease}",
        b: "web@{major}.{minor}.{patch}{prerelease}",
      }),
    );

    expect(outcome.kind).toBe("planned");
    if (outcome.kind !== "planned") {
      throw new Error("expected the split-namespace world to plan");
    }
    expect(outcome.plan.lines.map((line) => line.stable?.tag)).toEqual(["app@1.0.1", "web@1.0.1"]);
  });
});
