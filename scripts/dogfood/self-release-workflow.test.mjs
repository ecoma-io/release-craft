// The self-release workflow's own law (#259), pinned as text shapes over
// the real file — the same scan posture the workflow-safety gate uses, at
// the rows that are THIS workflow's law rather than every workflow's:
// dispatch-only trigger (the dogfood's law: a release surface must never
// mint on a push or PR trigger), the demanded declared posture, the
// no-cancel concurrency group, the minimum contents:write token, the
// credential's env-only channel, the always()-guarded evidence and
// judgment steps, and an invocation whose `with:` keys are exactly the
// Action's declared eight (the closed inventory #191/#252 refuse outside
// the metadata; a workflow that misspelled a key would be refused too —
// but only after a runner burned finding out).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const WORKFLOW = readFileSync(
  new URL("../../.github/workflows/self-release.yml", import.meta.url),
  "utf8",
);

/** The workflow with all comment lines removed — the executable shape. */
const executable = WORKFLOW.split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

/**
 * The file's lines from the first top-level `key:` at column 0 to the next
 * one — one top-level block, comments included.
 *
 * @param {string} key the block's key
 * @returns {string}
 */
function topLevelBlock(key) {
  const lines = WORKFLOW.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  assert.notEqual(start, -1, `no top-level "${key}:" block`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = /** @type {string} */ (lines[index]);
    if (/^[A-Za-z-]+:/.test(line)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * One step's block: from its `- name: <name>` line to the next step.
 *
 * @param {string} name the step's name
 * @returns {string}
 */
function stepBlock(name) {
  const lines = executable.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `no step named "${name}"`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = /** @type {string} */ (lines[index]);
    if (/^\s+- (name|uses):/.test(line)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("the self-release workflow's law", () => {
  it("is dispatch-only — a release surface never mints on a push or PR trigger", () => {
    const on = topLevelBlock("on");
    assert.match(on, /^on:\n/m);
    assert.match(on, /^\s{2}workflow_dispatch:\n/m);
    // the forbidden triggers appear on no executable line (comments may
    // name them to say why they are refused)
    assert.doesNotMatch(executable, /^\s*(push|pull_request|pull_request_target|schedule):/m);
  });

  it("demands the declared posture — expect-kind has no default to guess with", () => {
    const on = topLevelBlock("on");
    assert.match(on, /expect-kind:/);
    assert.match(on, /required: true/);
    assert.doesNotMatch(on, /default:/);
  });

  it("serializes dispatches without cancelling — the second conflict is evidence", () => {
    const concurrency = topLevelBlock("concurrency");
    assert.match(concurrency, /group:/);
    assert.match(concurrency, /cancel-in-progress: false/);
  });

  it("grants the minimum a mint needs: contents write, and only contents", () => {
    const permissions = topLevelBlock("permissions")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    assert.match(permissions, /contents: write/);
    assert.doesNotMatch(permissions, /id-token|packages|actions:|pull-requests|issues|deployments/);
  });

  it("persists no credentials and loads full history on the checkout", () => {
    const checkout = stepBlock("Check out the repository the run releases");
    assert.match(checkout, /persist-credentials: false/);
    assert.match(checkout, /fetch-depth: 0/);
  });

  it("the token travels through env:, never a run: interpolation", () => {
    const publish = stepBlock("Publish the mint to origin");
    assert.match(publish, /RC_TOKEN: \$\{\{ github\.token \}\}/);
    // no executable line composes a run: from the token — the gate's own
    // law (secrets travel through env:), pinned here for the github.token
    // spelling the gate does not scan for
    assert.doesNotMatch(executable, /run:.*github\.token/);
  });

  it("captures the evidence and runs both judges under if: always()", () => {
    for (const step of [
      "Publish the mint to origin",
      "Capture the evidence",
      "Judge the captured classes",
      "Verify the run's claims against origin",
    ]) {
      assert.match(
        stepBlock(step).split("\n")[1] ?? "",
        /if: always\(\)/,
        `"${step}" is not guarded by always()`,
      );
    }
  });

  it("judges the declared posture explicitly and verifies origin in-job", () => {
    const judge = stepBlock("Judge the captured classes");
    assert.match(judge, /scripts\/dogfood\/judge\.mjs/);
    assert.match(judge, /--expect-kind "\$EXPECT_KIND"/);
    assert.match(judge, /--actor "\$ACTOR"/);
    const verify = stepBlock("Verify the run's claims against origin");
    assert.match(verify, /scripts\/dogfood\/verify-origin\.mjs/);
    assert.match(verify, /--expect-origin "\$EXPECT_ORIGIN"/);
  });

  it("publishes through the caller-side script, never an undeclared Action input", () => {
    const publish = stepBlock("Publish the mint to origin");
    assert.match(
      publish,
      /scripts\/dogfood\/publish-mint\.mjs --local-before local-refs-before\.txt/,
    );
  });

  it("invokes the run door pinned at a full 40-character SHA", () => {
    const invoke = stepBlock("Invoke the run door");
    const uses = /uses:\s*ecoma-io\/release-craft@([0-9a-f]{40})\s*$/m.exec(invoke);
    assert.notEqual(uses, null, "the run door is not pinned to a full 40-character SHA");
  });

  it("passes exactly the Action's eight declared inputs — none invented, none misspelled", () => {
    const invoke = stepBlock("Invoke the run door");
    const withBlock = invoke.split(/with:\n/)[1] ?? "";
    const keys = [...withBlock.matchAll(/^\s{10}([a-z-]+):/gm)].map((match) => match[1]);
    assert.deepEqual(keys.sort(), [
      "actor",
      "intents",
      "line",
      "max-retries",
      "repo",
      "tag-namespaces",
      "world",
      // working-directory stays at its declared default — the eight names
      // phase 13 §2.3 declares, and nothing beside them
    ]);
  });
});
