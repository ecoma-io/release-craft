/**
 * Public types for the Node workspace adapter — the detected graph
 * description the planner and updater consume as declared structure
 * (issue #205).
 *
 * This adapter is sugar over hand-declared input: `ComponentMeta[]`
 * remains first-class, and a repository with no explicit workspace
 * evidence falls through to that path. The data here is provider-neutral,
 * serializable, and maps to `ComponentMeta[]` at assembly time (see
 * `toComponentMeta`).
 *
 * Gate: `check:package` (invariant 1: no runtime dependencies).
 */

/**
 * The package.json dependency field an edge was declared in. The kind is
 * the propagation contract: dev-only edges never release-propagate, while
 * runtime, peer, and optional edges do (the updater filters on this).
 */
export type WorkspaceDependencyKind =
  "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";

/** One dependency edge from a workspace member to another workspace
 * member: the target's package name, the declared range (D16 grammar:
 * `^x.y.z`, `~x.y.z`, or exact `x.y.z`), and the declaring field for
 * refusal traces and propagation filtering. */
export interface WorkspaceEdge {
  /** The target member's package name (component identity). */
  readonly target: string;
  /** The declared range expression in the D16 grammar. Unknown forms
   * refuse at detection time, before assembly. */
  readonly range: string;
  /** The dependency field that declared this edge. */
  readonly kind: WorkspaceDependencyKind;
  /** The manifest file that declared this edge. */
  readonly declaredIn: { readonly file: string };
}

/** One detected workspace member: the package.json metadata and the edges
 * it declares toward other members of the same workspace. External
 * dependencies are not edges — they are not components in the D16 graph. */
export interface WorkspaceMember {
  /** The package name from package.json (`name` field). */
  readonly name: string;
  /** The semver string from package.json (`version` field). */
  readonly version: string;
  /** Directory of this member, relative to the workspace root (`.` for
   * the root package itself when the root is a member). */
  readonly dir: string;
  /** Path to this member's package.json, relative to the workspace root. */
  readonly manifestPath: string;
  /** Declared edges to other workspace members. */
  readonly edges: readonly WorkspaceEdge[];
}

/** The detected Node workspace graph: the workspace root directory and
 * every member discovered from explicit workspace manifest evidence
 * (pnpm `packages:`, npm/yarn `workspaces:`). */
export interface DetectedWorkspace {
  /** The workspace root directory (absolute). */
  readonly root: string;
  /** All members, in glob discovery order. */
  readonly members: readonly WorkspaceMember[];
}

/** A structured refusal the detection layer surfaces when it rejects a
 * workspace manifest or member manifest. Detection never guesses: every
 * malformation — missing or duplicated keys, empty sequences, unsupported
 * glob metacharacters, unknown range variants, duplicate member names —
 * raises this error naming the file and field at fault. */
export class WorkspaceDetectionError extends Error {
  /** The file that triggered the refusal. */
  readonly file: string;
  /** The field or key within the file (e.g. `packages`, `workspaces`,
   * `dependencies.@scope/pkg`). */
  readonly field: string;

  constructor(opts: { file: string; field: string; message: string }) {
    super(opts.message);
    this.name = "WorkspaceDetectionError";
    this.file = opts.file;
    this.field = opts.field;
  }
}
