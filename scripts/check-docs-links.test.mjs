// Tests for the docs-integrity gate: fixture documents in a throwaway tree,
// asserting each rule fires on the drift it exists to catch and stays silent
// on honest documentation.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { auditMarkdown, collectHeadingSlugs, headingSlug } from "./check-docs-links.mjs";

/** @returns {{ root: string, dir: string }} */
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), "rc-docs-"));
  const dir = join(root, "docs");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "check-thing.mjs"), "// gate\n");
  writeFileSync(join(dir, "target.md"), "# Target\n\n## An anchor, here\n\nbody\n");
  return { root, dir };
}

describe("headingSlug", () => {
  it("slugs the way GitHub renders ASCII headings", () => {
    assert.equal(headingSlug("An anchor, here"), "an-anchor-here");
    assert.equal(headingSlug("  The moon.yml graph  "), "the-moonyml-graph");
  });
});

describe("collectHeadingSlugs", () => {
  it("collects every heading level", () => {
    const slugs = collectHeadingSlugs("# A\n\n## B\n\n### C");

    assert.deepEqual([...slugs].sort(), ["a", "b", "c"]);
  });
});

describe("auditMarkdown", () => {
  const scripts = new Set(["format", "check"]);

  it("accepts honest documentation", () => {
    const { root, dir } = makeTree();
    const violations = auditMarkdown(
      [
        "See [target](target.md#an-anchor-here) and [top](#top-of-this-page).",
        "",
        "# Top of this page",
        "",
        "Run `pnpm format`, `pnpm run check`, or `node scripts/check-thing.mjs`.",
        "Install with `pnpm install` and run any bin with `pnpm exec vitest`.",
      ].join("\n"),
      "docs/page.md",
      dir,
      root,
      scripts,
    );

    assert.deepEqual(violations, []);
  });

  it("refuses a link to a missing file", () => {
    const { root, dir } = makeTree();
    const violations = auditMarkdown("See [ghost](ghost.md).", "docs/page.md", dir, root, scripts);

    assert.deepEqual(violations, ["docs/page.md: link target does not exist: ghost.md"]);
  });

  it("refuses a broken anchor in another file", () => {
    const { root, dir } = makeTree();
    const violations = auditMarkdown(
      "See [target](target.md#no-such-heading).",
      "docs/page.md",
      dir,
      root,
      scripts,
    );

    assert.equal(violations.length, 1);
    assert.match(violations[0] ?? "", /broken anchor/);
  });

  it("refuses a bare anchor with no matching heading", () => {
    const { root, dir } = makeTree();
    const violations = auditMarkdown("[jump](#missing)", "docs/page.md", dir, root, scripts);

    assert.deepEqual(violations, ["docs/page.md: broken anchor #missing"]);
  });

  it("refuses a documented command that is not a script", () => {
    const { root, dir } = makeTree();
    const violations = auditMarkdown("Run `pnpm nonexistent`.", "docs/page.md", dir, root, scripts);

    assert.deepEqual(violations, [
      "docs/page.md: documents `pnpm nonexistent` — no such script in package.json",
    ]);
  });

  it("refuses a cited gate script that does not exist", () => {
    const { root, dir } = makeTree();
    const violations = auditMarkdown(
      "Run `node scripts/check-ghost.mjs`.",
      "docs/page.md",
      dir,
      root,
      scripts,
    );

    assert.equal(violations.length, 1);
    assert.match(violations[0] ?? "", /no such file/);
  });
});
