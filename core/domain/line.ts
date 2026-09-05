/**
 * The release line value — the ordered stream of versions, identified by
 * itself.
 *
 * A `ReleaseLine` is a durable id, a released-version pointer, the prerelease
 * stream state keyed to it, and a lifecycle — nothing else. It has no branch
 * field and no feed mapping: a line is fed by branches through recorded feed
 * mappings that are planning-side data (ADR-0002, amendment A5), so renaming a
 * feed branch cannot touch line identity — the absence of the field is what
 * [invariant 7](../../docs/design/release-model.md#architectural-invariants)
 * proves. Choosing what a line releases next, and which stream advances, is
 * policy outside this file; the arithmetic over already-recorded state is
 * value semantics and lives here.
 *
 * The contract, per
 * [phase1-contracts.md](../../docs/design/phase1-contracts.md) under ADR-0001's
 * `Version` discipline and ADR-0002's vocabulary lock:
 *
 *   - **The released pointer is monotonic per line** — `withReleased` accepts
 *     only a version that advances beyond the current pointer; equal or lower
 *     throws. Equal-version re-release on one line is a conflict the value
 *     refuses to represent (M-11/E-11 are per-line facts). The guard is
 *     monotonicity only: whether the pointer may ever hold a prerelease is
 *     policy the value does not re-check — prerelease deliverability runs
 *     through stream state, not the pointer.
 *   - **Streams are keyed by (target, identifier), carried as state**
 *     ([invariant 8](../../docs/design/release-model.md#architectural-invariants))
 *     — `advanceStream` computes that key's `sequence + 1`, seeded at `0`
 *     when absent: `alpha.9` → `alpha.10` is numeric, never lexicographic
 *     (P-01), and a `feat` mid-RC bumps the sequence (P-04). A different
 *     target under the same identifier is a new key at `0` — no cross-target
 *     continuation when the target moves under you (P-05). Keys compare by
 *     `Version#equals`; ordering is `Version#compare`, never a string sort.
 *   - **`streamVersion` composes** the recorded state through
 *     `Version.parse` — `target` + `-identifier.sequence` as a value (P-06:
 *     two streams, one target, both expressible; P-02: the ladder is
 *     per-identifier). A stream key that cannot compose — an identifier or
 *     target whose suffix is not a valid prerelease grammar — surfaces
 *     `Version`'s own typed rejection; the composition is `Version.parse`'s
 *     door, and this value adds no silent fallback beside it.
 *   - **Lifecycle transitions are total and validated** — the matrix is
 *     `active → frozen | retired`, `frozen → retired`, `retired` terminal;
 *     anything else throws (M-10: retirement is a state, not deletion).
 *     Mutating methods on a retired line throw; a frozen line may still
 *     record releases and advance streams — whether policy ever exercises
 *     that is policy's business, and only retirement is terminal.
 *   - **Frozen deeply** — the instance, the stream array, and every stream
 *     record are frozen at construction; every method returns a new value or
 *     throws, never an in-place edit.
 */

import { Version } from "./version.js";

/**
 * The line lifecycle states. `retired` is terminal: a retired line stays in
 * existence as recorded state (M-10) — deletion, like creation policy, is not
 * a value operation.
 */
export type LineLifecycle = "active" | "frozen" | "retired";

/**
 * The recorded head of one prerelease stream: which target it runs toward,
 * under which opaque identifier, at which position of the numeric sequence
 * (`≥ 0`). The triple (line, target, identifier) is the stream's identity
 * ([invariant 8](../../docs/design/release-model.md#architectural-invariants));
 * "prerelease stream" as a planning concept names the planner's view over
 * this state, not a second home.
 */
export interface PrereleaseStreamState {
  readonly target: Version;
  readonly identifier: string;
  readonly sequence: number;
}

/**
 * The one error the `ReleaseLine` doors raise — refused transitions and
 * rejected inputs alike, one error class per value
 * (phase1-contracts design rule 5). The full offending input travels on the
 * error — the argument a rejection is about, or the line whose state refuses
 * the operation; the message carries a truncated echo so a pathological input
 * cannot bloat a log line.
 */
export class InvalidLineTransitionError extends Error {
  /** The rejected input, verbatim — the offending argument, or the refusing line. */
  public readonly input: unknown;

  /** The machine-readable half of the rejection; the message is its prose form. */
  public readonly reason: string;

  public constructor(input: unknown, reason: string) {
    super(`invalid release line (${reason}): ${describe(input)}`);
    this.name = "InvalidLineTransitionError";
    this.input = input;
    this.reason = reason;
  }
}

/** A short, bounded echo of the rejected input for the error message. */
function describe(input: unknown): string {
  if (typeof input !== "string") {
    return `a ${input === null ? "null" : typeof input} value`;
  }
  const echo = input.length > 64 ? `${input.slice(0, 64)}…` : input;
  return JSON.stringify(echo);
}

/**
 * Validates the line id — presence and non-padding, that is all
 * (phase1-contracts design rule 4): the kernel never parses or patterns a
 * LineId. Padded input is rejected rather than trimmed — the door validates,
 * it does not normalize.
 */
function lineId(input: unknown): string {
  if (typeof input !== "string") {
    throw new InvalidLineTransitionError(input, "a release line id must be a string");
  }
  if (input.trim() === "") {
    throw new InvalidLineTransitionError(input, "a release line id is empty");
  }
  if (input.trim() !== input) {
    throw new InvalidLineTransitionError(
      input,
      "a release line id carries leading or trailing whitespace",
    );
  }
  return input;
}

/** Validates a stream identifier by the same opaque-string rule as the line id. */
function streamIdentifier(input: unknown): string {
  if (typeof input !== "string") {
    throw new InvalidLineTransitionError(input, "a stream identifier must be a string");
  }
  if (input.trim() === "") {
    throw new InvalidLineTransitionError(input, "a stream identifier is empty");
  }
  if (input.trim() !== input) {
    throw new InvalidLineTransitionError(
      input,
      "a stream identifier carries leading or trailing whitespace",
    );
  }
  return input;
}

/**
 * The release line value itself. Construct it through
 * {@link ReleaseLine.create}; the constructor is private so no unvalidated
 * state can be instantiated, not even from inside the module by accident.
 */
export class ReleaseLine {
  /** The line's own stable identity — never a ref name (invariant 7). */
  public readonly id: string;

  /** Where the line stands; `retired` refuses every mutation. */
  public readonly lifecycle: LineLifecycle;

  /** The released-version pointer — `null` until the line's first release. */
  public readonly released: Version | null;

  /** The prerelease stream state, frozen, keyed by (target, identifier). */
  public readonly streams: readonly PrereleaseStreamState[];

  private constructor(
    id: string,
    lifecycle: LineLifecycle,
    released: Version | null,
    streams: readonly PrereleaseStreamState[],
  ) {
    this.id = id;
    this.lifecycle = lifecycle;
    this.released = released;
    // Fresh frozen copies per instance, exactly as Version's identifier
    // arrays are: no two lines ever share a mutable (or a shared-frozen)
    // stream record.
    this.streams = Object.freeze(
      streams.map((state) =>
        Object.freeze({
          target: state.target,
          identifier: state.identifier,
          sequence: state.sequence,
        }),
      ),
    );
    // Frozen before any subclass body runs, exactly as Version is: an
    // immutable value a subclass could mutate is not immutable.
    Object.freeze(this);
  }

  /**
   * The one door into a new line: an id, `active`, no releases, no streams.
   * Everything a line becomes afterwards arrives through the methods below,
   * each of which returns a new value.
   */
  public static create(id: string): ReleaseLine {
    return new ReleaseLine(lineId(id), "active", null, []);
  }

  /**
   * Records a release on the line, as a new value. The version must advance
   * beyond the current pointer — equal or lower throws
   * {@link InvalidLineTransitionError}: re-releasing one version on one line
   * is a conflict the value refuses to represent (M-11/E-11 are per-line
   * facts). On a retired line the call throws outright.
   */
  public withReleased(version: Version): ReleaseLine {
    this.#requireMutable("recording a release");
    if (!(version instanceof Version)) {
      throw new InvalidLineTransitionError(version, "a released version must be a Version value");
    }
    if (this.released !== null && version.compare(this.released) <= 0) {
      throw new InvalidLineTransitionError(
        version,
        `the released pointer is monotonic per line — ${version.toString()} does not advance beyond ${this.released.toString()}`,
      );
    }
    return new ReleaseLine(this.id, this.lifecycle, version, this.streams);
  }

  /**
   * Advances one prerelease stream by a step, as a new value: the stream keyed
   * by (`target`, `identifier`) moves to `sequence + 1`, or is seeded at `0`
   * when the key is absent — a moved target starts a new key, never a
   * continuation of the old sequence (P-05). The arithmetic is value
   * semantics; which stream to advance, and when, is line/channel policy that
   * lives outside this file. On a retired line the call throws outright.
   */
  public advanceStream(target: Version, identifier: string): ReleaseLine {
    this.#requireMutable("advancing a prerelease stream");
    if (!(target instanceof Version)) {
      throw new InvalidLineTransitionError(target, "a stream target must be a Version value");
    }
    const name = streamIdentifier(identifier);
    const streams = [...this.streams];
    for (let index = 0; index < streams.length; index += 1) {
      const state = streams[index];
      if (state !== undefined && state.identifier === name && state.target.equals(target)) {
        streams[index] = { target, identifier: name, sequence: state.sequence + 1 };
        return new ReleaseLine(this.id, this.lifecycle, this.released, streams);
      }
    }
    streams.push({ target, identifier: name, sequence: 0 });
    return new ReleaseLine(this.id, this.lifecycle, this.released, streams);
  }

  /**
   * The stream's current version as a value, or `null` when the
   * (target, identifier) key is not on the line: the recorded state composed
   * through `Version.parse` as `target` + `-identifier.sequence`. Two streams
   * under one target are both expressible (P-06); the ladder is
   * per-identifier (P-02).
   */
  public streamVersion(target: Version, identifier: string): Version | null {
    const state = this.#stream(target, identifier);
    if (state === null) {
      return null;
    }
    return Version.parse(
      `${state.target.toString()}-${state.identifier}.${state.sequence.toString()}`,
    );
  }

  /**
   * Freezes the line, as a new value: `active → frozen`. Freezing ends the
   * active intake a lifecycle names; it does not end releases — only
   * retirement is terminal.
   */
  public freeze(): ReleaseLine {
    return this.#transition("frozen");
  }

  /**
   * Retires the line, as a new value: `active → retired` or
   * `frozen → retired`. Retirement is a state, not deletion (M-10) — the
   * retired line persists as recorded state and refuses every mutation.
   */
  public retire(): ReleaseLine {
    return this.#transition("retired");
  }

  /**
   * Structural equality over id, lifecycle, released (by `Version#equals`),
   * and the stream set keyed by (target, identifier) — the set, not the array
   * order: no release could observe stream ordering.
   */
  public equals(that: ReleaseLine): boolean {
    return (
      this.id === that.id &&
      this.lifecycle === that.lifecycle &&
      (this.released === null
        ? that.released === null
        : that.released !== null && this.released.equals(that.released)) &&
      sameStreams(this.streams, that.streams)
    );
  }

  /** The recorded state for one (target, identifier) key, or `null` when absent. */
  #stream(target: Version, identifier: string): PrereleaseStreamState | null {
    for (const state of this.streams) {
      if (state.identifier === identifier && state.target.equals(target)) {
        return state;
      }
    }
    return null;
  }

  /**
   * Refuses every mutating operation on a retired line: retirement is
   * terminal, and the value keeps the line as state rather than letting it
   * drift (M-10).
   */
  #requireMutable(action: string): void {
    if (this.lifecycle === "retired") {
      throw new InvalidLineTransitionError(
        this,
        `retirement is terminal — ${action} on a retired line is refused`,
      );
    }
  }

  /** Applies one lifecycle transition, validated against the matrix above. */
  #transition(to: "frozen" | "retired"): ReleaseLine {
    if (this.lifecycle === "retired" || (this.lifecycle === "frozen" && to === "frozen")) {
      throw new InvalidLineTransitionError(
        this,
        `a ${this.lifecycle} line cannot become ${to} — the matrix is active → frozen | retired, frozen → retired, retired terminal`,
      );
    }
    return new ReleaseLine(this.id, to, this.released, this.streams);
  }
}

/** Stream-set equality: same key set, same sequence at each key. */
function sameStreams(
  a: readonly PrereleaseStreamState[],
  b: readonly PrereleaseStreamState[],
): boolean {
  return (
    a.length === b.length &&
    a.every((state) =>
      b.some(
        (other) =>
          state.identifier === other.identifier &&
          state.target.equals(other.target) &&
          state.sequence === other.sequence,
      ),
    )
  );
}
