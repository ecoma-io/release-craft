/**
 * The artifact value — one publishable output, identified by digest.
 *
 * An `Artifact` is the kernel's record of one publishable thing: an opaque
 * kind (`"npm"`, `"container"`, …), opaque coordinates that label where the
 * thing lives (`"ghcr.io/x/app:2.0.0"`, …), and an opaque digest that is the
 * thing's content identity. The triple is the whole value. It says nothing
 * about validity — validation results with freshness (PR-03) are
 * execution-side evidence bundles bound to digests — and nothing about
 * generations: a deliberate rebuild under one version name is a new
 * generation recorded execution-side over digest records, not a field here
 * (PR-02).
 *
 * The contract, per
 * [phase1-contracts.md](../../docs/design/phase1-contracts.md) under ADR-0001's
 * `Version` discipline and ADR-0002's vocabulary lock:
 *
 *   - **Content identity is the digest** — `sameContent` compares digests
 *     alone, so promoting without rebuild is pointing at the same content
 *     whatever the coordinates say (PR-01), and two artifacts at one set of
 *     coordinates with different digests are different content.
 *   - **Coordinates are labels, never references** (AR-03) — the artifact
 *     version scheme may differ from the release version, and a container
 *     tag or registry path is never parsed, compared, or ordered by the
 *     kernel: there is no operation here that could dereference one
 *     ([invariant 15](../../docs/design/release-model.md#architectural-invariants)).
 *   - **Opaque strings stay opaque** — kind, coordinates, and digest are
 *     non-empty strings without surrounding whitespace, stored verbatim,
 *     never normalized: a value that arrives padded is a data error this
 *     door rejects, not one it silently trims.
 *   - **Frozen deeply** — the instance is frozen at construction; there is
 *     no method here that could edit one in place.
 */

/**
 * The only error the `Artifact` door raises, for every rejected input — a
 * blank or padded kind, coordinates, or digest, or a non-string reaching the
 * API at all. The full offending input travels on the error; the message
 * carries a truncated echo so a pathological input cannot bloat a log line.
 */
export class InvalidArtifactError extends Error {
  /** The rejected input, verbatim — whatever the door was handed. */
  public readonly input: unknown;

  /** The machine-readable half of the rejection; the message is its prose form. */
  public readonly reason: string;

  public constructor(input: unknown, reason: string) {
    super(`invalid artifact (${reason}): ${describe(input)}`);
    this.name = "InvalidArtifactError";
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
 * Validates one opaque string of the artifact triple — presence and
 * non-padding, that is all (phase1-contracts design rule 4). Padded input is
 * rejected rather than trimmed — the door validates, it does not normalize.
 */
function opaque(input: unknown, field: string): string {
  if (typeof input !== "string") {
    throw new InvalidArtifactError(input, `the artifact ${field} must be a string`);
  }
  if (input.trim() === "") {
    throw new InvalidArtifactError(input, `the artifact ${field} is empty`);
  }
  if (input.trim() !== input) {
    throw new InvalidArtifactError(
      input,
      `the artifact ${field} carries leading or trailing whitespace`,
    );
  }
  return input;
}

/**
 * The artifact value itself. Construct it through {@link Artifact.of}; the
 * constructor is private so no unvalidated state can be instantiated, not
 * even from inside the module by accident.
 */
export class Artifact {
  /** What kind of output this is — opaque (`"npm"`, `"container"`, …). */
  public readonly kind: string;

  /** The label naming where this output lives — opaque, never a reference. */
  public readonly coordinates: string;

  /** The content identity — opaque; promotion re-points at a digest, never re-fabricates one. */
  public readonly digest: string;

  private constructor(kind: string, coordinates: string, digest: string) {
    this.kind = kind;
    this.coordinates = coordinates;
    this.digest = digest;
    // Frozen before any subclass body runs, exactly as Version is: an
    // immutable value a subclass could mutate is not immutable.
    Object.freeze(this);
  }

  /**
   * The one door into an `Artifact`: the (kind, coordinates, digest) triple,
   * each validated as an opaque string. Anything else throws
   * {@link InvalidArtifactError} carrying the offending input.
   */
  public static of(kind: string, coordinates: string, digest: string): Artifact {
    return new Artifact(
      opaque(kind, "kind"),
      opaque(coordinates, "coordinates"),
      opaque(digest, "digest"),
    );
  }

  /**
   * Content identity: the digests alone. One digest across different
   * coordinates is the same content — promoting without rebuild points at
   * exactly this equality (PR-01); coordinates never decide it (AR-03).
   */
  public sameContent(that: Artifact): boolean {
    return this.digest === that.digest;
  }

  /** Structural equality over all three fields, coordinates included. */
  public equals(that: Artifact): boolean {
    return (
      this.kind === that.kind &&
      this.coordinates === that.coordinates &&
      this.digest === that.digest
    );
  }
}
