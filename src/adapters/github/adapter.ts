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
 *
 * The factory owns one check of its own, the open-time identity
 * agreement (§2.9; #177; D55): the sync transports against the binding's
 * `origin` while the API doors address `credentials.owner/repo` — two
 * remote identities nothing compared, so a credential for a fork passed
 * every classification while the two halves of the adapter spoke to two
 * different repositories. Before any unit is composed, the factory reads
 * the origin through the same transport runner the sync uses and refuses
 * to open unless the two identities name the same repository. The check
 * lives here and nowhere else: open is the one point every door crosses
 * — the doors themselves stay the sibling units' — and the origin is
 * resolvable here (a local config read, the earliest point it is known;
 * ADR-0010 decision 8 already reads the remote at open). An origin that
 * is not configured leaves nothing to compare: the sync unit's own
 * environmental fault stands when its door runs, as it always has.
 */

import { GitFaultError, type GitBinding } from "@ecoma-io/release-craft/adapters/git";
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
import { openRemoteGit } from "./remote-git.js";
import { originIdentityFault } from "./remote-identity.js";
import { GitRemoteSync } from "./sync.js";

/**
 * The open-time identity agreement (§2.9; #177; D55): reads the binding's
 * configured origin — the effective URL the sync itself pushes through —
 * and throws a `GitFaultError` naming both identities unless it names the
 * credentials' repository. The refusal is thrown, not returned: decision
 * 7's classes are remote-operation outcomes and no operation has run, and
 * the fault is the repository's own misconfiguration — the same thrown
 * family as the missing origin the sync unit already refuses with.
 */
const assertOriginAgreement = (binding: GitBinding, credentials: GitHubCredentials): void => {
  const git = openRemoteGit({ repoPath: binding.repo, token: credentials.token });
  const origin = git(["remote", "get-url", "origin"]);
  if (origin.code !== 0) {
    // No origin is configured: only one identity exists. Nothing here
    // compares — the sync door's own fault (the same GitFaultError) fires
    // when syncRemote runs, unchanged.
    return;
  }
  const fault = originIdentityFault(origin.stdout, credentials);
  if (fault !== null) {
    // The read succeeded — the fault is the agreement's, not the
    // invocation's — so no exit status is claimed (the `null` the fault
    // class itself uses when git could not be spawned).
    throw new GitFaultError(["remote", "get-url", "origin"], null, fault);
  }
};

/**
 * Opens the GitHub adapter over an already-opened binding and supplied
 * credentials, with the GitHub REST transport the publication and
 * reconciliation doors read through. The transport target is the
 * binding's own repository for the git-level sync (ADR-0010 decision
 * 3); the API doors compare and publish against the credentials'
 * owner/repo — and the factory refuses to open at all unless the origin
 * and the credentials name that same repository (§2.9; #177; D55).
 */
export const openGitHubAdapter = (
  binding: GitBinding,
  credentials: GitHubCredentials,
  transport: GitHubTransport,
): GitHubAdapter => {
  assertOriginAgreement(binding, credentials);
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
