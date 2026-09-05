/**
 * The change set value — an enumerated group and the bump it implies — plus
 * `Bump`, the version-semantics vocabulary the group carries.
 *
 * A `ChangeSet` is what a release instantiates: an enumerated group of
 * {@link Change} values, deduplicated by identity, with the bump level it
 * implies recorded verbatim. The group is a set by identity — one logical fix
 * is one member, however many lines it landed on (M-03) — and the bump is
 * decided upstream: a `Change` carries no bump, because the commit-type
 * mapping (`feat`→minor, `fix`→patch, breaking→major) is planning policy
 * (ADR-0002), not value semantics. The planner computes the level from its
 * own policy; this value carries it, frozen.
 *
 * The contract, per
 * [phase1-contracts.md](../../docs/design/phase1-contracts.md) under ADR-0001's
 * `Version` discipline and ADR-0002's vocabulary lock:
 *
 *   - **The bump is supplied and recorded verbatim** — `of(changes, bump)`
 *     never recomputes, defaults, or clamps the level; `empty()` is
 *     `of([], "patch")` because an empty group implies the least it can
 *     (PL-06: empty is a result, not an absence).
 *   - **Identity-uniqueness is enforced at the door** — two members with the
 *     same id make the whole construction throw: the triple-count failure
 *     (M-03) is unrepresentable at the value level. Same id with different
 *     lineage is still one identity — that conflict is a planning fact to
 *     surface there, not two entries here.
 *   - **Equality is order-insensitive** — the group is a set by identity, so
 *     `equals` compares identity sets and the bump, never entry order.
 *   - **Frozen deeply** — the instance and the member array are frozen at
 *     construction; no method mutates the receiver.
 */

import { Change } from "./change.js";

/**
 * The bump level a change set implies: which component of a version the
 * release moves. Not one of the five kernel values — it is the vocabulary
 * `ChangeSet` needs, expressed over `Version`'s existing
 * `bumpMajor`/`bumpMinor`/`bumpPatch`; `Version#apply(bump)` is deliberately
 * not added, because a switch there would duplicate the three methods it
 * dispatches to.
 */
export type Bump = "major" | "minor" | "patch";

/**
 * Each level's ordinal for comparison — `0` patch < `1` minor < `2` major.
 * Frozen: the ordering is part of the vocabulary, not data a caller can move.
 */
export const BUMP_LEVEL: Readonly<Record<Bump, number>> = Object.freeze({
  major: 2,
  minor: 1,
  patch: 0,
});

/**
 * The operations over bump levels. Combining already-decided levels is value
 * semantics, so it lives here; deciding a level from commit types — the
 * Conventional-Commits mapping — is planning/adapter policy and does not.
 */
export const Bump = Object.freeze({
  /**
   * The higher of two levels, total over the declared domain: combining a
   * patch and a minor yields the minor. Arguments outside `Bump` are a type
   * error the caller owns — the closed domain has no representation to
   * validate them into.
   */
  max(a: Bump, b: Bump): Bump {
    return BUMP_LEVEL[a] < BUMP_LEVEL[b] ? b : a;
  },
});

/**
 * The only error the `ChangeSet` doors raise, for every rejected input — a
 * non-array `changes`, a member that is not a `Change`, a bump outside the
 * three levels, or two members sharing one identity. The full offending input
 * travels on the error; the message carries a truncated echo so a
 * pathological input cannot bloat a log line.
 */
export class InvalidChangeSetError extends Error {
  /** The rejected input, verbatim — the argument the reason is about. */
  public readonly input: unknown;

  /** The machine-readable half of the rejection; the message is its prose form. */
  public readonly reason: string;

  public constructor(input: unknown, reason: string) {
    super(`invalid change set (${reason}): ${describe(input)}`);
    this.name = "InvalidChangeSetError";
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
 * Validates a bump at the door. The level is decided upstream, so a wrong one
 * here is a broken caller, not policy to second-guess — it throws rather than
 * being coerced to the nearest level.
 */
function bumpLevel(input: unknown): Bump {
  if (input === "major" || input === "minor" || input === "patch") {
    return input;
  }
  throw new InvalidChangeSetError(
    input,
    'a change set bump must be one of "major", "minor" or "patch"',
  );
}

/**
 * The change set value itself. Construct it through {@link ChangeSet.of} or
 * {@link ChangeSet.empty}; the constructor is private so no unvalidated state
 * can be instantiated, not even from inside the module by accident.
 */
export class ChangeSet {
  /** The enumerated members, frozen; uniqueness by identity is proven at the door. */
  public readonly changes: readonly Change[];

  /** The level this group implies, exactly as decided upstream — never recomputed here. */
  public readonly bump: Bump;

  private constructor(changes: readonly Change[], bump: Bump) {
    this.changes = Object.freeze([...changes]);
    this.bump = bump;
    // Frozen before any subclass body runs, exactly as Version is: an
    // immutable value a subclass could mutate is not immutable.
    Object.freeze(this);
  }

  /**
   * The one door into a `ChangeSet`: the enumerated members plus the bump the
   * planner decided they imply. Every member must be a `Change`, no two may
   * share an identity, and the bump must be one of the three levels — each
   * rejection throws {@link InvalidChangeSetError} carrying the full
   * `changes` array or the offending bump.
   */
  public static of(changes: readonly Change[], bump: Bump): ChangeSet {
    if (!Array.isArray(changes)) {
      throw new InvalidChangeSetError(changes, "a change set's changes must be an array");
    }
    const level = bumpLevel(bump);
    const seen = new Set<string>();
    for (const change of changes) {
      if (!(change instanceof Change)) {
        throw new InvalidChangeSetError(
          changes,
          "every member of a change set must be a Change value",
        );
      }
      if (seen.has(change.id)) {
        // One logical fix is one member (M-03): the triple-count failure is
        // made unrepresentable rather than detected later.
        throw new InvalidChangeSetError(
          changes,
          `two members share the change id "${change.id}" — one identity is one member`,
        );
      }
      seen.add(change.id);
    }
    return new ChangeSet(changes, level);
  }

  /**
   * The empty group — a result in its own right (PL-06). Its bump is
   * `"patch"` as the neutral element of `Bump.max`: the least level, raised
   * by any real member. What an empty group implies — a recorded no-op, a
   * withheld release (S-01: the latent version is minted nowhere) — is the
   * planner's decision to make; the value records the neutral level and
   * nothing more.
   */
  public static empty(): ChangeSet {
    return ChangeSet.of([], "patch");
  }

  /**
   * Whether a change with this id is a member. A presence query is total: an
   * unknown or malformed id is simply absent, never an error.
   */
  public includesIdentity(id: string): boolean {
    return this.changes.some((change) => change.id === id);
  }

  /**
   * Order-insensitive equality: the same identity set and the same bump. The
   * group is a set by identity — entry order carries no meaning a release
   * could observe.
   */
  public equals(that: ChangeSet): boolean {
    return (
      this.bump === that.bump &&
      this.changes.length === that.changes.length &&
      this.changes.every((change) => that.changes.some((other) => other.sameIdentity(change)))
    );
  }
}
