import { describe, expect, it } from "vitest";
import { Artifact, InvalidArtifactError } from "../src/index.ts";

/**
 * The contract suite for the artifact value — one publishable output,
 * identified by digest — exercised as an external consumer through the
 * package surface (`../src/index.ts`, ADR-0001 decision 9).
 *
 * Scenario anchors, exactly where the contract cites them: AR-03
 * (coordinates are labels, never references — the artifact version scheme
 * differs from the release version), PR-01 (promoting without rebuild is
 * pointing at the same digest), PR-02 (a deliberate rebuild is new
 * content — a new generation, recorded execution-side over digest
 * records), PR-03 (evidence does not live here), AR-01/AR-02/AR-04/AR-06
 * (the artifact class's family), R6/A4 (the vocabulary lock).
 */

/** The error `Artifact.of` raised for these arguments — or a loud failure. */
function artifactError(kind: unknown, coordinates: unknown, digest: unknown): unknown {
  try {
    Artifact.of(kind as string, coordinates as string, digest as string);
  } catch (error) {
    return error;
  }
  throw new Error(`unreachable — Artifact.of accepted ${JSON.stringify(kind)}`);
}

describe("construction doors — the triple is three opaque strings, never patterns", () => {
  const rejected: unknown[] = ["", " ", "\t", " npm", "npm ", 42, null, undefined, {}];

  for (const value of rejected) {
    it(`rejects the kind ${JSON.stringify(String(value))} (${typeof value})`, () => {
      const error = artifactError(
        value,
        "ghcr.io/x/app:2.0.0",
        "sha256:9f2c",
      ) as InvalidArtifactError;

      expect(error).toBeInstanceOf(InvalidArtifactError);
      expect(error.input).toBe(value);
    });

    it(`rejects the coordinates ${JSON.stringify(String(value))} (${typeof value})`, () => {
      const error = artifactError("npm", value, "sha256:9f2c") as InvalidArtifactError;

      expect(error).toBeInstanceOf(InvalidArtifactError);
      expect(error.input).toBe(value);
    });

    it(`rejects the digest ${JSON.stringify(String(value))} (${typeof value})`, () => {
      const error = artifactError("npm", "@ex/app@1.2.3", value) as InvalidArtifactError;

      expect(error).toBeInstanceOf(InvalidArtifactError);
      expect(error.input).toBe(value);
    });
  }

  it("carries a long offending input verbatim while truncating only the message echo", () => {
    const long = "x".repeat(80);
    const error = artifactError("npm", ` ${long} `, "sha256:9f2c") as InvalidArtifactError;

    expect(error.input).toBe(` ${long} `);
    expect(error.message).not.toContain(long);
  });

  it("accepts the coordinate shapes the taxonomy names, unparsed — AR-03", () => {
    // AR-03: `ghcr.io/x/app:2.0.0`, moving tags like `v2`/`latest`, an npm
    // name — all labels the kernel stores verbatim and never compares,
    // parses, or orders. The `v` prefix a Version would refuse is fine
    // here precisely because this string is not a version.
    const coordinates = ["ghcr.io/x/app:2.0.0", "ghcr.io/x/app:v2", "@ex/app", "app-1.2.3.tgz"];

    for (const label of coordinates) {
      const artifact = Artifact.of("container", label, "sha256:9f2c");

      expect(artifact.coordinates).toBe(label);
    }
  });

  it("exposes exactly the contract's field list — nothing about validity or generation", () => {
    // PR-03 (evidence is execution-side) and PR-02 (generation is
    // execution-side bookkeeping): the exact key list is the assertion.
    const artifact = Artifact.of("npm", "@ex/app@1.2.3", "sha512:aaa");

    expect(Object.keys(artifact)).toEqual(["kind", "coordinates", "digest"]);
  });
});

describe("content identity — the digest, nothing else (PR-01, AR-03)", () => {
  const digest = "sha256:9f2c4a1e";

  it("makes sameContent true across different coordinates with one digest — promote without rebuild", () => {
    // PR-01: the rc tarball and the stable tarball are the same bytes, so
    // promotion points at the digest; AR-03: the differing coordinate
    // labels never decide content identity.
    const rc = Artifact.of("npm", "@ex/app@1.2.3-rc.1", digest);
    const stable = Artifact.of("npm", "@ex/app@1.2.3", digest);

    expect(rc.sameContent(stable)).toBe(true);
    expect(stable.sameContent(rc)).toBe(true);
  });

  it("makes sameContent true across different kinds with one digest — AR-01's artifact set may share bytes", () => {
    const tarball = Artifact.of("npm", "@ex/app@1.2.3", digest);
    const image = Artifact.of("container", "ghcr.io/x/app:1.2.3", digest);

    expect(tarball.sameContent(image)).toBe(true);
  });

  it("makes sameContent false when the digest differs — a rebuild is new content (PR-02)", () => {
    const original = Artifact.of("npm", "@ex/app@1.2.3", "sha256:9f2c");
    const rebuilt = Artifact.of("npm", "@ex/app@1.2.3", "sha256:77aa");

    expect(original.sameContent(rebuilt)).toBe(false);
  });

  it("makes sameContent reflexive", () => {
    const artifact = Artifact.of("npm", "@ex/app@1.2.3", digest);

    expect(artifact.sameContent(artifact)).toBe(true);
  });
});

describe("equality — structural over all three fields, coordinates included", () => {
  it("equals an identically-constructed artifact", () => {
    const mine = Artifact.of("npm", "@ex/app@1.2.3", "sha256:9f2c");
    const yours = Artifact.of("npm", "@ex/app@1.2.3", "sha256:9f2c");

    expect(mine).not.toBe(yours);
    expect(mine.equals(yours)).toBe(true);
  });

  it("distinguishes coordinates — same digest, different label, different record", () => {
    // The pair sameContent says true for; equals must refuse: content
    // identity and record identity are two relations (AR-03/PR-01).
    const rc = Artifact.of("npm", "@ex/app@1.2.3-rc.1", "sha256:9f2c");
    const stable = Artifact.of("npm", "@ex/app@1.2.3", "sha256:9f2c");

    expect(rc.equals(stable)).toBe(false);
  });

  it("distinguishes kind", () => {
    const tarball = Artifact.of("npm", "@ex/app@1.2.3", "sha256:9f2c");
    const image = Artifact.of("container", "@ex/app@1.2.3", "sha256:9f2c");

    expect(tarball.equals(image)).toBe(false);
  });

  it("distinguishes digest", () => {
    const original = Artifact.of("npm", "@ex/app@1.2.3", "sha256:9f2c");
    const rebuilt = Artifact.of("npm", "@ex/app@1.2.3", "sha256:77aa");

    expect(original.equals(rebuilt)).toBe(false);
  });
});

describe("freeze discipline — the triple is immutable", () => {
  it("freezes the instance", () => {
    expect(Object.isFrozen(Artifact.of("npm", "@ex/app@1.2.3", "sha256:9f2c"))).toBe(true);
  });

  it("refuses direct field assignment on the frozen instance", () => {
    const artifact = Artifact.of("npm", "@ex/app@1.2.3", "sha256:9f2c");

    expect(() => {
      (artifact as { digest: string }).digest = "sha256:77aa";
    }).toThrow(TypeError);
    expect(artifact.digest).toBe("sha256:9f2c");
  });

  it("leaves the receiver untouched across queries — call twice, deep-equal", () => {
    const artifact = Artifact.of("npm", "@ex/app@1.2.3", "sha256:9f2c");
    const snapshot = Artifact.of("npm", "@ex/app@1.2.3", "sha256:9f2c");

    artifact.sameContent(snapshot);
    artifact.equals(snapshot);
    artifact.sameContent(Artifact.of("npm", "@ex/app@1.2.3-rc.1", "sha256:9f2c"));

    expect(artifact.equals(snapshot)).toBe(true);
    expect(artifact.digest).toBe("sha256:9f2c");
  });
});
