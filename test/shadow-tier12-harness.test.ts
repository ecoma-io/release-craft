/**
 * Behavioral tests for the §12–14 Tier 1+2 shadow-comparison harness (issue
 * #315) — the comparison module the recorded run drove, pinned so the field
 * list and the honesty fallbacks cannot drift after the evidence was
 * written.
 *
 * The tests pin the public contract: the fixed field list's membership and
 * size (16 fields, the owning issue's 12 among them), the refusal to compare
 * a partial list, the closed classification vocabulary, the harness's
 * unexplained fallback (a divergent field covered without a citation — or
 * with a class outside the closed set — records unexplained, never a
 * quieter verdict), the verdict and count arithmetic (equal, divergent,
 * not-exercised, unexplained), the comparator grain (ordering and assignment
 * compare over the shared entries; selection ignores each engine's entry
 * payload; range and component scoping compare equal facts across differing
 * coordinate names), and the ledger's shape (consumer-tagged divergences,
 * totals a matrix cell can cite).
 */

import { describe, expect, it } from "vitest";

import {
  aggregateLedger,
  compareConsumer,
  DIVERGENCE_CLASSES,
  FIELD_IDS,
  ISSUE_FIELD_IDS,
} from "../e2e/shadow/compare-fields.mjs";
import type { ClassificationTable } from "../e2e/shadow/compare-fields.mjs";

/** A full recorded-value set: one entry per field id, all equal by default.
 * The structural fields carry their comparators' expected shapes. */
const equalValues = (): Record<
  string,
  { rpSource: string; rpValue: unknown; rcSource: string; rcValue: unknown }
> =>
  Object.fromEntries(
    FIELD_IDS.map((id) => {
      const base = { rpSource: "the recorded artifact", rcSource: "the recorded plan" };
      const structural: Record<string, { rpValue: unknown; rcValue: unknown }> = {
        "selected-changes": { rpValue: { items: [] }, rcValue: { items: [] } },
        "changelog-entry-ordering": { rpValue: { items: [] }, rcValue: { items: [] } },
        "commit-to-section-assignment": { rpValue: { items: [] }, rcValue: { items: [] } },
        "commit-range": {
          rpValue: { baseTag: "v0.0.0", baseSha: "b", headSha: "h", commitCount: 0 },
          rcValue: { releasedUpTo: "b", head: "h", commitCount: 0 },
        },
        "component-scoping": {
          rpValue: { package: "p", tagCarriesComponent: false },
          rcValue: { component: "p", tagCarriesComponent: false },
        },
      };
      return [
        id,
        {
          ...base,
          ...(structural[id] ?? { rpValue: "x", rcValue: "x" }),
        },
      ];
    }),
  );

describe("the fixed field list", () => {
  it("carries the sixteen fields the run compared, frozen", () => {
    expect(FIELD_IDS).toHaveLength(16);
    expect(Object.isFrozen(FIELD_IDS)).toBe(true);
    expect([...FIELD_IDS]).toEqual([
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
  });

  it("covers the owning issue's twelve fields verbatim", () => {
    expect(ISSUE_FIELD_IDS).toHaveLength(12);
    for (const id of ISSUE_FIELD_IDS) {
      expect(FIELD_IDS).toContain(id);
    }
  });

  it("refuses to compare a partial list — the fixed list is the run's whole subject", () => {
    const values = equalValues();
    delete values["tag-name"];
    expect(() => compareConsumer({ consumer: "r", values, classifications: {} })).toThrow(
      /never a subset/,
    );
  });

  it("keeps the classification vocabulary closed at three classes", () => {
    expect([...DIVERGENCE_CLASSES]).toEqual([
      "release-craft-stronger",
      "release-please-quirk",
      "unexplained",
    ]);
  });
});

describe("the honesty fallbacks", () => {
  it("classifies a divergent field only with a class from the closed set AND a citation", () => {
    const values = equalValues();
    values["version"] = {
      rpSource: "the committed changelog bytes",
      rpValue: "0.6.0",
      rcSource: "the plan's stable target",
      rcValue: "0.6.1",
    };
    const covered: ClassificationTable = {
      version: { class: "release-craft-stronger", citation: "the decision-log row that covers it" },
    };
    expect(
      compareConsumer({ consumer: "r", values, classifications: covered }).fields[1]
        ?.classification,
    ).toBe("release-craft-stronger");
    const noCitation: ClassificationTable = {
      version: { class: "release-craft-stronger", citation: "" },
    };
    expect(
      compareConsumer({ consumer: "r", values, classifications: noCitation }).fields[1]
        ?.classification,
    ).toBe("unexplained");
    const outsideVocabulary: ClassificationTable = {
      version: { class: "PARTIAL", citation: "a matrix cell" },
    };
    expect(
      compareConsumer({ consumer: "r", values, classifications: outsideVocabulary }).fields[1]
        ?.classification,
    ).toBe("unexplained");
    expect(
      compareConsumer({ consumer: "r", values, classifications: {} }).fields[1]?.classification,
    ).toBe("unexplained");
  });

  it("records the citation alongside the classification it covered", () => {
    const values = equalValues();
    values["tag-name"] = {
      rpSource: "the recorded tag",
      rpValue: "v0.6.0",
      rcSource: "the plan's minted tag",
      rcValue: "v1.0.0",
    };
    const table: ClassificationTable = {
      "tag-name": { class: "release-please-quirk", citation: "row G, the tag-format knobs row" },
    };
    const row = compareConsumer({ consumer: "r", values, classifications: table }).fields[3];
    expect(row?.verdict).toBe("divergent");
    expect(row?.classification).toBe("release-please-quirk");
    expect(row?.citation).toBe("row G, the tag-format knobs row");
  });
});

describe("the verdict and count arithmetic", () => {
  it("counts equal, divergent, unexplained and not-exercised fields", () => {
    const values = equalValues();
    values["version"] = {
      rpSource: "a",
      rpValue: "0.6.0",
      rcSource: "b",
      rcValue: "0.6.1",
    }; // divergent
    values["tag-name"] = { rpSource: "a", rpValue: "v0.6.0", rcSource: "b", rcValue: "v0.6.0" }; // equal
    values["prerelease-channel"] = {
      rpSource: "the config",
      rpValue: null,
      rcSource: "b",
      rcValue: null,
    };
    // not exercised — the world mints no prerelease
    const comparison = compareConsumer({ consumer: "r", values, classifications: {} });
    expect(comparison.counts).toEqual({
      compared: 15,
      equal: 14,
      divergent: 1,
      unexplained: 1,
      notExercised: 1,
    });
  });

  it("reads a null on either side as not-exercised, never as a divergence", () => {
    const values = equalValues();
    values["bump-type"] = {
      rpSource: "the manifest",
      rpValue: null,
      rcSource: "the plan",
      rcValue: "patch",
    };
    const row = compareConsumer({ consumer: "r", values, classifications: {} }).fields[2];
    expect(row?.verdict).toBe("not-exercised");
    expect(row?.classification).toBeNull();
  });
});

describe("the comparator grain", () => {
  it("compares entry ordering over the SHARED entries, and a singleton order is equal at its granularity", () => {
    const values = equalValues();
    // Release-please carries a docs entry the plan does not select; the two
    // shared entries render in the same order on both sides.
    values["changelog-entry-ordering"] = {
      rpSource: "the committed bytes",
      rpValue: {
        items: [
          { id: "aaa", value: "aaa" },
          { id: "bbb", value: "bbb" },
          { id: "ccc", value: "ccc" },
        ],
      },
      rcSource: "the rendered bytes",
      rcValue: {
        items: [
          { id: "aaa", value: "aaa" },
          { id: "bbb", value: "bbb" },
        ],
      },
    };
    expect(
      compareConsumer({ consumer: "r", values, classifications: {} }).fields[12]?.verdict,
    ).toBe("equal");
    // Fewer than two shared entries is not an ordering.
    values["changelog-entry-ordering"] = {
      rpSource: "the committed bytes",
      rpValue: {
        items: [
          { id: "aaa", value: "aaa" },
          { id: "bbb", value: "bbb" },
        ],
      },
      rcSource: "the rendered bytes",
      rcValue: { items: [{ id: "zzz", value: "zzz" }] },
    };
    expect(
      compareConsumer({ consumer: "r", values, classifications: {} }).fields[12]?.verdict,
    ).toBe("equal");
    // The same shared entries in a genuinely different relative order diverge.
    values["changelog-entry-ordering"] = {
      rpSource: "the committed bytes",
      rpValue: {
        items: [
          { id: "aaa", value: "aaa" },
          { id: "bbb", value: "bbb" },
        ],
      },
      rcSource: "the rendered bytes",
      rcValue: {
        items: [
          { id: "bbb", value: "bbb" },
          { id: "aaa", value: "aaa" },
        ],
      },
    };
    expect(
      compareConsumer({ consumer: "r", values, classifications: {} }).fields[12]?.verdict,
    ).toBe("divergent");
    // One engine rendering an entry twice is a rendering quirk, not an
    // ordering fact — the first-occurrence order is what compares.
    values["changelog-entry-ordering"] = {
      rpSource: "the committed bytes",
      rpValue: {
        items: [
          { id: "aaa", value: "aaa" },
          { id: "bbb", value: "bbb" },
          { id: "aaa", value: "aaa (again)" },
        ],
      },
      rcSource: "the rendered bytes",
      rcValue: {
        items: [
          { id: "aaa", value: "aaa" },
          { id: "bbb", value: "bbb" },
        ],
      },
    };
    expect(
      compareConsumer({ consumer: "r", values, classifications: {} }).fields[12]?.verdict,
    ).toBe("equal");
  });

  it("compares commit-to-section assignment over the shared commits' grouping, not render order or heading spelling", () => {
    const values = equalValues();
    // Same grouping in a different render order, with a third commit the
    // other engine does not carry: the assignment agrees.
    values["commit-to-section-assignment"] = {
      rpSource: "the committed bytes",
      rpValue: {
        items: [
          { id: "aaa", value: "Features" },
          { id: "bbb", value: "Bug Fixes" },
        ],
      },
      rcSource: "the rendered bytes",
      rcValue: {
        items: [
          { id: "ccc", value: "Feat" },
          { id: "bbb", value: "Fix" },
          { id: "aaa", value: "Feat" },
        ],
      },
    };
    expect(
      compareConsumer({ consumer: "r", values, classifications: {} }).fields[13]?.verdict,
    ).toBe("equal");
    // A commit rendered under the wrong section is a real divergence.
    values["commit-to-section-assignment"] = {
      rpSource: "the committed bytes",
      rpValue: {
        items: [
          { id: "aaa", value: "Features" },
          { id: "bbb", value: "Bug Fixes" },
        ],
      },
      rcSource: "the rendered bytes",
      rcValue: {
        items: [
          { id: "aaa", value: "Features" },
          { id: "bbb", value: "Features" },
        ],
      },
    };
    expect(
      compareConsumer({ consumer: "r", values, classifications: {} }).fields[13]?.verdict,
    ).toBe("divergent");
    // No shared commit is no assignment to compare.
    values["commit-to-section-assignment"] = {
      rpSource: "the committed bytes",
      rpValue: { items: [{ id: "aaa", value: "Features" }] },
      rcSource: "the rendered bytes",
      rcValue: { items: [{ id: "zzz", value: "Fix" }] },
    };
    expect(
      compareConsumer({ consumer: "r", values, classifications: {} }).fields[13]?.verdict,
    ).toBe("equal");
  });

  it("compares the selected changes' membership, ignoring each engine's entry payload", () => {
    const values = equalValues();
    values["selected-changes"] = {
      rpSource: "the committed bytes",
      rpValue: { items: [{ id: "aaa", value: "**scope:** subject (#1) (aaa)" }] },
      rcSource: "the plan's change set",
      rcValue: { items: [{ id: "aaa", value: "feat" }] },
    };
    expect(compareConsumer({ consumer: "r", values, classifications: {} }).fields[5]?.verdict).toBe(
      "equal",
    );
  });

  it("compares the commit range across the two engines' coordinate names", () => {
    const values = equalValues();
    values["commit-range"] = {
      rpSource: "the clone's refs",
      rpValue: { baseTag: "v0.5.0", baseSha: "bbb", headSha: "ccc", commitCount: 79 },
      rcSource: "the declared world",
      rcValue: { releasedUpTo: "bbb", head: "ccc", commitCount: 79 },
    };
    expect(compareConsumer({ consumer: "r", values, classifications: {} }).fields[4]?.verdict).toBe(
      "equal",
    );
    values["commit-range"] = {
      rpSource: "the clone's refs",
      rpValue: { baseTag: "v0.5.0", baseSha: "bbb", headSha: "ccc", commitCount: 79 },
      rcSource: "the declared world",
      rcValue: { releasedUpTo: "bbb", head: "ccc", commitCount: 78 },
    };
    expect(compareConsumer({ consumer: "r", values, classifications: {} }).fields[4]?.verdict).toBe(
      "divergent",
    );
  });

  it("compares component scoping across the package/component names", () => {
    const values = equalValues();
    values["component-scoping"] = {
      rpSource: "the config",
      rpValue: { package: "@ecoma-io/loom", tagCarriesComponent: false },
      rcSource: "the declared world",
      rcValue: { component: "@ecoma-io/loom", tagCarriesComponent: false },
    };
    expect(
      compareConsumer({ consumer: "r", values, classifications: {} }).fields[14]?.verdict,
    ).toBe("equal");
  });
});

describe("the §13 ledger", () => {
  it("aggregates consumer-tagged divergences with their citations and the totals", () => {
    const values = equalValues();
    values["version"] = { rpSource: "a", rpValue: "0.6.0", rcSource: "b", rcValue: "0.6.1" };
    const table: ClassificationTable = {
      version: { class: "release-craft-stronger", citation: "the row that covers it" },
    };
    const ledger = aggregateLedger([
      compareConsumer({ consumer: "ecoma-io/r", values, classifications: table }),
    ]);
    expect(ledger.consumers).toEqual(["ecoma-io/r"]);
    expect(ledger.divergences).toHaveLength(1);
    expect(ledger.divergences[0]).toMatchObject({
      consumer: "ecoma-io/r",
      field: "version",
      classification: "release-craft-stronger",
      citation: "the row that covers it",
    });
    expect(ledger.totals).toEqual({
      consumers: 1,
      fieldsPerConsumer: 16,
      compared: 16,
      equal: 15,
      divergent: 1,
      unexplained: 0,
      notExercised: 0,
    });
  });
});
