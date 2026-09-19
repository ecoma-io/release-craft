/**
 * The Release-PR gate's durable record sink (issue #288): the git-backed
 * reference implementation of `ReleasePRRecordSink` — each record lands
 * as one compare-and-swap commit of its canonical JSON on a ref per
 * (identity, plan) sequence, the write-ahead discipline ADR-0006 gives
 * every execution half. A `gate-start` survives a crash, a fresh binding
 * re-reads the same tail, and a lost compare-and-swap race is a pure
 * extension of the recorded history or nothing at all — forward-only,
 * exactly as the ledger's own stream is.
 *
 * The file lives in the package shell, beside `release-pr-driver.js`,
 * where `type-package`'s boundary row reaches both the app layer and the
 * git binding: a `git *` sink cannot live in the app barrel — the
 * surface contract (obligation 2, `test/app/surface.test.ts`) is doors
 * and records, never a store, and its package front door must not carry
 * provider vocabulary (invariant 15, `test/provider-isolation.test.ts`:
 * `ref` among the tokens) — and it cannot live in the git binding, whose
 * row reaches never toward the surface: a git-bound sink would need to
 * import the app's `ReleasePRRecord` vocabulary, a reversed edge (ADR-
 * 0001; module-boundaries.config.mjs). The shell imports the app
 * barrel's types and the git barrel's CAS primitives instead and
 * assembles the sink behind the same factory discipline (ADR-0009
 * decision 8), exported through the front door so the production caller
 * names it — the driver's required sink argument (issue #309; the
 * caller passes `new GitReleasePRRecordSink(repo)`).
 *
 * The ref derivation stays module-private: the stream's ref name is an
 * implementation seam, and the package's public surface refuses the
 * provider vocabulary it would need to name it (`ref`). Callers that
 * must name a stream (the hostile-race test) replicate the derivation
 * from the two public primitives it composes.
 */
import {
  GitFaultError,
  casAppendCommit,
  commitRecord,
  deepFreeze,
  encodeRefComponent,
  firstParentHistory,
  frozenParse,
  openGitRun,
  readRef,
  type GitRun,
} from "@ecoma-io/release-craft/adapters/git";
import { canonicalJson } from "@ecoma-io/release-craft/planner";
import {
  type ReleasePRRecord,
  type ReleasePRRecordSink,
  type ReleasePRIdentity,
} from "@ecoma-io/release-craft/app";

/** The compare-and-swap budget: a lost race re-reads the tip,
 * re-classifies, and retries this many rounds, then the sink fails
 * closed — the ledger's own discipline, applied to the gate's streams. */
const MAX_CAS_ATTEMPTS = 3;

/** The gate's record-stream namespace: one ref per (identity, plan)
 * sequence. The ref must be stable across bindings, reloads, and crash
 * windows — the key is the canonical JSON of the tuple, same as the
 * ledger's id-keyed refs, percent-encoded into a refname. */
const RELEASE_PR_REF_NAMESPACE = "refs/release-craft/release-pr/";

/** The ref holding an (identity, plan) release-PR record stream — one
 * commit per record, the record's canonical JSON as the blob (contract
 * §2.2's reference mapping, applied to the gate's own family). */
const releasePRRecordRef = (identity: ReleasePRIdentity, planId: string): string =>
  `${RELEASE_PR_REF_NAMESPACE}${encodeRefComponent(canonicalJson({ identity, planId }))}`;

/** The git-backed release-PR record sink (issue #288): append-only, deep-
 * frozen on append, ordered by insertion across crashes — a fresh binding
 * on the same repository re-reads the same tail from the ref, and every
 * append is a pure extension of the recorded history or fails closed. */
export class GitReleasePRRecordSink implements ReleasePRRecordSink {
  readonly #git: GitRun;

  /** The reconstructed tails, keyed by ref and by the tip they walked —
   * the ledger's own cache discipline: the ref is read on every `tail`
   * call, the recorded commits are re-read only when the tip moved, and
   * an entry the sink's own winning append extended is extended in
   * place; anything else is dropped, so a history that raced a
   * concurrent winner is never served. */
  readonly #tails: Map<
    string,
    { readonly tip: string | null; readonly records: readonly ReleasePRRecord[] }
  > = new Map();

  /** Open the sink over the repository at `repo`. The `git` runner is
   * injectable for tests that race the ref under a hostile runner; the
   * production call names only the repository. */
  constructor(repo: string, git: GitRun = openGitRun(repo)) {
    this.#git = git;
  }

  /** Append, persist, freeze. The record lands as one compare-and-swap
   * commit on its (identity, plan) stream — a pure extension of the
   * recorded history or nothing at all — and the classification is
   * content-aware (the ledger's issue #185/D44 discipline): bytes the
   * stream's current tip already holds satisfy the write before any
   * commit is built, so a re-issued record of an already-landed write
   * never duplicates; records differing in any field are different
   * facts and land. A winning append extends the walked tail it built
   * on, so the next read of this stream does not re-read what it just
   * wrote. */
  append(record: ReleasePRRecord): ReleasePRRecord {
    const ref = releasePRRecordRef(record.identity, record.planId);
    const bytes = canonicalJson(record);
    this.#casAppend(
      ref,
      () => (this.#carries(record.identity, record.planId, bytes) ? null : bytes),
      (base, tip) => {
        this.#cacheAppend(ref, base, tip, bytes);
      },
    );
    return deepFreeze(record) as ReleasePRRecord;
  }

  /** All of the (identity, plan) sequence's records, append order — the
   * crash window's read path, reconstructed from the ref's tip by
   * walking the first-parent history (contract §2.2's read path). Every
   * record arrives deep-frozen — `frozenParse` froze it on the way out
   * of the repository. */
  tail(identity: ReleasePRIdentity, planId: string): readonly ReleasePRRecord[] {
    const ref = releasePRRecordRef(identity, planId);
    const cached = this.#tails.get(ref);
    const tip = readRef(this.#git, ref);
    if (cached !== undefined && cached.tip === tip) {
      return deepFreeze([...cached.records]) as readonly ReleasePRRecord[];
    }
    const commits = firstParentHistory(this.#git, ref);
    const records = commits.map(
      (commit) => frozenParse(commitRecord(this.#git, commit)) as ReleasePRRecord,
    );
    // The cache keys on the tip the walk itself saw — the history's own
    // last commit, not the probe above — so a ref that moves inside the
    // read window keys the entry to the history it truly holds.
    this.#tails.set(ref, { tip: commits.at(-1) ?? null, records });
    return deepFreeze(records) as readonly ReleasePRRecord[];
  }

  /** Whether the stream's current tip already holds exactly these
   * canonical bytes — the content-aware half of the append's identity
   * (ledger issue #185; D44): absorbs the stale writer's duplicate of a
   * concurrent winner's record, re-evaluated against the moved tip every
   * compare-and-swap round. */
  #carries(identity: ReleasePRIdentity, planId: string, bytes: string): boolean {
    const last = this.tail(identity, planId).at(-1);
    return last !== undefined && canonicalJson(last) === bytes;
  }

  /** Extends the walked tail the cache holds when it is exactly the
   * history `base` names — the state the append was classified against
   * and extended — and drops it otherwise: the next tail re-walks from
   * the ref, never serving a history the cache does not hold. The
   * appended record joins as `frozenParse` of the very bytes the commit
   * carries, so the cached tail is byte-identical to a fresh walk. */
  #cacheAppend(ref: string, base: string | null, tip: string, bytes: string): void {
    const cached = this.#tails.get(ref);
    if (cached === undefined || cached.tip !== base) {
      this.#tails.delete(ref);
      return;
    }
    this.#tails.set(ref, {
      tip,
      records: [...cached.records, frozenParse(bytes) as ReleasePRRecord],
    });
  }

  /** The one write door every stream shares — the ledger's own wheel,
   * re-spoked for the gate's records: classify against the stream's
   * current tip, then append one compare-and-swap commit built on that
   * tip. A lost race re-reads the tip, re-classifies, and retries —
   * `MAX_CAS_ATTEMPTS` rounds, then the sink fails closed: the recorded
   * history moved under every retry, and appending anyway would diverge
   * it. A null classification ends the loop with nothing written. */
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
      `the release-PR record append lost the compare-and-swap race ${String(MAX_CAS_ATTEMPTS)} times on ${ref} — the recorded stream moved under every retry; failing closed rather than diverging it (ADR-0006)`,
    );
  }
}
