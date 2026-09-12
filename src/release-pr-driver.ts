/**
 * The Release PR gate's production composition (issue #309): the real
 * GitHub port wired into the application gate, behind one open call. The
 * gate (`openReleasePRGate`) is injectable by design — it consumes the
 * port interface, not the adapter — and the CLI cannot supply the real
 * port itself (the boundary row for `type-cli` reaches no GitHub
 * adapter), so this file is the one place the wiring exists: the opened
 * adapter's `releasePR` port (the same injected transport and
 * credentials every other door reads through, with the open-time
 * identity agreement already enforced at the adapter factory) plus the
 * caller's record sink, composed into the gate the plan's projection is
 * driven through.
 *
 * The sink stays required, never defaulted: the gate's write-ahead
 * discipline (ADR-0006) is part of the door — a gate assembled without a
 * sink could crash mid-mutation with no evidence — and a composition
 * root that silently supplied an in-memory sink would hollow that
 * discipline out while looking assembled. The caller names where the
 * records go, or the driver does not open.
 *
 * The file lives in the package shell and nowhere else: `type-package`
 * is the one tag whose boundary row reaches both the app layer and the
 * GitHub adapter, so a driver in any other layer would either cross
 * upward (adapter → app) or force the CLI across its own refusal.
 */

import type { GitHubAdapter } from "@ecoma-io/release-craft/adapters/github";
import {
  openReleasePRGate,
  type ReleasePRGate,
  type ReleasePRRecordSink,
} from "@ecoma-io/release-craft/app";

/**
 * Opens the Release PR gate over the opened GitHub adapter's real port
 * and the caller's record sink. Synchronous, like the doors it composes:
 * the returned gate drives `detect`, `create`, and `update` against the
 * remote, and every refused, ambiguous, or partial port outcome crosses
 * as the gate's own recorded verdict (the port's classified fault is the
 * refusal envelope the gate's outcomes-only contract already converts —
 * see `GitHubReleasePRPort` in the adapter's vocabulary).
 */
export const openReleasePRDriver = (
  adapter: GitHubAdapter,
  sink: ReleasePRRecordSink,
): ReleasePRGate => openReleasePRGate(adapter.releasePR, sink);
