/**
 * Behavioral tests for the changelog renderer (issue #206) — the pure
 * projection of the recorded plan's change set into deterministic
 * CHANGELOG.md bytes.
 *
 * The tests pin the public contract: deterministic byte output, release-please
 * section ordering, hidden-section exclusion, surfacing of undeclared types,
 * entry ordering, idempotent prepend, the S-04 emptiness marker, the four
 * heading forms, commit-link short-form normalization, scope rendering, a
 * golden full-file fixture, caller-contract validation, and the idempotent
 * no-op when versions are empty but existing bytes are present.
 */

import { describe, expect, it } from "vitest";

import {
  renderChangelog,
  InvalidChangelogInputError,
} from "@ecoma-io/release-craft/__internal__/planner/changelog.js";

import type {
  ChangelogInput,
  ChangelogEntry,
  ChangelogVersion,
  ChangelogSection,
} from "@ecoma-io/release-craft/__internal__/planner/changelog.js";

// ---------------------------------------------------------------------------
// Fixture helpers — the inputs are closed values, no ambient state.
// ---------------------------------------------------------------------------

const FEAT_BAR: ChangelogEntry = {
  id: "abc1234def5678",
  type: "feat",
  scope: "bar",
  subject: "add the bar widget",
};

const FIX_FOO: ChangelogEntry = {
  id: "abc1234def5679",
  type: "fix",
  scope: "foo",
  subject: "fix the foo rendering",
};

const FIX_NO_SCOPE: ChangelogEntry = {
  id: "abc1234def5680",
  type: "fix",
  subject: "fix the rendering",
};

const BREAKING_BAR: ChangelogEntry = {
  id: "abc1234def5681",
  type: "feat",
  scope: "bar",
  subject: "drop the legacy bar interface",
  breaking: true,
};

const DEFAULT_SECTIONS: readonly ChangelogSection[] = [
  { type: "feat", section: "Features" },
  { type: "fix", section: "Bug Fixes" },
  { type: "perf", section: "Performance Improvements" },
];

function input(
  versions: readonly ChangelogVersion[],
  overrides?: Partial<ChangelogInput>,
): ChangelogInput {
  return { versions, sections: DEFAULT_SECTIONS, ...overrides };
}

// ---------------------------------------------------------------------------
// §1 — Determinism: identical input, identical bytes (twice; plus JSON
//        round-trip to prove no reference identity leaks).
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("the same input produces byte-identical output across calls and through a JSON round-trip", () => {
    const first = renderChangelog(input([{ version: "1.2.0", entries: [FEAT_BAR] }]));
    const second = renderChangelog(input([{ version: "1.2.0", entries: [FEAT_BAR] }]));
    const roundTripped = renderChangelog(
      JSON.parse(
        JSON.stringify(input([{ version: "1.2.0", entries: [FEAT_BAR] }])),
      ) as ChangelogInput,
    );
    expect(first).toBe(second);
    expect(first).toBe(roundTripped);
  });
});

// ---------------------------------------------------------------------------
// §2 — Declared section order is preserved, breaking section always first.
// ---------------------------------------------------------------------------

describe("section ordering", () => {
  it("declared sections render in the config order and the breaking section is always first", () => {
    const result = renderChangelog(
      input([
        {
          version: "1.2.0",
          entries: [
            { ...FIX_FOO, breaking: true, subject: "drop legacy foo" },
            { ...FIX_FOO, breaking: false, subject: "fix the foo rendering" },
            FEAT_BAR,
          ],
        },
      ]),
    );
    const lines = result.split("\n");
    const breakingHeading = lines.indexOf("### Breaking Changes");
    const featHeading = lines.indexOf("### Features");
    const fixHeading = lines.indexOf("### Bug Fixes");
    expect(breakingHeading).toBeGreaterThanOrEqual(0);
    expect(breakingHeading).toBeLessThan(featHeading);
    expect(featHeading).toBeLessThan(fixHeading);
  });
});

// ---------------------------------------------------------------------------
// §3 — A hidden declared type's entries are excluded; other types unaffected.
// ---------------------------------------------------------------------------

describe("hidden declared section", () => {
  it("excludes entries of a hidden type from the rendered output", () => {
    const result = renderChangelog(
      input([{ version: "1.0.0", entries: [FEAT_BAR, FIX_FOO] }], {
        sections: [
          { type: "feat", section: "Features" },
          { type: "fix", section: "Bug Fixes", hidden: true },
        ],
      }),
    );
    expect(result).toContain("### Features");
    expect(result).not.toContain("### Bug Fixes");
    expect(result).toContain("add the bar widget");
    expect(result).not.toContain("fix the foo rendering");
  });
});

// ---------------------------------------------------------------------------
// §4 — Undeclared types are surfaced under a capitalized type heading,
//        sorted by type code-point order.
// ---------------------------------------------------------------------------

describe("undeclared types are surfaced", () => {
  it("renders undeclared types under their own capitalized headings, sorted alphabetically", () => {
    const result = renderChangelog(
      input([
        {
          version: "1.3.0",
          entries: [
            { type: "test", subject: "add integration test" },
            { type: "refactor", id: "aaa1111bbb2222", subject: "extract config" },
          ],
        },
      ]),
    );
    expect(result).toContain("### Refactor");
    expect(result).toContain("### Test");
    const refactorLine = result.indexOf("### Refactor");
    const testLine = result.indexOf("### Test");
    expect(refactorLine).toBeLessThan(testLine);
  });
});

// ---------------------------------------------------------------------------
// §5 — Entry order within a section matches the input order.
// ---------------------------------------------------------------------------

describe("entry ordering within a section", () => {
  it("entries appear in the same order as the input array", () => {
    const first: ChangelogEntry = { type: "feat", subject: "alpha feature", id: "aaa1111" };
    const second: ChangelogEntry = { type: "feat", subject: "beta feature", id: "bbb2222" };
    const result = renderChangelog(input([{ version: "1.0.0", entries: [first, second] }]));
    const alphaPos = result.indexOf("alpha feature");
    const betaPos = result.indexOf("beta feature");
    expect(alphaPos).toBeLessThan(betaPos);
  });
});

// ---------------------------------------------------------------------------
// §6 — Idempotence / prepend: (a) a second version prepended leaves the
//        first block byte-identical below; (b) re-rendering the same
//        version onto the same existing bytes is byte-identical.
// ---------------------------------------------------------------------------

describe("idempotent prepend", () => {
  it("prepending a newer version leaves the older block byte-identical below", () => {
    const v1 = renderChangelog(
      input([{ version: "1.1.0", date: "2026-01-01", entries: [FIX_FOO] }]),
    );
    const result = renderChangelog(
      input([{ version: "1.2.0", date: "2026-02-01", entries: [FEAT_BAR] }], { existing: v1 }),
    );
    // The v1.1.0 block (its bytes below the file header) survives verbatim,
    // under the freshly prepended v1.2.0 block.
    const v1Block = v1.slice(v1.indexOf("## 1.1.0"));
    expect(result).toContain(v1Block);
    expect(result.indexOf("## 1.2.0")).toBeLessThan(result.indexOf("## 1.1.0"));
  });

  it("re-rendering the same version onto the same existing produces byte-identical output", () => {
    const existing = renderChangelog(
      input([{ version: "1.1.0", date: "2026-01-01", entries: [FIX_FOO] }]),
    );
    const once = renderChangelog(
      input([{ version: "1.2.0", date: "2026-02-01", entries: [FEAT_BAR] }], { existing }),
    );
    const twice = renderChangelog(
      input([{ version: "1.2.0", date: "2026-02-01", entries: [FEAT_BAR] }], { existing: once }),
    );
    expect(once).toBe(twice);
  });
});

// ---------------------------------------------------------------------------
// §7 — The S-04 empty-notes marker: zero entries or all hidden → explicit
//        "No user-facing changes." paragraph.
// ---------------------------------------------------------------------------

describe("S-04 empty-notes marker", () => {
  it("renders the marker when the version has zero entries", () => {
    const result = renderChangelog(input([{ version: "1.0.5", entries: [] }]));
    expect(result).toContain("No user-facing changes.");
  });

  it("renders the marker when all entries are hidden", () => {
    const result = renderChangelog(
      input([{ version: "1.0.5", entries: [FEAT_BAR] }], {
        sections: [{ type: "feat", section: "Features", hidden: true }],
      }),
    );
    expect(result).toContain("No user-facing changes.");
  });
});

// ---------------------------------------------------------------------------
// §8 — The four heading variants are each rendered correctly.
// ---------------------------------------------------------------------------

describe("heading variants", () => {
  it("url + date", () => {
    const result = renderChangelog(
      input([
        { version: "1.0.0", date: "2026-01-01", url: "https://example.com/r", entries: [FEAT_BAR] },
      ]),
    );
    expect(result).toContain("## [1.0.0](https://example.com/r) (2026-01-01)");
  });

  it("url only (no date)", () => {
    const result = renderChangelog(
      input([{ version: "1.0.0", url: "https://example.com/r", entries: [FEAT_BAR] }]),
    );
    expect(result).toContain("## [1.0.0](https://example.com/r)");
  });

  it("date only (no url)", () => {
    const result = renderChangelog(
      input([{ version: "1.0.0", date: "2026-01-01", entries: [FEAT_BAR] }]),
    );
    expect(result).toContain("## 1.0.0 (2026-01-01)");
  });

  it("bare version (neither url nor date)", () => {
    const result = renderChangelog(input([{ version: "1.0.0", entries: [FEAT_BAR] }]));
    expect(result).toContain("## 1.0.0");
    expect(result).not.toContain("## [1.0.0]");
  });
});

// ---------------------------------------------------------------------------
// §9 — Commit link short-form and repository trailing-slash normalization.
// ---------------------------------------------------------------------------

describe("commit links", () => {
  it("renders a 7-char short link when the id is longer and strips a trailing slash from the repository", () => {
    const result = renderChangelog(
      input([{ version: "1.0.0", entries: [FEAT_BAR] }], {
        repository: "https://github.com/acme/widget/",
      }),
    );
    // FEAT_BAR.id is "abc1234def5678" → short form "abc1234"
    expect(result).toContain("[abc1234](https://github.com/acme/widget/commit/abc1234def5678)");
  });

  it("uses the full id as link text when the id is 7 characters or fewer", () => {
    const short: ChangelogEntry = { type: "fix", subject: "fix", id: "abc1234" };
    const result = renderChangelog(
      input([{ version: "1.0.0", entries: [short] }], {
        repository: "https://github.com/acme/widget",
      }),
    );
    expect(result).toContain("[abc1234](https://github.com/acme/widget/commit/abc1234)");
  });

  it("omits the link entirely when no repository is declared", () => {
    const result = renderChangelog(input([{ version: "1.0.0", entries: [FEAT_BAR] }]));
    expect(result).not.toContain("commit/");
  });
});

// ---------------------------------------------------------------------------
// §10 — Scope rendering: with scope produces `**scope:**`, without omits it.
// ---------------------------------------------------------------------------

describe("scope rendering", () => {
  it("renders the scope in bold when present", () => {
    const result = renderChangelog(input([{ version: "1.0.0", entries: [FEAT_BAR] }]));
    expect(result).toContain("* **bar:** add the bar widget");
  });

  it("omits the scope prefix when absent", () => {
    const result = renderChangelog(input([{ version: "1.0.0", entries: [FIX_NO_SCOPE] }]));
    expect(result).toContain("* fix the rendering");
  });
});

// ---------------------------------------------------------------------------
// §11 — Golden full-file fixture: two versions, breaking, scoped, link.
// ---------------------------------------------------------------------------

describe("golden full-file fixture", () => {
  it("produces byte-exact output for a complete two-version changelog", () => {
    const result = renderChangelog(
      input(
        [
          {
            version: "1.2.0",
            date: "2026-02-03",
            url: "https://github.com/acme/widget/compare/v1.1.0...v1.2.0",
            entries: [
              { ...BREAKING_BAR, id: "c0ffee000000001" },
              { ...FEAT_BAR, id: "c0ffee000000002" },
              { ...FIX_FOO, id: "c0ffee000000003" },
            ],
          },
          {
            version: "1.1.0",
            date: "2026-01-15",
            entries: [{ ...FIX_NO_SCOPE, id: "deadbeef000001" }],
          },
        ],
        { repository: "https://github.com/acme/widget" },
      ),
    );
    expect(result).toBe(
      [
        "# Changelog",
        "",
        "## [1.2.0](https://github.com/acme/widget/compare/v1.1.0...v1.2.0) (2026-02-03)",
        "",
        "### Breaking Changes",
        "",
        "* **bar:** drop the legacy bar interface ([c0ffee0](https://github.com/acme/widget/commit/c0ffee000000001))",
        "",
        "### Features",
        "",
        "* **bar:** add the bar widget ([c0ffee0](https://github.com/acme/widget/commit/c0ffee000000002))",
        "",
        "### Bug Fixes",
        "",
        "* **foo:** fix the foo rendering ([c0ffee0](https://github.com/acme/widget/commit/c0ffee000000003))",
        "",
        "## 1.1.0 (2026-01-15)",
        "",
        "### Bug Fixes",
        "",
        "* fix the rendering ([deadbee](https://github.com/acme/widget/commit/deadbeef000001))",
        "",
      ].join("\n"),
    );
  });
});

// ---------------------------------------------------------------------------
// §12 — Validation: empty subject/type/version throws
//        InvalidChangelogInputError.
// ---------------------------------------------------------------------------

describe("caller-contract validation", () => {
  it("throws for an empty version string", () => {
    expect(() => renderChangelog(input([{ version: "", entries: [] }]))).toThrow(
      InvalidChangelogInputError,
    );
  });

  it("throws for an empty entry type", () => {
    expect(() =>
      renderChangelog(input([{ version: "1.0.0", entries: [{ type: "", subject: "foo" }] }])),
    ).toThrow(InvalidChangelogInputError);
  });

  it("throws for an empty entry subject", () => {
    expect(() =>
      renderChangelog(input([{ version: "1.0.0", entries: [{ type: "feat", subject: "" }] }])),
    ).toThrow(InvalidChangelogInputError);
  });
});

// ---------------------------------------------------------------------------
// §13 — Empty versions: with existing → existing verbatim; without → fresh
//         header.
// ---------------------------------------------------------------------------

describe("empty versions with and without existing", () => {
  it("versions empty + existing returns existing verbatim (idempotent no-op)", () => {
    const existing = renderChangelog(
      input([{ version: "1.0.0", date: "2026-01-01", entries: [FEAT_BAR] }]),
    );
    const result = renderChangelog(input([], { existing }));
    expect(result).toBe(existing);
  });

  it("versions empty + no existing produces a bare header", () => {
    const result = renderChangelog(input([]));
    expect(result).toBe("# Changelog\n");
  });
});

// ---------------------------------------------------------------------------
// §14 — Same version on two lines (M-02/M-11): split per-line tag namespaces
//        keep the same version legal across lines, so one CHANGELOG.md
//        carries both plan lines' blocks. Each line's block must survive
//        re-render — byte-identical onto its own output — never collapsed
//        onto the last line's block.
// ---------------------------------------------------------------------------

describe("same version on two lines (M-02/M-11)", () => {
  it("first render carries both lines' headings and entries", () => {
    const first = renderChangelog(
      input([
        { version: "2.0.0", date: "2026-03-01", entries: [FEAT_BAR] },
        { version: "2.0.0", date: "2026-03-01", entries: [FIX_FOO] },
      ]),
    );
    expect(first).toContain("add the bar widget");
    expect(first).toContain("fix the foo rendering");
    const headings = first.split("\n").filter((line) => line.startsWith("## 2.0.0"));
    expect(headings).toHaveLength(2);
  });

  it("re-rendering the same two lines onto their own output is byte-identical", () => {
    const versions = [
      { version: "2.0.0", date: "2026-03-01", entries: [FEAT_BAR] },
      { version: "2.0.0", date: "2026-03-01", entries: [FIX_FOO] },
    ];
    const first = renderChangelog(input(versions));
    const again = renderChangelog(input(versions, { existing: first }));
    // The re-render never collapses the pair onto the last line's block —
    // the pre-fix silent deletion of the first line's entries — and both
    // lines' notes are still there.
    expect(again).toBe(first);
    expect(again).toContain("add the bar widget");
    expect(again).toContain("fix the foo rendering");
  });
});
