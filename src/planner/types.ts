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
}

/** Package metadata for the component axis (§2.15, PR-4). Manifest versions
 * ride as projections — never as computation truth (invariant 6). */
export interface ComponentMeta {
  readonly name: string;
  readonly manifestVersion: string;
  readonly paths: readonly string[];
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
 * (S-01); `Release-As` semantics per the compatibility boundary row 2. */
export type OperatorIntent =
  | { readonly kind: "release" }
  | { readonly kind: "release-anyway" }
  | { readonly kind: "prerelease"; readonly stream: string; readonly lineId: string }
  | { readonly kind: "release-as"; readonly version: string };

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
 * the ambiguous commits — never silence, never a guess. */
export interface AttributionRefusal {
  readonly kind: "refused";
  readonly cause: "ambiguous-attribution" | "malformed-self-reference-marker";
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
      readonly bump: Bump;
      readonly changes: readonly ParsedCommit[];
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
      readonly kind: "refused";
      readonly cause: "attribution-ambiguity" | "operator-contradiction" | "kernel-rejection";
    } & RecordBase)
  | ({
      readonly kind: "blocked";
      readonly cause: "bootstrap-required" | "stale-plan";
    } & RecordBase);

/** `decide.ts` — turns one line's attribution into its §2.9 decision:
 * release-worthy pending set → `release` with the resolved bump; empty →
 * `no-op` enumerating ignored-by-policy commits; policy-filtered deferrals
 * → `withheld`; attribution ambiguity or operator contradiction → `refused`;
 * unmet preconditions (bootstrap, staleness) → `blocked`. Kernel
 * construction rejections surface as the corresponding record — never
 * re-thrown (§2.9). */
export type DecideLine = (
  line: LineAttribution,
  input: PlanningInput,
  range: LineRange,
) => LineDecision;
