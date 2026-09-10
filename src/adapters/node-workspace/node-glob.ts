/**
 * Minimal workspace glob resolver — matches pnpm/npm/yarn workspace glob
 * patterns against the filesystem to locate workspace member manifests.
 *
 * Workspace semantics: a pattern matches DIRECTORIES relative to the
 * workspace root; a matched directory that contains a `package.json` is a
 * member, and the resolver returns that manifest's path. This mirrors how
 * pnpm/yarn/npm interpret `packages/*`-style patterns (the pattern is the
 * package directory, never the manifest file).
 *
 * Supported subset: `*` (within one path segment), `**` (zero-or-more
 * segments), `?` (one character), literal segments. `node_modules` is never
 * traversed — judged on each candidate's RESOLVED path, so a symlink alias
 * into a hoisted tree is excluded exactly like the entry name would be —
 * symlinks are still followed to legitimate members, and no directory (nor
 * the root) is ever entered twice, which kills the symlink cycles that
 * would otherwise enumerate phantom members forever. A `*`/`?` segment does
 * not match dot-directories unless the pattern segment itself starts with
 * `.` — the standard glob posture, and the guard that keeps hoisted
 * dependency trees out of the workspace graph. Character classes, brace
 * expansion, and absolute patterns refuse loudly, naming the declaring
 * manifest — never best-effort, never silent.
 *
 * Gate: `check:package` (invariant 1: no runtime dependencies).
 */

import { existsSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { WorkspaceDetectionError } from "./types.js";

/**
 * Resolves one workspace glob pattern against the workspace root.
 *
 * @param root Absolute path to the workspace root the pattern is relative to.
 * @param pattern The glob pattern as declared in a workspace manifest.
 * @param sourceFile The manifest that declared the pattern — named in
 *   refusals so an operator can find the offending line.
 * @returns Matching member manifest paths (absolute), in filesystem walk
 *   order; empty when the pattern matches no directory containing a
 *   `package.json`.
 * @throws {WorkspaceDetectionError} when the pattern uses unsupported glob
 *   syntax or is absolute (an absolute pattern would silently ignore the
 *   workspace root — exactly the wrong-root failure mode).
 */
export function resolveWorkspaceGlob(
  root: string,
  pattern: string,
  sourceFile: string,
): readonly string[] {
  if (pattern.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pattern)) {
    throw new WorkspaceDetectionError({
      file: sourceFile,
      field: "packages",
      message: `pattern ${JSON.stringify(pattern)} is absolute — workspace globs must be relative to the workspace root`,
    });
  }
  for (const ch of pattern) {
    if (ch === "[" || ch === "]" || ch === "{" || ch === "}" || ch === "!" || ch === ",") {
      throw new WorkspaceDetectionError({
        file: sourceFile,
        field: "packages",
        message: `unsupported glob metacharacter ${JSON.stringify(ch)} in pattern ${JSON.stringify(pattern)}`,
      });
    }
  }

  const segments = pattern.split("/").filter((segment) => segment.length > 0);
  const manifests: string[] = [];
  // One resolved directory is entered at most once per pattern resolution:
  // statSync follows symlinks, so a cycle would loop forever and two names
  // for one real directory would enumerate its members twice. The root is
  // seeded so a symlink resolving back to it dies on entry.
  const visited = new Set<string>([resolveReal(root) ?? root]);
  // A manifest reached under two names (a symlinked member matched by two
  // branches of one pattern) is one member; keep the first-discovered path.
  const seenManifests = new Set<string>();
  walk(root, segments, 0, manifests, visited, seenManifests);
  return manifests;
}

/**
 * Depth-first walk interpreting the remaining pattern segments against a
 * concrete base directory. At the end of the pattern the base itself is
 * the candidate member directory: it must exist, be a directory, and
 * contain a `package.json`. `visited` holds the resolved paths of every
 * directory already entered (cycle guard); `seenManifests` holds the
 * resolved paths of already-emitted manifests (alias guard).
 */
function walk(
  base: string,
  segments: readonly string[],
  depth: number,
  out: string[],
  visited: Set<string>,
  seenManifests: Set<string>,
): void {
  const segment = segments[depth];
  if (segment === undefined) {
    // Pattern exhausted — the base directory is the member candidate.
    const manifest = join(base, "package.json");
    if (existsSync(manifest)) {
      const identity = resolveReal(manifest) ?? manifest;
      if (!seenManifests.has(identity)) {
        seenManifests.add(identity);
        out.push(manifest);
      }
    }
    return;
  }

  if (segment === ".") {
    // `.` is the current directory: consume the segment without descending.
    walk(base, segments, depth + 1, out, visited, seenManifests);
    return;
  }

  if (segment === "**") {
    // Zero segments consumed: the rest of the pattern applies at this level.
    walk(base, segments, depth + 1, out, visited, seenManifests);
    // One-or-more segments consumed: descend into every eligible child
    // directory and let `**` keep matching there.
    for (const child of listDirs(base, visited)) {
      walk(child, segments, depth, out, visited, seenManifests);
    }
    return;
  }

  for (const child of listDirs(base, visited)) {
    const name = basenameOf(child);
    if (matchesSegment(name, segment)) {
      walk(child, segments, depth + 1, out, visited, seenManifests);
    }
  }
}

/**
 * Lists the subdirectories of `base` that traversal may enter: existing
 * directories only; never `node_modules`, judged on the RESOLVED path so an
 * alias into a hoisted tree is excluded exactly like the entry name would
 * be; never a directory already entered under another name (symlink cycles
 * die here); and never a dot-directory (dot-directories are matched only by
 * an explicitly dotted pattern segment, judged by `matchesSegment` after
 * this listing).
 */
function listDirs(base: string, visited: Set<string>): readonly string[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(base).sort();
  } catch {
    return []; // Unreadable base — no candidates, not a crash.
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry === "node_modules") continue;
    const child = join(base, entry);
    const resolved = resolveReal(child);
    if (resolved === undefined) continue; // Dangling symlink or unreadable — no resolution, no candidate.
    if (isNodeModulesPath(resolved)) continue; // Alias into a hoisted tree.
    if (visited.has(resolved)) continue; // Cycle, or a second name for an entered directory.
    const stats = safeStat(child);
    if (stats !== undefined && stats.isDirectory()) {
      visited.add(resolved);
      dirs.push(child);
    }
  }
  return dirs;
}

/**
 * Whether one filename matches a single pattern segment. `*` matches any
 * run of characters within the segment, `?` exactly one; a segment without
 * metacharacters must equal the name. Dotted posture is symmetric: a
 * dot-directory only matches a dotted pattern segment, and vice versa.
 */
function matchesSegment(name: string, segment: string): boolean {
  const dotted = name.startsWith(".");
  const patternDotted = segment.startsWith(".");
  // The rule is symmetric: a dot-directory is matched only by a dotted
  // pattern segment, and a dotted pattern segment matches only
  // dot-directories (so `packages/.*` never picks up `visible`).
  if (dotted !== patternDotted) return false;

  if (!segment.includes("*") && !segment.includes("?")) return name === segment;

  let regex = "^";
  for (const ch of segment) {
    if (ch === "*") regex += ".*";
    else if (ch === "?") regex += ".";
    else if (/[A-Za-z0-9_-]/.test(ch)) regex += ch;
    else regex += `\\${ch}`; // `.` and any other punctuation stay literal.
  }
  return new RegExp(`${regex}$`).test(name);
}

/**
 * statSync guarded against races and broken symlinks: unreadable paths
 * yield `undefined` so a dangling entry filters out instead of crashing
 * the walk. (Shared by every existence judgment in this file.)
 */
function safeStat(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/**
 * realpathSync guarded like safeStat: a path that cannot be resolved (a
 * dangling symlink, a too-deep symlink cycle) yields `undefined` so the
 * caller filters the entry out instead of crashing the walk.
 */
function resolveReal(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Whether a RESOLVED path lies inside a `node_modules` directory anywhere
 * along its segments — the exclusion the entry-name check cannot see
 * through (`vendor -> node_modules` resolves into the hoisted tree).
 */
function isNodeModulesPath(resolved: string): boolean {
  for (const segment of resolved.split("/")) {
    if (segment === "node_modules") return true;
  }
  return false;
}

/** The final path segment of a joined child path. */
function basenameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}
