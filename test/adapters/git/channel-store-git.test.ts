import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  GitChannelStore,
  CHANNEL_REF_NAMESPACE,
  channelRefFor,
  commitRecord,
  openGitBinding,
  readRef,
} from "../../../src/adapters/git/index.js";
import {
  type ChannelApplyOutcome,
  type ChannelMove,
  type ChannelState,
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

describe("the git-backed channel store (ADR-0012 decision 6)", () => {
  it("the state ref is the sha256 of the channel id under the channel namespace", () => {
    const digest = createHash("sha256").update("stable", "utf8").digest("hex");
    expect(channelRefFor("stable")).toBe(`${CHANNEL_REF_NAMESPACE}${digest}`);
    expect(channelRefFor("stable")).toBe(channelRefFor("stable"));
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
      const ids = store.list().map((channel) => channel.id);
      // Exactly the recorded ids — and the order is the store's own:
      // refname order over the hashed refs, deterministic across reads.
      expect([...ids].sort()).toEqual(["next", "rc-preview", "stable"]);
      const refnameOrder = [...ids].sort((left, right) =>
        channelRefFor(left) < channelRefFor(right) ? -1 : 1,
      );
      expect(ids).toEqual(refnameOrder);
      expect(store.list().map((channel) => channel.id)).toEqual(ids);
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
