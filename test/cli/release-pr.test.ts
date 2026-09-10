/**
 * The release-pr door's CLI surface (issue #208): the grammar accepts the
 * command and the door refuses it by name — the unsupported band (65) —
 * until the Release PR lifecycle door (issue #202) is wired. The
 * subprocess fixtures prove the loud refusal's whole shape: exit 65,
 * stdout empty, stderr naming the carrier issue beside the synopsis.
 */

import { describe, expect, it } from "vitest";

import { UnsupportedFault, parseArgv } from "@ecoma-io/release-craft/__internal__/cli/parse.js";
import { executeReleasePr } from "@ecoma-io/release-craft/__internal__/cli/release-pr.js";
import { runCli } from "./harness.js";

const IDENTITY_ARGS = [
  "release-pr",
  "--assembly",
  "memory",
  "--world",
  "-",
  "--component",
  "lib-a",
  "--line",
  "main",
  "--target-branch",
  "main",
] as const;

describe("issue #208 — release-pr refuses loudly until the lifecycle door is wired", () => {
  it("the parsed invocation is well-formed — the refusal is the door's, not the grammar's", () => {
    const invocation = parseArgv([...IDENTITY_ARGS, "--json"]);
    expect(invocation.command).toBe("release-pr");
    if (invocation.command !== "release-pr") {
      throw new Error("the grammar accepts the spelling");
    }
    expect(invocation.identity).toStrictEqual({
      component: "lib-a",
      releaseLine: "main",
      targetBranch: "main",
    });
    expect(invocation.scopeLines).toStrictEqual([]);
  });

  it("scope-line repeats accumulate per-line selections", () => {
    const invocation = parseArgv([
      ...IDENTITY_ARGS,
      "--scope-line",
      "main",
      "--scope-line",
      "next",
    ]);
    if (invocation.command !== "release-pr") {
      throw new Error("the grammar accepts the spelling");
    }
    expect(invocation.scopeLines).toStrictEqual(["main", "next"]);
  });

  it("in process, the door throws the UnsupportedFault naming its carrier", () => {
    const invocation = parseArgv([...IDENTITY_ARGS, "--dry-run"]);
    if (invocation.command !== "release-pr") {
      throw new Error("the grammar accepts the spelling");
    }
    const fault = (() => {
      try {
        executeReleasePr(invocation);
      } catch (error) {
        return error as UnsupportedFault;
      }
      throw new Error("the door refuses");
    })();
    expect(fault.message).toContain("issue #202");
    expect(fault.message).toContain("issue #208");
    expect(fault).toBeInstanceOf(UnsupportedFault);
  });

  it("through the built bin: exit 65, stdout empty, the synopsis on stderr", () => {
    const child = runCli([...IDENTITY_ARGS, "--dry-run"]);
    expect(child.status).toBe(65);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("unsupported: release-pr");
    expect(child.stderr).toContain("issue #202");
  });
});
