import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, Version } from "../src/index.ts";

// The bootstrap's one suite proves the toolchain path end to end — source,
// Vitest, pass — on a subject with a real contract, rather than on
// expect(true).toBe(true). If the pipeline cannot execute this, every gate
// above it is theatre.
//
// The canary asserts only what the package can honestly claim: its own name,
// and that the domain re-export is live. It used to also export a `stage`
// literal claiming where the repository stood in its life — a claim in code
// that no gate reads, which drifted from the documented state within the PR
// that introduced it (issue #9) and was removed rather than re-tuned: the
// README's status section is the one place that describes repository state.
describe("the toolchain canary", () => {
  it("reports the package identity", () => {
    expect(PACKAGE_NAME).toBe("@ecoma-io/release-craft");
  });

  it("pins the name as a compile-time literal of the package contract", () => {
    // `as const` makes the export's type the literal itself, so a rename of
    // the constant's value is a compile-visible change, and the assertion
    // below is the runtime half of the same pin.
    const name: typeof PACKAGE_NAME = "@ecoma-io/release-craft";

    expect(PACKAGE_NAME).toBe(name);
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
