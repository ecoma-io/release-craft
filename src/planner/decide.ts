/**
 * §2.7 + §2.9 — bump resolution and per-line decision records.
 *
 * The commit-type → `Bump` mapping is policy data, never kernel state (§2.7,
 * ADR-0003 decision 6): `resolveBump` looks the declared mapping up by
 * `policy.bumpMappingId` — only `"default"` exists in Phase 2, and an
 * unknown id is a caller contract violation that throws, the same posture as
 * `input.ts` and `attribute.ts` — then folds `Bump.max` over the pending
 * commits in input order. A breaking marker dominates any type, even one
 * absent from the mapping (PL-05), so a breaking chore is release-triggering
 * and major. An empty release-worthy set resolves to `undefined`, the no-op
 * cause (§2.9); the empty group mints nothing and `ChangeSet.empty`'s
 * neutral `"patch"` level is never read as a decision (PL-06, S-01).
 *
 * `decideLine` turns one line's attribution into exactly one record, in
 * contract precedence: a `frozen` or `retired` lifecycle refuses
 * release-shaped planning outright — the `refused` record (`line-frozen` /
 * `line-retired`) lands regardless of pending changes or intents, since the
 * refusal is the planning semantics (D18 decision 2, ADR-0004); `blocked`
 * on a missing bootstrap decision (S-02, ADR-0003 decision 13 — keyed on
 * the range's `releasedUpTo` bound being `null`, reviewer m-4, never on the
 * attribution's released-identity count); then the intent routing
 * (D17(4)(5)): exact-duplicate intents collapse first; `promote` ×
 * `release-anyway` on one line is an operator contradiction; a `promote`
 * over an in-flight prerelease is the P-03 release with an inherited
 * (empty) change set and `bump: null`, and over release-worthy pending
 * changes or a pointer not held by a prerelease it refuses — a sibling
 * `prerelease` demand for the line is subsumed by the promotion (D38) and
 * named in the record; a `release-anyway` over a quiet line is the
 * `forced` record — never a routine release; a `release-as` demand the
 * kernel grammar cannot parse refuses regardless of the runway.
 * Thereafter: `refused` on the remaining
 * operator contradiction (§2.9, S-01: an explicit `release-as` demand
 * against a runway with nothing release-worthy); `blocked` on a
 * `release-as` demand naming a version the line's own history already
 * observes — the replay the recorded state refuses (§2.9 as amended,
 * #263); then the declared
 * withhold rules (D18 decision 3, PL-07): matching release-triggering
 * changes defer — the release range pins below the earliest withheld
 * commit when a release-worthy prefix survives there, and a line left with
 * nothing release-worthy yields the `withheld` record (`policy-filter`)
 * instead of a mint; then `blocked` on the released-version replay — a
 * release-shaped pass over the fully released range of a line whose birth
 * the recorded state carries (the §2.1 bootstrap decision): the latest
 * admitted tag sits at the feed-ref head, so the dispatch would re-plan
 * the version the world already observes, and the record refuses it
 * (#263). The recorded bootstrap is the discriminator: a line claims the
 * run's recorded birth when its own projected history admits the birth
 * version — that line was born through the tool and owns its release
 * identity (§2.13, #197 — one identity is one member), so a re-demanded
 * release over its released head is the replay; a line whose history
 * predates the tool carries no recorded birth, and its quiet released head
 * stays the recorded no-op (M-01's `main`, M-07's quiet line, S-05's
 * maintenance line). An admissible prerelease
 * demand keeps the ladder's no-op-plus-streams posture, and a passive pass
 * stays the recorded no-op. Otherwise the recorded no-op with
 * the ignored commits
 * enumerated in input order (§2.9, PL-06) or the `release` record whose
 * kernel change set is constructed through `ChangeSet.of` — a kernel
 * construction rejection surfaces as a `refused` record and is never
 * re-thrown (§2.9, ADR-0003 decision 1).
 *
 * The pointer a `promote` is judged against is re-derived from the same
 * §2.13 projection `history.ts` owns (D10): `decideLine`'s frozen signature
 * carries no rebuilt state, so the pointer is the line's
 * highest-precedence admissible tag — `undefined` at line birth. Pure,
 * deterministic, and never the manifest (invariant 6, S-03).
 *
 * One negative record still has no Phase 2 producer and is deliberately
 * never emitted here: `blocked`/`stale-plan` (staleness is recognized
 * against a stored plan, §2.10). `withheld`/`policy-filter` is produced
 * here since D18 decision 3 made the line's withhold rules planning input;
 * the `blocked` causes produced here are `bootstrap-required` (S-02) and —
 * since #263 — `released-version-observed`; the remaining `refused` causes
 * are produced upstream by `attribute.ts`.
 *
 * Pure and deterministic (invariant 2): no clock, environment, randomness,
 * filesystem, or network; every enumeration stays in input order (E-10).
 */

import {
  Bump,
  ChangeSet,
  InvalidChangeSetError,
  InvalidVersionError,
  Version,
  type Change,
} from "@ecoma-io/release-craft/domain";

import { loadTagHistory } from "./history.js";
import { InvalidPlanningInputError } from "./input.js";
import { isStreamAllowed } from "./plan.js";
import type {
  AdmissibleTag,
  BootstrapDecision,
  BumpMapping,
  DecideLine,
  LineConfig,
  LineDecision,
  LineRange,
  OperatorIntent,
  ParsedCommit,
  PlanningInput,
  PolicyInput,
  ResolveBump,
} from "./types.js";

/**
 * The `default` commit-type → `Bump` mapping (§2.7, ADR-0003 decision 6):
 * `feat` → minor, `fix`/`perf`/`refactor` → patch. `chore`, `docs`, `ci` and
 * `test` are deliberately absent — a non-breaking commit of those types is
 * not release-triggering (S-01, PL-06) and surfaces in the no-op record's
 * `ignored` enumeration. Absence never hides a breaking change: the marker
 * dominates filtering, so a breaking commit of an unlisted type is still
 * release-triggering (PL-05).
 */
const DEFAULT_BUMP_MAPPING: BumpMapping = Object.freeze({
  feat: "minor",
  fix: "patch",
  perf: "patch",
  refactor: "patch",
});

/**
 * The declared mapping for one policy (§2.7). Only the `default` mapping is
 * declared in Phase 2; anything else never entered the policy vocabulary, so
 * it is a caller contract violation — thrown with the input field path, as
 * `input.ts` records violations — not a planning outcome.
 */
function mappingFor(policy: PolicyInput): BumpMapping {
  if (policy.bumpMappingId !== "default") {
    throw new InvalidPlanningInputError([
      {
        field: "policy.bumpMappingId",
        problem: `unknown bump mapping id "${policy.bumpMappingId}" — only "default" is declared in Phase 2`,
      },
    ]);
  }
  return DEFAULT_BUMP_MAPPING;
}

/**
 * One commit's bump contribution (§2.7): a breaking marker dominates any
 * type — including a type absent from the mapping (PL-05) — then the
 * declared mapping decides; `undefined` when the commit is not
 * release-triggering (S-01, PL-06). Absence is data here, never a default.
 * With `noUncheckedIndexedAccess`, an unlisted type reads `undefined`
 * directly — exactly the not-release-triggering answer.
 */
function commitBump(mapping: BumpMapping, parsed: ParsedCommit): Bump | undefined {
  if (parsed.breaking) return "major";
  if (parsed.type === undefined) return undefined;
  return mapping[parsed.type];
}

export const resolveBump: ResolveBump = (pending, policy) => {
  const mapping = mappingFor(policy);
  // §2.7: `Bump.max` over the release-triggering commits. The fold order is
  // input order (deterministic, invariant 2), and `Bump.max` is total, so
  // the result is order-independent anyway; `undefined` only when no commit
  // qualifies — the no-op cause (§2.9).
  let resolved: Bump | undefined;
  for (const parsed of pending) {
    const perCommit = commitBump(mapping, parsed);
    if (perCommit === undefined) continue;
    resolved = resolved === undefined ? perCommit : Bump.max(resolved, perCommit);
  }
  return resolved;
};

/**
 * Exact-duplicate intents collapse to their first occurrence, in input order
 * (E-10). The key is the kind plus the intent's other fields in sorted field
 * order — a deterministic identity for "identical kind and fields".
 * `input.ts` also dedupes; `decide` tolerates either shape of the list.
 */
function dedupeIntents(intents: readonly OperatorIntent[]): readonly OperatorIntent[] {
  const seen = new Set<string>();
  const unique: OperatorIntent[] = [];
  for (const intent of intents) {
    const key = [
      intent.kind,
      ...Object.entries(intent)
        .filter(([field]) => field !== "kind")
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([field, value]) => `${field}=${value}`),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(intent);
  }
  return unique;
}

/**
 * The line's released pointer (D10), re-derived from the same §2.13
 * projection `history.ts` owns: `decideLine`'s frozen signature carries no
 * rebuilt state, so the pointer is the highest-precedence admissible tag —
 * the projection's last entry in its ascending order. `undefined` when the
 * line's history is empty (line birth). Pure; the manifest is never
 * consulted (invariant 6, S-03). Exported for the one consumer that must
 * name the SAME pointer a decision named — the planned promoted-from edge
 * (ADR-0012 decision 2): `rebuildLineState`'s pointer keeps the first
 * among precedence ties, `pointerFor` the last, and on a build-metadata
 * tie the two strings differ. The plan may not carry two identities for
 * the prerelease it promotes.
 */
export function pointerFor(lineId: string, input: PlanningInput): Version | undefined {
  const projected = loadTagHistory(input.history.tags, input.lines, input.policy);
  const history = projected.lines.find((entry) => entry.lineId === lineId);
  const latest = history?.tags[history.tags.length - 1];
  return latest?.version;
}

/**
 * The line's projected §2.13 history, over the same input the decisions
 * read. Both #263 records consult it — the replay record names the tag the
 * world observes at the head, and the release-as record names the tag that
 * already carries the demanded version — so both name the SAME projection
 * the recorded state was rebuilt from, never a second source of truth
 * (invariant 6).
 */
function projectedHistoryFor(lineId: string, input: PlanningInput): readonly AdmissibleTag[] {
  const projected = loadTagHistory(input.history.tags, input.lines, input.policy);
  return projected.lines.find((entry) => entry.lineId === lineId)?.tags ?? [];
}

/**
 * The recorded §2.1 bootstrap decision when it is THIS line's birth
 * (#263), else `undefined`: the bootstrap is run-level input with no line
 * id, so the line claims it by identity — the line's projected history
 * admits a tag whose version IS the recorded birth version (kernel
 * identity: `compare === 0`, so build metadata cannot forge a second
 * member). The bootstrap records the birth of exactly one line; a line
 * whose history carries that version is the line whose birth was recorded.
 * A line whose history predates the tool carries no matching birth and
 * never claims it — M-01's `main`, M-07's quiet line, and S-05's
 * maintenance line keep their recorded no-op. An unparseable recorded
 * version claims no line: the input door (§2.6 normalize) refuses it as
 * `bootstrap.version` before a decision reads it, so a hand-built input
 * that skipped the door gets the caller contract error the door would have
 * raised, captured here as data.
 */
function recordedBirthOf(lineId: string, input: PlanningInput): BootstrapDecision | undefined {
  const bootstrap = input.bootstrap;
  if (bootstrap === undefined) {
    return undefined;
  }
  let birth: Version;
  try {
    birth = Version.parse(bootstrap.version);
  } catch (error) {
    if (!(error instanceof InvalidVersionError)) {
      throw error;
    }
    return undefined;
  }
  const claimed = projectedHistoryFor(lineId, input).some(
    (tag) => tag.version.compare(birth) === 0,
  );
  return claimed ? bootstrap : undefined;
}

/**
 * Whether an admissible `prerelease` demand rides for the line (§2.8's
 * predicate, D18): such a demand mints the NEXT version's next sequence —
 * a new identity, never a re-release — so the released head keeps its
 * no-op-plus-streams posture and the replay record does not stand.
 */
function hasAdmissibleStreamDemand(
  intents: readonly OperatorIntent[],
  lineConfig: LineConfig | undefined,
): boolean {
  if (lineConfig === undefined) {
    return false;
  }
  return intents.some(
    (intent) =>
      intent.kind === "prerelease" &&
      intent.lineId === lineConfig.id &&
      isStreamAllowed(lineConfig, intent.stream),
  );
}

/**
 * The kernel grammar's verdict on a `release-as` demand (§2.1): `undefined`
 * when `Version.parse` — strict SemVer 2.0.0, the only door into a
 * `Version` — accepts the demanded version, else the captured rejection
 * message. The rejection is captured, not propagated: a malformed demand is
 * operator-contradiction record data (§2.9), never a planner exception.
 */
function releaseAsParseRefusal(
  demand: Extract<OperatorIntent, { kind: "release-as" }>,
): string | undefined {
  try {
    Version.parse(demand.version);
    return undefined;
  } catch (error: unknown) {
    if (!(error instanceof InvalidVersionError)) {
      throw error;
    }
    return error.message;
  }
}

/**
 * The kernel-validated `release` record, shared by the ordinary runway and
 * the withhold-pinned one (§2.9, ADR-0003 decision 1): the door validates
 * the group — every member a `Change`, identities unique, the bump a level
 * — and plan assembly takes its value; the record surface carries the
 * decided inputs. A construction rejection surfaces as the
 * `kernel-rejection` refused record and is never re-thrown; any other
 * error is not a kernel construction rejection and propagates: swallowing
 * defects would fake determinism.
 */
function kernelValidatedRelease(
  input: PlanningInput,
  lineId: string,
  evaluatedRange: LineRange,
  bump: Bump,
  contributing: readonly ParsedCommit[],
  detail: string,
  withheld?: readonly ParsedCommit[],
): LineDecision {
  const members: Change[] = [];
  for (const parsed of contributing) {
    if (parsed.change === undefined) continue;
    members.push(parsed.change);
  }
  try {
    ChangeSet.of(members, bump);
  } catch (error: unknown) {
    if (error instanceof InvalidChangeSetError) {
      return {
        kind: "refused",
        cause: "kernel-rejection",
        lineId,
        range: evaluatedRange,
        policyDigest: input.policy.digest,
        detail: `the kernel rejected this line's change set: ${error.reason}`,
      };
    }
    throw error;
  }
  return {
    kind: "release",
    bump,
    changes: contributing,
    // D18 (PL-07): present only for the withhold-pinned release — the
    // scope-matched commits the range pinned itself below; the plan's
    // explanation curates them with their rules (excluded is not
    // invisible). exactOptionalPropertyTypes: a conditional spread, never
    // an explicit undefined.
    ...(withheld === undefined ? {} : { withheld }),
    lineId,
    range: evaluatedRange,
    policyDigest: input.policy.digest,
    detail,
  };
}

export const decideLine: DecideLine = (line, input, range) => {
  // Caller-contract posture first (mirrors attribute.ts validating its
  // ranges at entry): the declared mapping is resolved before any record is
  // produced (§2.7).
  const mapping = mappingFor(input.policy);

  // Precedence 1 — the line's lifecycle (D18 decision 2, §2.9): a frozen or
  // retired line refuses release-shaped planning outright — no targets, no
  // streams, no release entry — regardless of pending changes or intents:
  // release, prerelease, promote, and release-anyway all land on this
  // record. The states are the declared vocabulary; the refusal is the
  // planning semantics (ADR-0004 decision 2). The mapping resolution above
  // stays ahead of it: caller-contract validation, not a decision.
  const lineConfig = input.lines.find((candidate) => candidate.id === line.lineId);
  if (lineConfig !== undefined && lineConfig.lifecycle !== "active") {
    return {
      kind: "refused",
      cause: lineConfig.lifecycle === "frozen" ? "line-frozen" : "line-retired",
      lineId: line.lineId,
      range,
      policyDigest: input.policy.digest,
      detail: `line "${line.lineId}" is ${lineConfig.lifecycle} — release-shaped planning refuses here: no targets, no streams, no release entry, regardless of pending changes or intents (D18 decision 2, ADR-0004)`,
    };
  }

  // Precedence 2 — unmet precondition (§2.9, S-02, ADR-0003 decision 13): a
  // line whose evaluated range starts at line birth (`releasedUpTo === null`
  // — reviewer m-4: the range's released bound decides "no release yet",
  // never the attribution's released-identity count, which can be empty
  // under a non-null bound) with pending work demands the recorded
  // bootstrap decision; the planner never invents the first version. An
  // empty pending set needs no bootstrap and falls through to the routing
  // below.
  if (range.releasedUpTo === null && line.pending.length > 0 && input.bootstrap === undefined) {
    return {
      kind: "blocked",
      cause: "bootstrap-required",
      lineId: line.lineId,
      range,
      policyDigest: input.policy.digest,
      detail:
        "the evaluated range starts at line birth, pending changes present, and no recorded bootstrap decision — the first version is the operator's call (S-02)",
    };
  }

  const bump = resolveBump(line.pending, input.policy);

  // Intent routing (D17(4)(5)): exact duplicates collapse first, then the
  // line-scoped and global reads — a `promote` applies only when it names
  // this line (§2.1); `release-anyway` and `release-as` carry no lineId, so
  // they are evaluated against every line decided here.
  const intents = dedupeIntents(input.intents ?? []);
  const promote = intents.find(
    (intent): intent is Extract<OperatorIntent, { kind: "promote" }> =>
      intent.kind === "promote" && intent.lineId === line.lineId,
  );
  const releaseAnyway = intents.some((intent) => intent.kind === "release-anyway");
  const releaseAs = intents.find(
    (intent): intent is Extract<OperatorIntent, { kind: "release-as" }> =>
      intent.kind === "release-as",
  );

  // Precedence 3 — promote × release-anyway (§2.9): one line cannot both
  // promote the validated stream and force past it; the refusal names the
  // contradiction instead of picking a winner.
  if (promote !== undefined && releaseAnyway) {
    return {
      kind: "refused",
      cause: "operator-contradiction",
      lineId: line.lineId,
      range,
      policyDigest: input.policy.digest,
      detail: `operator demanded a promotion and a release-anyway on line "${line.lineId}" — the intents contradict each other, and neither is honored`,
    };
  }

  // Precedence 4 — the promotion (D17(4), P-03): over an in-flight
  // prerelease with nothing release-worthy pending, the target is the
  // pointed-at release and the change set is inherited from the stream —
  // explicitly a release, never a no-op, despite the empty diff. A sibling
  // `prerelease` demand for the line is subsumed by the promotion (D38,
  // #90): the streams it would extend run toward the promotion's own mint,
  // so the promotion wins the line's posture and the record names the
  // subsumption. Release-worthy pending changes are a contradiction: stable
  // must contain
  // exactly what the prerelease validated, so the demand refuses instead of
  // silently absorbing them. A pointer held by a stable version — or no
  // pointer at all — refuses for the same reason: there is no in-flight
  // prerelease to promote.
  if (promote !== undefined) {
    const pointer = pointerFor(line.lineId, input);
    if (pointer === undefined || pointer.prerelease.length === 0) {
      return {
        kind: "refused",
        cause: "operator-contradiction",
        lineId: line.lineId,
        range,
        policyDigest: input.policy.digest,
        detail: `operator demanded a promotion on line "${line.lineId}", but the line's released pointer ${
          pointer === undefined
            ? "does not exist (no releases yet)"
            : `is the stable ${pointer.toString()}`
        } — there is no in-flight prerelease to promote`,
      };
    }
    if (bump !== undefined) {
      return {
        kind: "refused",
        cause: "operator-contradiction",
        lineId: line.lineId,
        range,
        policyDigest: input.policy.digest,
        detail: `operator demanded a promotion, but release-worthy change(s) are pending past the in-flight prerelease (${line.pending
          .filter((parsedCommit) => commitBump(mapping, parsedCommit) !== undefined)
          .map((parsedCommit) => `${parsedCommit.sha} (${parsedCommit.type ?? "untyped"})`)
          .join(
            ", ",
          )}) — stable must contain exactly what was validated; a new prerelease sequence is required first (P-03)`,
      };
    }
    // D38 (#90): the sibling prerelease demands this promotion subsumes, in
    // input order, deduplicated — the record names what the pass will not
    // mint, so a dropped demand is never silent (§2.9's records posture).
    // The targets layer enforces the rule (plan.ts); the record makes it
    // visible here, where the line's posture was decided.
    const subsumedStreams: string[] = [];
    for (const intent of intents) {
      if (intent.kind === "prerelease" && intent.lineId === line.lineId) {
        if (!subsumedStreams.includes(intent.stream)) {
          subsumedStreams.push(intent.stream);
        }
      }
    }
    return {
      kind: "release",
      bump: null,
      changes: [],
      lineId: line.lineId,
      range,
      policyDigest: input.policy.digest,
      detail:
        `promotion of the in-flight prerelease ${pointer.toString()} — the change set is inherited from the stream, so no bump was resolved from pending (P-03)` +
        (subsumedStreams.length === 0
          ? ""
          : `; the sibling prerelease demand(s) for stream(s) ${subsumedStreams.join(", ")} are subsumed by the promotion — a promotion-shaped decision never carries a stream extension (#90, D38)`),
    };
  }

  // Precedence 5 — the forced record (D17(5), S-01): a release-anyway over a
  // quiet line is recorded as operator-forced, never as a routine release —
  // the forced mint itself is declared-policy territory (PR-6). Over a real
  // release-worthy set the intent is already satisfied, and the ordinary
  // release below stands with no extra record kind.
  if (releaseAnyway && bump === undefined) {
    return {
      kind: "forced",
      cause: "release-anyway",
      lineId: line.lineId,
      range,
      policyDigest: input.policy.digest,
      detail:
        "operator forced a release over a quiet line — recorded as operator-forced, never as a routine release (S-01); the forced mint itself is declared-policy territory",
    };
  }

  // Precedence 6 — a release-as demand the kernel grammar refuses is an
  // operator contradiction regardless of the runway: the override names a
  // version that cannot exist (§2.9). A well-formed demand introduces no
  // decision of its own here — the override materializes in the plan's
  // targets (the plan is the record), and the runway checks below proceed.
  if (releaseAs !== undefined) {
    const parseRefusal = releaseAsParseRefusal(releaseAs);
    if (parseRefusal !== undefined) {
      return {
        kind: "refused",
        cause: "operator-contradiction",
        lineId: line.lineId,
        range,
        policyDigest: input.policy.digest,
        detail: `operator demanded release-as "${releaseAs.version}", which the kernel's version grammar refuses: ${parseRefusal}`,
      };
    }
  }

  // Precedence 7 — operator contradiction (§2.9, S-01): an explicit
  // `release-as` demand against a runway with nothing release-worthy. The
  // intent is recorded in the detail and the line refuses — the conflict is
  // surfaced, never resolved by silently releasing. A release-as on a
  // release-worthy runway is honored by the ordinary release below.
  if (bump === undefined && releaseAs !== undefined) {
    return {
      kind: "refused",
      cause: "operator-contradiction",
      lineId: line.lineId,
      range,
      policyDigest: input.policy.digest,
      detail: `operator demanded release-as ${releaseAs.version}, but this line has no release-worthy changes — the demand cannot be honored (S-01)`,
    };
  }

  // Precedence 8 — the release-as replay (#263): a well-formed demand that
  // names a version the line's own history already observes — an admitted
  // in-ancestry tag's version (§2.13) — is the re-release the recorded
  // state refuses, regardless of the runway behind it: one identity is one
  // member. The target override would otherwise materialize in the plan's
  // targets (namedTag) and mint a tag the world already carries. The
  // quiet-runway contradiction above keeps its more specific record; this
  // gate judges the demand against the world, not the runway.
  if (releaseAs !== undefined && bump !== undefined) {
    const demanded = Version.parse(releaseAs.version);
    const observed = projectedHistoryFor(line.lineId, input).find(
      (tag) => tag.version.compare(demanded) === 0,
    );
    if (observed !== undefined) {
      return {
        kind: "blocked",
        cause: "released-version-observed",
        lineId: line.lineId,
        range,
        policyDigest: input.policy.digest,
        detail: `operator demanded release-as ${demanded.toString()}, but the world already observes tag "${observed.name}" (version ${observed.version.toString()}) within line "${line.lineId}"'s ancestry at ${observed.commit} — re-releasing an observed version is the replay the recorded state refuses (§2.13, #263)`,
      };
    }
  }

  // Precedence 9 — the line's declared withhold rules (D18 decision 3,
  // PL-07, §2.9): matching release-triggering changes defer, never delete —
  // the first matching rule in declared order supplies the reason (E-10).
  // The release range pins below the earliest withheld commit (the first in
  // pending order) so the un-released span keeps them, recoverable after an
  // unfreeze; a release-worthy commit after the earliest withheld one
  // defers with it — the natural consequence of range pinning, never
  // per-commit filtering. A line left with nothing release-worthy in the
  // released prefix yields the `withheld` record (`policy-filter`) instead
  // of a mint.
  const withholdRules = lineConfig?.withhold;
  if (withholdRules !== undefined && withholdRules.length > 0) {
    const withheld: ParsedCommit[] = [];
    const withheldDescriptions: string[] = [];
    let earliestWithheld: ParsedCommit | undefined;
    for (const parsed of line.pending) {
      if (commitBump(mapping, parsed) === undefined) continue;
      const rule = withholdRules.find((candidate) => candidate.scope === parsed.scope);
      if (rule === undefined) continue;
      withheld.push(parsed);
      withheldDescriptions.push(`${parsed.sha} (${parsed.type ?? "untyped"}): "${rule.reason}"`);
      earliestWithheld ??= parsed;
    }
    if (earliestWithheld !== undefined) {
      // The earliest withheld commit in pending order bounds the release:
      // the contiguous prefix strictly before it is the releasable span,
      // and everything from the withheld commit onward — withheld or
      // release-worthy — stays inside the un-released span (PL-07's
      // recoverability rule).
      const earliestIndex = line.pending.indexOf(earliestWithheld);
      const surviving = line.pending
        .slice(0, earliestIndex)
        .filter((parsed) => commitBump(mapping, parsed) !== undefined);
      // The pin lands on the withheld commit's first parent as observed in
      // the commit graph; when that parent is unobservable the release
      // cannot be bounded below the withheld commit, so everything defers.
      const pinnedHead = input.repository.commits.find(
        (commit) => commit.sha === earliestWithheld.sha,
      )?.parents[0];
      const survivingChanges = surviving.filter((parsed) => parsed.change !== undefined);
      const survivingBump = surviving.length > 0 ? resolveBump(surviving, input.policy) : undefined;
      if (pinnedHead !== undefined && survivingBump !== undefined) {
        return kernelValidatedRelease(
          input,
          line.lineId,
          { lineId: range.lineId, releasedUpTo: range.releasedUpTo, head: pinnedHead },
          survivingBump,
          survivingChanges,
          `${String(survivingChanges.length)} release-worthy change(s) imply a ${survivingBump} bump; the range pins below the earliest withheld commit ${earliestWithheld.sha} so the withheld change(s) stay inside the un-released span (D18 decision 3, PL-07)`,
          withheld,
        );
      }
      return {
        kind: "withheld",
        cause: "policy-filter",
        withheld,
        lineId: line.lineId,
        range,
        policyDigest: input.policy.digest,
        detail: `withheld ${String(withheld.length)} release-worthy change(s) by the line's declared withhold rules, in input order: ${withheldDescriptions.join(", ")} — deferred inside the un-released span, never deleted (D18 decision 3, PL-07)`,
      };
    }
  }

  // Precedence 10 — the released-version replay record (§2.9 as amended,
  // #263): a release-shaped pass over the fully released range of the line
  // whose birth the recorded state carries. The line's evaluated range is
  // fully released — the latest admitted tag's commit IS the feed-ref head
  // (§2.13 admitted the world's observed tag, the refname spelling
  // included) — and the pass demands a release the world already carries:
  // the pending span is empty by construction (the range's bounds
  // coincide), so no bump resolved and the dispatch would re-plan the
  // observed version. The recorded §2.1 bootstrap decision is the
  // discriminator (one identity is one member, §2.13/#197): the line whose
  // history carries the recorded birth version is the line born through
  // the tool, so a re-demanded release over its released head is the
  // replay and the record blocks naming the observed tag, before any
  // attempt opens; a line whose history predates the tool carries no
  // recorded birth, and its quiet released head stays the recorded no-op
  // below — the maintenance posture M-01's `main`, M-07's quiet line, and
  // S-05's maintenance line pin. The other demand shapes keep their own
  // records: an admissible prerelease demand is the ladder continuing over
  // a released head — the NEXT version's sequence, a new identity, never a
  // re-release — so it falls through to the no-op whose targets still plan
  // the demanded streams; and the explicit-override records above already
  // stood. A passive pass (no release intent) stays the recorded no-op
  // below: nothing was demanded, so nothing is refused.
  const recordedBirth = recordedBirthOf(line.lineId, input);
  if (
    recordedBirth !== undefined &&
    range.releasedUpTo !== null &&
    range.releasedUpTo === range.head &&
    intents.some((intent) => intent.kind === "release") &&
    !hasAdmissibleStreamDemand(intents, lineConfig)
  ) {
    const latest = projectedHistoryFor(line.lineId, input).at(-1);
    if (latest === undefined) {
      // The range names a released bound the projection does not carry —
      // the range and the history disagree, a caller contract violation
      // surfaced the way the other stages surface theirs.
      throw new InvalidPlanningInputError([
        {
          field: `lines.${line.lineId}`,
          problem:
            "the evaluated range names a release bound the projected history does not carry — supply deriveRanges' ranges and loadTagHistory's projection over the same input",
        },
      ]);
    }
    return {
      kind: "blocked",
      cause: "released-version-observed",
      lineId: line.lineId,
      range,
      policyDigest: input.policy.digest,
      detail: `the world observes tag "${latest.name}" (version ${latest.version.toString()}) at line "${line.lineId}"'s head ${range.head}, and the line's recorded birth (${recordedBirth.version}, recorded by ${recordedBirth.who} at ${recordedBirth.when}) is already the world's — the re-dispatch refuses instead of re-planning the released version: one identity is one member, no claim, no mint, no second attempt (§2.13, #263)`,
    };
  }

  // Precedence 11 — the recorded no-op (§2.9, PL-06, S-01): with no
  // release-worthy commit, every pending entry was excluded by policy, so
  // the `ignored` enumeration is the whole pending set, in input order —
  // recorded, never silently dropped. The empty group mints nothing.
  if (bump === undefined) {
    return {
      kind: "no-op",
      cause: "no-release-worthy-changes",
      ignored: line.pending,
      lineId: line.lineId,
      range,
      policyDigest: input.policy.digest,
      detail:
        line.pending.length === 0
          ? "no pending changes on the evaluated range"
          : `no release-worthy changes; ignored as not release-triggering, in input order: ${line.pending
              .map((parsed) => `${parsed.sha} (${parsed.type ?? "untyped"})`)
              .join(", ")}`,
    };
  }

  // Precedence 12 — the release (§2.7, §2.9): the contributing commits are
  // the release-triggering ones, and the kernel change set is constructed
  // through `ChangeSet.of`. Pending entries are change-classified by
  // attribution (§2.4), so the `change` narrowing below is defensive only,
  // mirroring attribute.ts's released-id fallback.
  const contributing: ParsedCommit[] = [];
  for (const parsed of line.pending) {
    if (commitBump(mapping, parsed) === undefined) continue;
    if (parsed.change === undefined) continue;
    contributing.push(parsed);
  }
  return kernelValidatedRelease(
    input,
    line.lineId,
    range,
    bump,
    contributing,
    `${String(contributing.length)} release-worthy change(s) imply a ${bump} bump`,
  );
};
