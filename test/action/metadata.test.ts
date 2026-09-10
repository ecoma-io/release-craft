/**
 * §6 obligation 1's metadata legs, obligation 5 (the token-journey pin) and
 * obligation 6's negative inventory, pinned against the artifact itself.
 *
 * The drift rows bind the composite's declared values to this repository's
 * own pin files — the same declared-value-versus-repo-file shape as the
 * build-command pin — so a toolchain bump that edits the repo files but not
 * the composite (or the reverse) goes red. The adversarial form is
 * structural: the composite declares no file-path input at all, so a
 * consumer workspace's own `.node-version` is provably unread and its root
 * `packageManager` cannot re-pin the Action's toolchain (the declared
 * `version` wins; a disagreement makes provisioning throw loudly — §2.2's
 * owned residual — a fault, never a silent different-toolchain install).
 *
 * The input inventory's full row-by-row enforcement lives in the policy
 * gate (`scripts/check-action-metadata.mjs`, §6 obligation 8); this suite
 * pins the inventory's edges the contract assigns it: the refused inputs
 * absent, the token journey empty.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACTION_METADATA,
  INVOKE_SCRIPT,
  replayOutcome,
  runInvoke,
  withActionRepo,
} from "./harness.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const NODE_VERSION_FILE = readFileSync(join(REPO_ROOT, ".node-version"), "utf8").trim();
const PACKAGE_JSON = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  packageManager: string;
};
const MOON_GRAPH = readFileSync(join(REPO_ROOT, "moon.yml"), "utf8");

describe("fixture 1 — the toolchain pins are declared values, single-sourced", () => {
  it("the composite declares node-version and pnpm version by value", () => {
    expect(ACTION_METADATA).toMatch(/uses: actions\/setup-node@[0-9a-f]{40}( #|\n)/);
    expect(ACTION_METADATA).toMatch(/uses: pnpm\/action-setup@[0-9a-f]{40}( #|\n)/);
    expect(ACTION_METADATA).toMatch(/^\s+node-version: 24\s*$/m);
    expect(ACTION_METADATA).toMatch(/^\s+version: 11\.25\.0\s*$/m);
  });

  it("drift row: the declared node-version equals the repository's own .node-version", () => {
    const declared = /^\s+node-version: (\S+)\s*$/m.exec(ACTION_METADATA)?.[1];
    expect(declared).toBe(NODE_VERSION_FILE);
    expect(NODE_VERSION_FILE).toBe("24");
  });

  it("drift row: the declared pnpm version equals the repository's own packageManager", () => {
    const declared = /^\s+version: (\S+)\s*$/m.exec(ACTION_METADATA)?.[1];
    const managed = /^pnpm@(\S+)$/.exec(PACKAGE_JSON.packageManager)?.[1];
    expect(declared).toBe(managed);
    expect(managed).toBe("11.25.0");
  });

  it("drift row: the Action's build command is the moon graph's build command", () => {
    const moonCommand = /^ {4}command: (.+)$/m.exec(
      MOON_GRAPH.slice(MOON_GRAPH.indexOf("  build:")),
    )?.[1];
    expect(moonCommand).toBe("tsc -p tsconfig.build.json");
    expect(ACTION_METADATA).toContain(`run: pnpm exec ${moonCommand ?? ""}`);
  });

  it("provisioning stands in the materialized tree; the invocation stands where the metadata declared", () => {
    const workingDirectories = [...ACTION_METADATA.matchAll(/^\s+working-directory: (.+)$/gm)].map(
      (match) => match[1],
    );
    expect(workingDirectories).toStrictEqual([
      "${{ github.action_path }}",
      "${{ github.action_path }}",
      "${{ inputs.working-directory }}",
    ]);
    // The invocation step runs the script AND the bin from the same
    // materialization — the one tree the consumer's pin resolved.
    expect(ACTION_METADATA).toContain("${{ github.action_path }}/action/invoke.mjs");
    expect(ACTION_METADATA).toContain("${{ github.action_path }}/dist/src/cli/index.js");
  });

  it("every run step is bash — the invocation shell the composite is written for", () => {
    const runSteps = ACTION_METADATA.match(/^\s+run: /gm) ?? [];
    const bashSteps = ACTION_METADATA.match(/^\s+shell: bash\s*$/gm) ?? [];
    expect(bashSteps).toHaveLength(runSteps.length);
    expect(bashSteps.length).toBeGreaterThan(0);
  });

  it("the install is frozen and scripts-free — the invariants reach the front door", () => {
    const installs = ACTION_METADATA.match(/pnpm install.*/g) ?? [];
    expect(installs).toStrictEqual(["pnpm install --frozen-lockfile --ignore-scripts"]);
  });
});

describe("fixture 1 — the adversarial form is structural", () => {
  it("the composite declares no file-path resolution input — the mangled join is unrepresentable", () => {
    // The mechanism, not merely an unused row: neither provisioning action
    // joins its file input as-given (both `path.join` it onto
    // GITHUB_WORKSPACE), so under the no-checkout posture the spelling
    // `${{ github.action_path }}/.node-version` would arrive mangled and
    // fault — or, on pnpm's side, be swallowed into a silently disengaged
    // pin. The file-input names below must not appear anywhere in the
    // metadata — no `with:` row declares them, no `run:` line reads them.
    expect(ACTION_METADATA).not.toContain("node-version-file");
    expect(ACTION_METADATA).not.toContain("package_json_file");
    // The provisioning steps carry no `with:` row naming either pin file.
    expect(ACTION_METADATA).not.toMatch(/^\s+node-version-file:/m);
    expect(ACTION_METADATA).not.toMatch(/^\s+version-file:/m);
  });

  it("the invocation script reads no toolchain pin file of its own", () => {
    const script = readFileSync(INVOKE_SCRIPT, "utf8");
    expect(script).not.toMatch(/\.node-version/);
    expect(script).not.toMatch(/package\.json/);
    expect(script).not.toMatch(/packageManager/);
  });

  it(
    "a consumer workspace's planted pin files cannot re-pin the toolchain — the declared values win and the run publishes",
    { timeout: 45_000 },
    () => {
      withActionRepo("planted-pins", (repo, _git, worldPath) => {
        // The consumer repository carries its own (lying) toolchain pins at
        // its root — exactly the files the refused file-path inputs would
        // have resolved against the consumer's workspace. The composite
        // never reads them: the run publishes, and the planted bytes are
        // untouched evidence.
        writeFileSync(join(repo, ".node-version"), "99\n");
        writeFileSync(
          join(repo, "package.json"),
          `${JSON.stringify({ packageManager: "pnpm@99.99.99" }, null, 2)}\n`,
        );
        const drive = runInvoke(
          {
            world: worldPath,
            line: "main",
            actor: "the-release-author",
            tagNamespaces: "\n",
          },
          { cwd: repo },
        );
        expect(drive.status).toBe(0);
        const outcome = JSON.parse(replayOutcome(drive.outputs)) as { kind: string; tag: string };
        expect(outcome.kind).toBe("published");
        expect(outcome.tag).toBe("5.0.0-beta.1");
        expect(readFileSync(join(repo, ".node-version"), "utf8")).toBe("99\n");
        expect(readFileSync(join(repo, "package.json"), "utf8")).toContain("pnpm@99.99.99");
      });
    },
  );
});

describe("fixture 1 — the materialization guarantee", () => {
  it(
    "the invocation executes the bin built from the pinned tree, over the consumer's repository",
    { timeout: 45_000 },
    () => {
      withActionRepo("materialization", (repo, git, worldPath) => {
        const drive = runInvoke(
          {
            world: worldPath,
            line: "main",
            actor: "the-release-author",
            tagNamespaces: "\n",
          },
          { cwd: repo },
        );
        expect(drive.status).toBe(0);
        const outcome = JSON.parse(replayOutcome(drive.outputs)) as { kind: string };
        expect(outcome.kind).toBe("published");
        // The mint is local: the tag exists in the caller's copy and
        // nowhere else (§2.8).
        expect(git(["tag", "--list"]).trim()).toBe("5.0.0-beta.1");
      });
    },
  );
});

describe("fixture 5 — the token journey is empty", () => {
  it("the metadata declares no token input and references no secret", () => {
    const inputs = inputsBlock(ACTION_METADATA);
    expect(inputs).not.toContain("token");
    expect(ACTION_METADATA).not.toMatch(/\$\{\{\s*secrets\./);
    expect(ACTION_METADATA).not.toMatch(/GH_TOKEN|GITHUB_TOKEN/);
  });

  it("the composite performs no checkout of any repository — persist-credentials holds vacuously", () => {
    // No `uses:` step checks anything out, and no step declares the
    // credential row a checkout would carry — the pin is structural (a
    // checkout step is unrepresentable), not a prose ban.
    expect(ACTION_METADATA).not.toMatch(/uses:\s*actions\/checkout/);
    expect(ACTION_METADATA).not.toMatch(/persist-credentials\s*:/);
    // The refused second-checkout spelling (§2.7) is unrepresentable too.
    expect(ACTION_METADATA).not.toContain("github.action_ref");
  });

  it("the invocation script performs no git of its own — the binding's spawns are the only git", () => {
    const script = readFileSync(INVOKE_SCRIPT, "utf8");
    // Exactly one spawn, and it spawns the built bin through the running
    // node — the only git the Action performs is the git the engine's own
    // binding performs inside that bin (§2.8, §5's law).
    const spawns = script.match(/^\s*child = spawnSync\(.+$/gm) ?? [];
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toContain("process.execPath");
    expect(script).not.toMatch(/spawnSync\(\s*["'`]git/);
    expect(script).not.toMatch(/\b(execSync|execFile|exec)\(/);
    expect(script).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|secrets\./);
  });
});

describe("fixture 6 — the refused inputs are absent from the metadata", () => {
  // `target-branch` is release-pr's own CLI flag (issue #208) but no
  // Action input — the Action drives `run` alone; the release-please
  // vocabulary is refused by name at the metadata boundary.
  it.each([
    "assembly",
    "command",
    "json",
    "token",
    "declarations",
    "naming-module",
    "target",
    "release-type",
    "draft-pull-request",
    "label",
    "target-branch",
    "bootstrap-sha",
    "last-release-sha",
    "initial-version",
    "package-name",
    "separate-pull-requests",
  ])("no `%s` input exists — the refused side door does not re-enter through metadata", (name) => {
    const inputs = inputsBlock(ACTION_METADATA);
    expect(inputs.has(name)).toBe(false);
  });
});

/** The input names declared under the top-level `inputs:` block. */
function inputsBlock(metadata: string): Set<string> {
  const start = metadata.indexOf("\ninputs:");
  const end = metadata.indexOf("\nruns:");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const names = new Set<string>();
  for (const line of metadata.slice(start, end).split("\n")) {
    const match = /^ {2}([a-z-]+):$/.exec(line);
    if (match?.[1] !== undefined) {
      names.add(match[1]);
    }
  }
  return names;
}
