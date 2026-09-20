// ---------------------------------------------------------------------------
// §2.9 — the claim-namespace fetch is the composite's own step, fail-closed
// ---------------------------------------------------------------------------
//
// The fetch-leg fixture pins the DECIDED mechanism at the Action surface:
// the composite materializes `refs/release-craft/claims/*` into the
// consumer's checkout before the invocation when the demanded `claims-fetch`
// input says so, and a failing fetch fails the step — the job never reaches
// the invocation, so no verdict exists (the register's CAS can only ever
// arbitrate the namespace a checkout actually holds; ADR-0011 D2, ADR-0010
// D3, issue #237).
//
// The harness drives `action/invoke.mjs` as a subprocess and never executes
// the composite's step list (that is the runner's territory), so the step
// transcript is asserted two ways: statically over the reviewed metadata
// (`ACTION_METADATA`, the exact file a consumer's `uses:` resolves), and
// behaviorally by executing the fetch step's own extracted `run:` shell line
// against real repositories — the two legs of the runner's behavior this
// surface's shape depends on.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ACTION_METADATA, INVOKE_SCRIPT, withScratchDir } from "./harness.js";

/** The composite's steps, in file order. */
const steps = ACTION_METADATA.split(/\n {4}- /).slice(1);
const fetchPosition = steps.findIndex((step) => step.startsWith("name: Fetch the claim namespace"));
const invokePosition = steps.findIndex((step) => step.startsWith("name: Invoke the run door"));

/** The fetch step's `run: |` block, de-indented — the exact shell the runner
 * would execute in the declared working-directory. */
function extractFetchRun(): string {
  const fetchStep = steps[fetchPosition] ?? "";
  const run = /run: \|\n((?: {8}[^\n]*\n)+)/.exec(fetchStep);
  expect(run).not.toBeNull();
  return (run?.[1] ?? "")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.slice(8))
    .join("\n")
    .trim();
}

describe("fixture: the claim-namespace fetch is a composite step before the invocation (transcript)", () => {
  it("the fetch step precedes the invocation step in the step list", () => {
    expect(fetchPosition).toBeGreaterThanOrEqual(0);
    expect(invokePosition).toBeGreaterThanOrEqual(0);
    expect(invokePosition).toBeGreaterThan(fetchPosition);
  });

  it("the fetch step gates on the declared spelling — the runner's skip is the only skip", () => {
    const fetchStep = steps[fetchPosition] ?? "";
    // The decided grammar: `"true"` fetches, every other spelling (the
    // declared `"false"` included) is the runner's skip arm — the input is
    // demanded with no default, so a skipped step is always an explicit
    // declaration in the consumer's own workflow, never a default that
    // took over silently (§2.9).
    expect(fetchStep).toContain("if: ${{ inputs.claims-fetch == 'true' }}");
    expect(fetchStep).not.toContain("||");
    expect(fetchStep).not.toContain("else");
  });

  it("the fetch step stands in the declared working-directory and fails loudly", () => {
    const fetchStep = steps[fetchPosition] ?? "";
    expect(fetchStep).toContain("shell: bash");
    expect(fetchStep).toContain("working-directory: ${{ inputs.working-directory }}");
    // Fail-closed: nothing may swallow the step's failure — no
    // continue-on-error, no shim, and the step reads no outputs (the only
    // output-ward step stays the invocation's).
    expect(fetchStep).not.toContain("continue-on-error:");
    expect(fetchStep).not.toMatch(/\bid:\s+\S+/);
  });

  it("the fetch step's run block is set -euo pipefail plus the one decided refspec line", () => {
    expect(extractFetchRun()).toBe(`set -euo pipefail
git fetch --no-tags origin '+refs/release-craft/claims/*:refs/release-craft/claims/*'`);
  });

  it("the invocation step follows intact — claims-fetch reaches no flag and no env row", () => {
    const invokeStep = steps[invokePosition] ?? "";
    expect(invokeStep).toContain("id: invoke");
    expect(invokeStep).toContain("--world");
    expect(invokeStep).toContain("--changelog");
    expect(invokeStep).not.toContain("claims-fetch");
    expect(invokeStep).not.toContain("RC_CLAIMS-FETCH");
    // The only `outcome` producer remains the invocation step — a failing
    // fetch means the step never ran, so no output exists: no verdict.
    expect(ACTION_METADATA).toContain("value: ${{ steps.invoke.outputs.outcome }}");
  });

  it("the fetch lives in the composite — the invocation script is not the fetch's home", () => {
    const script = readFileSync(INVOKE_SCRIPT, "utf8");
    expect(script).not.toContain("refs/release-craft/claims");
    expect(script).not.toMatch(/spawnSync\(\s*["'`]git/);
  });
});

describe("fixture: the fetch step's own line, executed (the runner's two legs)", () => {
  it("fail-closed: a fetch that cannot materialize the namespace fails the step — no run, no verdict", () => {
    withScratchDir((scratch) => {
      const consumer = join(scratch, "consumer");
      mkdirSync(consumer);
      execFileSync("git", ["init", "-q"], { cwd: consumer });
      // The checkout has no origin — the declared namespace is
      // unobservable from this checkout, and the step must refuse the run
      // rather than let the invocation proceed over an unclaimed-looking
      // namespace it never witnessed.
      let status = 0;
      let stderr = "";
      try {
        execFileSync("bash", ["-c", extractFetchRun()], { cwd: consumer });
      } catch (error) {
        // The child-process failure shape is node's documented
        // ExecFileException (status plus captured stderr), never external data.
        const failure = error as { status?: number; stderr?: string | Buffer };
        status = failure.status ?? -1;
        stderr = String(failure.stderr ?? "");
      }
      expect(status).not.toBe(0);
      expect(stderr).toContain("origin");
    });
  });

  it("when declared true, the step's line materializes origin's claim refs into the checkout", () => {
    withScratchDir((scratch) => {
      const origin = join(scratch, "origin.git");
      const consumer = join(scratch, "consumer");
      mkdirSync(consumer);
      execFileSync("git", ["init", "--bare", "-q", origin]);
      // One object the origin store must actually hold — written into it
      // (update-ref refuses an id the odb does not contain)...
      const tree = execFileSync("git", ["--git-dir", origin, "mktree"], {
        input: "",
      })
        .toString()
        .trim();
      const sha = execFileSync(
        "git",
        [
          "-c",
          "user.name=fixture",
          "-c",
          "user.email=fixture@example.com",
          "--git-dir",
          origin,
          "commit-tree",
          tree,
          "-m",
          "seed",
        ],
        { input: "" },
      )
        .toString()
        .trim();
      // ...so the shared ref space the register arbitrates (ADR-0011 D2)
      // can be seeded on the origin side only — a standard clone would
      // never carry it.
      execFileSync("git", [
        "--git-dir",
        origin,
        "update-ref",
        "refs/release-craft/claims/1.0",
        sha,
      ]);

      execFileSync("git", ["init", "-q"], { cwd: consumer });
      execFileSync("git", ["remote", "add", "origin", origin], { cwd: consumer });
      // Before the declared fetch, the checkout's ref space has no claim
      // refs — the two-checkout disjunction of #182 materialized.
      expect(
        execFileSync("git", ["for-each-ref", "--format=%(refname)"], { cwd: consumer })
          .toString()
          .trim(),
      ).toBe("");

      // The step's own line, executed:
      execFileSync("bash", ["-c", extractFetchRun()], { cwd: consumer });

      const refs = execFileSync("git", ["for-each-ref", "--format=%(refname)"], { cwd: consumer })
        .toString()
        .split("\n")
        .filter((line) => line.length > 0);
      expect(refs).toContain("refs/release-craft/claims/1.0");
    });
  });
});
