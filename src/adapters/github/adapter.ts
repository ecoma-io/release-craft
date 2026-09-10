/**
 * The GitHub adapter's assembly (the Phase 9 contract §2.6; ADR-0010
 * decision 2 as amended by #65): `openGitHubAdapter` composes the
 * merged units — remote synchronization, release publication and
 * verification, reconciliation — behind the one factory the barrel
 * exports. The factory owns no mechanics of its own: the HTTP transport
 * is injected at open (the surface type every unit already consumes),
 * so the credential discipline (`remote-git.ts`: the token crosses as
 * an environment variable, never as an argument) and the synchronous
 * discipline (§2.2: values, never promises) are the composition root's
 * to keep — Node has no synchronous HTTPS client, and every in-factory
 * improvisation (an external binary, an ambient token) would break one
 * of the two disciplines this layer records.
 */

import type { GitBinding } from "@ecoma-io/release-craft/adapters/git";
import type {
  GitHubAdapter,
  GitHubCredentials,
  GitHubTransport,
  ReconciliationReport,
  ReleaseOutcome,
  SyncReport,
  VerificationOutcome,
} from "./adapter-types.js";
import { GitReleasePublication } from "./publication.js";
import { GitReleaseReconciliation } from "./reconciliation.js";
import { GitRemoteSync } from "./sync.js";

/**
 * Opens the GitHub adapter over an already-opened binding and supplied
 * credentials, with the GitHub REST transport the publication and
 * reconciliation doors read through. The transport target is the
 * binding's own repository for the git-level sync (ADR-0010 decision
 * 3); the API doors compare and publish against the credentials'
 * owner/repo.
 */
export const openGitHubAdapter = (
  binding: GitBinding,
  credentials: GitHubCredentials,
  transport: GitHubTransport,
): GitHubAdapter => {
  const sync = GitRemoteSync(binding, credentials);
  const publication = GitReleasePublication(binding, credentials, transport);
  const reconciliation = GitReleaseReconciliation(binding, credentials, transport);
  return {
    syncRemote(): SyncReport {
      return sync.syncRemote();
    },
    publishRelease(tag: string): ReleaseOutcome {
      return publication.publishRelease(tag);
    },
    verifyRelease(tag: string): VerificationOutcome {
      return publication.verifyRelease(tag);
    },
    reconcile(): ReconciliationReport {
      return reconciliation.reconcile();
    },
  };
};
