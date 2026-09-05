// Repository invariant: the files the bootstrap contract depends on exist, and
// the files the contract forbids do not.
//
// This is the gate that turns "the substrate is complete" from a memory into a
// check: a contributor (or an agent) who deletes a governance file, or adds a
// root archkeep.json next to `.moon/` — a pair archkeep refuses outright —
// fails here, in the same second, on every machine. The list is data on
// purpose: adding a required file edits this list and the file together.
//
// Exit codes: 0 clean · 1 findings.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Every file the repository's governance depends on. Grouped by what owns
 * them, so the next addition is filed under the thing it belongs to.
 *
 * @type {string[]}
 */
const REQUIRED_FILES = [
  // Governance documents.
  "README.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "LICENSE",
  "docs/bootstrap/ecosystem-analysis.md",

  // Architecture decisions — one file per accepted ADR.
  "docs/adr/0001-domain-kernel-and-semantic-version.md",

  // The domain kernel — its own Moon project, its own typecheck baseline.
  "core/domain/version.ts",
  "core/domain/tsconfig.json",
  "core/domain/moon.yml",
  "test/version.test.ts",

  // Package and toolchain contract.
  "package.json",
  "pnpm-lock.yaml",
  ".npmrc",
  ".node-version",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.build.json",
  "scripts/tsconfig.json",
  "vitest.config.ts",
  "eslint.config.mjs",
  "commitlint.config.mjs",
  ".prettierrc",
  ".prettierignore",
  ".editorconfig",

  // Task graph and architecture law.
  ".moon/workspace.yml",
  "moon.yml",
  "scripts/moon.yml",
  "module-boundaries.config.mjs",
  "lefthook.yml",

  // Repository plumbing.
  ".gitignore",
  ".gitattributes",

  // Workflows — the three-layer CI split.
  ".github/workflows/ci.yml",
  ".github/workflows/analysis.yml",
  ".github/workflows/policy.yml",
  ".github/renovate.json5",

  // Issue and pull request templates.
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",

  // The toolchain canary and its suite.
  "src/index.ts",
  "test/index.test.ts",
];

/**
 * Files that must NOT exist. Each entry carries its reason, so the violation
 * message is the argument, not just the verdict.
 *
 * @type {Array<{ path: string, reason: string }>}
 */
const FORBIDDEN_FILES = [
  {
    path: "archkeep.json",
    reason:
      "this is a Moonrepo workspace — archkeep refuses a root holding both `.moon/` and `archkeep.json`; the Moon provider reads module-boundaries.config.mjs by convention instead (see docs/bootstrap/ecosystem-analysis.md)",
  },
];

/**
 * Returns the required files missing under `root`.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function collectMissingFiles(root) {
  return REQUIRED_FILES.filter((file) => !existsSync(join(root, file)));
}

/**
 * Returns the forbidden files present under `root`.
 *
 * @param {string} root
 * @returns {Array<{ path: string, reason: string }>}
 */
export function collectForbiddenFiles(root) {
  return FORBIDDEN_FILES.filter((file) => existsSync(join(root, file.path)));
}

function main() {
  const root = resolve(import.meta.dirname, "..");
  const missing = collectMissingFiles(root);
  const forbidden = collectForbiddenFiles(root);

  for (const file of missing) {
    console.error(`✗ required file missing: ${file}`);
  }
  for (const file of forbidden) {
    console.error(`✗ forbidden file present: ${file.path} — ${file.reason}`);
  }

  if (missing.length > 0 || forbidden.length > 0) {
    console.error(`check-required-files: ${missing.length} missing, ${forbidden.length} forbidden`);
    process.exitCode = 1;
    return;
  }
  console.log("✓ every required file present, no forbidden files");
}

main();
