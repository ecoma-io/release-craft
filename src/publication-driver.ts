/**
 * The publication port's production composition (audit §7.1; D87): the real
 * GitHub release doors wired into the application assembly, behind one
 * open call. The assembly (`assemblePublicationBinding`) is injectable by
 * design — it consumes the port interface, never the adapter — and the
 * boundary names no provider (invariant 2.11), so this file is the one
 * place the wiring exists: the opened adapter's `publishRelease` and
 * `verifyRelease` ports (the same injected transport and credentials
 * every other door reads through, with the origin agreement already
 * enforced at the adapter factory) composed into the assembly the engine
 * runs through.
 *
 * The file lives in the package shell and nowhere else: `type-package`
 * is the one tag whose boundary row reaches both the app layer and the
 * GitHub adapter, so a composition in any other layer would either cross
 * upward (adapter → app) or force the app boundary across its own
 * provider-blind row.
 */

import type { GitBinding } from "@ecoma-io/release-craft/adapters/git";
import type { GitHubAdapter } from "@ecoma-io/release-craft/adapters/github";
import {
  assemblePublicationBinding,
  type AssemblyConfig,
  type Engine,
} from "@ecoma-io/release-craft/app";

/**
 * Assembles the engine over the opened git binding and the opened GitHub
 * adapter's real publication doors. Synchronous, like the doors it
 * composes: the returned engine's completed walks publish the minted
 * tag's release from the binding's recorded tail and verify it, and every
 * refused, absent, ambiguous, or transport-failure port outcome crosses
 * as the attempt's determinate refusal or blocked cause (D87) — the
 * port's classified outcome is the vocabulary the engine's effects
 * already consume.
 */
export const openPublicationDriver = (
  binding: GitBinding,
  github: GitHubAdapter,
  config: AssemblyConfig,
): Engine =>
  assemblePublicationBinding(
    binding,
    {
      publishRelease: (tag) => github.publishRelease(tag),
      verifyRelease: (tag) => github.verifyRelease(tag),
    },
    config,
  );
