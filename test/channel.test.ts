import { describe, expect, it } from "vitest";
import { Channel, type ChannelTarget, InvalidChannelError, Version } from "../src/index.ts";

/**
 * The contract suite for the channel value — the mutable deliverability
 * pointer, as a value — exercised as an external consumer through the
 * package surface (`../src/index.ts`, ADR-0001 decision 9).
 *
 * Scenario anchors, exactly where the contract cites them: PR-04 (a move —
 * rollback included — is a new value), PR-05 (the one-point-in-time
 * membership query `pointsAt` answers; a retraction removes future
 * membership and returns the channel to hidden), S-02 (a channel exists
 * before its first binding — hidden is a first-class state, not an
 * absence), and invariant 15 (the target names a line and a version, never
 * a provider object).
 */

/** The version helper — one parse per literal keeps the fixtures honest. */
function v(spec: string): Version {
  return Version.parse(spec);
}

/** A well-formed target, for tests whose subject is elsewhere. */
function target(line: string, spec: string): ChannelTarget {
  return { line, version: v(spec) };
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

describe("construction doors — the id is an opaque string", () => {
  const rejected: unknown[] = ["", " ", "\t", " stable", "stable ", 42, null, undefined, {}];

  for (const id of rejected) {
    it(`rejects the id ${JSON.stringify(String(id))} (${typeof id}) on both doors`, () => {
      for (const error of [
        caught(() => Channel.create(id as string)),
        caught(() => Channel.of(id as string, null)),
      ]) {
        expect(error).toBeInstanceOf(InvalidChannelError);
        expect((error as InvalidChannelError).input).toBe(id);
      }
    });
  }

  it("truncates only the message echo, never the input", () => {
    const long = "x".repeat(80);
    const error = caught(() => Channel.create(` ${long} `)) as InvalidChannelError;

    expect(error.input).toBe(` ${long} `);
    expect(error.message).not.toContain(long);
  });

  it("creates a channel hidden — target null is a first-class state (S-02)", () => {
    const channel = Channel.create("stable");

    expect(channel.id).toBe("stable");
    expect(channel.target).toBeNull();
  });
});

describe("construction doors — the target names a line and a version, or nothing", () => {
  it("accepts a null target on both doors", () => {
    expect(Channel.of("stable", null).target).toBeNull();
    expect(Channel.create("stable").repoint(null).target).toBeNull();
  });

  it("accepts a well-formed target, recorded by value", () => {
    const channel = Channel.of("stable", target("1.x", "1.9.0"));

    expect(channel.target?.line).toBe("1.x");
    expect(channel.target?.version.toString()).toBe("1.9.0");
  });

  it("refuses a target that is not an object, carrying it verbatim", () => {
    for (const bad of [undefined, 42, "1.x", false]) {
      const error = caught(() =>
        Channel.of("stable", bad as unknown as ChannelTarget),
      ) as InvalidChannelError;

      expect(error).toBeInstanceOf(InvalidChannelError);
      expect(error.input).toBe(bad);
    }
  });

  it("refuses a target whose version is not a Version value, carrying the whole target", () => {
    for (const version of [undefined, "1.9.0", 42, { major: 1, minor: 9, patch: 0 }]) {
      const bad = { line: "1.x", version } as unknown as ChannelTarget;
      const error = caught(() => Channel.of("stable", bad)) as InvalidChannelError;

      expect(error).toBeInstanceOf(InvalidChannelError);
      expect(error.input).toBe(bad);
    }
  });

  it("refuses a target whose line is not an opaque string, carrying the whole target", () => {
    for (const line of [undefined, "", " ", " 1.x", "1.x ", 42, null]) {
      const bad = { line, version: v("1.9.0") } as unknown as ChannelTarget;
      const error = caught(() => Channel.of("stable", bad)) as InvalidChannelError;

      expect(error).toBeInstanceOf(InvalidChannelError);
      // The full-input contract (design rule 5): the argument handed to the
      // door, not the internal field fragment.
      expect(error.input).toBe(bad);
    }
  });

  it("exposes exactly the contract's target fields — nothing that could be a provider object", () => {
    // Invariant 15: the target is a LineId and a Version; the exact key
    // list is the assertion, as with the line's field list in line.test.ts.
    const channel = Channel.of("stable", target("1.x", "1.9.0"));

    expect(Object.keys(channel)).toEqual(["id", "target"]);
    expect(Object.keys(channel.target as object)).toEqual(["line", "version"]);
  });
});

describe("repoint — a move is a new value; history is not stored here (PR-04)", () => {
  it("returns a new value and never edits the receiver", () => {
    const hidden = Channel.create("stable");
    const moved = hidden.repoint(target("1.x", "1.9.0"));

    expect(moved).not.toBe(hidden);
    expect(moved.target?.line).toBe("1.x");
    expect(hidden.target).toBeNull();
  });

  it("hides with repoint(null) — PR-05: a retraction removes future membership, never history", () => {
    const pointed = Channel.of("stable", target("1.x", "1.2.0"));
    const hidden = pointed.repoint(null);

    expect(hidden.target).toBeNull();
    expect(hidden.id).toBe("stable");
  });

  it("makes a rollback indistinguishable from any other move at this layer", () => {
    // PR-04: repointing back to a prior target is the same value-level
    // operation as any move — the audit lives above, so the value equals
    // the one that pointed there all along.
    const initial = Channel.of("stable", target("1.x", "1.2.0"));
    const rolled = initial.repoint(target("1.x", "1.1.9")).repoint(target("1.x", "1.2.0"));

    expect(rolled.equals(initial)).toBe(true);
    expect(rolled).not.toBe(initial);
  });

  it("validates the incoming target exactly like the doors", () => {
    const channel = Channel.create("stable");

    expect(() => channel.repoint(42 as unknown as ChannelTarget)).toThrow(InvalidChannelError);
    expect(() => channel.repoint({ line: " " } as unknown as ChannelTarget)).toThrow(
      InvalidChannelError,
    );
    expect(channel.target).toBeNull();
  });

  it("leaves the receiver untouched across repeated calls — call twice, deep-equal", () => {
    const channel = Channel.of("stable", target("1.x", "1.9.0"));
    const snapshot = Channel.of("stable", target("1.x", "1.9.0"));

    channel.repoint(target("1.x", "1.9.1"));
    channel.repoint(target("2.x", "2.0.0"));
    channel.repoint(null);

    expect(channel.equals(snapshot)).toBe(true);
    expect(channel.target?.version.toString()).toBe("1.9.0");
  });
});

describe("pointsAt — identity by value, the PR-05 query", () => {
  it("answers true for the pointed line and an equal Version instance", () => {
    const channel = Channel.of("stable", target("1.x", "1.9.0"));

    // A distinct instance that is the same version: the query is by value.
    expect(channel.pointsAt("1.x", v("1.9.0"))).toBe(true);
  });

  it("answers false for a different line", () => {
    const channel = Channel.of("stable", target("1.x", "1.9.0"));

    expect(channel.pointsAt("2.x", v("1.9.0"))).toBe(false);
  });

  it("answers false for a different version — build metadata included", () => {
    const channel = Channel.of("stable", target("1.x", "1.9.0"));

    expect(channel.pointsAt("1.x", v("1.9.1"))).toBe(false);
    expect(channel.pointsAt("1.x", v("1.9.0+a"))).toBe(false);
  });

  it("answers false for everything when hidden — a hidden channel points at nothing", () => {
    const hidden = Channel.create("stable");

    expect(hidden.pointsAt("1.x", v("1.9.0"))).toBe(false);
  });
});

describe("equality — structural over the id and the target", () => {
  it("equals an identically-constructed channel", () => {
    const mine = Channel.of("stable", target("1.x", "1.9.0"));
    const yours = Channel.of("stable", target("1.x", "1.9.0"));

    expect(mine).not.toBe(yours);
    expect(mine.equals(yours)).toBe(true);
  });

  it("distinguishes ids", () => {
    expect(Channel.create("stable").equals(Channel.create("next"))).toBe(false);
  });

  it("distinguishes pointed from hidden, both directions", () => {
    const hidden = Channel.create("stable");
    const pointed = Channel.of("stable", target("1.x", "1.9.0"));

    expect(hidden.equals(pointed)).toBe(false);
    expect(pointed.equals(hidden)).toBe(false);
  });

  it("distinguishes the target's line and version", () => {
    const base = Channel.of("stable", target("1.x", "1.9.0"));

    expect(base.equals(Channel.of("stable", target("2.x", "1.9.0")))).toBe(false);
    expect(base.equals(Channel.of("stable", target("1.x", "1.9.1")))).toBe(false);
    expect(base.equals(Channel.of("stable", target("1.x", "1.9.0+a")))).toBe(false);
  });

  it("compares hidden channels by id alone", () => {
    expect(Channel.create("stable").equals(Channel.create("stable"))).toBe(true);
  });
});

describe("freeze discipline — the binding is deeply immutable", () => {
  it("freezes the instance and the target record", () => {
    const channel = Channel.of("stable", target("1.x", "1.9.0"));

    expect(Object.isFrozen(channel)).toBe(true);
    expect(Object.isFrozen(channel.target)).toBe(true);
  });

  it("refuses mutation through the target record", () => {
    const channel = Channel.of("stable", target("1.x", "1.9.0"));
    const record = channel.target as { line: string };

    expect(() => {
      record.line = "2.x";
    }).toThrow(TypeError);
    expect(record.line).toBe("1.x");
  });

  it("refuses direct field assignment on the frozen instance", () => {
    const channel = Channel.of("stable", target("1.x", "1.9.0"));

    expect(() => {
      (channel as { id: string }).id = "next";
    }).toThrow(TypeError);
    expect(channel.id).toBe("stable");
  });

  it("does not alias the caller's target object — the value owns its frozen copy", () => {
    const handed = target("1.x", "1.9.0");
    const channel = Channel.of("stable", handed);

    expect(channel.target).not.toBe(handed);
    (handed as { line: string }).line = "mutated-after";
    expect(channel.target?.line).toBe("1.x");
  });
});
