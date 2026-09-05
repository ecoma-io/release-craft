// Tests for the pull-request-description gate. The fixtures are the two
// real bodies this gate exists for — #5's placeholder-filled, all-unchecked
// description — shrunk to their finding-bearing parts, plus the benign
// shapes that must stay clean (quoted scaffolding in a fenced block, real
// prose in every section).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { analyzePrDescription, withoutHtmlComments } from "./check-pr-description.mjs";

/**
 * A finalized body: every section written, no scaffolding, checklist ticked.
 *
 * @returns {string}
 */
function goodBody() {
  return [
    "## Description",
    "",
    "Materializes the first domain primitive, behind executable boundaries.",
    "",
    "## Type of change",
    "",
    "- [x] Product (release engine)",
    "",
    "## Could this fail silently?",
    "",
    "Yes — the boundary probes below each turned a gate red before being removed,",
    "so the enforcement is known to bite rather than to pass by construction.",
    "",
    "## How was this verified?",
    "",
    "`pnpm check` and `pnpm check:policy`, plus `moon ci --base` with the resolved",
    "targets recorded in the description.",
    "",
    "## Checklist",
    "",
    "- [x] `pnpm check` and `pnpm check:policy` pass locally",
    "- [x] No new runtime dependencies; no floating versions; lockfile unchanged",
  ].join("\n");
}

describe("analyzePrDescription", () => {
  it("accepts a finalized description", () => {
    assert.deepEqual(analyzePrDescription(goodBody()), []);
  });

  it("refuses the empty body — the template prefills, so emptiness is an erasure", () => {
    const violations = analyzePrDescription("");

    assert.ok(violations.some((v) => v.includes("description is empty")));
  });

  it("refuses a whitespace-only body the same as an empty one", () => {
    const violations = analyzePrDescription("   \n\n  ");

    assert.ok(violations.some((v) => v.includes("description is empty")));
  });

  it("refuses the #5 signature: a placeholder marker where the description should be", () => {
    const body = goodBody().replace(
      "Materializes the first domain primitive, behind executable boundaries.",
      "(To be finalized — the domain kernel work)",
    );

    assert.ok(analyzePrDescription(body).some((v) => v.includes("to be finalized")));
  });

  it("refuses every load-bearing section left unwritten", () => {
    for (const section of ["Description", "Could this fail silently?", "How was this verified?"]) {
      const body = goodBody().replace(`## ${section}\n`, "");

      assert.ok(
        analyzePrDescription(body).some((v) => v.includes(`"## ${section}" section is missing`)),
        `expected the gate to refuse a removed "## ${section}"`,
      );
    }
  });

  it("refuses a section that carries only its template comment", () => {
    const body = goodBody().replace(
      "Materializes the first domain primitive, behind executable boundaries.",
      '<!-- What changes, and why. Link the issue: "Closes #N". -->',
    );

    assert.ok(analyzePrDescription(body).some((v) => v.includes("HTML comment")));
  });

  it("refuses an unclosed comment opener — scaffolding either way", () => {
    const body = goodBody().replace(
      "Materializes the first domain primitive, behind executable boundaries.",
      "<!-- half a template comment, never closed",
    );

    assert.ok(analyzePrDescription(body).some((v) => v.includes("HTML comment")));
  });

  it("strips every opener, closed or not — no `<!--` survives the sanitizer", () => {
    // The property a complete sanitizer owes its callers: whatever goes in,
    // no comment opener can come out. The first input has a stray opener
    // *after* a closed comment (what paired-comment removal alone leaves
    // behind); the second nests one inside another.
    for (const text of [
      "fine <!-- closed --> then a stray <!-- never closed",
      "<!-- outer <!-- inner --> tail",
    ]) {
      assert.ok(!withoutHtmlComments(text).includes("<!--"), `opener survived: ${text}`);
    }
  });

  it("refuses a checklist left unchecked — the #5 merge precondition failure", () => {
    const body = goodBody()
      .replaceAll("- [x] `pnpm check`", "- [ ] `pnpm check`")
      .replaceAll("- [x] No new runtime dependencies", "- [ ] No new runtime dependencies");

    assert.ok(analyzePrDescription(body).some((v) => v.includes("unchecked task box")));
  });

  it("refuses a body that kept the whole template verbatim", () => {
    const body = [
      "## Description",
      "",
      '<!-- What changes, and why. Link the issue: "Closes #N". -->',
      "",
      "## Type of change",
      "",
      "- [ ] Foundation / tooling",
      "- [ ] Documentation",
      "- [ ] Governance (gates, workflows, rulesets)",
      "- [ ] Product (release engine — currently nothing lives here)",
      "",
      "## Could this fail silently?",
      "",
      "<!-- The standing question. ... -->",
      "",
      "## How was this verified?",
      "",
      "<!-- The commands you actually ran ... -->",
    ].join("\n");
    const violations = analyzePrDescription(body);

    assert.ok(violations.some((v) => v.includes("HTML comment")));
    assert.ok(violations.some((v) => v.includes("unchecked task box")));
  });

  it("exempts scaffolding quoted inside a fenced code block", () => {
    const body = [
      "## Description",
      "",
      "Adds the description gate. The template text it refuses looks like:",
      "",
      "```markdown",
      '<!-- What changes, and why. Link the issue: "Closes #N". -->',
      "- [ ] Foundation / tooling",
      "(To be finalized)",
      "```",
      "",
      "## Could this fail silently?",
      "",
      "The gate's own fixtures are the refusal cases, so a rule that stops firing",
      "fails the suite instead of the repository.",
      "",
      "## How was this verified?",
      "",
      "`pnpm check:policy` with a deliberately unfinished body passed through env.",
      "",
      "## Checklist",
      "",
      "- [x] `pnpm check` and `pnpm check:policy` pass locally",
    ].join("\n");

    assert.deepEqual(analyzePrDescription(body), []);
  });

  it("exempts the marker named in inline code — quoting a rule is not using it", () => {
    // Found live: this gate's own introduction PR was refused because its
    // prose described the `to be finalized` signature it enforces against.
    const body = goodBody().replace(
      "Materializes the first domain primitive, behind executable boundaries.",
      "Guards the failure class whose signature is `to be finalized` in prose.",
    );

    assert.deepEqual(analyzePrDescription(body), []);
  });

  it("still refuses the marker when it is raw prose, not quoted", () => {
    const body = goodBody().replace(
      "Materializes the first domain primitive, behind executable boundaries.",
      "The description is to be finalized in a follow-up edit.",
    );

    assert.ok(analyzePrDescription(body).some((v) => v.includes("to be finalized")));
  });

  it("reports every violation at once, not just the first", () => {
    const violations = analyzePrDescription("To be finalized");

    assert.ok(violations.some((v) => v.includes("description is empty")) === false);
    assert.ok(violations.length >= 3);
  });
});
