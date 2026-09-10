/**
 * Artifacts as steps (phase 7 contract §2; ADR-0008): the declared
 * artifact values ride the attempt; this module drives the scheduler that
 * walks the effective step list and records the generation records — the
 * (kind, coordinates, digest) triple plus the dependency digests the
 * completion verified against. The producer is the hook effect's sibling:
 * caller-injected, synchronous, never stored or invented by the engine
 * (ADR-0008 decision 2) — invoked at the seam only after the guard check
 * and the dependency precondition pass, and after the step's start is
 * durable (write-ahead). A completed artifact step is never re-executed:
 * replay answers from the ledger projection, and a differing digest on
 * the same key is a conflict, not a silent pass (§2.4).
 *
 * Pure values only: no clock, randomness, environment, filesystem, or
 * network reads (§2.10; ADR-0008 decision 11). Determinism holds —
 * identical declarations, ledgers, claims, and producers classify
 * identically, provable by double-run.
 */
import { block, InvalidExecutionTransitionError } from "./attempt.js";
import { completionRecords } from "./completions.js";
import { effectiveSteps } from "./hooks.js";
import { artifactStepKey, isArtifactStepKey } from "./step-keys.js";
import {
  type ArtifactOutcome,
  type ArtifactProducer,
  type ArtifactsRun,
  type Attribution,
  type ClaimView,
  type ExecutionLedger,
  type LedgerRecord,
  type ReleaseAttempt,
  type StepKey,
  type TransitionRecord,
} from "./types.js";

/** The generation's completeness (§2.4): every declared artifact step of
 * the attempt has a recorded completion in the ledger — the publish
 * gate's evidence (§2.5), read from the projection, never asserted by a
 * caller. */
export const generationComplete = (attempt: ReleaseAttempt, ledger: ExecutionLedger): boolean =>
  (attempt.artifacts ?? []).every(
    (declared) => ledger.step(attempt.attemptId, artifactStepKey(declared.id)) === "completed",
  );

/** The recorded generation record for a completed artifact step (§2.3):
 * the last completion record's content half, or null when the step has
 * no completion — "the ledger projection answers replay" (ADR-0008
 * decision 6). */
export const recordedArtifact = (
  ledger: ExecutionLedger,
  attemptId: string,
  stepKey: StepKey,
): { readonly kind: string; readonly coordinates: string; readonly digest: string } | null => {
  const completions = completionRecords(ledger, attemptId, stepKey);
  const last = completions[completions.length - 1];
  if (last === undefined) {
    return null;
  }
  if (last.artifact === undefined) {
    throw new Error(
      `the ledger recorded ${stepKey} completed without its generation record (contract §2.3)`,
    );
  }
  return last.artifact;
};

/** The appended record's narrowing — `append` returns the frozen
 * `LedgerRecord`; a step write that came back anything but a step record
 * would be the ledger contradicting itself. */
const stepRecord = (appended: LedgerRecord): TransitionRecord => {
  if (appended.kind !== "step") {
    throw new Error("the ledger appended a record it cannot read back as a step record");
  }
  return appended.record;
};

/** The domain artifact door's rule (§2.1, quoted not imported): opaque,
 * non-empty, unpadded. Applied to the producer's digest before the
 * generation record may carry it — fail-closed. */
const digestMalformed = (digest: string): boolean =>
  digest.length === 0 || digest !== digest.trim();

/** Drives the attempt's declared artifact steps in effective-list order
 * (§2.2; ADR-0008 decisions 2–8). Returns the successor attempt — blocked
 * after a §2.5 escalation, otherwise the input — and the outcomes
 * recorded so far; the walk stops at the first refusal or escalation
 * (ordered execution). Order inside the walk: the guard rule, the
 * dependency precondition (before any write-ahead, so a missing proof is
 * the no-record refusal §2.4 demands), the write-ahead start, the
 * producer, the recorded proofs, the completion or the failure. */
export const scheduleArtifacts = (
  attempt: ReleaseAttempt,
  attribution: Attribution,
  ledger: ExecutionLedger,
  claims: ClaimView,
  producers: ReadonlyMap<string, ArtifactProducer>,
): ArtifactsRun => {
  if (attempt.state !== "executing") {
    throw new InvalidExecutionTransitionError(
      `scheduleArtifacts drives an executing attempt, got ${attempt.state} — artifacts run inside the kernel's doors, not beside them`,
    );
  }
  const outcomes: ArtifactOutcome[] = [];
  for (const step of effectiveSteps(attempt)) {
    if (!isArtifactStepKey(step)) {
      continue;
    }
    const declared = (attempt.artifacts ?? []).find(
      (candidate) => artifactStepKey(candidate.id) === step,
    );
    if (declared === undefined) {
      throw new InvalidExecutionTransitionError(
        `no declared artifact answers the recorded key ${step} (contract §2.1)`,
      );
    }
    // Digest reconciliation on replay (§2.4): a second completion record
    // whose recorded digest differs from the first is a conflict — E-02's
    // done-vs-conflict, refused, never a silent pass.
    const completions = completionRecords(ledger, attempt.attemptId, step);
    const digests = new Set(
      completions.flatMap((record) =>
        record.artifact === undefined ? [] : [record.artifact.digest],
      ),
    );
    if (digests.size > 1) {
      outcomes.push({
        kind: "refused",
        stepKey: step,
        artifactId: declared.id,
        detail: `digest-conflict: the generation records disagree on "${declared.id}"'s content (contract §2.4)`,
      });
      break;
    }
    // Replay (§2.2) first: the ledger projection answers, the producer
    // never re-runs to obtain a proof to compare — a completed artifact
    // step replays even when the producers map carries no entry.
    if (ledger.step(attempt.attemptId, step) === "completed") {
      const completed = ledger.stepView().completed(attempt.attemptId, step);
      if (completed === null) {
        throw new Error("the ledger reported the artifact step completed but lost its record");
      }
      if (completed.artifact === undefined) {
        throw new Error(
          `the ledger recorded ${step} completed without its generation record (contract §2.3)`,
        );
      }
      outcomes.push({
        kind: "completed",
        stepKey: step,
        artifactId: declared.id,
        record: completed,
        ...(completed.recordedAt === undefined ? {} : { recordedAt: completed.recordedAt }),
      });
      continue;
    }
    const producer = producers.get(declared.id);
    if (producer === undefined) {
      throw new InvalidExecutionTransitionError(
        `no producer injected for the declared artifact "${declared.id}" — the engine never invents user code (ADR-0008 decision 2)`,
      );
    }
    // The one aggregate guard check, exactly a hook's (ADR-0008
    // decision 3): the attempt holds its claim and the store verifies
    // the token — scope-agnostic, because the ClaimView port exposes
    // exactly one held claim.
    const held = claims.held;
    const verified =
      held !== null && held.holder === attempt.attemptId && claims.verify(held.token);
    if (!verified) {
      // The kernel's recorded refusal — the same shape a mutating stage
      // without its claim takes (§2.5). No record; the caller retries.
      outcomes.push({
        kind: "refused",
        stepKey: step,
        artifactId: declared.id,
        detail: "mutation-without-claim",
      });
      break;
    }
    // The verify precondition (§2.4), before any write-ahead: each
    // declared dependency's completion proof must exist in this
    // generation — a missing proof is the recorded refusal with no
    // record appended, the same shape an unheld claim takes.
    const dependencyDigests: { readonly artifactId: string; readonly digest: string }[] = [];
    let dependencyMissing: string | undefined;
    for (const sibling of declared.dependsOn) {
      const siblingKey = artifactStepKey(sibling);
      const recorded = recordedArtifact(ledger, attempt.attemptId, siblingKey);
      if (recorded === null) {
        dependencyMissing = sibling;
        break;
      }
      dependencyDigests.push({ artifactId: sibling, digest: recorded.digest });
    }
    if (dependencyMissing !== undefined) {
      outcomes.push({
        kind: "refused",
        stepKey: step,
        artifactId: declared.id,
        detail: `dependency-unrecorded: "${dependencyMissing}" has no completion proof in this generation (contract §2.4)`,
      });
      break;
    }
    // Write-ahead start (ADR-0006 decision 2): the declared guard name,
    // verbatim, durable before the producer may run.
    ledger.appendStart(attempt, step, attribution, undefined, declared.guard);
    // The seam (ADR-0008 decision 2): the producer runs; the engine
    // records what it returns. Nothing else is executed or stored.
    const observation = producer({
      attemptId: attempt.attemptId,
      artifactId: declared.id,
      kind: declared.kind,
      coordinates: declared.coordinates,
      stage: declared.anchor.stage,
    });
    // The domain artifact door's rule applies to the recorded triple
    // (§2.1): a malformed digest never lands in the generation record —
    // the §2.5 fail-closed escalation.
    if (digestMalformed(observation.digest)) {
      const appended = ledger.append({
        kind: "step",
        record: {
          attemptId: attempt.attemptId,
          stepKey: step,
          from: "started",
          to: "failed",
          guards: [{ guard: declared.guard, passed: true }],
          attribution: observation.attribution,
          ...(observation.evidence === undefined ? {} : { evidence: observation.evidence }),
          ...(observation.recordedAt === undefined ? {} : { recordedAt: observation.recordedAt }),
        },
      });
      const blocked = block(attempt, `validation:artifact:${declared.id}:digest-invalid`);
      outcomes.push({
        kind: "failed",
        stepKey: step,
        artifactId: declared.id,
        detail: "the producer's digest is not an opaque non-empty unpadded value (contract §2.1)",
        record: stepRecord(appended),
      });
      return { attempt: blocked, outcomes };
    }
    const guards = [{ guard: declared.guard, passed: true }];
    const baseRecord = {
      attemptId: attempt.attemptId,
      stepKey: step,
      from: "started" as const,
      guards,
      attribution: observation.attribution,
      ...(observation.evidence === undefined ? {} : { evidence: observation.evidence }),
      ...(observation.recordedAt === undefined ? {} : { recordedAt: observation.recordedAt }),
    };
    const completionRecord: Omit<TransitionRecord, "to"> = {
      ...baseRecord,
      // The generation record's halves (§2.3, §2.4): the domain
      // `Artifact` triple verbatim — the digest is the content identity,
      // so it is the record's fingerprint too — and the dependency
      // digests this completion verified against, carried verbatim.
      artifact: {
        kind: declared.kind,
        coordinates: declared.coordinates,
        digest: observation.digest,
      },
      contentFingerprint: observation.digest,
      ...(dependencyDigests.length === 0 ? {} : { dependsOn: dependencyDigests }),
    };
    // Postconditions as recorded proofs, the hook's kinds verbatim
    // (§2.2): the check runs before the completion record exists, and
    // the proof lands on it.
    const unmet = declared.postconditions.filter(
      (kind) =>
        (kind === "content-fingerprint-present" && observation.digest.length === 0) ||
        (kind === "evidence-present" &&
          (observation.evidence === undefined || observation.evidence.length === 0)),
    );
    const firstUnmet = unmet[0];
    if (firstUnmet !== undefined) {
      // The failed record is a failure, not a generation record (§2.3):
      // the completion-only halves — the triple, the dependency digests,
      // the content fingerprint — never land on it.
      const appended = ledger.append({
        kind: "step",
        record: { ...baseRecord, to: "failed" },
      });
      const blocked = block(attempt, `validation:artifact:${declared.id}:${firstUnmet}`);
      outcomes.push({
        kind: "failed",
        stepKey: step,
        artifactId: declared.id,
        detail: `postcondition "${firstUnmet}" unmet (contract §2.5)`,
        record: stepRecord(appended),
      });
      return { attempt: blocked, outcomes };
    }
    const appended = ledger.append({
      kind: "step",
      record: { ...completionRecord, to: "completed" },
    });
    outcomes.push({
      kind: "completed",
      stepKey: step,
      artifactId: declared.id,
      record: stepRecord(appended),
      ...(observation.recordedAt === undefined ? {} : { recordedAt: observation.recordedAt }),
    });
  }
  return { attempt, outcomes };
};
