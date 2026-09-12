/**
 * Node workspace detection — the adapter that reads workspace manifests
 * (pnpm `packages:`, npm/yarn `workspaces:`) and member package.json files
 * to produce the declared workspace graph, plus the trivial conversion to
 * `ComponentMeta[]` that feeds `planPropagation` and the updater.
 *
 * This adapter is sugar: a repository with no explicit workspace evidence
 * returns `null`, and hand-declared `ComponentMeta[]` remains the
 * first-class fallback (never suppressed, never overwritten). The output
 * contract is pure data, so the app layer composes `PlanningInput` at
 * merge time without re-detecting anything.
 *
 * Every refusal is loud and names the source file and field: missing or
 * duplicated manifest keys, empty sequences, unsupported glob syntax,
 * unknown range variants (outside the D16 `^`/`~`/exact grammar),
 * duplicate member names, and a member dependency naming the workspace
 * root package (the root is not a member, so no edge can represent it)
 * refuse at detection time — never best-effort, never silent.
 *
 * Gate: `check:package` (invariant 1: no runtime dependencies).
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Version } from "@ecoma-io/release-craft/domain";
import type { ComponentMeta } from "@ecoma-io/release-craft/planner";
import { parsePnpmWorkspace } from "./pnpm-workspace.js";
import { resolveWorkspaceGlob } from "./node-glob.js";
import {
  WorkspaceDetectionError,
  type DetectedWorkspace,
  type WorkspaceDependencyKind,
  type WorkspaceEdge,
  type WorkspaceMember,
} from "./types.js";

/** The D16 dependency fields that release-propagate. Dev-only edges are
 * real workspace edges (the updater sees them) but never propagate a
 * release, so they are excluded from the `ComponentMeta` conversion. */
const PROPAGATING_KINDS: readonly WorkspaceDependencyKind[] = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
];

const ALL_KINDS: readonly WorkspaceDependencyKind[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

// ---------------------------------------------------------------------------
// Detection entry point
// ---------------------------------------------------------------------------

/**
 * Detects the Node workspace graph rooted at `root`.
 *
 * Detection order:
 *   1. `pnpm-workspace.yaml` declaring a `packages:` sequence.
 *   2. `workspaces` in the root `package.json` (npm array form, yarn
 *      `{ packages: [...] }` form).
 *
 * @param root Absolute path to the workspace root directory.
 * @returns The detected workspace graph, or `null` when neither source
 *   declares workspace evidence — the caller then falls through to
 *   hand-declared components.
 * @throws {WorkspaceDetectionError} when evidence exists but is malformed,
 *   a glob uses unsupported syntax, a member manifest is unreadable or
 *   incomplete, a member name is duplicated, a member dependency names the
 *   workspace root package, or an edge range is outside the D16 grammar.
 */
export function detectNodeWorkspace(root: string): DetectedWorkspace | null {
  const patterns = readWorkspacePatterns(root);
  if (patterns.length === 0) return null;

  const manifests = discoverManifests(root, patterns);
  if (manifests.length === 0) {
    throw new WorkspaceDetectionError({
      file: patterns[0]?.sourceFile ?? "(workspace)",
      field: "packages",
      message: "workspace globs matched no directory containing a package.json",
    });
  }

  const rootPackageName = readRootPackageName(join(root, "package.json"));
  const members = buildMembers(root, manifests, rootPackageName);
  return { root, members };
}

// ---------------------------------------------------------------------------
// Workspace evidence reading (pnpm, then npm/yarn)
// ---------------------------------------------------------------------------

/** A glob pattern plus the manifest that declared it (named in refusals). */
interface WorkspacePattern {
  readonly glob: string;
  readonly sourceFile: string;
}

function readWorkspacePatterns(root: string): readonly WorkspacePattern[] {
  // Evidence 1 — pnpm-workspace.yaml. A missing file (field `(file)`, the
  // read error names ENOENT) or a settings-only manifest without a
  // `packages:` key is "no evidence here", so detection falls through to
  // the root package.json. Every other malformation refuses.
  try {
    const globs = parsePnpmWorkspace(join(root, "pnpm-workspace.yaml"));
    return globs.map((glob) => ({
      glob,
      sourceFile: "pnpm-workspace.yaml",
    }));
  } catch (error: unknown) {
    if (!(error instanceof WorkspaceDetectionError)) throw error;
    const missingFile = error.field === "(file)" && error.message.includes("ENOENT");
    const settingsOnly = error.field === "packages" && error.message.includes("no `packages` key");
    if (!missingFile && !settingsOnly) throw error;
  }

  // Evidence 2 — `workspaces` in the root package.json.
  return readRootPackageWorkspaces(join(root, "package.json"));
}

/**
 * Reads the `workspaces` field from the root package.json. Accepts the npm
 * array form (`["packages/*"]`) and the yarn `{ packages: [...] }` form.
 * A missing field or missing file yields no patterns (not workspace
 * evidence); a present-but-malformed field refuses.
 */
function readRootPackageWorkspaces(pkgPath: string): readonly WorkspacePattern[] {
  let pkg: Record<string, unknown>;
  try {
    pkg = readJsonObject(pkgPath);
  } catch (error: unknown) {
    // A missing root package.json is "no evidence here", not a refusal —
    // we only got here because pnpm evidence was absent too. Any other
    // read or parse failure refuses loudly.
    if (error instanceof WorkspaceDetectionError && error.message.includes("ENOENT")) {
      return [];
    }
    throw error;
  }

  const workspaces = pkg.workspaces;
  if (workspaces === undefined) return [];

  const sourceFile = "package.json";
  if (Array.isArray(workspaces)) {
    return patternsFromList(workspaces, sourceFile, "workspaces");
  }
  if (typeof workspaces === "object" && workspaces !== null) {
    const packages = (workspaces as Record<string, unknown>).packages;
    if (packages === undefined) return [];
    if (!Array.isArray(packages)) {
      throw new WorkspaceDetectionError({
        file: sourceFile,
        field: "workspaces.packages",
        message: `expected an array of globs, found ${typeof packages}`,
      });
    }
    return patternsFromList(packages, sourceFile, "workspaces.packages");
  }
  throw new WorkspaceDetectionError({
    file: sourceFile,
    field: "workspaces",
    message: `expected an array or { packages: [...] }, found ${typeof workspaces}`,
  });
}

/**
 * The root manifest's own `name`, or `undefined` when the root manifest is
 * absent or carries no usable name — a workspace with no root name has no
 * root-named dependency targets to refuse. A missing file is "no name
 * here" (the same posture as `readRootPackageWorkspaces`); any other read
 * or parse failure refuses loudly.
 */
function readRootPackageName(pkgPath: string): string | undefined {
  let pkg: Record<string, unknown>;
  try {
    pkg = readJsonObject(pkgPath);
  } catch (error: unknown) {
    if (error instanceof WorkspaceDetectionError && error.message.includes("ENOENT")) {
      return undefined;
    }
    throw error;
  }
  const name = pkg.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function patternsFromList(
  entries: readonly unknown[],
  sourceFile: string,
  field: string,
): readonly WorkspacePattern[] {
  const patterns: WorkspacePattern[] = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new WorkspaceDetectionError({
        file: sourceFile,
        field: `${field}[${String(index)}]`,
        message: `expected a non-empty string glob, found ${JSON.stringify(entry ?? null)}`,
      });
    }
    patterns.push({ glob: entry.trim(), sourceFile });
  }
  return patterns;
}

// ---------------------------------------------------------------------------
// Member discovery
// ---------------------------------------------------------------------------

/** One discovered member manifest before edge extraction. */
interface RawMember {
  readonly name: string;
  readonly version: string;
  readonly dir: string;
  readonly manifestPath: string;
  readonly data: Record<string, unknown>;
  readonly edges: WorkspaceEdge[];
}

function discoverManifests(root: string, patterns: readonly WorkspacePattern[]): readonly string[] {
  // The same directory can match several globs, and a symlinked member can
  // be reached under several names — dedupe by the RESOLVED manifest path,
  // keeping first-discovery order (glob order is deterministic per walk).
  const seen = new Set<string>();
  const manifests: string[] = [];
  for (const { glob, sourceFile } of patterns) {
    for (const pkgPath of resolveWorkspaceGlob(root, glob, sourceFile)) {
      const identity = manifestIdentity(pkgPath);
      if (!seen.has(identity)) {
        seen.add(identity);
        manifests.push(pkgPath);
      }
    }
  }
  return manifests;
}

/**
 * The identity a manifest is deduped by: its resolved path when it can be
 * resolved (a manifest that exists always can), the literal path otherwise —
 * dedupe must stay total, never a crash on an unresolvable path.
 */
function manifestIdentity(manifest: string): string {
  try {
    return realpathSync(manifest);
  } catch {
    return manifest;
  }
}

function buildMembers(
  root: string,
  manifests: readonly string[],
  rootPackageName: string | undefined,
): readonly WorkspaceMember[] {
  const members: RawMember[] = [];
  for (const manifestPath of manifests) {
    members.push(readMember(root, manifestPath));
  }

  // Duplicate member names would make component identity ambiguous —
  // the planner keys propagation by name — so refuse.
  const nameIndex: Record<string, true> = {};
  for (const member of members) {
    if (nameIndex[member.name] === true) {
      throw new WorkspaceDetectionError({
        file: member.manifestPath,
        field: "name",
        message: `duplicate workspace member name ${JSON.stringify(member.name)}`,
      });
    }
    nameIndex[member.name] = true;
  }

  // Second pass: edges resolve only against known member names, so every
  // member must be read first.
  const memberNames: Record<string, true> = {};
  for (const member of members) memberNames[member.name] = true;
  for (const member of members) extractEdges(member, memberNames, rootPackageName);

  return members.map((member) => toPublicMember(root, member));
}

/**
 * Reads one member manifest: validates name/version presence, computes the
 * member directory relative to the workspace root, and returns the raw
 * parsed JSON for edge extraction.
 */
function readMember(root: string, manifestPath: string): RawMember {
  const data = readJsonObject(manifestPath);

  const name = data.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new WorkspaceDetectionError({
      file: manifestPath,
      field: "name",
      message: "workspace member has no package name",
    });
  }
  const version = data.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new WorkspaceDetectionError({
      file: manifestPath,
      field: "version",
      message: `package ${JSON.stringify(name)} has no version field`,
    });
  }

  const dir = relative(root, dirname(manifestPath)) || ".";
  return { name, version, dir, manifestPath, data, edges: [] };
}

function toPublicMember(root: string, member: RawMember): WorkspaceMember {
  return {
    name: member.name,
    version: member.version,
    dir: member.dir,
    manifestPath: relative(root, member.manifestPath),
    edges: member.edges,
  };
}

// ---------------------------------------------------------------------------
// Edge extraction
// ---------------------------------------------------------------------------

/**
 * Extracts dependency edges from one member's manifest: every declared
 * dependency whose name resolves to another workspace member becomes an
 * edge, with its kind and declaring file recorded. External dependencies
 * are skipped — they are not components — but a dependency naming the
 * workspace root package's name refuses: the root is inside the workspace,
 * so silently classifying it external would drop a real intra-workspace
 * dependency on the floor (issue #285). Each range is validated against
 * the D16 grammar on the spot.
 */
function extractEdges(
  member: RawMember,
  memberNames: Readonly<Record<string, true>>,
  rootPackageName: string | undefined,
): void {
  for (const kind of ALL_KINDS) {
    const deps = member.data[kind];
    if (deps === undefined || deps === null) continue;
    if (typeof deps !== "object" || Array.isArray(deps)) {
      throw new WorkspaceDetectionError({
        file: member.manifestPath,
        field: kind,
        message: `expected a mapping of dependency names to ranges, found ${Array.isArray(deps) ? "an array" : typeof deps}`,
      });
    }
    for (const [target, rangeExpr] of Object.entries(deps as Record<string, unknown>)) {
      // The root package's name is an intra-workspace target, but the root
      // is not a member, so no edge can represent it — refuse, whatever the
      // range says. When the root is itself discovered as a member (the `.`
      // glob), memberNames resolves it and the member path below applies.
      if (target === rootPackageName && memberNames[target] !== true) {
        throw new WorkspaceDetectionError({
          file: member.manifestPath,
          field: `${kind}.${target}`,
          message: `dependency ${JSON.stringify(target)} names the workspace root package: the root is not a workspace member, so this dependency is not representable as a workspace edge`,
        });
      }
      if (memberNames[target] !== true) continue; // External — not a workspace edge.
      if (typeof rangeExpr !== "string" || rangeExpr.length === 0) {
        throw new WorkspaceDetectionError({
          file: member.manifestPath,
          field: `${kind}.${target}`,
          message: `expected a range string, found ${JSON.stringify(rangeExpr ?? null)}`,
        });
      }
      validateRange(rangeExpr, member.manifestPath, `${kind}.${target}`);
      member.edges.push({
        target,
        range: rangeExpr,
        kind,
        declaredIn: { file: member.manifestPath },
      });
    }
  }
}

/**
 * Validates one range expression against the D16 grammar: `^x.y.z`,
 * `~x.y.z`, or exact `x.y.z` — the version part judged by the kernel's
 * strict SemVer grammar (core/domain/version.ts is the authority, decision
 * log D16): no leading-zero cores, no leading-zero numeric prerelease
 * identifiers, no empty identifiers, cores within the safe-integer bound.
 * Anything else — `*`, `latest`, `>=1.0.0`, `1.x`, `workspace:*`, git URLs,
 * and non-canonical SemVer strings — refuses naming the file and field, so
 * a malformed range dies at detection instead of drifting downstream to
 * planPropagation's bare range error.
 */
function validateRange(range: string, file: string, field: string): void {
  const floor = range.startsWith("^") || range.startsWith("~") ? range.slice(1) : range;
  try {
    Version.parse(floor);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new WorkspaceDetectionError({
      file,
      field,
      message: `range ${JSON.stringify(range)} is outside the D16 grammar (^x.y.z / ~x.y.z / exact x.y.z): ${reason}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Conversion to planner input
// ---------------------------------------------------------------------------

/**
 * Converts a detected workspace into the `ComponentMeta[]` the planner
 * consumes, so the app layer feeds `PlanningInput.components` directly.
 *
 * Only propagation-relevant edges become `dependencies`: devDependencies
 * are workspace edges (the updater sees them in `DetectedWorkspace`) but
 * never release-propagate. Members with no propagating edges carry no
 * `dependencies` field — exactly the shape a hand-declared input would
 * have, so downstream behavior is identical.
 */
export function toComponentMeta(workspace: DetectedWorkspace): readonly ComponentMeta[] {
  return workspace.members.map((member) => {
    const dependencies = member.edges
      .filter((edge) => PROPAGATING_KINDS.includes(edge.kind))
      .map((edge) => ({ name: edge.target, range: edge.range }));
    return {
      name: member.name,
      manifestVersion: member.version,
      paths: [member.dir],
      ...(dependencies.length > 0 ? { dependencies } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

/**
 * Reads and parses a package.json manifest, refusing every failure —
 * unreadable file or JSON syntax error — with the file named. A missing
 * file surfaces the underlying ENOENT message so callers can distinguish
 * "no evidence here" (missing manifest) from "evidence was unreadable".
 */
function readJsonObject(file: string): Record<string, unknown> {
  let body: string;
  try {
    body = readFileSync(file, "utf-8");
  } catch (error: unknown) {
    throw new WorkspaceDetectionError({
      file,
      field: "(file)",
      message: `cannot read manifest: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch (error: unknown) {
    throw new WorkspaceDetectionError({
      file,
      field: "(file)",
      message: `cannot read manifest: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WorkspaceDetectionError({
      file,
      field: "(file)",
      message: `expected a JSON object, found ${Array.isArray(parsed) ? "an array" : typeof parsed}`,
    });
  }
  return parsed as Record<string, unknown>;
}
