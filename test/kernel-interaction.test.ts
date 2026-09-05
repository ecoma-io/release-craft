import { describe, expect, it } from "vitest";
import {
  Artifact,
  Change,
  ChangeSet,
  Channel,
  InvalidChangeSetError,
  InvalidLineTransitionError,
  ReleaseLine,
  Version,
} from "../src/index.ts";

/**
 * The ensemble suite — the PL-01-shaped flow the contract's "Interaction"
 * obligation names, expressed purely in kernel values: a release line with
 * streams and a released pointer, a channel re-pointed onto it, artifact
 * records bound by digest, and the change set a release instantiates. No
 * planner exists yet (Phase 2); this suite proves the values compose into
 * the planner's future input alphabet without any of them reaching for
 * more than value semantics.
 *
 * The frame is PL-01's monorepo — one package changed, one package
 * released — with the anchors cited where each fact lands: PL-01 (lib-a
 * moves, app does not), PL-06 (app's empty change set is a result),
 * P-01/P-04 (rc sequence arithmetic), P-03 (a change set may be
 * inherited), M-03 (one identity is one member), PR-01/PR-02 (promotion
 * and rebuild over digests), AR-03 (coordinates are labels), PR-04
 * (a channel move is a new value).
 */

/** The version helper — one parse per literal keeps the fixtures honest. */
function v(spec: string): Version {
  return Version.parse(spec);
}

describe("the ensemble — one package's release, end to end, in values", () => {
  it("takes lib-a from a released 1.2.0 through an rc stream to a released 1.2.1", () => {
    const line = ReleaseLine.create("lib-a").withReleased(v("1.2.0"));

    // Stabilization toward 1.2.1: the stream is state on the line
    // (invariant 8), advanced by value semantics — P-04's mid-RC sequence
    // bump, P-01's numeric arithmetic.
    const rc0 = line.advanceStream(v("1.2.1"), "rc");
    const rc1 = rc0.advanceStream(v("1.2.1"), "rc");

    expect(rc0.streamVersion(v("1.2.1"), "rc")?.toString()).toBe("1.2.1-rc.0");
    expect(rc1.streamVersion(v("1.2.1"), "rc")?.toString()).toBe("1.2.1-rc.1");

    // The release moves the pointer, monotonic per line; the stream state
    // survives it as recorded state — the value keeps both facts.
    const released = rc1.withReleased(v("1.2.1"));

    expect(released.released?.toString()).toBe("1.2.1");
    expect(released.lifecycle).toBe("active");
    expect(released.streamVersion(v("1.2.1"), "rc")?.toString()).toBe("1.2.1-rc.1");
    // Re-releasing 1.2.1 on this line stays refused (M-11/E-11).
    expect(() => released.withReleased(v("1.2.1"))).toThrow(InvalidLineTransitionError);
  });

  it("instantiates the same frozen change set at rc.1 and at the release — P-03", () => {
    // PL-01: the commit `fix(lib-a): guard empty config` is one change on
    // lib-a's line; the group it implies is decided upstream and recorded
    // verbatim.
    const fix = Change.of("chg:guard-empty-config", {
      originCommit: "9f2c4a1e",
      originLine: "lib-a",
    });
    const set = ChangeSet.of([fix], "patch");

    // The frozen group feeds the rc publication and the release: inherited,
    // never rebuilt, never mutated (P-03). Inheritance is value identity —
    // an independently constructed group with the same members and bump is
    // the same group, never the same object.
    const atRelease = ChangeSet.of(
      [Change.of("chg:guard-empty-config", { originCommit: "9f2c4a1e", originLine: "lib-a" })],
      "patch",
    );

    expect(atRelease.equals(set)).toBe(true);
    expect(atRelease).not.toBe(set);
    expect(atRelease.bump).toBe("patch");
    expect(atRelease.includesIdentity("chg:guard-empty-config")).toBe(true);

    // M-03 made structural: the fix cannot enter the group twice, whatever
    // lineage the second copy carries.
    expect(() =>
      ChangeSet.of([fix, Change.of("chg:guard-empty-config", { originLine: "app" })], "patch"),
    ).toThrow(InvalidChangeSetError);
  });

  it("re-points the stable channel onto the release — a move is a new value (PR-04)", () => {
    const line = ReleaseLine.create("lib-a").withReleased(v("1.2.0")).withReleased(v("1.2.1"));

    // The channel starts hidden — it exists before its first binding (S-02),
    // the same state a retraction returns it to (PR-05) — then binds to the
    // released pair by
    // value; the earlier binding — 1.2.0, never pointed at here — is not
    // pointed at now, because the value carries the current binding only.
    const stable = Channel.create("stable")
      .repoint({ line: "lib-a", version: v("1.2.0") })
      .repoint({ line: "lib-a", version: line.released as Version });

    expect(stable.pointsAt("lib-a", v("1.2.1"))).toBe(true);
    expect(stable.pointsAt("lib-a", v("1.2.0"))).toBe(false);
    expect(stable.pointsAt("app", v("1.2.1"))).toBe(false);
  });

  it("binds the release's artifacts by digest — same bytes across coordinates (PR-01/AR-03)", () => {
    const digest = "sha256:9f2c4a1e";

    // AR-01's artifact set for lib-a 1.2.1: the npm tarball and the
    // container image, one digest if the bytes are one build.
    const tarball = Artifact.of("npm", "@ex/lib-a@1.2.1", digest);
    const image = Artifact.of("container", "ghcr.io/x/lib-a:1.2.1", digest);

    // PR-01: promoting the rc build without rebuild is pointing at the
    // same digest whatever the coordinates say; AR-03: the container
    // coordinate is a label, never a version to compare.
    expect(tarball.sameContent(image)).toBe(true);
    expect(tarball.equals(image)).toBe(false);

    // PR-02: a deliberate rebuild under the same version name is new
    // content — a new generation recorded execution-side over digest
    // records; the kernel values say exactly "different content".
    const rebuilt = Artifact.of("npm", "@ex/lib-a@1.2.1", "sha256:77aabb");
    expect(rebuilt.sameContent(tarball)).toBe(false);
    expect(rebuilt.equals(tarball)).toBe(false);
  });

  it("leaves app untouched — PL-01's other half, PL-06's empty result", () => {
    // PL-01: exactly lib-a's version moves. App released nothing: its line
    // still equals its construction, and no channel points at it.
    const app = ReleaseLine.create("app").withReleased(v("2.0.0"));
    const next = Channel.create("next"); // app's channel, never moved

    const libA = ReleaseLine.create("lib-a").withReleased(v("1.2.0")).withReleased(v("1.2.1"));
    const stable = Channel.create("stable").repoint({
      line: "lib-a",
      version: libA.released as Version,
    });

    // App's decision is a recorded empty group (PL-06), not an absence. The
    // empty group's `"patch"` is the neutral element of Bump.max — the least
    // level; what an empty result implies is the planner's decision to make,
    // and no version is ever minted from here (S-01).
    const nothingDue = ChangeSet.empty();

    expect(nothingDue.bump).toBe("patch");
    expect(nothingDue.changes).toEqual([]);
    expect(nothingDue.includesIdentity("chg:guard-empty-config")).toBe(false);

    expect(stable.pointsAt("app", v("2.0.0"))).toBe(false);
    expect(next.pointsAt("app", v("2.0.0"))).toBe(false);
    expect(app.equals(ReleaseLine.create("app").withReleased(v("2.0.0")))).toBe(true);
    expect(app.streams).toEqual([]);
  });

  it("is pure throughout — no value in the chain mutated its receiver", () => {
    // Re-derive the whole ensemble from scratch; every earlier value must
    // deep-equal its re-derivation, which is only possible if no step
    // edited a prior value in place.
    const derive = () => {
      const line = ReleaseLine.create("lib-a").withReleased(v("1.2.0"));
      const rc1 = line.advanceStream(v("1.2.1"), "rc").advanceStream(v("1.2.1"), "rc");
      const released = rc1.withReleased(v("1.2.1"));
      const stable = Channel.create("stable").repoint({ line: "lib-a", version: v("1.2.1") });
      const artifacts = [
        Artifact.of("npm", "@ex/lib-a@1.2.1", "sha256:9f2c4a1e"),
        Artifact.of("container", "ghcr.io/x/lib-a:1.2.1", "sha256:9f2c4a1e"),
      ];
      return { line, rc1, released, stable, artifacts };
    };

    const first = derive();
    const second = derive();

    // The values compose and re-compose identically — the determinism a
    // pure planner (invariant 2) will need from this alphabet.
    expect(first.line.equals(second.line)).toBe(true);
    expect(first.rc1.equals(second.rc1)).toBe(true);
    expect(first.released.equals(second.released)).toBe(true);
    expect(first.stable.equals(second.stable)).toBe(true);
    expect(first.artifacts[0]?.equals(second.artifacts[0] as Artifact)).toBe(true);

    // And the frozen discipline held everywhere along the way.
    for (const value of [first.line, first.rc1, first.released, first.stable, ...first.artifacts]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });
});
