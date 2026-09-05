/**
 * The change value — the atomic unit of release work, identified for transport.
 *
 * A `Change` is the kernel's record of one logical piece of work: an opaque id
 * that stays stable across lines, cherry-picks and reformatting, plus the
 * lineage that says where it came from. It is a record, not a resolver — it
 * never parses its ids, never dereferences a sha, and never links `parent` to
 * any other value it can see. What produces the ids (the change-id marker
 * convention, open fork 8) is adapter-side; what releases a change on which
 * line is planning policy. Neither lives here.
 *
 * The contract, per
 * [phase1-contracts.md](../../docs/design/phase1-contracts.md) under ADR-0001's
 * `Version` discipline and ADR-0002's vocabulary lock:
 *
 *   - **Identity is the id, nothing else** — `sameIdentity` compares ids alone,
 *     so one logical fix on three lines is one change (M-03) even where each
 *     copy carries a different lineage (M-05: same identity, divergent
 *     descriptors — both facts are kept, one identity).
 *   - **Identity is never derived** from content, shas, or hashes
 *     ([invariant 9](../../docs/design/release-model.md#architectural-invariants)):
 *     there is no field here that could compute one, and no fuzzy matching is
 *     admitted (M-05).
 *   - **Lineage is recorded, not resolved** — `parent`, `originCommit` and
 *     `originLine` are opaque strings when present; the kernel imposes no
 *     structural constraint between them. Resolving a lineage is planning's
 *     business.
 *   - **`equals` is structural** over id plus the recorded lineage fields;
 *     `sameIdentity` is the coarser transport relation. Two changes with one
 *     id and different lineages are equal in identity, unequal as records —
 *     the conflicting-backport case a planner must surface (M-05), not hide.
 *   - **Opaque strings stay opaque** — ids and lineage fields are non-empty
 *     strings without surrounding whitespace, stored verbatim, never
 *     normalized: a value that arrives padded is a data error this door
 *     rejects, not one it silently trims.
 *   - **Frozen deeply** — the instance and its lineage record are frozen at
 *     construction; no method mutates the receiver.
 */

/**
 * The only error the `Change` doors raise, for every rejected input — a
 * non-string or blank id, a malformed lineage, a wrong type reaching the API
 * at all. The full offending input travels on the error; the message carries a
 * truncated echo so a pathological input cannot bloat a log line.
 */
export class InvalidChangeError extends Error {
  /** The rejected input, verbatim — whatever the door was handed. */
  public readonly input: unknown;

  /** The machine-readable half of the rejection; the message is its prose form. */
  public readonly reason: string;

  public constructor(input: unknown, reason: string) {
    super(`invalid change (${reason}): ${describe(input)}`);
    this.name = "InvalidChangeError";
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
 * Validates one opaque string — a change id or a lineage field. Presence and
 * non-padding, that is all (phase1-contracts design rule 4): the kernel never
 * patterns, parses, or dereferences these strings, so no shape rule could be
 * honest here. Padded input is rejected rather than trimmed — the door
 * validates, it does not normalize.
 */
function opaque(input: unknown, field: string): string {
  if (typeof input !== "string") {
    throw new InvalidChangeError(input, `the change ${field} must be a string`);
  }
  if (input.trim() === "") {
    throw new InvalidChangeError(input, `the change ${field} is empty`);
  }
  if (input.trim() !== input) {
    throw new InvalidChangeError(
      input,
      `the change ${field} carries leading or trailing whitespace`,
    );
  }
  return input;
}

/**
 * Where a change came from, as the adapter observed it. Every field is
 * optional and opaque: `parent` names the ChangeId this one derives from
 * (F″→F′→F across a cherry-pick chain), `originCommit` the sha where it
 * originated, `originLine` the LineId it originated on when that is known.
 * The kernel records them; it never walks them.
 */
export interface ChangeLineage {
  readonly parent?: string;
  readonly originCommit?: string;
  readonly originLine?: string;
}

/**
 * The change value itself. Construct it through {@link Change.of}; the
 * constructor is private so no unvalidated state can be instantiated, not
 * even from inside the module by accident.
 */
export class Change {
  /** The transport-stable identity — opaque, never derived from content. */
  public readonly id: string;

  /** Where this change came from; frozen, fields present only when supplied. */
  public readonly lineage: ChangeLineage;

  private constructor(id: string, lineage: ChangeLineage) {
    this.id = id;
    this.lineage = lineage;
    // Frozen before any subclass body runs, exactly as Version is: an
    // immutable value a subclass could mutate is not immutable.
    Object.freeze(this);
  }

  /**
   * The one door into a `Change`: an id plus, optionally, the lineage the
   * adapter observed. Everything is validated — a blank id, a padded field, a
   * non-object lineage, or a non-string lineage field throws
   * {@link InvalidChangeError} carrying the offending input.
   */
  public static of(id: string, lineage?: ChangeLineage): Change {
    return new Change(opaque(id, "id"), lineageFrom(lineage));
  }

  /**
   * Transport identity: the ids alone. One logical fix on three lines is one
   * change (M-03); the same id with divergent lineage is the
   * conflicting-backport fact a planner surfaces (M-05) — this relation says
   * "same change" regardless.
   */
  public sameIdentity(that: Change): boolean {
    return this.id === that.id;
  }

  /** Structural equality over the id and the recorded lineage fields. */
  public equals(that: Change): boolean {
    return this.id === that.id && sameLineage(this.lineage, that.lineage);
  }
}

/**
 * Validates a lineage into the frozen record the value stores: absent means
 * `{}`, anything else must be an object whose present fields pass the opaque
 * door. Only the declared fields are recorded — the value keeps the
 * vocabulary, not whatever else the caller's object happened to carry.
 */
function lineageFrom(input: unknown): ChangeLineage {
  if (input === undefined) {
    return Object.freeze({});
  }
  if (typeof input !== "object" || input === null) {
    throw new InvalidChangeError(input, "a change lineage must be an object");
  }
  const source = input as Record<string, unknown>;
  // Built mutably, frozen at the end: present fields only, so an absent field
  // is absent on the record, never present-and-undefined.
  const record: { parent?: string; originCommit?: string; originLine?: string } = {};
  if (source.parent !== undefined) {
    record.parent = opaque(source.parent, "lineage parent");
  }
  if (source.originCommit !== undefined) {
    record.originCommit = opaque(source.originCommit, "lineage originCommit");
  }
  if (source.originLine !== undefined) {
    record.originLine = opaque(source.originLine, "lineage originLine");
  }
  return Object.freeze(record);
}

/** Structural lineage equality: present fields pairwise identical. */
function sameLineage(a: ChangeLineage, b: ChangeLineage): boolean {
  return (
    a.parent === b.parent && a.originCommit === b.originCommit && a.originLine === b.originLine
  );
}
