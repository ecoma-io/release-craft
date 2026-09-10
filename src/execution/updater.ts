/**
 * The updater layer (issue #203): ledger-tracked file mutations. Every
 * mutation the engine performs is an execution step — write-ahead start,
 * then effect, then completion or failure record — the same doctrine the
 * hooks and artifact layers follow (§2.2, ADR-0006 decision 2).
 *
 * Deterministic replay (issue #203): the content producer is a pure
 * function. Re-running it must yield identical bytes. The scheduler's
 * replay path answers from the ledger's stored record and never re-runs
 * the producer.
 *
 * Crash reconciliation (issue #203): a step `started` but not
 * `completed` is a crash between write-ahead and effect. The scheduler
 * re-derives the expected bytes and reads the filesystem: identical →
 * resume (record completion); different → refuse (external modification
 * or partial write; a human judges).
 *
 * Pure values only: no clock, randomness, environment, or network reads
 * (§2.10). The filesystem seam (`UpdaterFs`) and the content producers
 * (`MutationIntent.produce`) are caller-injected — the engine never
 * invents them.
 */
import { block, InvalidExecutionTransitionError } from "./attempt.js";
import { updaterStepKey } from "./step-keys.js";
import {
  type Attribution,
  type ClaimView,
  type DeclaredMutation,
  type ExecutionLedger,
  type LedgerRecord,
  type MutationIntent,
  type MutationOutcome,
  type MutationsRun,
  type PostconditionKind,
  type ReleaseAttempt,
  type TransitionRecord,
  type UpdaterFs,
  type UpdaterStepKey,
} from "./types.js";

/** The appended record's narrowing (hooks module §2.5's shape): `append`
 * returns the frozen `LedgerRecord`; a step write that came back anything
 * but a step record is the ledger contradicting itself. */
const stepRecord = (appended: LedgerRecord): TransitionRecord => {
  if (appended.kind !== "step") {
    throw new Error("the ledger appended a mutation record it cannot read back as a step record");
  }
  return appended.record;
};

/** Extracts the updater mutation steps from the declared mutations in
 * declaration order, each paired with its ledger key (issue #203's
 * `updater:<id>` space). The scheduler iterates these; `effectiveSteps`
 * (hooks module) places the same keys in the attempt's full step list
 * so the resume classification sees them. */
export const effectiveUpdaterSteps = (
  attempt: ReleaseAttempt,
): readonly { readonly stepKey: UpdaterStepKey; readonly mutation: DeclaredMutation }[] =>
  (attempt.mutations ?? []).map((mutation) => ({
    stepKey: updaterStepKey(mutation.id),
    mutation,
  }));

/** The declared postconditions this mutation cannot prove (ADR-0007
 * decision 5, shared by the fresh and crash-reconcile paths): an
 * `evidence-present` declaration is unmet by construction — the FS seam
 * returns no evidence ref — and `content-fingerprint-present` is unmet
 * when the intent declares no digest. Shared so a resumed completion
 * proves exactly what a fresh one would. */
const unmetPostconditions = (
  mutation: DeclaredMutation,
  intent: MutationIntent,
): readonly PostconditionKind[] =>
  mutation.postconditions.filter(
    (kind) =>
      (kind === "content-fingerprint-present" && intent.expectedDigest.length === 0) ||
      kind === "evidence-present",
  );

/** Drives the attempt's declared updater mutations in effective-list
 * order (issue #203). Returns the successor attempt — blocked after a
 * §2.5 escalation, otherwise the input — and the outcomes recorded so
 * far; the walk stops at the first refusal or escalation (ordered
 * execution). A completed mutation is never re-executed: the ledger
 * projection answers, and the outcome carries the stored proof (decision
 * 6). The engine executes nothing but the caller-injected producers and
 * the FS adapter at the seam (decision 2). */
export const scheduleMutations = (
  attempt: ReleaseAttempt,
  attribution: Attribution,
  ledger: ExecutionLedger,
  claims: ClaimView,
  intents: ReadonlyMap<string, MutationIntent>,
  fs: UpdaterFs,
): MutationsRun => {
  if (attempt.state !== "executing") {
    throw new InvalidExecutionTransitionError(
      `scheduleMutations drives an executing attempt, got ${attempt.state} — mutations run inside the kernel's doors, not beside them`,
    );
  }
  const outcomes: MutationOutcome[] = [];
  for (const { stepKey, mutation } of effectiveUpdaterSteps(attempt)) {
    // Replay (§2.2) first: the ledger projection answers, the producer
    // never re-runs — a completed mutation replays even when the intents
    // map carries no entry.
    if (ledger.step(attempt.attemptId, stepKey) === "completed") {
      const completed = ledger.stepView().completed(attempt.attemptId, stepKey);
      if (completed === null) {
        throw new Error("the ledger reported the mutation completed but lost its record");
      }
      outcomes.push({
        kind: "completed",
        stepKey,
        mutationId: mutation.id,
        record: completed,
      });
      continue;
    }

    // The intent: every non-replay path needs the producer and the path.
    // (Replay above deliberately answers without one.)
    const intent = intents.get(mutation.id);

    // Crash reconciliation (issue #203): a step `started` but not
    // `completed` — a crash between write-ahead and effect. Re-derive
    // the expected bytes from the producer and read the filesystem:
    // identical → resume; different → refuse.
    if (ledger.step(attempt.attemptId, stepKey) === "started") {
      if (intent === undefined) {
        // The engine cannot reconcile without a producer — the durable
        // start exists but the intent to re-derive from does not.
        // Escalate: a human judges (§2.5).
        const appended = ledger.append({
          kind: "step",
          record: {
            attemptId: attempt.attemptId,
            stepKey,
            from: "started",
            guards: [{ guard: mutation.guard, passed: false }],
            attribution,
            to: "failed",
          },
        });
        const blocked = block(attempt, `validation:updater:${mutation.id}:no-intent`);
        outcomes.push({
          kind: "failed",
          stepKey,
          mutationId: mutation.id,
          detail:
            "no intent injected for a durable start — the engine cannot re-derive the expected bytes (ADR-0007 decision 2)",
          record: stepRecord(appended),
        });
        return { attempt: blocked, outcomes };
      }
      const expected = intent.produce();
      const current = fs.read(intent.path);
      if (current === expected) {
        // The same declarable proofs the fresh path runs — a resumed
        // completion carries them identically, or it is a failure the
        // same way a fresh one would be.
        const unmet = unmetPostconditions(mutation, intent);
        const firstUnmet = unmet[0];
        if (firstUnmet !== undefined) {
          const appended = ledger.append({
            kind: "step",
            record: {
              attemptId: attempt.attemptId,
              stepKey,
              from: "started",
              guards: [{ guard: mutation.guard, passed: true }],
              attribution,
              to: "failed",
            },
          });
          const blocked = block(attempt, `validation:updater:${mutation.id}:${firstUnmet}`);
          outcomes.push({
            kind: "failed",
            stepKey,
            mutationId: mutation.id,
            detail: `postcondition "${firstUnmet}" unmet (contract §2.5)`,
            record: stepRecord(appended),
          });
          return { attempt: blocked, outcomes };
        }
        // Resume: the filesystem already holds the correct bytes. The
        // effect is durable-in-place; record completion, never re-write.
        // The completion carries the caller's declared digest — the
        // recorded proof downstream verification reads (issue #203).
        const appended = ledger.append({
          kind: "step",
          record: {
            attemptId: attempt.attemptId,
            stepKey,
            from: "started",
            guards: [{ guard: mutation.guard, passed: true }],
            attribution,
            to: "completed",
            ...(intent.expectedDigest.length === 0
              ? {}
              : { contentFingerprint: intent.expectedDigest }),
          },
        });
        outcomes.push({
          kind: "completed",
          stepKey,
          mutationId: mutation.id,
          record: stepRecord(appended),
        });
        continue;
      }
      // Refuse: the filesystem differs from what the deterministic
      // producer re-derives — an external modification or a partial
      // write happened between the crash and this resume. Fail-closed:
      // no completion, no re-write; the caller retries after a human
      // judges the divergence.
      outcomes.push({
        kind: "refused",
        stepKey,
        mutationId: mutation.id,
        detail:
          "crash reconciliation refused — the filesystem differs from the re-derived content (external modification or partial write)",
      });
      break;
    }

    // A fresh mutation step (ledger state `none`).
    if (intent === undefined) {
      throw new InvalidExecutionTransitionError(
        `no intent injected for the declared mutation "${mutation.id}" — the engine never invents user code (ADR-0007 decision 2)`,
      );
    }

    // The one aggregate guard check (ADR-0007 decision 4): the attempt
    // holds its claim and the store verifies the token.
    const held = claims.held;
    const verified =
      held !== null && held.holder === attempt.attemptId && claims.verify(held.token);
    if (!verified) {
      // The kernel's recorded refusal — the same shape a mutating stage
      // without its claim takes (§2.5). No record; the caller retries.
      outcomes.push({
        kind: "refused",
        stepKey,
        mutationId: mutation.id,
        detail: "mutation-without-claim",
      });
      break;
    }

    // Write-ahead start (ADR-0006 decision 2): the declared guard name,
    // verbatim, durable before the producer may run.
    ledger.appendStart(attempt, stepKey, attribution, undefined, mutation.guard);

    // The seam (ADR-0007 decision 2): the producer runs; the engine
    // records what it returns. Nothing else is executed or stored.
    const content = intent.produce();

    // The effect: the FS adapter writes. Its mechanism (direct, atomic,
    // buffered) is the adapter's own choice — the updater never assumes.
    fs.write(intent.path, content);

    // The write-verify gate (issue #203): re-read and compare against
    // the producer's bytes. A deterministic producer plus a correct
    // adapter always agree; divergence is the adapter's failure.
    const written = fs.read(intent.path);
    if (written !== content) {
      const appended = ledger.append({
        kind: "step",
        record: {
          attemptId: attempt.attemptId,
          stepKey,
          from: "started",
          guards: [{ guard: mutation.guard, passed: true }],
          attribution,
          to: "failed",
        },
      });
      const blocked = block(attempt, `validation:updater:${mutation.id}:write-verify`);
      outcomes.push({
        kind: "failed",
        stepKey,
        mutationId: mutation.id,
        detail: "write-verify mismatch — the adapter's bytes differ from the producer's bytes",
        record: stepRecord(appended),
      });
      return { attempt: blocked, outcomes };
    }

    // Postconditions as recorded proofs (ADR-0007 decision 5): the check
    // runs before the completion record exists, and the proof lands on
    // it. For file mutations the only declarable proof is the content
    // fingerprint — the intent's expectedDigest, the caller's declared
    // digest of the produced bytes. `evidence-present` has no updater
    // analogue (the FS seam returns no evidence ref), so a declaration
    // of it is unmet by construction.
    const firstUnmet = unmetPostconditions(mutation, intent)[0];
    if (firstUnmet !== undefined) {
      const appended = ledger.append({
        kind: "step",
        record: {
          attemptId: attempt.attemptId,
          stepKey,
          from: "started",
          guards: [{ guard: mutation.guard, passed: true }],
          attribution,
          to: "failed",
        },
      });
      const blocked = block(attempt, `validation:updater:${mutation.id}:${firstUnmet}`);
      outcomes.push({
        kind: "failed",
        stepKey,
        mutationId: mutation.id,
        detail: `postcondition "${firstUnmet}" unmet (contract §2.5)`,
        record: stepRecord(appended),
      });
      return { attempt: blocked, outcomes };
    }

    // The completion record: guards passed, content fingerprint from the
    // caller's declared digest when the postcondition names it (or the
    // digest is non-empty — the proof is free and always true of a
    // deterministic producer's output).
    const appended = ledger.append({
      kind: "step",
      record: {
        attemptId: attempt.attemptId,
        stepKey,
        from: "started",
        guards: [{ guard: mutation.guard, passed: true }],
        attribution,
        to: "completed",
        ...(intent.expectedDigest.length === 0
          ? {}
          : { contentFingerprint: intent.expectedDigest }),
      },
    });
    outcomes.push({
      kind: "completed",
      stepKey,
      mutationId: mutation.id,
      record: stepRecord(appended),
    });
  }
  return { attempt, outcomes };
};
