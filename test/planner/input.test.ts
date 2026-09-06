import { describe, expect, it } from "vitest";

import { InvalidPlanningInputError, normalize } from "../../src/planner/input.js";
import type {
  CommitObservation,
  ComponentMeta,
  LineConfig,
  OperatorIntent,
  PlanningInput,
  PolicyInput,
  RefObservation,
  TagObservation,
} from "../../src/planner/types.js";

/**
 * The contract suite for the planner's input boundary (phase2 contract
 * §2.1): `normalize` deep-validates a `PlanningInput`, throws the planner's
 * own error naming every violation in deterministic order, and returns the
 * closed value with exact-duplicate intents collapsed (m-6b — the same
 * reference when nothing duplicates). The planner invents nothing and
 * mutates nothing; these tests pin that posture from the caller's side.
 */

/** A fixed 64-hex policy digest — realistic shape, stable across runs. */
const DIGEST = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

/** A fixed 40-hex commit sha for fixtures. */
const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

/** A sha never present in any fixture's commit set — the closed-input foil. */
const ABSENT = "ffffffffffffffffffffffffffffffffffffffff";

/**
 * Smuggles a wrong-typed value past the checker so the trap stays a runtime
 * assertion instead of a literal the compiler would refuse (the convention
 * version.test.ts sets): the planner must reject at runtime what
 * TypeScript rejects at compile time — closed inputs arrive as data.
 */
function wrong(value: unknown): never {
  return value as never;
}

const baseCommit = (): CommitObservation => ({
  sha: SHA,
  parents: [],
  message: "feat: a change worth releasing",
  committedAt: "2026-01-01T00:00:00Z",
  containingRefs: [],
});

const baseLine = (): LineConfig => ({
  id: "main",
  feedRef: "refs/heads/main",
  lifecycle: "active",
  declared: true,
});

/** The minimal valid input: one policy, one commit, one line, no refs/tags. */
function makeValidInput(): PlanningInput {
  return {
    policy: {
      digest: DIGEST,
      bumpMappingId: "default",
      prereleaseLadder: ["alpha", "beta", "rc"],
      prereleaseSeed: "0",
      pre10Dampening: true,
      selfReferenceNamespace: "Change-Ref:",
      tagFormats: {},
    },
    repository: { commits: [baseCommit()], refs: [] },
    history: { tags: [] },
    lines: [baseLine()],
  };
}

function withPolicy(patch: Partial<PolicyInput>): PlanningInput {
  const base = makeValidInput();
  return { ...base, policy: { ...base.policy, ...patch } };
}

function withCommits(commits: readonly CommitObservation[]): PlanningInput {
  const base = makeValidInput();
  return { ...base, repository: { ...base.repository, commits } };
}

function withRefs(refs: readonly RefObservation[]): PlanningInput {
  const base = makeValidInput();
  return { ...base, repository: { ...base.repository, refs } };
}

function withTags(tags: readonly TagObservation[]): PlanningInput {
  const base = makeValidInput();
  return { ...base, history: { tags } };
}

function withLines(lines: readonly LineConfig[]): PlanningInput {
  return { ...makeValidInput(), lines };
}

function withIntents(intents: readonly OperatorIntent[]): PlanningInput {
  return { ...makeValidInput(), intents };
}

function withComponents(components: readonly ComponentMeta[]): PlanningInput {
  return { ...makeValidInput(), components };
}

/**
 * Runs `normalize` on `input`, expecting rejection, and returns the
 * planner's own error. This is try/catch plumbing only — every assertion
 * lives in the test body, where the reader (and the lint rule) can see it.
 */
function reject(input: PlanningInput): InvalidPlanningInputError {
  try {
    normalize(input);
  } catch (error) {
    if (error instanceof InvalidPlanningInputError) return error;
    throw error;
  }
  throw new Error("unreachable — normalize accepted an input expected to be rejected");
}

/** The violated field paths of a rejection, in traversal order. */
function fieldsOf(rejected: InvalidPlanningInputError): string[] {
  return rejected.violations.map((violation) => violation.field);
}

describe("normalize — the closed input boundary (§2.1)", () => {
  it("passes a valid input through unchanged: same reference, nothing added, nothing mutated", () => {
    const input = makeValidInput();
    const snapshot = structuredClone(input);

    const result = normalize(input);

    expect(result).toBe(input); // no copy — caller-owned data stays caller-owned
    expect(result).toEqual(snapshot); // validation-only — no defaults filled, no mutation
  });

  it("rejects with the planner's own error: instance, name, and a message naming the field", () => {
    const rejected = reject(withPolicy({ digest: "" }));

    expect(rejected).toBeInstanceOf(InvalidPlanningInputError);
    expect(rejected.name).toBe("InvalidPlanningInputError");
    expect(rejected.message).toContain("policy.digest");
  });

  describe("policy", () => {
    it("rejects an empty digest, naming policy.digest", () => {
      const rejected = reject(withPolicy({ digest: "" }));
      expect(fieldsOf(rejected)).toContain("policy.digest");
    });

    it("rejects a padded digest, naming policy.digest", () => {
      const rejected = reject(withPolicy({ digest: ` ${DIGEST} ` }));
      expect(fieldsOf(rejected)).toContain("policy.digest");
    });

    it("rejects an empty bump mapping id, naming policy.bumpMappingId", () => {
      const rejected = reject(withPolicy({ bumpMappingId: "" }));
      expect(fieldsOf(rejected)).toContain("policy.bumpMappingId");
    });

    it("rejects an empty prerelease ladder, naming policy.prereleaseLadder", () => {
      const rejected = reject(withPolicy({ prereleaseLadder: [] }));
      expect(fieldsOf(rejected)).toContain("policy.prereleaseLadder");
    });

    it("rejects an empty rung inside the ladder, naming the indexed field", () => {
      const rejected = reject(withPolicy({ prereleaseLadder: ["alpha", ""] }));
      expect(fieldsOf(rejected)).toContain("policy.prereleaseLadder[1]");
    });

    it("rejects a seed outside the declared fork, naming policy.prereleaseSeed", () => {
      const rejected = reject(withPolicy({ prereleaseSeed: wrong("2") }));
      expect(fieldsOf(rejected)).toContain("policy.prereleaseSeed");
    });

    it("rejects an empty self-reference namespace, naming policy.selfReferenceNamespace", () => {
      const rejected = reject(withPolicy({ selfReferenceNamespace: "" }));
      expect(fieldsOf(rejected)).toContain("policy.selfReferenceNamespace");
    });

    it("rejects a namespace missing its trailing colon, naming policy.selfReferenceNamespace", () => {
      const rejected = reject(withPolicy({ selfReferenceNamespace: "Change-Ref" }));
      expect(fieldsOf(rejected)).toContain("policy.selfReferenceNamespace");
    });

    it("rejects an empty tag-format key, naming the keyed field", () => {
      const rejected = reject(withPolicy({ tagFormats: { "": "v%@M" } }));
      expect(fieldsOf(rejected)).toContain('policy.tagFormats[""]');
    });

    it("rejects an empty tag-format value, naming the keyed field", () => {
      const rejected = reject(withPolicy({ tagFormats: { main: "" } }));
      expect(fieldsOf(rejected)).toContain('policy.tagFormats["main"]');
    });

    it("rejects a bump mapping id other than the declared default, naming policy.bumpMappingId", () => {
      const rejected = reject(withPolicy({ bumpMappingId: "conventional-default" }));
      expect(fieldsOf(rejected)).toContain("policy.bumpMappingId");
    });

    it("rejects a tag format missing the {prerelease} token, naming the keyed field", () => {
      const rejected = reject(withPolicy({ tagFormats: { main: "{major}.{minor}.{patch}" } }));
      expect(fieldsOf(rejected)).toContain('policy.tagFormats["main"]');
    });
  });

  describe("repository.commits", () => {
    it("rejects an empty sha, naming the indexed field", () => {
      const rejected = reject(withCommits([{ ...baseCommit(), sha: "" }]));
      expect(fieldsOf(rejected)).toContain("repository.commits[0].sha");
    });

    it("rejects duplicate shas, naming the second occurrence", () => {
      const duplicate = withCommits([baseCommit(), { ...baseCommit(), message: "feat: another" }]);
      const rejected = reject(duplicate);
      expect(fieldsOf(rejected)).toContain("repository.commits[1].sha");
    });

    it("rejects a parent outside the closed commit set, naming the indexed parent field", () => {
      const rejected = reject(withCommits([{ ...baseCommit(), parents: [ABSENT] }]));
      expect(fieldsOf(rejected)).toContain("repository.commits[0].parents[0]");
    });
  });

  describe("repository.refs and history.tags", () => {
    it("rejects a duplicate ref name, naming the second occurrence", () => {
      const duplicate = withRefs([
        { name: "refs/heads/main", head: SHA },
        { name: "refs/heads/main", head: SHA },
      ]);
      const rejected = reject(duplicate);
      expect(fieldsOf(rejected)).toContain("repository.refs[1].name");
    });

    it("rejects a ref head outside the closed commit set, naming the indexed head field", () => {
      const rejected = reject(withRefs([{ name: "refs/heads/feature", head: ABSENT }]));
      expect(fieldsOf(rejected)).toContain("repository.refs[0].head");
    });

    it("rejects a duplicate tag name, naming the second occurrence", () => {
      const duplicate = withTags([
        { name: "v1.0.0", commit: SHA },
        { name: "v1.0.0", commit: SHA },
      ]);
      const rejected = reject(duplicate);
      expect(fieldsOf(rejected)).toContain("history.tags[1].name");
    });

    it("rejects a tag bound outside the closed commit set, naming the indexed commit field", () => {
      const rejected = reject(withTags([{ name: "v2.0.0", commit: ABSENT }]));
      expect(fieldsOf(rejected)).toContain("history.tags[0].commit");
    });
  });

  describe("lines", () => {
    it("rejects an empty line array, naming lines", () => {
      const rejected = reject(withLines([]));
      expect(fieldsOf(rejected)).toContain("lines");
    });

    it("rejects a duplicate line id, naming the second occurrence", () => {
      const duplicate = withLines([baseLine(), { ...baseLine(), feedRef: "refs/heads/other" }]);
      const rejected = reject(duplicate);
      expect(fieldsOf(rejected)).toContain("lines[1].id");
    });

    it("rejects an empty line id, naming the indexed field", () => {
      const rejected = reject(withLines([{ ...baseLine(), id: "" }]));
      expect(fieldsOf(rejected)).toContain("lines[0].id");
    });

    it("rejects an empty feed ref, naming the indexed field", () => {
      const rejected = reject(withLines([{ ...baseLine(), feedRef: "" }]));
      expect(fieldsOf(rejected)).toContain("lines[0].feedRef");
    });

    it("rejects a lifecycle outside the declared union, naming the indexed field", () => {
      const archived = withLines([{ ...baseLine(), lifecycle: wrong("archived") }]);
      const rejected = reject(archived);
      expect(fieldsOf(rejected)).toContain("lines[0].lifecycle");
    });

    it("rejects an allow list that is neither a union member nor a list, naming the indexed field", () => {
      const rejected = reject(withLines([{ ...baseLine(), streams: { allow: wrong(7) } }]));
      expect(fieldsOf(rejected)).toContain("lines[0].streams.allow");
    });

    it("rejects an empty stream identifier in the allow list, naming the indexed field", () => {
      const rejected = reject(withLines([{ ...baseLine(), streams: { allow: ["rc", ""] } }]));
      expect(fieldsOf(rejected)).toContain("lines[0].streams.allow[1]");
    });

    it("rejects a duplicate stream identifier, naming the second occurrence and the value", () => {
      const rejected = reject(withLines([{ ...baseLine(), streams: { allow: ["rc", "rc"] } }]));

      expect(fieldsOf(rejected)).toContain("lines[0].streams.allow[1]");
      const violation = rejected.violations.find(
        (candidate) => candidate.field === "lines[0].streams.allow[1]",
      );
      expect(violation?.problem).toContain("rc");
    });

    it("accepts an empty allow list — valid data: the line mints no streams", () => {
      const input = withLines([{ ...baseLine(), streams: { allow: [] } }]);
      const snapshot = structuredClone(input);

      const result = normalize(input);

      expect(result).toBe(input);
      expect(result).toEqual(snapshot);
    });

    it("rejects a line seed outside the declared fork, naming the indexed field", () => {
      const rejected = reject(withLines([{ ...baseLine(), streams: { seed: wrong("2") } }]));
      expect(fieldsOf(rejected)).toContain("lines[0].streams.seed");
    });

    it("rejects a withhold rule with an empty scope, naming the indexed field", () => {
      const rejected = reject(
        withLines([{ ...baseLine(), withhold: [{ scope: "", reason: "held for review" }] }]),
      );
      expect(fieldsOf(rejected)).toContain("lines[0].withhold[0].scope");
    });

    it("rejects a withhold rule with an empty reason, naming the indexed field", () => {
      const rejected = reject(
        withLines([{ ...baseLine(), withhold: [{ scope: "docs/*", reason: "" }] }]),
      );
      expect(fieldsOf(rejected)).toContain("lines[0].withhold[0].reason");
    });

    it("rejects an empty publishes binding, naming the indexed field", () => {
      const rejected = reject(withLines([{ ...baseLine(), publishes: "" }]));
      expect(fieldsOf(rejected)).toContain("lines[0].publishes");
    });

    it("rejects a publishes binding naming an undeclared component, naming the component and the gap", () => {
      const rejected = reject(withLines([{ ...baseLine(), publishes: "cli" }]));

      expect(fieldsOf(rejected)).toContain("lines[0].publishes");
      const violation = rejected.violations.find(
        (candidate) => candidate.field === "lines[0].publishes",
      );
      expect(violation?.problem).toContain("cli");
      expect(violation?.problem).toContain("binding has a gap");
    });

    it("rejects a publishes binding when the input declares other components", () => {
      const input: PlanningInput = {
        ...makeValidInput(),
        components: [{ name: "app", manifestVersion: "1.2.3", paths: ["apps/app"] }],
        lines: [{ ...baseLine(), publishes: "cli" }],
      };

      const rejected = reject(input);

      expect(fieldsOf(rejected)).toContain("lines[0].publishes");
    });

    it("accepts a fully declared line policy — streams, seed, withhold, and a declared binding", () => {
      const input: PlanningInput = {
        ...makeValidInput(),
        components: [{ name: "app", manifestVersion: "1.2.3", paths: ["apps/app"] }],
        lines: [
          {
            ...baseLine(),
            streams: { allow: ["rc", "beta"], seed: "1" },
            withhold: [{ scope: "docs/*", reason: "documentation rides the next train" }],
            publishes: "app",
          },
        ],
      };
      const snapshot = structuredClone(input);

      const result = normalize(input);

      expect(result).toBe(input);
      expect(result).toEqual(snapshot);
    });
  });

  describe("components", () => {
    it("accepts well-formed component metadata, unchanged", () => {
      const input = withComponents([
        { name: "app", manifestVersion: "1.2.3", paths: ["apps/app"] },
        {
          name: "lib",
          manifestVersion: "0.9.0",
          paths: ["libs/lib"],
          dependencies: [{ name: "app", range: "^1.2.3" }],
        },
      ]);
      const snapshot = structuredClone(input);

      const result = normalize(input);

      expect(result).toBe(input); // validation-only — no copy, no mutation
      expect(result).toEqual(snapshot);
    });

    it("rejects an empty component name, naming the indexed field", () => {
      const rejected = reject(withComponents([{ name: "", manifestVersion: "1.2.3", paths: [] }]));
      expect(fieldsOf(rejected)).toContain("components[0].name");
    });
  });

  describe("bootstrap", () => {
    it("rejects a recorded version that does not parse as a Version, naming bootstrap.version", () => {
      const input: PlanningInput = {
        ...makeValidInput(),
        bootstrap: { version: "1.2", who: "operator", when: "2026-01-01T00:00:00Z" },
      };

      const rejected = reject(input);

      expect(fieldsOf(rejected)).toContain("bootstrap.version");
    });

    it("accepts a recorded version that parses (S-02: absence is legal, presence must parse)", () => {
      const input: PlanningInput = {
        ...makeValidInput(),
        bootstrap: { version: "1.2.3", who: "operator", when: "2026-01-01T00:00:00Z" },
      };

      const result = normalize(input);

      expect(result).toBe(input);
    });
  });

  describe("intents", () => {
    it("rejects an empty prerelease stream, naming the indexed field", () => {
      const intent = withIntents([{ kind: "prerelease", stream: "", lineId: "main" }]);
      const rejected = reject(intent);
      expect(fieldsOf(rejected)).toContain("intents[0].stream");
    });

    it("rejects an empty release-as version, naming the indexed field", () => {
      const rejected = reject(withIntents([{ kind: "release-as", version: "" }]));
      expect(fieldsOf(rejected)).toContain("intents[0].version");
    });

    it("rejects a promote naming an undeclared line, naming the indexed field", () => {
      const rejected = reject(withIntents([{ kind: "promote", lineId: "develop" }]));
      expect(fieldsOf(rejected)).toContain("intents[0].lineId");
    });

    it("rejects a prerelease naming an undeclared line, naming the indexed field", () => {
      const rejected = reject(
        withIntents([{ kind: "prerelease", stream: "rc", lineId: "develop" }]),
      );
      expect(fieldsOf(rejected)).toContain("intents[0].lineId");
    });

    it("rejects a prerelease without a line — stream demand is always per line", () => {
      const rejected = reject(withIntents([{ kind: "prerelease", stream: "rc" }]));
      expect(fieldsOf(rejected)).toContain("intents[0].lineId");
    });

    it("rejects a release-as version that does not parse as a Version, naming the indexed field", () => {
      const rejected = reject(withIntents([{ kind: "release-as", version: "1.2.x" }]));
      expect(fieldsOf(rejected)).toContain("intents[0].version");
    });
    it("accepts every declared intent kind with a well-formed payload, unchanged", () => {
      const input = withIntents([
        { kind: "release" },
        { kind: "release-anyway" },
        { kind: "prerelease", stream: "beta", lineId: "main" },
        { kind: "release-as", version: "2.4.0" },
        { kind: "promote", lineId: "main" },
      ]);
      const snapshot = structuredClone(input);

      const result = normalize(input);

      expect(result).toBe(input);
      expect(result).toEqual(snapshot);
    });
  });

  describe("exact-duplicate intents (m-6b)", () => {
    it("collapses exact duplicates to their first occurrence, preserving order", () => {
      const input = withIntents([
        { kind: "release" },
        { kind: "prerelease", stream: "rc", lineId: "main" },
        { kind: "release" },
        { kind: "prerelease", stream: "rc", lineId: "main" },
        { kind: "promote", lineId: "main" },
        { kind: "promote", lineId: "main" },
      ]);

      const result = normalize(input);

      expect(result).not.toBe(input); // a duplicate dropped — the intent array is new
      expect(result.intents).toEqual([
        { kind: "release" },
        { kind: "prerelease", stream: "rc", lineId: "main" },
        { kind: "promote", lineId: "main" },
      ]);
    });

    it("keeps intents differing in any field — only exact duplicates collapse", () => {
      const input = withIntents([
        { kind: "prerelease", stream: "rc", lineId: "main" },
        { kind: "prerelease", stream: "beta", lineId: "main" },
        { kind: "promote", lineId: "main" },
      ]);

      const result = normalize(input);

      expect(result).toBe(input); // nothing dropped — the same closed value
      expect(result.intents).toHaveLength(3);
    });
  });

  describe("aggregate reporting and determinism", () => {
    it("lists every violation, in traversal order, not just the first", () => {
      const rejected = reject(withPolicy({ digest: "", bumpMappingId: "" }));

      expect(fieldsOf(rejected)).toEqual(["policy.digest", "policy.bumpMappingId"]);
    });

    it("reports an identical violation list — same fields, same order, same message — for identical input", () => {
      const input = withPolicy({ digest: "", prereleaseSeed: wrong("2") });
      const first = reject(input);
      const second = reject(input);

      expect(second.violations).toEqual(first.violations);
      expect(second.message).toBe(first.message);
    });
  });
});
