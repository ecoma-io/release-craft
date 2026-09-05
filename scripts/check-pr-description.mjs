// Repository invariant: a pull request's description is finalized before the
// pull request can be green — it is the review's primary input, and the
// squash merge turns it into permanent history.
//
// This gate exists because the failure it guards already happened once:
// #5 merged green with a body that still read "(To be finalized — …)" and a
// checklist with every box unchecked, claiming an implemented domain kernel
// while its diff changed nothing (filed as #6, which observed that no layer
// verified either condition). The placeholders are now executable findings.
//
// What is judged — the body as it stood at the last push (GitHub triggers
// `pull_request` on open and push, never on description edits, so an edit
// after the last commit re-judges only on the next push; the title check in
// this workflow carries the identical semantics):
//
//   - an empty body is a finding (the template is prefilled on open — an
//     empty body is a deliberate erasure);
//   - the three template sections a reviewer reads first — Description,
//     "Could this fail silently?", "How was this verified?" — must exist and
//     carry at least one line of their own (blank lines and HTML comments
//     are not content);
//   - no HTML comment may remain outside quoted material, closed or not —
//     the template's instructions are comments, and a comment left in
//     place marks the section it sits in as unwritten;
//   - no placeholder marker (`to be finalized`) outside quoted material
//     — the observed #5 signature, kept as data so new observed markers
//     extend the list instead of forking rules;
//   - no unchecked task box (`- [ ]`) outside quoted material — a merge
//     precondition per CONTRIBUTING.md is not left unticked.
//
// Fenced code blocks and inline code spans are exempt throughout: quoting
// the template, or naming the marker a rule refuses, is evidence, not
// scaffolding — found live, when this gate's own introduction PR was
// refused for describing the signature it enforces against.
//
// Run context: the policy workflow passes the body through `env:`
// (`PR_BODY`), never interpolated into the script source. With `PR_BODY`
// unset — a local `pnpm check:policy`, or any non-pull-request run — there is
// no body to judge and the gate exits 0 with a note; it never invents a
// verdict about a subject it cannot see.
//
// Exit codes: 0 clean (or no context) · 1 findings.
import { env } from "node:process";

/**
 * Sections a reviewer must be able to read. Each name is matched against
 * `##` headings, case-sensitively — they are the template's own wording.
 *
 * @type {string[]}
 */
const REQUIRED_SECTIONS = ["Description", "Could this fail silently?", "How was this verified?"];

/**
 * Placeholder strings whose presence marks the description as unfinished.
 * Grown only from observed merge failures, never speculatively.
 *
 * @type {string[]}
 */
const PLACEHOLDER_MARKERS = ["to be finalized"];

/**
 * Strips fenced code blocks, keeping the line count stable so
 * heading-based section parsing still sees the document's shape.
 *
 * @param {string} body
 * @returns {string}
 */
function withoutFencedBlocks(body) {
  let insideFence = false;
  return body
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        insideFence = !insideFence;
        return "";
      }
      return insideFence ? "" : line;
    })
    .join("\n");
}

/**
 * Removes HTML comments (multi-line included) and everything after an
 * unclosed `<!--` — which is how a renderer reads it: a comment with no
 * end swallows the rest of the document. Paired-comment removal runs to a
 * fixpoint because removing one comment can splice new text together, and
 * truncation guarantees the result contains no opener at all, so no
 * hazard survives the sanitizer for any future caller that would render
 * its result. The scaffolding rule needs openers detected while they are
 * still there; this function is what the content rules run on after.
 *
 * @param {string} text
 * @returns {string}
 */
export function withoutHtmlComments(text) {
  let withoutClosed = text;
  let previous = null;
  while (withoutClosed !== previous) {
    previous = withoutClosed;
    withoutClosed = withoutClosed.replace(/<!--[\s\S]*?-->/g, "");
  }
  const firstOpener = withoutClosed.indexOf("<!--");
  return firstOpener === -1 ? withoutClosed : withoutClosed.slice(0, firstOpener);
}

/**
 * Removes inline code spans, replaced by a non-empty stub so a section
 * whose only content is a quoted string still counts as having content.
 * Same exemption as fences, at quote size.
 *
 * @param {string} text
 * @returns {string}
 */
function withoutInlineCode(text) {
  return text.replace(/`[^`\n]*`/g, '""');
}

/**
 * The section's own text, from its `##` heading to the next heading of any
 * level, or the end of the document.
 *
 * @param {string} body body with fences and comments already removed
 * @param {string} name
 * @returns {string} the section body, possibly empty
 */
function sectionText(body, name) {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${name}`);
  if (start === -1) {
    return "";
  }
  const end = lines.findIndex((line, index) => index > start && /^#{1,6}\s/.test(line));
  return lines.slice(start + 1, end === -1 ? lines.length : end).join("\n");
}

/**
 * Judges one pull-request body. Pure, so the gate's own test can point it at
 * fixture strings.
 *
 * @param {string} body the pull-request description, verbatim
 * @returns {string[]} one message per violation, empty when clean
 */
export function analyzePrDescription(body) {
  /** @type {string[]} */
  const violations = [];

  if (body.trim() === "") {
    violations.push(
      "the pull request description is empty — the template prefills it, so emptiness is an erasure",
    );
    return violations;
  }

  const quoted = withoutInlineCode(withoutFencedBlocks(body));
  const bare = withoutHtmlComments(quoted);

  for (const name of REQUIRED_SECTIONS) {
    const text = sectionText(bare, name);
    if (text.trim() === "") {
      violations.push(
        `the "## ${name}" section is missing or empty — it is load-bearing review input (CONTRIBUTING.md)`,
      );
    }
  }

  if (/<!--/.test(quoted)) {
    violations.push(
      "an HTML comment (or unclosed comment opener) remains in the description — template instructions left in place mark their section as unwritten",
    );
  }

  for (const marker of PLACEHOLDER_MARKERS) {
    if (bare.toLowerCase().includes(marker)) {
      violations.push(
        `the description carries the placeholder marker "${marker}" — the observed signature of a body that was never finalized (#5, #6)`,
      );
    }
  }

  if (/(^|\n)\s*-\s*\[ \]/.test(bare)) {
    violations.push(
      "an unchecked task box remains (`- [ ]`) — the template's checklist is a merge precondition, not a suggestion",
    );
  }

  return violations;
}

function main() {
  const body = env["PR_BODY"];
  if (body === undefined) {
    console.log("check-pr-description: no pull request context (PR_BODY unset) — nothing to judge");
    return;
  }

  const violations = analyzePrDescription(body);
  for (const violation of violations) {
    console.error(`✗ ${violation}`);
  }
  if (violations.length > 0) {
    console.error(`check-pr-description: ${violations.length} violation(s)`);
    process.exitCode = 1;
    return;
  }
  console.log("✓ the pull request description is finalized");
}

main();
