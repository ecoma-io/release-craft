/**
 * The reconciliation unit (the Phase 9 contract §2.2; ADR-0010
 * decision 8): the remote's tags and GitHub Releases are discovered
 * through the transport and compared against the binding's recorded
 * state — the binding is the truth, the remote is checked against it.
 * Divergence is reported, never silently resolved: the unit never
 * imports, adopts, or deletes anything, and never writes to the
 * binding from remote discovery.
 *
 * Each listing carries its own observation outcome on the report
 * (issue #66; D30): the comparison's results are claimed only by the
 * listings that are `listed` — over an unobserved remote, a comparison
 * that never ran is unrepresentable as a passed one. A listing that
 * never became usable — unreachable, unexpected status, a body that is
 * not a list, a compared field that is not a string — is
 * `transport-failure`, never a thrown exception and never an empty
 * listing. Both listings are always attempted: each observation's
 * outcome stands on its own, and one listing's failure never preempts
 * its sibling's.
 */

import type { GitBinding } from "../git/index.js";
import type {
  Divergence,
  GitHubCredentials,
  GitHubResponse,
  GitHubTransport,
  ReconciliationReport,
  ReleasesListingOutcome,
  TagsListingOutcome,
} from "./adapter-types.js";
import { readFailure, type ReadFailure } from "./response.js";

/** One row of either REST listing the reconciliation reads — only the
 *  fields the comparisons use, everything else unknown. */
interface RemoteRow {
  readonly name?: unknown;
  readonly commit?: { readonly sha?: unknown };
  readonly tag_name?: unknown;
}

const listPath = (credentials: GitHubCredentials, resource: "tags" | "releases"): string =>
  `/repos/${credentials.owner}/${credentials.repo}/${resource}?per_page=100`;

/** One listing's parse: the rows, or the read failure they carry. */
type ParsedListing = { readonly ok: true; readonly rows: readonly unknown[] } | ReadFailure;

/** The listing as rows, or the read failure it carries instead: a
 *  non-200 status classifies through the one §2.3 table, and a body that
 *  is not a list is an unexpected response. The listing is the
 *  comparison's premise — an unusable listing claims nothing, never an
 *  empty listing (an empty listing would read as a clean report, the one
 *  outcome this unit must never produce). */
const asRows = (response: GitHubResponse): ParsedListing => {
  if (response.status !== 200) {
    return readFailure(response);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return { kind: "transport-failure" };
  }
  if (!Array.isArray(parsed)) {
    return { kind: "transport-failure" };
  }
  return { ok: true, rows: parsed };
};

/** The one field the comparison reads off a row, when it is the string
 *  the REST contract types it as. A field that is not a string is a
 *  lying listing — inventing a tag name could match nothing and read as
 *  divergence, or worse, match something and read as verified — so the
 *  listing aborts as unusable rather than compare over a lie. */
const asText = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** The row as the shape the comparison reads, or undefined — a row that
 *  is not an object (a null, a number) is a lying listing like any
 *  other, never a throw past the no-exception law (§2.3). */
const asRow = (row: unknown): RemoteRow | undefined =>
  row !== null && typeof row === "object" ? row : undefined;

const recordedTags = (binding: GitBinding): Map<string, string> => {
  const recorded = new Map<string, string>();
  for (const row of binding.refs.tags()) {
    if (row.kind === "tag" && row.ref.startsWith("refs/tags/")) {
      recorded.set(row.ref.slice("refs/tags/".length), row.target);
    }
  }
  return recorded;
};

/** The comparison's stable order: code-unit comparison, deterministic
 *  across environments (a review reads the same report twice). */
const byTag = (left: Divergence, right: Divergence): number =>
  left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0;

/** The tag listing's comparison: every remote tag checked against the
 *  binding's record. A tag the binding holds no record of is unadopted,
 *  and so is a tag at a target the binding does not record — a name
 *  matching with a target drifting is exactly the silent failure this
 *  unit exists to surface. The rows are narrowed first, whole-listing:
 *  a lying row unclaims the listing instead of comparing over it. */
const comparedTags = (
  rows: readonly unknown[],
  recorded: Map<string, string>,
): TagsListingOutcome => {
  const divergences: Divergence[] = [];
  const verifiedTags: string[] = [];
  for (const row of rows) {
    const tag = asRow(row);
    const name = asText(tag?.name);
    const target = asText(tag?.commit?.sha);
    if (name === undefined || target === undefined) {
      return { state: "transport-failure" };
    }
    const recordedTarget = recorded.get(name);
    if (recordedTarget === undefined) {
      divergences.push({
        kind: "unadopted-tag",
        tag: name,
        detail: `the remote has the tag ${name} at ${target}, but the binding holds no record of it`,
      });
    } else if (recordedTarget !== target) {
      divergences.push({
        kind: "unadopted-tag",
        tag: name,
        detail: `the remote has the tag ${name} at ${target}, but the binding records it at ${recordedTarget}`,
      });
    } else {
      verifiedTags.push(name);
    }
  }
  // Stable reports: the comparison's output is data for review, and a
  // review reads the same report twice.
  divergences.sort(byTag);
  verifiedTags.sort();
  return { state: "listed", divergences, verifiedTags };
};

/** The release listing's comparison: the remote's releases checked
 *  against the binding's recorded tags — a release is the publication of
 *  a tag, so a release whose tag the binding holds no record of is an
 *  adopted publication over unadopted state; reported, never resolved. */
const comparedReleases = (
  rows: readonly unknown[],
  recorded: Map<string, string>,
): ReleasesListingOutcome => {
  const divergences: Divergence[] = [];
  for (const row of rows) {
    const release = asRow(row);
    const tag = asText(release?.tag_name);
    if (tag === undefined) {
      return { state: "transport-failure" };
    }
    if (!recorded.has(tag)) {
      divergences.push({
        kind: "unadopted-release",
        tag,
        detail: `the remote has a release for ${tag}, but the binding holds no record of the tag`,
      });
    }
  }
  divergences.sort(byTag);
  return { state: "listed", divergences };
};

/** The observation outcome a listing's parse carries onto the report:
 *  the comparison over a usable observation, or the failure class —
 *  the refusal with its detail (decision 9's reset timestamp on
 *  `rate-limited`), the failure bare. */
const listed = <R>(
  parsed: ParsedListing,
  compare: (rows: readonly unknown[]) => R,
): R | Extract<TagsListingOutcome, { readonly state: "refused" | "transport-failure" }> => {
  if ("ok" in parsed) {
    return compare(parsed.rows);
  }
  return parsed.kind === "refused"
    ? { state: "refused", reason: parsed.reason, detail: parsed.detail }
    : { state: "transport-failure" };
};

/** The reconciliation over a real binding and the caller-injected
 * transport (ADR-0010 decision 2's boundary, the no-runtime-dependency
 * house rule). The assembly composes it behind `openGitHubAdapter` —
 * implementation, never a public crossing. Both listings are attempted:
 * each observation's outcome stands on its own, and one listing's
 * failure never demotes the sibling's comparison. */
export const GitReleaseReconciliation = (
  binding: GitBinding,
  credentials: GitHubCredentials,
  transport: GitHubTransport,
): { reconcile(): ReconciliationReport } => ({
  reconcile(): ReconciliationReport {
    const recorded = recordedTags(binding);

    const tags = listed(asRows(transport.request(listPath(credentials, "tags"))), (rows) =>
      comparedTags(rows, recorded),
    );
    const releases = listed(asRows(transport.request(listPath(credentials, "releases"))), (rows) =>
      comparedReleases(rows, recorded),
    );

    return { tags, releases };
  },
});
