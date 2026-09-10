/**
 * Issue #195, defect 1: the engine's canonical-stage fingerprints were the
 * constant `content:<stage>:<attemptId>` — attempt identity where phase 5
 * §2.6 demands `content_sha256:<hex>` over the canonical JSON of the
 * step's declared content inputs. Three properties, all pinned here:
 * a §2.6 consumer re-derives every record's digest from the plan line the
 * walk carried (one row re-derived by hand, the table's smallest cell, so
 * the helper can never drift from the contract unread); the idempotency
 * key does not move with the attempt ordinal — the same declared content
 * under a second attempt hashes equal, so done-versus-conflict stays
 * judgeable by content (E-02, E-03); and different declared content under
 * one stage fingerprints differently, per stage, over the inputs that
 * stage's record describes.
 */
import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  contentFingerprint,
  isArtifactStepKey,
  isHookStepKey,
  plan,
  stageContentFingerprint,
  type LedgerRecord,
  type OperatorIntent,
  type PlanLine,
  type StageKey,
  type TransitionRecord,
} from "../../src/index.js";
import { COMMITTED_AT, liveWorld, planLineFor, plannedOf } from "../vertical/matrix.js";
import {
  beta,
  freshAssembly,
  fullDeclaration,
  rc,
  registerSeededAfter,
  runRequest,
} from "./harness.js";

/** One walk's canonical step records — started and completed both, extension
 * steps excluded (their fingerprints are the observation's, not the walk's). */
const canonicalRecords = (records: readonly LedgerRecord[]): readonly TransitionRecord[] =>
  records.flatMap((appended) =>
    appended.kind === "step" &&
    !isHookStepKey(appended.record.stepKey) &&
    !isArtifactStepKey(appended.record.stepKey)
      ? [appended.record]
      : [],
  );

/** The plan line the walk over one request carries, derived by re-planning
 * the request's closed input — deterministic, so the re-derivation observes
 * exactly the line the engine walked. */
const lineFor = (intents: readonly OperatorIntent[] = [beta]): PlanLine => {
  const planning = plannedOf(plan(runRequest(liveWorld(), "main", intents).input));
  return planLineFor(planning.plan, "main");
};

describe("canonical-stage fingerprints (§2.6): content-bound digests, never a constant", () => {
  it("a §2.6 consumer re-derives every canonical record's fingerprint from declared content", () => {
    const assembly = freshAssembly();
    const outcome = assembly.engine.run(runRequest(liveWorld(), "main", [beta], fullDeclaration()));
    if (outcome.kind !== "published" || outcome.handle === null) {
      throw new Error("fixture broken: expected a published outcome with a handle");
    }
    const line = lineFor();
    const records = canonicalRecords(assembly.stores.ledger.tail(outcome.handle.attemptId));
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.contentFingerprint).toBe(
        stageContentFingerprint(record.stepKey as StageKey, line),
      );
    }
    // One row re-derived by hand — the consumer's side, independent of the
    // helper: the tag stages digest the line id, the stage, and the minted
    // tag's canonical JSON, and nothing else.
    const mintedTag = line.streams[0]?.tag ?? line.stable?.tag ?? null;
    for (const stage of ["tag", "publish", "verify"] as const) {
      expect(stageContentFingerprint(stage, line)).toBe(
        contentFingerprint({ lineId: line.lineId, stage, tag: canonicalJson(mintedTag) }),
      );
    }
  });

  it("the same declared content under a second attempt identity fingerprints identically", () => {
    const first = freshAssembly();
    const outcome = first.engine.run(runRequest(liveWorld(), "main", [beta], fullDeclaration()));
    if (outcome.kind !== "published" || outcome.handle === null || outcome.planId === null) {
      throw new Error("fixture broken: expected a published outcome with a plan id");
    }
    // A second ordinal over the same plan: the register allocates ordinal 2,
    // so the attempt id — identity, not content — is the only thing that
    // moves. §2.6's digest must not move with it: the idempotency key is
    // the declared content, so done-versus-conflict stays judgeable across
    // attempts (E-02, E-03).
    const second = freshAssembly({ register: registerSeededAfter(outcome.planId) });
    const rerun = second.engine.run(runRequest(liveWorld(), "main", [beta], fullDeclaration()));
    if (rerun.kind !== "published" || rerun.handle === null) {
      throw new Error(`fixture broken: expected the second run published, got ${rerun.kind}`);
    }
    expect(rerun.handle.attemptId).not.toBe(outcome.handle.attemptId);
    const fingerprintsOf = (records: readonly LedgerRecord[]): Map<string, string | undefined> => {
      const map = new Map<string, string | undefined>();
      for (const record of canonicalRecords(records)) {
        if (!map.has(record.stepKey)) {
          map.set(record.stepKey, record.contentFingerprint);
        }
      }
      return map;
    };
    const digests = fingerprintsOf(first.stores.ledger.tail(outcome.handle.attemptId));
    const redigested = fingerprintsOf(second.stores.ledger.tail(rerun.handle.attemptId));
    expect(redigested.size).toBe(digests.size);
    for (const [stepKey, digest] of digests) {
      expect(redigested.get(stepKey)).toBe(digest);
    }
  });

  it("the same stage under different declared content fingerprints differently", () => {
    const betaLine = lineFor([beta]);
    const rcLine = lineFor([rc]);
    // The plan, its claim scope, the re-proved precondition, and the
    // tag-bound stages all bind content the beta and rc streams genuinely
    // differ in — the digest moves with it, per stage.
    for (const stage of ["plan", "claim", "validate", "tag", "publish", "verify"] as const) {
      expect(stageContentFingerprint(stage, betaLine)).not.toBe(
        stageContentFingerprint(stage, rcLine),
      );
    }
    // A world with one more release-worthy commit on the line moves the
    // change set — prepare and commit digest it — while the minted tag is
    // unchanged, so the tag stages' digests stand: the binding is
    // per-stage content, not a whole-plan proxy.
    const grownWorld = {
      commits: [
        ...liveWorld().commits,
        {
          sha: "m6",
          parents: ["m5"],
          message: "fix: the after-hours fix",
          committedAt: COMMITTED_AT,
          containingRefs: ["main"],
        },
      ],
      refs: liveWorld().refs.map((ref) => (ref.name === "main" ? { ...ref, head: "m6" } : ref)),
      tags: [...liveWorld().tags],
    };
    const grownLine = planLineFor(
      plannedOf(plan(runRequest(grownWorld, "main", [beta]).input)).plan,
      "main",
    );
    for (const stage of ["prepare", "commit", "plan"] as const) {
      expect(stageContentFingerprint(stage, betaLine)).not.toBe(
        stageContentFingerprint(stage, grownLine),
      );
    }
    expect(stageContentFingerprint("tag", betaLine)).toBe(
      stageContentFingerprint("tag", grownLine),
    );
    // The channel stage digests the planned moves: an empty plan and a
    // plan naming one move disagree.
    const movingLine: PlanLine = {
      ...betaLine,
      channels: [
        { kind: "channel-move", channelId: "stable", to: { line: "main", version: "5.0.0" } },
      ],
    };
    expect(stageContentFingerprint("channel-transition", betaLine)).not.toBe(
      stageContentFingerprint("channel-transition", movingLine),
    );
    // Determinism: identical declared content digests identically.
    expect(stageContentFingerprint("tag", betaLine)).toBe(
      stageContentFingerprint("tag", lineFor([beta])),
    );
  });
});
