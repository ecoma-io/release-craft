/**
 * The semantic version value — release-craft's first domain primitive.
 *
 * A `Version` is an immutable value that represents one valid version string
 * per the SemVer 2.0.0 grammar, and nothing else. It knows how to be parsed,
 * printed, compared and (within the evidence recorded in ADR-0001) bumped; it
 * does not know about release lines, branches, changes, channels or
 * publishing — a version's meaning inside a release process is policy that
 * lives above this file, never inside it.
 *
 * Purity is layered, each layer owning the surface it can actually see
 * (docs/adr/0001-domain-kernel-and-semantic-version.md is the source of
 * truth; this header only points at it):
 *
 *   - This file imports nothing. archkeep refuses every external import from
 *     the `type-domain` project (`bannedExternalImports: ["*"]` in
 *     `module-boundaries.config.mjs`) — no Node built-in (`fs`, `path`, …),
 *     no npm package (`semver`, `octokit`, …), no other project's module.
 *   - The project's `tsconfig.json` compiles with `types: []`, so the Node
 *     globals (`process`, `Buffer`, `__dirname`, …) are compile errors here.
 *   - The lint gate refuses the non-import surface static import analysis
 *     cannot see (`Date`, timers, `Math.random`, `console`) for
 *     `core/domain/**`.
 *
 * The contract, each line of it pinned by the contract suite (`test/`):
 *
 *   - **Grammar** — strict SemVer 2.0.0: `MAJOR.MINOR.PATCH` with optional
 *     `-prerelease` and `+build`. No `v` prefix, no loose or coercing mode,
 *     no surrounding whitespace, all three core components required, numeric
 *     identifiers without leading zeroes (build metadata may carry them —
 *     the spec only forbids them in numeric *prerelease* positions).
 *   - **Bound** — every component that participates in numeric comparison
 *     (the three core numbers and numeric prerelease identifiers) must fit a
 *     safe integer (`0…2^53-1`); beyond it the decimal comparison this
 *     grammar promises would silently lie at the `Number` precision edge.
 *     Build identifiers carry no bound — they are never compared.
 *   - **Canonical serialization** — the grammar is strict enough that every
 *     accepted string is its own canonical form: `format(parse(s)) === s`
 *     for all `s`, and nothing non-canonical is accepted to begin with.
 *     `parse` never returns an invalid value; every rejection throws
 *     `InvalidVersionError`.
 *   - **Two distinct relations** — `equals` is structural: the build
 *     metadata is part of a version's identity, so `1.0.0+a` does not equal
 *     `1.0.0+b`. `compare` is SemVer precedence: the spec ignores build
 *     metadata there, so the same two compare as `0`. Both facts are
 *     asserted, in both directions.
 *   - **Ordering is numeric-semantic, never lexical** — `1.0.0-alpha` sorts
 *     *below* `1.0.0`, `beta.2` below `beta.11`, and numeric prerelease
 *     identifiers below alphanumeric ones, exactly as SemVer 2.0.0 §11
 *     defines. The suite pins the traps a string comparison would walk into.
 *   - **Bumps are releases** — `bumpMajor`/`bumpMinor`/`bumpPatch` always
 *     return a core-only version (prerelease and build stripped), matching
 *     what release tooling means by "bump the patch" on `1.2.3-rc.1`:
 *     release `1.2.3`. An increment that would cross the safe-integer bound
 *     throws `RangeError` rather than wrapping into an invalid value.
 *   - **Immutability** — the instance and both identifier arrays are frozen
 *     at construction; a mutable subclass cannot exist, because the base
 *     constructor freezes `this` before a subclass body ever runs.
 */

/** The inclusive upper bound for any numeric identifier that takes part in comparison. */
const SAFE_BOUND = Number.MAX_SAFE_INTEGER;

/**
 * The whole grammar, anchored at both ends: three numeric components without
 * leading zeroes, an optional prerelease of dot-separated non-empty
 * alphanumeric-hyphen identifiers, and an optional build of the same shape.
 * What this one pattern cannot express locally — no leading zeroes in
 * *numeric* prerelease identifiers, the safe-integer bound — is checked after
 * it matches, because the restrictions are about meaning, not shape.
 */
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Digits only — the test that decides whether a prerelease identifier is numeric. */
const NUMERIC_PATTERN = /^\d+$/;

/** Numeric identifiers additionally reject leading zeroes: the spec's `<numeric identifier>`. */
const CANONICAL_NUMERIC_PATTERN = /^(0|[1-9]\d*)$/;

/**
 * The only error `parse` raises, for every rejected input — malformed shape,
 * leading zeroes, bound overflow, or a non-string reaching the API at all.
 * The full offending input travels on the error; the message carries a
 * truncated echo so a pathological input cannot bloat a log line.
 */
export class InvalidVersionError extends Error {
  /** The rejected input, verbatim — whatever `parse` was handed. */
  public readonly input: unknown;

  /** The machine-readable half of the rejection; the message is its prose form. */
  public readonly reason: string;

  public constructor(input: unknown, reason: string) {
    super(`invalid semantic version (${reason}): ${describe(input)}`);
    this.name = "InvalidVersionError";
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
 * The version value itself. Construct it through {@link Version.parse}; the
 * constructor is private so no unvalidated state can be instantiated, not
 * even from inside the module by accident.
 */
export class Version {
  /** The core components — the only parts every version has. */
  public readonly major: number;
  public readonly minor: number;
  public readonly patch: number;

  readonly #prerelease: readonly string[];
  readonly #build: readonly string[];

  private constructor(
    major: number,
    minor: number,
    patch: number,
    prerelease: readonly string[],
    build: readonly string[],
  ) {
    this.major = major;
    this.minor = minor;
    this.patch = patch;
    this.#prerelease = Object.freeze([...prerelease]);
    this.#build = Object.freeze([...build]);
    // Frozen before any subclass body runs: an immutable value that a
    // subclass could mutate is not immutable. Deliberately hostile to
    // subclassing; composition over Version is the supported shape.
    Object.freeze(this);
  }

  /**
   * Parses a strict SemVer 2.0.0 string. This is the only door into a
   * `Version`; it throws {@link InvalidVersionError} on anything the grammar
   * or the safe-integer bound refuses, and never returns a partially built
   * value.
   */
  public static parse(input: string): Version {
    if (typeof input !== "string") {
      throw new InvalidVersionError(input, "a semantic version must be a string");
    }
    try {
      return Version.#parseShape(input);
    } catch (error) {
      // A component-level rejection carries the fragment it named; the error
      // contract is the FULL input on every error, so re-wrap with the same
      // reason under the whole string.
      if (error instanceof InvalidVersionError && error.input !== input) {
        throw new InvalidVersionError(input, error.reason);
      }
      throw error;
    }
  }

  /** The shape-and-components half of {@link Version.parse}; errors here may carry fragments. */
  static #parseShape(input: string): Version {
    const match = VERSION_PATTERN.exec(input);
    if (match === null) {
      throw new InvalidVersionError(input, shapeReason(input));
    }

    const major = component(match[1], "major");
    const minor = component(match[2], "minor");
    const patch = component(match[3], "patch");
    const prerelease = identifiers(match[4]);
    const build = match[5] === undefined ? [] : match[5].split(".");

    return new Version(major, minor, patch, prerelease, build);
  }

  /** The prerelease identifiers, in order — frozen, numeric ones in canonical decimal. */
  public get prerelease(): readonly string[] {
    return this.#prerelease;
  }

  /** The build metadata identifiers, in order — frozen, never compared by `compare`. */
  public get build(): readonly string[] {
    return this.#build;
  }

  /**
   * Structural equality: same core, same prerelease identifiers, same build
   * identifiers. This is value identity — `1.0.0+a` and `1.0.0+b` are
   * different versions that happen to tie in precedence.
   */
  public equals(that: Version): boolean {
    return (
      this.major === that.major &&
      this.minor === that.minor &&
      this.patch === that.patch &&
      sameIdentifiers(this.#prerelease, that.#prerelease) &&
      sameIdentifiers(this.#build, that.#build)
    );
  }

  /**
   * SemVer 2.0.0 §11 precedence: core numerically, then prerelease presence
   * (absence is higher), then identifiers left to right — numeric before
   * alphanumeric, numerics by value, alphanumerics in ASCII order, a longer
   * identifier list above a prefix of itself. Build metadata plays no part;
   * versions differing only in build compare as `0`.
   */
  public compare(that: Version): number {
    const byCore =
      byNumber(this.major, that.major) ||
      byNumber(this.minor, that.minor) ||
      byNumber(this.patch, that.patch);
    if (byCore !== 0) {
      return byCore;
    }
    return byPrerelease(this.#prerelease, that.#prerelease);
  }

  /** The next major release: core major+1, everything else reset — a release, never a bump on top of a prerelease. */
  public bumpMajor(): Version {
    return Version.core(checked(this.major + 1, "major"), 0, 0);
  }

  /** The next minor release: core minor+1, patch and everything after reset. */
  public bumpMinor(): Version {
    return Version.core(this.major, checked(this.minor + 1, "minor"), 0);
  }

  /**
   * The next patch release; on a prerelease, the release it has been pointing
   * at — `1.2.3-rc.1` is work toward `1.2.3`, so its patch bump *is* `1.2.3`
   * (the npm-semver convention for "bump the patch" over a prerelease).
   */
  public bumpPatch(): Version {
    const patch = this.#prerelease.length > 0 ? this.patch : checked(this.patch + 1, "patch");
    return Version.core(this.major, this.minor, patch);
  }

  /** The canonical serialization — the exact string `parse` accepted. */
  public toString(): string {
    const core = `${this.major}.${this.minor}.${this.patch}`;
    const pre = this.#prerelease.length > 0 ? `-${this.#prerelease.join(".")}` : "";
    const build = this.#build.length > 0 ? `+${this.#build.join(".")}` : "";
    return `${core}${pre}${build}`;
  }

  /** The factory for validated core-only versions — the shape every bump returns. */
  private static core(major: number, minor: number, patch: number): Version {
    return new Version(major, minor, patch, [], []);
  }
}

/**
 * Why the shape was refused, for the three cases worth naming before the
 * generic grammar answer — enough for the error to teach the grammar without
 * pretending to be a parser diagnostic.
 */
function shapeReason(input: string): string {
  if (input === "") {
    return "the empty string";
  }
  if (input.trim() !== input) {
    return "leading or trailing whitespace";
  }
  if (/^v\d/.test(input)) {
    return "a leading 'v' prefix — the grammar is strict SemVer 2.0.0";
  }
  return "expected MAJOR.MINOR.PATCH[-prerelease][+build] per SemVer 2.0.0";
}

/** Validates one core component: the regex guarantees digits; the bound is this contract's. */
function component(raw: string | undefined, which: string): number {
  if (raw === undefined) {
    throw new InvalidVersionError(raw, `the ${which} component is missing`);
  }
  return bounded(Number(raw), which);
}

/** Validates one numeric component's magnitude against the safe-integer bound. */
function bounded(value: number, which: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new InvalidVersionError(value, `the ${which} component exceeds the safe-integer bound`);
  }
  return value;
}

/**
 * Prerelease identifiers, canonicalized: numeric identifiers must be free of
 * leading zeroes (a shape the master pattern allows in mixed identifiers like
 * `01a`, but never in a numeric one) and bounded like the core, because they
 * take part in numeric comparison.
 */
function identifiers(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  return raw.split(".").map((identifier) => {
    if (!NUMERIC_PATTERN.test(identifier)) {
      // A mixed identifier like `01a` is alphanumeric, not numeric: the
      // leading-zero and bound rules do not apply to it.
      return identifier;
    }
    if (!CANONICAL_NUMERIC_PATTERN.test(identifier)) {
      throw new InvalidVersionError(
        identifier,
        `the numeric prerelease identifier "${identifier}" carries a leading zero`,
      );
    }
    return String(bounded(Number(identifier), `prerelease identifier "${identifier}"`));
  });
}

/** An increment that would leave the safe-integer domain is refused, not wrapped. */
function checked(value: number, which: string): number {
  if (value > SAFE_BOUND) {
    throw new RangeError(
      `bumping the ${which} component would exceed the safe-integer bound (${SAFE_BOUND})`,
    );
  }
  return value;
}

/** The three-way sign, the only comparison primitive this file needs. */
function byNumber(x: number, y: number): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

function byPrerelease(x: readonly string[], y: readonly string[]): number {
  if (x.length === 0 && y.length === 0) {
    return 0;
  }
  if (x.length === 0) {
    return 1; // Absence of a prerelease outranks any prerelease.
  }
  if (y.length === 0) {
    return -1;
  }
  const shared = Math.min(x.length, y.length);
  for (let index = 0; index < shared; index += 1) {
    const left = x[index];
    const right = y[index];
    if (left === undefined || right === undefined) {
      break; // Unreachable: `shared` bounds both lists.
    }
    const ordered = byIdentifier(left, right);
    if (ordered !== 0) {
      return ordered;
    }
  }
  // All shared identifiers tie: the longer list outranks its prefix.
  return byNumber(x.length, y.length);
}

/** One identifier pair: numerics by value, numerics below alphanumerics, text in ASCII order. */
function byIdentifier(x: string, y: string): number {
  const xNumeric = NUMERIC_PATTERN.test(x);
  const yNumeric = NUMERIC_PATTERN.test(y);
  if (xNumeric && yNumeric) {
    return byNumber(Number(x), Number(y));
  }
  if (xNumeric) {
    return -1;
  }
  if (yNumeric) {
    return 1;
  }
  // Identifiers are ASCII-only by grammar, so code-unit order is ASCII order.
  return x < y ? -1 : x > y ? 1 : 0;
}

function sameIdentifiers(x: readonly string[], y: readonly string[]): boolean {
  return x.length === y.length && x.every((identifier, index) => y[index] === identifier);
}
