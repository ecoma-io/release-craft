/**
 * The git assembly — the second factory over an opened binding (the
 * application boundary contract §2.2), smoke-pinned end to end: the walk
 * runs over the binding's own durable stores, the completion mints the
 * §3.2 tag onto the request's supplied target through the binding's real
 * door, and the mint's target rule refuses before the walk when the caller
 * supplies none. Real-git subprocesses throughout, via the binding's own
 * test repository harness.
 */
import { describe, expect, it } from "vitest";

import { assembleGitBinding } from "../../src/index.js";
import { withTempRepo } from "../adapters/git/temp-repo.js";
import { liveWorld } from "../vertical/matrix.js";
import { openGitState } from "../vertical/matrix-git.js";
import { beta, fullDeclaration, runRequest } from "./harness.js";

describe("§2.2 — assembleGitBinding over an opened binding", () => {
  it(
    "a beta run publishes and mints the §3.2 tag onto the supplied target",
    { timeout: 60_000 },
    () => {
      withTempRepo("app-git-assembly", (repo) => {
        const state = openGitState(repo);
        const engine = assembleGitBinding(state.binding, { maxRetries: 2 });
        const target = state.lineHeads.main;
        if (target === undefined) {
          throw new Error("fixture broken: no recorded head for main");
        }
        const outcome = engine.run({
          ...runRequest(liveWorld(), "main", [beta], fullDeclaration()),
          targets: { main: target },
        });
        expect(outcome.kind).toBe("published");
        if (outcome.kind !== "published" || outcome.handle === null) {
          throw new Error("expected a published outcome");
        }
        expect(outcome.tag).toBe("5.0.0-beta.1");
        // The mint is real: the binding's own read door lists the ref, and
        // the engine's observation carries it as the attempt's tag.
        expect(state.binding.refs.tags().map((ref) => ref.ref)).toContain("refs/tags/5.0.0-beta.1");
        const observation = engine.observe({ kind: "attempt", handle: outcome.handle });
        if (observation.kind !== "attempt") {
          throw new Error(`expected an attempt observation, got ${observation.kind}`);
        }
        expect(observation.tags).toStrictEqual(["5.0.0-beta.1"]);
      });
    },
  );

  it(
    "a minting plan without a supplied target refuses before the walk, naming the rule",
    { timeout: 60_000 },
    () => {
      withTempRepo("app-git-no-target", (repo) => {
        const state = openGitState(repo);
        const engine = assembleGitBinding(state.binding, { maxRetries: 2 });
        const outcome = engine.run(runRequest(liveWorld(), "main", [beta], fullDeclaration()));
        expect(outcome.kind).toBe("refused");
        if (outcome.kind !== "refused") {
          throw new Error("expected a refused outcome");
        }
        expect(outcome.detail).toContain("mints");
        expect(outcome.detail).toContain("no recorded target");
        expect(outcome.detail).toContain("never ambient HEAD");
        expect(outcome.planId).not.toBeNull();
        expect(outcome.handle).toBeNull();
        expect(outcome.drives).toStrictEqual([]);
        // Nothing minted, nothing recorded: the refusal preceded the walk.
        expect(state.binding.refs.tags()).toStrictEqual([]);
      });
    },
  );
});
