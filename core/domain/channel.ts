/**
 * The channel value — the mutable deliverability pointer, as a value.
 *
 * A `Channel` is a named pointer a consumer reads: which line, at which
 * released version, deliverable through this channel right now — or `null`
 * when the channel is hidden. It carries the current binding only: the event
 * log of moves is execution-side (PR-04's audited events, PR-05's timeline),
 * and repointing back to a prior target — a rollback — is the same
 * value-level operation as any move, because history is not stored here to
 * compare against. Backend bindings (an npm dist-tag, a container tag) are
 * adapters; the value names neither.
 *
 * The contract, per
 * [phase1-contracts.md](../../docs/design/phase1-contracts.md) under ADR-0001's
 * `Version` discipline and ADR-0002's vocabulary lock:
 *
 *   - **The target names a line and a version, never a branch, ref, pull
 *     request, or registry object**
 *     ([invariant 15](../../docs/design/release-model.md#architectural-invariants)):
 *     `line` is an opaque LineId and `version` a `Version` — there is no
 *     field here that could carry provider state, which is the invariant's
 *     kernel half made structural.
 *   - **A move is a new value** — `repoint` returns a fresh channel; hiding
 *     is `repoint(null)` (S-04/PR-04: rollback hides, never erases, and the
 *     erasure-or-not question never reaches the value).
 *   - **`pointsAt` is identity by value** — LineId string equality plus
 *     `Version#equals`, the one-point-in-time query PR-05's membership
 *     timeline asks; it is total, so anything is simply not pointed-at.
 *   - **Frozen deeply** — the instance and its target record are frozen at
 *     construction; every method returns a new value, never an in-place edit.
 */

import { Version } from "./version.js";

/**
 * What a channel points at: a LineId and the released version on that line.
 * Both fields are the whole target — whether a binding also names an artifact
 * is execution-side (registry channels are adapters).
 */
export interface ChannelTarget {
  readonly line: string;
  readonly version: Version;
}

/**
 * The only error the `Channel` doors raise, for every rejected input — a
 * blank or padded id, a malformed target, a target without a `Version`. The
 * full offending input travels on the error; the message carries a truncated
 * echo so a pathological input cannot bloat a log line.
 */
export class InvalidChannelError extends Error {
  /** The rejected input, verbatim — whatever the door was handed. */
  public readonly input: unknown;

  /** The machine-readable half of the rejection; the message is its prose form. */
  public readonly reason: string;

  public constructor(input: unknown, reason: string) {
    super(`invalid channel (${reason}): ${describe(input)}`);
    this.name = "InvalidChannelError";
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
 * Validates the channel id — presence and non-padding, that is all
 * (phase1-contracts design rule 4): the kernel never parses a channel id.
 * Padded input is rejected rather than trimmed — the door validates, it does
 * not normalize.
 */
function channelId(input: unknown): string {
  if (typeof input !== "string") {
    throw new InvalidChannelError(input, "a channel id must be a string");
  }
  if (input.trim() === "") {
    throw new InvalidChannelError(input, "a channel id is empty");
  }
  if (input.trim() !== input) {
    throw new InvalidChannelError(input, "a channel id carries leading or trailing whitespace");
  }
  return input;
}

/**
 * Validates a target into the frozen record the value stores: `null` passes
 * through (a hidden channel), anything else must be an object whose `line`
 * passes the opaque door and whose `version` is a `Version` — no other shape
 * could name what a channel points at (invariant 15).
 */
function targetFrom(input: unknown): ChannelTarget | null {
  if (input === null) {
    return null;
  }
  if (typeof input !== "object") {
    throw new InvalidChannelError(input, "a channel target must be an object or null");
  }
  const source = input as Record<string, unknown>;
  const version = source.version;
  if (!(version instanceof Version)) {
    throw new InvalidChannelError(input, "a channel target's version must be a Version value");
  }
  return Object.freeze({ line: targetLine(source.line), version });
}

/** Validates the target's line by the same opaque-string rule as the channel id. */
function targetLine(input: unknown): string {
  if (typeof input !== "string") {
    throw new InvalidChannelError(input, "a channel target's line must be a string");
  }
  if (input.trim() === "") {
    throw new InvalidChannelError(input, "a channel target's line is empty");
  }
  if (input.trim() !== input) {
    throw new InvalidChannelError(
      input,
      "a channel target's line carries leading or trailing whitespace",
    );
  }
  return input;
}

/**
 * The channel value itself. Construct it through {@link Channel.create} or
 * {@link Channel.of}; the constructor is private so no unvalidated state can
 * be instantiated, not even from inside the module by accident.
 */
export class Channel {
  /** The channel's own stable identity — never a ref name (invariant 7). */
  public readonly id: string;

  /** What the channel currently points at, or `null` when hidden. */
  public readonly target: ChannelTarget | null;

  private constructor(id: string, target: ChannelTarget | null) {
    this.id = id;
    this.target = target;
    // Frozen before any subclass body runs, exactly as Version is: an
    // immutable value a subclass could mutate is not immutable.
    Object.freeze(this);
  }

  /**
   * A new channel with no binding: `target` is `null` — hidden/empty is a
   * first-class state (S-04), not an absence of value.
   */
  public static create(id: string): Channel {
    return new Channel(channelId(id), null);
  }

  /**
   * A channel with a binding supplied whole. The id passes the opaque door;
   * a non-null target must carry an opaque `line` and a `Version` — anything
   * else throws {@link InvalidChannelError} carrying the offending input.
   */
  public static of(id: string, target: ChannelTarget | null): Channel {
    return new Channel(channelId(id), targetFrom(target));
  }

  /**
   * Moves the channel — or hides it with `null` — as a new value. The same
   * validation as {@link Channel.of} applies to the incoming target; the
   * receiver is never edited, so a rollback is indistinguishable from any
   * other move at this layer, by design (PR-04: the audit lives above).
   */
  public repoint(target: ChannelTarget | null): Channel {
    return new Channel(this.id, targetFrom(target));
  }

  /**
   * Whether the channel currently points at this (line, version), by value:
   * LineId string equality plus `Version#equals`. A hidden channel points at
   * nothing, and an unknown target is simply not pointed-at — queries are
   * total, only doors throw.
   */
  public pointsAt(line: string, version: Version): boolean {
    return this.target !== null && this.target.line === line && this.target.version.equals(version);
  }

  /** Structural equality over the id and the target (line and version by value). */
  public equals(that: Channel): boolean {
    return (
      this.id === that.id &&
      (this.target === null
        ? that.target === null
        : that.target !== null &&
          this.target.line === that.target.line &&
          this.target.version.equals(that.target.version))
    );
  }
}
