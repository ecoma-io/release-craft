import { describe, expect, it } from "vitest";
import { identity, PACKAGE_NAME, Version } from "../src/index.ts";

// The bootstrap's one suite proves the toolchain path end to end — source,
// Vitest, pass — on a subject with a real contract, rather than on
// expect(true).toBe(true). If the pipeline cannot execute this, every gate
// above it is theatre.
describe("the toolchain canary", () => {
  it("reports the package identity", () => {
    const identity_ = identity();

    expect(identity_.name).toBe("@ecoma-io/release-craft");
    expect(identity_.stage).toBe("foundation");
  });

  it("keeps the identity a compile-time function of PACKAGE_NAME", () => {
    // The exported constant and the constructed identity must agree — the
    // interface pins the constant's literal type, so a drift between the two
    // is a typecheck failure before it is a test failure.
    const identity_: { name: typeof PACKAGE_NAME; stage: "foundation" } = identity();

    expect(identity_.name).toBe(PACKAGE_NAME);
  });

  it("does not leak state between calls", () => {
    expect(identity()).toStrictEqual(identity());
  });
});

// The package's one domain claim, pinned from the consumer side: the public
// surface re-exports the kernel's primitive, and the re-export is live — the
// `type-package → type-domain` edge archkeep allows has a working reader.
describe("the package surface", () => {
  it("re-exports the domain primitive, working", () => {
    expect(Version.parse("1.2.3").toString()).toBe("1.2.3");
    expect(Version.parse("1.2.3").equals(Version.parse("1.2.3"))).toBe(true);
  });
});
