import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  claimRegisterRefFor,
  commitRecord,
  type ClaimRecord,
  GitClaimStore,
  readRef,
  type GitRun,
} from "../../../src/adapters/git/index.js";
import {
  type Claim,
  type ClaimDenied,
  canonicalJson,
  type ClaimScope,
  type ClaimStore,
  MemoryClaimStore,
} from "../../../src/index.js";
import { withTempRepo } from "./temp-repo.js";

/**
 * The per-line claim register (ADR-0011) — the pins its Consequences name:
 * the deterministic concurrency suite (two writers one move at a time,
 * through a hostile `git` on PATH that diverges the register between a
 * loser's evaluation and its CAS — the loser re-evaluates against the
 * diverged tip and lands or denies, never both-accept, never a stale
 * adjudication), the release-by-token pin, the crash window, the
 * loud foreign-blob refusals, the #69 denial parity, and the dual-backend
 * scenario list run over both stores.
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
 * The hostile `git`: a PATH shim that intercepts the store's first
 * compare-and-set on the register ref and, before delegating, makes one
 * divergent move of its own — the concurrent writer's landing — or dies
 * mid-write (the crash window). The real CAS then fails on git's own
 * old-value check, exactly as a concurrent writer's ref move fails it.
 */
interface Shim {
  readonly dir: string;
  /** Arms the trap: the next compare-and-set on the register ref is
   *  intercepted. Setup moves before `arm()` pass through untouched. */
  arm(): void;
  cleanup(): void;
}

const buildShim = (spec: {
  readonly registerRef: string;
  /** The register blob the concurrent writer lands, when diverging. */
  readonly payload?: string;
  readonly mode: "diverge" | "crash";
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
  const payload = join(dir, "payload.json");
  if (spec.payload !== undefined) {
    writeFileSync(payload, spec.payload);
  }
  const diverge =
    spec.mode === "diverge" && spec.payload !== undefined
      ? [
          `BLOB=$(cat "${payload}" | "${real}" hash-object -w --stdin)`,
          `TREE=$(printf '100644 blob %s\\trecord\\n' "$BLOB" | "${real}" mktree)`,
          `COMMIT=$("${real}" commit-tree "$TREE" -m "ecoma: append")`,
          `"${real}" update-ref "${spec.registerRef}" "$COMMIT" || exit 1`,
        ].join("\n")
      : "kill -9 $$";
  const script = [
    "#!/bin/sh",
    `if [ "$1" = "update-ref" ] && [ "$2" = "${spec.registerRef}" ] && [ -e "${armed}" ] && [ ! -e "${flag}" ]; then`,
    `  touch "${flag}"`,
    diverge,
    "fi",
    `exec "${real}" "$@"`,
    "",
  ].join("\n");
  const shim = join(dir, "git");
  writeFileSync(shim, script);
  chmodSync(shim, 0o755);
  return {
    dir,
    arm: () => {
      writeFileSync(armed, "");
    },
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

    it("a release racing the same scope's re-acquisition removes by token, never by scope", () => {
      withTempRepo("register-release-by-token", (repo, git) => {
        // A lease, not a record: a stable-version claim's release is a
        // no-op (P-01), so the race only exists for the lease scopes.
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
        const commit = git(["commit-tree", tree, "-m", "ecoma: append"]).trim();
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
          const commit = git(["commit-tree", tree, "-m", "ecoma: append"]).trim();
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
    scenario("leases release, records stand (P-01)", (store, log) => {
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
