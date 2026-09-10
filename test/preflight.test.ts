/**
 * The preflight's message contract (#144): when the built CLI is missing the
 * error must name the exact command that fixes it — otherwise the guard is
 * just another confusing failure.
 */
import { describe, expect, it } from "vitest";

import { missingBuildMessage } from "../globalSetup.js";

describe("the vitest preflight's actionable message", () => {
  it("names the build command that fixes the missing dist", () => {
    expect(missingBuildMessage("/repo/dist/src/cli/index.js")).toContain("`pnpm build`");
  });
});
