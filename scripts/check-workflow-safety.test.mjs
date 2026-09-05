// Tests for the workflow-safety gate. Each fixture is the smallest workflow
// text that exercises one rule — the fixtures ARE the threat model, written
// down.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { analyzeWorkflow } from "./check-workflow-safety.mjs";

/** @returns {string} */
function goodWorkflow() {
  return [
    "name: CI",
    "on:",
    "  pull_request:",
    "  push:",
    "    branches: [main]",
    "concurrency:",
    "  group: ci-${{ github.ref }}",
    "  cancel-in-progress: true",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  lint:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    "        with:",
    "          persist-credentials: false",
    "      - run: pnpm lint",
  ].join("\n");
}

describe("analyzeWorkflow", () => {
  it("accepts the posture every workflow must keep", () => {
    assert.deepEqual(analyzeWorkflow(goodWorkflow()), []);
  });

  it("refuses an action pinned to a tag instead of a SHA", () => {
    const source = goodWorkflow().replace(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
      "actions/checkout@v7",
    );

    assert.ok(analyzeWorkflow(source).some((v) => v.includes("40-character commit SHA")));
  });

  it("refuses a local action ref with no digest", () => {
    const source = `${goodWorkflow()}\n      - uses: ./action\n`;

    assert.ok(analyzeWorkflow(source).some((v) => v.includes("./action")));
  });

  it("refuses pull_request_target", () => {
    const source = goodWorkflow().replace("  pull_request:", "  pull_request_target:");

    assert.ok(analyzeWorkflow(source).some((v) => v.includes("pull_request_target")));
  });

  it("refuses pull_request_target in flow-list trigger form", () => {
    const source = goodWorkflow().replace(
      "  pull_request:",
      "  pull_request: # a real key stays caught either way",
    );
    const flow = goodWorkflow().replace(
      /on:[\s\S]*?branches: \[main\]\n/,
      "on: [push, pull_request_target]\n",
    );

    assert.ok(analyzeWorkflow(flow).some((v) => v.includes("pull_request_target")));
    assert.deepEqual(analyzeWorkflow(source), []);
  });

  it("allows a comment that names pull_request_target to explain its absence", () => {
    const source = goodWorkflow().replace(
      "name: CI",
      "name: CI\n# pull_request_target is forbidden here — and this sentence must not be a finding.",
    );

    assert.deepEqual(analyzeWorkflow(source), []);
  });

  it("refuses write-all permissions", () => {
    const source = goodWorkflow().replace("  contents: read", "  write-all: true");

    assert.deepEqual(analyzeWorkflow(goodWorkflow()), []);
    assert.ok(
      analyzeWorkflow(
        source.replace("permissions:\n  write-all: true", "permissions: write-all"),
      ).some((v) => v.includes("write-all")),
    );
  });

  it("refuses a workflow with no permissions block", () => {
    const source = goodWorkflow().replace("permissions:\n  contents: read\n", "");

    assert.ok(analyzeWorkflow(source).some((v) => v.includes("permissions block")));
  });

  it("refuses a workflow with no concurrency block", () => {
    const source = goodWorkflow().replace(/concurrency:[\s\S]*?cancel-in-progress: true\n/, "");

    assert.ok(analyzeWorkflow(source).some((v) => v.includes("concurrency")));
  });

  it("refuses a checkout that persists credentials", () => {
    const source = goodWorkflow().replace("          persist-credentials: false\n", "");

    assert.ok(analyzeWorkflow(source).some((v) => v.includes("persist-credentials")));
  });

  it("refuses a secret interpolated into a run line", () => {
    const source = goodWorkflow().replace(
      "      - run: pnpm lint",
      "      - run: echo ${{ secrets.TOKEN }}",
    );

    assert.ok(analyzeWorkflow(source).some((v) => v.includes("env:")));
  });
});
