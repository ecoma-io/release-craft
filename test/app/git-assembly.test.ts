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
import { COMMITTED_AT, liveWorld, matrixHooks, runInput } from "../vertical/matrix.js";
import { naming, openGitBinding, openGitState } from "../vertical/matrix-git.js";
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

  it(
    "an unchanged re-dispatch over the released head blocks at the planning boundary — the repository is untouched (#263)",
    { timeout: 60_000 },
    () => {
      withTempRepo("app-git-replay-263", (repo) => {
        const state = openGitState(repo);
        const engine = assembleGitBinding(state.binding, { maxRetries: 2 });
        const head = state.lineHeads.main;
        if (head === undefined) {
          throw new Error("fixture broken: no recorded head for main");
        }
        // The hosted close-world shape (#263): the world observes the
        // released tag under its full git refname at the unchanged head,
        // the recorded bootstrap that birthed the line rides the closed
        // input, and a release demand re-arrives. The planner admits the
        // refname-spelled tag (§2.13's normalization), the line's recorded
        // pointer IS the head, and §2.9 refuses the replay before any
        // attempt opens.
        const base = runInput(liveWorld(), "main", [{ kind: "release" }]);
        const input = {
          ...base,
          repository: {
            commits: base.repository.commits.map((candidate) =>
              candidate.sha === "m5" ? { ...candidate, sha: head } : candidate,
            ),
            refs: base.repository.refs.map((ref) => (ref.name === "main" ? { ...ref, head } : ref)),
          },
          history: { tags: [...base.history.tags, { name: "refs/tags/5.0.0", commit: head }] },
          bootstrap: { version: "5.0.0", who: "the operator", when: COMMITTED_AT },
        };
        const outcome = engine.run({
          ...runRequest(liveWorld(), "main", [{ kind: "release" }], fullDeclaration()),
          input,
          targets: { main: head },
        });
        expect(outcome.kind).toBe("blocked");
        if (outcome.kind !== "blocked") {
          throw new Error("expected a blocked outcome");
        }
        expect(outcome.cause).toContain("released-version-observed");
        expect(outcome.cause).toContain("refs/tags/5.0.0");
        expect(outcome.planId).not.toBeNull();
        expect(outcome.handle).toBeNull();
        expect(outcome.drives).toStrictEqual([]);
        // No second attempt, no mint: the repository carries no new tag,
        // and the planned tag never reached the binding's real door.
        expect(state.binding.refs.tags()).toStrictEqual([]);
      });
    },
  );
});

describe("the durable abandonment over the binding — restart visibility (ADR-0013 decision 4)", () => {
  it(
    "abort, then a fresh binding over the same repository: the fresh run refuses the recorded evidence",
    { timeout: 60_000 },
    () => {
      withTempRepo("app-git-abandonment-restart", (repo) => {
        const state = openGitState(repo);
        const engine = assembleGitBinding(state.binding, { maxRetries: 2 });
        const target = state.lineHeads.main;
        if (target === undefined) {
          throw new Error("fixture broken: no recorded head for main");
        }
        // The attest hook fails with no evidence: the walk blocks, and the
        // human aborts it — the abandonment record lands in the binding's
        // own ledger.
        const hooks = matrixHooks();
        const stopped = engine.run({
          ...runRequest(liveWorld(), "main", [beta], {
            hooks: [hooks.attest],
            hookEffects: new Map([
              [
                hooks.attest.id,
                (input) => ({ attribution: { attemptId: input.attemptId, actor: "automation" } }),
              ],
            ]),
          }),
          targets: { main: target },
        });
        expect(stopped.kind).toBe("blocked");
        if (stopped.kind !== "blocked" || stopped.handle === null) {
          throw new Error("expected a blocked outcome");
        }
        const abandoned = engine.abort(stopped.handle, "human:maintainer", ABORT_REASON);
        expect(abandoned.kind).toBe("abandoned");

        // The restart: a FRESH binding over the same repository — nothing
        // process-local survives, only the git refs carry the story. The
        // fresh run (target supplied, so the mint rule is satisfied) must
        // refuse quoting the recorded evidence before the walk.
        const restartedEngine = assembleGitBinding(openGitBinding({ repo, tagNaming: naming }), {
          maxRetries: 2,
        });
        const rerun = restartedEngine.run({
          ...runRequest(liveWorld(), "main", [beta]),
          targets: { main: target },
        });
        expect(rerun.kind).toBe("refused");
        if (rerun.kind !== "refused") {
          throw new Error(`expected a refused outcome, got ${rerun.kind}`);
        }
        expect(rerun.detail).toContain("human:maintainer");
        expect(rerun.detail).toContain(ABORT_REASON);
        expect(rerun.detail).toContain(stopped.handle.attemptId);
        expect(rerun.drives).toStrictEqual([]);
        // The refusal minted nothing: the walk never started.
        expect(state.binding.refs.tags()).toStrictEqual([]);
      });
    },
  );
});

const ABORT_REASON = "the release was withdrawn";
