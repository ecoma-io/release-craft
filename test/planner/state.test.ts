/**
 * §2.13 line-state rebuild (`state.ts`) — black-box tests over the observable
 * `LineState`: the released pointer as the line's highest admissible version
 * by kernel precedence (a
 * prerelease may hold it — M-08's first-ever `2.4.0-rc.1`), `stableBase` as
 * the highest released version with no prerelease suffix (D17(2)'s P-04/P-05
 * in-flight-target rule recomputes against it), and the stream keys
 * composition shape (`1.2.0-rc.3` → key `(1.2.0, rc)` at sequence 3; two
 * streams under one target — P-06). State is rebuilt from tags per run and
 * never carried (invariant 6); identical histories rebuild identical state
 * (invariant 2). Fixtures are self-contained `LineHistory` values in the
 * loader's ascending order; assertions never touch implementation internals.
 */
import { describe, expect, it } from "vitest";

import { Version } from "@ecoma-io/release-craft/domain";

import { rebuildLineState } from "../../src/planner/state.js";
import type { AdmissibleTag, LineHistory, LineState } from "../../src/planner/types.js";

/** A tag in the loader's shape: the parsed version is the observation's name. */
function tag(version: string): AdmissibleTag {
  // The kernel's parse door keeps the fixture honest: an invalid fixture
  // version fails here, not inside the unit under test.
  const parsed = Version.parse(version);
  return { name: version, commit: `commit-for-${version}`, version: parsed };
}

function historyOf(tags: readonly string[]): LineHistory {
  const observed = tags.map((version) => tag(version));
  return { lineId: "main", tags: observed, foreign: [] };
}

/** The observable stream-key view: bare target, identifier, sequence. */
function streamTuples(state: LineState): [string, string, number][] {
  const tuples: [string, string, number][] = [];
  for (const key of state.streams) {
    tuples.push([key.target.toString(), key.identifier, key.sequence]);
  }
  return tuples;
}

describe("rebuildLineState — §2.13 pointer and stream keys", () => {
  it("rebuilds the pointer from the highest version, a prerelease holding it (M-08)", () => {
    const state = rebuildLineState(historyOf(["2.3.0", "2.4.0-rc.1"]));

    expect(state.pointer?.toString()).toBe("2.4.0-rc.1");
    // D17(2)'s base: the released stable 2.3.0 survives under the rc pointer.
    expect(state.stableBase?.toString()).toBe("2.3.0");
  });

  it("rebuilds an empty history as a line birth: null pointer, no streams", () => {
    const state = rebuildLineState(historyOf([]));

    expect(state.pointer).toBeNull();
    expect(state.stableBase).toBeNull();
    expect(state.streams).toHaveLength(0);
  });

  it("reconstructs one stream key from a composing tag: 1.2.0-rc.3 is (1.2.0, rc) at 3", () => {
    const state = rebuildLineState(historyOf(["1.2.0-rc.3"]));

    expect(state.pointer?.toString()).toBe("1.2.0-rc.3");
    expect(streamTuples(state)).toStrictEqual([["1.2.0", "rc", 3]]);
  });

  it("keeps the highest sequence per key when several tags share it", () => {
    const state = rebuildLineState(historyOf(["1.2.0-rc.1", "1.2.0-rc.3"]));

    expect(streamTuples(state)).toStrictEqual([["1.2.0", "rc", 3]]);
    expect(state.pointer?.toString()).toBe("1.2.0-rc.3");
  });

  it("rebuilds two streams under one target as sibling keys (P-06)", () => {
    const state = rebuildLineState(historyOf(["1.2.0-alpha.4", "1.2.0-rc.1"]));

    expect(streamTuples(state)).toStrictEqual([
      ["1.2.0", "alpha", 4],
      ["1.2.0", "rc", 1],
    ]);
    expect(state.pointer?.toString()).toBe("1.2.0-rc.1");
  });

  it("counts a build-only tag for the pointer while it composes no stream", () => {
    const state = rebuildLineState(historyOf(["1.1.0", "1.2.0+build.7"]));

    expect(state.pointer?.toString()).toBe("1.2.0+build.7");
    // Build metadata is not a prerelease suffix: the tag counts for the
    // stable namespace too (D17(2)'s base rule reads the suffix, not build).
    expect(state.stableBase?.toString()).toBe("1.2.0+build.7");
    expect(state.streams).toHaveLength(0);
  });

  it("rebuilds the stream key from a composing prerelease even when the tag carries build", () => {
    // The prerelease part of `1.2.0-rc.3+build.5` is the kernel's composition
    // `[rc, 3]`; the build identifiers never compose a key of their own and
    // never move the sequence — they compare as 0.
    const state = rebuildLineState(historyOf(["1.2.0-rc.3+build.5"]));

    expect(streamTuples(state)).toStrictEqual([["1.2.0", "rc", 3]]);
    expect(state.pointer?.toString()).toBe("1.2.0-rc.3+build.5");
  });

  it("orders keys by target precedence then identifier ASCII, pinned", () => {
    const state = rebuildLineState(
      historyOf(["1.0.0-alpha.9", "1.0.0-rc.2", "2.0.0-rc.1", "3.0.0-beta.1"]),
    );

    expect(streamTuples(state)).toStrictEqual([
      ["1.0.0", "alpha", 9],
      ["1.0.0", "rc", 2],
      ["2.0.0", "rc", 1],
      ["3.0.0", "beta", 1],
    ]);
  });

  it("skips non-composing prerelease suffixes for streams while the pointer still counts them", () => {
    // KNOWN PHASE-2 LIMIT (reported): an admissible tag whose prerelease does
    // not match the kernel's `target-identifier.sequence` composition has no
    // surface in the frozen LineState — it rebuilds no stream key and is not
    // reported as foreign anywhere else. Surfacing it needs a LineState shape
    // revision; the rebuild conservatively counts the version for the pointer
    // only.
    const state = rebuildLineState(historyOf(["1.4.0-one.two", "1.5.0-alpha"]));

    expect(state.pointer?.toString()).toBe("1.5.0-alpha");
    expect(state.streams).toHaveLength(0);
  });

  it("breaks a precedence tie by keeping the first tag in the history's order", () => {
    // Build metadata compares as 0, so these two are precedence-equal; the
    // first in the loader's ascending order wins, deterministically.
    const state = rebuildLineState(historyOf(["2.0.0", "2.0.0+build.1"]));

    expect(state.pointer?.toString()).toBe("2.0.0");
    // The identical tie rule governs stableBase: the first of the
    // precedence-equal stables wins.
    expect(state.stableBase?.toString()).toBe("2.0.0");
    expect(state.streams).toHaveLength(0);
  });
});

describe("rebuildLineState — stableBase, D17(2)'s in-flight-target base", () => {
  it("keeps the highest released stable under a prerelease pointer (P-04's base)", () => {
    const state = rebuildLineState(historyOf(["1.0.0", "1.1.0", "1.2.0-rc.1", "1.2.0-rc.2"]));

    expect(state.pointer?.toString()).toBe("1.2.0-rc.2");
    expect(state.stableBase?.toString()).toBe("1.1.0");
  });

  it("stays null when the history carries no stable release (P-01's alpha-only line)", () => {
    const state = rebuildLineState(historyOf(["1.2.0-alpha.9"]));

    expect(state.pointer?.toString()).toBe("1.2.0-alpha.9");
    expect(state.stableBase).toBeNull();
  });

  it("follows the stable namespace, not the pointer: a heavier prerelease leaves it put", () => {
    const state = rebuildLineState(historyOf(["0.3.2", "0.4.0-rc.1"]));

    expect(state.pointer?.toString()).toBe("0.4.0-rc.1");
    expect(state.stableBase?.toString()).toBe("0.3.2");
  });

  it("tracks a promotion tag the moment it lands — rc then its pointed-at release", () => {
    const state = rebuildLineState(historyOf(["1.2.0-rc.2", "1.2.0"]));

    expect(state.pointer?.toString()).toBe("1.2.0");
    expect(state.stableBase?.toString()).toBe("1.2.0");
  });
});
