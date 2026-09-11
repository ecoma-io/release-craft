/**
 * Unit tests for parsePnpmWorkspace — the pnpm-workspace.yaml subset
 * reader. Covers the accepted block/inline forms and every refusal class:
 * a manifest must declare `packages:` exactly once, as a non-empty
 * sequence of scalar globs, or the parser names the file and field and
 * refuses. No best-effort guessing is ever allowed silently through.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { parsePnpmWorkspace } from "@ecoma-io/release-craft/__internal__/adapters/node-workspace/pnpm-workspace.js";
import { WorkspaceDetectionError } from "@ecoma-io/release-craft/__internal__/adapters/node-workspace/types.js";
import { withTempWorkspace } from "./temp-workspace.js";

/** Runs `fn`, returning whatever it threw (or `undefined`). */
function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Parses the fixture's pnpm-workspace.yaml — one consistent call site for
 * every test, so the manifest path construction cannot drift. */
function parseIn(ws: { readonly root: string }): readonly string[] {
  return parsePnpmWorkspace(join(ws.root, "pnpm-workspace.yaml"));
}

describe("parsePnpmWorkspace — accepted forms", () => {
  it("reads block-sequence globs in declaration order", () => {
    withTempWorkspace("block", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages:\n  - packages/*\n  - apps/*\n  - tooling/**\n");
      expect(parseIn(ws)).toEqual(["packages/*", "apps/*", "tooling/**"]);
    });
  });

  it("accepts sequence items at column zero (valid YAML)", () => {
    withTempWorkspace("col0", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages:\n- a\n- b\n");
      expect(parseIn(ws)).toEqual(["a", "b"]);
    });
  });

  it("reads the inline [a, b] form", () => {
    withTempWorkspace("inline", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages: [packages/*, apps/*]\n");
      expect(parseIn(ws)).toEqual(["packages/*", "apps/*"]);
    });
  });

  it("strips matching single or double quotes from items", () => {
    withTempWorkspace("quoted", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages:\n  - \"packages/*\"\n  - 'apps/*'\n");
      expect(parseIn(ws)).toEqual(["packages/*", "apps/*"]);
    });
  });

  it("ignores comments, including one on the key line itself", () => {
    withTempWorkspace("comments", (ws) => {
      ws.write(
        "pnpm-workspace.yaml",
        "# owned by the platform group\npackages: # declared globs\n  - packages/* # one per line\n",
      );
      expect(parseIn(ws)).toEqual(["packages/*"]);
    });
  });

  it("keeps a # inside a quoted item (literal, not a comment)", () => {
    withTempWorkspace("hash", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages:\n  - 'a#b'\n");
      expect(parseIn(ws)).toEqual(["a#b"]);
    });
  });

  it("stops the sequence at the next top-level key", () => {
    withTempWorkspace("next-key", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages:\n  - a\ncatalog:\n  x: 1\n");
      expect(parseIn(ws)).toEqual(["a"]);
    });
  });

  it("requires the key to be exactly `packages`", () => {
    withTempWorkspace("exact-key", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages-x: 1\npackages-y: 2\n");
      const error = capture(() => parseIn(ws));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      expect((error as WorkspaceDetectionError).message).toMatch(/no `packages` key/);
    });
  });
});

describe("parsePnpmWorkspace — loud refusals", () => {
  it("refuses a missing `packages` key", () => {
    withTempWorkspace("no-key", (ws) => {
      ws.write("pnpm-workspace.yaml", "catalog:\n  x: 1\n");
      const error = capture(() => parseIn(ws));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      expect((error as WorkspaceDetectionError).field).toBe("packages");
      expect((error as WorkspaceDetectionError).message).toMatch(/no `packages` key/);
    });
  });

  it("refuses a duplicated `packages` key instead of choosing one", () => {
    withTempWorkspace("dup-key", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages:\n  - a\npackages:\n  - b\n");
      const error = capture(() => parseIn(ws));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      expect((error as WorkspaceDetectionError).field).toBe("packages");
      expect((error as WorkspaceDetectionError).message).toMatch(/more than once/);
    });
  });

  it("refuses an empty block sequence (`packages:` with nothing — YAML null)", () => {
    withTempWorkspace("empty-block", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages:\n");
      const error = capture(() => parseIn(ws));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      expect((error as WorkspaceDetectionError).message).toMatch(/sequence is empty/);
    });
  });

  it("refuses an empty inline sequence", () => {
    withTempWorkspace("empty-inline", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages: []\n");
      const error = capture(() => parseIn(ws));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      expect((error as WorkspaceDetectionError).message).toMatch(/sequence is empty/);
    });
  });

  it("refuses an unclosed inline sequence", () => {
    withTempWorkspace("unclosed", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages: [a\n");
      const error = capture(() => parseIn(ws));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      expect((error as WorkspaceDetectionError).message).toMatch(/not closed/);
    });
  });

  it("refuses an empty inline item (`a,,b`)", () => {
    withTempWorkspace("empty-item", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages: [a,,b]\n");
      const error = capture(() => parseIn(ws));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      expect((error as WorkspaceDetectionError).message).toMatch(/item is empty/);
    });
  });

  it("refuses a dangling dash item", () => {
    withTempWorkspace("dangling", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages:\n  -\n  - b\n");
      const error = capture(() => parseIn(ws));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      expect((error as WorkspaceDetectionError).message).toMatch(/item is empty/);
    });
  });

  it("refuses an indented line that is not a sequence item", () => {
    withTempWorkspace("indented-map", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages:\n  foo: bar\n");
      const error = capture(() => parseIn(ws));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      expect((error as WorkspaceDetectionError).message).toMatch(/expected a sequence item/);
    });
  });

  it("refuses a scalar value in place of the sequence", () => {
    withTempWorkspace("scalar", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages: tools\n");
      const error = capture(() => parseIn(ws));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      expect((error as WorkspaceDetectionError).message).toMatch(/expected a sequence after/);
    });
  });

  it("refuses an unreadable manifest and names the file", () => {
    const error = capture(() => parsePnpmWorkspace("/nonexistent/pnpm-workspace.yaml"));
    expect(error).toBeInstanceOf(WorkspaceDetectionError);
    expect((error as WorkspaceDetectionError).file).toBe("/nonexistent/pnpm-workspace.yaml");
    expect((error as WorkspaceDetectionError).field).toBe("(file)");
    expect((error as WorkspaceDetectionError).message).toMatch(/cannot read workspace manifest/);
  });
});
