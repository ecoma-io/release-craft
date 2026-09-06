/**
 * The Phase 2 planner's frozen input/extraction/attribution interface.
 *
 * These types are the contract the PR-2 modules are implemented against
 * (phase2-planner-contract.md §2.1–§2.4, §2.12): `input.ts` normalizes the
 * closed input boundary, `extract.ts` maps commit observations to candidate
 * kernel `Change` values, and `attribute.ts` attributes changes to lines by
 * ancestry, failing closed. The function types below are the module
 * signatures — implementations conform to them, they do not extend them.
 *
 * Provider neutrality (invariant 15): nothing here names provider state.
 * Refs and branches appear only as observations and declared bindings.
 * Timestamps are carried as input data and are never used for ordering
 * (E-10): attribution and range walks are ancestry-only.
 */

import type { Bump, Change, Version } from "@ecoma-io/release-craft/domain";

// ---------------------------------------------------------------------------
// §2.1 — the planner input boundary (closed, serializable, provider-neutral)
// ---------------------------------------------------------------------------

/** The named policy decisions this contract fixes, digest-bound. */
export interface PolicyInput {
  /** Digest of the effective policy — binds every record and plan identity. */
  readonly digest: string;
  /** Identifier of the declared commit-type → bump mapping (§2.7, PR-3). */
  readonly bumpMappingId: string;
  /** Declared prerelease ladder, e.g. `["alpha", "beta", "rc"]` (§2.8). */
  readonly prereleaseLadder: readonly string[];
  /** Fork 17's declared seed policy: the first sequence of a fresh stream
   * key — `"0"` is the kernel default, `"1"` by explicit declaration. */
  readonly prereleaseSeed: "0" | "1";
  /** Pre-1.0 dampening (breaking bumps minor before 1.0.0) — line default. */
  readonly pre10Dampening: boolean;
  /** The reserved self-reference trailer namespace (§2.12). */
  readonly selfReferenceNamespace: string;
  /** Declared per-line tag-format overrides, keyed by line id (fork 11's
   * naming knob). */
  readonly tagFormats: Readonly<Record<string, string>>;
}

/** §2.2 — a precomputed commit observation. The planner performs zero git
 * calls; observations arrive precomputed and closed. */
export interface CommitObservation {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly message: string;
  /** Input data, never an ordering key (E-10). */
  readonly committedAt: string;
  /** Ref names whose ancestry contains this commit (input evidence; the
   * parent graph remains the authoritative ancestry for attribution). */
  readonly containingRefs: readonly string[];
}

/** §2.2 — a ref observation: name and the commit it heads. */
export interface RefObservation {
  readonly name: string;
  readonly head: string;
}

/** §2.13 — a tag observation. Parsed to kernel `Version`s by the history
 * loader (PR-3); PR-2 attribution consumes only the release-bound shas the
 * caller derives from them. */
export interface TagObservation {
  readonly name: string;
  readonly commit: string;
}

/** §2.6 — a release-line configuration. Declared and default-derived lines
 * share this one schema (no code path keyed on "simple mode"). `id` is the
 * stable line identity (invariant 7) — never a branch name. */
export interface LineConfig {
  readonly id: string;
  readonly feedRef: string;
  readonly lifecycle: "active" | "frozen" | "retired";
  /** Present when the line was declared; absent for default-derived. */
  readonly declared: boolean;
  /** §2.13 — the line's declared version band: which major (and optionally
   * minor) series this line releases into. Absent for a single-line repo,
   * whose line admits every admissible tag. Admission is band equality; an
   * out-of-band tag is foreign, surfaced — never silently dropped (E-06). */
  readonly versionBand?: { readonly major: number; readonly minor?: number };
  /** §2.8 (D18) — the line's declared stream policy, overriding the global
   * admission posture per line. Absent = the defaults-as-data posture: every
   * declared or ladder identifier is mintable (`allow: "all"`) and the
   * global `policy.prereleaseSeed` governs. `allow: "none"` is M-08's
   * stable-only knob: a `prerelease` intent naming the line is a recorded
   * refusal on the plan (`refusedIntents`), never a fallback to stable. A
   * listed identifier is a declaration — opaque identifiers are legal
   * exactly so (§2.8's fork-4 resolution; the ladder itself stays global
   * promotion-slice data, fork 3's fixed order). */
  readonly streams?: {
    readonly allow?: "all" | "none" | readonly string[];
    readonly seed?: "0" | "1";
  };
  /** §2.9 (D18, PL-07) — the line's declared withhold rules: pending
   * release-triggering changes whose scope matches a rule are deferred,
   * never deleted. The release range pins below the earliest withheld
   * commit so deferral stays recoverable after an unfreeze (PL-06's
   * deferral rule), and the withheld set is enumerated in the plan's
   * explanation — excluded is not invisible. */
  readonly withhold?: readonly {
    readonly scope: string;
    readonly reason: string;
  }[];
  /** D18 — the declared component binding: which declared component this
   * line's releases publish through the door (PL-01's seam). Absent keeps
   * the D17(8) default posture (exactly one declared component meets
   * exactly one releasing line); with more releasing lines than an
   * undeclared mapping can carry, the binding is mandatory — an undeclared
   * or ambiguous mapping is a caller contract violation naming the binding
   * gap, never a fabricated release. */
  readonly publishes?: string;
}

/** Package metadata for the component axis (§2.15, PR-4). Manifest versions
 * ride as projections — never as computation truth (invariant 6). */
export interface ComponentMeta {
  readonly name: string;
  readonly manifestVersion: string;
  readonly paths: readonly string[];
  /** D16 — declared dependency edges, read from manifests at input time:
   * the packages this component depends on, with the range expression each
   * relationship declares. PL-02's range math consumes these; an edge to a
   * component not declared in `input.components` is a caller contract
   * violation surfaced by the propagation planner. Absent = the component
   * declares no dependencies. */
  readonly dependencies?: readonly ComponentDependency[];
}

/** One declared dependency relationship (D16): the dependency's component
 * name and its range expression in the declared grammar (`^x.y.z`,
 * `~x.y.z`, exact `x.y.z`). */
export interface ComponentDependency {
  readonly name: string;
  readonly range: string;
}

/** §2.1 — the recorded bootstrap decision (S-02). Its absence is not an
 * error here; demanding it is a `blocked` record at the planning boundary. */
export interface BootstrapDecision {
  readonly version: string;
  readonly who: string;
  readonly when: string;
}

/** Operator intents that must be recorded when exercised (§2.1): an
 * "release anyway" is an operator-forced record, never a routine release
 * (S-01); `Release-As` semantics per the compatibility boundary row 2; a
 * `promote` publishes the in-flight prerelease's target as stable (P-03:
 * explicitly not a no-op despite the empty diff — the change set is
 * inherited from the stream). */
export type OperatorIntent =
  | { readonly kind: "release" }
  | { readonly kind: "release-anyway" }
  | { readonly kind: "prerelease"; readonly stream: string; readonly lineId: string }
  | { readonly kind: "release-as"; readonly version: string }
  | { readonly kind: "promote"; readonly lineId: string };

/** The planner's single argument (§2.1). Everything the planner decides, it
 * decides from this value — never from environment, clock, filesystem, or
 * network (invariant 2). */
export interface PlanningInput {
  readonly policy: PolicyInput;
  readonly repository: {
    readonly commits: readonly CommitObservation[];
    readonly refs: readonly RefObservation[];
  };
  readonly history: { readonly tags: readonly TagObservation[] };
  readonly lines: readonly LineConfig[];
  readonly components?: readonly ComponentMeta[];
  readonly bootstrap?: BootstrapDecision;
  readonly intents?: readonly OperatorIntent[];
}

// ---------------------------------------------------------------------------
// §2.2 — the evaluated range, supplied per line by the caller in PR-2
// ---------------------------------------------------------------------------

/** One line's evaluated range (§2.2, §2.5): the span from the line's latest
 * admissible release tag (`releasedUpTo`, or line birth when `null`) to the
 * line's feed-ref head. PR-3's history loader derives these from
 * `TagObservation[]`; PR-2's harness takes them as declared fixture data so
 * attribution stays independent of range calculation. */
export interface LineRange {
  readonly lineId: string;
  /** Head of the line's latest release (a commit sha), or `null` when the
   * line has no release yet — then the range starts at the line's birth. */
  readonly releasedUpTo: string | null;
  /** The line's feed-ref head commit sha. */
  readonly head: string;
}

// ---------------------------------------------------------------------------
// §2.3 + §2.12 — extraction: commit observations → candidate changes
// ---------------------------------------------------------------------------

/** How the commit was classified before change detection (PL-04). */
export type CommitClassification = "change" | "self-reference" | "malformed-marker" | "unparseable";

/** Where the change identity came from — first match wins (§2.3, fork 8). */
export type IdentitySource = "change-id-footer" | "cherry-pick-origin" | "commit-sha";

/** A commit after extraction: its classification, parsed shape, and (for
 * `change`) its candidate kernel `Change` value. Identity is the id, never
 * content (invariant 9); lineage records the chain (§2.3). */
export interface ParsedCommit {
  readonly sha: string;
  readonly classification: CommitClassification;
  /** Conventional-commit type (`feat`, `fix`, …), when parseable. */
  readonly type?: string;
  readonly scope?: string;
  readonly subject: string;
  /** True when `!` or a `BREAKING CHANGE:` footer is present (any type). */
  readonly breaking: boolean;
  /** The candidate change value; present only for `classification: "change"`. */
  readonly change?: Change;
  readonly identitySource?: IdentitySource;
}

/** A commit excluded from classification — surfaced, never invisible
 * (§2.12, PL-04). */
export interface ExcludedCommit {
  readonly sha: string;
  readonly rule: "self-reference" | "malformed-marker" | "unparseable";
  readonly detail: string;
}

/** One identity, divergent payloads (M-05): surfaced in explanation data,
 * never silently merged away and never fuzzy-matched. */
export interface IdentityConflict {
  readonly changeId: string;
  readonly shas: readonly string[];
  readonly detail: string;
}

/** §2.3's result: deterministic — identical observations produce identical
 * results, in stable (input) order. */
export interface ExtractionResult {
  readonly commits: readonly ParsedCommit[];
  readonly excluded: readonly ExcludedCommit[];
  readonly conflicts: readonly IdentityConflict[];
}

// ---------------------------------------------------------------------------
// §2.4 — attribution: ancestry-based, per line, fail-closed
// ---------------------------------------------------------------------------

/** Per line: the pending change set plus the change identities already
 * released on that line. Releasedness is per (line, change) — a change
 * released on one line is never thereby released on another (M-04, M-06,
 * M-09); lineage is recorded for traceability, suppressive only within a
 * line. */
export interface LineAttribution {
  readonly lineId: string;
  /** Commits pending on this line, stable order. */
  readonly pending: readonly ParsedCommit[];
  /** Identities already released on this line (from its released span). */
  readonly released: readonly string[];
  /** Commits excluded inside this line's range (surfaced per line). */
  readonly excluded: readonly ExcludedCommit[];
}

/** §2.4's fail-closed refusal (M-01, PL-05a): ambiguous attribution names
 * the ambiguous commits — never silence, never a guess. The same shape
 * carries the door's plan-level refusals: `version-collision` (M-11) is
 * two lines minting the same tag in one pass — a self-conflicting plan,
 * refused before assembly with both lines and both heads named. */
export interface AttributionRefusal {
  readonly kind: "refused";
  readonly cause: "ambiguous-attribution" | "malformed-self-reference-marker" | "version-collision";
  /** Commit shas the refusal is about. */
  readonly commits: readonly string[];
  readonly policyDigest: string;
  readonly detail: string;
}

export type AttributionOutcome =
  | { readonly kind: "attributed"; readonly lines: readonly LineAttribution[] }
  | { readonly kind: "refused"; readonly refusal: AttributionRefusal };

// ---------------------------------------------------------------------------
// Frozen module signatures (the PR-2 implementation contract)
// ---------------------------------------------------------------------------

/** `input.ts` — validates and normalizes the input boundary. Malformed
 * `PlanningInput` values are caller contract violations, not planning
 * outcomes: this throws. */
export type NormalizeInput = (raw: PlanningInput) => PlanningInput;

/** `extract.ts` — maps commit observations to candidate changes (§2.3) with
 * the self-reference rule applied before classification (§2.12). */
export type ExtractChanges = (
  commits: readonly CommitObservation[],
  policy: PolicyInput,
) => ExtractionResult;

/** `attribute.ts` — attributes extracted changes to lines by ancestry within
 * the supplied ranges (§2.4), failing closed on ambiguity. */
export type AttributeChanges = (
  extraction: ExtractionResult,
  input: PlanningInput,
  ranges: readonly LineRange[],
) => AttributionOutcome;

// ---------------------------------------------------------------------------
// §2.13 + §2.5 — tag-history projection and range derivation (PR-3)
// ---------------------------------------------------------------------------

/** One admissible tag after history projection: the observation plus the
 * kernel `Version` its name parses to (§2.13). Ordered ascending by version
 * within a line's history. */
export interface AdmissibleTag {
  readonly name: string;
  readonly commit: string;
  readonly version: Version;
}

/** A tag excluded from a line's history — foreign or unattributable (§2.13,
 * E-06): surfaced in explanation data, never silently dropped. */
export interface ForeignTag {
  readonly name: string;
  readonly commit: string;
  readonly detail: string;
}

/** One line's projected release history (§2.13): the admissible tags, in
 * ascending version order, plus everything the projection kept out. The
 * history is rebuilt from `TagObservation[]` at plan time — manifest
 * versions are never consumed as truth (invariant 6, S-03). */
export interface LineHistory {
  readonly lineId: string;
  readonly tags: readonly AdmissibleTag[];
  readonly foreign: readonly ForeignTag[];
}

export interface TagHistoryResult {
  readonly lines: readonly LineHistory[];
}

/** `history.ts` — projects `TagObservation[]` onto the declared lines
 * (§2.13): parses names through the kernel's grammar, admits a tag into a
 * line's history when its version falls in that line's namespace per the
 * declared configuration, surfaces the rest as foreign. Deterministic. */
export type LoadTagHistory = (
  tags: readonly TagObservation[],
  lines: readonly LineConfig[],
  policy: PolicyInput,
) => TagHistoryResult;

/** `history.ts` — derives each line's evaluated range (§2.5) from its
 * projected history: the latest admissible tag's commit bounds the lower
 * end (`null` — line birth — when the history is empty); the line's
 * feed-ref head bounds the upper end. Independent per line (M-07, S-03);
 * manifest versions never bound a range. */
export type DeriveRanges = (
  history: TagHistoryResult,
  refs: readonly RefObservation[],
  lines: readonly LineConfig[],
) => readonly LineRange[];

// ---------------------------------------------------------------------------
// §2.7 — bump resolution (policy data, never kernel state)
// ---------------------------------------------------------------------------

/** The commit-type → `Bump` mapping for one `bumpMappingId` (§2.7). The
 * `default` mapping: `feat` → minor, `fix`/`perf`/`refactor` → patch,
 * `chore`/`docs`/`ci`/`test` → absent (not release-triggering, S-01, PL-06);
 * a breaking marker dominates any type. `ChangeSet.of` records the winner. */
export type BumpMapping = Readonly<Record<string, Bump>>;

/** `decide.ts` — resolves the line's change-set bump (§2.7): `Bump.max`
 * over the pending release-triggering changes; `undefined` when none qualify
 * (the no-op record's cause, §2.9). Declared policy mapping only — the
 * mapping is looked up by `policy.bumpMappingId`. */
export type ResolveBump = (
  pending: readonly ParsedCommit[],
  policy: PolicyInput,
) => Bump | undefined;

// ---------------------------------------------------------------------------
// §2.9 — negative outcomes are records, never exceptions
// ---------------------------------------------------------------------------

/** Every record carries the cause, the evaluated range, and the policy
 * digest that produced it (invariant 4, amendment A1). */
interface RecordBase {
  readonly lineId: string;
  readonly range: LineRange;
  readonly policyDigest: string;
  readonly detail: string;
}

export type LineDecision =
  | ({
      readonly kind: "release";
      /** The resolved change-set bump — `null` for a promotion (P-03): the
       * target is the in-flight prerelease's pointed-at release and the
       * change set is inherited, so nothing was resolved from pending. */
      readonly bump: Bump | null;
      readonly changes: readonly ParsedCommit[];
      /** D18 (PL-07): the withhold-matched commits the release's range
       * pinned itself below — present only when declared rules deferred
       * changes; the plan's explanation enumerates them with their rules'
       * scope and reason (excluded is not invisible). */
      readonly withheld?: readonly ParsedCommit[];
    } & RecordBase)
  | ({
      readonly kind: "no-op";
      readonly cause: "no-release-worthy-changes";
      readonly ignored: readonly ParsedCommit[];
    } & RecordBase)
  | ({
      readonly kind: "withheld";
      readonly cause: "policy-filter";
      readonly withheld: readonly ParsedCommit[];
    } & RecordBase)
  | ({
      readonly kind: "forced";
      readonly cause: "release-anyway";
    } & RecordBase)
  | ({
      readonly kind: "refused";
      readonly cause:
        | "attribution-ambiguity"
        | "operator-contradiction"
        | "kernel-rejection"
        | "line-frozen"
        | "line-retired";
    } & RecordBase)
  | ({
      readonly kind: "blocked";
      readonly cause: "bootstrap-required" | "stale-plan";
    } & RecordBase);

/** `decide.ts` — turns one line's attribution into its §2.9 decision:
 * release-worthy pending set → `release` with the resolved bump; a
 * `promote` intent over an in-flight prerelease → `release` with an
 * inherited (empty) change set and `bump: null` (P-03); empty → `no-op`
 * enumerating ignored-by-policy commits; a `release-anyway` intent over a
 * quiet line → `forced` (S-01: recorded, never a routine release — the
 * forced mint is declared-policy territory); policy-filtered deferrals →
 * `withheld`; attribution ambiguity or operator contradiction → `refused`;
 * unmet preconditions (bootstrap, staleness) → `blocked`. Kernel
 * construction rejections surface as the corresponding record — never
 * re-thrown (§2.9). */
export type DecideLine = (
  line: LineAttribution,
  input: PlanningInput,
  range: LineRange,
) => LineDecision;

// ---------------------------------------------------------------------------
// §2.13 (line state), §2.6 + §2.7 + §2.8 (targets), §2.15 (propagation),
// §2.10 + §2.11 (plan identity) — the planning layer (PR-4)
// ---------------------------------------------------------------------------

/** One line's release state rebuilt from its projected history (§2.13): the
 * released pointer is the highest admissible version by precedence (the
 * kernel's own monotonic reading; a prerelease may hold it, M-08);
 * `stableBase` is the highest released version with no prerelease suffix —
 * the base the P-04/P-05 in-flight-target rule recomputes against; and
 * every prerelease tag contributes its stream key — target, identifier,
 * sequence — the highest sequence per key winning. Stream state is rebuilt
 * from tags at plan time, never carried across runs (invariant 6). */
export interface LineState {
  readonly pointer: Version | null;
  readonly stableBase: Version | null;
  readonly streams: readonly StreamKeyState[];
}

/** One observed stream key (§2.8): the target version the stream sits on,
 * the prerelease identifier, and the highest sequence observed for the key. */
export interface StreamKeyState {
  readonly target: Version;
  readonly identifier: string;
  readonly sequence: number;
}

/** `state.ts` — rebuilds per-line release state from the projected history
 * (§2.13): pointer from the highest admissible version, streams from the
 * history's prerelease tags (a tag `1.2.0-rc.3` is key `(1.2.0, rc)` at
 * sequence 3). Deterministic; identical histories rebuild identical state. */
export type RebuildLineState = (history: LineHistory) => LineState;

/** One planned prerelease stream (§2.8): the version the stream will mint,
 * its tag, the seed used (fork 17 — recorded per stream), the pointer base
 * the plan computed from (D9), and whether publishing this version moves
 * the line's released pointer by precedence (M-08 vs P-02/P-07). */
export interface PlannedStream {
  readonly identifier: string;
  readonly version: Version;
  readonly tag: string;
  readonly seed: string;
  readonly pointerBase: string | null;
  readonly movesPointer: boolean;
}

/** One line's planned targets (§2.6 + §2.8): the stable target when the
 * line's decision releases AND no `prerelease` intent demands this line's
 * publication (P-04/P-05/P-07/M-08: the run publishes the stream only —
 * the would-be stable is the streams' target, never a co-mint), and every
 * prerelease stream the operator's intents demand. `stable` is `null`
 * otherwise. Tags follow the declared tag format (`policy.tagFormats`,
 * fork 11) or the bare default. */
export interface TargetPlan {
  readonly stable: { readonly version: Version; readonly tag: string } | null;
  readonly streams: readonly PlannedStream[];
}

/** `plan.ts` — computes one line's targets (§2.6, §2.7, §2.8): the stable
 * version from the decision's bump applied to the rebuilt pointer through
 * the kernel's bump doors, with §2.7's pre-1.0 dampening (breaking → minor
 * below `1.0.0`); a `release-as` intent's exact version overrides the
 * computed target (compatibility boundary row 2). While a prerelease
 * holds the pointer, the in-flight-target rule governs (P-04 vs P-05): the
 * candidate recomputed from `stableBase` and the in-flight target
 * (`bumpPatch` of the pointer) — the higher by precedence wins, so a
 * joining change at or under the in-flight class keeps the target and its
 * sequence, a heavier one moves it and resets. `null` stable when a
 * `prerelease` intent demands this line (the streams carry the target).
 * Kernel rejections surface as the caller contract errors they are —
 * target computation never invents fallbacks. */
export type PlanTargets = (
  intents: readonly OperatorIntent[],
  decision: LineDecision,
  state: LineState,
  line: LineConfig,
  policy: PolicyInput,
) => TargetPlan;

/** `plan.ts` — plans the line's prerelease streams (§2.8) from the
 * operator's `prerelease` intents: each intent names the identifier; the
 * sequence continues the rebuilt stream key (`+1`) or starts at the
 * declared seed (fork 17) for a fresh key — a moved target (P-05) or a new
 * identifier (P-02) never continues the old sequence. A mint sorting below
 * the line's released pointer is a caller contract violation (D10: the
 * planner never invents the ladder override). `planTargets` is the
 * targets-only view over this (no intents → no streams). */
export type PlanStreams = (
  intents: readonly OperatorIntent[],
  decision: LineDecision,
  state: LineState,
  line: LineConfig,
  policy: PolicyInput,
) => readonly PlannedStream[];

/** One propagation edge (§2.15): a release in `from` forces a bump in `to`
 * because `to`'s declared range on `from` no longer accepts `from`'s new
 * version. Edges are declared content — derivable, recorded, never
 * implied (invariant 14). */
export interface PropagationEdge {
  readonly from: string;
  readonly to: string;
  readonly reason: "range-widening";
}

/** Negative evidence (§2.15, PL-03): a component that did not move, and the
 * deterministic reason — no reverse dependency on a releasing component, or
 * a declared range that still accepts the new version. */
export interface NotMovedEvidence {
  readonly component: string;
  readonly why: "no-reverse-dependency" | "range-compatible";
}

/** The propagation plan (§2.15): the edges in topological order, the
 * topological order of every affected component, and the negative evidence
 * for everything that did not move. */
export interface PropagationPlan {
  readonly edges: readonly PropagationEdge[];
  readonly order: readonly string[];
  readonly notMoved: readonly NotMovedEvidence[];
}

/** `propagate.ts` — computes the propagation plan (§2.15) from the declared
 * component graph (D16) and the lines' release decisions: a component
 * release breaks its dependents' ranges exactly when the new version is
 * outside the declared range expression (caret/tilde/exact); dependents
 * widen (one minor), transitively, in topological order. Unknown dependency
 * names are caller contract violations — this throws naming the edge. */
export type PlanPropagation = (
  components: readonly ComponentMeta[],
  releases: readonly {
    readonly component: string;
    readonly version: Version;
  }[],
) => PropagationPlan;

/** A plan precondition the executing side re-verifies (§2.10, §2.11, E-04):
 * structured data, never prose. `tag-absent` is invariant 6's global tag
 * namespace check (PL-08, E-11) — the target tag must not exist when the
 * plan executes. */
export type PlanPrecondition = { readonly kind: "tag-absent"; readonly tag: string };

/** One line's entry in a plan (§2.11's closed tuple): the line id, the
 * target the plan mints (stable, streams), the change set that produced it
 * (members with id, lineage, type, bump — the decided inputs), the stream
 * states with the seed and pointer base used, and the artifact
 * declarations (declared labels only — never provider state, §2.16). */
export interface PlanLine {
  readonly lineId: string;
  readonly stable: { readonly version: string; readonly tag: string } | null;
  readonly streams: readonly PlannedStream[];
  readonly changes: readonly {
    readonly id: string;
    readonly lineage: readonly string[];
    readonly type: string;
    readonly bump: Bump;
  }[];
  readonly propagation: PropagationPlan;
  readonly preconditions: readonly PlanPrecondition[];
  readonly artifacts: readonly string[];
}

/** The release plan (§2.11): content-fingerprinted (`planId`), persistable,
 * provider-neutral (§2.16). `supersedes` is a recorded relation, never an
 * edit (invariant 5); a regeneration landing on emptiness yields a plan
 * with no lines that still carries `supersedes` (§2.10's no-op successor).
 * `inputsFingerprint` fingerprints the input world (D17: the policy
 * digest, the observed refs/tags, the lines and components, bootstrap,
 * intents, and the policy-relevant extracted change set — policy-ignored
 * commits never invalidate a stored plan, PL-08) so a stored plan can be
 * re-judged against a changed world (E-04). `refusedIntents` (D18) are the
 * requested streams the lines' declared policies refused — recorded, never
 * retried. `explanation` is the plan's mandated explanation data
 * (§2.11/§2.12/§2.13, E-06): everything the pipeline kept out of the plan,
 * surfaced — excluded is not invisible. */
export interface ReleasePlan {
  readonly planId: string;
  readonly supersedes: string | null;
  readonly policyDigest: string;
  readonly inputsFingerprint: string;
  readonly refusedIntents: readonly RefusedIntent[];
  readonly lines: readonly PlanLine[];
  readonly explanation: {
    readonly foreignTags: readonly ForeignTag[];
    readonly conflicts: readonly IdentityConflict[];
    readonly excluded: readonly ExcludedCommit[];
    /** D18 (PL-07): the withhold-deferred commits across the pass — the
     * rule-matched changes the release ranges pinned below (or, for a
     * fully-deferred line, withheld outright), each with its line, matched
     * scope, and the rule's reason. Deferral is recoverable, so the stored
     * plan must show what is waiting (excluded is not invisible). */
    readonly withheld: readonly WithheldCommit[];
  };
}

/** D18 (PL-07) — one withhold-deferred change on the plan's explanation:
 * the decision record carries the raw commits; this is the curated
 * plan-level view naming the rule that deferred each. */
export interface WithheldCommit {
  readonly lineId: string;
  readonly sha: string;
  readonly scope: string;
  readonly reason: string;
}

/** D18/M-08 — a requested stream the line's declared policy refuses
 * (§2.9): recorded on the plan — never retried, never silently absorbed
 * into a stable fallback. The rest of the plan is unaffected: M-08's
 * stable-only line still releases its own change set in the same pass. */
export interface RefusedIntent {
  readonly intent: OperatorIntent;
  readonly lineId: string;
  readonly reason: string;
}

/** `identity.ts` — the canonical JSON of a plan-eligible value (§2.11):
 * recursively key-sorted, no insignificant whitespace. Deterministic across
 * processes (invariant 2). */
export type CanonicalJson = (value: unknown) => string;

/** `identity.ts` — the plan's content fingerprint (§2.11): canonical JSON
 * of the closed tuple (policy digest, inputs fingerprint, supersedes, per
 * line the frozen `PlanLine` fields) → SHA-256 → `plan_sha256:<hex>`.
 * Version equality implies nothing about plan equality (E-11); identical
 * inputs imply identical fingerprints (invariant 2). */
export type PlanFingerprint = (plan: Omit<ReleasePlan, "planId">) => string;

/** `identity.ts` — fingerprints the input world (§2.11, E-04): canonical
 * JSON of the planning input's semantic fields → SHA-256 →
 * `inputs_sha256:<hex>`. A stored plan re-judged against a world whose
 * inputs fingerprint differs is stale (E-04's recognition data). */
export type InputsFingerprint = (input: PlanningInput) => string;

// ---------------------------------------------------------------------------
// The planner's single entry (§2.6 + §2.9 + §2.16) — the integration door
// ---------------------------------------------------------------------------

/** The planner's outcome (§2.9): negative outcomes are records, never
 * exceptions — an attribution refusal is the outcome; a plan whose lines
 * all no-op is still a plan (§2.10's no-op successor shape, `lines: []`).
 * `supersedes` is always `null` from the pure door: the planner has no
 * memory, and threading the prior plan's id is the persistence layer's
 * adjacent concern (§6, D14). */
export type PlanningOutcome =
  | {
      readonly kind: "planned";
      readonly plan: ReleasePlan;
      readonly decisions: readonly LineDecision[];
    }
  | { readonly kind: "refused"; readonly refusal: AttributionRefusal };

/** `assemble.ts` — the planner's single entry (§2.6): normalize → extract →
 * tag history → ranges → attribute → decide → rebuild state → plan
 * targets/streams → propagate → assemble and fingerprint the plan. One
 * pure function of the input boundary (invariant 2, §2.14): identical
 * inputs produce identical outcomes, double-run equal. */
export type Plan = (input: PlanningInput) => PlanningOutcome;
