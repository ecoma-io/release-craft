import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  CLAIM_REF_NAMESPACE,
  claimRegisterRefFor,
  commitRecord,
  type ClaimRecord,
  GitClaimStore,
  GitFaultError,
  hermeticGitEnv,
  openGitRun,
  readRef,
  readRegister,
  type GitRun,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import {
  type Claim,
  type ClaimDenied,
  type ClaimScope,
  type ClaimStore,
  type ClaimVerification,
  canonicalJson,
  MemoryClaimStore,
} from "../../../src/index.js";
import { createTempRepo, withTempRepo } from "./temp-repo.js";

/**
 * The per-line claim register (ADR-0011) — the pins its Consequences name:
 * the deterministic concurrency suite (two writers one move at a time,
 * through a hostile `git` on PATH that diverges the register between a
 * loser's evaluation and its CAS — at the CAS itself, and at the read the
 * CAS bases on, pinning the single-read base — so the loser re-evaluates
 * against the diverged tip and lands or denies, never both-accept, never a
 * stale adjudication), the release-by-token pin, the crash window, the
 * loud foreign-blob and non-canonical refusals, the #69 denial parity, the
 * dual-backend scenario list run over both stores, and the decision 2
 * scope boundary (#182): the exclusion is one shared ref space, pinned as
 * a negative capability test — two clones of one repository acquire the
 * same line's claim independently.
 */

const stableVersion = (version: string, lineId = "line-main"): ClaimScope => ({
  kind: "stable-version",
  lineId,
  version,
});

const prerelease = (sequence: number, lineId = "line-main"): ClaimScope => ({
  kind: "prerelease-sequence",
  lineId,
  target: "1.3.0-rc",
  streamId: "rc",
  sequence,
});

const releaseLine = (lineId = "line-main"): ClaimScope => ({ kind: "release-line", lineId });

const asClaim = (outcome: Claim | ClaimDenied): Claim => {
  if (outcome.kind !== "claim") {
    throw new Error(`expected a claim, got a denial by ${String(outcome.holder)}`);
  }
  return outcome;
};

const asDenied = (outcome: Claim | ClaimDenied): ClaimDenied => {
  if (outcome.kind !== "denied") {
    throw new Error("expected a denial");
  }
  return outcome;
};

const registerBlob = (git: GitRun, lineId: string): string =>
  commitRecord(git, readRef(git, claimRegisterRefFor(lineId)) ?? "");

/** A claim record's stored JSON — `kind` inclusive, the canonical form. */
const recordJson = (record: ClaimRecord): string =>
  canonicalJson({ kind: "claim", scope: record.scope, token: record.token, holder: record.holder });

/** The canonical register envelope a fixture writer lands by hand. */
const envelope = (records: readonly ClaimRecord[]): string =>
  `{"claims":[${records.map(recordJson).join(",")}]}`;

/** The definite outcome of a hostile-window move, once the window closed. */
const outcome = (settled: Claim | ClaimDenied | undefined): Claim | ClaimDenied => {
  if (settled === undefined) {
    throw new Error("the hostile window produced no outcome");
  }
  return settled;
};

/**
 * The hostile `git`: a PATH shim that intercepts one step of the store's
 * claim cycle and, before delegating, makes one divergent move of its own
 * — the concurrent writer's landing — or dies mid-write (the crash
 * window). Two interception points, the two windows the store's discipline
 * must close: the compare-and-set itself (`update-ref` on the register
 * ref — the window git's own old-value check arbitrates; the loser loses
 * the CAS and re-evaluates), and the Nth post-arm read of the register ref
 * (`fireOnRead`) — the read-to-CAS window, where a writer's landing must
 * be either seen by the mutation's read or caught by the old-value check,
 * never passed over.
 */
interface Shim {
  readonly dir: string;
  /** Arms the trap: the intercepted step is watched from here on. Setup
   *  moves before `arm()` pass through untouched. */
  arm(): void;
  /** Whether the trap fired — the divergent move landed (or the crash
   *  happened). False means the intercepted condition never occurred,
   *  which is itself an observation: the watched window does not exist. */
  fired(): boolean;
  cleanup(): void;
}

const buildShim = (spec: {
  readonly registerRef: string;
  /** The register blob the concurrent writer lands, when diverging. */
  readonly payload?: string;
  readonly mode: "diverge" | "crash";
  /** Fire on the Nth post-arm `rev-parse` of the register ref instead of
   *  the compare-and-set. */
  readonly fireOnRead?: number;
}): Shim => {
  const dir = mkdtempSync(join(tmpdir(), "release-craft-git-hostile-"));
  const found = spawnSync("which", ["git"], { encoding: "utf8" });
  const real = found.stdout.trim();
  if (real === "") {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`the fixture needs a real git to delegate to: ${found.stderr}`);
  }
  const armed = join(dir, "armed");
  const flag = join(dir, "fired");
  const counter = join(dir, "reads");
  const payload = join(dir, "payload.json");
  if (spec.payload !== undefined) {
    writeFileSync(payload, spec.payload);
  }
  const diverge =
    spec.mode === "diverge" && spec.payload !== undefined
      ? [
          `BLOB=$(cat "${payload}" | "${real}" hash-object -w --stdin)`,
          `TREE=$(printf '100644 blob %s\\trecord\\n' "$BLOB" | "${real}" mktree)`,
          `COMMIT=$("${real}" commit-tree "$TREE" -m "release-craft: append")`,
          `"${real}" update-ref "${spec.registerRef}" "$COMMIT" || exit 1`,
        ].join("\n")
      : "kill -9 $$";
  // The `rev-parse` argv is `rev-parse --verify --quiet <ref>`: the ref is
  // `$4`. Each watched read counts; the Nth fires. The delegation keeps
  // the original arguments, so the read returns whatever the ref now
  // holds — the diverged tip when the move landed first.
  const intercept =
    spec.fireOnRead === undefined
      ? [
          `if [ "$1" = "update-ref" ] && [ "$2" = "${spec.registerRef}" ] && [ -e "${armed}" ] && [ ! -e "${flag}" ]; then`,
          `  touch "${flag}"`,
          diverge,
          "fi",
        ]
      : [
          `if [ "$1" = "rev-parse" ] && [ "$4" = "${spec.registerRef}" ] && [ -e "${armed}" ] && [ ! -e "${flag}" ]; then`,
          `  N=$(cat "${counter}" 2>/dev/null || echo 0)`,
          `  N=$((N+1))`,
          `  echo "$N" > "${counter}"`,
          `  if [ "$N" -ge ${String(spec.fireOnRead)} ]; then`,
          `    touch "${flag}"`,
          diverge
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n"),
          "  fi",
          "fi",
        ];
  const script = ["#!/bin/sh", ...intercept, `exec "${real}" "$@"`, ""].join("\n");
  const shim = join(dir, "git");
  writeFileSync(shim, script);
  chmodSync(shim, 0o755);
  return {
    dir,
    arm: () => {
      writeFileSync(armed, "");
    },
    fired: () => existsSync(flag),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

/** Runs `fn` with the shim first on PATH — every `git` the store spawns in
 *  there resolves through it. Restored whether `fn` passes or fails. */
const withHostilePath = (dir: string, fn: () => void): void => {
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous ?? ""}`;
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previous;
    }
  }
};

describe("the per-line claim register (ADR-0011)", () => {
  describe("the deterministic concurrency suite", () => {
    it("the exclusion race: the loser re-evaluates against the diverged register and denies (#47)", () => {
      withTempRepo("register-race-exclusion", (repo, git) => {
        // Writer B (release-line on the shared line) lands between A's
        // evaluation of the empty register and A's compare-and-set.
        const writerB: ClaimRecord = {
          scope: releaseLine(),
          token: "b".repeat(64),
          holder: "attempt_b",
        };
        const shim = buildShim({
          registerRef: claimRegisterRefFor("line-main"),
          payload: envelope([writerB]),
          mode: "diverge",
        });
        try {
          let settled: Claim | ClaimDenied | undefined;
          withHostilePath(shim.dir, () => {
            shim.arm();
            settled = new GitClaimStore(repo).acquire(stableVersion("1.2.3"), "attempt_a");
          });
          // A evaluated an empty register, so the per-scope mapping would
          // have both-accepted here (#47's window). The register's CAS
          // lost, the re-read found B's record, and the exclusion law
          // denied — never both-accept, never a stale adjudication.
          const denial = asDenied(outcome(settled));
          expect(denial).toEqual({
            kind: "denied",
            scope: stableVersion("1.2.3"),
            holder: "attempt_b",
          });
          expect(Object.hasOwn(denial, "holderSequence")).toBe(false);
          expect(registerBlob(git, "line-main")).toBe(envelope([writerB]));
        } finally {
          shim.cleanup();
        }
      });
    });

    it("the same-scope race: the loser adjudicates the winner's landed record", () => {
      withTempRepo("register-race-same-scope", (repo, git) => {
        const writerB: ClaimRecord = {
          scope: stableVersion("1.2.3"),
          token: "b".repeat(64),
          holder: "attempt_b",
        };
        const shim = buildShim({
          registerRef: claimRegisterRefFor("line-main"),
          payload: envelope([writerB]),
          mode: "diverge",
        });
        try {
          let settled: Claim | ClaimDenied | undefined;
          withHostilePath(shim.dir, () => {
            shim.arm();
            settled = new GitClaimStore(repo).acquire(stableVersion("1.2.3"), "attempt_a");
          });
          expect(asDenied(outcome(settled))).toEqual({
            kind: "denied",
            scope: stableVersion("1.2.3"),
            holder: "attempt_b",
          });
          expect(registerBlob(git, "line-main")).toBe(envelope([writerB]));
        } finally {
          shim.cleanup();
        }
      });
    });

    it("the register's content and its CAS base come from one read — a writer landing inside the window is never passed over", () => {
      withTempRepo("register-single-read", (repo, git) => {
        // Writer B (release-line on the shared line) lands at the second
        // read of the register — strictly inside the read-to-CAS window.
        // A base read separately from the content would take B's landing
        // as its own base and pass the old-value check over a register A
        // never saw: B destroyed, both acquires answered (the lost update).
        const writerB: ClaimRecord = {
          scope: releaseLine(),
          token: "b".repeat(64),
          holder: "attempt_b",
        };
        const shim = buildShim({
          registerRef: claimRegisterRefFor("line-main"),
          payload: envelope([writerB]),
          mode: "diverge",
          fireOnRead: 2,
        });
        try {
          let settledMaybe: Claim | ClaimDenied | undefined;
          withHostilePath(shim.dir, () => {
            shim.arm();
            settledMaybe = new GitClaimStore(repo).acquire(stableVersion("1.2.3"), "attempt_a");
          });
          const settled = outcome(settledMaybe);
          // The two worlds the window admits, decided by whether the trap
          // fired. Fired — B's landing was intercepted inside it and must
          // have been caught by the old-value check: the loop re-read, the
          // exclusion law denied, and B's record is the register's whole
          // content. Not fired — the CAS based itself on a read the trap
          // never saw (one taken before the arm), B never landed, and A's
          // accept is the plain first write.
          const expectedOutcome: Claim | ClaimDenied = shim.fired()
            ? { kind: "denied", scope: stableVersion("1.2.3"), holder: "attempt_b" }
            : {
                kind: "claim",
                scope: stableVersion("1.2.3"),
                token: settled.kind === "claim" ? settled.token : "",
                holder: "attempt_a",
              };
          const expectedRecords: readonly ClaimRecord[] =
            settled.kind === "claim"
              ? [{ scope: settled.scope, token: settled.token, holder: settled.holder }]
              : [writerB];
          expect(settled).toEqual(expectedOutcome);
          expect(registerBlob(git, "line-main")).toBe(envelope(expectedRecords));
        } finally {
          shim.cleanup();
        }
      });
    });

    it("a release's stale read never clobbers a claim that landed inside its window", () => {
      withTempRepo("register-release-single-read", (repo, git) => {
        const scope = prerelease(7);
        // The late arrival: a coexisting claim that lands inside A's
        // release window. The release's stale set — read before it — does
        // not hold it, so a CAS based on a separate later read would wipe
        // it: a record removed that the release never observed.
        const lateArrival: ClaimRecord = {
          scope: stableVersion("1.2.3"),
          token: "c".repeat(64),
          holder: "attempt_c",
        };
        const shim = buildShim({
          registerRef: claimRegisterRefFor("line-main"),
          payload: envelope([lateArrival]),
          mode: "diverge",
          fireOnRead: 3,
        });
        try {
          let staleToken = "";
          withHostilePath(shim.dir, () => {
            // Setup runs disarmed: A's lease lands untouched. The release
            // then walks the registers (read 1), reads the line's register
            // (read 2), and bases its CAS on a further read (read 3) —
            // when the base is that third read, the window exists.
            const store = new GitClaimStore(repo);
            staleToken = asClaim(store.acquire(scope, "attempt_a")).token;
            shim.arm();
            store.release(staleToken);
          });
          const witness = new GitClaimStore(repo);
          // The two worlds the window admits. Fired — the arrival landed
          // inside it: the old-value check refused the stale CAS, the loop
          // re-read, and the removal landed on top of the arrival, by
          // token — the arrival still held. Not fired — the CAS based
          // itself on a read the trap never saw, the arrival never landed,
          // and the removal is the plain one: the register empties.
          const expectedArrival: ClaimVerification = shim.fired()
            ? {
                kind: "held",
                claim: {
                  kind: "claim",
                  scope: lateArrival.scope,
                  token: lateArrival.token,
                  holder: lateArrival.holder,
                },
              }
            : { kind: "lost" };
          expect(witness.verify(lateArrival.token)).toEqual(expectedArrival);
          // The stale lease is gone in either world — removed by token.
          expect(witness.verify(staleToken)).toEqual({ kind: "lost" });
          expect(registerBlob(git, "line-main")).toBe(
            shim.fired() ? envelope([lateArrival]) : '{"claims":[]}',
          );
        } finally {
          shim.cleanup();
        }
      });
    });

    it("a release racing the same scope's re-acquisition removes by token, never by scope", () => {
      withTempRepo("register-release-by-token", (repo, git) => {
        // A lease, not a record: a stable-version claim's release is a
        // no-op (ADR-0009 decision 4), so the race only exists for the
        // lease scopes.
        const scope = prerelease(7);
        // Writer B re-acquires the same scope — a new holder, a new
        // token — between A's release resolution and A's compare-and-set.
        const writerB: ClaimRecord = {
          scope,
          token: "b".repeat(64),
          holder: "attempt_b",
        };
        const shim = buildShim({
          registerRef: claimRegisterRefFor("line-main"),
          payload: envelope([writerB]),
          mode: "diverge",
        });
        try {
          let staleToken = "";
          withHostilePath(shim.dir, () => {
            // Setup runs disarmed: A's claim lands untouched.
            const store = new GitClaimStore(repo);
            staleToken = asClaim(store.acquire(scope, "attempt_a")).token;
            shim.arm();
            store.release(staleToken);
          });
          // A's release lost the CAS, the re-read found no stale token,
          // and it returned — B's record stands. A scope-keyed removal
          // would have deleted the new holder's claim here.
          const witness = new GitClaimStore(repo);
          expect(witness.verify(writerB.token)).toEqual({
            kind: "held",
            claim: { kind: "claim", scope, token: writerB.token, holder: "attempt_b" },
          });
          expect(witness.verify(staleToken)).toEqual({ kind: "lost" });
          expect(registerBlob(git, "line-main")).toBe(envelope([writerB]));
        } finally {
          shim.cleanup();
        }
      });
    });

    it("a release of one lease leaves the line's other claims untouched", () => {
      withTempRepo("register-release-scoped", (repo, git) => {
        const store = new GitClaimStore(repo);
        const lease = asClaim(store.acquire(prerelease(7), "attempt_a"));
        const other = asClaim(store.acquire(stableVersion("1.2.3"), "attempt_b"));
        store.release(lease.token);
        expect(store.verify(other.token).kind).toBe("held");
        const blob = registerBlob(git, "line-main");
        expect(blob).toContain(recordJson(other));
        expect(blob).not.toContain(lease.token);
      });
    });

    it("a crash before the CAS leaves the register at a consistent tip; recovery is the next CAS", () => {
      withTempRepo("register-crash-window", (repo, git) => {
        const ref = claimRegisterRefFor("line-main");
        const shim = buildShim({ registerRef: ref, mode: "crash" });
        try {
          let crashed = false;
          withHostilePath(shim.dir, () => {
            shim.arm();
            try {
              new GitClaimStore(repo).acquire(stableVersion("1.2.3"), "attempt_a");
            } catch {
              // The substrate died mid-write — a fault, not a claim.
              crashed = true;
            }
          });
          expect(crashed).toBe(true);
          // Either side of every CAS the register is a value: here it
          // never moved at all.
          expect(readRef(git, ref)).toBeNull();
          // Recovery is the next compare-and-set.
          const store = new GitClaimStore(repo);
          const recovered = asClaim(store.acquire(stableVersion("1.2.3"), "attempt_a"));
          expect(store.verify(recovered.token).kind).toBe("held");
          expect(registerBlob(git, "line-main")).toContain("attempt_a");
        } finally {
          shim.cleanup();
        }
      });
    });
  });

  describe("the loud refusals (ADR-0011 decision 5)", () => {
    it("a per-scope-layout blob refuses loudly on the first claim read", () => {
      withTempRepo("register-foreign-layout", (repo, git) => {
        // The per-scope layout's record, sitting where a register must.
        const record = recordJson({
          scope: stableVersion("1.2.3"),
          token: "a".repeat(64),
          holder: "attempt_legacy",
        });
        const blob = git(["hash-object", "-w", "--stdin"], record).trim();
        const tree = git(["mktree"], `100644 blob ${blob}\trecord\n`).trim();
        const commit = git(["commit-tree", tree, "-m", "release-craft: append"]).trim();
        git(["update-ref", claimRegisterRefFor("line-main"), commit]);
        const store = new GitClaimStore(repo);
        expect(() => store.acquire(stableVersion("1.2.3"), "attempt_a")).toThrow(TypeError);
        expect(() => store.verify("any-token")).toThrow(TypeError);
        expect(() => {
          store.release("any-token");
        }).toThrow(TypeError);
      });
    });

    it("a register holding a non-record element refuses loudly", () => {
      withTempRepo("register-junk-record", (repo, git) => {
        const land = (content: string): void => {
          const blob = git(["hash-object", "-w", "--stdin"], content).trim();
          const tree = git(["mktree"], `100644 blob ${blob}\trecord\n`).trim();
          const commit = git(["commit-tree", tree, "-m", "release-craft: append"]).trim();
          git(["update-ref", claimRegisterRefFor("line-main"), commit]);
        };
        land('{"claims":[42]}');
        const store = new GitClaimStore(repo);
        expect(() => store.acquire(stableVersion("1.2.3"), "attempt_a")).toThrow(TypeError);
        // A record without the fields the store computes over is as
        // foreign as a whole non-register blob.
        land('{"claims":[{"scope":{},"token":"t","holder":"h"}]}');
        expect(() => store.verify("any-token")).toThrow(TypeError);
      });
    });

    it("a register outside the canonical form refuses loudly", () => {
      withTempRepo("register-non-canonical", (repo, git) => {
        const land = (content: string): void => {
          const blob = git(["hash-object", "-w", "--stdin"], content).trim();
          const tree = git(["mktree"], `100644 blob ${blob}\trecord\n`).trim();
          const commit = git(["commit-tree", tree, "-m", "release-craft: append"]).trim();
          git(["update-ref", claimRegisterRefFor("line-main"), commit]);
        };
        const record = (scope: ClaimScope, token: string): string =>
          recordJson({ scope, token, holder: "attempt_x" });
        const store = new GitClaimStore(repo);
        // The writer sorts before every land; a set the writer could not
        // have produced is corrupted recorded state, with the same voice
        // as a foreign layout (ADR-0011 decision 5).
        land(
          `{"claims":[${record(stableVersion("1.3.0"), "c".repeat(64))},${record(stableVersion("1.2.3"), "b".repeat(64))}]}`,
        );
        expect(() => store.verify("any-token")).toThrow(TypeError);
        land(
          `{"claims":[${record(stableVersion("1.2.3"), "b".repeat(64))},${record(stableVersion("1.2.3"), "c".repeat(64))}]}`,
        );
        expect(() => store.verify("any-token")).toThrow(TypeError);
        // An extra field is as foreign as a missing one.
        land(
          '{"claims":[{"kind":"claim","scope":{"kind":"release-line","lineId":"line-main"},"token":"t","holder":"h","extra":1}]}',
        );
        expect(() => store.verify("any-token")).toThrow(TypeError);
      });
    });

    it("a register git cannot read refuses loudly — never reads as an unclaimed line (#95)", () => {
      withTempRepo("register-broken-ref", (repo, git) => {
        // The register ref's loose file holds garbage: git's own
        // `rev-parse --verify --quiet` exits 1 with a warning on stderr —
        // the absence shape (exit 1, empty stderr) it is not.
        const ref = claimRegisterRefFor("line-broken");
        const refPath = join(
          repo,
          ".git",
          "refs",
          "release-craft",
          "claims",
          ref.slice(CLAIM_REF_NAMESPACE.length),
        );
        mkdirSync(dirname(refPath), { recursive: true });
        writeFileSync(refPath, "not-a-commit\n");
        // The read boundary faults instead of reporting the empty set.
        expect(() => readRegister(git, ref)).toThrow(GitFaultError);
        expect(() => readRegister(git, ref)).toThrow(/broken ref/);
        // The store's opening read faults with it: an acquire over the
        // line cannot read the corrupt register as an unclaimed one and
        // mint a claim over it.
        const store = new GitClaimStore(repo);
        expect(() => store.acquire(releaseLine("line-broken"), "attempt_broken")).toThrow(
          GitFaultError,
        );
        // The all-register walk is a `for-each-ref`, and git's enumeration
        // skips a broken ref silently: verify reports the token lost rather
        // than faulting — the loud path is direct addressing (D39 records
        // the reach boundary).
        expect(store.verify("any-token")).toEqual({ kind: "lost" });
      });
    });
  });

  describe("the recorded takeover (ADR-0011 decision 9; issue #227)", () => {
    const supersessionJson = (superseded: ClaimRecord, supersededBy: ClaimRecord): string =>
      canonicalJson({
        kind: "supersession",
        superseded: {
          kind: "claim",
          scope: superseded.scope,
          token: superseded.token,
          holder: superseded.holder,
        },
        supersededBy: {
          kind: "claim",
          scope: supersededBy.scope,
          token: supersededBy.token,
          holder: supersededBy.holder,
        },
      });

    it("a takeover lands the claim and its supersession in one commit — the envelope carries both", () => {
      withTempRepo("register-takeover-lands", (repo, git) => {
        const store = new GitClaimStore(repo);
        const holderClaim = asClaim(store.acquire(prerelease(1), "attempt_holder"));
        // No takeover yet: the envelope carries no supersessions member at
        // all — the canonical form without one is byte-identical to the
        // pre-#227 register.
        expect(registerBlob(git, "line-main")).toBe(
          envelope([{ scope: prerelease(1), token: holderClaim.token, holder: "attempt_holder" }]),
        );
        const takerClaim = asClaim(store.acquire(prerelease(2), "attempt_taker"));
        const holderRecord = {
          scope: prerelease(1),
          token: holderClaim.token,
          holder: "attempt_holder",
        };
        const takerRecord = {
          scope: prerelease(2),
          token: takerClaim.token,
          holder: "attempt_taker",
        };
        expect(registerBlob(git, "line-main")).toBe(
          `{"claims":[${recordJson(holderRecord)},${recordJson(takerRecord)}],"supersessions":[${supersessionJson(holderRecord, takerRecord)}]}`,
        );
        // One mutation, one commit: the ref holds exactly two commits — the
        // claim and its supersession never landed as two compare-and-sets.
        const count = git(["rev-list", "--count", claimRegisterRefFor("line-main")]).trim();
        expect(Number.parseInt(count, 10)).toBe(2);
        // The fence verdict: the passed token verifies superseded naming the
        // taker; the taker's own stays held.
        expect(store.verify(holderClaim.token)).toEqual({
          kind: "superseded",
          supersededBy: takerClaim,
        });
        expect(store.verify(takerClaim.token)).toEqual({ kind: "held", claim: takerClaim });
      });
    });

    it("the superseded holder's re-acquisition denies with the refusal marker, no retry base, the taker named", () => {
      withTempRepo("register-takeover-reacquire", (repo) => {
        const store = new GitClaimStore(repo);
        asClaim(store.acquire(prerelease(1), "attempt_holder"));
        asClaim(store.acquire(prerelease(2), "attempt_taker"));
        expect(store.acquire(prerelease(1), "attempt_holder")).toEqual({
          kind: "denied",
          holder: "attempt_taker",
          scope: prerelease(1),
          refusal: "superseded",
        });
      });
    });

    it("the superseded record stands: a third claim on the exact scope is still denied by it (E-07)", () => {
      withTempRepo("register-takeover-record-stands", (repo) => {
        const store = new GitClaimStore(repo);
        asClaim(store.acquire(prerelease(1), "attempt_holder"));
        asClaim(store.acquire(prerelease(2), "attempt_taker"));
        expect(store.acquire(prerelease(1), "attempt_stranger")).toEqual({
          kind: "denied",
          holder: "attempt_holder",
          scope: prerelease(1),
          holderSequence: 1,
        });
      });
    });

    it("the fence survives release: a released passed lease still verifies superseded", () => {
      withTempRepo("register-takeover-survives-release", (repo, git) => {
        const store = new GitClaimStore(repo);
        const holderClaim = asClaim(store.acquire(prerelease(1), "attempt_holder"));
        const takerClaim = asClaim(store.acquire(prerelease(2), "attempt_taker"));
        store.release(holderClaim.token);
        // The claims set lost the released lease; the supersession member
        // stands — the evidence survives the release.
        expect(store.verify(holderClaim.token)).toEqual({
          kind: "superseded",
          supersededBy: takerClaim,
        });
        expect(registerBlob(git, "line-main")).toContain('"supersessions":[');
      });
    });

    it("a later takeover re-lands the record naming the latest taker", () => {
      withTempRepo("register-takeover-relands", (repo) => {
        const store = new GitClaimStore(repo);
        const first = asClaim(store.acquire(prerelease(1), "attempt_first"));
        const second = asClaim(store.acquire(prerelease(2), "attempt_second"));
        const third = asClaim(store.acquire(prerelease(3), "attempt_third"));
        expect(store.verify(first.token)).toEqual({ kind: "superseded", supersededBy: third });
        expect(store.verify(second.token)).toEqual({ kind: "superseded", supersededBy: third });
      });
    });

    it("a corrupt supersessions member refuses loudly — unsorted, duplicated, malformed", () => {
      withTempRepo("register-corrupt-supersessions", (repo, git) => {
        const land = (content: string): void => {
          const blob = git(["hash-object", "-w", "--stdin"], content).trim();
          const tree = git(["mktree"], `100644 blob ${blob}\trecord\n`).trim();
          const commit = git(["commit-tree", tree, "-m", "release-craft: append"]).trim();
          git(["update-ref", claimRegisterRefFor("line-main"), commit]);
        };
        const claim = (sequence: number, token: string): string =>
          recordJson({ scope: prerelease(sequence), token, holder: "attempt_x" });
        const passed = (sequence: number, token: string, taker: string): string =>
          supersessionJson(
            { scope: prerelease(sequence), token, holder: "attempt_x" },
            { scope: prerelease(9), token: "d".repeat(64), holder: taker },
          );
        const claimsPart = `${claim(1, "b".repeat(64))},${claim(2, "c".repeat(64))}`;
        const store = new GitClaimStore(repo);
        // The writer sorts before every land; an unsorted or duplicated
        // supersessions set is corrupted recorded state, with the same
        // voice as a foreign layout (ADR-0011 decision 5's law at the
        // fence).
        land(
          `{"claims":[${claimsPart}],"supersessions":[${passed(2, "c".repeat(64), "taker")},${passed(1, "b".repeat(64), "taker")}]}`,
        );
        expect(() => store.verify("any-token")).toThrow(TypeError);
        land(
          `{"claims":[${claimsPart}],"supersessions":[${passed(1, "b".repeat(64), "taker")},${passed(1, "b".repeat(64), "taker")}]}`,
        );
        expect(() => store.verify("any-token")).toThrow(TypeError);
        // A malformed element and a non-array member refuse the same way.
        land(`{"claims":[${claimsPart}],"supersessions":[42]}`);
        expect(() => store.verify("any-token")).toThrow(TypeError);
        land(`{"claims":[${claimsPart}],"supersessions":"gone"}`);
        expect(() => store.verify("any-token")).toThrow(TypeError);
      });
    });
  });

  describe("the denial parity (#69)", () => {
    it("the exclusion-path denial carries no holderSequence", () => {
      withTempRepo("register-exclusion-denial", (repo) => {
        const store = new GitClaimStore(repo);
        asClaim(store.acquire(releaseLine(), "attempt_holder"));
        const denial = asDenied(store.acquire(prerelease(7), "attempt_requester"));
        expect(denial).toEqual({
          kind: "denied",
          scope: prerelease(7),
          holder: "attempt_holder",
        });
        // The requester's own sequence is not a retry base — stamping it
        // keyed an E-08 retry loop on a meaningless value.
        expect(Object.hasOwn(denial, "holderSequence")).toBe(false);
      });
    });
  });
});

/**
 * The dual-backend scenario list (ADR-0011's test strategy): one script of
 * acquire/verify/release moves, run over both stores, requiring one
 * observable transcript. Tokens are labelled in first-sighting order — the
 * two stores allocate differently, and the port promises behavior, not
 * token spelling.
 */

interface TranscriptEntry {
  readonly op: string;
  readonly outcome: unknown;
}

interface Scenario {
  readonly name: string;
  readonly run: (store: ClaimStore) => readonly TranscriptEntry[];
}

const scenario = (
  name: string,
  moves: (store: ClaimStore, log: (op: string, result: unknown) => void) => void,
): Scenario => ({
  name,
  run: (store) => {
    const transcript: TranscriptEntry[] = [];
    const labels = new Map<string, string>();
    const tokenLabel = (token: string): string => {
      const seen = labels.get(token);
      if (seen !== undefined) {
        return seen;
      }
      const fresh = `t${String(labels.size + 1)}`;
      labels.set(token, fresh);
      return fresh;
    };
    // The observable transcript: the port's outcomes with tokens labelled,
    // everything the two stores promise to share.
    const normalize = (result: unknown): unknown => {
      if (result !== null && typeof result === "object" && "kind" in result) {
        const value = result as { kind: string; claim?: unknown };
        if (value.kind === "claim") {
          const claim = result as Claim;
          return { kind: "claim", holder: claim.holder, token: tokenLabel(claim.token) };
        }
        if (value.kind === "denied") {
          const denial = result as ClaimDenied;
          return denial.holderSequence === undefined
            ? { kind: "denied", holder: denial.holder }
            : { kind: "denied", holder: denial.holder, holderSequence: denial.holderSequence };
        }
        if (value.kind === "held" && value.claim !== null && typeof value.claim === "object") {
          const claim = value.claim as Claim;
          return {
            kind: "held",
            claim: { kind: "claim", holder: claim.holder, token: tokenLabel(claim.token) },
          };
        }
      }
      return result;
    };
    moves(store, (op, result) => transcript.push({ op, outcome: normalize(result) }));
    return transcript;
  },
});

describe("the dual-backend scenario list (ADR-0011)", () => {
  const scenarios: readonly Scenario[] = [
    scenario("coexistence, adjudication, and idempotent re-acquisition", (store, log) => {
      log("acquire 1.2.3@a", store.acquire(stableVersion("1.2.3"), "attempt_a"));
      log("acquire 1.3.0@b", store.acquire(stableVersion("1.3.0"), "attempt_b"));
      log("acquire 1.2.3@c", store.acquire(stableVersion("1.2.3"), "attempt_c"));
      log("acquire 1.2.3@a", store.acquire(stableVersion("1.2.3"), "attempt_a"));
    }),
    scenario("the line exclusion law holds from both sides", (store, log) => {
      log("acquire line@a", store.acquire(releaseLine(), "attempt_a"));
      log("acquire 1.2.3@b", store.acquire(stableVersion("1.2.3"), "attempt_b"));
      log("acquire rc7@c", store.acquire(prerelease(7), "attempt_c"));
      log("acquire line@d", store.acquire(releaseLine(), "attempt_d"));
    }),
    scenario("leases release, records stand (ADR-0009 decision 4)", (store, log) => {
      const lease = asClaim(store.acquire(prerelease(7), "attempt_a"));
      store.release(lease.token);
      log("verify released lease", store.verify(lease.token));
      const record = asClaim(store.acquire(stableVersion("1.2.3"), "attempt_b"));
      store.release(record.token);
      log("verify released record", store.verify(record.token));
      store.release("no-such-token");
    }),
    scenario("the E-08 retry base is the winner's sequence", (store, log) => {
      const winner = asClaim(store.acquire(prerelease(7), "attempt_w"));
      log("acquire rc7@l", store.acquire(prerelease(7), "attempt_l"));
      store.release(winner.token);
      log("acquire rc7@l after release", store.acquire(prerelease(7), "attempt_l"));
    }),
  ];

  for (const { name, run } of scenarios) {
    it(`${name} — one transcript over both stores`, () => {
      withTempRepo("register-parity", (repo) => {
        expect(run(new GitClaimStore(repo))).toEqual(run(new MemoryClaimStore()));
      });
    });
  }
});

/**
 * The declared scope boundary (#182, ADR-0011 decision 2): the register's
 * exclusion is one shared ref space — compare-and-set over the one
 * repository's own `refs/release-craft/claims/*` — and extends exactly
 * that far. Two standard clones of one repository hold disjoint claim
 * refs (a standard clone's refspec brings only `refs/heads/*` and
 * `refs/tags/*`; the adapter never fetches remote claim state — ADR-0010
 * decision 3), so both acquire the same line's claim, each register lists
 * only its own record, and the divergence first surfaces at the
 * consumer's push as a non-fast-forward rejection — outside the engine's
 * verdict vocabulary. The declared precondition of every surface above
 * the binding; cross-checkout enforcement is deliberately out of scope,
 * and this pin exists so a change to the boundary moves a test.
 */

describe("the exclusion is one shared ref space (#182)", () => {
  /** The hermetic environment the fixture's own `clone`/`push` spawns need
   *  (the store's runner bakes the same floor). */
  const CLONE_ENV: NodeJS.ProcessEnv = hermeticGitEnv();

  const spawnGit = (cwd: string, args: readonly string[]): { status: number; stderr: string } => {
    const result = spawnSync("git", [...args], { cwd, env: CLONE_ENV, encoding: "utf8" });
    if (result.error !== undefined) {
      throw new Error(`git ${args.join(" ")} failed to spawn: ${result.error.message}`);
    }
    return { status: result.status ?? -1, stderr: result.stderr };
  };

  it("two clones of one repository acquire the same line's claim independently — each register lists only its own record, neither can observe the other", () => {
    const scope = releaseLine("line-shared-182");
    const ref = claimRegisterRefFor(scope.lineId);
    const origin = createTempRepo();
    const work = mkdtempSync(join(tmpdir(), "release-craft-register-scope-182-"));
    try {
      const checkoutA = join(work, "checkout-a");
      const checkoutB = join(work, "checkout-b");
      expect(spawnGit(work, ["clone", origin.repo, checkoutA]).status).toBe(0);
      expect(spawnGit(work, ["clone", origin.repo, checkoutB]).status).toBe(0);
      const gitA = openGitRun(checkoutA);
      const gitB = openGitRun(checkoutB);

      // A standard clone fetches only heads and tags: the claim namespace
      // is invisible to every checkout but its own.
      expect(gitA(["config", "--get-all", "remote.origin.fetch"])).toBe(
        "+refs/heads/*:refs/remotes/origin/*\n",
      );
      expect(gitB(["config", "--get-all", "remote.origin.fetch"])).toBe(
        "+refs/heads/*:refs/remotes/origin/*\n",
      );

      // The same scope on the same line, two checkouts: both acquire.
      // Within one checkout the second acquire would be a denial naming
      // the winner; the ref spaces are disjoint, so neither exclusion
      // check ever sees the other claim.
      const storeA = new GitClaimStore(checkoutA);
      const storeB = new GitClaimStore(checkoutB);
      const claimA = asClaim(storeA.acquire(scope, "attempt_a"));
      const claimB = asClaim(storeB.acquire(scope, "attempt_b"));
      expect(claimA.holder).toBe("attempt_a");
      expect(claimB.holder).toBe("attempt_b");
      expect(claimA.token).not.toBe(claimB.token);

      // Each register lists exactly its own record, under the same ref
      // name (the lineId's digest) at disjoint tips.
      expect(readRegister(gitA, ref)?.map((record) => record.holder)).toEqual(["attempt_a"]);
      expect(readRegister(gitB, ref)?.map((record) => record.holder)).toEqual(["attempt_b"]);
      const tipA = readRef(gitA, ref);
      const tipB = readRef(gitB, ref);
      expect(tipA).not.toBeNull();
      expect(tipA).not.toBe(tipB);

      // Neither checkout can observe the other's claim through the port.
      expect(storeA.verify(claimB.token)).toEqual({ kind: "lost" });
      expect(storeB.verify(claimA.token)).toEqual({ kind: "lost" });

      // Where the divergence first surfaces: the consumer's own push. The
      // first clone's claim ref lands; the second's is a non-fast-forward
      // rejection — a git refusal, carrying no engine outcome kind.
      expect(spawnGit(checkoutA, ["push", "origin", `${ref}:${ref}`]).status).toBe(0);
      const rejected = spawnGit(checkoutB, ["push", "origin", `${ref}:${ref}`]);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("rejected");
      // The remote holds the first checkout's claim; the loser's mint
      // never landed.
      expect(readRef(origin.git, ref)).toBe(tipA);
    } finally {
      origin.cleanup();
      rmSync(work, { recursive: true, force: true });
    }
  });
});
