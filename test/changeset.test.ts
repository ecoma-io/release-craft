import { describe, expect, it } from "vitest";
import {
  BUMP_LEVEL,
  Bump,
  Change,
  type Bump as BumpLevel,
  ChangeSet,
  InvalidChangeSetError,
} from "../src/index.ts";

/**
 * The contract suite for the change set value and its `Bump` vocabulary —
 * the enumerated group a release instantiates, plus the bump level it
 * implies, exercised as an external consumer through the package surface
 * (`../src/index.ts`, ADR-0001 decision 9).
 *
 * Scenario anchors, exactly where the contract cites them: PL-06 (empty is
 * a result, not an absence), M-03 (the triple-count failure is
 * unrepresentable at the value level), P-03 (a change set may be inherited
 * unchanged), and the ADR-0002 vocabulary lock the bump records verbatim.
 */

/** A minimal distinct change — ids are all identity is. */
function change(id: string): Change {
  return Change.of(id);
}

describe("construction doors — every member and the level are validated", () => {
  it("rejects a changes argument that is not an array, carrying it verbatim", () => {
    for (const changes of [undefined, null, 42, "chg:F", { length: 0 }]) {
      let error: unknown;
      try {
        ChangeSet.of(changes as unknown as readonly Change[], "patch");
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(InvalidChangeSetError);
      expect((error as InvalidChangeSetError).input).toBe(changes);
    }
  });

  it("rejects a member that is not a Change value, carrying the whole changes argument", () => {
    for (const member of [undefined, null, "chg:F", 42, {}]) {
      const changes = [change("chg:F"), member, change("chg:G")] as unknown as readonly Change[];
      let error: unknown;
      try {
        ChangeSet.of(changes, "patch");
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(InvalidChangeSetError);
      // The full-input contract names the argument, not the member fragment.
      expect((error as InvalidChangeSetError).input).toBe(changes);
    }
  });

  const badBumps: unknown[] = [undefined, null, 42, "MAJOR", "major ", "", "breaking"];

  for (const bump of badBumps) {
    it(`rejects the bump ${JSON.stringify(String(bump))} (${typeof bump}) without coercing it`, () => {
      let error: unknown;
      try {
        ChangeSet.of([], bump as BumpLevel);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(InvalidChangeSetError);
      expect((error as InvalidChangeSetError).input).toBe(bump);
    });
  }

  it("truncates only the message echo of a long rejected bump, never the input", () => {
    const long = "x".repeat(80);
    let error: unknown;
    try {
      ChangeSet.of([], long as unknown as BumpLevel);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(InvalidChangeSetError);
    expect((error as InvalidChangeSetError).input).toBe(long);
    expect((error as InvalidChangeSetError).message).not.toContain(long);
  });

  it("accepts exactly the three levels", () => {
    for (const bump of ["major", "minor", "patch"] as const) {
      expect(ChangeSet.of([], bump).bump).toBe(bump);
    }
  });

  it("records the bump verbatim — never recomputed, defaulted, or clamped", () => {
    // The level is decided upstream (ADR-0002): the value carries it frozen.
    // A patch-level group recorded as major stays major; the value does not
    // peek at the members to second-guess the planner.
    const fixesOnly = [change("chg:F1"), change("chg:F2")];
    expect(ChangeSet.of(fixesOnly, "major").bump).toBe("major");
    expect(ChangeSet.of(fixesOnly, "minor").bump).toBe("minor");
    expect(ChangeSet.of(fixesOnly, "patch").bump).toBe("patch");
  });
});

describe("identity-uniqueness — M-03's triple-count is unrepresentable", () => {
  it("throws when two members share an id, carrying the whole changes argument", () => {
    const changes = [change("chg:F"), change("chg:G"), change("chg:F")];
    let error: unknown;
    try {
      ChangeSet.of(changes, "patch");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(InvalidChangeSetError);
    expect((error as InvalidChangeSetError).input).toBe(changes);
    expect((error as InvalidChangeSetError).reason).toContain("chg:F");
  });

  it("treats same id with different lineage as one identity — the conflict is planning's to surface (M-05)", () => {
    // M-03/M-05: F and F″ carry one id with divergent lineage records; the
    // group still refuses the second entry — one identity is one member.
    const onMain = Change.of("chg:F", { originCommit: "aaa111", originLine: "main" });
    const on19 = Change.of("chg:F", { originCommit: "ccc333", originLine: "1.9" });

    expect(() => ChangeSet.of([onMain, on19], "patch")).toThrow(InvalidChangeSetError);
  });

  it("accepts distinct ids any number of times", () => {
    const set = ChangeSet.of([change("chg:F"), change("chg:G"), change("chg:H")], "minor");

    expect(set.changes).toHaveLength(3);
  });
});

describe("the empty group — PL-06: empty is a result, not an absence", () => {
  it('is constructible and equals of([], "patch")', () => {
    const empty = ChangeSet.empty();

    expect(empty.changes).toEqual([]);
    expect(empty.bump).toBe("patch");
    expect(empty.equals(ChangeSet.of([], "patch"))).toBe(true);
  });

  it("answers includesIdentity with false for everything — a total query, never an error", () => {
    const empty = ChangeSet.empty();

    expect(empty.includesIdentity("chg:F")).toBe(false);
    // Malformed ids are absent, not exceptional: queries are total.
    expect(empty.includesIdentity("")).toBe(false);
    expect(empty.includesIdentity(" ")).toBe(false);
  });
});

describe("equality — the group is a set by identity, order carries no meaning", () => {
  it("is order-insensitive over the same members", () => {
    const forward = ChangeSet.of([change("chg:F"), change("chg:G"), change("chg:H")], "minor");
    const backward = ChangeSet.of([change("chg:H"), change("chg:F"), change("chg:G")], "minor");

    expect(forward.equals(backward)).toBe(true);
    expect(backward.equals(forward)).toBe(true);
  });

  it("distinguishes identity sets", () => {
    const fg = ChangeSet.of([change("chg:F"), change("chg:G")], "patch");
    const fh = ChangeSet.of([change("chg:F"), change("chg:H")], "patch");

    expect(fg.equals(fh)).toBe(false);
  });

  it("distinguishes member counts", () => {
    const one = ChangeSet.of([change("chg:F")], "patch");
    const two = ChangeSet.of([change("chg:F"), change("chg:G")], "patch");

    expect(one.equals(two)).toBe(false);
    expect(two.equals(one)).toBe(false);
  });

  it("distinguishes the bump — same members, different level, different group", () => {
    const patch = ChangeSet.of([change("chg:F")], "patch");
    const minor = ChangeSet.of([change("chg:F")], "minor");

    expect(patch.equals(minor)).toBe(false);
    expect(patch.equals(ChangeSet.of([change("chg:F")], "patch"))).toBe(true);
  });

  it("compares members by identity, not by record — lineage is not group membership (M-03)", () => {
    const withLineage = ChangeSet.of(
      [Change.of("chg:F", { originLine: "main", originCommit: "aaa111" })],
      "patch",
    );
    const sameIdOtherLineage = ChangeSet.of(
      [Change.of("chg:F", { originLine: "1.9", originCommit: "ccc333" })],
      "patch",
    );

    expect(withLineage.equals(sameIdOtherLineage)).toBe(true);
  });
});

describe("includesIdentity — presence by transport identity", () => {
  it("answers by id, for members with any lineage", () => {
    const set = ChangeSet.of([Change.of("chg:F", { originLine: "1.9" }), change("chg:G")], "patch");

    expect(set.includesIdentity("chg:F")).toBe(true);
    expect(set.includesIdentity("chg:G")).toBe(true);
    expect(set.includesIdentity("chg:H")).toBe(false);
  });
});

describe("freeze discipline — the group is deeply immutable", () => {
  it("freezes the instance and the member array", () => {
    const set = ChangeSet.of([change("chg:F")], "patch");

    expect(Object.isFrozen(set)).toBe(true);
    expect(Object.isFrozen(set.changes)).toBe(true);
  });

  it("refuses mutation through the exposed member array", () => {
    const set = ChangeSet.of([change("chg:F")], "patch");

    expect(() => {
      (set.changes as Change[]).push(change("chg:G"));
    }).toThrow(TypeError);
    expect(set.changes).toHaveLength(1);

    expect(() => {
      (set.changes as Change[]).pop();
    }).toThrow(TypeError);
    expect(set.changes).toHaveLength(1);
  });

  it("refuses direct field assignment on the frozen instance", () => {
    const set = ChangeSet.of([change("chg:F")], "patch");

    expect(() => {
      (set as { bump: BumpLevel }).bump = "major";
    }).toThrow(TypeError);
    expect(set.bump).toBe("patch");
  });

  it("does not alias the caller's array — the value owns its frozen copy", () => {
    const handed = [change("chg:F")];
    const set = ChangeSet.of(handed, "patch");

    expect(set.changes).not.toBe(handed);
    handed.push(change("chg:G"));
    expect(set.changes).toHaveLength(1);
  });

  it("leaves the receiver untouched across queries — P-03's inherited set is reusable", () => {
    // P-03: the same frozen group instantiates rc and release alike; calling
    // the query twice changes nothing.
    const set = ChangeSet.of([change("chg:F"), change("chg:G")], "patch");
    const snapshot = ChangeSet.of([change("chg:F"), change("chg:G")], "patch");

    set.includesIdentity("chg:F");
    set.includesIdentity("chg:H");
    set.equals(snapshot);

    expect(set.equals(snapshot)).toBe(true);
    expect(set.changes).toHaveLength(2);
  });
});

describe("Bump — combining decided levels is value semantics", () => {
  const levels: BumpLevel[] = ["patch", "minor", "major"];

  it("BUMP_LEVEL orders patch < minor < major by ordinal", () => {
    expect(BUMP_LEVEL.patch).toBe(0);
    expect(BUMP_LEVEL.minor).toBe(1);
    expect(BUMP_LEVEL.major).toBe(2);
    expect(BUMP_LEVEL.patch < BUMP_LEVEL.minor).toBe(true);
    expect(BUMP_LEVEL.minor < BUMP_LEVEL.major).toBe(true);
  });

  it("BUMP_LEVEL's ordering is frozen — not data a caller can move", () => {
    expect(() => {
      (BUMP_LEVEL as Record<string, number>).patch = 9;
    }).toThrow(TypeError);
    expect(BUMP_LEVEL.patch).toBe(0);
  });

  it("Bump.max returns the higher of two levels over the full matrix", () => {
    for (const a of levels) {
      for (const b of levels) {
        const expected = BUMP_LEVEL[a] >= BUMP_LEVEL[b] ? a : b;

        expect(Bump.max(a, b)).toBe(expected);
      }
    }
  });

  it("Bump.max is commutative and idempotent", () => {
    for (const a of levels) {
      for (const b of levels) {
        expect(Bump.max(a, b)).toBe(Bump.max(b, a));
      }
      expect(Bump.max(a, a)).toBe(a);
    }
  });
});
