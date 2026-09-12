// The §12–14 Tier 1+2 shadow comparison's field list and comparison logic
// (issue #315). This module is deliberately the FIRST half of the harness the
// run used and the only place the field list lives: the fields were fixed
// here, in code, before any value was compared — the anti-cherry-picking law
// the shadow run records under.
//
//   - Every release-please-side value in a comparison arrives with its
//     `rpSource` — the recorded artifact (merged PR, release, tag, committed
//     CHANGELOG bytes, config or manifest file) it was read from. The harness
//     never synthesizes a release-please value (the §15 fixture law): this
//     module compares what it is handed, it does not predict.
//   - A divergent field is classified only when the caller's classification
//     table carries BOTH a class from the closed set and a citation (the
//     compatibility-matrix row, contract, or decision that covers the
//     divergence). Anything else is recorded `unexplained` — the fallback is
//     the harness's own default, never the caller's silence.
//   - `not-exercised` is a verdict, not a dodge: it records that release-
//     please produced no observable output for the field on this window,
//     with the config citation that says why.
//
// Pure logic, zero I/O: the file imports nothing, so the unit pins
// (test/shadow-tier12-harness.test.ts) drive exactly the bytes the run drove.

/**
 * @typedef {"equal" | "divergent" | "not-exercised"} FieldVerdict
 */

/**
 * @typedef {"release-craft-stronger" | "release-please-quirk" | "unexplained"} DivergenceClass
 */

/**
 * One field's comparison row, as the evidence records it.
 *
 * @typedef {object} FieldRow
 * @property {string} field the field's id (a member of FIELD_IDS)
 * @property {string} rpSource the recorded release-please artifact the value
 *   was read from (artifact + ref, e.g. "merged PR #235 body")
 * @property {unknown} rpValue the observed release-please value
 * @property {string} rcSource where release-craft's value was computed from
 * @property {unknown} rcValue release-craft's independently computed value
 * @property {FieldVerdict} verdict equal | divergent | not-exercised
 * @property {DivergenceClass | null} classification present only on a
 *   divergent row
 * @property {string | null} citation the row/contract/decision covering a
 *   classified divergence; null means unexplained (the harness's fallback)
 */

/**
 * @typedef {object} ComparisonCounts
 * @property {number} compared fields where both engines produced an output
 * @property {number} equal
 * @property {number} divergent
 * @property {number} unexplained the divergent rows whose classification
 *   fell back to the harness's default
 * @property {number} notExercised fields release-please produced no output for
 */

/**
 * @typedef {object} Comparison
 * @property {string} consumer
 * @property {readonly FieldRow[]} fields
 * @property {ComparisonCounts} counts
 */

/**
 * One divergent field as the §13 ledger records it.
 *
 * @typedef {object} LedgerDivergence
 * @property {string} consumer
 * @property {string} field
 * @property {string} rpSource
 * @property {unknown} rpValue
 * @property {unknown} rcValue
 * @property {DivergenceClass | null} classification
 * @property {string | null} citation
 */

/**
 * @typedef {object} LedgerTotals
 * @property {number} consumers
 * @property {number} fieldsPerConsumer
 * @property {number} compared
 * @property {number} equal
 * @property {number} divergent
 * @property {number} unexplained
 * @property {number} notExercised
 */

/**
 * @typedef {object} Ledger
 * @property {string[]} consumers
 * @property {LedgerDivergence[]} divergences
 * @property {LedgerTotals} totals
 */

/**
 * The classification table a comparison run is handed: field id → the class
 * and the citation that covers the divergence. A class without a citation is
 * refused to `unexplained` by the harness — pre-classifying without a
 * citable cover is exactly the laundering the shadow law forbids.
 *
 * @typedef {Readonly<Record<string, { readonly class: string, readonly citation: string }>>} ClassificationTable
 */

/**
 * The fixed field list, in its fixed order — frozen. Sixteen fields: the
 * twelve the owning issue names plus the four the compatibility matrix's
 * canonical shadow-comparison field list adds where release-please produces
 * an observable output on these windows (release decision, commit range,
 * selected changes, and the prerelease/channel posture recorded
 * `not-exercised`). The list is part of the pinned surface: the unit pins
 * assert its membership and its size, so a field added after a run — or one
 * quietly dropped — is a visible diff against the recorded evidence.
 *
 * @type {readonly string[]}
 */
export const FIELD_IDS = Object.freeze([
  "release-decision",
  "version",
  "bump-type",
  "tag-name",
  "commit-range",
  "selected-changes",
  "release-pr-title",
  "release-pr-body-structure",
  "release-pr-labels",
  "head-branch-naming",
  "changelog-path",
  "changelog-section-headers",
  "changelog-entry-ordering",
  "commit-to-section-assignment",
  "component-scoping",
  "prerelease-channel",
]);

/** The twelve fields the owning issue names, verbatim — the subset the
 * sixteen-field list exists to cover. (Pinned, like FIELD_IDS.) */
export const ISSUE_FIELD_IDS = Object.freeze([
  "version",
  "bump-type",
  "tag-name",
  "release-pr-title",
  "release-pr-body-structure",
  "release-pr-labels",
  "head-branch-naming",
  "changelog-path",
  "changelog-section-headers",
  "changelog-entry-ordering",
  "commit-to-section-assignment",
  "component-scoping",
]);

/** The closed classification vocabulary (the §13 ledger's classes). */
export const DIVERGENCE_CLASSES = Object.freeze([
  "release-craft-stronger",
  "release-please-quirk",
  "unexplained",
]);

/**
 * Scalar equality over JSON values — the default comparator. Objects and
 * arrays must be deep-equal (the comparison runs over canonical
 * JSON.stringify forms), strings and numbers exactly equal.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * One entry of a shared-order list: `id` identifies the entry across the
 * two engines (a commit sha, a subject), `value` is the payload the row
 * records. A bare non-object entry is its own id and value.
 *
 * @typedef {object} SharedItem
 * @property {unknown} id
 * @property {unknown} value
 */

/**
 * Sequence equality over the SHARED members of two lists, in each list's own
 * order — the comparator behind `changelog-entry-ordering`. Entries the two
 * engines do not both carry are the membership question (the
 * `selected-changes` field's verdict), not the ordering question: this field
 * asks whether, for the entries both sides render, the ORDER agrees. Each
 * side's own sequence is first deduplicated to first occurrences, then
 * restricted to the entries the other side also carries: a member only one
 * engine carries is the membership question (`selected-changes`), and one
 * engine rendering the same entry twice is a rendering quirk, not an
 * ordering fact — neither may manufacture an ordering divergence. Returns
 * null when fewer than two shared entries exist — an order of zero or one
 * elements is not an ordering.
 *
 * @param {{ items: SharedItem[] }} a
 * @param {{ items: SharedItem[] }} b
 * @returns {boolean | null}
 */
const sameSharedOrder = (a, b) => {
  /** @type {(item: SharedItem) => string} */
  const keyOf = (item) => JSON.stringify(item.id);
  const leftKeys = [...new Set(a.items.map(keyOf))];
  const rightKeys = [...new Set(b.items.map(keyOf))];
  const leftSet = new Set(leftKeys);
  const rightSet = new Set(rightKeys);
  const leftShared = leftKeys.filter((key) => rightSet.has(key));
  const rightShared = rightKeys.filter((key) => leftSet.has(key));
  if (leftShared.length < 2) return null;
  return sameValue(leftShared, rightShared);
};

/**
 * Grouping equality over the SHARED commits — the comparator behind
 * `commit-to-section-assignment`. The question is which commits each engine
 * renders in the SAME section, not which heading text it uses (the heading
 * vocabulary is `changelog-section-headers`' own verdict): a fix commit must
 * land in the engine's fix section, whichever spelling that section wears.
 * So the comparator compares the two engines' partitions of the shared
 * commits — two commits sit together on a side exactly when that side gave
 * them one section — which is independent of render order and of heading
 * spelling, and blind to neither. Returns null when no commit is shared —
 * there is no assignment to compare.
 *
 * @param {{ items: SharedItem[] }} a
 * @param {{ items: SharedItem[] }} b
 * @returns {boolean | null}
 */
const sameSharedPartition = (a, b) => {
  /** @type {(item: SharedItem) => string} */
  const keyOf = (item) => JSON.stringify(item.id);
  const left = new Map(a.items.map((item) => [keyOf(item), String(item.value)]));
  const right = new Map(b.items.map((item) => [keyOf(item), String(item.value)]));
  const shared = [...left.keys()].filter((key) => right.has(key));
  if (shared.length < 1) return null;
  for (const [x, kx] of shared.entries()) {
    for (const [y, ky] of shared.entries()) {
      if (y <= x) continue;
      const leftX = /** @type {string} */ (left.get(kx));
      const leftY = /** @type {string} */ (left.get(ky));
      const rightX = /** @type {string} */ (right.get(kx));
      const rightY = /** @type {string} */ (right.get(ky));
      if ((leftX === leftY) !== (rightX === rightY)) return false;
    }
  }
  return true;
};

/**
 * Membership-and-order equality over the two engines' selected change lists,
 * deliberately ignoring the entry payload's representation (release-please
 * records a markdown entry line, release-craft records the change type — the
 * payload difference is a rendering fact, not a selection fact).
 *
 * @param {{ items: SharedItem[] }} a
 * @param {{ items: SharedItem[] }} b
 * @returns {boolean | null}
 */
const sameSelectedChanges = (a, b) =>
  sameValue(
    a.items.map((item) => item.id),
    b.items.map((item) => item.id),
  );

/**
 * Range equality over the recorded coordinates. The two engines name their
 * ends differently (release-please's record carries `baseSha`/`headSha`; the
 * declared world's carries `releasedUpTo`/`head`) — the comparison is over
 * the observed base commit, head commit, and ancestry count.
 *
 * @param {{ baseSha: string, headSha: string, commitCount: number }} a
 * @param {{ releasedUpTo: string, head: string, commitCount: number }} b
 * @returns {boolean | null}
 */
const sameCommitRange = (a, b) =>
  a.baseSha === b.releasedUpTo && a.headSha === b.head && a.commitCount === b.commitCount;

/**
 * Component-scoping equality over the two engines' recorded coordinates:
 * release-please names the package (`package`), the declared world names the
 * component (`component`) — the comparison is over the scoping identity and
 * whether the minted tag carries it.
 *
 * @param {{ package: string | null, tagCarriesComponent: boolean }} a
 * @param {{ component: string | null, tagCarriesComponent: boolean }} b
 * @returns {boolean | null}
 */
const sameComponentScoping = (a, b) =>
  a.package === b.component && a.tagCarriesComponent === b.tagCarriesComponent;

/**
 * The per-field comparators, keyed by field id. Absent ids fall to
 * `sameValue`. The named comparators cover the fields whose two engines
 * record the same fact in different coordinates or at a different grain:
 * `changelog-entry-ordering` compares the shared entries' relative order and
 * `commit-to-section-assignment` the shared commits' grouping (membership is
 * `selected-changes`' question, heading spelling `changelog-section-headers`'s
 * — neither is theirs); `selected-changes` compares the selected identity
 * lists ignoring each engine's entry-payload representation; `commit-range`
 * and `component-scoping` compare equal facts across the two engines'
 * differing coordinate names (documented on each comparator).
 *
 * @type {Readonly<Record<string, (a: unknown, b: unknown) => boolean | null>>}
 */
const COMPARATORS = Object.freeze({
  "changelog-entry-ordering": (a, b) =>
    sameSharedOrder(
      /** @type {{ items: SharedItem[] }} */ (a),
      /** @type {{ items: SharedItem[] }} */ (b),
    ),
  "commit-to-section-assignment": (a, b) =>
    sameSharedPartition(
      /** @type {{ items: SharedItem[] }} */ (a),
      /** @type {{ items: SharedItem[] }} */ (b),
    ),
  "selected-changes": (a, b) =>
    sameSelectedChanges(
      /** @type {{ items: SharedItem[] }} */ (a),
      /** @type {{ items: SharedItem[] }} */ (b),
    ),
  "commit-range": (a, b) =>
    sameCommitRange(
      /** @type {{ baseSha: string, headSha: string, commitCount: number }} */ (a),
      /** @type {{ releasedUpTo: string, head: string, commitCount: number }} */ (b),
    ),
  "component-scoping": (a, b) =>
    sameComponentScoping(
      /** @type {{ package: string | null, tagCarriesComponent: boolean }} */ (a),
      /** @type {{ component: string | null, tagCarriesComponent: boolean }} */ (b),
    ),
});

/**
 * Compares one field's two values into a verdict. `null` on either side
 * means the engine produced no observable output — the `not-exercised`
 * verdict (the evidence's rpSource states which config key says so). The
 * comparator's `null` (order undefined over an empty/lonely shared set)
 * reads as equal-at-this-granularity: the row's `rpValue`/`rcValue` carry
 * the singleton lists, so the record shows exactly why no order existed.
 *
 * @param {string} field
 * @param {unknown} rpValue
 * @param {unknown} rcValue
 * @returns {FieldVerdict}
 */
const verdictFor = (field, rpValue, rcValue) => {
  if (rpValue === null || rcValue === null) return "not-exercised";
  const compare = COMPARATORS[field] ?? sameValue;
  const result = compare(rpValue, rcValue);
  // No ordering exists for fewer than two shared entries; the comparator
  // deliberately returns null and the row remains equal at that granularity.
  return result === null || result ? "equal" : "divergent";
};

/**
 * Runs the fixed field list over one consumer's recorded pair.
 *
 * @param {object} input
 * @param {string} input.consumer the consumer's repository name
 * @param {Readonly<Record<string, { rpSource: string, rpValue: unknown, rcSource: string, rcValue: unknown }>>} input.values
 *   per-field values, keyed by field id — every id in FIELD_IDS must be
 *   present (the harness refuses a partial list: the fixed list is the run's
 *   whole subject)
 * @param {ClassificationTable} input.classifications the caller's
 *   pre-declared classification table; every divergent field not covered
 *   here — or covered without a citation — records `unexplained`
 * @returns {Comparison} the comparison, counts included
 */
export const compareConsumer = (input) => {
  const { consumer, values, classifications } = input;
  /** @type {FieldRow[]} */
  const fields = [];
  for (const id of FIELD_IDS) {
    const value = values[id];
    if (value === undefined) {
      throw new Error(
        `field "${id}" carries no recorded value — the fixed field list is the run's whole subject, never a subset`,
      );
    }
    const verdict = verdictFor(id, value.rpValue, value.rcValue);
    /** @type {DivergenceClass | null} */
    let classification = null;
    /** @type {string | null} */
    let citation = null;
    if (verdict === "divergent") {
      const declared = classifications[id];
      const covered =
        declared !== undefined &&
        DIVERGENCE_CLASSES.includes(/** @type {DivergenceClass} */ (declared.class)) &&
        typeof declared.citation === "string" &&
        declared.citation.length > 0;
      classification = covered ? /** @type {DivergenceClass} */ (declared?.class) : "unexplained";
      citation = covered ? (declared?.citation ?? null) : null;
    }
    fields.push({
      field: id,
      rpSource: value.rpSource,
      rpValue: value.rpValue,
      rcSource: value.rcSource,
      rcValue: value.rcValue,
      verdict,
      classification,
      citation,
    });
  }
  const divergent = fields.filter((row) => row.verdict === "divergent");
  return {
    consumer,
    fields,
    counts: {
      compared: fields.filter((row) => row.verdict !== "not-exercised").length,
      equal: fields.filter((row) => row.verdict === "equal").length,
      divergent: divergent.length,
      unexplained: divergent.filter((row) => row.classification === "unexplained").length,
      notExercised: fields.filter((row) => row.verdict === "not-exercised").length,
    },
  };
};

/**
 * Aggregates per-consumer comparisons into the §13 divergence ledger: one
 * row per divergent field, its classification and citation, and the run's
 * totals. Every row keeps its consumer's name — the ledger is the record a
 * Tier 3 gate reads, and a Tier 3 gate reads `unexplained` as a stop.
 *
 * @param {readonly Comparison[]} comparisons
 * @returns {Ledger} the ledger: the divergent rows, the totals, the counts
 *   a matrix cell cites
 */
export const aggregateLedger = (comparisons) => {
  const divergences = comparisons.flatMap((comparison) =>
    comparison.fields
      .filter((row) => row.verdict === "divergent")
      .map((row) => ({
        consumer: comparison.consumer,
        field: row.field,
        rpSource: row.rpSource,
        rpValue: row.rpValue,
        rcValue: row.rcValue,
        classification: row.classification,
        citation: row.citation,
      })),
  );
  const allFields = comparisons.flatMap((comparison) => comparison.fields);
  return {
    consumers: comparisons.map((comparison) => comparison.consumer),
    divergences,
    totals: {
      consumers: comparisons.length,
      fieldsPerConsumer: FIELD_IDS.length,
      compared: allFields.filter((row) => row.verdict !== "not-exercised").length,
      equal: allFields.filter((row) => row.verdict === "equal").length,
      divergent: allFields.filter((row) => row.verdict === "divergent").length,
      unexplained: allFields.filter((row) => row.classification === "unexplained").length,
      notExercised: allFields.filter((row) => row.verdict === "not-exercised").length,
    },
  };
};
