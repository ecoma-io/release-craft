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
 *
 * The page walk's honesty is the report's premise (issue #179; D53):
 * `complete` is claimed from evidence the chain ended — a final page
 * under the requested size — never from a header's mere absence, which
 * a stripped `Link` header forges; a full final page reads `truncated`,
 * an honest partial observation. A chain that cycles or declares a
 * next it cannot name faults the listing loudly within the no-throw
 * law, and every transport call crosses `guardedRequest` so a hostile
 * transport's exception never escapes the doors (ADR-0010 decision 7).
 */

import type { GitBinding } from "@ecoma-io/release-craft/adapters/git";
import type {
  Divergence,
  GitHubCredentials,
  GitHubResponse,
  GitHubTransport,
  PaginationCompleteness,
  ReconciliationReport,
  ReleasesListingOutcome,
  TagsListingOutcome,
} from "./adapter-types.js";
import { guardedRequest, nextLink, readFailure, type ReadFailure } from "./response.js";

/** One row of either REST listing the reconciliation reads — only the
 *  fields the comparisons use, everything else unknown. */
interface RemoteRow {
  readonly name?: unknown;
  readonly commit?: { readonly sha?: unknown };
  readonly tag_name?: unknown;
}

/** The requested page size — the walk's evidence unit (issue #179;
 *  D53). The pagination reference ("Changing the number of items per
 *  page", docs.github.com/en/rest/using-the-rest-api/using-pagination-
 *  in-the-rest-api) documents the maximum as 100 for most endpoints
 *  ("the response includes no more than the maximum number of results
 *  per page"), so a page under this size could not have a successor —
 *  the one observable that *is* the chain's end. */
const PER_PAGE = 100;

/** The first page of a resource's listing; the page chain is followed
 *  through the `Link` header's `rel="next"` (issue #68; D32). */
const listPath = (credentials: GitHubCredentials, resource: "tags" | "releases"): string =>
  `/repos/${credentials.owner}/${credentials.repo}/${resource}?per_page=${String(PER_PAGE)}`;

/** One listing's parse: the rows and the response's headers the
 *  pagination walk reads the next-page `Link` from (issue #68; D32), or
 *  the read failure they carry. */
type ParsedListing =
  | {
      readonly ok: true;
      readonly rows: readonly unknown[];
      readonly headers: Readonly<Record<string, string>>;
    }
  | ReadFailure;

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
  return { ok: true, rows: parsed, headers: response.headers };
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
 *  a lying row unclaims the listing instead of comparing over it.
 *  `listed` counts every observed row and carries the observation's
 *  completeness as the walk evidenced it (issue #68; D32; issue #179;
 *  D53) — a `truncated` observation still claims the comparison its
 *  rows really earned, and its `pagination` is what denies the
 *  clean-bill reading over the rows it never saw. */
const comparedTags = (
  rows: readonly unknown[],
  recorded: Map<string, string>,
  pagination: PaginationCompleteness,
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
  return {
    state: "listed",
    listed: rows.length,
    pagination,
    divergences,
    verifiedTags,
  };
};

/** The release listing's comparison: the remote's releases checked
 *  against the binding's recorded tags — a release is the publication of
 *  a tag, so a release whose tag the binding holds no record of is an
 *  adopted publication over unadopted state; reported, never resolved.
 *  `listed` carries the observation's row count and the walk-evidenced
 *  completeness (issue #68; D32; issue #179; D53). */
const comparedReleases = (
  rows: readonly unknown[],
  recorded: Map<string, string>,
  pagination: PaginationCompleteness,
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
  return { state: "listed", listed: rows.length, pagination, divergences };
};

/** The observation a listing's response chain carries onto the report:
 *  the comparison over the complete usable observation, or the failure
 *  class — the refusal with its detail (decision 9's reset timestamp on
 *  `rate-limited`), the failure bare. A page's failure unclaims the
 *  *whole* listing — a partial comparison would read a truncated remote
 *  as a passed one (issue #68; D32). */
type ListingFailure = Extract<
  TagsListingOutcome,
  { readonly state: "refused" | "transport-failure" }
>;

/** The observation a listing's page chain carries: the rows the chain
 *  actually returned, with the completeness the chain's end was
 *  *evidenced* to have — or the failure the chain carried. */
type ChainOutcome =
  | {
      readonly ok: true;
      readonly rows: readonly unknown[];
      readonly completeness: PaginationCompleteness;
    }
  | ListingFailure;

/** The completed observation's rows and its completeness evidence, or
 *  the failure the chain carried: the pages walk `Link: rel="next"`
 *  (RFC 8288) to the end of the resource; a refused or unusable page —
 *  on any page of the chain — fails the whole listing, never a partial
 *  comparison over the pages already read.
 *
 * The chain's end is claimed by evidence, never by a header's absence
 * (issue #179; D53). The requested page size is the most any page
 * returns, so a final page under `PER_PAGE` could not have a
 * successor — that short page, with no `next` declared on it, is the
 * walk's completion evidence and the listing reads `complete`. A final
 * page at full size with no `next` is ambiguous: GitHub omits the
 * header whenever "all results fit on a single page" (the pagination
 * reference, "Using link headers"), which is byte-identical to what a
 * transport or proxy stripping the header produces — so the listing
 * reads `truncated` over the rows it actually holds, an honest partial
 * observation the caller sees, never a clean bill and never a discarded
 * comparison.
 *
 * Two chain shapes have no honest end and fault the listing loudly —
 * `transport-failure`, the fail-closed class that claims nothing,
 * within the no-throw law (ADR-0010 decision 7) that forbids the louder
 * throw: a `next` target the walk already requested is a *cycle* (the
 * chain loops; following it again cannot terminate, and the door must
 * never hang), and a declared next whose target is no requestable path
 * is *malformed* (the header says more pages follow, and following it
 * blind is the request-error shape issue #179 refuses — the walk never
 * requests what the transport contract does not speak). */
const listAll = (
  credentials: GitHubCredentials,
  resource: "tags" | "releases",
  transport: GitHubTransport,
): ChainOutcome => {
  const rows: unknown[] = [];
  const requested = new Set<string>();
  let path: string | undefined = listPath(credentials, resource);
  let lastPageRows = 0;
  while (path !== undefined) {
    if (requested.has(path)) {
      // The cycle fault (issue #179; D53): this page was already read —
      // the chain loops and re-reading it cannot end it. The listing
      // unclaims entire; the walk never spins.
      return { state: "transport-failure" };
    }
    requested.add(path);
    const parsed = asRows(guardedRequest(transport, path));
    if (!("ok" in parsed)) {
      return parsed.kind === "refused"
        ? { state: "refused", reason: parsed.reason, detail: parsed.detail }
        : { state: "transport-failure" };
    }
    rows.push(...parsed.rows);
    lastPageRows = parsed.rows.length;
    const next = nextLink(parsed.headers);
    if (next.kind === "malformed") {
      // The malformed-next fault (issue #179; D53): the header declares
      // a next and the declaration names no page — neither following it
      // nor stopping silently is honest.
      return { state: "transport-failure" };
    }
    path = next.kind === "next" ? next.path : undefined;
  }
  return {
    ok: true,
    rows,
    completeness: lastPageRows < PER_PAGE ? "complete" : "truncated",
  };
};

/** The listing's observation, composed over the page chain its walk
 *  evidenced. */
const listed = <R>(
  outcome: ChainOutcome,
  compare: (rows: readonly unknown[], pagination: PaginationCompleteness) => R,
): R | ListingFailure => {
  if ("ok" in outcome) {
    return compare(outcome.rows, outcome.completeness);
  }
  return outcome;
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

    const tags = listed(listAll(credentials, "tags", transport), (rows, pagination) =>
      comparedTags(rows, recorded, pagination),
    );
    const releases = listed(listAll(credentials, "releases", transport), (rows, pagination) =>
      comparedReleases(rows, recorded, pagination),
    );

    return { tags, releases };
  },
});
