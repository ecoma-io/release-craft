/**
 * Unit tests for resolveWorkspaceGlob — workspace globs match DIRECTORIES
 * relative to the workspace root, and a matched directory with a
 * package.json is a member. Covers `*`, `**`, `?`, literal segments, the
 * node_modules exclusion, dot-directory posture, and every unsupported
 * pattern refusal (absolute patterns and glob metacharacters beyond the
 * subset).
 */
import { describe, expect, it } from "vitest";

import { resolveWorkspaceGlob } from "@ecoma-io/release-craft/__internal__/adapters/node-workspace/node-glob.js";
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

const PKG = (name: string): string => JSON.stringify({ name, version: "1.0.0" });

/** Resolves `pattern` against the fixture root, naming a synthetic source
 * file so refusals can be asserted deterministically. */
function resolveIn(ws: { readonly root: string }, pattern: string): readonly string[] {
  return resolveWorkspaceGlob(ws.root, pattern, "pnpm-workspace.yaml");
}

describe("resolveWorkspaceGlob — directory semantics", () => {
  it("matches a single `*` segment across sibling packages, sorted", () => {
    withTempWorkspace("star", (ws) => {
      ws.write("packages/a/package.json", PKG("a"));
      ws.write("packages/b/package.json", PKG("b"));
      ws.write("packages/not-a-package/readme.md", "");
      const matches = resolveIn(ws, "packages/*");
      expect(matches).toEqual([
        `${ws.root}/packages/a/package.json`,
        `${ws.root}/packages/b/package.json`,
      ]);
    });
  });

  it("treats the matched directory itself as the member (not the file path)", () => {
    withTempWorkspace("dir-member", (ws) => {
      ws.write("packages/core/package.json", PKG("core"));
      expect(resolveIn(ws, "packages/core")).toEqual([`${ws.root}/packages/core/package.json`]);
      expect(resolveIn(ws, "packages/core/package.json")).toEqual([]);
    });
  });

  it("requires the matched directory to contain a package.json", () => {
    withTempWorkspace("no-manifest", (ws) => {
      ws.write("packages/empty/readme.md", "");
      ws.write("packages/full/package.json", PKG("full"));
      expect(resolveIn(ws, "packages/*")).toEqual([`${ws.root}/packages/full/package.json`]);
    });
  });

  it("`**` crosses zero or more segments, deep and shallow alike", () => {
    withTempWorkspace("globstar", (ws) => {
      ws.write("packages/a/package.json", PKG("a"));
      ws.write("packages/a/nested/b/package.json", PKG("b"));
      ws.write("packages/c/package.json", PKG("c"));
      const matches = resolveIn(ws, "packages/**");
      expect(matches).toEqual([
        `${ws.root}/packages/a/package.json`,
        `${ws.root}/packages/a/nested/b/package.json`,
        `${ws.root}/packages/c/package.json`,
      ]);
    });
  });

  it("`?` matches exactly one character", () => {
    withTempWorkspace("qmark", (ws) => {
      ws.write("packages/p-a/package.json", PKG("p-a"));
      ws.write("packages/p-ab/package.json", PKG("p-ab"));
      expect(resolveIn(ws, "packages/p-?")).toEqual([`${ws.root}/packages/p-a/package.json`]);
    });
  });

  it("never traverses node_modules", () => {
    withTempWorkspace("nm", (ws) => {
      ws.write("packages/app/node_modules/hoisted/package.json", PKG("hoisted"));
      ws.write("node_modules/rooted/package.json", PKG("rooted"));
      ws.write("packages/app/package.json", PKG("app"));
      // `**` reaches every real package but never enters node_modules —
      // neither the root-level one nor a nested one.
      expect(resolveIn(ws, "**")).toEqual([`${ws.root}/packages/app/package.json`]);
      expect(resolveIn(ws, "packages/*/node_modules/*")).toEqual([]);
    });
  });

  it("`*` does not match dot-directories; an explicit dotted segment does", () => {
    withTempWorkspace("dot", (ws) => {
      ws.write("packages/.hidden/package.json", PKG("hidden"));
      ws.write("packages/visible/package.json", PKG("visible"));
      expect(resolveIn(ws, "packages/*")).toEqual([`${ws.root}/packages/visible/package.json`]);
      expect(resolveIn(ws, "packages/.*")).toEqual([`${ws.root}/packages/.hidden/package.json`]);
    });
  });

  it("the `.` pattern matches the root itself", () => {
    withTempWorkspace("root-dot", (ws) => {
      ws.write("package.json", PKG("root"));
      expect(resolveIn(ws, ".")).toEqual([`${ws.root}/package.json`]);
    });
  });

  it("matches nothing for a pattern with no hits (empty but legal)", () => {
    withTempWorkspace("no-hits", (ws) => {
      expect(resolveIn(ws, "apps/*")).toEqual([]);
    });
  });
});

describe("resolveWorkspaceGlob — loud refusals", () => {
  it("refuses absolute patterns (wrong-root hazard) naming the source file", () => {
    withTempWorkspace("absolute", (ws) => {
      ws.write("packages/a/package.json", PKG("a"));
      const error = capture(() => resolveWorkspaceGlob(ws.root, "/packages/*", "package.json"));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      expect((error as WorkspaceDetectionError).file).toBe("package.json");
      expect((error as WorkspaceDetectionError).message).toMatch(/absolute/);
    });
  });

  it.each(["packages/[ab]", "packages/{a,b}", "packages/a!", "packages/x,y"])(
    "refuses unsupported glob metacharacters in %s",
    (pattern) => {
      withTempWorkspace("metachar", (ws) => {
        const error = capture(() => resolveIn(ws, pattern));
        expect(error).toBeInstanceOf(WorkspaceDetectionError);
        expect((error as WorkspaceDetectionError).file).toBe("pnpm-workspace.yaml");
        expect((error as WorkspaceDetectionError).message).toMatch(
          /unsupported glob metacharacter/,
        );
      });
    },
  );
});
