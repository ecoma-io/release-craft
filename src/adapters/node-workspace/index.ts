/**
 * Public barrel for the Node workspace adapter — a public-surface export
 * with no in-repo production caller yet (issue #290): nothing consumes the
 * detected graph description in this repository today.
 *
 * Detection maps explicit workspace evidence (pnpm `packages:`,
 * npm/yarn `workspaces:`) to a `DetectedWorkspace` object; the
 * `toComponentMeta` conversion then produces `ComponentMeta[]`, the
 * planner's declared-component shape, so a caller can compose
 * `PlanningInput` from it without re-detecting anything.
 *
 * Gate: `check:package` (invariant 1: no runtime dependencies).
 */

export { detectNodeWorkspace, toComponentMeta } from "./detection.js";
export { parsePnpmWorkspace } from "./pnpm-workspace.js";
export { resolveWorkspaceGlob } from "./node-glob.js";
export {
  WorkspaceDetectionError,
  type DetectedWorkspace,
  type WorkspaceDependencyKind,
  type WorkspaceEdge,
  type WorkspaceMember,
} from "./types.js";
