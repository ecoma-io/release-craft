/**
 * §2.3 — extraction: commit observations mapped to candidate changes, with
 * the self-reference rule applied before classification (§2.12).
 *
 * One deterministic sweep over the observations in input order. Per commit,
 * in contract order:
 *
 *   1. The self-reference namespace rule (§2.12, PL-04) runs FIRST, over the
 *      message's trailer block only (the last paragraph): a well-formed
 *      `<namespace> <value>` line classifies the commit `self-reference` and
 *      excludes it; a line carrying the namespace — or the namespace minus
 *      its trailing colon at a word boundary — without being well-formed
 *      classifies `malformed-marker` and surfaces for explicit review, never
 *      silent exclusion. Neither is ever parsed as a conventional commit.
 *   2. Conventional-commit classification: merge commits (two or more
 *      parents) and headers without the `type(scope)!: subject` shape are
 *      `unparseable` and surfaced — excluded is not invisible. Breaking is
 *      the header `!` or a `BREAKING CHANGE: ` footer line, for any type.
 *   3. Identity, first match wins (fork 8): a `Change-Id: <value>` footer;
 *      else a `(cherry picked from commit <sha>)` trailer; else the commit's
 *      own sha (recorded provenance). A blank footer value is no match and
 *      falls through to the next step. A cherry-pick inherits its origin's
 *      identity — transitively, across the whole observed chain (§2.3: one
 *      logical fix is one change, M-03; the kernel's F″→F′→F) — with
 *      `lineage.originCommit` recording the direct parent; an unobserved
 *      origin keeps the raw sha, and a cycle stops deterministically. The
 *      kernel value is built through `Change.of`; a kernel rejection —
 *      padded identity data chiefly — is a surfaced `unparseable` record,
 *      never a throw (§2.9: negative outcomes are records).
 *   4. Conflicts (M-05): one resolved identity claimed independently by two
 *      or more commits, or a cherry-pick whose immediate origin sha is
 *      absent from the observed commit set, is surfaced as an
 *      `IdentityConflict` in first-appearance order; the involved commits
 *      stay individual `ParsedCommit`s — never merged away, never
 *      fuzzy-matched.
 *
 * Purity and determinism (invariant 2, E-10, §2.14): no clock, no
 * randomness, no environment, no filesystem, no network. `commits` preserves
 * input order; `excluded` and `conflicts` accumulate in first-appearance
 * order; identical observations produce deep-equal results. The kernel is
 * reached only through the `@ecoma-io/release-craft/domain` alias — the one
 * archkeep-visible edge, spelled exactly as src/index.ts spells it.
 */

import { Change, InvalidChangeError, type ChangeLineage } from "@ecoma-io/release-craft/domain";
import type {
  CommitObservation,
  ExcludedCommit,
  ExtractChanges,
  IdentityConflict,
  IdentitySource,
  ParsedCommit,
} from "./types.js";

// ---------------------------------------------------------------------------
// message geometry — the trailer block (§2.12: the marker namespace lives
// in the last paragraph, git's trailer section, never in the subject or
// the body)
// ---------------------------------------------------------------------------

/** The message's trailer block: the lines of the last blank-line-separated
 * paragraph. A trailing blank line is not a paragraph. */
function trailerLinesOf(message: string): readonly string[] {
  const lastParagraph =
    message
      .trimEnd()
      .split(/\r?\n[ \t]*\r?\n/)
      .pop() ?? "";
  return lastParagraph === "" ? [] : lastParagraph.split(/\r?\n/);
}

// ---------------------------------------------------------------------------
// the namespace rule (§2.12, the locked shared decision)
// ---------------------------------------------------------------------------

/** What one trailer-block scan decides about the marker namespace. */
type MarkerVerdict =
  | { readonly kind: "self-reference"; readonly value: string }
  | { readonly kind: "malformed-marker"; readonly line: string };

/** The first trailer line carrying the self-reference namespace decides the
 * commit — a line-by-line scan, first marker wins, deterministically:
 *
 *   - well-formed: `<namespace> <non-empty value>` — the namespace exactly,
 *     case-sensitively, then exactly one separating space, then a value that
 *     rides verbatim (the kernel's opaque discipline: extraction never
 *     normalizes identity-bound data);
 *   - malformed: the line starts with the namespace, or with the namespace
 *     minus its trailing colon at a word boundary (followed by end-of-line,
 *     whitespace, `:` or `-`), without being well-formed — §2.12's
 *     fail-toward-explicit-review case.
 *
 * An empty namespace (a caller-contract violation `input.ts` rejects) names
 * no reserved namespace and matches nothing. */
function markerVerdictOf(
  trailers: readonly string[],
  namespace: string,
): MarkerVerdict | undefined {
  if (namespace === "") return undefined;
  for (const line of trailers) {
    if (line.startsWith(namespace)) {
      const wellFormed =
        line.length > namespace.length &&
        line[namespace.length] === " " &&
        line.slice(namespace.length + 1) !== "";
      if (wellFormed) return { kind: "self-reference", value: line.slice(namespace.length + 1) };
      return { kind: "malformed-marker", line };
    }
    if (namespace.endsWith(":")) {
      const bare = namespace.slice(0, -1);
      if (bare !== "" && line.startsWith(bare)) {
        const next = line[bare.length];
        if (next === undefined || next === " " || next === "\t" || next === ":" || next === "-") {
          return { kind: "malformed-marker", line };
        }
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// conventional-commit classification (extraction's second step)
// ---------------------------------------------------------------------------

/** The conventional header shape: `type(scope)!: subject`, `type!: subject`,
 * `type: subject` — a type starting with a letter, a non-empty scope when
 * parenthesized, the breaking `!`, exactly one space, a non-empty subject.
 * Anything else has "no conventional commit header". */
const CONVENTIONAL_HEADER = /^([A-Za-z][A-Za-z0-9-]*)(?:\(([^)]+)\))?(!)?: (\S.*)$/;

/** The breaking footer line — any type is breaking when it is present. */
const BREAKING_FOOTER = /^BREAKING CHANGE: /;

/** The parsed header, with only the fields the header itself supplied. */
interface ConventionalHeader {
  readonly type: string;
  readonly scope?: string;
  readonly subject: string;
  readonly breakingByBang: boolean;
}

function parseConventionalHeader(header: string): ConventionalHeader | undefined {
  const match = CONVENTIONAL_HEADER.exec(header);
  if (match === null) return undefined;
  const type = match[1];
  const subject = match[4];
  if (type === undefined || subject === undefined) return undefined;
  const scope = match[2];
  return {
    type,
    ...(scope !== undefined ? { scope } : {}),
    subject,
    breakingByBang: match[3] === "!",
  };
}

// ---------------------------------------------------------------------------
// identity, first match wins (§2.3, fork 8)
// ---------------------------------------------------------------------------

/** The `Change-Id:` footer prefix; the single space after the colon is the
 * footer's separator syntax, exactly as the namespace rule's is. */
const CHANGE_ID_PREFIX = "Change-Id: ";

/** The cherry-pick trailer, its origin sha captured verbatim (no whitespace
 * can survive the capture, so the kernel's opaque discipline holds). */
const CHERRY_PICK_TRAILER = /^\(cherry picked from commit (\S+)\)$/;

/** The shallow identity §2.3's first match yields, before chain resolution:
 * `rawId` is the one-hop id (footer value, origin sha, or own sha); a
 * cherry-pick also records its immediate `originSha` — the direct parent in
 * the chain, which is what `lineage.originCommit` records. */
interface ShallowIdentity {
  readonly source: IdentitySource;
  readonly rawId: string;
  readonly originSha?: string;
}

/** The first non-blank `Change-Id: <value>` footer value in the trailer
 * block, or undefined — a blank value is no match, and the step falls
 * through to the cherry-pick trailer, then to the commit's own sha. */
function changeIdValueOf(trailers: readonly string[]): string | undefined {
  for (const line of trailers) {
    if (!line.startsWith(CHANGE_ID_PREFIX)) continue;
    const value = line.slice(CHANGE_ID_PREFIX.length);
    if (value.trim() !== "") return value;
  }
  return undefined;
}

/** The first well-formed cherry-pick trailer's origin sha, or undefined —
 * a malformed trailer is no match, and the step falls through. */
function cherryPickOriginOf(trailers: readonly string[]): string | undefined {
  for (const line of trailers) {
    const match = CHERRY_PICK_TRAILER.exec(line);
    const origin = match?.[1];
    if (origin !== undefined) return origin;
  }
  return undefined;
}

function resolveShallowIdentity(
  observation: CommitObservation,
  trailers: readonly string[],
): ShallowIdentity {
  const footerValue = changeIdValueOf(trailers);
  if (footerValue !== undefined) return { source: "change-id-footer", rawId: footerValue };
  const originSha = cherryPickOriginOf(trailers);
  if (originSha !== undefined) return { source: "cherry-pick-origin", rawId: originSha, originSha };
  return { source: "commit-sha", rawId: observation.sha };
}

/** §2.3's one-identity promise across a cherry-pick chain (M-03; the
 * kernel's F″→F′→F): a cherry-pick's identity is its origin's identity,
 * recursively, so chain depth never splits one logical fix. While the sha
 * under resolution names an observed cherry-pick candidate, the walk follows
 * the chain; it stops at a root candidate (its footer value or own sha), at
 * an unobserved or non-candidate sha (the raw sha — dangling provenance
 * included), or at a cycle: a self- or mutual-referential origin is its own
 * root, stopped at the first repeated sha. */
function cherryRootIdOf(
  originSha: string,
  candidatesBySha: ReadonlyMap<string, ShallowIdentity>,
): string {
  const visited = new Set<string>();
  let current = originSha;
  for (;;) {
    const candidate = candidatesBySha.get(current);
    if (candidate === undefined) return current;
    if (candidate.source !== "cherry-pick-origin") return candidate.rawId;
    if (visited.has(current)) return current;
    visited.add(current);
    const next = candidate.originSha;
    if (next === undefined) return current;
    current = next;
  }
}

/** The lineage §2.3 records for each identity source: a cherry-pick's
 * immediate origin sha — the direct parent in the chain, hop by hop, even
 * though the id itself carries the resolved root; a self-identified commit's
 * own sha as its recorded provenance; nothing for an explicit `Change-Id`,
 * which carries no observable chain. */
function lineageOf(
  identity: ShallowIdentity,
  observation: CommitObservation,
): ChangeLineage | undefined {
  if (identity.source === "cherry-pick-origin") {
    const origin = identity.originSha;
    return origin === undefined ? undefined : { originCommit: origin };
  }
  if (identity.source === "commit-sha") return { originCommit: observation.sha };
  return undefined;
}

/** The kernel value, or the rejection reason. Blank ids never reach here —
 * the identity steps fall through on them — so what this catches is the
 * kernel's remaining rejections, padded identity fields chiefly: a data
 * fact to surface (§2.9), never a throw to escape extraction with. */
function changeOf(
  id: string,
  lineage: ChangeLineage | undefined,
):
  { readonly ok: true; readonly change: Change } | { readonly ok: false; readonly reason: string } {
  try {
    return { ok: true, change: Change.of(id, lineage) };
  } catch (error) {
    if (error instanceof InvalidChangeError) return { ok: false, reason: error.reason };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// conflicts (M-05 — one identity, divergent payloads)
// ---------------------------------------------------------------------------

/** One commit's claim on a change identity. */
interface IdentityClaim {
  readonly sha: string;
  readonly source: IdentitySource;
  /** Present exactly when the claim came from a cherry-pick trailer: the
   * immediate origin sha whose presence in the commit set decides whether
   * the provenance dangles. */
  readonly originSha?: string;
}

/** The conflict pass, over claims grouped by resolved id in first-appearance
 * order (Map insertion order — the stable-order discipline, never a sort):
 *
 *   - two or more independent claims (any source but `cherry-pick-origin`)
 *     on one id → the M-05 conflict, naming the independent claimers;
 *   - a cherry-pick claim whose immediate origin sha is absent from the
 *     observed commit set → the dangling-provenance conflict. Cherry-picks
 *     whose origin IS observed resolve to one identity with their chain
 *     (M-03's success path) and conflict never. */
function conflictsOf(
  claimsById: ReadonlyMap<string, readonly IdentityClaim[]>,
  observedShas: ReadonlySet<string>,
): IdentityConflict[] {
  const conflicts: IdentityConflict[] = [];
  for (const [changeId, claims] of claimsById) {
    const independent = claims.filter((claim) => claim.source !== "cherry-pick-origin");
    if (independent.length >= 2) {
      conflicts.push({
        changeId,
        shas: independent.map((claim) => claim.sha),
        detail:
          `change identity ${JSON.stringify(changeId)} is claimed independently by commits ` +
          independent.map((claim) => JSON.stringify(claim.sha)).join(", "),
      });
      continue;
    }
    // A cherry-pick whose immediate origin sha is absent from the observed
    // set dangles: its provenance cannot be resolved, so the identity is
    // surfaced, never merged on a guess (the locked M-05 rule). The check is
    // per claim, on the claim's own origin — a cherry-pick that resolved
    // through an observed chain always has an observed origin and never
    // conflicts.
    const dangling = claims.filter(
      (claim) => claim.originSha !== undefined && !observedShas.has(claim.originSha),
    );
    if (dangling.length > 0) {
      conflicts.push({
        changeId,
        shas: dangling.map((claim) => claim.sha),
        detail:
          `cherry-pick origin ${JSON.stringify(changeId)} is absent from the observed commit set ` +
          `(claimed by commits ${dangling.map((claim) => JSON.stringify(claim.sha)).join(", ")})`,
      });
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// the extraction pass itself
// ---------------------------------------------------------------------------

/** One commit's classified outcome: already excluded (with its surfaced
 * entry and evidence row), or a candidate whose kernel value awaits chain
 * resolution in pass two. */
type ExtractionSlot =
  | { readonly kind: "excluded"; readonly entry: ExcludedCommit; readonly parsed: ParsedCommit }
  | {
      readonly kind: "candidate";
      readonly observation: CommitObservation;
      readonly conventional: ConventionalHeader;
      readonly breaking: boolean;
      readonly shallow: ShallowIdentity;
    };

/**
 * The frozen §2.3 signature. Every input commit appears in `commits` exactly
 * once, in input order, whatever its classification — the excluded set is
 * the explanation (§2.12: excluded is not invisible), the commit list is the
 * evidence (PL-04).
 */
export const extract: ExtractChanges = (commits, policy) => {
  const parsed: ParsedCommit[] = [];
  const excluded: ExcludedCommit[] = [];
  const claimsById = new Map<string, IdentityClaim[]>();
  const observedShas = new Set<string>();
  const candidatesBySha = new Map<string, ShallowIdentity>();
  const slots: ExtractionSlot[] = [];

  // Pass one — classify. The namespace rule runs first (§2.12): marker
  // commits never reach conventional parsing at all. Merges are named before
  // shape: a merge commit is unparseable for being a merge, whatever its
  // header reads. Candidates park their shallow identity; no kernel value is
  // built until every chain link is known.
  for (const observation of commits) {
    observedShas.add(observation.sha);
    const header = observation.message.split(/\r?\n/, 1)[0] ?? "";
    const trailers = trailerLinesOf(observation.message);

    const marker = markerVerdictOf(trailers, policy.selfReferenceNamespace);
    if (marker !== undefined) {
      slots.push(
        marker.kind === "self-reference"
          ? {
              kind: "excluded",
              entry: {
                sha: observation.sha,
                rule: "self-reference",
                detail: `self-reference marker value ${JSON.stringify(marker.value)}`,
              },
              parsed: {
                sha: observation.sha,
                classification: "self-reference",
                subject: header,
                breaking: false,
              },
            }
          : {
              kind: "excluded",
              entry: {
                sha: observation.sha,
                rule: "malformed-marker",
                detail: `malformed self-reference marker ${JSON.stringify(marker.line)} in the trailer block`,
              },
              parsed: {
                sha: observation.sha,
                classification: "malformed-marker",
                subject: header,
                breaking: false,
              },
            },
      );
      continue;
    }

    const conventional = parseConventionalHeader(header);
    if (observation.parents.length >= 2 || conventional === undefined) {
      slots.push({
        kind: "excluded",
        entry: {
          sha: observation.sha,
          rule: "unparseable",
          detail:
            observation.parents.length >= 2 ? "merge commit" : "no conventional commit header",
        },
        parsed: {
          sha: observation.sha,
          classification: "unparseable",
          subject: header,
          breaking: false,
        },
      });
      continue;
    }

    const shallow = resolveShallowIdentity(observation, trailers);
    candidatesBySha.set(observation.sha, shallow);
    slots.push({
      kind: "candidate",
      observation,
      conventional,
      breaking: conventional.breakingByBang || trailers.some((line) => BREAKING_FOOTER.test(line)),
      shallow,
    });
  }

  // Pass two — resolve identities in input order, build the kernel values,
  // and let each candidate claim its resolved identity for the conflict pass.
  for (const slot of slots) {
    if (slot.kind === "excluded") {
      excluded.push(slot.entry);
      parsed.push(slot.parsed);
      continue;
    }
    // Identity (fork 8) resolved across the observed chain (§2.3, M-03). A
    // kernel rejection — a padded identity field, say — surfaces as an
    // unparseable record; the still-parsed header shape rides along.
    const id =
      slot.shallow.source === "cherry-pick-origin"
        ? cherryRootIdOf(slot.shallow.originSha ?? slot.observation.sha, candidatesBySha)
        : slot.shallow.rawId;
    const built = changeOf(id, lineageOf(slot.shallow, slot.observation));
    if (!built.ok) {
      excluded.push({
        sha: slot.observation.sha,
        rule: "unparseable",
        detail: `change identity rejected by the kernel: ${built.reason}`,
      });
      parsed.push({
        sha: slot.observation.sha,
        classification: "unparseable",
        type: slot.conventional.type,
        ...(slot.conventional.scope !== undefined ? { scope: slot.conventional.scope } : {}),
        subject: slot.conventional.subject,
        breaking: slot.breaking,
      });
      continue;
    }
    const claims = claimsById.get(id) ?? [];
    if (claims.length === 0) claimsById.set(id, claims);
    claims.push({
      sha: slot.observation.sha,
      source: slot.shallow.source,
      ...(slot.shallow.originSha !== undefined ? { originSha: slot.shallow.originSha } : {}),
    });
    parsed.push({
      sha: slot.observation.sha,
      classification: "change",
      type: slot.conventional.type,
      ...(slot.conventional.scope !== undefined ? { scope: slot.conventional.scope } : {}),
      subject: slot.conventional.subject,
      breaking: slot.breaking,
      change: built.change,
      identitySource: slot.shallow.source,
    });
  }

  // 4. Conflicts, first-appearance order.
  return { commits: parsed, excluded, conflicts: conflictsOf(claimsById, observedShas) };
};
