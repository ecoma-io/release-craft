// Repository invariant: every GitHub Actions workflow keeps the security
// posture the bootstrap promised — least privilege, pinned actions, no
// untrusted-code write paths.
//
// The workflows are scanned as text rather than parsed YAML: every rule below
// is a line-shape or whole-file fact, a YAML dependency would be the gate's
// first runtime dependency, and a parser that must be perfect to be safe is
// worse than a scanner that is honest about what it sees. The rules:
//
//   - every `uses:` is pinned to a full 40-character commit SHA (a tag can be
//     moved; a digest cannot — Renovate keeps the `# vX.Y.Z` comment beside it
//     readable);
//   - `pull_request_target` appears on no executable line (it runs untrusted
//     PR code with repository secrets — the one trigger this repository must
//     never use). Comment lines are exempt: naming a forbidden thing in order
//     to explain that it is forbidden is documentation, and these files do
//     exactly that;
//   - no `permissions: write-all` anywhere, and every workflow declares a
//     top-level permissions block (an undeclared block inherits the job's
//     default token, which is whatever GitHub's default is that day);
//   - every `actions/checkout` step carries `persist-credentials: false`
//     (whole-file fact: the option lives on a following `with:` block);
//   - no `${{ secrets.* }}` interpolated directly into a `run:` line —
//     secrets travel through `env:`, where the shell cannot see them as code;
//   - every workflow declares a `concurrency` block (redundant runs are
//     cancelled by design, not by luck).
//
// Exit codes: 0 clean · 1 findings.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const WORKFLOWS_DIR = ".github/workflows";

/**
 * Judges one workflow's text. Pure, so the gate's own test can point it at
 * fixture strings.
 *
 * @param {string} source the workflow file's full text
 * @returns {string[]} one message per violation, empty when clean
 */
export function analyzeWorkflow(source) {
  /** @type {string[]} */
  const violations = [];
  const lines = source.split("\n");

  lines.forEach((line, index) => {
    const number = index + 1;
    // Comment lines are documentation — a workflow that teaches its reader
    // which trigger it refuses to use names the thing, and must be allowed to.
    // Every executable-shape rule below applies to non-comment lines only.
    const isComment = line.trimStart().startsWith("#");
    const uses = /^\s*(?:-+\s+)?uses:\s*(\S+)\s*(?:#.*)?$/.exec(line);
    if (uses) {
      const ref = uses[1];
      const at = ref === undefined ? -1 : ref.lastIndexOf("@");
      const digest = at === -1 || ref === undefined ? "" : ref.slice(at + 1);
      // A moved tag or branch is a supply-chain incident; a 40-character
      // commit SHA cannot move. Local composite actions (`uses: ./path`)
      // carry no @ref and are refused too — this repository has none.
      if (!/^[0-9a-f]{40}$/.test(digest)) {
        violations.push(
          `line ${number}: action "${ref}" is not pinned to a full 40-character commit SHA`,
        );
      }
    }
    if (!isComment && line.includes("pull_request_target")) {
      violations.push(
        `line ${number}: pull_request_target is forbidden — it runs untrusted PR code with repository credentials`,
      );
    }
    if (!isComment && /permissions:\s*write-all/.test(line)) {
      violations.push(`line ${number}: permissions "write-all" is forbidden — grant the minimum`);
    }
    if (!isComment && /run:.*\$\{\{\s*secrets\./.test(line)) {
      violations.push(
        `line ${number}: a secret is interpolated into run: — pass it through env: instead`,
      );
    }
  });

  if (!/^concurrency:/m.test(source)) {
    violations.push("no concurrency block — redundant runs are neither grouped nor cancelled");
  }
  if (!/^permissions:/m.test(source)) {
    violations.push("no top-level permissions block — the token scope is left to GitHub's default");
  }
  if (source.includes("actions/checkout@") && !/persist-credentials:\s*false/.test(source)) {
    violations.push(
      "an actions/checkout step does not set persist-credentials: false — the default leaks the token into the runner's git config",
    );
  }

  return violations;
}

function main() {
  const dir = resolve(import.meta.dirname, "..", WORKFLOWS_DIR);
  const files = readdirSync(dir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
  /** @type {string[]} */
  const violations = [];

  if (files.length === 0) {
    console.error(`✗ no workflows found under ${WORKFLOWS_DIR}`);
    process.exitCode = 1;
    return;
  }

  for (const file of files) {
    const source = readFileSync(join(dir, file), "utf8");
    for (const violation of analyzeWorkflow(source)) {
      violations.push(`${WORKFLOWS_DIR}/${file}: ${violation}`);
    }
  }

  for (const violation of violations) {
    console.error(`✗ ${violation}`);
  }
  if (violations.length > 0) {
    console.error(`check-workflow-safety: ${violations.length} violation(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${files.length} workflow(s) keep the security posture`);
}

main();
