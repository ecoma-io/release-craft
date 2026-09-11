/**
 * The engine's updater boundary (issue #203; adversarial review
 * 2026-09-11): a refused mutation is a §2.5 escalation — the attempt
 * blocks and the walk stops, so a half-mutated tree is never published —
 * and the shared artifact/mutation boundary is guarded by the attempt's
 * executing state, the same way the hooks→artifacts boundary is.
 */
import { describe, expect, it } from "vitest";

import type { RunDeclarations, UpdaterFs } from "../../src/index.js";
import { liveWorld } from "../vertical/matrix.js";
import { beta, freshAssembly, runRequest } from "./harness.js";

/** One mutation anchored `commit:after` with a deterministic producer —
 * the smallest declaration that reaches the updater boundary. */
const mutationDeclaration = (fs: UpdaterFs): RunDeclarations => ({
  mutations: [
    {
      id: "mut-1",
      anchor: { stage: "commit", position: "after" },
      guard: "release-line",
      postconditions: [],
    },
  ],
  mutationIntents: new Map([
    ["mut-1", { path: "pkg.json", produce: () => "{}", expectedDigest: "" }],
  ]),
  updaterFs: fs,
});

describe("the engine's updater boundary (issue #203)", () => {
  it("a crash-divergence refusal blocks the attempt — the half-mutated tree never publishes (issue #203)", () => {
    const assembly = freshAssembly();
    const world = liveWorld();

    // Run 1: the process dies mid-write — the write-ahead start is
    // durable, the effect is not.
    const crashingFs: UpdaterFs = {
      read: () => undefined,
      write: () => {
        throw new Error("process died between write-ahead and effect");
      },
    };
    expect(() =>
      assembly.engine.run(runRequest(world, "main", [beta], mutationDeclaration(crashingFs))),
    ).toThrow(/process died/);

    // Run 2: the resumed walk re-derives the expected bytes and finds the
    // filesystem holding something else — the crash-divergence refusal.
    const divergedFs: UpdaterFs = {
      read: () => '{"partial":"write"}',
      write: () => {
        throw new Error("must not write");
      },
    };
    const outcome = assembly.engine.run(
      runRequest(world, "main", [beta], mutationDeclaration(divergedFs)),
    );

    // The refusal escalates, it never publishes beside itself: blocked
    // with the refusal as the cause, the mutation still uncompleted.
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("expected a blocked outcome");
    if (outcome.handle === null) throw new Error("expected a run handle");
    expect(outcome.cause).toContain("refused:updater:mut-1");
    expect(outcome.handle.attemptId).toBeTruthy();
    expect(assembly.stores.ledger.step(outcome.handle.attemptId, "updater:mut-1")).toBe("started");
  });

  it("an artifact postcondition failure at the shared boundary stops before the mutations — blocked, never a mid-walk throw (issue #203)", () => {
    const assembly = freshAssembly();
    const declarations: RunDeclarations = {
      artifacts: [
        {
          id: "changelog",
          anchor: { stage: "commit", position: "after" },
          guard: "release-line",
          kind: "changelog",
          coordinates: "CHANGELOG.md",
          dependsOn: [],
          postconditions: ["evidence-present"],
        },
      ],
      producers: new Map([
        [
          "changelog",
          (input) => ({
            attribution: { attemptId: input.attemptId, actor: "automation" },
            digest: "digest_sha256:changelog",
          }),
        ],
      ]),
      mutations: [
        {
          id: "version",
          anchor: { stage: "commit", position: "after" },
          guard: "release-line",
          postconditions: [],
        },
      ],
      mutationIntents: new Map([
        ["version", { path: "VERSION", produce: () => "1.0.0", expectedDigest: "" }],
      ]),
      // The mutations must never run — a write here would mean the walk
      // drove mutations over an already-blocked attempt.
      updaterFs: {
        read: () => undefined,
        write: () => {
          throw new Error("must not write");
        },
      },
    };

    const outcome = assembly.engine.run(runRequest(liveWorld(), "main", [beta], declarations));

    // The artifact's failure is the recorded cause; the walk stopped at
    // the shared boundary instead of throwing through it.
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("expected a blocked outcome");
    if (outcome.handle === null) throw new Error("expected a run handle");
    expect(assembly.stores.ledger.step(outcome.handle.attemptId, "updater:version")).toBe("none");
  });
});
