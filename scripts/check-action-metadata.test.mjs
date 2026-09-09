// The gate's own suite (the repository's gates are plain .mjs — zero
// dependencies, `node --test`): every rule of check-action-metadata is
// judged against fixture strings, clean and violated, including the honest
// comment-line exemption (these files TEACH which mechanisms were refused —
// naming a refused input in a comment is documentation, not a declaration).
import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeActionMetadata } from "./check-action-metadata.mjs";

/** The clean fixture: the shape the contract decided, in full. */
const CLEAN = `# The release-craft GitHub Action (phase 13 contract).
#
# The header teaches the refusals: no checkout exists, no secret is read,
# the token journey is empty, the file-keyed toolchain mechanism
# (node-version-file / package_json_file) is unrepresentable, and the
# refused inputs (assembly, command, token, json, declarations,
# naming-module, target) have no rows here.
name: release-craft
description: Runs the release-craft engine's run door over a declared world.
inputs:
  world:
    required: true
    description: Path to the world document
  line:
    required: true
    description: Release line id to run
  actor:
    required: true
    description: Attribution string recorded on every record
  tag-namespaces:
    required: true
    description: Declared namespace roots, one per line
  intents:
    default: ""
    description: Operator intents, one per line
  repo:
    default: "."
    description: Repository path the binding walks
  max-retries:
    default: "0"
    description: Claim sequence retry bound
  working-directory:
    default: "\${{ github.workspace }}"
    description: Where the run stands
outputs:
  outcome:
    description: The run outcome's --json envelope, byte for byte
    value: \${{ steps.invoke.outputs.outcome }}
runs:
  using: composite
  steps:
    - name: Provision Node
      uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
      with:
        node-version: 24

    - name: Provision pnpm
      uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10
      with:
        version: 11.25.0

    - name: Install the lockfile
      shell: bash
      working-directory: \${{ github.action_path }}
      run: pnpm install --frozen-lockfile

    - name: Build the bin
      shell: bash
      working-directory: \${{ github.action_path }}
      run: pnpm exec tsc -p tsconfig.build.json

    - name: Invoke the run door
      id: invoke
      shell: bash
      working-directory: \${{ inputs.working-directory }}
      env:
        RC_WORLD: \${{ inputs.world }}
        RC_LINE: \${{ inputs.line }}
        RC_ACTOR: \${{ inputs.actor }}
        RC_TAG_NAMESPACES: \${{ inputs.tag-namespaces }}
        RC_INTENTS: \${{ inputs.intents }}
        RC_REPO: \${{ inputs.repo }}
        RC_MAX_RETRIES: \${{ inputs.max-retries }}
      run: |
        node "\${{ github.action_path }}/action/invoke.mjs" \\
          --bin "\${{ github.action_path }}/dist/src/cli/index.js" \\
          --outputs-file "$GITHUB_OUTPUT" \\
          --world "$RC_WORLD" \\
          --line "$RC_LINE" \\
          --actor "$RC_ACTOR" \\
          --tag-namespaces "$RC_TAG_NAMESPACES" \\
          --intents "$RC_INTENTS" \\
          --repo "$RC_REPO" \\
          --max-retries "$RC_MAX_RETRIES"
`;

test("the clean fixture passes with zero findings", () => {
  assert.deepEqual(analyzeActionMetadata(CLEAN), []);
});

test("an unpinned uses: is a finding", () => {
  const source = CLEAN.replace(
    "uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "uses: actions/setup-node@v7",
  );
  assert.ok(
    analyzeActionMetadata(source).some((violation) =>
      violation.includes("40-character commit SHA"),
    ),
  );
});

test("the file-keyed toolchain mechanism is refused on executable lines, named freely in comments", () => {
  const withRow = CLEAN.replace(
    "        node-version: 24",
    "        node-version-file: .node-version",
  );
  assert.ok(
    analyzeActionMetadata(withRow).some((violation) => violation.includes("node-version-file")),
  );
  const withPnpmRow = CLEAN.replace(
    "        version: 11.25.0",
    "        version: 11.25.0\n        package_json_file: package.json",
  );
  assert.ok(
    analyzeActionMetadata(withPnpmRow).some((violation) => violation.includes("package_json_file")),
  );
  assert.deepEqual(analyzeActionMetadata(CLEAN), []);
});

test("a secret interpolation, a token name, and the second-checkout spellings are findings", () => {
  const secreted = CLEAN.replace("RC_WORLD: ${{ inputs.world }}", "RC_WORLD: ${{ secrets.WORLD }}");
  assert.ok(analyzeActionMetadata(secreted).some((violation) => violation.includes("secret")));
  const tokened = CLEAN.replace("RC_ACTOR: ${{ inputs.actor }}", "RC_ACTOR: ${{ GITHUB_TOKEN }}");
  assert.ok(
    analyzeActionMetadata(tokened).some((violation) => violation.includes("token journey")),
  );
  const checkedOut = CLEAN.replace(
    "    - name: Provision Node",
    "    - name: Grab the tree\n      uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n    - name: Provision Node",
  );
  const checkedFindings = analyzeActionMetadata(checkedOut);
  assert.ok(checkedFindings.some((violation) => violation.includes("actions/checkout")));
  const persisted = checkedOut.replace(
    "      uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "      uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n      with:\n        persist-credentials: false",
  );
  assert.ok(
    analyzeActionMetadata(persisted).some((violation) => violation.includes("persist-credentials")),
  );
  const actionRef = CLEAN.replace(
    "working-directory: ${{ github.action_path }}\n      run: pnpm exec",
    "working-directory: ${{ github.action_ref }}\n      run: pnpm exec",
  );
  assert.ok(
    analyzeActionMetadata(actionRef).some((violation) => violation.includes("github.action_ref")),
  );
});

test("the refused inputs are findings; the inventory is closed", () => {
  const assembled = CLEAN.replace("inputs:\n", "inputs:\n  assembly:\n    default: git\n");
  assert.ok(analyzeActionMetadata(assembled).some((violation) => violation.includes('"assembly"')));
  const targeted = CLEAN.replace("inputs:\n", "inputs:\n  target:\n    default: m5\n");
  assert.ok(analyzeActionMetadata(targeted).some((violation) => violation.includes('"target"')));
});

test("a demanded input with a default, or an optional input without one, is a finding", () => {
  const defaultedActor = CLEAN.replace(
    "  actor:\n    required: true",
    "  actor:\n    required: true\n    default: someone",
  );
  assert.ok(
    analyzeActionMetadata(defaultedActor).some((violation) =>
      violation.includes('input "actor" declares a default'),
    ),
  );
  const bareIntents = CLEAN.replace('  intents:\n    default: ""', "  intents:");
  assert.ok(
    analyzeActionMetadata(bareIntents).some((violation) =>
      violation.includes('input "intents" declares no default'),
    ),
  );
  const undemandedWorld = CLEAN.replace(
    "  world:\n    required: true",
    "  world:\n    default: world.json",
  );
  const findings = analyzeActionMetadata(undemandedWorld);
  assert.ok(
    findings.some((violation) => violation.includes('input "world" does not demand a value')),
  );
  assert.ok(findings.some((violation) => violation.includes('input "world" declares a default')));
});

test("a missing inventory row is a finding", () => {
  const noMaxRetries = CLEAN.replace(
    / {2}max-retries:\n {4}default: "0"\n {4}description: Claim sequence retry bound\n/,
    "",
  );
  assert.ok(
    analyzeActionMetadata(noMaxRetries).some((violation) =>
      violation.includes('input "max-retries" is missing'),
    ),
  );
});

test("a run: step without bash, or with a foreign working-directory, is a finding", () => {
  const noShell = CLEAN.replace(
    "    - name: Build the bin\n      shell: bash\n",
    "    - name: Build the bin\n",
  );
  assert.ok(analyzeActionMetadata(noShell).some((violation) => violation.includes("shell: bash")));
  const foreignDirectory = CLEAN.replace(
    "      working-directory: ${{ inputs.working-directory }}\n      env:",
    "      working-directory: ${{ github.workspace }}\n      env:",
  );
  assert.ok(
    analyzeActionMetadata(foreignDirectory).some((violation) =>
      violation.includes("working-directory"),
    ),
  );
  const noDirectory = CLEAN.replace(
    "      working-directory: ${{ github.action_path }}\n      run: pnpm install",
    "      run: pnpm install",
  );
  assert.ok(
    analyzeActionMetadata(noDirectory).some((violation) => violation.includes("working-directory")),
  );
});

test("an unfrozen install is a finding", () => {
  const loose = CLEAN.replace("pnpm install --frozen-lockfile", "pnpm install");
  assert.ok(analyzeActionMetadata(loose).some((violation) => violation.includes("frozen")));
});

test("the output surface is exactly one outcome output over the invocation step", () => {
  const noOutputs = CLEAN.replace(/outputs:\n {2}outcome:[^\n]*\n[^\n]*\n[^\n]*\n/, "");
  assert.ok(
    analyzeActionMetadata(noOutputs).some((violation) => violation.includes("outputs: block")),
  );
  const shaped = CLEAN.replace(
    "    value: ${{ steps.invoke.outputs.outcome }}",
    "    value: ${{ steps.invoke.outputs.outcome }}\n  tag:\n    description: The tag\n    value: ${{ steps.invoke.outputs.outcome }}",
  );
  assert.ok(
    analyzeActionMetadata(shaped).some((violation) =>
      violation.includes('exactly one output, "outcome"'),
    ),
  );
  const noStepId = CLEAN.replace("      id: invoke\n", "");
  assert.ok(analyzeActionMetadata(noStepId).some((violation) => violation.includes("id: invoke")));
});

test("a non-composite kind is a finding", () => {
  const docker = CLEAN.replace("using: composite", "using: docker");
  assert.ok(analyzeActionMetadata(docker).some((violation) => violation.includes("composite")));
});
