/**
 * Minimal pnpm-workspace.yaml parser — the D16 contract requires explicit
 * workspace evidence; this parser reads the `packages:` sequence from
 * pnpm's workspace manifest using a hand-rolled YAML subset (no runtime
 * dependencies).
 *
 * Supported subset: a top-level `packages:` key whose value is a sequence
 * of scalar strings (block form or inline `[a, b]` form). Comments (`#`),
 * quoted scalars, and other top-level keys are tolerated and ignored.
 * Anything outside the subset — a missing or duplicated `packages:` key,
 * an empty sequence, an unclosed inline sequence, an indented line that is
 * not a sequence item — produces a `WorkspaceDetectionError` naming the
 * file and field; never best-effort guessing, never silence.
 *
 * Gate: `check:package` (invariant 1: no runtime dependencies).
 */

import { readFileSync } from "node:fs";
import { WorkspaceDetectionError } from "./types.js";

/**
 * Reads and parses the `packages:` globs from a `pnpm-workspace.yaml` file.
 *
 * @param manifestPath Path to the pnpm-workspace.yaml file.
 * @returns The declared workspace globs in declaration order.
 * @throws {WorkspaceDetectionError} when the file cannot be read, the
 *   `packages:` key is missing or duplicated, or its value is not a
 *   non-empty sequence of scalars.
 */
export function parsePnpmWorkspace(manifestPath: string): readonly string[] {
  let content: string;
  try {
    content = readFileSync(manifestPath, "utf-8");
  } catch (error: unknown) {
    throw new WorkspaceDetectionError({
      file: manifestPath,
      field: "(file)",
      message:
        error instanceof Error
          ? `cannot read workspace manifest: ${error.message}`
          : "cannot read workspace manifest",
    });
  }

  const lines = content.split("\n");

  // Pass 1 — locate the `packages:` key: a non-indented line whose stripped
  // form is exactly `packages:` or `packages: …`. A key appearing twice is
  // a malformed manifest (a strict YAML parser would refuse it too), so the
  // parser refuses instead of picking first or last.
  let keyLineIndex = -1;
  for (const [index, raw] of lines.entries()) {
    if (raw.startsWith(" ") || raw.startsWith("\t")) continue;
    const stripped = stripComment(raw).trim();
    if (/^packages:(\s.*)?$/.test(stripped)) {
      if (keyLineIndex !== -1) {
        throw new WorkspaceDetectionError({
          file: manifestPath,
          field: "packages",
          message: "`packages` key is declared more than once",
        });
      }
      keyLineIndex = index;
    }
  }
  if (keyLineIndex === -1) {
    throw new WorkspaceDetectionError({
      file: manifestPath,
      field: "packages",
      message: "workspace manifest has no `packages` key",
    });
  }

  // Pass 2 — the key line's remainder decides the value form: `[…]` inline,
  // empty rest → block sequence, anything else → refused (a scalar or
  // nested mapping is not the declared sequence shape).
  const keyRest = stripComment(lines[keyLineIndex] ?? "")
    .trim()
    .slice("packages:".length)
    .trim();

  let rawItems: readonly string[];
  if (keyRest.startsWith("[")) {
    rawItems = parseInlineSequence(keyRest, manifestPath);
  } else if (keyRest.length === 0) {
    rawItems = collectBlockSequence(lines, keyLineIndex, manifestPath);
  } else {
    throw new WorkspaceDetectionError({
      file: manifestPath,
      field: "packages",
      message: `expected a sequence after \`packages:\`, found ${JSON.stringify(keyRest)}`,
    });
  }

  // One shared scalar site: strip optional matching quotes from every item.
  const globs: string[] = [];
  for (const rawItem of rawItems) {
    const first = rawItem.charAt(0);
    const last = rawItem.charAt(rawItem.length - 1);
    if (rawItem.length >= 2 && (first === '"' || first === "'") && first === last) {
      globs.push(rawItem.slice(1, -1));
    } else {
      globs.push(rawItem);
    }
  }
  return globs;
}

// ---------------------------------------------------------------------------
// Block-sequence collection
// ---------------------------------------------------------------------------

/**
 * Collects the block-sequence items that follow the `packages:` key line.
 * Blank and comment-only lines are skipped; a `- value` line at any
 * indentation is an item; a non-indented non-item line ends the sequence
 * (another top-level key follows); an indented non-item line is a malformed
 * shape and refuses. A sequence with zero items is `packages: null` in
 * YAML terms — refused, since the contract declares a sequence.
 */
function collectBlockSequence(
  lines: readonly string[],
  keyLineIndex: number,
  manifestPath: string,
): readonly string[] {
  const items: string[] = [];
  for (let index = keyLineIndex + 1; index < lines.length; index++) {
    const raw = lines[index] ?? "";
    const stripped = stripComment(raw).trim();
    if (stripped.length === 0) continue;

    const indented = raw.startsWith(" ") || raw.startsWith("\t");
    if (!stripped.startsWith("-")) {
      if (indented) {
        throw new WorkspaceDetectionError({
          file: manifestPath,
          field: `packages[${String(items.length)}]`,
          message: `expected a sequence item (\`- …\`), found ${JSON.stringify(stripped)}`,
        });
      }
      break; // The next top-level key — the declared sequence is complete.
    }

    const value = stripped.slice(1).trim();
    if (value.length === 0) {
      throw new WorkspaceDetectionError({
        file: manifestPath,
        field: `packages[${String(items.length)}]`,
        message: "sequence item is empty",
      });
    }
    items.push(value);
  }

  if (items.length === 0) {
    throw new WorkspaceDetectionError({
      file: manifestPath,
      field: "packages",
      message: "`packages` sequence is empty",
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Inline-flow form
// ---------------------------------------------------------------------------

function parseInlineSequence(keyRest: string, manifestPath: string): readonly string[] {
  if (!keyRest.endsWith("]")) {
    throw new WorkspaceDetectionError({
      file: manifestPath,
      field: "packages",
      message: "inline sequence is not closed (missing `]`)",
    });
  }
  const inner = keyRest.slice(1, -1).trim();
  if (inner.length === 0) {
    throw new WorkspaceDetectionError({
      file: manifestPath,
      field: "packages",
      message: "`packages` sequence is empty",
    });
  }
  const items: string[] = [];
  for (const piece of inner.split(",")) {
    const item = piece.trim();
    if (item.length === 0) {
      throw new WorkspaceDetectionError({
        file: manifestPath,
        field: `packages[${String(items.length)}]`,
        message: "inline sequence item is empty",
      });
    }
    items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

/**
 * Strips a YAML comment (`# …`) from a line, respecting quoted strings —
 * a `#` inside single or double quotes is literal content, not a comment.
 */
function stripComment(line: string): string {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let index = 0; index < line.length; index++) {
    const ch = line.charAt(index);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
    else if (ch === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
    else if (ch === "#" && !inSingleQuote && !inDoubleQuote) return line.slice(0, index);
  }
  return line;
}
