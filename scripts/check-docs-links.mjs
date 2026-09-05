// Repository invariant: the documentation does not lie about the repository.
//
// Three checks over every markdown file outside the generated trees:
//
//   1. Link targets resolve. A relative link (or image) must name a file that
//      exists; a `#fragment` — bare or after a path — must name a heading in
//      the target file, GitHub-slugged the way GitHub renders it.
//   2. Documented commands exist. A `pnpm <script>` or `pnpm run <script>`
//      literal in prose must name a script in package.json — the moment a
//      command is renamed, every page that still cites the old name fails
//      here instead of failing a contributor.
//   3. Cited gate scripts exist. A `node scripts/<file>.mjs` literal must
//      name a file on disk.
//
// `pnpm exec …`, `pnpm install` and the other package-manager subcommands are
// exempt: they resolve against bins and lifecycle, not the scripts map.
//
// Exit codes: 0 clean · 1 findings.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const SKIP_DIRECTORIES = new Set(["node_modules", ".git", ".moon", "dist", "coverage", ".claude"]);
const PACKAGE_MANAGER_SUBCOMMANDS = new Set([
  "add",
  "config",
  "dlx",
  "exec",
  "install",
  "remove",
  "rebuild",
  "store",
  "update",
]);

/**
 * GitHub's heading slug, approximated for ASCII headings: lowercase, drop
 * punctuation, spaces become hyphens. Every heading in this repository's
 * documents is ASCII, which is the boundary the approximation is honest
 * within — a non-ASCII heading that slugs differently would fail as a broken
 * anchor rather than pass as a false one (fail loud, not wrong).
 *
 * @param {string} heading
 * @returns {string}
 */
export function headingSlug(heading) {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

/**
 * Collects the slugs of every heading in a markdown document.
 *
 * @param {string} content
 * @returns {Set<string>}
 */
export function collectHeadingSlugs(content) {
  const slugs = new Set();
  for (const line of content.split("\n")) {
    const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (heading && heading[1] !== undefined) {
      slugs.add(headingSlug(heading[1]));
    }
  }
  return slugs;
}

/**
 * Lists every markdown file under `root`, skipping the generated trees.
 *
 * @param {string} root
 * @returns {string[]} paths relative to `root`
 */
export function collectMarkdownFiles(root) {
  /** @type {string[]} */
  const files = [];
  const walk = (/** @type {string} */ dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRECTORIES.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (extname(entry) === ".md") {
        files.push(relative(root, full).split("\\").join("/"));
      }
    }
  };
  walk(root);
  return files.sort();
}

/**
 * Audits one markdown document. Pure: all facts arrive as arguments, so the
 * gate's own test can point it at fixture strings.
 *
 * @param {string} content the document's text
 * @param {string} relativePath its repo-relative path, for messages
 * @param {string} absoluteDir the directory the document lives in
 * @param {string} root the repository root link targets resolve against
 * @param {ReadonlySet<string>} scripts package.json's script names
 * @returns {string[]} one message per violation, empty when clean
 */
export function auditMarkdown(content, relativePath, absoluteDir, root, scripts) {
  /** @type {string[]} */
  const violations = [];
  const ownSlugs = collectHeadingSlugs(content);

  // Links and images: [text](target "title?").
  const links = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of content.matchAll(links)) {
    const target = match[1];
    if (target === undefined) continue;
    if (/^(?:https?:|mailto:)/.test(target)) continue;

    if (target.startsWith("#")) {
      if (!ownSlugs.has(headingSlug(decodeURIComponent(target.slice(1))))) {
        violations.push(`${relativePath}: broken anchor ${target}`);
      }
      continue;
    }

    const hashIndex = target.indexOf("#");
    const pathPart = hashIndex === -1 ? target : target.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? undefined : target.slice(hashIndex + 1);
    const resolved = resolve(absoluteDir, decodeURIComponent(pathPart));
    if (!existsSync(resolved)) {
      violations.push(`${relativePath}: link target does not exist: ${target}`);
      continue;
    }
    if (fragment !== undefined) {
      const targetContent = readFileSync(resolved, "utf8");
      if (!collectHeadingSlugs(targetContent).has(headingSlug(decodeURIComponent(fragment)))) {
        violations.push(`${relativePath}: broken anchor in ${pathPart}: #${fragment}`);
      }
    }
    // A link that escapes the working tree resolves nowhere a reader is.
    if (!resolved.startsWith(root)) {
      violations.push(`${relativePath}: link escapes the repository: ${target}`);
    }
  }

  // Documented pnpm scripts: `pnpm <script>` or `pnpm run <script>`.
  const pnpmCommands = /`pnpm (?!exec\b|run\b)([\w:@/-]+)`|`pnpm run ([\w:@/-]+)`/g;
  for (const match of content.matchAll(pnpmCommands)) {
    const command = match[1] ?? match[2];
    if (command === undefined || PACKAGE_MANAGER_SUBCOMMANDS.has(command)) continue;
    if (!scripts.has(command)) {
      violations.push(
        `${relativePath}: documents \`pnpm ${command}\` — no such script in package.json`,
      );
    }
  }

  // Cited gate scripts: `node scripts/<file>.mjs`.
  const nodeScripts = /`node (scripts\/[\w./-]+\.mjs)`/g;
  for (const match of content.matchAll(nodeScripts)) {
    const cited = match[1];
    if (cited !== undefined && !existsSync(join(root, cited))) {
      violations.push(`${relativePath}: documents \`node ${cited}\` — no such file`);
    }
  }

  return violations;
}

function main() {
  const root = resolve(import.meta.dirname, "..");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const scripts = new Set(Object.keys(/** @type {object} */ (manifest["scripts"] ?? {})));
  /** @type {string[]} */
  const violations = [];

  for (const file of collectMarkdownFiles(root)) {
    const absolute = join(root, file);
    const content = readFileSync(absolute, "utf8");
    violations.push(...auditMarkdown(content, file, dirname(absolute), root, scripts));
  }

  for (const violation of violations) {
    console.error(`✗ ${violation}`);
  }
  if (violations.length > 0) {
    console.error(`check-docs-links: ${violations.length} violation(s)`);
    process.exitCode = 1;
    return;
  }
  console.log("✓ documentation links, anchors and commands all resolve");
}

main();
