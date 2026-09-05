import { describe, expect, it } from "vitest";
import {
  InvalidLineTransitionError,
  InvalidVersionError,
  ReleaseLine,
  Version,
} from "../src/index.ts";

/**
 * The contract suite for the release line value — the ordered stream of
 * versions, identified by itself — exercised as an external consumer
 * through the package surface (`../src/index.ts`, ADR-0001 decision 9).
 *
 * Scenario anchors, exactly where the contract cites them: invariant 7
 * (identity is not a ref name — M-10, S-03, S-05), invariant 8
 * (prereleases are streams — P-01, P-02, P-04, P-05, P-06), M-10
 * (retirement is a state, not deletion), M-11/E-11 (equal-version
 * re-release on one line is refused).
 */

/** The version helper — one parse per literal keeps the fixtures honest. */
function v(spec: string): Version {
  return Version.parse(spec);
}

/** The error `thunk` raised — or a loud failure, never a maybe. */
function caught(thunk: () => unknown): unknown {
  try {
    thunk();
  } catch (error) {
    return error;
  }
  throw new Error("unreachable — the operation succeeded where the contract refuses it");
}

/** Plain string comparison — the foil P-01 argues against, as in version.test.ts. */
function lexically(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The error `ReleaseLine.create` raised for this id — or a loud failure. */
function createError(id: unknown): unknown {
  try {
    ReleaseLine.create(id as string);
  } catch (error) {
    return error;
  }
  throw new Error(`unreachable — create accepted ${JSON.stringify(id)}`);
}

describe("construction doors — the id is an opaque string, never a ref name", () => {
  const rejected: unknown[] = ["", " ", "\t", " 1.x", "1.x ", 42, null, undefined, {}];

  for (const id of rejected) {
    it(`rejects the id ${JSON.stringify(String(id))} (${typeof id})`, () => {
      const error = createError(id) as InvalidLineTransitionError;

      expect(error).toBeInstanceOf(InvalidLineTransitionError);
      expect(error.input).toBe(id);
    });
  }

  it("truncates only the message echo, never the input", () => {
    const long = "x".repeat(80);
    const error = createError(` ${long} `) as InvalidLineTransitionError;

    expect(error.input).toBe(` ${long} `);
    expect(error.message).not.toContain(long);
  });

  it("creates the initial state: active, no releases, no streams", () => {
    const line = ReleaseLine.create("1.x");

    expect(line.id).toBe("1.x");
    expect(line.lifecycle).toBe("active");
    expect(line.released).toBeNull();
    expect(line.streams).toEqual([]);
  });
});

describe("invariant 7 — the value has no branch field to rename", () => {
  it("exposes exactly the contract's field list, and nothing that could be a feed ref", () => {
    const line = ReleaseLine.create("1.x").withReleased(v("1.9.0"));

    // The exact list is the assertion: a `branch`, `ref`, or feed field
    // appearing here would fail it — that is how the absence is proven.
    expect(Object.keys(line)).toEqual(["id", "lifecycle", "released", "streams"]);
  });

  it("survives a feed-branch rename as the same line — there is no field the rename could touch", () => {
    // M-10/S-03/S-05: "renaming the feed branch" is a no-op on the value —
    // it has no representation here, which the key list above is the proof
    // of. Identity is the recorded state and nothing beside it, so the
    // independently constructed line after the "rename" is the same line.
    const before = ReleaseLine.create("1.x").withReleased(v("1.9.5"));
    const after = ReleaseLine.create("1.x").withReleased(v("1.9.5"));

    expect(after.equals(before)).toBe(true);
    expect(after.id).toBe("1.x");
  });

  it("records stream state keyed by (target, identifier) only — the record's own keys", () => {
    const line = ReleaseLine.create("1.x").advanceStream(v("1.2.0"), "alpha");
    const state = line.streams[0] as unknown as Record<string, unknown>;

    expect(Object.keys(state)).toEqual(["target", "identifier", "sequence"]);
  });
});

describe("the released pointer — monotonic per line (M-11/E-11 are per-line facts)", () => {
  it("records the first release from a null pointer", () => {
    const line = ReleaseLine.create("1.x").withReleased(v("1.9.0"));

    expect(line.released?.toString()).toBe("1.9.0");
  });

  it("accepts a version that advances beyond the pointer", () => {
    const line = ReleaseLine.create("1.x")
      .withReleased(v("1.9.0"))
      .withReleased(v("1.9.1"))
      .withReleased(v("2.0.0"));

    expect(line.released?.toString()).toBe("2.0.0");
  });

  it("refuses an equal version — re-release on one line is a conflict, carried with the offending input", () => {
    const line = ReleaseLine.create("1.x").withReleased(v("1.9.0"));
    const repeat = v("1.9.0");
    const error = caught(() => line.withReleased(repeat)) as InvalidLineTransitionError;

    expect(error).toBeInstanceOf(InvalidLineTransitionError);
    expect(error.input).toBe(repeat);
    expect(line.released?.toString()).toBe("1.9.0");
  });

  it("refuses a lower version — the pointer never regresses", () => {
    const line = ReleaseLine.create("1.x").withReleased(v("1.9.0"));

    expect(() => line.withReleased(v("1.8.9"))).toThrow(InvalidLineTransitionError);
    expect(() => line.withReleased(v("0.9.9"))).toThrow(InvalidLineTransitionError);
    expect(line.released?.toString()).toBe("1.9.0");
  });

  it("orders by compare, not by string — 1.10.0 advances beyond 1.9.0", () => {
    const line = ReleaseLine.create("1.x").withReleased(v("1.9.0"));

    expect(line.withReleased(v("1.10.0")).released?.toString()).toBe("1.10.0");
  });

  it("guards monotonicity only — a prerelease that advances is the policy's call, not the value's", () => {
    // The contract's parenthetical: the pointer holds releases, and the
    // guard is regression-or-equality, nothing more; whether policy ever
    // puts a prerelease here does not reach this value.
    const line = ReleaseLine.create("1.x").withReleased(v("1.9.0"));

    expect(line.withReleased(v("2.0.0-rc.1")).released?.toString()).toBe("2.0.0-rc.1");
    expect(() => line.withReleased(v("1.9.0-rc.1"))).toThrow(InvalidLineTransitionError);
  });

  it("refuses a non-Version argument, carrying it verbatim", () => {
    const line = ReleaseLine.create("1.x");

    for (const version of ["1.9.0", { major: 1, minor: 9, patch: 0 }, null, 42]) {
      const error = caught(() =>
        line.withReleased(version as unknown as Version),
      ) as InvalidLineTransitionError;

      expect(error).toBeInstanceOf(InvalidLineTransitionError);
      expect(error.input).toBe(version);
    }
  });
});

describe("stream arithmetic — invariant 8: streams are state, keyed and numeric", () => {
  it("seeds a new (target, identifier) key at sequence 0", () => {
    const line = ReleaseLine.create("1.x").advanceStream(v("1.2.0"), "alpha");

    expect(line.streams).toHaveLength(1);
    expect(line.streams[0]?.identifier).toBe("alpha");
    expect(line.streams[0]?.sequence).toBe(0);
    expect(line.streams[0]?.target.toString()).toBe("1.2.0");
  });

  it("P-01: advances alpha.9 to alpha.10 — numeric, where lexicographic order lies", () => {
    let line = ReleaseLine.create("1.x");
    // Ten advances of the alpha stream toward 1.2.0: head alpha.0 … alpha.9.
    for (let step = 0; step < 10; step += 1) {
      line = line.advanceStream(v("1.2.0"), "alpha");
    }

    expect(line.streamVersion(v("1.2.0"), "alpha")?.toString()).toBe("1.2.0-alpha.9");

    const next = line.advanceStream(v("1.2.0"), "alpha");

    expect(next.streamVersion(v("1.2.0"), "alpha")?.toString()).toBe("1.2.0-alpha.10");
    // The trap P-01 names: a string-sorting tool reads alpha.9 > alpha.10
    // and re-publishes alpha.9. Ordering is Version#compare, never lexical.
    expect(lexically("1.2.0-alpha.9", "1.2.0-alpha.10")).toBe(1);
    expect(
      next
        .streamVersion(v("1.2.0"), "alpha")
        ?.compare(line.streamVersion(v("1.2.0"), "alpha") as Version),
    ).toBe(1);
  });

  it("P-04: a feat landing mid-RC bumps the sequence — the state is a counter, not a boolean", () => {
    const rc1 = ReleaseLine.create("1.x").advanceStream(v("1.2.0"), "rc");
    const rc2 = rc1.advanceStream(v("1.2.0"), "rc");

    expect(rc1.streamVersion(v("1.2.0"), "rc")?.toString()).toBe("1.2.0-rc.0");
    expect(rc2.streamVersion(v("1.2.0"), "rc")?.toString()).toBe("1.2.0-rc.1");
  });

  it("P-05: a different target under the same identifier is a new key at 0 — no cross-target continuation", () => {
    const at12 = ReleaseLine.create("1.x")
      .advanceStream(v("1.2.0"), "rc")
      .advanceStream(v("1.2.0"), "rc"); // rc.1 published, target 1.2.0

    const moved = at12.advanceStream(v("2.0.0"), "rc");

    // The target moved under you: 2.0.0-rc.0, never 2.0.0-rc.2.
    expect(moved.streamVersion(v("2.0.0"), "rc")?.toString()).toBe("2.0.0-rc.0");
    // The abandoned sequence is kept as state, never deleted (P-05).
    expect(moved.streamVersion(v("1.2.0"), "rc")?.toString()).toBe("1.2.0-rc.1");
    expect(moved.streams).toHaveLength(2);
  });

  it("P-06: two streams under one target are both expressible, each advancing alone", () => {
    let line = ReleaseLine.create("1.x");
    for (let step = 0; step < 5; step += 1) {
      line = line.advanceStream(v("1.2.0"), "alpha"); // alpha.4 head
    }
    line = line.advanceStream(v("1.2.0"), "rc"); // rc.0 beside it

    // "Advance rc only": alpha untouched at 4, rc moves to 1.
    const afterFix = line.advanceStream(v("1.2.0"), "rc");

    expect(afterFix.streamVersion(v("1.2.0"), "alpha")?.toString()).toBe("1.2.0-alpha.4");
    expect(afterFix.streamVersion(v("1.2.0"), "rc")?.toString()).toBe("1.2.0-rc.1");
  });

  it("P-02: the ladder is per-identifier — beta seeds fresh at 0 while alpha's state remains", () => {
    let line = ReleaseLine.create("1.x");
    for (let step = 0; step < 4; step += 1) {
      line = line.advanceStream(v("1.2.0"), "alpha"); // alpha.3 published
    }

    const beta = line.advanceStream(v("1.2.0"), "beta");

    expect(beta.streamVersion(v("1.2.0"), "beta")?.toString()).toBe("1.2.0-beta.0");
    expect(beta.streamVersion(v("1.2.0"), "alpha")?.toString()).toBe("1.2.0-alpha.3");
    // The ladder's order is SemVer precedence: beta.0 > alpha.3 despite the reset.
    expect(beta.streamVersion(v("1.2.0"), "beta")?.compare(v("1.2.0-alpha.3"))).toBe(1);
  });

  it("keys streams by Version#equals — build metadata is part of a target's identity", () => {
    const plain = ReleaseLine.create("1.x").advanceStream(v("1.2.0"), "alpha");
    const built = plain.advanceStream(v("1.2.0+exp.1"), "alpha");

    expect(built.streams).toHaveLength(2);
    expect(built.streamVersion(v("1.2.0"), "alpha")?.toString()).toBe("1.2.0-alpha.0");
    expect(built.streamVersion(v("1.2.0+exp.1"), "alpha")?.toString()).toBe("1.2.0+exp.1-alpha.0");
  });

  it("answers null for an absent key — a total query, never an error", () => {
    const line = ReleaseLine.create("1.x").advanceStream(v("1.2.0"), "alpha");

    expect(line.streamVersion(v("1.2.0"), "beta")).toBeNull();
    expect(line.streamVersion(v("2.0.0"), "alpha")).toBeNull();
    expect(ReleaseLine.create("1.x").streamVersion(v("1.2.0"), "alpha")).toBeNull();
  });

  it("composes the stream version through Version.parse — the round trip is exact", () => {
    let line = ReleaseLine.create("1.x");
    for (let step = 0; step < 5; step += 1) {
      line = line.advanceStream(v("1.2.0"), "alpha");
    }
    const composed = line.streamVersion(v("1.2.0"), "alpha") as Version;

    expect(composed.equals(Version.parse("1.2.0-alpha.4"))).toBe(true);
    expect(Version.parse(composed.toString()).equals(composed)).toBe(true);
  });

  it("surfaces Version's own typed rejection when a recorded key cannot compose — no silent fallback", () => {
    // An identifier that passes the opaque door but is not prerelease
    // grammar (a space) composes to an invalid version string; the
    // composition is Version.parse's door, and this value adds nothing
    // beside it.
    const line = ReleaseLine.create("1.x").advanceStream(v("1.2.0"), "al pha");

    expect(() => line.streamVersion(v("1.2.0"), "al pha")).toThrow(InvalidVersionError);
  });

  it("refuses a non-Version target, carrying it verbatim", () => {
    const line = ReleaseLine.create("1.x");

    for (const target of ["1.2.0", { major: 1 }, null]) {
      const error = caught(() =>
        line.advanceStream(target as unknown as Version, "alpha"),
      ) as InvalidLineTransitionError;

      expect(error).toBeInstanceOf(InvalidLineTransitionError);
      expect(error.input).toBe(target);
    }
  });

  it("validates the identifier by the same opaque rule, carrying it verbatim", () => {
    const line = ReleaseLine.create("1.x");

    for (const identifier of ["", " ", " alpha", "alpha ", 42, null, undefined]) {
      const error = caught(() =>
        line.advanceStream(v("1.2.0"), identifier as string),
      ) as InvalidLineTransitionError;

      expect(error).toBeInstanceOf(InvalidLineTransitionError);
      expect(error.input).toBe(identifier);
    }
  });
});

describe("lifecycle — the matrix is total and validated (M-10: retirement is a state)", () => {
  it("walks active → frozen → retired", () => {
    const line = ReleaseLine.create("1.x");
    const frozen = line.freeze();

    expect(frozen.lifecycle).toBe("frozen");
    expect(frozen.retire().lifecycle).toBe("retired");
  });

  it("walks active → retired directly", () => {
    expect(ReleaseLine.create("1.x").retire().lifecycle).toBe("retired");
  });

  it("refuses frozen → frozen", () => {
    const frozen = ReleaseLine.create("1.x").freeze();

    expect(() => frozen.freeze()).toThrow(InvalidLineTransitionError);
  });

  it("refuses retired → retired: retirement is terminal", () => {
    const retired = ReleaseLine.create("1.x").retire();

    expect(() => retired.retire()).toThrow(InvalidLineTransitionError);
  });

  it("refuses retired → frozen: nothing leaves retirement", () => {
    const retired = ReleaseLine.create("1.x").retire();

    expect(() => retired.freeze()).toThrow(InvalidLineTransitionError);
    expect(retired.lifecycle).toBe("retired");
  });

  it("refuses every mutating operation on a retired line", () => {
    const retired = ReleaseLine.create("1.x").withReleased(v("1.9.0")).retire();

    expect(() => retired.withReleased(v("1.9.1"))).toThrow(InvalidLineTransitionError);
    expect(() => retired.advanceStream(v("1.9.1"), "alpha")).toThrow(InvalidLineTransitionError);
    // The refusal mutates nothing: the line survives as recorded state.
    expect(retired.released?.toString()).toBe("1.9.0");
    expect(retired.streams).toEqual([]);
  });

  it("lets a frozen line still record releases and advance streams — only retirement is terminal", () => {
    const frozen = ReleaseLine.create("1.x").withReleased(v("1.9.0")).freeze();

    const stillReleasing = frozen.withReleased(v("1.9.1"));
    expect(stillReleasing.lifecycle).toBe("frozen");
    expect(stillReleasing.released?.toString()).toBe("1.9.1");

    const stillStreaming = frozen.advanceStream(v("1.10.0"), "alpha");
    expect(stillStreaming.lifecycle).toBe("frozen");
    expect(stillStreaming.streamVersion(v("1.10.0"), "alpha")?.toString()).toBe("1.10.0-alpha.0");
  });
});

describe("equality — structural over id, lifecycle, released, and the stream set", () => {
  it("equals an identically-constructed line", () => {
    const mine = ReleaseLine.create("1.x").withReleased(v("1.9.0"));
    const yours = ReleaseLine.create("1.x").withReleased(v("1.9.0"));

    expect(mine).not.toBe(yours);
    expect(mine.equals(yours)).toBe(true);
  });

  it("distinguishes ids", () => {
    expect(ReleaseLine.create("1.x").equals(ReleaseLine.create("2.x"))).toBe(false);
  });

  it("distinguishes lifecycles over identical state", () => {
    const active = ReleaseLine.create("1.x").withReleased(v("1.9.0"));
    const frozen = active.freeze();

    expect(active.equals(frozen)).toBe(false);
    expect(frozen.equals(active)).toBe(false);
  });

  it("distinguishes the released pointer by Version#equals — build metadata included", () => {
    const bare = ReleaseLine.create("1.x").withReleased(v("1.9.0"));
    const built = ReleaseLine.create("1.x").withReleased(v("1.9.0+a"));

    expect(bare.equals(built)).toBe(false);
  });

  it("distinguishes a null pointer from a set one, both directions", () => {
    const empty = ReleaseLine.create("1.x");
    const released = empty.withReleased(v("1.9.0"));

    expect(empty.equals(released)).toBe(false);
    expect(released.equals(empty)).toBe(false);
  });

  it("ignores stream order — the stream set is keyed, the array order carries no meaning", () => {
    const alphaFirst = ReleaseLine.create("1.x")
      .advanceStream(v("1.2.0"), "alpha")
      .advanceStream(v("1.2.0"), "rc");
    const rcFirst = ReleaseLine.create("1.x")
      .advanceStream(v("1.2.0"), "rc")
      .advanceStream(v("1.2.0"), "alpha");

    expect(alphaFirst.equals(rcFirst)).toBe(true);
  });

  it("distinguishes stream sequences and stream key sets", () => {
    const once = ReleaseLine.create("1.x").advanceStream(v("1.2.0"), "alpha");
    const twice = once.advanceStream(v("1.2.0"), "alpha");
    const otherKey = ReleaseLine.create("1.x").advanceStream(v("1.2.0"), "beta");

    expect(once.equals(twice)).toBe(false);
    expect(once.equals(otherKey)).toBe(false);
    expect(once.equals(ReleaseLine.create("1.x").advanceStream(v("1.3.0"), "alpha"))).toBe(false);
  });

  it("does not share stream records between lines — a frozen copy per instance", () => {
    const seeded = ReleaseLine.create("1.x").advanceStream(v("1.2.0"), "alpha");
    const advanced = seeded.advanceStream(v("1.2.0"), "alpha");

    expect(advanced.streams[0]).not.toBe(seeded.streams[0]);
    expect(advanced.streams[0]?.sequence).toBe(1);
    expect(seeded.streams[0]?.sequence).toBe(0);
  });
});

describe("freeze discipline — every method returns a new value or throws", () => {
  it("freezes the instance, the stream array, and every stream record", () => {
    const line = ReleaseLine.create("1.x").advanceStream(v("1.2.0"), "alpha");

    expect(Object.isFrozen(line)).toBe(true);
    expect(Object.isFrozen(line.streams)).toBe(true);
    expect(Object.isFrozen(line.streams[0])).toBe(true);
  });

  it("refuses mutation through the exposed stream array", () => {
    const line = ReleaseLine.create("1.x").advanceStream(v("1.2.0"), "alpha");

    expect(() => {
      (line.streams as unknown as unknown[]).push({
        target: v("1.3.0"),
        identifier: "beta",
        sequence: 0,
      });
    }).toThrow(TypeError);
    expect(line.streams).toHaveLength(1);

    expect(() => {
      (line.streams as unknown as { identifier: string }[]).shift();
    }).toThrow(TypeError);
    expect(line.streams).toHaveLength(1);
  });

  it("refuses mutation through a stream record", () => {
    const line = ReleaseLine.create("1.x").advanceStream(v("1.2.0"), "alpha");
    const state = line.streams[0] as { sequence: number };

    expect(() => {
      state.sequence = 9;
    }).toThrow(TypeError);
    expect(state.sequence).toBe(0);
  });

  it("refuses direct field assignment on the frozen instance", () => {
    const line = ReleaseLine.create("1.x");

    expect(() => {
      (line as { id: string }).id = "2.x";
    }).toThrow(TypeError);
    expect(line.id).toBe("1.x");
  });

  it("leaves the receiver untouched across repeated calls — call twice, deep-equal", () => {
    const line = ReleaseLine.create("1.x").withReleased(v("1.9.0"));
    const snapshot = ReleaseLine.create("1.x").withReleased(v("1.9.0"));

    line.withReleased(v("1.10.0"));
    line.withReleased(v("2.0.0"));
    line.advanceStream(v("1.10.0"), "alpha");
    line.advanceStream(v("1.10.0"), "alpha");
    line.freeze();
    line.retire();

    expect(line.equals(snapshot)).toBe(true);
    expect(line.lifecycle).toBe("active");
    expect(line.released?.toString()).toBe("1.9.0");
    expect(line.streams).toEqual([]);
  });
});
