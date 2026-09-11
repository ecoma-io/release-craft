// Tests for the required-files gate: the fixtures are throwaway trees, so the
// gate is judged on real filesystem facts rather than on the live repository
// (which would make the test a mirror of the gate's own list).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { collectForbiddenFiles, collectMissingFiles } from "./check-required-files.mjs";

function makeTree(/** @type {Record<string, string>} */ files) {
  const root = mkdtempSync(join(tmpdir(), "rc-required-files-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe("collectMissingFiles", () => {
  it("reports a required file that is absent", () => {
    const root = makeTree({ "README.md": "x", "package.json": "{}" });
    try {
      const missing = collectMissingFiles(root);

      assert.ok(missing.includes("AGENTS.md"));
      assert.ok(!missing.includes("README.md"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports nothing for a tree that has a required file", () => {
    const root = makeTree({ "docs/bootstrap/ecosystem-analysis.md": "x" });
    try {
      assert.ok(!collectMissingFiles(root).includes("docs/bootstrap/ecosystem-analysis.md"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("collectForbiddenFiles", () => {
  it("flags a root archkeep.json in a Moon workspace", () => {
    const root = makeTree({ "archkeep.json": "{}" });
    try {
      const forbidden = collectForbiddenFiles(root);

      assert.equal(forbidden.length, 1);
      assert.equal(forbidden[0]?.path, "archkeep.json");
      assert.match(forbidden[0]?.reason ?? "", /\.moon/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is silent when no forbidden file exists", () => {
    const root = makeTree({ "README.md": "x" });
    try {
      assert.deepEqual(collectForbiddenFiles(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
