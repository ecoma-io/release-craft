/**
 * §6 obligations 1, 3, and 7, driven through the built bin:
 *
 * 1. Two assemblies over one world — the same world-document bytes go
 *    through `--assembly memory` and `--assembly git` and both doors
 *    answer identically; the git assembly additionally mints the ref into
 *    the repository, the memory assembly leaves no world (§2.2).
 * 3. Pass-through equality — the CLI's `--json` stdout equals the direct
 *    Engine-door outcome serialized, for every scenario the process
 *    surface can construct: a plan, a published run over each assembly, a
 *    post-planning refusal, a claim denial, a retry conflict, an
 *    ambiguity, and the observation doors.
 * 7. Cross-process posture — resume/resolve/abort/show against a fresh
 *    process render whatever the engine returns, including the `refused`
 *    row for a plan this engine does not carry; the surface runs no
 *    capability gate and adds no pre-check (§2.7).
 */

import { describe, expect, it } from "vitest";

import { plan } from "@ecoma-io/release-craft/planner";

import type { PlanningInput } from "../../src/index.js";
import {
  betaIntent,
  cliJson,
  directObserve,
  directPlan,
  directResume,
  directRun,
  docBytes,
  expectPassThrough,
  gitDoc,
  gitSelection,
  lockChannelRefs,
  memoryDoc,
  memorySelection,
  projectRepo,
  promoteIntent,
  runCli,
  withSeededRepo,
  type CliResult,
} from "./harness.js";

interface OutcomeShape {
  readonly kind: string;
  readonly detail?: string;
  readonly holder?: string | null;
  readonly tag?: string | null;
  readonly planId?: string | null;
  readonly handle?: {
    readonly planId: string;
    readonly attemptId: string;
    readonly actor: string;
  } | null;
  readonly drives?: readonly {
    readonly stepKey: string;
    readonly outcome: { readonly kind: string };
  }[];
}

const asOutcome = (value: unknown): OutcomeShape => value as OutcomeShape;

const expectTag = (result: CliResult, tag: string): void => {
  expect(result.status).toBe(0);
  const outcome = asOutcome(cliJson(result));
  expect(outcome.kind).toBe("published");
  expect(outcome.tag).toBe(tag);
};

/** The git run's argv for the main line, over one repository, under one
 * declared namespace root. */
const gitRunArgs = (repo: string, namespace = ""): string[] => [
  "run",
  "--assembly",
  "git",
  "--repo",
  repo,
  "--tag-namespace",
  namespace,
  "--world",
  "-",
  "--actor",
  "automation",
  "--line",
  "main",
  "--json",
];

describe("§6 obligation 1 — two assemblies over one world", () => {
  it(
    "the same world-document bytes publish the same tag through memory and git",
    { timeout: 45_000 },
    () => {
      withSeededRepo("two-assemblies", (repo, git, heads) => {
        const doc = docBytes(gitDoc("main", [betaIntent], heads));
        const memory = runCli(
          [
            "run",
            "--assembly",
            "memory",
            "--world",
            "-",
            "--actor",
            "automation",
            "--line",
            "main",
            "--json",
          ],
          { input: doc },
        );
        expectTag(memory, "5.0.0-beta.1");
        // The memory assembly mints nothing: no tag door is wired, the
        // caller owns the world (§2.2).
        expect(git(["tag", "--list"]).trim()).toBe("");

        const gitRun = runCli(
          [
            "run",
            "--assembly",
            "git",
            "--repo",
            repo,
            "--tag-namespace",
            "",
            "--world",
            "-",
            "--actor",
            "automation",
            "--line",
            "main",
            "--json",
          ],
          { input: doc },
        );
        expectTag(gitRun, "5.0.0-beta.1");
        // The git assembly minted the ref into the repository.
        expect(git(["tag", "--list"]).trim()).toBe("5.0.0-beta.1");
      });
    },
  );
});

describe("§2.3 — the declared naming renders the world's own tag format", () => {
  const prefixed = { main: "v{major}.{minor}.{patch}{prerelease}" };

  it(
    "a world declaring a prefixed format mints the PREFIXED tag — the naming and the plan render one tag from one document",
    { timeout: 45_000 },
    () => {
      let childText: string | null = null;
      let childRepo: string | null = null;
      withSeededRepo("naming-prefixed-child", (repo, git, heads) => {
        const doc = docBytes(gitDoc("main", [betaIntent], heads, [], prefixed));
        const child = runCli(gitRunArgs(repo), { input: doc });
        // The plan's tag renders through the declared format; the naming's
        // projection of the held claim's scope must equal it or the mint
        // refuses `unclaimed` with the claim standing (the strand this pin
        // exists to keep impossible).
        expectTag(child, "v5.0.0-beta.1");
        expect(git(["tag", "--list"]).trim()).toBe("v5.0.0-beta.1");
        childText = child.stdout;
        childRepo = repo;
      });
      // Pass-through holds with declared formats too: a direct engine over
      // an identically seeded repository builds its naming from the same
      // document's policy and answers identically.
      withSeededRepo("naming-prefixed-direct", (repo, _git, heads) => {
        expect(childText).not.toBeNull();
        const doc = docBytes(gitDoc("main", [betaIntent], heads, [], prefixed));
        const direct = directRun(gitSelection(repo), doc, "main", [betaIntent]);
        expect(asOutcome(direct).kind).toBe("published");
        expect(
          projectRepo(JSON.parse(childText as string) as unknown, childRepo as string),
        ).toStrictEqual(projectRepo(direct, repo));
      });
    },
  );

  it(
    "a root claiming only the bare spelling refuses the prefixed scope at the namespace door — the filter reads the RENDERED tag",
    { timeout: 45_000 },
    () => {
      withSeededRepo("naming-prefixed-refused", (repo, git, heads) => {
        const doc = docBytes(gitDoc("main", [betaIntent], heads, [], prefixed));
        // Root "5.0.0" would claim the BARE projection ("5.0.0-beta.1");
        // the rendered tag is "v5.0.0-beta.1", which it does not claim —
        // the namespace door refuses the acquisition (ClaimDenied
        // { refusal: "namespace" }, holder absent) and nothing walks.
        const child = runCli(
          [
            "run",
            "--assembly",
            "git",
            "--repo",
            repo,
            "--tag-namespace",
            "5.0.0",
            "--world",
            "-",
            "--actor",
            "automation",
            "--line",
            "main",
            "--json",
          ],
          { input: doc },
        );
        expect(child.status).toBe(10);
        const outcome = asOutcome(cliJson(child));
        expect(outcome.kind).toBe("refused");
        expect(outcome.detail).toContain("the declared naming derives no tag for it");
        expect(outcome.drives).toStrictEqual([]);
        // Nothing stood up: no tag minted, the refusal is the whole stop.
        expect(git(["tag", "--list"]).trim()).toBe("");
      });
    },
  );
});

describe("§6 obligation 3 — pass-through equality", () => {
  it("plan: the child's JSON equals the direct door's outcome", () => {
    const doc = docBytes(memoryDoc("main", [betaIntent]));
    const child = runCli(["plan", "--assembly", "memory", "--world", "-", "--json"], {
      input: doc,
    });
    expect(child.status).toBe(0);
    expectPassThrough(child, directPlan(memorySelection(), doc));
  });

  it("run (memory, published): the child's JSON equals the direct door's outcome", () => {
    const doc = docBytes(memoryDoc("main", [betaIntent]));
    const child = runCli(
      [
        "run",
        "--assembly",
        "memory",
        "--world",
        "-",
        "--actor",
        "automation",
        "--line",
        "main",
        "--json",
      ],
      { input: doc },
    );
    expect(child.stderr).toBe("");
    expectTag(child, "5.0.0-beta.1");
    expectPassThrough(child, directRun(memorySelection(), doc, "main", [betaIntent]));
  });

  it(
    "run (git, published): the child's JSON equals a direct engine's outcome over an identically seeded repository",
    { timeout: 45_000 },
    () => {
      let docText: string | null = null;
      let childResult: CliResult | null = null;
      withSeededRepo("git-passthrough-child", (repo, _git, heads) => {
        docText = docBytes(gitDoc("main", [betaIntent], heads));
        const child = runCli(
          [
            "run",
            "--assembly",
            "git",
            "--repo",
            repo,
            "--tag-namespace",
            "",
            "--world",
            "-",
            "--actor",
            "automation",
            "--line",
            "main",
            "--json",
          ],
          { input: docText },
        );
        expectTag(child, "5.0.0-beta.1");
        childResult = child;
      });
      withSeededRepo("git-passthrough-direct", (repo2, _git, heads) => {
        // The fixture commits are deterministic: the second repository's
        // heads equal the first's, so the same document describes both.
        expect(docText).not.toBeNull();
        expect(docBytes(gitDoc("main", [betaIntent], heads))).toBe(docText);
        const direct = directRun(gitSelection(repo2), docText as string, "main", [betaIntent]);
        expect(asOutcome(direct).kind).toBe("published");
        // Equal modulo the two values that are genuinely per-repository:
        // the claim token (the binding's one random value) and any fault
        // text's own path — see projectRepo.
        expect(projectRepo(cliJson(childResult as CliResult))).toStrictEqual(projectRepo(direct));
      });
    },
  );

  it("run (memory, post-planning refusal): the child's JSON equals the direct door's outcome", () => {
    // The promote intent over a world with no in-flight prerelease: the
    // request is well-formed, the plan assembles no line.
    const doc = docBytes(memoryDoc("main", [promoteIntent]));
    const child = runCli(
      [
        "run",
        "--assembly",
        "memory",
        "--world",
        "-",
        "--actor",
        "automation",
        "--line",
        "main",
        "--json",
      ],
      { input: doc },
    );
    expect(child.status).toBe(10);
    const childOutcome = asOutcome(cliJson(child));
    expect(childOutcome.kind).toBe("refused");
    expect(childOutcome.detail).toContain("assembles no line");
    expect(childOutcome.handle).toBeNull();
    expectPassThrough(child, directRun(memorySelection(), doc, "main", [promoteIntent]));
  });

  it(
    "run (git, denial and retry conflict): both children equal direct engines over the same repository states",
    { timeout: 45_000 },
    () => {
      withSeededRepo("git-denied-conflict", (repo, _git, heads) => {
        const stableDoc = docBytes(gitDoc("4.8.x", [], heads));
        const stableArgs = [
          "run",
          "--assembly",
          "git",
          "--repo",
          repo,
          "--tag-namespace",
          "",
          "--world",
          "-",
          "--actor",
          "automation",
          "--line",
          "4.8.x",
          "--json",
        ];
        const first = runCli(stableArgs, { input: stableDoc });
        expectTag(first, "4.8.7");
        const firstHandle = asOutcome(cliJson(first)).handle;
        expect(firstHandle).not.toBeNull();

        // The claims persist after publish: a second process's stable run
        // on the same line is the E-07 denial, naming the holder.
        const second = runCli(stableArgs, { input: stableDoc });
        expect(second.status).toBe(11);
        const secondOutcome = asOutcome(cliJson(second));
        expect(secondOutcome.kind).toBe("denied");
        expect(secondOutcome.holder).toBe(firstHandle?.attemptId);

        // The beta ladder twice: the E-08 denial with a full retry bound is
        // the explicit conflict.
        const betaDoc = docBytes(gitDoc("main", [betaIntent], heads));
        const betaArgs = [
          "run",
          "--assembly",
          "git",
          "--repo",
          repo,
          "--tag-namespace",
          "",
          "--world",
          "-",
          "--actor",
          "automation",
          "--line",
          "main",
          "--json",
        ];
        const betaFirst = runCli(betaArgs, { input: betaDoc });
        expectTag(betaFirst, "5.0.0-beta.1");
        const betaSecond = runCli(betaArgs, { input: betaDoc });
        expect(betaSecond.status).toBe(14);
        expect(asOutcome(cliJson(betaSecond)).kind).toBe("conflict");

        // Pass-through equality for both rows: a direct engine over the
        // same repository state answers identically. The repository now
        // holds 4.8.7 and 5.0.0-beta.1; a fresh direct engine's first
        // stable run is the denial, its first beta run the conflict.
        const directStable = asOutcome(directRun(gitSelection(repo), stableDoc, "4.8.x"));
        expect(directStable.kind).toBe("denied");
        expect(directStable.holder).toBe(firstHandle?.attemptId);
        const directBeta = asOutcome(directRun(gitSelection(repo), betaDoc, "main", [betaIntent]));
        expect(directBeta.kind).toBe("conflict");
      });
    },
  );

  it(
    "run (git, ambiguity): the child's JSON equals the direct outcome, modulo the fault text's own repository paths",
    { timeout: 45_000 },
    () => {
      let childText: string | null = null;
      let childRepo: string | null = null;
      withSeededRepo("git-ambiguous-child", (repo, _git, heads) => {
        const first = runCli(
          [
            "run",
            "--assembly",
            "git",
            "--repo",
            repo,
            "--tag-namespace",
            "",
            "--world",
            "-",
            "--actor",
            "automation",
            "--line",
            "main",
            "--json",
          ],
          { input: docBytes(gitDoc("main", [betaIntent], heads)) },
        );
        expectTag(first, "5.0.0-beta.1");
        // The in-flight prerelease is declared world state: the promote
        // plan names the channel moves.
        const promoteDoc = docBytes(
          gitDoc("main", [promoteIntent], heads, [
            { name: "5.0.0-beta.1", commit: heads["main"] as string },
          ]),
        );
        lockChannelRefs(repo, ["stable", "next"]);
        const child = runCli(
          [
            "run",
            "--assembly",
            "git",
            "--repo",
            repo,
            "--tag-namespace",
            "",
            "--world",
            "-",
            "--actor",
            "automation",
            "--line",
            "main",
            "--json",
          ],
          { input: promoteDoc },
        );
        expect(child.status).toBe(15);
        expect(asOutcome(cliJson(child)).kind).toBe("ambiguous");
        childText = child.stdout;
        childRepo = repo;
      });
      // The same scenario through a direct engine: the outcomes are equal
      // once the child's fault text has its own repository path projected
      // out — the detail quotes the GitFaultError verbatim, and the fault
      // quotes the ref it could not move.
      withSeededRepo("git-ambiguous-direct", (repo, _git, heads) => {
        expect(childText).not.toBeNull();
        directRun(gitSelection(repo), docBytes(gitDoc("main", [betaIntent], heads)), "main", [
          betaIntent,
        ]);
        const promoteDoc = docBytes(
          gitDoc("main", [promoteIntent], heads, [
            { name: "5.0.0-beta.1", commit: heads["main"] as string },
          ]),
        );
        lockChannelRefs(repo, ["stable", "next"]);
        const direct = directRun(gitSelection(repo), promoteDoc, "main", [promoteIntent]);
        expect(asOutcome(direct).kind).toBe("ambiguous");
        // Equal once each side's own repository path is projected out of the
        // fault text it quotes (the ambiguous detail embeds the GitFaultError
        // verbatim — the path is the only thing that differs).
        const child = projectRepo(JSON.parse(childText as string) as unknown, childRepo as string);
        const projected = projectRepo(direct, repo);
        expect(child).toStrictEqual(projected);
      });
    },
  );

  it("observe channels (memory): the store-less refusal passes through", () => {
    const child = runCli(["show", "channels", "--assembly", "memory", "--json"]);
    expect(child.status).toBe(10);
    const childOutcome = asOutcome(cliJson(child));
    expect(childOutcome.kind).toBe("refused");
    expect(cliJson(child)).toStrictEqual(directObserve(memorySelection(), { kind: "channels" }));
  });

  it(
    "observe channels (git): the recorded channel states pass through",
    { timeout: 45_000 },
    () => {
      withSeededRepo("git-channels", (repo, _git, _heads) => {
        const child = runCli([
          "show",
          "channels",
          "--assembly",
          "git",
          "--repo",
          repo,
          "--tag-namespace",
          "",
          "--json",
        ]);
        expect(child.status).toBe(0);
        expect(cliJson(child)).toStrictEqual(
          directObserve(gitSelection(repo), { kind: "channels" }),
        );
        // Five channels, each standing at its seeded target.
        const channels = cliJson(child) as { channels: readonly { id: string; target: unknown }[] };
        expect(channels.channels).toHaveLength(5);
      });
    },
  );

  it(
    "observe attempt (git): a carried-entry read after a published run refuses cross-process — and equals the direct door",
    { timeout: 45_000 },
    () => {
      withSeededRepo("git-observe-attempt", (repo, _git, heads) => {
        const run = runCli(
          [
            "run",
            "--assembly",
            "git",
            "--repo",
            repo,
            "--tag-namespace",
            "",
            "--world",
            "-",
            "--actor",
            "automation",
            "--line",
            "main",
            "--json",
          ],
          { input: docBytes(gitDoc("main", [betaIntent], heads)) },
        );
        expectTag(run, "5.0.0-beta.1");
        const handle = asOutcome(cliJson(run)).handle;
        expect(handle).not.toBeNull();
        const child = runCli([
          "show",
          "attempt",
          "--assembly",
          "git",
          "--repo",
          repo,
          "--tag-namespace",
          "",
          "--plan",
          handle?.planId as string,
          "--attempt",
          handle?.attemptId as string,
          "--actor",
          "automation",
          "--json",
        ]);
        expect(child.status).toBe(10);
        expect(child.stderr).toBe("");
        const childOutcome = asOutcome(cliJson(child));
        expect(childOutcome.kind).toBe("refused");
        expect(childOutcome.detail).toContain("unknown attempt");
        // Pass-through: a fresh direct engine refuses identically — the
        // surface added nothing (§2.7).
        const direct = directResume(
          gitSelection(repo),
          docBytes(gitDoc("main", [betaIntent], heads)),
          handle as { planId: string; attemptId: string; actor: string },
        );
        expect(direct.kind).toBe("refused");
        if (direct.kind !== "refused") {
          throw new Error("expected a refused outcome");
        }
        expect(direct.detail).toBe(childOutcome.detail);
      });
    },
  );
});

describe("the two plan doors fingerprint one world identically (#319)", () => {
  const withoutIntents = (doc: PlanningInput): PlanningInput => {
    const copy = { ...doc };
    delete (copy as { intents?: unknown }).intents;
    return copy;
  };
  const cliPlanIdentity = (doc: PlanningInput): { planId: string; inputs: string } => {
    const child = runCli(["plan", "--assembly", "memory", "--world", "-", "--json"], {
      input: docBytes(doc),
    });
    expect(child.status).toBe(0);
    const outcome = cliJson(child) as { plan?: { planId: string; inputsFingerprint: string } };
    expect(outcome.plan).toBeDefined();
    return { planId: outcome.plan?.planId ?? "", inputs: outcome.plan?.inputsFingerprint ?? "" };
  };
  const seamPlanIdentity = (doc: PlanningInput): { planId: string; inputs: string } => {
    const outcome = plan(doc);
    if (outcome.kind !== "planned") {
      throw new Error(`expected a planned outcome, got "${outcome.kind}"`);
    }
    return { planId: outcome.plan.planId, inputs: outcome.plan.inputsFingerprint };
  };

  it("the built CLI's plan door and the raw planner seam answer byte-identical inputs and plan digests over a world that omits intents AND over the same world declaring `intents: []` — one identity per world, across both doors and both spellings", () => {
    const declared = memoryDoc("main", []);
    const absent = withoutIntents(declared);
    const identities: { planId: string; inputs: string }[] = [];
    for (const doc of [absent, declared]) {
      const cli = cliPlanIdentity(doc);
      const seam = seamPlanIdentity(doc);
      expect(cli.inputs).toBe(seam.inputs);
      expect(cli.planId).toBe(seam.planId);
      identities.push(cli);
    }
    // The two spellings of the same world are one world: `intents: []` and
    // the omitted field carry one inputs digest and one planId everywhere.
    expect(identities[0]?.planId).toBe(identities[1]?.planId);
    expect(identities[0]?.inputs).toBe(identities[1]?.inputs);
  });
});

describe("§6 obligation 7 — cross-process posture", () => {
  it("resume against a fresh process is the carried-entry refusal, rendered as the outcome it is (exit 10)", () => {
    const doc = docBytes(memoryDoc("main", [betaIntent]));
    const child = runCli(
      [
        "resume",
        "--assembly",
        "memory",
        "--world",
        "-",
        "--actor",
        "operator",
        "--plan",
        "sha256:" + "a".repeat(64),
        "--attempt",
        "attempt_sha256:" + "b".repeat(64),
        "--json",
      ],
      { input: doc },
    );
    expect(child.status).toBe(10);
    expect(child.stdout).not.toBe("");
    expect(child.stderr).toBe("");
    const outcome = asOutcome(cliJson(child));
    expect(outcome.kind).toBe("refused");
    expect(outcome.detail).toContain("unknown attempt");
    expect(outcome.detail).toContain("phase 11 contract §2.7");
    expect(outcome.handle).toStrictEqual({
      planId: "sha256:" + "a".repeat(64),
      attemptId: "attempt_sha256:" + "b".repeat(64),
      actor: "operator",
    });
  });

  it("abort against a fresh process renders the same refusal shape through the abort door", () => {
    const child = runCli([
      "abort",
      "--assembly",
      "memory",
      "--actor",
      "operator",
      "--plan",
      "sha256:" + "c".repeat(64),
      "--attempt",
      "attempt_sha256:" + "d".repeat(64),
      "--reason",
      "stand down",
      "--json",
    ]);
    expect(child.status).toBe(10);
    const outcome = asOutcome(cliJson(child));
    expect(outcome.kind).toBe("refused");
    expect(outcome.detail).toContain("unknown attempt");
  });

  it("resolve against a fresh process renders the same refusal shape through the resolve door", () => {
    const doc = docBytes(memoryDoc("main", [betaIntent]));
    const child = runCli(
      [
        "resolve",
        "--assembly",
        "memory",
        "--actor",
        "operator",
        "--plan",
        "sha256:" + "e".repeat(64),
        "--attempt",
        "attempt_sha256:" + "f".repeat(64),
        "--step",
        "validate",
        "--resolution",
        "human",
        "--note",
        "the guard is fine",
        "--json",
      ],
      { input: doc },
    );
    expect(child.status).toBe(10);
    expect(asOutcome(cliJson(child)).kind).toBe("refused");
  });

  it("the refusal is the outcome, not a translated fault: stdout carries the JSON, stderr stays empty", () => {
    const child = runCli([
      "show",
      "attempt",
      "--assembly",
      "memory",
      "--plan",
      "p",
      "--attempt",
      "a",
      "--actor",
      "x",
      "--json",
    ]);
    expect(child.status).toBe(10);
    expect(child.stderr).toBe("");
    expect(asOutcome(cliJson(child)).kind).toBe("refused");
  });
});
