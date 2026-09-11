/**
 * The validate stage's recorded evidence names its derivation (#269) — the
 * application boundary contract §2.5's amended validate clause: the walk
 * records the plan's preconditions as the plan's own recorded content, and
 * every passed guard row carries the `plan-recorded` derivation on the
 * durable record, never a bare hold no check derived. The refusal half
 * rides the same vocabulary: a `holds: false` observation — the shape a
 * world-side delta would arrive in — is the kernel door's
 * `blocked(precondition-delta)` (E-04) with the cause on the failed row,
 * the verdict the walk stops on in order (§2.5's non-advance law), and a
 * derivation token outside the closed vocabulary is the door's named
 * refusal — never a silent fall-through to a bare hold.
 *
 * The fabrication class this file pins shut (#269): a validate record
 * asserting a hold without naming where the hold came from. Dropping the
 * derivation from the walk's mapping — or the detail from the guard row —
 * turns the first test red; deleting the door's vocabulary check turns the
 * third red.
 */
import { describe, expect, it } from "vitest";

import {
  MemoryAttemptRegister,
  MemoryClaimStore,
  MemoryTransitionLog,
  openAttempt,
  requestStep,
  start,
  type PreconditionObservation,
  type RequestStepOutcome,
  type StepRequest,
} from "../../src/index.js";
import { beta, freshAssembly, runRequest } from "./harness.js";
import { liveWorld } from "../vertical/matrix.js";

/** One validate observation through the kernel door, over the walk's own
 * recorded prefix: plan, claim, prepare stand before validate — the door's
 * sequence law refuses a stage whose predecessor never recorded, so each
 * observation opens its own attempt and walks the prefix, exactly as the
 * boundary's walk would. */
const observe = (extra: Partial<StepRequest>): RequestStepOutcome => {
  const store = new MemoryClaimStore();
  const log = new MemoryTransitionLog();
  const attempt = start(
    openAttempt(new MemoryAttemptRegister(), {
      planId: "plan:test",
      planFingerprint: "content:plan",
    }),
  );
  const run = (stepKey: StepRequest["stepKey"]): void => {
    const outcome = requestStep(
      attempt,
      {
        stepKey,
        attribution: { attemptId: attempt.attemptId, actor: "automation" },
        contentFingerprint: `content:${stepKey}:${attempt.attemptId}`,
      },
      store.viewFor(attempt.attemptId),
      log.stepView(),
    );
    expect(outcome.kind).toBe("advance");
    if (outcome.kind === "advance") {
      log.append(outcome.record);
    }
  };
  run("plan");
  store.acquire(
    { kind: "stable-version", lineId: "line-main", version: "1.2.0" },
    attempt.attemptId,
  );
  run("claim");
  run("prepare");
  return requestStep(
    attempt,
    {
      stepKey: "validate",
      attribution: { attemptId: attempt.attemptId, actor: "automation" },
      contentFingerprint: `content:validate:${attempt.attemptId}`,
      ...extra,
    },
    store.viewFor(attempt.attemptId),
    log.stepView(),
  );
};

describe("#269 — the validate evidence names its derivation", () => {
  it("every precondition guard row the walk records carries the plan-recorded derivation", () => {
    const { engine } = freshAssembly();
    const outcome = engine.run(runRequest(liveWorld(), "main", [beta]));
    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published" || outcome.handle === null) {
      throw new Error("fixture broken: the beta run did not publish");
    }
    const validate = outcome.drives.find((drive) => drive.stepKey === "validate");
    expect(validate?.outcome.kind).toBe("advance");
    if (validate === undefined || validate.outcome.kind !== "advance") {
      throw new Error("fixture broken: no validate advance in the drives");
    }
    const preconditionRows = validate.outcome.record.guards.filter((guard) =>
      guard.guard.startsWith("precondition:"),
    );
    // The beta plan mints a tag, so its plan line carries at least one
    // `tag-absent` precondition — the pin is never vacuous.
    expect(preconditionRows.length).toBeGreaterThan(0);
    for (const row of preconditionRows) {
      expect(row.passed).toBe(true);
      // The hold is named for what it is: the plan's own recorded
      // precondition content, derived at planning — not a re-observation.
      expect(row.detail).toMatch(/^plan-recorded:/);
    }
  });

  it("the door's refusal half: a failed hold blocks with the cause; a derived hold advances and names itself", () => {
    const rows: readonly PreconditionObservation[] = [
      {
        precondition: '{"kind":"tag-absent","tag":"1.2.0"}',
        holds: true,
        derivation: "plan-recorded",
      },
    ];
    const advance = observe({ preconditions: rows });
    expect(advance.kind).toBe("advance");
    if (advance.kind !== "advance") {
      throw new Error("fixture broken: the derived hold did not advance");
    }
    expect(advance.record.guards).toStrictEqual([
      {
        guard: 'precondition:{"kind":"tag-absent","tag":"1.2.0"}',
        passed: true,
        detail:
          "plan-recorded: the hold is the plan's own recorded precondition content, derived at planning from the closed input world — the walk re-observed nothing (phase 11 §2.5)",
      },
    ]);

    const failed = observe({
      preconditions: [
        {
          precondition: '{"kind":"tag-absent","tag":"1.2.0"}',
          holds: false,
          cause: "precondition-delta",
        },
      ],
    });
    expect(failed).toEqual({
      kind: "blocked",
      stepKey: "validate",
      cause: "precondition-delta",
    });
  });

  it("a foreign derivation through the door is refused loudly, never a silent bare hold", () => {
    // The runtime hole the compile-time union cannot close: a JS-boundary
    // caller handing the kernel door a token outside the closed vocabulary.
    // The row is built the way such a caller's payload arrives — untyped
    // through the wire, JSON.parse — and handed to the typed door verbatim.
    // The door must refuse by name; falling through would record a bare
    // unevaluated hold, byte-identical to the pre-#269 fabrication.
    const foreignRow = JSON.parse(
      JSON.stringify({
        precondition: '{"kind":"tag-absent","tag":"1.2.0"}',
        holds: true,
        derivation: "world-reobserved-typo",
      }),
    ) as PreconditionObservation;
    const outcome = observe({ preconditions: [foreignRow] });
    expect(outcome).toEqual({
      kind: "refused",
      stepKey: "validate",
      detail:
        'precondition-derivation-unknown: "world-reobserved-typo" is outside the closed derivation vocabulary (plan-recorded) — the hold cannot be recorded honestly (#269)',
    });
  });
});
