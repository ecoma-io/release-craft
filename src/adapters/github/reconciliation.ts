/**
 * The reconciliation unit (the Phase 9 contract §2.2; ADR-0010
 * decision 8): the remote's tags and GitHub Releases are discovered
 * through the transport and compared against the binding's recorded
 * state — the binding is the truth, the remote is checked against it.
 * Divergence is reported, never silently resolved: the unit never
 * imports, adopts, or deletes anything, and never writes to the
 * binding from remote discovery.
 */

import type { GitBinding } from "../git/index.js";
import type {
  Divergence,
  GitHubCredentials,
  GitHubResponse,
  GitHubTransport,
  ReconciliationReport,
} from "./adapter-types.js";

/** One row of the REST tag listing the reconciliation reads — only the
 *  fields the comparison uses, everything else unknown. */
interface RemoteTag {
  readonly name?: unknown;
  readonly commit?: { readonly sha?: unknown };
}

/** One row of the REST release listing. */
interface RemoteRelease {
  readonly tag_name?: unknown;
}

const listPath = (credentials: GitHubCredentials, resource: "tags" | "releases"): string =>
  `/repos/${credentials.owner}/${credentials.repo}/${resource}?per_page=100`;

/** The listing body as rows. The listing is the comparison's premise:
 *  a non-200 status or a body that is not a list is an unexpected
 *  response, and the unit fails closed on it rather than mistaking it
 *  for an empty listing — an empty listing would read as a clean
 *  report, and a falsely clean report is the one outcome this unit must
 *  never produce. */
const asRows = (response: GitHubResponse): readonly unknown[] => {
  if (response.status !== 200) {
    throw new TypeError(`the reconciliation listing returned ${String(response.status)}, not 200`);
  }
  const parsed: unknown = JSON.parse(response.body);
  if (!Array.isArray(parsed)) {
    throw new TypeError("the reconciliation listing returned a body that is not a list");
  }
  return parsed;
};

/** The one field the comparison reads off a row. A field the REST
 *  contract types as a string that is not a string is a lying listing —
 *  the unit fails closed on it rather than inventing a tag name (an
 *  empty or object-coerced name could match nothing and read as
 *  divergence, or worse, match something and read as verified). */
const asText = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new TypeError("the reconciliation listing row carries a field that is not a string");
  }
  return value;
};

const recordedTags = (binding: GitBinding): Map<string, string> => {
  const recorded = new Map<string, string>();
  for (const row of binding.refs.tags()) {
    if (row.kind === "tag" && row.ref.startsWith("refs/tags/")) {
      recorded.set(row.ref.slice("refs/tags/".length), row.target);
    }
  }
  return recorded;
};

/** The reconciliation over a real binding and the caller-injected
 * transport (ADR-0010 decision 2's boundary, the no-runtime-dependency
 * house rule). The assembly composes it behind `openGitHubAdapter` —
 * implementation, never a public crossing.
 */
export const GitReleaseReconciliation = (
  binding: GitBinding,
  credentials: GitHubCredentials,
  transport: GitHubTransport,
): { reconcile(): ReconciliationReport } => ({
  reconcile(): ReconciliationReport {
    const recorded = recordedTags(binding);
    const remoteTags = asRows(
      transport.request(listPath(credentials, "tags")),
    ) as readonly RemoteTag[];
    const remoteReleases = asRows(
      transport.request(listPath(credentials, "releases")),
    ) as readonly RemoteRelease[];

    const divergences: Divergence[] = [];
    const verifiedTags: string[] = [];

    // The remote's tags, each checked against the binding's record: a
    // tag the binding holds no record of is unadopted, and so is a tag
    // at a target the binding does not record — a name matching with a
    // target drifting is exactly the silent failure this unit exists to
    // surface.
    for (const row of remoteTags) {
      const tag = asText(row.name);
      const target = asText(row.commit?.sha);
      const recordedTarget = recorded.get(tag);
      if (recordedTarget === undefined) {
        divergences.push({
          kind: "unadopted-tag",
          tag,
          detail: `the remote has the tag ${tag} at ${target}, but the binding holds no record of it`,
        });
      } else if (recordedTarget !== target) {
        divergences.push({
          kind: "unadopted-tag",
          tag,
          detail: `the remote has the tag ${tag} at ${target}, but the binding records it at ${recordedTarget}`,
        });
      } else {
        verifiedTags.push(tag);
      }
    }

    // The remote's releases: a release is the publication of a tag, so
    // a release whose tag the binding holds no record of is an adopted
    // publication over unadopted state — reported, never resolved.
    for (const row of remoteReleases) {
      const tag = asText(row.tag_name);
      if (!recorded.has(tag)) {
        divergences.push({
          kind: "unadopted-release",
          tag,
          detail: `the remote has a release for ${tag}, but the binding holds no record of the tag`,
        });
      }
    }

    // Stable reports: the comparison's output is data for review, and a
    // review reads the same report twice.
    divergences.sort(
      (left, right) => left.kind.localeCompare(right.kind) || left.tag.localeCompare(right.tag),
    );
    verifiedTags.sort();
    return { divergences, verifiedTags };
  },
});
