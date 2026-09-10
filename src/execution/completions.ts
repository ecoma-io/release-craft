/**
 * The completion-record projection both extension schedulers reconcile
 * over (phase 6 contract §2.4; phase 7 contract §2.3–§2.4): the
 * `completed` step records one step key has accumulated on the tail, in
 * append order. The hook scheduler's recorded-content reconciliation and
 * the artifact scheduler's digest reconciliation read this one projection
 * so the two scans cannot drift.
 *
 * Pure values only: reads the ledger's tail, writes nothing (§2.10).
 */
import type { ExecutionLedger, StepKey, TransitionRecord } from "./types.js";

/** The completion records one step has accumulated, append order — the
 * recorded-vs-recorded reconciliation's raw material (§2.2; phase 7
 * §2.4). A failed or started record is never a completion. */
export const completionRecords = (
  ledger: ExecutionLedger,
  attemptId: string,
  stepKey: StepKey,
): readonly TransitionRecord[] =>
  ledger
    .tail(attemptId)
    .flatMap((appended) => (appended.kind === "step" ? [appended.record] : []))
    .filter((record) => record.stepKey === stepKey && record.to === "completed");
