import { describe, expect, it } from "vitest";
import { Change, type ChangeLineage, InvalidChangeError } from "../src/index.ts";

/**
 * The contract suite for the change value — the kernel's record of one
 * logical unit of release work, exercised as an external consumer through
 * the package surface (`../src/index.ts`, ADR-0001 decision 9).
 *
 * Every claim in `core/domain/change.ts`'s contract — validated door,
 * opaque strings, identity-is-the-id, lineage recorded never resolved,
 * deep freeze — is asserted against the scenario anchors the contract
 * cites: M-03 (one logical fix on three lines), M-05 (conflicting
 * backport, same id divergent payload), M-04/M-06/M-09/PL-04/PL-05
 * (invariant 9's family: identity survives transport, never derived from
 * content).
 */

/** The error `Change.of` raised for these arguments — or a loud failure, never a maybe. */
function changeError(id: unknown, lineage?: unknown): unknown {
  try {
    Change.of(id as string, lineage as ChangeLineage | undefined);
  } catch (error) {
    return error;
  }
  throw new Error(`unreachable — Change.of accepted ${JSON.stringify(id)}`);
}

describe("construction doors — the id is validated as an opaque string, never patterned", () => {
  const rejected: unknown[] = ["", " ", "\t", " x", "x ", "x\t", 42, null, undefined, {}];

  for (const id of rejected) {
    it(`rejects the id ${JSON.stringify(String(id))} (${typeof id})`, () => {
      expect(() => Change.of(id as string)).toThrow(InvalidChangeError);
    });
  }

  it("carries the offending id on the error, verbatim — never an internal fragment", () => {
    const error = changeError(" padded ") as InvalidChangeError;

    expect(error).toBeInstanceOf(InvalidChangeError);
    expect(error.input).toBe(" padded ");
    expect(typeof error.reason).toBe("string");
  });

  it("accepts any non-empty unpadded string — shape-agnostic by contract (design rule 4)", () => {
    // The kernel never patterns an id: punctuation, colons, unicode are all
    // one opaque transport identity.
    for (const id of ["chg:F", "9f2c-4a1e", "修-2026", "fix-F"]) {
      expect(Change.of(id).id).toBe(id);
    }
  });

  it("truncates only the message echo, never the input — a pathological id cannot bloat a log line", () => {
    const long = `x`.repeat(80);
    const error = changeError(` ${long} `) as InvalidChangeError;

    expect(error.input).toBe(` ${long} `);
    expect(error.message).not.toContain(long);
  });
});

describe("construction doors — the lineage is validated field by field", () => {
  it("records every declared field, present fields only", () => {
    const lineage = { parent: "F", originCommit: "9f2c4a1e", originLine: "1.9" };
    const change = Change.of("F'", lineage);

    expect(change.lineage.parent).toBe("F");
    expect(change.lineage.originCommit).toBe("9f2c4a1e");
    expect(change.lineage.originLine).toBe("1.9");
  });

  it("keeps an absent field absent — never present-and-undefined", () => {
    const change = Change.of("F", {});

    expect(Object.keys(change.lineage)).toEqual([]);
    expect("parent" in change.lineage).toBe(false);
  });

  it("treats an omitted lineage and an empty lineage as the same record", () => {
    expect(Change.of("F").equals(Change.of("F", {}))).toBe(true);
  });

  it("rejects a lineage that is not an object, carrying the argument verbatim", () => {
    for (const lineage of [42, "F", null]) {
      const error = changeError("F", lineage) as InvalidChangeError;

      expect(error).toBeInstanceOf(InvalidChangeError);
      expect(error.input).toBe(lineage);
    }
  });

  const badFields: Array<[keyof ChangeLineage, unknown]> = [
    ["parent", ""],
    ["parent", " "],
    ["parent", " F"],
    ["originCommit", 42],
    ["originCommit", null],
    ["originLine", " "],
  ];

  for (const [field, value] of badFields) {
    it(`rejects the lineage ${field} ${JSON.stringify(String(value))} (${typeof value})`, () => {
      const lineage = { [field]: value } as ChangeLineage;
      const error = changeError("F", lineage) as InvalidChangeError;

      expect(error).toBeInstanceOf(InvalidChangeError);
      // The full-input contract: the error carries the lineage argument the
      // door was handed, not the internal field fragment (design rule 5,
      // exactly as Version.parse re-wraps component rejections).
      expect(error.input).toBe(lineage);
    });
  }

  it("keeps only the declared fields — the caller's extras are not vocabulary", () => {
    const change = Change.of("F", { parent: "P", extra: "not a field" } as ChangeLineage);

    expect(Object.keys(change.lineage)).toEqual(["parent"]);
  });
});

describe("identity — M-03/M-05: one logical fix on three lines is one change", () => {
  // M-03's three copies: F on main, F′ cherry-picked to 2.2, F″ adapted to
  // 1.9 — three SHAs, adapted content, one logical fix.
  const onMain = Change.of("chg:F", { originCommit: "aaa111", originLine: "main" });
  const on22 = Change.of("chg:F", { parent: "chg:F", originCommit: "bbb222", originLine: "2.2" });
  const on19 = Change.of("chg:F", { parent: "chg:F", originCommit: "ccc333", originLine: "1.9" });

  it("makes sameIdentity true across all three copies (M-03)", () => {
    expect(onMain.sameIdentity(on22)).toBe(true);
    expect(on22.sameIdentity(on19)).toBe(true);
    expect(on19.sameIdentity(onMain)).toBe(true);
  });

  it("makes equals false wherever the lineage records diverge (M-05's divergent payload, kept)", () => {
    expect(onMain.equals(on22)).toBe(false);
    expect(on22.equals(on19)).toBe(false);
  });

  it("keeps both facts on one id: same identity, different lineage records (M-05)", () => {
    const backportMain = Change.of("chg:B", { originCommit: "ddd444", originLine: "main" });
    const backport19 = Change.of("chg:B", { originCommit: "eee555", originLine: "1.9" });

    expect(backportMain.sameIdentity(backport19)).toBe(true);
    expect(backportMain.equals(backport19)).toBe(false);
  });

  it("never derives identity from content descriptors — different origins, same id, still one", () => {
    // Invariant 9: no field of this value computes an identity, and none is
    // consulted — the id alone decides, whatever the payload says.
    const plain = Change.of("chg:F");
    const descriptive = Change.of("chg:F", {
      parent: "chg:E",
      originCommit: "fff666",
      originLine: "1.9",
    });

    expect(plain.sameIdentity(descriptive)).toBe(true);
  });

  it("distinguishes different ids, always", () => {
    expect(Change.of("chg:F").sameIdentity(Change.of("chg:G"))).toBe(false);
    expect(Change.of("chg:F").equals(Change.of("chg:G"))).toBe(false);
  });

  it("makes equals structural over exactly id plus the lineage fields", () => {
    const base = { parent: "chg:F", originCommit: "aaa111", originLine: "1.9" };
    const same = Change.of("chg:F2", { ...base });
    const otherParent = Change.of("chg:F2", { ...base, parent: "chg:X" });
    const otherCommit = Change.of("chg:F2", { ...base, originCommit: "zzz999" });
    const otherLine = Change.of("chg:F2", { ...base, originLine: "2.2" });
    const noLine = Change.of("chg:F2", { parent: "chg:F", originCommit: "aaa111" });

    expect(same.equals(Change.of("chg:F2", { ...base }))).toBe(true);
    expect(same.equals(otherParent)).toBe(false);
    expect(same.equals(otherCommit)).toBe(false);
    expect(same.equals(otherLine)).toBe(false);
    expect(same.equals(noLine)).toBe(false);
  });
});

describe("freeze discipline — the record is deeply immutable", () => {
  it("freezes the instance and the lineage record", () => {
    const change = Change.of("chg:F", { originCommit: "aaa111" });

    expect(Object.isFrozen(change)).toBe(true);
    expect(Object.isFrozen(change.lineage)).toBe(true);
  });

  it("refuses mutation through the lineage record", () => {
    const change = Change.of("chg:F", { originCommit: "aaa111" });

    expect(() => {
      (change.lineage as { parent?: string }).parent = "chg:X";
    }).toThrow(TypeError);
    expect(change.lineage.parent).toBeUndefined();
  });

  it("refuses direct field assignment on the frozen instance", () => {
    const change = Change.of("chg:F");

    expect(() => {
      (change as { id: string }).id = "chg:G";
    }).toThrow(TypeError);
    expect(change.id).toBe("chg:F");
  });

  it("does not alias the caller's lineage object — the value owns its frozen copy", () => {
    const handed = { originCommit: "aaa111" };
    const change = Change.of("chg:F", handed);

    expect(change.lineage).not.toBe(handed);
    handed.originCommit = "mutated-after";
    expect(change.lineage.originCommit).toBe("aaa111");
  });
});
