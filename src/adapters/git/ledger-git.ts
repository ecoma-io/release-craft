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

  /** The reconstructed tails, keyed by ref and by the tip they walked. The
   * ref itself is read on every `tail` call — the cheap half — and the
   * recorded commits are re-read out of the object store only when the tip
   * has moved; a walk's repeated tail reads (the projection, the resume
   * classification, the abandonment scan) stop re-deriving the whole
   * history per call. A concurrent writer still shows: it moves the ref,
   * the probe misses the cache, the history is re-walked. Entries are
   * extended by the walk's own winning appends only when they hold the
   * exact base the append extended — anything else is dropped, so a
   * history that raced a concurrent winner is never served. */
  readonly #tails: Map<
    string,
    { readonly tip: string | null; readonly records: readonly LedgerRecord[] }
  > = new Map();

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
   * the recorded history or nothing at all. A winning append extends the
   * walked tail it built on, so the walk's next read of this stream does
   * not re-read what it just wrote. */
  append(record: LedgerRecord): LedgerRecord {
    const attemptId =
      record.kind === "step"
        ? record.record.attemptId
        : record.kind === "channel-transition"
          ? record.record.attemptId
          : record.attemptId;
    const ref = ledgerRef(attemptId);
    const bytes = canonicalJson(record);
    this.#casAppend(
      ref,
      () => bytes,
      (base, tip) => {
        this.#cacheAppend(ref, base, tip, bytes);
      },
    );
    return deepFreeze(record) as LedgerRecord;
  }

  /** All of the attempt's records, append order, reconstructed from the
   * ref's tip by walking the first-parent history (contract §2.2's read
   * path). The ref is read on every call; the history behind it is walked
   * only when the tip moved off what the last walk saw — a repeated tail
   * read inside one walk is answered from the walked history without
   * re-reading the object store, and a concurrent writer's ref move is
   * still seen as it happens. Every record arrives deep-frozen —
   * `frozenParse` froze it on the way out of the repository. */
  tail(attemptId: string): readonly LedgerRecord[] {
    const ref = ledgerRef(attemptId);
    const cached = this.#tails.get(ref);
    const tip = readRef(this.#git, ref);
    if (cached !== undefined && cached.tip === tip) {
      return deepFreeze([...cached.records]) as readonly LedgerRecord[];
    }
    const commits = firstParentHistory(this.#git, ref);
    const records = commits.map(
      (commit) => frozenParse(commitRecord(this.#git, commit)) as LedgerRecord,
    );
    // The cache keys on the tip the walk itself saw — the history's own
    // last commit, not the probe above — so a ref that moves inside the
    // read window keys the entry to the history it truly holds.
    this.#tails.set(ref, { tip: commits.at(-1) ?? null, records });
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
   * function names its attempt, and every call re-reads the ref rather
   * than caching mutable state (the walked history behind the ref is
   * `tail`'s tip-keyed cache). */
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
    this.#casAppend(
      ref,
      () => (this.planFingerprint(attemptId) === null ? canonicalJson(record) : null),
      (base, tip) => {
        this.#cacheAppend(ref, base, tip, canonicalJson(record));
      },
    );
  }

  /**
   * Extends the walked tail `ref`'s cache holds when it is exactly the
   * history `base` names — the state the append was classified against and
   * extended — and drops it otherwise (a read that raced a concurrent
   * winner, or no read at all): the next tail re-walks from the ref, never
   * serving a history the cache does not hold. The appended record joins
   * as `frozenParse` of the very bytes the commit carries, so the cached
   * tail is byte-identical to what a fresh walk of the ref returns.
   */
  #cacheAppend(ref: string, base: string | null, tip: string, bytes: string): void {
    const cached = this.#tails.get(ref);
    if (cached === undefined || cached.tip !== base) {
      this.#tails.delete(ref);
      return;
    }
    this.#tails.set(ref, {
      tip,
      records: [...cached.records, frozenParse(bytes) as LedgerRecord],
    });
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
   * satisfies the write. A winning round hands `(base, tip)` to `onWin`
   * before the loop returns, so the caller can extend what it knows the
   * append produced. Returns the new tip, or null when the write was
   * already satisfied.
   */
  #casAppend(
    ref: string,
    classify: () => string | null,
    onWin?: (base: string | null, tip: string) => void,
  ): string | null {
    for (let round = 0; round < MAX_CAS_ATTEMPTS; round++) {
      const base = readRef(this.#git, ref);
      const content = classify();
      if (content === null) {
        return null;
      }
      const tip = casAppendCommit(this.#git, ref, content, base);
      if (tip !== null) {
        onWin?.(base, tip);
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
