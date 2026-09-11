/**
 * The verify stage's recorded evidence names its derivation (#279) — the
 * same truthing class #269 shut at validate, applied to the walk's last
 * stage: the tag-boundary guard row's durable detail states the
 * recorded-sequence projection the check performs (every prior stage's
 * completion read from the records, no world re-observation) and names
 * where the boundary's world-side re-check actually lives (the mint door's
 * create-if-absent CAS) — never a re-proof the verify check did not run.
 *
 * The fabrication class this file pins shut (#279): a verify record whose
 * detail claims a world re-proof the check never performed. Reverting the
 * wording — here or in the kernel's guard builder — turns the test red.
 */
import { describe, expect, it } from "vitest";

import { beta, freshAssembly, runRequest } from "./harness.js";
import { liveWorld } from "../vertical/matrix.js";

describe("#279 — the verify evidence names its derivation", () => {
  it("the boundary's beta run records the tag-boundary row with the recorded-sequence derivation", () => {
    const { engine } = freshAssembly();
    const outcome = engine.run(runRequest(liveWorld(), "main", [beta]));
    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published" || outcome.handle === null) {
      throw new Error("fixture broken: the beta run did not publish");
    }
    const verify = outcome.drives.find((drive) => drive.stepKey === "verify");
    expect(verify?.outcome.kind).toBe("advance");
    if (verify === undefined || verify.outcome.kind !== "advance") {
      throw new Error("fixture broken: no verify advance in the drives");
    }
    // The row is never vacuous — the beta run's walk reaches verify with
    // its full recorded prefix behind it.
    expect(verify.outcome.record.guards).toStrictEqual([
      {
        guard: "tag-boundary",
        passed: true,
        detail:
          "the tag boundary stands by the walk's recorded sequence — every prior stage's completion recorded, no world re-observation here; the world's re-check lives at the mint door's create-if-absent CAS (§2.9)",
      },
    ]);
  });
});
