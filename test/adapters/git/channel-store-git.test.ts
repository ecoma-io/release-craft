import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  GitChannelStore,
  CHANNEL_REF_NAMESPACE,
  channelRefFor,
  commitRecord,
  GitFaultError,
  openGitBinding,
  readRef,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import {
  type ChannelApplyOutcome,
  type ChannelMove,
  type ChannelState,
  MemoryChannelStore,
  canonicalJson,
  channelStateFingerprint,
} from "../../../src/index.js";
import { withTempRepo } from "./temp-repo.js";

/**
 * The git-backed channel store (ADR-0012 decision 6's physical half): the
 * total read (an absent ref is the hidden channel, S-02), the canonical
 * envelope under the hashed channel ref, the CAS semantics table over the
 * persisted state (applied · noop · conflict), the hostile-`git` race pins
 * (the loser re-evaluates against the diverged ref and reports what the
 * recorded state proves — the deterministic concurrency suite's channel
 * chapter), the loud foreign-blob refusal, the frozen returns, and the
 * binding wiring.
 */

const pointed = (version: string, line = "1.x"): ChannelState["target"] => ({
  line,
  version,
});

const move = (
  channelId: string,
  from: ChannelState["target"],
  to: ChannelState["target"],
): ChannelMove => ({ channelId, from, to });

const asOutcome = <K extends ChannelApplyOutcome["kind"]>(
  outcome: ChannelApplyOutcome,
  kind: K,
): Extract<ChannelApplyOutcome, { kind: K }> => {
  expect(outcome.kind).toBe(kind);
  return outcome as Extract<ChannelApplyOutcome, { kind: K }>;
};

/** The channel-state envelope the store writes, computed through the
 *  store's own canonicalizer — the race fixtures' competing writer lands
 *  the same bytes by hand. */
const envelope = (id: string, target: ChannelState["target"]): string =>
  canonicalJson({ channel: { id, target } });

/**
 * The hostile `git` for the channel races: a PATH shim that intercepts the
 * store's compare-and-set (`update-ref` on the channel ref) and, before
 * delegating, lands the concurrent writer's state — so the store's CAS
 * loses (git's own old-value check refuses) and the loop must re-read and
 * re-evaluate against the diverged tip (ADR-0011 decision 2's law, pinned
 * for channels). Mirrors the claim register's fixture
 * (claim-register.test.ts) at the one window the channel move has.
 */
const buildChannelShim = (spec: { readonly ref: string; readonly payload: string }) => {
  const dir = mkdtempSync(join(tmpdir(), "release-craft-channel-hostile-"));
  const found = spawnSync("which", ["git"], { encoding: "utf8" });
  const real = found.stdout.trim();
  if (real === "") {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`the fixture needs a real git to delegate to: ${found.stderr}`);
  }
  const armed = join(dir, "armed");
  const flag = join(dir, "fired");
  const payload = join(dir, "payload.txt");
  writeFileSync(payload, spec.payload);
  const script = [
    "#!/bin/sh",
    `if [ "$1" = "update-ref" ] && [ "$2" = "${spec.ref}" ] && [ -e "${armed}" ] && [ ! -e "${flag}" ]; then`,
    `  touch "${flag}"`,
    `  BLOB=$(cat "${payload}" | "${real}" hash-object -w --stdin)`,
    `  TREE=$(printf '100644 blob %s\\trecord\\n' "$BLOB" | "${real}" mktree)`,
    `  COMMIT=$("${real}" commit-tree "$TREE" -m "ecoma: append")`,
    `  "${real}" update-ref "${spec.ref}" "$COMMIT" || exit 1`,
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
    fired: () => existsSync(flag),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

/** Runs `fn` with the shim first on PATH — every `git` the store spawns in
 *  there resolves through it. Restored whether `fn` passes or fails. The
 *  store must be constructed inside `fn`: the runner bakes the environment
 *  it opens with. */
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

/**
 * The hostile `git` for the land-fault pin: a PATH shim whose `update-ref`
 * on the channel ref always dies (exit 128, a lock failure on stderr) and
 * delegates everything else to the real git — so the store's read succeeds
 * and the fault lands exactly on the compare-and-set's write, the one
 * window `ambiguous` exists for (ADR-0012 decision 7).
 */
const buildLandFaultShim = (spec: { readonly ref: string }) => {
  const dir = mkdtempSync(join(tmpdir(), "release-craft-channel-landfault-"));
  const found = spawnSync("which", ["git"], { encoding: "utf8" });
  const real = found.stdout.trim();
  if (real === "") {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`the fixture needs a real git to delegate to: ${found.stderr}`);
  }
  const script = [
    "#!/bin/sh",
    `if [ "$1" = "update-ref" ] && [ "$2" = "${spec.ref}" ]; then`,
    `  echo "fatal: cannot lock ref '${spec.ref}': hostile land fault" >&2`,
    "  exit 128",
    "fi",
    `exec "${real}" "$@"`,
    "",
  ].join("\n");
  const shim = join(dir, "git");
  writeFileSync(shim, script);
  chmodSync(shim, 0o755);
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

describe("the git-backed channel store (ADR-0012 decision 6)", () => {
  it("the state ref is the sha256 of the channel id under the channel namespace", () => {
    const digest = createHash("sha256").update("stable", "utf8").digest("hex");
    // The digest itself is pinned literally — an encoding or hash-algorithm
    // drift cannot pass silently.
    expect(digest).toBe("f379ccb92b9116442dc65bdc35648a85d3786b34779db7f704a901fa07b00cb6");
    expect(channelRefFor("stable")).toBe(`${CHANNEL_REF_NAMESPACE}${digest}`);
  });

  it("an absent ref reads as the hidden channel", () => {
    withTempRepo("channel-absent", (repo, git) => {
      const store = new GitChannelStore(repo);
      expect(store.read("stable")).toEqual({ id: "stable", target: null });
      expect(store.list()).toEqual([]);
      expect(readRef(git, channelRefFor("stable"))).toBeNull();
    });
  });

  it("a move out of the hidden state lands the canonical envelope, byte-exact for a fresh reader", () => {
    withTempRepo("channel-apply", (repo, git) => {
      const store = new GitChannelStore(repo);
      const ref = channelRefFor("stable");
      const outcome = asOutcome(
        store.applyTransition(move("stable", null, pointed("1.2.0"))),
        "applied",
      );
      expect(outcome.contentFingerprint).toBe(
        channelStateFingerprint({ id: "stable", target: null }),
      );
      // The ref exists and its tip commit's blob is the canonical envelope —
      // the exact bytes, no envelope of the binding's own.
      const tip = readRef(git, ref);
      expect(tip).not.toBeNull();
      expect(commitRecord(git, tip as string)).toBe(envelope("stable", pointed("1.2.0")));
      // A second store instance — a fresh runner on the same repository —
      // reads the landed state: durability is the repository's, not the
      // instance's.
      expect(new GitChannelStore(repo).read("stable")).toEqual({
        id: "stable",
        target: pointed("1.2.0"),
      });
    });
  });

  it("a replay of a landed move is noop, and a divergent prior conflicts naming the observed", () => {
    withTempRepo("channel-noop-conflict", (repo) => {
      const store = new GitChannelStore(repo);
      store.applyTransition(move("stable", null, pointed("1.2.0")));
      const standing: ChannelState = { id: "stable", target: pointed("1.2.0") };
      // The double-run: the same move again reads as `noop` over the
      // standing state — the idempotency key (ADR-0012 decision 4).
      expect(store.applyTransition(move("stable", null, pointed("1.2.0")))).toEqual({
        kind: "noop",
        contentFingerprint: channelStateFingerprint(standing),
      });
      // The divergence: a move computed against 1.1.0 finds 1.2.0 standing
      // — a conflict naming the observed target, never a silent move.
      expect(store.applyTransition(move("stable", pointed("1.1.0"), pointed("1.3.0")))).toEqual({
        kind: "conflict",
        contentFingerprint: channelStateFingerprint(standing),
        observed: pointed("1.2.0"),
      });
    });
  });

  it("hiding lands the null-target sentinel the same way", () => {
    withTempRepo("channel-hide", (repo, git) => {
      const store = new GitChannelStore(repo);
      store.applyTransition(move("stable", null, pointed("1.2.0")));
      expect(store.applyTransition(move("stable", pointed("1.2.0"), null)).kind).toBe("applied");
      expect(commitRecord(git, readRef(git, channelRefFor("stable")) as string)).toBe(
        envelope("stable", null),
      );
      expect(new GitChannelStore(repo).read("stable")).toEqual({ id: "stable", target: null });
    });
  });

  it("list enumerates exactly the recorded channels, in the hashed refs' refname order", () => {
    withTempRepo("channel-list", (repo) => {
      const store = new GitChannelStore(repo);
      for (const id of ["stable", "next", "rc-preview"]) {
        store.applyTransition(move(id, null, pointed("1.2.0")));
      }
      // Exactly the recorded states, and the order is the store's own —
      // refname order over the hashed refs (the digests of "rc-preview",
      // "next", "stable" sort in that order), pinned literally so a
      // hashing or ordering drift cannot pass silently.
      expect(store.list()).toEqual([
        { id: "rc-preview", target: pointed("1.2.0") },
        { id: "next", target: pointed("1.2.0") },
        { id: "stable", target: pointed("1.2.0") },
      ]);
    });
  });

  it("a foreign blob refuses loudly — never reads as the hidden state", () => {
    withTempRepo("channel-foreign", (repo, git) => {
      const ref = channelRefFor("stable");
      const blob = git(["hash-object", "-w", "--stdin"], '{"claims":[]}');
      const tree = git(["mktree"], `100644 blob ${blob.trim()}\trecord\n`).trim();
      const commit = git(["commit-tree", tree.trim(), "-m", "ecoma: append"]).trim();
      git(["update-ref", ref, commit]);
      const store = new GitChannelStore(repo);
      expect(() => store.read("stable")).toThrow(/channel namespace/);
      expect(() => store.list()).toThrow(/channel namespace/);
    });
  });

  it("a state keyed to another channel's ref refuses loudly — read and list alike", () => {
    withTempRepo("channel-miskeyed", (repo, git) => {
      const ref = channelRefFor("stable");
      // A shape-valid envelope naming "next", hand-landed under stable's
      // ref. The ref mapping is derived from the id, so no writer of the
      // canonical form produces this — it is recorded corruption (a
      // duplicate JSON key would parse to its last value and land in the
      // same refusal): the read boundary refuses instead of computing a
      // move over a state that names another channel.
      const blob = git(["hash-object", "-w", "--stdin"], envelope("next", pointed("9.9.9")));
      const tree = git(["mktree"], `100644 blob ${blob.trim()}\trecord\n`).trim();
      const commit = git(["commit-tree", tree.trim(), "-m", "ecoma: append"]).trim();
      git(["update-ref", ref, commit]);
      const store = new GitChannelStore(repo);
      expect(() => store.read("stable")).toThrow(/one channel per ref/);
      expect(() => store.list()).toThrow(/one channel per ref/);
    });
  });

  it("a ref git cannot read refuses loudly — never the hidden channel, never a false replay (#95)", () => {
    withTempRepo("channel-broken-ref", (repo) => {
      const store = new GitChannelStore(repo);
      store.applyTransition(move("stable", null, pointed("1.2.0")));
      // The loose ref file is overwritten with garbage: git's own
      // `rev-parse --verify --quiet` exits 1 with a warning on stderr —
      // the absence shape (exit 1, empty stderr) it is not.
      const refPath = join(
        repo,
        ".git",
        "refs",
        "release-craft",
        "channels",
        channelRefFor("stable").slice(CHANNEL_REF_NAMESPACE.length),
      );
      mkdirSync(dirname(refPath), { recursive: true });
      writeFileSync(refPath, "not-a-commit\n");
      // The read faults instead of reporting the hidden channel.
      expect(() => store.read("stable")).toThrow(GitFaultError);
      expect(() => store.read("stable")).toThrow(/broken ref/);
      // The hide-move replay refuses too — pre-fix it read the corrupt
      // pointer as the already-hidden channel and classified the move
      // `noop` over the hidden state's fingerprint.
      expect(() => store.applyTransition(move("stable", pointed("1.2.0"), null))).toThrow(
        GitFaultError,
      );
      // The pointed move from hidden refuses at its read as well: the
      // corruption surfaces before any move is attempted (pre-fix the
      // phantom hidden read reached the land and classified `ambiguous` —
      // the land-fault contract below is where that outcome belongs).
      expect(() => store.applyTransition(move("stable", null, pointed("1.2.0")))).toThrow(
        GitFaultError,
      );
      // `list()` walks `for-each-ref`, and git's enumeration skips a
      // broken ref silently: the broken channel is omitted, never read as
      // a hidden state — the loud path is the directly-addressed read (D39
      // records the reach boundary).
      expect(store.list()).toEqual([]);
    });
  });

  it("a land fault stays ambiguous — the read discrimination never swallows the CAS write either", () => {
    withTempRepo("channel-land-fault", (repo) => {
      // The read succeeds over an absent ref (real git delegates), the
      // land dies under the hostile lock: the outcome is `ambiguous`, the
      // fail-closed land-fault class the broken-ref read must not reach.
      const shim = buildLandFaultShim({ ref: channelRefFor("stable") });
      try {
        withHostilePath(shim.dir, () => {
          const store = new GitChannelStore(repo);
          expect(store.applyTransition(move("stable", null, pointed("1.2.0"))).kind).toBe(
            "ambiguous",
          );
        });
      } finally {
        shim.cleanup();
      }
    });
  });

  it("both reference implementations fingerprint a state identically — literal digests pinned", () => {
    withTempRepo("channel-fingerprint-parity", (repo) => {
      const standing: ChannelState = { id: "stable", target: pointed("1.2.0") };
      // The digests are frozen contract — the ledger stores them as the
      // move's idempotency key (ADR-0012 decision 4) — so their bytes are
      // pinned: a canonicalizer or sentinel drift cannot pass silently.
      expect(channelStateFingerprint(standing)).toBe(
        "content_sha256:0ad432c6562a2d4bbe87326299e893429f00d321f385ff17d1d5d3159608efc4",
      );
      expect(channelStateFingerprint({ id: "stable", target: null })).toBe(
        "content_sha256:ff7be9b449cb280211c3a893dd5b59894c90480c7c120e589110a0a240c9fcf4",
      );
      // And the two stores compute the same key for the same recorded
      // state: a move replayed across store kinds stays idempotent.
      const gitStore = new GitChannelStore(repo);
      const memoryStore = new MemoryChannelStore();
      const appliedViaGit = asOutcome(
        gitStore.applyTransition(move("stable", null, pointed("1.2.0"))),
        "applied",
      );
      const appliedViaMemory = asOutcome(
        memoryStore.applyTransition(move("stable", null, pointed("1.2.0"))),
        "applied",
      );
      // Both observed the hidden prior; the key names what was seen.
      expect(appliedViaGit.contentFingerprint).toBe(
        "content_sha256:ff7be9b449cb280211c3a893dd5b59894c90480c7c120e589110a0a240c9fcf4",
      );
      expect(appliedViaMemory.contentFingerprint).toBe(appliedViaGit.contentFingerprint);
      // The replay outcome keys over the standing state — the pointed
      // digest, identical across the stores.
      expect(gitStore.applyTransition(move("stable", null, pointed("1.2.0")))).toEqual({
        kind: "noop",
        contentFingerprint:
          "content_sha256:0ad432c6562a2d4bbe87326299e893429f00d321f385ff17d1d5d3159608efc4",
      });
      expect(memoryStore.applyTransition(move("stable", null, pointed("1.2.0")))).toEqual({
        kind: "noop",
        contentFingerprint:
          "content_sha256:0ad432c6562a2d4bbe87326299e893429f00d321f385ff17d1d5d3159608efc4",
      });
    });
  });

  it("returns are frozen — the state and every decided outcome", () => {
    withTempRepo("channel-frozen", (repo) => {
      const store = new GitChannelStore(repo);
      expect(Object.isFrozen(store.read("stable"))).toBe(true);
      const applied = asOutcome(
        store.applyTransition(move("stable", null, pointed("1.2.0"))),
        "applied",
      );
      expect(Object.isFrozen(applied)).toBe(true);
      const conflicted = store.applyTransition(move("stable", pointed("1.1.0"), pointed("1.3.0")));
      expect(conflicted.kind).toBe("conflict");
      expect(Object.isFrozen(conflicted)).toBe(true);
      expect(Object.isFrozen((conflicted as { observed: unknown }).observed)).toBe(true);
    });
  });

  it("the race: the loser re-evaluates against the diverged ref and reports noop when the winner landed the same target", () => {
    withTempRepo("channel-race-noop", (repo) => {
      const ref = channelRefFor("stable");
      // Writer B lands exactly writer A's target between A's evaluation
      // and A's compare-and-set.
      const shim = buildChannelShim({
        ref,
        payload: envelope("stable", pointed("1.2.0")),
      });
      try {
        withHostilePath(shim.dir, () => {
          const store = new GitChannelStore(repo);
          shim.arm();
          const standing: ChannelState = { id: "stable", target: pointed("1.2.0") };
          expect(store.applyTransition(move("stable", null, pointed("1.2.0")))).toEqual({
            kind: "noop",
            contentFingerprint: channelStateFingerprint(standing),
          });
          expect(shim.fired()).toBe(true);
        });
      } finally {
        shim.cleanup();
      }
    });
  });

  it("the race: the loser reports conflict when the winner landed a different target", () => {
    withTempRepo("channel-race-conflict", (repo) => {
      const ref = channelRefFor("stable");
      // Writer B lands 2.0.0; writer A's move was computed against hidden.
      const shim = buildChannelShim({
        ref,
        payload: envelope("stable", pointed("2.0.0")),
      });
      try {
        withHostilePath(shim.dir, () => {
          const store = new GitChannelStore(repo);
          shim.arm();
          const observed: ChannelState = { id: "stable", target: pointed("2.0.0") };
          expect(store.applyTransition(move("stable", null, pointed("1.2.0")))).toEqual({
            kind: "conflict",
            contentFingerprint: channelStateFingerprint(observed),
            observed: pointed("2.0.0"),
          });
          expect(shim.fired()).toBe(true);
        });
      } finally {
        shim.cleanup();
      }
    });
  });

  it("the binding exposes the channel store, wired to the same repository", () => {
    withTempRepo("channel-binding", (repo) => {
      const binding = openGitBinding({
        repo,
        tagNaming: { namespaces: [], tagFor: () => null },
      });
      expect(binding.channels.read("stable")).toEqual({ id: "stable", target: null });
      expect(binding.channels.applyTransition(move("stable", null, pointed("1.2.0"))).kind).toBe(
        "applied",
      );
      // The binding's store and a fresh one read the same recorded state.
      expect(new GitChannelStore(repo).read("stable").target).toEqual(pointed("1.2.0"));
    });
  });
});
