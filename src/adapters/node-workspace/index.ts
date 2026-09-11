/**
 * Public barrel for the Node workspace adapter — the detected graph
 * description the planner and updater consume as structured input.
 *
 * Detection maps explicit workspace evidence (pnpm `packages:`,
 * npm/yarn `workspaces:`) to a `DetectedWorkspace` object; the
 * `toComponentMeta` conversion then produces `ComponentMeta[]` for the
 * propagation planner, so the app layer composes `PlanningInput` at
 * merge time.
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
