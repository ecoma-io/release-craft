/**
 * Attribution-gated adoption, the disposition store, and evidence
 * verification (phase 5 contract §2.5–§2.6; ADR-0006 decisions 6–8).
 * Externally observed state is adopted as completed work only when
 * `verifyEvidence` returns `verified` over the source attempt's recorded
 * fingerprint and the observation's — adoption then appends an absorption
 * record (`adopted-from:<sourceAttemptId>`) into the adopting attempt's
 * ledger and never re-executes the step. Evidence that is absent, partial,
 * or ambiguous escalates instead: the observation lands verbatim in the
 * disposition store, an append-only surfaced collection nothing
 * auto-resolves (E-09). Bare existence is never evidence; `conflict` and
 * `unverified` are recorded values, never throws (§3's no-silent-failure
 * law).
 */
import { InvalidExecutionTransitionError } from "./attempt.js";
import type {
  AdoptionOutcome,
  DispositionEntry,
  EvidenceVerdict,
  ExecutionLedger,
  ExternalSatisfaction,
  ReleaseAttempt,
  StepKey,
} from "./types.js";

/**
 * The evidence verdict (§2.6, E-03) — pure over the recorded and observed
 * fingerprints: both present and equal → verified; both present and
 * different → conflict; exactly one present → conflict (fail-closed — an
 * evidence pair must agree, a missing side is a disagreement); absent on
 * both sides → unverified. This is the verification ADR-0005 decision 8
 * deferred; adoption never runs on conflict or unverified.
 */
export const verifyEvidence = (
  recorded: string | undefined,
  observed: string | undefined,
): EvidenceVerdict => {
  if (recorded === undefined && observed === undefined) {
    return { kind: "unverified" };
  }
  if (recorded === undefined || observed === undefined) {
    return {
      kind: "conflict",
      detail: `one-sided evidence: the ${
        recorded === undefined ? "recorded" : "observed"
      } fingerprint is absent — the pair must agree (§2.6, fail-closed)`,
    };
  }
  if (recorded !== observed) {
    return {
      kind: "conflict",
      detail: `content fingerprints disagree: recorded ${recorded}, observed ${observed} (§2.6)`,
    };
  }
  return { kind: "verified" };
};

/** The disposition store (§2.5, E-09): append-only, surfaced, never
 * auto-resolved — disposition (adopt, delete-tag, void) is a recorded human
 * or policy decision consumed as a value. Entries deep-freeze on record —
 * the ledger's discipline (§2.1); `entries()` hands out a fresh array, so
 * the only way in is `record`. */
export class MemoryDispositionStore {
  readonly #entries: DispositionEntry[] = [];

  /** The store's only write: append, deep-freeze, keep order. Returns
   * the frozen entry that is now part of the dispositions. */
  record(entry: DispositionEntry): DispositionEntry {
    const frozen = Object.freeze({
      ...entry,
      attribution: Object.freeze({ ...entry.attribution }),
    });
    this.#entries.push(frozen);
    return frozen;
  }

  /** Every recorded entry, append order (§2.5, E-09). */
  entries(): readonly DispositionEntry[] {
    return this.#entries.slice();
  }
}

/**
 * Adoption (§2.5, E-06, AR-05, AR-06): attribute the source attempt's
 * completed step to the observation and, only over `verified` evidence,
 * append into the ADOPTING attempt's ledger: the step's own write-ahead
 * start, its completion (so every projection and later classification
 * sees adopted work as done — ADR-0006 decision 6), and the absorption
 * record naming the source. The source attempt is never mutated and no
 * evidence is ever invented — records carry the observation's evidence
 * and attribution verbatim. `recordedAt`, when the caller supplies it,
 * enters the store's entries verbatim as §2.5's "when" metadata.
 * Without a completed source record, or on `conflict`/`unverified` (§2.6's
 * fail-closed pair), the observation is recorded verbatim in the dispositions
 * and the path escalates — adoption never runs on unverified evidence, and
 * bare existence never adopts. An empty actor is the one protocol
 * violation: attribution is §2.6's non-empty identity.
 */
export const adopt = (
  into: ReleaseAttempt,
  stepKey: StepKey,
  adoptedFrom: string,
  ledger: ExecutionLedger,
  observation: ExternalSatisfaction,
  dispositions: MemoryDispositionStore,
  recordedAt?: string,
): AdoptionOutcome => {
  if (observation.attribution.actor.length === 0) {
    throw new InvalidExecutionTransitionError(
      "adoption observation carries an empty actor — attribution is §2.6's non-empty identity",
    );
  }
  // E-06/AR-05: the source attempt must have completed the step — a bare
  // start record (or no record at all) leaves the state orphaned.
  const source = ledger.stepView().completed(adoptedFrom, stepKey);
  if (source === null) {
    dispositions.record({
      kind: "orphan-state",
      // §2.5's "where" is the ORPHANED state's coordinates — the source
      // attempt's step, not the adopting attempt's pointer to it.
      where: `attempt:${adoptedFrom}/step:${stepKey}`,
      evidence: observation.evidence,
      attribution: observation.attribution,
      ...(recordedAt === undefined ? {} : { recordedAt }),
    });
    return {
      kind: "escalated",
      detail: `no completed ${stepKey} recorded for source attempt ${adoptedFrom} — bare existence never adopts (E-06, AR-05)`,
    };
  }
  const verdict = verifyEvidence(source.contentFingerprint, observation.contentFingerprint);
  if (verdict.kind !== "verified") {
    // E-06/AR-06: the pre-overwrite observation is preserved verbatim; the
    // recorded human or policy decision happens later — nothing here
    // auto-resolves (§2.5, §3).
    dispositions.record({
      kind: "unattributed-state",
      where: `attempt:${adoptedFrom}/step:${stepKey}`,
      evidence: observation.evidence,
      attribution: observation.attribution,
      ...(recordedAt === undefined ? {} : { recordedAt }),
    });
    return {
      kind: "escalated",
      detail:
        verdict.kind === "conflict"
          ? `adoption refused on conflict: ${verdict.detail}`
          : "adoption refused on unverified evidence: no fingerprints on either side (§2.6)",
    };
  }
  // ADR-0006 decision 6: adopted state is COMPLETED work — the adopting
  // ledger records the step as its own start-then-completion (write-ahead
  // included, the source attribution carried) so every projection and every
  // later classification sees it done and the step is never re-executed;
  // the absorption record then names where the work came from (§2.5).
  ledger.appendStart(into, stepKey, observation.attribution, observation.contentFingerprint);
  ledger.append({
    kind: "step",
    record: {
      attemptId: into.attemptId,
      stepKey,
      from: "started",
      to: "completed",
      guards: [],
      attribution: observation.attribution,
      evidence: observation.evidence,
      ...(observation.contentFingerprint === undefined
        ? {}
        : { contentFingerprint: observation.contentFingerprint }),
    },
  });
  const record = ledger.append({
    kind: "absorption",
    attemptId: into.attemptId,
    stepKey,
    adoptedFrom,
    evidence: observation.evidence,
    attribution: observation.attribution,
    ...(recordedAt === undefined ? {} : { recordedAt }),
  });
  return { kind: "adopted", record };
};
