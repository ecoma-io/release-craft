/**
 * The git-backed ledger (ADR-0009 decisions 2–3; contract §2.2) — the
 * durable `ExecutionLedger`, second implementation behind the same doors as
 * the reference `MemoryLedger`, invisible through the port. The mapping the
 * binding owns and the tests pin: one ref per attempt —
 * `refs/ecoma/ledger/<attemptId>` — whose first-parent history is the
 * attempt's record stream, one commit per appended record, the record's
 * canonical JSON as the blob (`record`). The reference discipline carries
 * over unchanged: the plan record is the attempt's first, written once, and
 * lives on the attempt's own stream — the port needs no plan-level anchor,
 * because the reference ledger's plan record is exactly a `tail` member
 * (`tail(attemptId)` includes it; `planFingerprint` reads it there). The
 * externally observed satisfactions (`noteExternal`, E-03) persist on their
 * own per-attempt stream, `refs/ecoma/ledger-external/<attemptId>`, one
 * commit per note, last note per step key winning — the reload path must
 * reproduce them, since `classifyResume`'s `satisfied-externally` verdict
 * reads them through the step view (contract §2.2.3: reloaded tail
 * classifies identically). Every append is a compare-and-swap extension of
 * the recorded history — forward-only by construction; a write that is not
 * an extension never reaches git's ref, and a race the binding keeps losing
 * fails closed (GitFaultError) rather than diverging.
 */
import { Buffer } from "node:buffer";

import {
  InvalidExecutionTransitionError,
  type Attribution,
  type ExecutionLedger,
  type ExternalSatisfaction,
  type KeyedObservation,
  type LedgerRecord,
  type LedgerStepState,
  type ReleaseAttempt,
  type StepKey,
  type StepRecordsView,
  type StepState,
  type TransitionRecord,
} from "../../index.js";

import { canonicalJson } from "../../planner/index.js";

import { deepFreeze, frozenParse } from "./freeze.js";
import { casAppendCommit, commitRecord, firstParentHistory, readRef } from "./git-refs.js";
import { GitFaultError, type GitRun } from "./git-run.js";

/** The compare-and-swap budget: a lost race re-reads the tip, re-classifies,
 * and retries this many rounds, then the binding fails closed. */
const MAX_CAS_ATTEMPTS = 3;

/** Percent-encodes every character git forbids in a refname — the engine's
 * ids hold `:` (`attempt_sha256:<hex>`), which `update-ref` refuses — plus
 * `%` itself, upper-case hex, so the id → ref mapping stays injective. */
export const encodeRefComponent = (value: string): string =>
  value.replace(/[^A-Za-z0-9._/-]/g, (character) =>
    [...Buffer.from(character, "utf8")]
      .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
      .join(""),
  );

/** The ref holding an attempt's record stream — one commit per record, the
 * record's canonical JSON as the blob (contract §2.2's reference mapping). */
export const ledgerRef = (attemptId: string): string =>
  `refs/ecoma/ledger/${encodeRefComponent(attemptId)}`;

/** The ref holding an attempt's external-satisfaction stream (E-03). */
export const externalRef = (attemptId: string): string =>
  `refs/ecoma/ledger-external/${encodeRefComponent(attemptId)}`;

/** One persisted external-satisfaction note (E-03): the keyed observation
 * minus the attempt id, which the stream's ref already names. */
interface ExternalNote {
  readonly stepKey: StepKey;
  readonly satisfaction: ExternalSatisfaction;
}

export class GitLedger implements ExecutionLedger {
  readonly #git: GitRun;

  constructor(git: GitRun) {
    this.#git = git;
  }

  appendStart(
    attempt: ReleaseAttempt,
    stepKey: StepKey,
    attribution: Attribution,
    contentFingerprint?: string,
    guard?: string,
  ): TransitionRecord {
    if (guard !== undefined && guard.length === 0) {
      throw new InvalidExecutionTransitionError(
        "a recorded guard must be a non-empty value (contract §2.6)",
      );
    }
    this.#openPlan(attempt.attemptId, attempt.planFingerprint, attribution);
    const record: TransitionRecord = {
      attemptId: attempt.attemptId,
      stepKey,
      from: "pending",
      to: "started",
      // The hook's declared guard name, verbatim, carrying the one
      // aggregate check's result — the check ran before this write-ahead
      // call (phase 6 contract §2.2; ADR-0007 decision 4).
      guards: guard === undefined ? [] : [{ guard, passed: true }],
      attribution,
      ...(contentFingerprint === undefined ? {} : { contentFingerprint }),
    };
    this.append({ kind: "step", record });
    const stored = this.tail(attempt.attemptId).at(-1);
    if (stored?.kind !== "step") {
      throw new Error("the ledger lost the step record it just appended");
    }
    return stored.record;
  }

  /** The only other write: append, persist, freeze. The record lands as one
   * compare-and-swap commit on its attempt's stream — a pure extension of
   * the recorded history or nothing at all. */
  append(record: LedgerRecord): LedgerRecord {
    const attemptId =
      record.kind === "step"
        ? record.record.attemptId
        : record.kind === "channel-transition"
          ? record.record.attemptId
          : record.attemptId;
    const ref = ledgerRef(attemptId);
    this.#casAppend(ref, () => canonicalJson(record));
    return deepFreeze(record) as LedgerRecord;
  }

  /** All of the attempt's records, append order, reconstructed from the
   * ref's tip by walking the first-parent history (contract §2.2's read
   * path). Every record arrives deep-frozen — `frozenParse` froze it on
   * the way out of the repository. */
  tail(attemptId: string): readonly LedgerRecord[] {
    const ref = ledgerRef(attemptId);
    const records = firstParentHistory(this.#git, ref).map(
      (commit) => frozenParse(commitRecord(this.#git, commit)) as LedgerRecord,
    );
    return deepFreeze(records) as readonly LedgerRecord[];
  }

  /** The step's recorded state, `none` when nothing is recorded (§2.1). A
   * `pending` `to` is not producible through any write door — appendStart
   * writes `started` first — so §2.1's four-state vocabulary reports it as
   * the not-yet-completed state it can only mean. */
  step(attemptId: string, stepKey: StepKey): LedgerStepState {
    const record = this.#stepRecords(attemptId)
      .filter((item) => item.stepKey === stepKey)
      .at(-1);
    return record === undefined ? "none" : record.to === "pending" ? "started" : record.to;
  }

  /** The recorded plan fingerprint (§2.2), or null before the first record. */
  planFingerprint(attemptId: string): string | null {
    const plan = this.tail(attemptId).find(
      (record) => record.kind === "plan" && record.attemptId === attemptId,
    );
    return plan?.kind === "plan" ? plan.planFingerprint : null;
  }

  /** Records an externally observed step satisfaction (E03) on the
   * attempt's external stream — persisted, so a reloaded binding's step
   * view reports the same observation and classification stays equal
   * across reload (contract §2.2.3). */
  noteExternal(observation: KeyedObservation): void {
    const ref = externalRef(observation.attemptId);
    const note: ExternalNote = {
      stepKey: observation.stepKey,
      satisfaction: observation.satisfaction,
    };
    this.#casAppend(ref, () => canonicalJson(note));
  }

  /** The step record view the kernel's `requestStep` consumes (§2.3) — the
   * replay projection, lazy per attempt: nothing is read until a view
   * function names its attempt, and every call reconstructs from the
   * repository rather than caching mutable state. */
  stepView(): StepRecordsView {
    return {
      records: (attemptId) => this.#stepRecords(attemptId),
      completed: (attemptId, stepKey) =>
        [...this.#stepRecords(attemptId)]
          .reverse()
          .find(
            (item) =>
              item.attemptId === attemptId && item.stepKey === stepKey && item.to === "completed",
          ) ?? null,
      state: (attemptId, stepKey): StepState =>
        [...this.#stepRecords(attemptId)]
          .reverse()
          .find((item) => item.attemptId === attemptId && item.stepKey === stepKey)?.to ??
        "pending",
      external: (attemptId, stepKey) => this.#external(attemptId, stepKey),
    };
  }

  #stepRecords(attemptId: string): readonly TransitionRecord[] {
    return this.tail(attemptId).flatMap((record) =>
      record.kind === "step" && record.record.attemptId === attemptId ? [record.record] : [],
    );
  }

  /** The attempt's recorded external satisfactions, the reference ledger's
   * map semantics: the last note for the step key wins. A value that is
   * not a note is a corrupt stream — fail closed, never guess. */
  #external(attemptId: string, stepKey: StepKey): ExternalSatisfaction | null {
    const ref = externalRef(attemptId);
    const noteAt = (commit: string): ExternalNote => {
      // frozenParse hands back unknown; the guard re-earns the type from
      // the bytes before anything consumes them.
      const value = frozenParse(commitRecord(this.#git, commit));
      if (
        typeof value !== "object" ||
        value === null ||
        !("stepKey" in value) ||
        typeof value.stepKey !== "string" ||
        !("satisfaction" in value) ||
        typeof value.satisfaction !== "object" ||
        value.satisfaction === null
      ) {
        throw new GitFaultError(
          ["show", `${commit}:record`],
          null,
          `the external-satisfaction stream at ${ref} holds a value that is not a note — failing closed on a corrupt stream (contract §2.2)`,
        );
      }
      return value as ExternalNote;
    };
    const note = firstParentHistory(this.#git, ref)
      .map(noteAt)
      .filter((item) => item.stepKey === stepKey)
      .at(-1);
    return note === undefined ? null : note.satisfaction;
  }

  /** Plan-first ordering: the attempt's plan record is its first, written
   * once, by the first writer to win the ref (the reference ledger's
   * appendStart discipline, observable-identical — the record joins the
   * attempt's own stream, so `tail` and `planFingerprint` see it there). A
   * lost race re-classifies against the moved tip: another writer's plan
   * record satisfies the open, and nothing more is written. */
  #openPlan(attemptId: string, planFingerprint: string, attribution: Attribution): void {
    const ref = ledgerRef(attemptId);
    const record: LedgerRecord = {
      kind: "plan",
      attemptId,
      planFingerprint,
      attribution,
    };
    this.#casAppend(ref, () =>
      this.planFingerprint(attemptId) === null ? canonicalJson(record) : null,
    );
  }

  /**
   * The one write door every stream shares: classify against the stream's
   * current tip, then append one compare-and-swap commit built on that tip
   * (`casAppendCommit` — the blob is the classified record's canonical
   * JSON, the ref moves only from the base it was read at). A lost race
   * re-reads the tip, re-classifies, and retries — `MAX_CAS_ATTEMPTS`
   * rounds, then the binding fails closed: the recorded history moved
   * under every retry, and appending anyway would diverge it (contract
   * §2.2's forward-only guarantee made physical). A null classification
   * ends the loop with nothing written — the re-read state already
   * satisfies the write. Returns the new tip, or null when the write was
   * already satisfied.
   */
  #casAppend(ref: string, classify: () => string | null): string | null {
    for (let round = 0; round < MAX_CAS_ATTEMPTS; round++) {
      const base = readRef(this.#git, ref);
      const content = classify();
      if (content === null) {
        return null;
      }
      const tip = casAppendCommit(this.#git, ref, content, base);
      if (tip !== null) {
        return tip;
      }
    }
    throw new GitFaultError(
      ["update-ref", ref],
      null,
      `the append lost the compare-and-swap race ${String(MAX_CAS_ATTEMPTS)} times on ${ref} — the recorded history moved under every retry; failing closed rather than diverging it (contract §2.2)`,
    );
  }
}
