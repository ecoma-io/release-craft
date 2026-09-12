/**
 * The Release PR port — the Release PR gate's remote half (issue #309; the
 * compatibility matrix's F1 row). The gate (`src/app/release-pr.ts`,
 * issue #202) projects a recorded plan onto PR content and refuses to
 * rewrite a PR whose claim disagrees with the recomputed world; this unit
 * is the remote boundary that projection rides: discover an existing PR by
 * the identity claim its body embeds, create the PR from a projection,
 * update one in place. Three laws shape every door:
 *
 * - Identity is the claim marker, never a mutable label (issue #202 §11.5).
 *   Discovery walks the repository's open pull requests and parses each
 *   body against the marker format the gate itself speaks — the parse half
 *   of the same format `parseIdentityClaim` reads (the app layer cannot be
 *   imported here — the `type-adapters-github` boundary row — so the format
 *   is spelled twice and the unit suite pins the two halves together by
 *   adopting a body the gate's own render produced). A body with no marker
 *   is a foreign PR: skipped, never adopted. A body carrying the marker's
 *   signature that does not parse is a loud refusal: silently skipping it
 *   would answer null and create the duplicate PR the marker exists to
 *   prevent. A listing that cannot be observed completely (the pagination
 *   walk's truncated end, a cycling or malformed next) refuses for the
 *   same reason — null over an incomplete observation is the duplicate.
 *
 * - A create is honest about its partial states. The head branch is
 *   derived from the identity (the port owns branch derivation per the
 *   interface's docblock), the projected files are committed over the git
 *   data API, and only then does the pull request open. A branch pushed
 *   whose pull request did not open is a refusal naming what landed —
 *   never success — and the retry path is find-then-adopt: discovery
 *   finds the claim-matching PR the first attempt (or a lost response)
 *   left behind, and the branch whose tree already matches the projection
 *   commits nothing again. At the provider's already-exists answer the
 *   same discovery decides: adopt the matching PR, or refuse when a
 *   foreign PR occupies the derived branch.
 *
 * - An update cannot clobber what it did not verify. The PR is re-read
 *   before any write and its body's claim re-parsed: a body that lost its
 *   claim between the gate's find and this write is a human edit the port
 *   refuses to overwrite, and a marker whose own identity disagrees with
 *   the head branch it sits on is a tampered PR. The files move first —
 *   the claim (the body) moves last, so a crash never leaves a body
 *   claiming content the branch does not carry — then the title/body,
 *   then the label set. Every write is idempotent: a tree whose sha the
 *   projection cannot change commits nothing, an already-equal title/body
 *   patches nothing, an already-equal label set writes nothing.
 *
 * Refusals classify through the one §2.3 table (`readFailure`), every
 * transport call crosses the guarded boundary (`guardedRequest`), a 404 is
 * discriminated by the repository probe before it is claimed (a branch
 * read's 404 also answers a repository this credential cannot observe —
 * the publication unit's own idiom), and a write whose response is lost
 * mid-call reads `ambiguous` (§2.3): it may have landed unseen, and
 * verification is the caller's next read. The doors themselves are values
 * all the way down; the one throw is the port view's classified fault, the
 * refusal envelope the app port's null-or-PR interface forces (see
 * `GitHubReleasePRPort` in adapter-types.ts).
 */

import type {
  GitHubCredentials,
  GitHubExistingPR,
  GitHubReleasePRCreateParams,
  GitHubReleasePRFile,
  GitHubReleasePRIdentity,
  GitHubReleasePRPort,
  GitHubReleasePRUpdateParams,
  GitHubRequestInit,
  GitHubResponse,
  GitHubTransport,
  RefusalReason,
} from "./adapter-types.js";
import { bodyMessage, guardedRequest, nextLink, readFailure } from "./response.js";

// ---------------------------------------------------------------------------
// §1 — the classified outcomes (values all the way down to the port view)
// ---------------------------------------------------------------------------

/** A refusal reason is the W4 vocabulary's; a lost write's response reads
 *  `ambiguous`; `partial` names a write that landed half-done — the state
 *  a create or update must never dress up as success. */
type FailureState = "refused" | "transport-failure" | "ambiguous" | "partial";

/** The failure a door can end in: the provider declining with the operator
 *  class (the W4 reason), the retryable class, the lost write, or the
 *  half-done write whose detail names exactly what landed. */
type Failure =
  | { readonly state: "refused"; readonly reason: RefusalReason; readonly detail: string }
  | { readonly state: "transport-failure"; readonly detail?: string }
  | { readonly state: "ambiguous"; readonly detail?: string }
  | { readonly state: "partial"; readonly detail: string };

/** The identity lookup's outcome: found, determinately none, or the
 *  failure — never a null that a truncated observation would have
 *  produced. (The create and update doors throw the classified fault
 *  directly at their refused, ambiguous, and partial outcomes — the port
 *  interface has no refusal variant to carry them as values.) */
type Discovery =
  { readonly state: "found"; readonly pr: GitHubExistingPR } | { readonly state: "none" } | Failure;

/** The classified fault the port view throws (see `GitHubReleasePRPort`):
 *  the operation, the outcome state, the W4 reason when the provider
 *  declined, and the detail naming what landed — the words a debugging
 *  operator reads, and the words the gate's recorded verdict carries. */
export class GitHubReleasePRFault extends Error {
  /** The port operation that refused. */
  readonly operation: "findPR" | "createPR" | "updatePR";
  /** The classified outcome state. */
  readonly state: FailureState;
  /** The W4 refusal reason, when the provider declined the request. */
  readonly reason: RefusalReason | null;
  /** The refusal's own words, when it carried any. */
  readonly detail: string | null;

  constructor(operation: "findPR" | "createPR" | "updatePR", failure: Failure) {
    const reason = failure.state === "refused" ? failure.reason : null;
    const detail =
      failure.state === "refused" || failure.state === "partial"
        ? failure.detail
        : (failure.detail ?? null);
    const reasonWords = reason === null ? "" : ` (${reason})`;
    const detailWords = detail === null ? "" : `: ${detail}`;
    super(`the release PR port's ${operation} ended ${failure.state}${reasonWords}${detailWords}`);
    this.name = "GitHubReleasePRFault";
    this.operation = operation;
    this.state = failure.state;
    this.reason = reason;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// §2 — the identity claim marker (the parse half of the gate's format)
// ---------------------------------------------------------------------------

/** The parsed claim: the identity a PR was created (or last updated)
 *  under, and the plan fingerprint its body renders. */
interface ParsedClaim {
  readonly component: string;
  readonly releaseLine: string;
  readonly targetBranch: string;
  readonly planId: string;
}

/** The full marker pattern — byte-for-byte the app gate's `MARKER_PATTERN`
 *  (`src/app/release-pr.ts`), the encoded form `renderBody` produces. The
 *  two halves cannot share a module (the boundary row keeps the app out of
 *  this layer), so the unit suite pins them together: a body the gate
 *  rendered parses here to the same identity it was rendered from. */
const MARKER_PATTERN =
  /<!--\s*release-craft:\s*identity\s+component=([^\s>]+)\s+line=([^\s>]+)\s+target=([^\s>]+)\s+plan=([^\s>]+)\s*-->/;

/** The marker's signature: the claim's opening, independent of the fields'
 *  well-formedness. A body matching the signature but not the pattern
 *  carries a *malformed* claim — the loud-refusal class. A body matching
 *  neither is foreign — the skip class. Reading the signature from the
 *  same opener the pattern anchors on keeps the two classes one edit
 *  apart, not one format apart. */
const MARKER_SIGNATURE = /<!--\s*release-craft:\s*identity\b/;

/** How a body answers the identity question: its own claim, no claim at
 *  all (foreign), or a claim's remains (malformed — refuse loudly). */
type ClaimReading =
  | { readonly kind: "claim"; readonly claim: ParsedClaim }
  | { readonly kind: "foreign" }
  | { readonly kind: "malformed" };

const readClaim = (body: string): ClaimReading => {
  const match = MARKER_PATTERN.exec(body);
  const component = match?.[1];
  const releaseLine = match?.[2];
  const targetBranch = match?.[3];
  const planId = match?.[4];
  if (
    component !== undefined &&
    releaseLine !== undefined &&
    targetBranch !== undefined &&
    planId !== undefined
  ) {
    return { kind: "claim", claim: { component, releaseLine, targetBranch, planId } };
  }
  return MARKER_SIGNATURE.test(body) ? { kind: "malformed" } : { kind: "foreign" };
};

/** Whether a parsed claim names exactly the identity sought — the full
 *  triplet, every field, or no match at all (issue #202 §11.5: a label or
 *  a title is never consulted). */
const claimMatches = (claim: ParsedClaim, identity: GitHubReleasePRIdentity): boolean =>
  claim.component === identity.component &&
  claim.releaseLine === identity.releaseLine &&
  claim.targetBranch === identity.targetBranch;

// ---------------------------------------------------------------------------
// §3 — the head branch derivation (the port's own grammar)
// ---------------------------------------------------------------------------

/** The head branch a release PR for the identity opens from: release-
 *  please's `--`-separated convention (`release-please--branches--<branch>`),
 *  carrying the full triplet so the derivation is injective over it — a
 *  changed component, line, or target derives a changed branch, which is
 *  what makes the derived name part of the port's identity rather than a
 *  mutable label. */
const deriveHeadBranch = (
  identity: GitHubReleasePRIdentity,
):
  | { readonly ok: true; readonly branch: string }
  | { readonly ok: false; readonly detail: string } => {
  const parts: readonly (readonly [string, string])[] = [
    ["target", identity.targetBranch],
    ["line", identity.releaseLine],
    ["component", identity.component],
  ];
  for (const [name, token] of parts) {
    const unsafe = refUnsafePart(token);
    if (unsafe !== null) {
      return {
        ok: false,
        detail:
          `the identity's ${name} ${JSON.stringify(token)} cannot name a head branch: ${unsafe} — ` +
          "the derivation refuses rather than open a PR on a branch the grammar cannot own",
      };
    }
  }
  return {
    ok: true,
    branch: `release-craft--branches--${identity.targetBranch}--lines--${identity.releaseLine}--components--${identity.component}`,
  };
};

/** Why a token cannot appear in the derived branch name, or null when it
 *  can. Git's ref grammar first (git-check-ref-format'srefuse classes: the
 *  control characters, the space, `~^:?*[\`, `..`, a leading `-`, a
 *  `.lock` suffix), then the three characters the REST paths this branch
 *  travels in cannot carry safely (`%`, `#`, `?`), then the derivation's
 *  own separator: a token containing `--` could forge the grammar's
 *  delimiters and collide another triplet's branch. */
const refUnsafePart = (token: string): string | null => {
  if (token === "") {
    return "the token is empty";
  }
  for (const character of token) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return "it carries a control character";
    }
  }
  if (/\s/.test(token)) {
    return "it carries whitespace (the claim marker cannot round-trip it either)";
  }
  if (/[~^:?*[\]\\]/.test(token)) {
    return "it carries a character git's ref grammar refuses";
  }
  if (token.includes("..")) {
    return "it carries git's `..` range";
  }
  if (/[%#?]/.test(token)) {
    return "it carries a character the REST path cannot carry unescaped";
  }
  if (token.includes("--")) {
    return "it carries the derivation's own `--` separator";
  }
  // The token may itself carry `/` (a scoped component id), so git's
  // per-component rules are checked over every slash-separated part: no
  // empty part (`//`), none beginning with a dot, none ending `.lock`,
  // none beginning with `-`.
  for (const part of token.split("/")) {
    if (part === "") {
      return "it carries an empty path component (`//`)";
    }
    if (part.startsWith(".")) {
      return `it carries the path component ${JSON.stringify(part)}, which begins with a dot`;
    }
    if (part.endsWith(".lock")) {
      return `it carries the path component ${JSON.stringify(part)}, which ends with git's \`.lock\` suffix`;
    }
    if (part.startsWith("-")) {
      return `it carries the path component ${JSON.stringify(part)}, which begins with \`-\` (git reads that as an option)`;
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// §4 — the transport helpers (the W4 vocabulary, one guarded boundary)
// ---------------------------------------------------------------------------

/** The requested page size — the walk's evidence unit, the reconciliation
 *  walk's own constant (the pagination reference documents 100 as the
 *  maximum for most endpoints, so a page under this size could not have a
 *  successor). */
const PER_PAGE = 100;

/** Every transport call crosses the one guarded boundary (ADR-0010
 *  decision 7): a thrown transport arrives as status 0, whose reading is
 *  the callers' existing one. */
const request = (
  transport: GitHubTransport,
  path: string,
  init?: GitHubRequestInit,
): GitHubResponse => guardedRequest(transport, path, init);

/** A non-200 status through the one §2.3 table. */
const failureOf = (response: GitHubResponse): Failure => {
  const failure = readFailure(response);
  return failure.kind === "refused"
    ? { state: "refused", reason: failure.reason, detail: failure.detail }
    : failure.detail === undefined
      ? { state: "transport-failure" }
      : { state: "transport-failure", detail: failure.detail };
};

/** The provider's own words for a refusal detail. */
const providerWords = (response: GitHubResponse): string | undefined => bodyMessage(response.body);

const asText = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** One row of the pull-request listing, narrowed to the fields the doors
 *  read. A lying row (a number that is not a number, a label that is not a
 *  label) makes the whole listing unusable — the reconciliation walk's
 *  rule: nothing is compared over a lie. */
interface PullRow {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly state: string;
  readonly headRef: string;
  readonly labels: readonly string[];
}

const narrowPull = (row: unknown): PullRow | undefined => {
  if (row === null || typeof row !== "object") {
    return undefined;
  }
  const record = row as Record<string, unknown>;
  const number = record["number"];
  const title = record["title"];
  const body = record["body"];
  const draft = record["draft"];
  const state = record["state"];
  const labels = record["labels"];
  const head = record["head"];
  if (
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    typeof title !== "string" ||
    typeof draft !== "boolean" ||
    typeof state !== "string"
  ) {
    return undefined;
  }
  // The body is the claim's carrier; a null body (GitHub's shape for no
  // description) reads as an empty one — a foreign PR, never a parse
  // error.
  const bodyText = body === null ? "" : asText(body);
  if (bodyText === undefined) {
    return undefined;
  }
  const headRef =
    head !== null && typeof head === "object"
      ? asText((head as Record<string, unknown>)["ref"])
      : undefined;
  if (headRef === undefined) {
    return undefined;
  }
  if (!Array.isArray(labels)) {
    return undefined;
  }
  const names: string[] = [];
  for (const label of labels) {
    const name =
      label !== null && typeof label === "object"
        ? asText((label as Record<string, unknown>)["name"])
        : undefined;
    if (name === undefined) {
      return undefined;
    }
    names.push(name);
  }
  return { number, title, body: bodyText, draft, state, headRef, labels: names };
};

// ---------------------------------------------------------------------------
// §5 — the discovery walk (the pagination-completeness law over PRs)
// ---------------------------------------------------------------------------

/** The listing walk's outcome: the usable rows with the completeness the
 *  chain's end was evidenced to have, or the failure. The walk is the
 *  reconciliation unit's, re-speoken for the pull-request listing: the
 *  pages follow the `Link` header's `rel="next"` to a final page under the
 *  requested size; a full final page with no next is indistinguishable
 *  from a stripped header, so the walk reports it `truncated` and the
 *  discovery refuses — a null over a truncated listing is the duplicate
 *  the claim marker exists to prevent. A cycling chain or a declared next
 *  that names no page faults loudly; a lying row unclaims the listing
 *  entire. */
type WalkOutcome =
  | {
      readonly ok: true;
      readonly rows: readonly PullRow[];
      readonly completeness: "complete" | "truncated";
    }
  | { readonly ok: false; readonly failure: Failure };

const walkOpenPulls = (credentials: GitHubCredentials, transport: GitHubTransport): WalkOutcome => {
  const rows: PullRow[] = [];
  const requested = new Set<string>();
  let path: string | undefined =
    `/repos/${credentials.owner}/${credentials.repo}/pulls?state=open&per_page=${String(PER_PAGE)}`;
  let lastPageRows = 0;
  while (path !== undefined) {
    if (requested.has(path)) {
      // The cycle fault (issue #179; D53): the chain loops, the walk
      // never spins, and the listing claims nothing.
      return { ok: false, failure: { state: "transport-failure" } };
    }
    requested.add(path);
    const response = request(transport, path);
    if (response.status !== 200) {
      return { ok: false, failure: failureOf(response) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return { ok: false, failure: { state: "transport-failure" } };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, failure: { state: "transport-failure" } };
    }
    for (const row of parsed) {
      const pull = narrowPull(row);
      if (pull === undefined) {
        return { ok: false, failure: { state: "transport-failure" } };
      }
      rows.push(pull);
    }
    lastPageRows = parsed.length;
    const next = nextLink(response.headers);
    if (next.kind === "malformed") {
      return { ok: false, failure: { state: "transport-failure" } };
    }
    path = next.kind === "next" ? next.path : undefined;
  }
  return {
    ok: true,
    rows,
    completeness: lastPageRows < PER_PAGE ? "complete" : "truncated",
  };
};

/** The identity search over the walked listing. The completeness law is
 *  the search's premise: only a `complete` walk can answer `none`, because
 *  only a complete walk observed every PR that could have claimed the
 *  identity. A duplicate pair — two open PRs claiming one identity — is
 *  the defect state itself and refuses rather than silently blessing the
 *  older one. */
const discoverPR = (
  credentials: GitHubCredentials,
  transport: GitHubTransport,
  identity: GitHubReleasePRIdentity,
): Discovery => {
  const walk = walkOpenPulls(credentials, transport);
  if (!walk.ok) {
    return walk.failure;
  }
  if (walk.completeness === "truncated") {
    return {
      state: "transport-failure",
      detail:
        "the open pull-request listing ended on a full page with no next link — the walk cannot claim " +
        "which pull requests exist, and a null over an incomplete observation would create a duplicate PR",
    };
  }
  const matches: PullRow[] = [];
  for (const row of walk.rows) {
    const reading = readClaim(row.body);
    if (reading.kind === "malformed") {
      return {
        state: "refused",
        reason: "release-conflict",
        detail:
          `pull request #${String(row.number)} carries the release-craft identity signature but its ` +
          "marker does not parse — refusing to skip it, because a skipped claim would answer none and " +
          "create a duplicate PR (repair or close the PR, then re-run)",
      };
    }
    if (reading.kind === "foreign") {
      continue; // a foreign PR is never adopted — and never refused for being foreign
    }
    if (claimMatches(reading.claim, identity)) {
      matches.push(row);
    }
  }
  if (matches.length > 1) {
    const numbers = matches.map((row) => `#${String(row.number)}`).join(", ");
    return {
      state: "refused",
      reason: "release-conflict",
      detail:
        `the listing holds ${String(matches.length)} open pull requests claiming the identity ` +
        `(${numbers}) — the duplicate pair is the defect this port exists to prevent; ` +
        "close all but one, then re-run",
    };
  }
  const match = matches[0];
  if (match === undefined) {
    return { state: "none" };
  }
  return { state: "found", pr: asExistingPR(match) };
};

const asExistingPR = (row: PullRow): GitHubExistingPR => ({
  number: row.number,
  title: row.title,
  body: row.body,
  headRef: row.headRef,
  draft: row.draft,
  labels: row.labels,
});

// ---------------------------------------------------------------------------
// §6 — the git data API (the projected files' remote writes)
// ---------------------------------------------------------------------------

/** A branch head's read: the sha, a determinate absence (claimed only over
 *  a repository the probe observably reached — a 404 also answers a
 *  repository this credential cannot see, the publication unit's
 *  discrimination), or the failure. */
type RefRead =
  { readonly state: "found"; readonly sha: string } | { readonly state: "absent" } | Failure;

const repoPath = (credentials: GitHubCredentials): string =>
  `/repos/${credentials.owner}/${credentials.repo}`;

/** The ref read's own shape: `{ ref: "refs/heads/<branch>", object: { sha
 *  …, type: "commit" } }`. */
const refShaOf = (parsed: unknown): string | undefined => {
  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  const object = (parsed as Record<string, unknown>)["object"];
  return object !== null && typeof object === "object"
    ? asText((object as Record<string, unknown>)["sha"])
    : undefined;
};

const readBranchHead = (
  credentials: GitHubCredentials,
  transport: GitHubTransport,
  branch: string,
): RefRead => {
  const response = request(
    transport,
    `/repos/${credentials.owner}/${credentials.repo}/git/ref/heads/${branch}`,
  );
  if (response.status === 200) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return { state: "transport-failure" };
    }
    const sha = refShaOf(parsed);
    return sha === undefined ? { state: "transport-failure" } : { state: "found", sha };
  }
  if (response.status !== 404) {
    return failureOf(response);
  }
  // The probe decides what the 404 means (issue #176's discrimination,
  // the publication unit's own): over an observable repository the branch
  // is determinately absent; over an unobservable one nothing was read.
  const probe = request(transport, repoPath(credentials));
  if (probe.status === 200) {
    return { state: "absent" };
  }
  return failureOf(probe);
};

/** A commit's tree sha (the base the projection's tree builds on). */
type CommitRead = { readonly state: "found"; readonly treeSha: string } | Failure;

const readCommitTree = (
  credentials: GitHubCredentials,
  transport: GitHubTransport,
  sha: string,
): CommitRead => {
  const response = request(
    transport,
    `/repos/${credentials.owner}/${credentials.repo}/git/commits/${sha}`,
  );
  if (response.status !== 200) {
    return failureOf(response);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return { state: "transport-failure" };
  }
  const tree =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)["tree"]
      : undefined;
  const treeSha =
    tree !== null && typeof tree === "object"
      ? asText((tree as Record<string, unknown>)["sha"])
      : undefined;
  return treeSha === undefined ? { state: "transport-failure" } : { state: "found", treeSha };
};

/** The projected files as one tree built on the base. A tree object is
 *  unreferenced content until a commit names it, so a lost response here
 *  is the retryable class, not an ambiguous write — nothing observable
 *  landed. */
type TreeWrite = { readonly state: "written"; readonly treeSha: string } | Failure;

const writeTree = (
  credentials: GitHubCredentials,
  transport: GitHubTransport,
  baseTreeSha: string,
  files: readonly GitHubReleasePRFile[],
): TreeWrite => {
  const response = request(transport, `/repos/${credentials.owner}/${credentials.repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: files.map((file) => ({
        path: file.path,
        mode: "100644",
        type: "blob",
        content: file.content,
      })),
    }),
    headers: { "Content-Type": "application/json" },
  });
  if (response.status !== 201) {
    // Status 0 is the retryable class here: the tree is unreferenced
    // content, not state a reader can observe.
    return failureOf(response);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return { state: "transport-failure" };
  }
  const treeSha = asText((parsed as Record<string, unknown> | null)?.["sha"]);
  return treeSha === undefined ? { state: "transport-failure" } : { state: "written", treeSha };
};

/** The commit that carries the tree. Like the tree, an unreferenced
 *  commit: a lost response is the retryable class. */
type CommitWrite = { readonly state: "created"; readonly sha: string } | Failure;

const writeCommit = (
  credentials: GitHubCredentials,
  transport: GitHubTransport,
  treeSha: string,
  parentSha: string,
  message: string,
): CommitWrite => {
  const response = request(
    transport,
    `/repos/${credentials.owner}/${credentials.repo}/git/commits`,
    {
      method: "POST",
      body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }),
      headers: { "Content-Type": "application/json" },
    },
  );
  if (response.status !== 201) {
    return failureOf(response);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return { state: "transport-failure" };
  }
  const sha = asText((parsed as Record<string, unknown> | null)?.["sha"]);
  return sha === undefined ? { state: "transport-failure" } : { state: "created", sha };
};

/** The ref write — the moment the branch exists remotely, and the one
 *  git-data write whose lost response is `ambiguous` (the branch may have
 *  landed unseen; discovery on the retry decides from what actually
 *  holds). A create lands a new ref; an update moves the existing one
 *  fast-forward only — the sync unit's law that the remote's history is
 *  never overwritten standing in the ref API's own key: GitHub answers a
 *  non-fast-forward update with 422, and that is a refusal, never a force. */
type RefWrite = { readonly state: "pushed" } | Failure;

const writeRef = (
  credentials: GitHubCredentials,
  transport: GitHubTransport,
  branch: string,
  sha: string,
  existed: boolean,
): RefWrite => {
  const response = existed
    ? request(
        transport,
        `/repos/${credentials.owner}/${credentials.repo}/git/refs/heads/${branch}`,
        {
          method: "PATCH",
          body: JSON.stringify({ sha, force: false }),
          headers: { "Content-Type": "application/json" },
        },
      )
    : request(transport, `/repos/${credentials.owner}/${credentials.repo}/git/refs`, {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
        headers: { "Content-Type": "application/json" },
      });
  if (response.status === 200 || response.status === 201) {
    return { state: "pushed" };
  }
  if (response.status === 0) {
    const thrown = providerWords(response);
    return thrown === undefined ? { state: "ambiguous" } : { state: "ambiguous", detail: thrown };
  }
  if (response.status === 422) {
    const words = providerWords(response);
    return {
      state: "refused",
      reason: "release-conflict",
      detail:
        `the head branch ${branch} refused the write` +
        (existed ? " (a non-fast-forward update — the branch moved underneath this run)" : "") +
        (words === undefined ? "" : `: ${words}`),
    };
  }
  return failureOf(response);
};

// ---------------------------------------------------------------------------
// §7 — the doors
// ---------------------------------------------------------------------------

/** The projection files written onto a branch head — the create's and the
 *  update's shared file half. The tree is built on the branch's current
 *  tree; a tree whose sha the projection cannot change writes nothing (the
 *  idempotent re-run's evidence is the identical sha, and the commit — the
 *  only observable new object — never happens). */
type FilesWrite = { readonly state: "written"; readonly headSha: string } | Failure;

const writeProjectionFiles = (
  credentials: GitHubCredentials,
  transport: GitHubTransport,
  branch: string,
  parentSha: string,
  files: readonly GitHubReleasePRFile[],
  existed: boolean,
): FilesWrite => {
  const head = readCommitTree(credentials, transport, parentSha);
  if (head.state !== "found") {
    return head;
  }
  const tree = writeTree(credentials, transport, head.treeSha, files);
  if (tree.state !== "written") {
    return tree;
  }
  if (tree.treeSha === head.treeSha) {
    // Byte-exact already: the projection cannot change this tree, so no
    // commit exists to create and the branch's sha stands.
    return { state: "written", headSha: parentSha };
  }
  const commit = writeCommit(credentials, transport, tree.treeSha, parentSha, commitMessage(files));
  if (commit.state !== "created") {
    return commit;
  }
  const ref = writeRef(credentials, transport, branch, commit.sha, existed);
  if (ref.state !== "pushed") {
    return ref;
  }
  return { state: "written", headSha: commit.sha };
};

/** The commit message: the projection's own title — deterministic over the
 *  inputs the gate renders, so the same plan commits the same bytes. */
const commitMessage = (files: readonly GitHubReleasePRFile[]): string =>
  files.length > 0
    ? `chore(release): the release-craft projection (${String(files.length)} ${files.length === 1 ? "file" : "files"})`
    : "chore(release): the release-craft projection";

/** The claim a write's body carries, verified against the write's own
 *  identity: the gate renders the body from the identity, but the port
 *  verifies rather than trusts — a body whose marker disagrees with the
 *  identity the port was given would open a PR that lies about itself, and
 *  a body with no claim at all could never be re-verified by the gate's
 *  update. */
const verifyWriteClaim = (
  body: string,
  identity: GitHubReleasePRIdentity,
): { readonly ok: true } | { readonly ok: false; readonly detail: string } => {
  const reading = readClaim(body);
  if (reading.kind === "malformed") {
    return {
      ok: false,
      detail:
        "the body's release-craft identity marker does not parse — a PR opened over it could never be " +
        "re-verified against the plan it claims",
    };
  }
  if (reading.kind === "foreign") {
    return {
      ok: false,
      detail:
        "the body carries no release-craft identity claim — the gate's update refuses a claim-less body, " +
        "so the port refuses to create one",
    };
  }
  if (!claimMatches(reading.claim, identity)) {
    return {
      ok: false,
      detail:
        `the body's claim (component ${JSON.stringify(reading.claim.component)}, line ` +
        `${JSON.stringify(reading.claim.releaseLine)}, target ${JSON.stringify(reading.claim.targetBranch)}) ` +
        "disagrees with the identity the port was given",
    };
  }
  return { ok: true };
};

/** The pull request's open: 201 is the number; the already-exists answer
 *  is its own outcome — the retry path's discriminator, decided by
 *  discovery, never by trusting the refusal. */
type PullOpen =
  | { readonly state: "opened"; readonly number: number }
  | { readonly state: "already-exists"; readonly detail: string }
  | Failure;

const openPullRequest = (
  credentials: GitHubCredentials,
  transport: GitHubTransport,
  params: {
    readonly head: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
    readonly draft: boolean;
  },
): PullOpen => {
  const response = request(transport, `/repos/${credentials.owner}/${credentials.repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: params.title,
      head: params.head,
      base: params.base,
      body: params.body,
      draft: params.draft,
    }),
    headers: { "Content-Type": "application/json" },
  });
  if (response.status === 201) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return { state: "transport-failure" };
    }
    const number = (parsed as Record<string, unknown> | null)?.["number"];
    return typeof number === "number" && Number.isInteger(number)
      ? { state: "opened", number }
      : { state: "transport-failure" };
  }
  if (response.status === 0) {
    const thrown = providerWords(response);
    return thrown === undefined ? { state: "ambiguous" } : { state: "ambiguous", detail: thrown };
  }
  if (response.status === 422 || response.status === 409) {
    const words = providerWords(response) ?? "";
    if (/already exists/i.test(words) || response.body.includes("already exists")) {
      return {
        state: "already-exists",
        detail:
          words === ""
            ? "the provider answered that a pull request already exists for this head and base"
            : words,
      };
    }
    return {
      state: "refused",
      reason: "release-conflict",
      detail: `the provider refused the pull request create (HTTP ${String(response.status)}${
        words === "" ? "" : `: ${words}`
      })`,
    };
  }
  return failureOf(response);
};

/** The label set write (the issues API owns labels for pull requests).
 *  PUT replaces the set — the byte-exact form of "these are the labels the
 *  projection carries"; the gate passes the merged set it wants. */
type LabelsWrite = { readonly state: "applied" } | Failure;

const writeLabels = (
  credentials: GitHubCredentials,
  transport: GitHubTransport,
  prNumber: number,
  labels: readonly string[],
): LabelsWrite => {
  const response = request(
    transport,
    `/repos/${credentials.owner}/${credentials.repo}/issues/${String(prNumber)}/labels`,
    {
      method: "PUT",
      body: JSON.stringify({ labels }),
      headers: { "Content-Type": "application/json" },
    },
  );
  if (response.status === 200) {
    return { state: "applied" };
  }
  if (response.status === 0) {
    const thrown = providerWords(response);
    return thrown === undefined ? { state: "ambiguous" } : { state: "ambiguous", detail: thrown };
  }
  return failureOf(response);
};

/** One pull request read by number — the update's re-verify read. */
type PullRead = { readonly state: "found"; readonly pr: GitHubExistingPR } | Failure;

const readPullRequest = (
  credentials: GitHubCredentials,
  transport: GitHubTransport,
  prNumber: number,
): PullRead => {
  const response = request(
    transport,
    `/repos/${credentials.owner}/${credentials.repo}/pulls/${String(prNumber)}`,
  );
  if (response.status !== 200) {
    return failureOf(response);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return { state: "transport-failure" };
  }
  const row = narrowPull(parsed);
  if (row === undefined) {
    return { state: "transport-failure" };
  }
  // The update's own premise: the gate found this PR open. A read that
  // now answers closed (or anything else) refuses — a closed PR's fields
  // are not the gate's to move.
  if (row.state !== "open") {
    return {
      state: "refused",
      reason: "release-conflict",
      detail:
        `pull request #${String(row.number)} is ${row.state === "closed" ? "closed" : row.state} — ` +
        "the gate only updates an open PR",
    };
  }
  return { state: "found", pr: asExistingPR(row) };
};

/** The title/body write. A lost response is `ambiguous` — the fields may
 *  have landed unseen; the caller's next read decides. */
type PullPatch =
  | { readonly state: "patched" }
  | { readonly state: "ambiguous"; readonly detail?: string }
  | Failure;

const patchPullFields = (
  credentials: GitHubCredentials,
  transport: GitHubTransport,
  prNumber: number,
  title: string,
  body: string,
): PullPatch => {
  const response = request(
    transport,
    `/repos/${credentials.owner}/${credentials.repo}/pulls/${String(prNumber)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ title, body }),
      headers: { "Content-Type": "application/json" },
    },
  );
  if (response.status === 200) {
    return { state: "patched" };
  }
  if (response.status === 0) {
    const thrown = providerWords(response);
    return thrown === undefined ? { state: "ambiguous" } : { state: "ambiguous", detail: thrown };
  }
  return failureOf(response);
};

/**
 * Opens the Release PR port on the open credentials and the injected
 * transport. Synchronous, like every unit; the doors speak the classified
 * outcomes internally and the port view (the interface the app gate
 * consumes) carries a refusal as the classified fault.
 */
export function GitReleasePR(
  credentials: GitHubCredentials,
  transport: GitHubTransport,
): GitHubReleasePRPort {
  return {
    findPR(identity: GitHubReleasePRIdentity): GitHubExistingPR | null {
      const found = discoverPR(credentials, transport, identity);
      if (found.state === "found") {
        return found.pr;
      }
      if (found.state === "none") {
        return null;
      }
      throw new GitHubReleasePRFault("findPR", found);
    },

    createPR(params: GitHubReleasePRCreateParams): GitHubExistingPR {
      const branch = deriveHeadBranch(params.identity);
      if (!branch.ok) {
        throw new GitHubReleasePRFault("createPR", {
          state: "refused",
          reason: "release-conflict",
          detail: branch.detail,
        });
      }
      const claim = verifyWriteClaim(params.body, params.identity);
      if (!claim.ok) {
        throw new GitHubReleasePRFault("createPR", {
          state: "refused",
          reason: "release-conflict",
          detail: claim.detail,
        });
      }
      const target = readBranchHead(credentials, transport, params.identity.targetBranch);
      if (target.state !== "found") {
        throw new GitHubReleasePRFault(
          "createPR",
          target.state === "absent"
            ? {
                state: "refused",
                reason: "release-conflict",
                detail: `the target branch ${params.identity.targetBranch} does not exist — a pull request cannot open against it`,
              }
            : target,
        );
      }
      const head = readBranchHead(credentials, transport, branch.branch);
      if (head.state !== "found" && head.state !== "absent") {
        throw new GitHubReleasePRFault("createPR", head);
      }
      const files = writeProjectionFiles(
        credentials,
        transport,
        branch.branch,
        head.state === "found" ? head.sha : target.sha,
        params.files,
        head.state === "found",
      );
      if (files.state !== "written") {
        throw new GitHubReleasePRFault("createPR", files);
      }
      const opened = openPullRequest(credentials, transport, {
        head: branch.branch,
        base: params.identity.targetBranch,
        title: params.title,
        body: params.body,
        draft: params.draft,
      });
      if (opened.state === "already-exists") {
        // The provider says the PR exists; discovery decides from the
        // claims, never from the refusal. A claim-matching PR is the
        // adopted retry; a listing with no claim for this identity means
        // a foreign PR occupies the derived branch — refused, never
        // adopted (the foreign-PR law survives the recovery path).
        const existing = discoverPR(credentials, transport, params.identity);
        if (existing.state === "found") {
          const labels = writeLabels(credentials, transport, existing.pr.number, params.labels);
          if (labels.state !== "applied") {
            throw new GitHubReleasePRFault("createPR", {
              state: "partial",
              detail:
                `the pull request #${String(existing.pr.number)} was adopted (the create's own response ` +
                `was lost or its answer was already-exists), but the label write ended ${describeOutcome(labels)}`,
            });
          }
          return existing.pr;
        }
        throw new GitHubReleasePRFault("createPR", {
          state: "refused",
          reason: "release-conflict",
          detail:
            "the provider refused the create because a pull request already exists on the derived " +
            `head branch ${branch.branch}, and the listing holds no open PR claiming this identity — ` +
            "a foreign PR occupies the branch; refusing to adopt it",
        });
      }
      if (opened.state !== "opened") {
        // The branch may carry the projection with no PR: the partial
        // create's loud record names exactly what landed, so the retry's
        // findPR can adopt instead of duplicating.
        const whatLanded = `the head branch ${branch.branch} was pushed with the projection (head ${files.headSha})`;
        const tail =
          opened.state === "refused"
            ? `but the pull request create was refused: ${opened.detail}`
            : opened.state === "ambiguous"
              ? `but the pull request create's response was lost${
                  opened.detail === undefined ? "" : ` (${opened.detail})`
                } — the PR may have landed unseen`
              : `but the pull request create failed in transport${opened.detail === undefined ? "" : `: ${opened.detail}`}`;
        throw new GitHubReleasePRFault(
          "createPR",
          opened.state === "refused"
            ? {
                state: "refused",
                reason: opened.reason,
                detail: `${whatLanded}, ${tail} — the retry path is findPR, which adopts the claim-matching PR instead of duplicating`,
              }
            : opened.state === "ambiguous"
              ? {
                  state: "ambiguous",
                  detail: `${whatLanded}, ${tail} — the retry path is findPR, which adopts the claim-matching PR instead of duplicating`,
                }
              : {
                  state: "transport-failure",
                  detail: `${whatLanded}, ${tail} — the retry path is findPR, which adopts the claim-matching PR instead of duplicating`,
                },
        );
      }
      const labels = writeLabels(credentials, transport, opened.number, params.labels);
      if (labels.state !== "applied") {
        throw new GitHubReleasePRFault("createPR", {
          state: "partial",
          detail:
            `the pull request #${String(opened.number)} opened, but the label write ended ` +
            `${labels.state}${labels.state === "refused" ? ` (${labels.reason})` : ""}`,
        });
      }
      return {
        number: opened.number,
        title: params.title,
        body: params.body,
        headRef: branch.branch,
        draft: params.draft,
        labels: [...params.labels],
      };
    },

    updatePR(params: GitHubReleasePRUpdateParams): GitHubExistingPR {
      const read = readPullRequest(credentials, transport, params.prNumber);
      if (read.state !== "found") {
        throw new GitHubReleasePRFault("updatePR", read);
      }
      const current = read.pr;
      // The re-verify: the body the gate saw at find time may not be the
      // body on the remote now. A claim that vanished is a human edit the
      // port refuses to overwrite; a claim whose identity disagrees with
      // the head branch it sits on is a tampered PR.
      const reading = readClaim(current.body);
      if (reading.kind !== "claim") {
        throw new GitHubReleasePRFault("updatePR", {
          state: "refused",
          reason: "release-conflict",
          detail:
            reading.kind === "malformed"
              ? `pull request #${String(current.number)} carries the release-craft identity signature but its marker does not parse — refusing to overwrite it`
              : `pull request #${String(current.number)} carries no release-craft identity claim — refusing to overwrite a foreign or human-edited body`,
        });
      }
      const derived = deriveHeadBranch({
        component: reading.claim.component,
        releaseLine: reading.claim.releaseLine,
        targetBranch: reading.claim.targetBranch,
      });
      if (derived.ok && derived.branch !== current.headRef) {
        throw new GitHubReleasePRFault("updatePR", {
          state: "refused",
          reason: "release-conflict",
          detail:
            `pull request #${String(current.number)} claims the identity ` +
            `(component ${JSON.stringify(reading.claim.component)}, line ${JSON.stringify(reading.claim.releaseLine)}, ` +
            `target ${JSON.stringify(reading.claim.targetBranch)}) but sits on the head branch ${current.headRef}, ` +
            `not the derived ${derived.branch} — the marker and the branch disagree`,
        });
      }
      if (params.draft !== current.draft) {
        throw new GitHubReleasePRFault("updatePR", {
          state: "refused",
          reason: "release-conflict",
          detail:
            `the update demands draft ${String(params.draft)} but the pull request is ` +
            `${current.draft ? "a draft" : "ready for review"} — the REST transport cannot flip a draft; ` +
            "the gate passes the PR's own draft",
        });
      }
      const head = readBranchHead(credentials, transport, current.headRef);
      if (head.state === "absent") {
        throw new GitHubReleasePRFault("updatePR", {
          state: "refused",
          reason: "release-conflict",
          detail:
            `the pull request's head branch ${current.headRef} is gone — GitHub closes such a pull request; ` +
            "a new PR is required",
        });
      }
      if (head.state !== "found") {
        throw new GitHubReleasePRFault("updatePR", head);
      }
      // Files first: the claim (the body) moves last, so a crash never
      // leaves a body claiming content the branch does not carry.
      const files = writeProjectionFiles(
        credentials,
        transport,
        current.headRef,
        head.sha,
        params.files,
        true,
      );
      if (files.state !== "written") {
        throw new GitHubReleasePRFault("updatePR", files);
      }
      let pr: GitHubExistingPR = current;
      if (current.title !== params.title || current.body !== params.body) {
        const patched = patchPullFields(
          credentials,
          transport,
          current.number,
          params.title,
          params.body,
        );
        if (patched.state !== "patched") {
          throw new GitHubReleasePRFault("updatePR", patched);
        }
        pr = { ...pr, title: params.title, body: params.body };
      }
      if (!sameLabels(current.labels, params.labels)) {
        const labels = writeLabels(credentials, transport, current.number, params.labels);
        if (labels.state !== "applied") {
          throw new GitHubReleasePRFault("updatePR", {
            state: "partial",
            detail:
              `the pull request #${String(current.number)} was updated in place, but the label write ended ` +
              describeOutcome(labels),
          });
        }
        pr = { ...pr, labels: [...params.labels] };
      }
      return pr;
    },
  };
}

/** A failed write's words for a partial-outcome detail: the state, the
 *  refusal reason when the provider declined, the provider's own words
 *  when it offered any. */
const describeOutcome = (failure: Failure): string =>
  failure.state === "refused"
    ? `${failure.state} (${failure.reason}): ${failure.detail}`
    : failure.detail === undefined
      ? failure.state
      : `${failure.state}: ${failure.detail}`;

/** Label-set equality as sequences — the gate's merged set keeps the PR's
 *  existing order, so an already-applied set compares equal and writes
 *  nothing (the idempotent update's third no-op). */
const sameLabels = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((label, index) => label === right[index]);
