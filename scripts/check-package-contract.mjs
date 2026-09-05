// Repository invariant: package.json keeps the contract the toolchain and CI
// are built on.
//
// The checks are the bootstrap's dependency policy, made executable:
//   - the canonical developer interface exists (no tool with its own private
//     invocation and no documented command);
//   - the package manager is pinned to an exact pnpm version (Corepack and
//     CI's pnpm/action-setup both read `packageManager` — a range here means
//     two machines can install different lockfiles);
//   - no runtime dependencies at bootstrap (the substrate needs none; adding
//     the first one is a design decision that edits this gate with it);
//   - the architecture governor is pinned EXACTLY — `@ecoma-io/archkeep` is
//     the one dependency whose version is law, so its range syntax is
//     forbidden (^, ~, >, <, * would let a bump rewrite the boundary verdicts
//     without a diff anyone asked for);
//   - no `latest`, no wildcard ranges, anywhere in devDependencies — the
//     lockfile is the only source of truth for what actually installs.
//
// Exit codes: 0 clean · 1 findings.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The canonical developer interface every other invocation routes through.
 *
 * @type {string[]}
 */
const CANONICAL_SCRIPTS = [
  "format",
  "format:check",
  "lint",
  "typecheck",
  "test",
  "test:coverage",
  "build",
  "arch",
  "check",
];

const EXACT_PIN_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * Validates a parsed package.json against the contract. Pure, so the gate's
 * own test can point it at fixtures.
 *
 * @param {{ [key: string]: unknown }} pkg
 * @returns {string[]} one message per violation, empty when clean
 */
export function validatePackageContract(pkg) {
  /** @type {string[]} */
  const violations = [];

  if (pkg["name"] !== "@ecoma-io/release-craft") {
    violations.push(`name must be "@ecoma-io/release-craft", got ${JSON.stringify(pkg["name"])}`);
  }
  if (pkg["private"] !== true) {
    violations.push("private must be true — no publish path exists at bootstrap");
  }
  if (pkg["type"] !== "module") {
    violations.push('type must be "module" — the substrate is ESM-first');
  }

  const packageManager = pkg["packageManager"];
  if (typeof packageManager !== "string" || !/^pnpm@\d+\.\d+\.\d+$/.test(packageManager)) {
    violations.push(
      `packageManager must pin an exact pnpm version ("pnpm@<major>.<minor>.<patch>"), got ${JSON.stringify(packageManager)}`,
    );
  }

  const engines = /** @type {{ [key: string]: unknown } | undefined} */ (pkg["engines"]);
  if (engines?.["node"] !== ">=24") {
    violations.push('engines.node must be ">=24" — the documented development floor');
  }
  if (engines?.["pnpm"] !== ">=11") {
    violations.push('engines.pnpm must be ">=11" — the org-wide pnpm line');
  }

  const scripts = /** @type {{ [key: string]: unknown } | undefined} */ (pkg["scripts"]);
  for (const script of CANONICAL_SCRIPTS) {
    if (typeof scripts?.[script] !== "string") {
      violations.push(`scripts.${script} is missing — the canonical interface is incomplete`);
    }
  }

  const dependencies = pkg["dependencies"];
  if (dependencies !== undefined && dependencies !== null) {
    const size = Object.keys(/** @type {object} */ (dependencies)).length;
    if (size > 0) {
      violations.push(
        `dependencies must be absent or empty at bootstrap — found ${size} runtime ${size === 1 ? "dependency" : "dependencies"}`,
      );
    }
  }

  const devDependencies = /** @type {{ [key: string]: string } | undefined} */ (
    pkg["devDependencies"]
  );
  if (devDependencies === undefined) {
    violations.push("devDependencies is missing — the toolchain has nowhere to live");
  } else {
    const archkeep = devDependencies["@ecoma-io/archkeep"];
    if (archkeep === undefined) {
      violations.push("@ecoma-io/archkeep is missing — architecture enforcement has no tool");
    } else if (!EXACT_PIN_PATTERN.test(archkeep)) {
      violations.push(
        `@ecoma-io/archkeep must be pinned exactly (no range syntax), got "${archkeep}"`,
      );
    }
    // Caret and tilde ranges are allowed for ordinary dev tooling (Renovate
    // + the lockfile own what actually installs); `latest` and wildcard
    // ranges are not — they resolve to nothing a lockfile can pin.
    for (const [name, range] of Object.entries(devDependencies)) {
      if (range === "latest") {
        violations.push(`devDependency "${name}" uses "latest" — pin a version`);
      } else if (range.includes("*")) {
        violations.push(`devDependency "${name}" uses a wildcard range "${range}" — pin a version`);
      }
    }
  }

  return violations;
}

function main() {
  const manifestPath = resolve(import.meta.dirname, "..", "package.json");
  /** @type {{ [key: string]: unknown }} */
  const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
  const violations = validatePackageContract(pkg);

  for (const violation of violations) {
    console.error(`✗ ${violation}`);
  }
  if (violations.length > 0) {
    console.error(`check-package-contract: ${violations.length} violation(s)`);
    process.exitCode = 1;
    return;
  }
  console.log("✓ package.json keeps the bootstrap contract");
}

main();
