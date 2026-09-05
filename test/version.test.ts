import { describe, expect, it } from "vitest";
import { InvalidVersionError, Version } from "../src/index.ts";

/**
 * The contract suite for the semantic version value — the domain kernel's
 * first primitive, exercised as an external consumer: everything here enters
 * through the package surface (`../src/index.ts`), which is also what keeps
 * the kernel project itself free of test-runner imports (ADR-0001).
 *
 * These are contract and invariant tests, not example snapshots: every claim
 * in the `Version` header — grammar, bound, canonical serialization, the two
 * relations, numeric-semantic ordering, immutability, bumps — is asserted as
 * a property with its boundary cases, including the ones a wrong
 * implementation would pass (string comparison, shared mutable state,
 * silently canonicalized input).
 */

/** The inclusive bound every compared numeric identifier must respect. */
const SAFE = Number.MAX_SAFE_INTEGER;

/**
 * Plain string comparison — the foil the ordering tests argue against. Typed
 * as parameters so the lexical traps stay runtime assertions instead of
 * always-true literals the type checker would refuse.
 */
function lexically(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The error `parse` raised for `input` — or a loud failure, never a maybe. */
function parseError(input: string): unknown {
  try {
    Version.parse(input);
  } catch (error) {
    return error;
  }
  throw new Error(`unreachable — parse accepted ${JSON.stringify(input)}`);
}

describe("grammar — what the strict SemVer 2.0.0 surface accepts", () => {
  it("parses the core components", () => {
    const version = Version.parse("1.2.3");

    expect(version.major).toBe(1);
    expect(version.minor).toBe(2);
    expect(version.patch).toBe(3);
    expect(version.prerelease).toEqual([]);
    expect(version.build).toEqual([]);
  });

  it("accepts zero components and a full identifier structure", () => {
    const version = Version.parse("0.0.0-x.7.z.92+exp.sha.5114f85");

    expect(version.major).toBe(0);
    expect(version.minor).toBe(0);
    expect(version.patch).toBe(0);
    expect(version.prerelease).toEqual(["x", "7", "z", "92"]);
    expect(version.build).toEqual(["exp", "sha", "5114f85"]);
  });

  it("treats an alphanumeric identifier starting with 0 as alphanumeric, not numeric", () => {
    // The leading-zero rule guards NUMERIC identifiers; `0a` is alphanumeric
    // and carries no numeric meaning to protect.
    expect(Version.parse("1.0.0-0a").prerelease).toEqual(["0a"]);
    expect(Version.parse("1.0.0-alpha.0").prerelease).toEqual(["alpha", "0"]);
  });

  it("accepts the safe-integer bound itself, everywhere a number is compared", () => {
    expect(Version.parse(`${String(SAFE)}.0.0`).major).toBe(SAFE);
    expect(Version.parse("1.2.3-9007199254740991").prerelease).toEqual([String(SAFE)]);
  });

  it("accepts build identifiers with leading zeroes — the spec only forbids them in numeric prerelease positions", () => {
    expect(Version.parse("1.0.0+001.002").build).toEqual(["001", "002"]);
  });
});

describe("canonical serialization — every accepted string is its own canonical form", () => {
  const accepted = [
    "0.0.0",
    "1.2.3",
    "10.20.30",
    "1.0.0-0",
    "1.0.0-0a",
    "1.0.0-alpha",
    "1.0.0-x.7.z.92",
    "1.0.0+001.002",
    "1.0.0-alpha+build.1",
    "1.0.0-rc.1+21AF26D3--117B344092BD",
    `${String(SAFE)}.0.0`,
    "1.2.3-9007199254740991",
  ];

  for (const input of accepted) {
    it(`round-trips ${JSON.stringify(input)} exactly`, () => {
      const version = Version.parse(input);

      // Identity, not normalisation: the canonical form of an accepted
      // string is the string itself, so format∘parse is the identity.
      expect(version.toString()).toBe(input);
      expect(Version.parse(version.toString()).equals(version)).toBe(true);
    });
  }

  it("refuses everything the grammar would have to canonicalize", () => {
    // If any of these were accepted and rewritten, "canonical serialization"
    // would mean a normaliser, and the identity round-trip above would be a
    // coincidence of the test list.
    const nonCanonical = [
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "v1.2.3",
      " 1.2.3",
      "1.2.3 ",
      "1.2.3\t",
      "1.0.0-01",
      "1.0.0-alpha.01",
    ];

    for (const input of nonCanonical) {
      expect(() => Version.parse(input)).toThrow(InvalidVersionError);
    }
  });
});

describe("invalid input — parse throws the typed error and never returns a partial value", () => {
  const rejected = [
    "",
    ".",
    "1",
    "1.2",
    "1.2.3.4",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "v1.2.3",
    " 1.2.3",
    "1.2.3 ",
    "1.0.0-",
    "1.0.0+",
    "1.0.0-.",
    "1.0.0-alpha..1",
    "1.0.0+build.",
    "1.0.0-01",
    "1.0.0-alpha.01",
    "1.0.0-alpha!",
    "1.0.0+build_1",
    "1.0.0-α",
    "1.0.0+α",
    `${String(SAFE + 1)}.0.0`,
    "1.0.0-9007199254740992",
  ];

  for (const input of rejected) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expect(() => Version.parse(input)).toThrow(InvalidVersionError);
    });
  }

  it("rejects non-string input at the API boundary", () => {
    const notAString = [undefined, null, 42, {}, Version.parse("1.0.0")] as unknown as string[];

    for (const input of notAString) {
      expect(() => Version.parse(input)).toThrow(InvalidVersionError);
    }
  });

  it("carries the offending input on the error, verbatim", () => {
    const error = parseError("1.0.0-01");

    expect(error).toBeInstanceOf(InvalidVersionError);
    expect((error as InvalidVersionError).input).toBe("1.0.0-01");
  });
});

describe("ordering — numeric-semantic precedence, never lexical string order", () => {
  // SemVer 2.0.0 §11.4's own example chain, the one a string sort gets wrong
  // three separate ways.
  const chain = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ];

  it("sorts the spec's §11 chain into itself from any fixed permutation", () => {
    const versions = chain.map((spec) => Version.parse(spec));
    // Two permutations that agree on nothing: exact reversal, and a rotation
    // that leaves no element where it started. Both must fold to the chain.
    const permutations = [
      versions.slice().reverse(),
      versions.slice(4).concat(versions.slice(0, 4)),
    ];

    for (const permutation of permutations) {
      const sorted = permutation.slice().sort((a, b) => a.compare(b));
      expect(sorted.map(String)).toEqual(chain);
    }
  });

  it("makes every adjacent pair strictly ordered in both directions", () => {
    const versions = chain.map((spec) => Version.parse(spec));

    for (let index = 0; index < versions.length - 1; index += 1) {
      const lower = versions[index];
      const higher = versions[index + 1];
      if (lower === undefined || higher === undefined) {
        throw new Error("unreachable — index bounds the chain");
      }
      expect(lower.compare(higher)).toBe(-1);
      expect(higher.compare(lower)).toBe(1);
    }
  });

  it("places a prerelease below its release, where lexical order would not", () => {
    // The trap: string comparison ranks "1.0.0-alpha" ABOVE "1.0.0".
    expect(lexically("1.0.0-alpha", "1.0.0")).toBe(1);
    expect(Version.parse("1.0.0-alpha").compare(Version.parse("1.0.0"))).toBe(-1);
    expect(Version.parse("1.0.0").compare(Version.parse("1.0.0-alpha"))).toBe(1);
  });

  it("compares numeric prerelease identifiers by value, where lexical order would not", () => {
    // The trap: string comparison ranks "11" BELOW "2".
    expect(lexically("11", "2")).toBe(-1);
    expect(Version.parse("1.0.0-beta.11").compare(Version.parse("1.0.0-beta.2"))).toBe(1);
    expect(Version.parse("1.0.0-2").compare(Version.parse("1.0.0-10"))).toBe(-1);
  });

  it("compares core components numerically across carry boundaries", () => {
    // The trap: string comparison ranks "1.9.9" ABOVE "1.10.0".
    expect(lexically("1.9.9", "1.10.0")).toBe(1);
    expect(Version.parse("1.10.0").compare(Version.parse("1.9.9"))).toBe(1);
    expect(Version.parse("2.0.0").compare(Version.parse("1.9999.9999"))).toBe(1);
  });

  it("ranks numeric identifiers below alphanumeric ones, per §11.4", () => {
    expect(Version.parse("1.0.0-1").compare(Version.parse("1.0.0-alpha"))).toBe(-1);
    // Mixed within one list: the numeric/alphanumeric rule applies pairwise.
    expect(Version.parse("1.0.0-alpha.1").compare(Version.parse("1.0.0-alpha.beta"))).toBe(-1);
  });

  it("compares alphanumeric identifiers in ASCII order, where case separates them", () => {
    expect(Version.parse("1.0.0-Alpha").compare(Version.parse("1.0.0-alpha"))).toBe(-1);
    expect(Version.parse("1.0.0-RC1").compare(Version.parse("1.0.0-rc1"))).toBe(-1);
  });

  it("outranks a prefix list with the longer identifier list, per §11.4", () => {
    expect(Version.parse("1.0.0-alpha.0").compare(Version.parse("1.0.0-alpha"))).toBe(1);
    expect(Version.parse("1.0.0-alpha.0.1").compare(Version.parse("1.0.0-alpha.0"))).toBe(1);
  });

  it("is a total order on distinct values: antisymmetric and self-tied", () => {
    const versions = ["1.0.0", "1.0.0-rc.1", "0.9.9", "2.0.0-1", "2.0.0-x"].map((spec) =>
      Version.parse(spec),
    );

    // Direction only: `toBe` distinguishes -0 from +0 (and so does negating
    // zero), while the antisymmetry this pins is about direction.
    const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

    for (const a of versions) {
      expect(a.compare(a)).toBe(0);
      for (const b of versions) {
        expect(sign(a.compare(b))).toBe(sign(-b.compare(a)));
      }
    }
  });
});

describe("the two relations — structural equality and precedence must not be confused", () => {
  it("makes build metadata part of identity, but never of precedence", () => {
    const withA = Version.parse("1.0.0+a");
    const withB = Version.parse("1.0.0+b");

    expect(withA.equals(withB)).toBe(false);
    expect(withA.compare(withB)).toBe(0);
    expect(withB.compare(withA)).toBe(0);
  });

  it("keeps equality implying a precedence tie, and the converse false", () => {
    const bare = Version.parse("1.0.0");
    const withBuild = Version.parse("1.0.0+z");

    expect(bare.equals(withBuild)).toBe(false);
    expect(bare.compare(withBuild)).toBe(0);
    expect(bare.compare(Version.parse("1.0.0-alpha"))).toBe(1);
  });

  it("makes equality structural in every component", () => {
    const cases: Array<[string, string, boolean]> = [
      ["1.2.3", "1.2.3", true],
      ["1.2.3", "1.2.4", false],
      ["1.2.3", "1.3.3", false],
      ["1.2.3", "2.2.3", false],
      ["1.2.3-rc.1", "1.2.3-rc.1", true],
      ["1.2.3-rc.1", "1.2.3-rc.2", false],
      ["1.2.3-rc.1", "1.2.3", false],
      ["1.2.3+a", "1.2.3+a", true],
      ["1.2.3+a", "1.2.3+b", false],
      ["1.2.3+a", "1.2.3", false],
    ];

    for (const [left, right, equal] of cases) {
      expect(Version.parse(left).equals(Version.parse(right))).toBe(equal);
    }
  });

  it("parses equal strings into distinct values that are equal", () => {
    const first = Version.parse("2.7.1-beta.2+f00d");
    const second = Version.parse("2.7.1-beta.2+f00d");

    expect(first).not.toBe(second);
    expect(first.equals(second)).toBe(true);
    // No shared identifier array: freezing per instance, not per string.
    expect(first.prerelease).not.toBe(second.prerelease);
  });
});

describe("immutability — no state can be reached, mutated or shared", () => {
  it("freezes the value and both identifier arrays", () => {
    const version = Version.parse("1.0.0-rc.1+build.2");

    expect(Object.isFrozen(version)).toBe(true);
    expect(Object.isFrozen(version.prerelease)).toBe(true);
    expect(Object.isFrozen(version.build)).toBe(true);
  });

  it("refuses mutation through the exposed identifier arrays", () => {
    const version = Version.parse("1.0.0-rc.1+build.2");

    expect(() => {
      (version.prerelease as string[]).push("9");
    }).toThrow(TypeError);
    expect(version.prerelease).toEqual(["rc", "1"]);
    expect(() => {
      (version.build as string[]).shift();
    }).toThrow(TypeError);
    expect(version.build).toEqual(["build", "2"]);
  });

  it("refuses direct field assignment on the frozen instance", () => {
    const version = Version.parse("1.0.0");

    expect(() => {
      (version as { major: number }).major = 2;
    }).toThrow(TypeError);
    expect(version.major).toBe(1);
  });

  it("leaves the operand untouched across bumps", () => {
    const version = Version.parse("1.2.3-rc.1+build.7");

    version.bumpMajor();
    version.bumpMinor();
    version.bumpPatch();

    expect(version.toString()).toBe("1.2.3-rc.1+build.7");
  });
});

describe("bumps — a bump is a release: core incremented, prerelease and build stripped", () => {
  const cases: Array<[string, "bumpMajor" | "bumpMinor" | "bumpPatch", string]> = [
    ["1.2.3", "bumpMajor", "2.0.0"],
    ["1.2.3", "bumpMinor", "1.3.0"],
    ["1.2.3", "bumpPatch", "1.2.4"],
    ["1.2.3-rc.1", "bumpMajor", "2.0.0"],
    ["1.2.3-rc.1", "bumpMinor", "1.3.0"],
    ["1.2.3-rc.1", "bumpPatch", "1.2.3"],
    ["1.2.3+build.7", "bumpPatch", "1.2.4"],
    ["0.0.0", "bumpPatch", "0.0.1"],
  ];

  for (const [input, bump, expected] of cases) {
    it(`bumps ${JSON.stringify(input)} with ${bump} to ${JSON.stringify(expected)}`, () => {
      expect(Version.parse(input)[bump]().toString()).toBe(expected);
    });
  }

  it("composes left to right like the release numbers read", () => {
    expect(
      Version.parse("0.1.0").bumpMinor().bumpPatch().bumpMajor().equals(Version.parse("1.0.0")),
    ).toBe(true);
  });

  it("refuses an increment that would leave the safe-integer domain", () => {
    expect(() => Version.parse(`${String(SAFE)}.0.0`).bumpMajor()).toThrow(RangeError);
    expect(() => Version.parse(`0.${String(SAFE)}.0`).bumpMinor()).toThrow(RangeError);
    expect(() => Version.parse(`0.0.${String(SAFE)}`).bumpPatch()).toThrow(RangeError);
  });
});
