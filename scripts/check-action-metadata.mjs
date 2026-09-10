// Repository invariant: the root action.yml — the GitHub Action front door —
// keeps the shape the phase 13 contract decided (§2.3's inventory, §2.6's
// pins, §2.8's empty token journey, §3.1's one output).
//
// The metadata is scanned as text rather than parsed YAML, the same posture
// as check-workflow-safety: every rule below is a line-shape or whole-file
// fact, a YAML dependency would be the gate's first runtime dependency, and
// a parser that must be perfect to be safe is worse than a scanner that is
// honest about what it sees. The rules:
//
//   - the file IS an action: a `name:`, a `description:`, and
//     `runs: using: composite` (§2.2 — the kind hermeticity decided);
//   - every `uses:` is pinned to a full 40-character commit SHA (a tag can
//     be moved; a digest cannot — the org's workflow law, one layer down);
//   - the toolchain is pinned by VALUE: a `node-version:` row and a
//     `version:` row must EXIST on executable lines (presence only — the
//     exact values are the artifact suite's to bind to this repository's
//     own `.node-version` / `packageManager`, so the pin has one
//     definition, not two), and the file-keyed mechanism
//     (`node-version-file`, `package_json_file`) appears on no executable
//     line (§2.2 — a file input cannot reach the materialized tree, and the
//     mangled join must stay unrepresentable, not merely unused);
//   - the input inventory is EXACTLY §2.3's eight rows, with the demanded
//     four `required: true` (no default — `actor` demanded, never inferred)
//     and the optional four each carrying a `default:` (§2.3);
//   - the refused inputs appear on no executable line (§2.3's closed
//     inventory: `assembly`, `command`, `token`, `json`, `declarations`,
//     `naming-module`, `target`);
//   - the token journey is empty (§2.8): no `actions/checkout`, no
//     `persist-credentials` row, no `${{ secrets.` interpolation, no
//     `GITHUB_TOKEN`/`GH_TOKEN` spelling, no `github.action_ref` (the
//     second-checkout spelling is unrepresentable);
//   - every `run:` step declares `shell: bash` and a `working-directory:`
//     of exactly the two the contract names (§2.7 — the Action's own tree
//     for provisioning, the declared input for the invocation);
//   - the install is frozen and runs no lifecycle scripts
//     (`pnpm install --frozen-lockfile --ignore-scripts`) — the lockfile is
//     the pin's reproducibility (§2.6), and the scripts-free row is the
//     materialization's (§2.2): the archive extraction carries no .git, so a
//     lifecycle script that assumes one cannot succeed there — the package's
//     own prepare died exactly that way in the first self-dogfood run
//     (34388697784);
//   - one output, `outcome`, declared over the invocation step (§3.1 — the
//     exposure plumbing `steps.<id>.outputs.outcome` presupposes), and no
//     shaped outputs beside it.
//
// Comment lines are exempt from the executable-shape rules, as in the
// workflow gate: these files teach their reader which mechanisms were
// refused and why, and naming a refused thing to explain the refusal is
// documentation.
//
// Exit codes: 0 clean · 1 findings.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ACTION_FILE = "action.yml";

/** §2.3's input inventory, row by row: the demanded four carry no default
 * (their omission must stop the step), the optional four each declare one. */
const DEMANDED_INPUTS = ["world", "line", "actor", "tag-namespaces"];
const OPTIONAL_INPUTS = ["intents", "repo", "max-retries", "working-directory"];

/** The invocation step's id — the one the `outputs:` declaration reads. */
const INVOKE_STEP_ID = "invoke";

/**
 * The executable lines of one metadata file: everything except comment
 * lines. A `run: |` block's contents are executable shell, not comments —
 * they are judged by the line-shape rules that apply to them.
 *
 * @param {string[]} lines
 * @returns {{ line: string, number: number }[]}
 */
function executableLines(lines) {
  /** @type {{ line: string, number: number }[]} */
  const result = [];
  let inRunBlock = false;
  lines.forEach((raw, index) => {
    const number = index + 1;
    const isComment = raw.trimStart().startsWith("#");
    if (/^\s*run:\s*\|/.test(raw)) {
      inRunBlock = true;
      result.push({ line: raw, number });
      return;
    }
    if (inRunBlock) {
      // A run block ends at the first line that is neither blank nor more
      // indented than the `run:` key itself (four spaces at this file's
      // shape). Its lines are shell — never exempt as comments.
      if (raw.trim().length > 0 && /^\s{8,}\S/.test(raw)) {
        result.push({ line: raw, number });
        return;
      }
      inRunBlock = false;
    }
    if (!isComment) {
      result.push({ line: raw, number });
    }
  });
  return result;
}

/**
 * Judges one action.yml's text. Pure, so the gate's own test can point it
 * at fixture strings.
 *
 * @param {string} source the action.yml full text
 * @returns {string[]} one message per violation, empty when clean
 */
export function analyzeActionMetadata(source) {
  /** @type {string[]} */
  const violations = [];
  const lines = source.split("\n");
  const executable = executableLines(lines);

  if (!/^name:\s*\S/m.test(source)) {
    violations.push("no name: — the action is unnamed");
  }
  if (!/^description:\s*\S/m.test(source)) {
    violations.push("no description: — the action is undocumented");
  }
  if (!/^runs:/m.test(source) || !/^\s+using:\s*composite\s*$/m.test(source)) {
    violations.push(
      'runs: does not declare "using: composite" — the contract decided the kind (§2.2)',
    );
  }

  // — the toolchain pins exist, by value (§2.2): presence on executable
  // lines only. The VALUES are not judged here — the artifact suite binds
  // them to this repository's own `.node-version` and `packageManager` and
  // goes red on drift, so the pin keeps one definition, not two.
  if (!executable.some(({ line }) => /^\s+node-version:\s*\S/.test(line))) {
    violations.push('no "node-version:" row — the node toolchain is not pinned by value (§2.2)');
  }
  if (!executable.some(({ line }) => /^\s+version:\s*\S/.test(line))) {
    violations.push('no "version:" row — the pnpm toolchain is not pinned by value (§2.2)');
  }

  for (const { line, number } of executable) {
    const uses = /^\s*(?:-+\s+)?uses:\s*(\S+)\s*(?:#.*)?$/.exec(line);
    if (uses) {
      const ref = uses[1];
      const at = ref === undefined ? -1 : ref.lastIndexOf("@");
      const digest = at === -1 || ref === undefined ? "" : ref.slice(at + 1);
      if (!/^[0-9a-f]{40}$/.test(digest)) {
        violations.push(
          `line ${number}: action "${ref}" is not pinned to a full 40-character commit SHA`,
        );
      }
    }
    // The file-keyed toolchain mechanism is unrepresentable, not unused:
    // neither name may appear on an executable line in any spelling.
    if (/\bnode-version-file\b/.test(line)) {
      violations.push(
        `line ${number}: node-version-file appears — the toolchain is pinned by value (§2.2)`,
      );
    }
    if (/package_json_file/.test(line)) {
      violations.push(
        `line ${number}: package_json_file appears — the toolchain is pinned by value (§2.2)`,
      );
    }
    if (/\$\{\{\s*secrets\./.test(line)) {
      violations.push(
        `line ${number}: a secret is interpolated — the token journey is empty (§2.8)`,
      );
    }
    if (/\b(?:GITHUB_TOKEN|GH_TOKEN)\b/.test(line)) {
      violations.push(`line ${number}: a token name appears — the token journey is empty (§2.8)`);
    }
    if (/github\.action_ref/.test(line)) {
      violations.push(
        `line ${number}: github.action_ref appears — the second checkout is refused (§2.7)`,
      );
    }
    if (/^\s*(?:-+\s+)?uses:\s*actions\/checkout/.test(line)) {
      violations.push(
        `line ${number}: an actions/checkout step appears — no checkout exists (§2.8)`,
      );
    }
    if (/persist-credentials\s*:/.test(line)) {
      violations.push(
        `line ${number}: persist-credentials appears — there is no checkout to carry the row (§2.8)`,
      );
    }
    for (const refused of [
      // — this surface's own closed grammar (§2.3): the Action drives
      // `run` alone, so its inputs never spell the CLI's cross-door
      // vocabulary —
      "assembly",
      "command",
      "token",
      "declarations",
      "naming-module",
      "target",
      // — release-please's vocabulary (issue #208): a workflow that
      // expects those inputs must get the runner's unknown-input refusal,
      // never a silently different release —
      "release-type",
      "draft-pull-request",
      "label",
      "target-branch",
      "bootstrap-sha",
      "last-release-sha",
      "initial-version",
      "package-name",
      "separate-pull-requests",
    ]) {
      if (new RegExp(`^\\s+${refused}:`).test(line)) {
        violations.push(`line ${number}: the refused input "${refused}" is declared (§2.3)`);
      }
    }
  }

  // — the input inventory, exactly §2.3's eight rows —
  const inputsStart = lines.findIndex((line) => /^inputs:\s*$/.test(line));
  const runsStart = lines.findIndex((line) => /^runs:\s*$/.test(line));
  // The block ends at the NEXT top-level key (outputs: sits between inputs:
  // and runs:), never at runs: itself.
  const inputsEnd = lines.findIndex(
    (line, index) => index > inputsStart && /^[a-z-]+:\s*$/.test(line),
  );
  if (inputsStart === -1 || inputsEnd <= inputsStart) {
    violations.push("no inputs: block — the inventory is undeclared");
  } else if (runsStart !== -1 && runsStart < inputsEnd) {
    violations.push("no inputs: block before runs: — the inventory is undeclared");
  } else {
    const block = lines.slice(inputsStart + 1, inputsEnd);
    /** @type {Record<string, string[]>} */
    const rows = {};
    let current = null;
    for (const line of block) {
      const key = /^ {2}([a-z-]+):\s*$/.exec(line);
      if (key?.[1] !== undefined) {
        current = key[1];
        rows[current] = [];
        continue;
      }
      if (current !== null && /^\s+/.test(line) && line.trim().length > 0) {
        rows[current]?.push(line.trim());
      }
    }
    const declared = Object.keys(rows).sort();
    const expected = [...DEMANDED_INPUTS, ...OPTIONAL_INPUTS].sort();
    for (const name of declared) {
      if (!expected.includes(name)) {
        violations.push(`input "${name}" is outside §2.3's inventory`);
      }
    }
    for (const name of expected) {
      if (!declared.includes(name)) {
        violations.push(`input "${name}" is missing from the inventory`);
      }
    }
    for (const name of DEMANDED_INPUTS) {
      const row = rows[name] ?? [];
      if (!row.includes("required: true")) {
        violations.push(`input "${name}" does not demand a value (required: true)`);
      }
      if (row.some((field) => field.startsWith("default:"))) {
        violations.push(
          `input "${name}" declares a default — the demanded inputs carry none (§2.3, §2.4)`,
        );
      }
    }
    for (const name of OPTIONAL_INPUTS) {
      const row = rows[name] ?? [];
      if (!row.some((field) => field.startsWith("default:"))) {
        violations.push(
          `input "${name}" declares no default — the optional inputs each carry one (§2.3)`,
        );
      }
    }
  }

  // — the run steps: bash, and one of the two declared working directories —
  // Steps split at the four-space `- ` item markers; the shell and the
  // working directory live anywhere inside their own step's block.
  const stepStarts = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^ {4}-\s/.test(line));
  for (let stepIndex = 0; stepIndex < stepStarts.length; stepIndex += 1) {
    const start = stepStarts[stepIndex]?.index ?? 0;
    const end = stepStarts[stepIndex + 1]?.index ?? lines.length;
    const step = lines.slice(start, end);
    const hasRun = step.some((line) => /^\s{6}run:\s/.test(line));
    if (!hasRun) {
      continue;
    }
    if (!step.some((line) => /^\s{6}shell:\s*bash\s*$/.test(line))) {
      violations.push(
        `line ${start + 1}: a run: step without "shell: bash" — the composite is written for bash (§2.2)`,
      );
    }
    const directory = step
      .map((line) => /^\s{6}working-directory:\s*(.+)$/.exec(line)?.[1] ?? "")
      .find((value) => value.length > 0);
    if (
      directory !== "${{ github.action_path }}" &&
      directory !== "${{ inputs.working-directory }}"
    ) {
      violations.push(
        `line ${start + 1}: a run: step's working-directory (${directory || "undeclared"}) is not one of the two declared roots (§2.7)`,
      );
    }
  }

  if (!/pnpm install --frozen-lockfile --ignore-scripts/.test(source)) {
    violations.push(
      "the install is not frozen-and-scripts-free — pnpm install --frozen-lockfile --ignore-scripts is absent (§2.2, §2.6)",
    );
  }

  // — one output, `outcome`, exposed over the invocation step (§3.1) —
  if (!/^\s+id:\s*invoke\s*$/m.test(source)) {
    violations.push(`no step carries "id: ${INVOKE_STEP_ID}" — the output has no source step`);
  }
  const outputsStart = lines.findIndex((line) => /^outputs:\s*$/.test(line));
  if (outputsStart === -1) {
    violations.push("no outputs: block — the outcome output is not exposed to consumers (§3.1)");
  } else {
    const outputsEnd = lines.findIndex(
      (line, index) => index > outputsStart && /^[a-z-]+:\s*$/.test(line),
    );
    const block = lines.slice(outputsStart + 1, outputsEnd === -1 ? lines.length : outputsEnd);
    const names = block
      .map((line) => /^ {2}([a-z-]+):\s*$/.exec(line)?.[1] ?? null)
      .filter((name) => name !== null);
    if (!(names.length === 1 && names[0] === "outcome")) {
      violations.push('the outputs block does not declare exactly one output, "outcome" (§3.1)');
    }
    if (
      !block.some((line) => /value:\s*\$\{\{\s*steps\.invoke\.outputs\.outcome\s*\}\}/.test(line))
    ) {
      violations.push(
        `the outcome output does not read steps.${INVOKE_STEP_ID}.outputs.outcome (§3.1)`,
      );
    }
  }

  return violations;
}

function main() {
  const file = resolve(import.meta.dirname, "..", ACTION_FILE);
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    console.error(`✗ ${ACTION_FILE} not found — the Action's front door is missing`);
    process.exitCode = 1;
    return;
  }

  const violations = analyzeActionMetadata(source);
  for (const violation of violations) {
    console.error(`✗ ${ACTION_FILE}: ${violation}`);
  }
  if (violations.length > 0) {
    console.error(`check-action-metadata: ${violations.length} violation(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${ACTION_FILE} keeps the contract's shape (inventory, pins, empty token journey)`);
}

main();
