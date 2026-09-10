/**
 * The git-backed attempt register (ADR-0009 decisions 2–3; contract §2.2) —
 * the durable `AttemptRegister` (E-05): each plan's ordinal counter is one
 * fast-forward-only ref, `refs/release-craft/register/<planId>`, whose tip commit's
 * blob is `{"nextOrdinal":N}` in canonical JSON. Allocating an ordinal is a
 * compare-and-swap of that blob — one ref update decides, so two racing
 * allocators see exactly one winner; the loser re-reads the tip and
 * retries, and a race the binding keeps losing fails closed
 * (GitFaultError) rather than double-allocating. The counter shares the
 * ledger's persistence discipline (contract §2.2.4: one discipline for
 * every scope) — canonical form, forward-only, byte-exact reload.
 */

import { type AttemptRegister } from "@ecoma-io/release-craft/execution";

import { canonicalJson } from "@ecoma-io/release-craft/planner";

import { frozenParse } from "./freeze.js";
import { casAppendCommit, commitRecord, readRef } from "./git-refs.js";
import { GitFaultError, type GitRun } from "./git-run.js";
import { encodeRefComponent } from "./ledger-git.js";

/** The compare-and-swap budget: a lost race re-reads the tip and retries
 * this many rounds, then the binding fails closed. */
const MAX_CAS_ATTEMPTS = 3;

/** The ref holding a plan's ordinal counter (E-05) — one commit per
 * allocation, the counter's canonical JSON as the blob. */
const registerRef = (planId: string): string =>
  `refs/release-craft/register/${encodeRefComponent(planId)}`;

export class GitAttemptRegister implements AttemptRegister {
  readonly #git: GitRun;

  constructor(git: GitRun) {
    this.#git = git;
  }

  /** The plan's next 1-based attempt ordinal, allocated atomically — one
   * compare-and-swap accept decides. The counter starts absent (the
   * reference register's explicit initial state: nothing recorded, next
   * ordinal 1) and every allocation appends the incremented value as one
   * commit on the counter's stream. */
  nextOrdinal(planId: string): number {
    const ref = registerRef(planId);
    for (let round = 0; round < MAX_CAS_ATTEMPTS; round++) {
      const base = readRef(this.#git, ref);
      const next = (base === null ? 0 : this.#storedOrdinal(ref, base)) + 1;
      if (casAppendCommit(this.#git, ref, canonicalJson({ nextOrdinal: next }), base) !== null) {
        return next;
      }
    }
    throw new GitFaultError(
      ["update-ref", ref],
      null,
      `the ordinal allocation lost the compare-and-swap race ${String(MAX_CAS_ATTEMPTS)} times on ${ref} — the counter moved under every retry; failing closed rather than double-allocating (contract §2.2)`,
    );
  }

  /** The counter a tip holds, validated before use: anything that is not
   * `{"nextOrdinal":N}` is a corrupt counter — fail closed, never guess. */
  #storedOrdinal(ref: string, tip: string): number {
    // frozenParse hands back unknown; the guard re-earns the number from
    // the bytes before anything consumes them.
    const value = frozenParse(commitRecord(this.#git, tip));
    if (
      typeof value !== "object" ||
      value === null ||
      !("nextOrdinal" in value) ||
      typeof value.nextOrdinal !== "number" ||
      !Number.isInteger(value.nextOrdinal) ||
      value.nextOrdinal < 1
    ) {
      throw new GitFaultError(
        ["show", `${tip}:record`],
        null,
        `the ordinal counter at ${ref} does not hold {"nextOrdinal":N} — failing closed on a corrupt counter (contract §2.2)`,
      );
    }
    return value.nextOrdinal;
  }
}
