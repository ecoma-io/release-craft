/**
 * The Release-PR gate's durable record sink (issue #288) — the git-backed
 * persistence of the write-ahead records: one compare-and-swap commit per
 * record on a ref per (identity, plan) sequence, the ledger's own
 * contract §2.2 mapping applied to the gate's records. The suite pins:
 * the roundtrip through a fresh binding (a crash window's reload), the
 * tip-relative absorb of a byte-identical re-append, forward-only
 * extension, the content-addressed distinct streams, and the fail-closed
 * compare-and-swap race.
 *
 * The suite lives beside the driver's, in the package shell's test row:
 * its subject is a shell module (the app barrel's surface is closed to
 * stores — obligation 2), and it names the stream refs itself by
 * replicating the sink's module-private derivation from the two public
 * primitives it composes — the same shape a hostile test needs to race
 * the ref.
 */
import { describe, expect, it } from "vitest";

import { canonicalJson } from "@ecoma-io/release-craft/planner";
import {
  encodeRefComponent,
  GitFaultError,
  commitRecord,
  firstParentHistory,
  type GitRun,
} from "@ecoma-io/release-craft/adapters/git";
import {
  GitReleasePRRecordSink,
  type ReleasePRRecord,
  type ReleasePRIdentity,
} from "../src/index.js";

import { withTempRepo } from "./adapters/git/temp-repo.js";

const identity: ReleasePRIdentity = {
  component: "lib-a",
  releaseLine: "lib-a",
  targetBranch: "main",
};

/** One minimal gate-start record; distinct calls return distinct
 * instances so a frozen returned value never leaks across records. */
const start = (planId: string, fingerprint = "content_sha256:render"): ReleasePRRecord => ({
  kind: "gate-start",
  action: "create",
  identity,
  planId,
  contentFingerprint: fingerprint,
});

const outcome = (planId: string, fingerprint = "content_sha256:render"): ReleasePRRecord => ({
  kind: "gate-outcome",
  action: "create",
  identity,
  planId,
  outcome: { kind: "nothing-pending" },
  contentFingerprint: fingerprint,
});

/** The (identity, plan) stream's ref — the sink's own module-private
 * derivation, replicated here so the suite can name the stream it races
 * and walks. */
const ref = (streamIdentity: ReleasePRIdentity, planId: string): string =>
  `refs/release-craft/release-pr/${encodeRefComponent(
    canonicalJson({ identity: streamIdentity, planId }),
  )}`;

describe("GitReleasePRRecordSink", () => {
  it("appends deep-frozen records and a fresh binding re-reads the same tail", () => {
    withTempRepo("release-pr-sink-roundtrip", (repo) => {
      const first = new GitReleasePRRecordSink(repo);
      const record = start("p1");
      expect(first.append(record)).toBe(record);
      expect(Object.isFrozen(record)).toBe(true);

      const fresh = new GitReleasePRRecordSink(repo);
      const tail = fresh.tail(identity, "p1");
      expect(canonicalJson(tail)).toEqual(canonicalJson([record]));
      expect(Object.isFrozen(tail[0])).toBe(true);
    });
  });

  it("a fresh binding's append extends the stream — forward-only (A then B)", () => {
    withTempRepo("release-pr-sink-forward", (repo) => {
      const a = start("p1");
      const b = outcome("p1");
      new GitReleasePRRecordSink(repo).append(a);
      const fresh = new GitReleasePRRecordSink(repo);
      fresh.append(b);
      expect(canonicalJson(fresh.tail(identity, "p1"))).toEqual(canonicalJson([a, b]));
      expect(fresh.tail(identity, "p1")[1]).toStrictEqual(b);
    });
  });

  it("a byte-identical re-append is absorbed — the stream stays one commit", () => {
    withTempRepo("release-pr-sink-absorb", (repo, git) => {
      const a = start("p1");
      new GitReleasePRRecordSink(repo).append(a);
      const again = new GitReleasePRRecordSink(repo);
      again.append(a);
      expect(again.tail(identity, "p1")).toHaveLength(1);
      expect(firstParentHistory(git, ref(identity, "p1"))).toHaveLength(1);
    });
  });

  it("a record differing in any field is a different fact and lands", () => {
    withTempRepo("release-pr-sink-differing", (repo) => {
      const sink = new GitReleasePRRecordSink(repo);
      sink.append(start("p1"));
      sink.append(start("p1", "content_sha256:other"));
      expect(sink.tail(identity, "p1")).toHaveLength(2);
      expect(sink.tail(identity, "p1")[1]).toMatchObject({
        kind: "gate-start",
        planId: "p1",
        contentFingerprint: "content_sha256:other",
      });
    });
  });

  it("distinct (identity, plan) tuples name distinct streams", () => {
    withTempRepo("release-pr-sink-streams", (repo, git) => {
      const other: ReleasePRIdentity = {
        component: "lib-b",
        releaseLine: "lib-b",
        targetBranch: "main",
      };
      const sink = new GitReleasePRRecordSink(repo);
      sink.append(start("p1"));
      sink.append({ ...start("p1"), identity: other });
      sink.append(start("p2"));

      expect(ref(identity, "p1")).not.toBe(ref(other, "p1"));
      expect(ref(identity, "p1")).not.toBe(ref(identity, "p2"));
      for (const [streamIdentity, planId] of [
        [identity, "p1"],
        [other, "p1"],
        [identity, "p2"],
      ] as const) {
        expect(firstParentHistory(git, ref(streamIdentity, planId))).toHaveLength(1);
      }
    });
  });

  it("a lost compare-and-swap race fails closed — nothing of the loser lands", () => {
    withTempRepo("release-pr-sink-cas", (repo, git) => {
      const stream = ref(identity, "p1");
      const peer = new GitReleasePRRecordSink(repo);
      // A concurrent writer keeps winning the stream's ref: every
      // compare-and-swap the racing sink attempts finds the tip moved, so
      // its append is no longer an extension of the recorded history. The
      // wrapper diverges the ref under the loser's update exactly as a
      // concurrent winner would — deterministically, one distinct record
      // per round until the budget is spent.
      const rounds = [
        "content_sha256:peer-1",
        "content_sha256:peer-2",
        "content_sha256:peer-3",
      ] as const;
      let round = 0;
      const diverge = (): void => {
        const fingerprint = rounds[round];
        if (fingerprint === undefined) throw new Error("the divergence exhausted its records");
        peer.append({ ...start("p1"), contentFingerprint: fingerprint });
        round += 1;
      };
      const hostile: GitRun = (args, input) => {
        if (args[0] === "update-ref" && args[1] === stream) {
          diverge();
        }
        return git(args, input);
      };

      const racing = new GitReleasePRRecordSink(repo, hostile);
      const refused = start("p1");
      expect(() => racing.append(refused)).toThrow(GitFaultError);

      // Nothing the refused door wrote is on the ref: the history is
      // exactly the concurrent winner's own records — readable by a fresh
      // binding, byte-identical where it was written.
      const history = firstParentHistory(git, stream);
      const onRef = history.map((commit) => commitRecord(git, commit));
      expect(onRef).toHaveLength(3);
      expect(onRef).not.toContain(canonicalJson(refused));
      const witness = new GitReleasePRRecordSink(repo);
      expect(canonicalJson(witness.tail(identity, "p1"))).toEqual(
        canonicalJson([
          { ...start("p1"), contentFingerprint: rounds[0] },
          { ...start("p1"), contentFingerprint: rounds[1] },
          { ...start("p1"), contentFingerprint: rounds[2] },
        ]),
      );
    });
  });
});
