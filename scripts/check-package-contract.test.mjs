// Tests for the package-contract gate: each fixture is a minimal package.json
// standing in for one way the contract can drift.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validatePackageContract } from "./check-package-contract.mjs";

/** @returns {{ [key: string]: unknown }} */
function goodPackage() {
  return {
    name: "@ecoma-io/release-craft",
    version: "0.1.0",
    private: true,
    type: "module",
    packageManager: "pnpm@11.25.0",
    engines: { node: ">=24", pnpm: ">=11" },
    scripts: Object.fromEntries(
      [
        "format",
        "format:check",
        "lint",
        "typecheck",
        "test",
        "test:coverage",
        "build",
        "arch",
        "check",
      ].map((script) => [script, "true"]),
    ),
    devDependencies: { "@ecoma-io/archkeep": "0.24.1", vitest: "^4.1.11" },
  };
}

describe("validatePackageContract", () => {
  it("accepts a package that keeps the contract", () => {
    assert.deepEqual(validatePackageContract(goodPackage()), []);
  });

  it("refuses a wrong package name", () => {
    const pkg = goodPackage();
    pkg["name"] = "release-craft";

    assert.ok(validatePackageContract(pkg).some((v) => v.includes("name")));
  });

  it("refuses an unpublished-ready private:false", () => {
    const pkg = goodPackage();
    pkg["private"] = false;

    assert.ok(validatePackageContract(pkg).some((v) => v.includes("private")));
  });

  it("refuses a floating packageManager pin", () => {
    const pkg = goodPackage();
    pkg["packageManager"] = "pnpm@^11";

    assert.ok(validatePackageContract(pkg).some((v) => v.includes("packageManager")));
  });

  it("refuses a missing canonical script", () => {
    const pkg = goodPackage();
    /** @type {{ [key: string]: unknown }} */ (pkg["scripts"])["arch"] = undefined;

    assert.ok(validatePackageContract(pkg).some((v) => v.includes("scripts.arch")));
  });

  it("refuses runtime dependencies at bootstrap", () => {
    const pkg = goodPackage();
    pkg["dependencies"] = { "left-pad": "^1.0.0" };

    assert.ok(validatePackageContract(pkg).some((v) => v.includes("dependencies")));
  });

  it("refuses a ranged @ecoma-io/archkeep pin", () => {
    const pkg = goodPackage();
    /** @type {{ [key: string]: unknown }} */ (pkg["devDependencies"])["@ecoma-io/archkeep"] =
      "^0.24.1";

    assert.ok(
      validatePackageContract(pkg).some(
        (v) => v.includes("@ecoma-io/archkeep") && v.includes("exactly"),
      ),
    );
  });

  it("refuses latest and wildcard devDependency ranges", () => {
    const pkg = goodPackage();
    /** @type {{ [key: string]: unknown }} */ (pkg["devDependencies"])["vitest"] = "latest";

    assert.ok(validatePackageContract(pkg).some((v) => v.includes("latest")));
  });
});
