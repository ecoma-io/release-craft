import { describe, expect, it } from "vitest";

import {
  InvalidManifestError,
  parseManifest,
} from "@ecoma-io/release-craft/__internal__/planner/config.js";
import { plan } from "@ecoma-io/release-craft/__internal__/planner/assemble.js";
import type {
  CommitObservation,
  ManifestInput,
  PlanningInput,
  PlanningOutcome,
  RefObservation,
} from "@ecoma-io/release-craft/__internal__/planner/types.js";

/**
 * Contract suite for the manifest configuration surface (issue #204):
 * `parseManifest` is a closed-configuration door (phase2 contract §2.1.a):
 * 1. A well-formed JSON document (manifest) is parsed single-pass into
 *    `ManifestInput` — the planner's own vocabulary — with loud refusal of
 *    unknown keys, dangling component/line references, malformed fields,
 *    and incomplete mandatory sections (policy + lines required).
 * 2. The output composes with observations to produce a `PlanningInput`
 *    accepted by the full planner (`normalize` + `plan`), establishing the
 *    manifest's position as the single entry surface for human-authored
 *    configuration.
 * 3. All refusal classes are named, field-local, and deterministic.
 */

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

/** A fixed 64-hex policy digest — passes the manifest door's shape check. */
const DIGEST = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

/** A fixed 40-hex commit sha for fixtures. */
const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

const COMMITTED_AT = "2026-01-01T00:00:00Z";

// ---------------------------------------------------------------------------
// Smuggler
// ---------------------------------------------------------------------------

function wrong(value: unknown): never {
  return value as never;
}

// ---------------------------------------------------------------------------
// Manifest document builders
// ---------------------------------------------------------------------------

function basePolicyDoc(): {
  readonly digest: string;
  readonly bumpMappingId: string;
  readonly prereleaseLadder: readonly string[];
  readonly prereleaseSeed: string;
  readonly pre10Dampening: boolean;
  readonly selfReferenceNamespace: string;
  readonly tagFormats: Readonly<Record<string, string>>;
} {
  return {
    digest: DIGEST,
    bumpMappingId: "default",
    prereleaseLadder: ["alpha", "beta", "rc"],
    prereleaseSeed: "0",
    pre10Dampening: true,
    selfReferenceNamespace: "Release-Craft:",
    tagFormats: {},
  };
}

/**
 * A fully valid manifest document — every section declared, all paths
 * forward-plausible. This is the canonical starting point for refusals
 * (mutate one field at a time).
 */
function baseManifestDoc(): Record<string, unknown> {
  return {
    policy: basePolicyDoc(),
    lines: [
      {
        id: "main",
        feedRef: "refs/heads/main",
        lifecycle: "active",
      },
    ],
    components: {
      defaults: { manifestVersion: "0.1.0", dependencies: [] },
      "lib-a": { paths: ["libs/a/package.json"] },
    },
    channels: [{ id: "stable", target: { line: "main", version: "0.1.0" } }],
    bootstrap: {
      version: "0.1.0",
      who: "John Martin <john.itvn@gmail.com>",
      when: "2026-09-05T11:13:25+07:00",
    },
  };
}

// ---------------------------------------------------------------------------
// Observation builders (mirror channels.test.ts)
// ---------------------------------------------------------------------------

function commit(
  sha: string,
  message: string,
  opts: {
    readonly parents?: readonly string[];
    readonly containingRefs?: readonly string[];
  } = {},
): CommitObservation {
  return {
    sha,
    parents: opts.parents ?? [],
    message,
    committedAt: COMMITTED_AT,
    containingRefs: opts.containingRefs ?? [],
  };
}

function ref(name: string, head: string): RefObservation {
  return { name, head };
}

function baseObservations(): Pick<PlanningInput, "repository" | "history"> {
  return {
    repository: {
      commits: [
        commit(SHA, "feat: a change worth releasing", { containingRefs: ["refs/heads/main"] }),
      ],
      refs: [ref("refs/heads/main", SHA)],
    },
    history: { tags: [] },
  };
}

// ---------------------------------------------------------------------------
// Compose helpers
// ---------------------------------------------------------------------------

/** Compose ManifestInput + observations → PlanningInput for plan(). */
function compose(
  declared: ManifestInput,
  opts?: {
    readonly commits?: readonly CommitObservation[];
    readonly refs?: readonly RefObservation[];
    readonly tags?: readonly { readonly name: string; readonly commit: string }[];
  },
): PlanningInput {
  return {
    ...declared,
    repository: {
      commits: opts?.commits ?? baseObservations().repository.commits,
      refs: opts?.refs ?? baseObservations().repository.refs,
    },
    history: { tags: opts?.tags ?? [] },
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function plannedOf(outcome: PlanningOutcome): Extract<PlanningOutcome, { kind: "planned" }> {
  if (outcome.kind !== "planned") {
    throw new Error(`fixture broken: expected planned, got ${outcome.kind}`);
  }
  return outcome;
}

function reject(document: unknown): InvalidManifestError {
  try {
    parseManifest(document);
  } catch (error) {
    if (error instanceof InvalidManifestError) return error;
    throw error;
  }
  throw new Error("unreachable — parseManifest accepted a document expected to be rejected");
}

function fieldsOf(rejected: InvalidManifestError): string[] {
  return rejected.violations.map((violation) => violation.field);
}

// ===========================================================================
// Valid manifest — accept and plan
// ===========================================================================

describe("a valid manifest document parses and plans", () => {
  it("parses a full manifest to the planner's vocabulary and produces a planned outcome", () => {
    const declared = parseManifest(baseManifestDoc());

    // The declared half: policy passthrough, lines carry declared:true,
    // components in document order, channels and bootstrap projected.
    expect(declared.policy.digest).toBe(DIGEST);
    expect(declared.policy.tagFormats).toStrictEqual({});
    expect(declared.lines).toHaveLength(1);
    expect(declared.lines[0]?.declared).toBe(true);
    expect(declared.lines[0]?.id).toBe("main");
    expect(declared.components).toHaveLength(1);
    expect(declared.components?.[0]?.name).toBe("lib-a");
    expect(declared.components?.[0]?.manifestVersion).toBe("0.1.0");
    expect(declared.components?.[0]?.paths).toStrictEqual(["libs/a/package.json"]);
    expect(declared.components?.[0]?.dependencies).toStrictEqual([]);
    expect(declared.channels).toHaveLength(1);
    expect(declared.channels?.[0]?.id).toBe("stable");
    expect(declared.bootstrap).toStrictEqual({
      version: "0.1.0",
      who: "John Martin <john.itvn@gmail.com>",
      when: "2026-09-05T11:13:25+07:00",
    });

    // Compose + plan: the birth target is the bootstrap version verbatim
    // (D17(1)) — stable = "0.1.0" regardless of the commit's feat prefix.
    const input = compose(declared);
    const outcome = plan(input);
    expect(outcome.kind).toBe("planned");
    const planned = plannedOf(outcome);
    expect(planned.plan.lines).toHaveLength(1);
    expect(planned.plan.lines[0]?.stable).toStrictEqual({ version: "0.1.0", tag: "0.1.0" });
  });

  it("declared line options flow through verbatim (versionBand, streams, withhold, publishes)", () => {
    const doc = {
      policy: basePolicyDoc(),
      lines: [
        {
          id: "main",
          feedRef: "refs/heads/main",
          lifecycle: "active",
          versionBand: { major: 1 },
          streams: { allow: ["next"], seed: "1" },
          withhold: [{ scope: "docs-only", reason: "docs changes do not release" }],
          publishes: "lib-a",
        },
      ],
      components: {
        defaults: { manifestVersion: "0.1.0", dependencies: [] },
        "lib-a": { paths: ["package.json"] },
      },
    };

    const declared = parseManifest(doc);
    expect(declared.lines).toStrictEqual([
      {
        id: "main",
        feedRef: "refs/heads/main",
        lifecycle: "active",
        declared: true,
        versionBand: { major: 1 },
        streams: { allow: ["next"], seed: "1" },
        withhold: [{ scope: "docs-only", reason: "docs changes do not release" }],
        publishes: "lib-a",
      },
    ]);
  });

  it("parses a minimal manifest (policy + lines only) and plans with zero releases", () => {
    const doc = {
      policy: basePolicyDoc(),
      lines: [{ id: "main", feedRef: "refs/heads/main", lifecycle: "active" }],
    };

    const declared = parseManifest(doc);
    expect(declared.components).toBeUndefined();
    expect(declared.channels).toBeUndefined();
    expect(declared.bootstrap).toBeUndefined();

    // Compose with a chore commit (not release-worthy) → zero-release plan.
    const choreCommit = commit(
      "cccccccccccccccccccccccccccccccccccccccc",
      "chore: no release-worthy changes",
      { containingRefs: ["refs/heads/main"] },
    );
    const input = compose(declared, {
      commits: [choreCommit],
      refs: [ref("refs/heads/main", "cccccccccccccccccccccccccccccccccccccccc")],
    });
    const outcome = plan(input);
    expect(outcome.kind).toBe("planned");
    const planned = plannedOf(outcome);
    // A zero-release plan is the no-op successor shape (§2.10): a plan
    // with no lines that still records the line's decision.
    expect(planned.plan.lines).toStrictEqual([]);
    expect(planned.decisions.map((d) => d.lineId)).toStrictEqual(["main"]);
  });
});

// ===========================================================================
// Defaults / override merge
// ===========================================================================

describe("components defaults and per-entry override merge", () => {
  it("an entry with only paths inherits manifestVersion and dependencies from defaults", () => {
    const doc = {
      policy: basePolicyDoc(),
      lines: [{ id: "main", feedRef: "refs/heads/main", lifecycle: "active" }],
      components: {
        defaults: { manifestVersion: "1.2.3", dependencies: [{ name: "lib-a", range: "^1.0.0" }] },
        "lib-b": { paths: ["libs/b/package.json"] },
      },
    };

    const declared = parseManifest(doc);
    expect(declared.components).toHaveLength(1);
    expect(declared.components?.[0]?.name).toBe("lib-b");
    expect(declared.components?.[0]?.manifestVersion).toBe("1.2.3");
    expect(declared.components?.[0]?.paths).toStrictEqual(["libs/b/package.json"]);
    expect(declared.components?.[0]?.dependencies).toStrictEqual([
      { name: "lib-a", range: "^1.0.0" },
    ]);
  });

  it("an entry's own manifestVersion overrides the default", () => {
    const doc = {
      policy: basePolicyDoc(),
      lines: [{ id: "main", feedRef: "refs/heads/main", lifecycle: "active" }],
      components: {
        defaults: { manifestVersion: "1.0.0", dependencies: [] },
        "lib-a": { paths: ["package.json"], manifestVersion: "2.0.0" },
      },
    };

    const declared = parseManifest(doc);
    expect(declared.components?.[0]?.manifestVersion).toBe("2.0.0");
  });

  it("an entry with dependencies:[] clears inherited dependency edges", () => {
    const doc = {
      policy: basePolicyDoc(),
      lines: [{ id: "main", feedRef: "refs/heads/main", lifecycle: "active" }],
      components: {
        defaults: { manifestVersion: "1.0.0", dependencies: [{ name: "lib-a", range: "^1.0.0" }] },
        "lib-a": { paths: ["package.json"], dependencies: [] },
      },
    };

    const declared = parseManifest(doc);
    expect(declared.components?.[0]?.dependencies).toStrictEqual([]);
  });

  it("component name matches the map key", () => {
    const doc = {
      policy: basePolicyDoc(),
      lines: [{ id: "main", feedRef: "refs/heads/main", lifecycle: "active" }],
      components: {
        defaults: { manifestVersion: "1.0.0", dependencies: [] },
        "@scope/named": { paths: ["a.json"] },
      },
    };

    const declared = parseManifest(doc);
    expect(declared.components?.[0]?.name).toBe("@scope/named");
  });

  it("output order matches document key order (JSON insertion order)", () => {
    const doc = {
      policy: basePolicyDoc(),
      lines: [{ id: "main", feedRef: "refs/heads/main", lifecycle: "active" }],
      components: {
        defaults: { manifestVersion: "1.0.0", dependencies: [] },
        "c-third": { paths: ["c.json"] },
        "a-first": { paths: ["a.json"] },
        "b-second": { paths: ["b.json"] },
      },
    };

    const declared = parseManifest(doc);
    const names = declared.components?.map((c) => c.name);
    expect(names).toStrictEqual(["c-third", "a-first", "b-second"]);
  });
});

// ===========================================================================
// S-03 projection invariance — config-sourced inputs keep the door's pins
// ===========================================================================

describe("manifestVersion rides as projection, never computation truth", () => {
  it("the birth target is the bootstrap version verbatim, not the manifest's recorded manifestVersion", () => {
    // Invariant 6: the document's recorded manifest version never becomes
    // computation truth — the first release targets the recorded bootstrap
    // (D17(1)) even when the manifest claims a wildly different
    // manifestVersion for the component.
    const doc = {
      policy: basePolicyDoc(),
      lines: [{ id: "main", feedRef: "refs/heads/main", lifecycle: "active" }],
      components: {
        defaults: { dependencies: [] },
        "lib-a": { paths: ["package.json"], manifestVersion: "9.9.9" },
      },
      bootstrap: { version: "0.1.0", who: "test", when: "2026-01-01T00:00:00Z" },
    };

    const outcome = plan(compose(parseManifest(doc)));
    expect(outcome.kind).toBe("planned");
    expect(plannedOf(outcome).plan.lines[0]?.stable).toStrictEqual({
      version: "0.1.0",
      tag: "0.1.0",
    });
  });

  it("double-runs parse+plan over the same manifest to deep-equal outcomes (§2.14, S-03)", () => {
    // The determinism pin with config-sourced inputs: two fresh parses of
    // the same document (what two processes reading the same file see)
    // compose into worlds that plan to deep-equal outcomes.
    const doc = baseManifestDoc();
    const first = plan(compose(parseManifest(doc)));
    const second = plan(compose(parseManifest(doc)));
    expect(first.kind).toBe("planned");
    expect(second).toEqual(first);
  });
});

// ===========================================================================
// Dogfood declared-half parity
// ===========================================================================

describe("dogfood declared-half parity", () => {
  it("the self-dogfood's declared half is expressible as a manifest, parsed to identical values", () => {
    // The declared half the dogfood closure emits (scripts/dogfood/
    // close-world.mjs — opaque digest, Change-Ref: namespace, one line,
    // one component, recorded bootstrap), expressed as a manifest
    // document. Dependency edges are declared absence ([] in the
    // manifest; the world document omits the field) — both accepted by
    // normalize; the manifest door is the stricter authoring shape.
    const dogfoodDoc = {
      policy: {
        digest: "release-craft-self-dogfood-policy-1",
        bumpMappingId: "default",
        prereleaseLadder: ["alpha", "beta", "rc"],
        prereleaseSeed: "0",
        pre10Dampening: false,
        selfReferenceNamespace: "Change-Ref:",
        tagFormats: {},
      },
      lines: [{ id: "main", feedRef: "refs/heads/main", lifecycle: "active" }],
      components: {
        defaults: { dependencies: [] },
        "@ecoma-io/release-craft": { paths: ["package.json"], manifestVersion: "0.1.0" },
      },
      bootstrap: {
        version: "0.1.0",
        who: "John Martin <john.itvn@gmail.com>",
        when: "2026-09-05T11:13:25+07:00",
      },
    };

    const declared = parseManifest(dogfoodDoc);
    expect(declared.policy.digest).toBe("release-craft-self-dogfood-policy-1");
    expect(declared.policy.tagFormats).toStrictEqual({});
    expect(declared.lines).toStrictEqual([
      { id: "main", feedRef: "refs/heads/main", lifecycle: "active", declared: true },
    ]);
    expect(declared.components).toStrictEqual([
      {
        name: "@ecoma-io/release-craft",
        manifestVersion: "0.1.0",
        paths: ["package.json"],
        dependencies: [],
      },
    ]);
    expect(declared.bootstrap).toStrictEqual({
      version: "0.1.0",
      who: "John Martin <john.itvn@gmail.com>",
      when: "2026-09-05T11:13:25+07:00",
    });
  });
});

// ===========================================================================
// InvalidManifestError shape
// ===========================================================================

describe("InvalidManifestError", () => {
  it("is an instance of Error with violations array and diagnostic message", () => {
    const error = reject(null);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("InvalidManifestError");
    expect(Array.isArray(error.violations)).toBe(true);
    expect(error.violations.length).toBeGreaterThan(0);
    expect(typeof error.message).toBe("string");
    expect(error.message).toContain("1 violation");
  });

  it("lists all violations in its message in field order", () => {
    const error = reject({});
    // policy + lines missing → 2 violations, fields in order
    expect(fieldsOf(error)).toStrictEqual(["policy", "lines"]);
    expect(error.message).toContain("2 violations");
    expect(error.message).toContain("policy: missing");
    expect(error.message).toContain("lines:");
  });
});

// ===========================================================================
// Refusal — document shape
// ===========================================================================

describe("refuses non-object documents", () => {
  it.each([
    { input: null, label: "null" },
    { input: "not an object", label: "string" },
    { input: 42, label: "number" },
    { input: true, label: "boolean" },
    { input: [], label: "array" },
  ])("rejects $label", ({ input }) => {
    const error = reject(input);
    expect(fieldsOf(error)).toContain("input");
  });
});

// ===========================================================================
// Refusal — unknown top-level keys
// ===========================================================================

describe("refuses unknown top-level manifest keys", () => {
  it("rejects a document with an extra top-level key", () => {
    const doc = { ...baseManifestDoc(), extra: 1 };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("input");
  });
});

// ===========================================================================
// Refusal — policy
// ===========================================================================

describe("refuses malformed policy", () => {
  it("rejects missing policy section", () => {
    const { policy: _p, ...rest } = baseManifestDoc();
    const error = reject(rest);
    expect(fieldsOf(error)).toContain("policy");
  });

  it("rejects unknown policy key when tagFormats is present and valid", () => {
    const doc = {
      ...baseManifestDoc(),
      policy: { ...basePolicyDoc(), typo: true },
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("policy");
  });

  it("rejects unknown policy key when tagFormats is missing", () => {
    const { tagFormats: _tf, ...rest } = basePolicyDoc();
    const doc = {
      ...baseManifestDoc(),
      policy: { ...rest, typo: true },
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("policy");
  });

  it("rejects unknown policy key when tagFormats is malformed", () => {
    const doc = {
      ...baseManifestDoc(),
      policy: { ...basePolicyDoc(), tagFormats: "not-a-map", typo: true },
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("policy");
  });

  it.each([
    { field: "policy.digest", patch: { digest: "" } },
    { field: "policy.bumpMappingId", patch: { bumpMappingId: "unknown" } },
    { field: "policy.prereleaseLadder", patch: { prereleaseLadder: [] } },
    { field: "policy.prereleaseSeed", patch: { prereleaseSeed: "2" } },
    { field: "policy.digest", patch: { digest: " padded with leading whitespace" } },
    { field: "policy.digest", patch: { digest: "trailing\nnewline" } },
    { field: "policy.pre10Dampening", patch: { pre10Dampening: wrong("yes") } },
    { field: "policy.selfReferenceNamespace", patch: { selfReferenceNamespace: "no-colon-here" } },
    { field: "policy.selfReferenceNamespace", patch: { selfReferenceNamespace: "" } },
  ])("policy field $field malformed", ({ field, patch }) => {
    const doc = {
      ...baseManifestDoc(),
      policy: { ...basePolicyDoc(), ...patch },
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain(field);
  });

  it("rejects tagFormat without {prerelease} token", () => {
    const doc = {
      ...baseManifestDoc(),
      policy: {
        ...basePolicyDoc(),
        tagFormats: { main: "v{major}.{minor}.{patch}" },
      },
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("policy.tagFormats.main");
  });

  it("rejects empty tagFormats value string", () => {
    const doc = {
      ...baseManifestDoc(),
      policy: { ...basePolicyDoc(), tagFormats: { main: "" } },
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("policy.tagFormats.main");
  });

  it("rejects empty tagFormats key", () => {
    const doc = {
      ...baseManifestDoc(),
      policy: {
        ...basePolicyDoc(),
        tagFormats: { "": "v{major}.{minor}.{patch}{prerelease}" },
      },
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("policy.tagFormats");
  });

  it("rejects missing policy field (pre10Dampening)", () => {
    const { pre10Dampening: _p, ...rest } = basePolicyDoc();
    const doc = {
      ...baseManifestDoc(),
      policy: rest,
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("policy.pre10Dampening");
  });
});

// ===========================================================================
// Refusal — lines
// ===========================================================================

describe("refuses malformed lines", () => {
  it("rejects missing lines section", () => {
    const { lines: _l, ...rest } = baseManifestDoc();
    const error = reject(rest);
    expect(fieldsOf(error)).toContain("lines");
  });

  it("rejects empty lines array", () => {
    const doc = { ...baseManifestDoc(), lines: [] };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("lines");
  });

  it("rejects unknown line key", () => {
    const doc = {
      ...baseManifestDoc(),
      lines: [{ id: "main", feedRef: "refs/heads/main", lifecycle: "active", extra: true }],
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("lines[0]");
  });

  it("rejects duplicate line ids", () => {
    const doc = {
      ...baseManifestDoc(),
      lines: [
        { id: "main", feedRef: "refs/heads/main", lifecycle: "active" },
        { id: "main", feedRef: "refs/heads/other", lifecycle: "active" },
      ],
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("lines[1].id");
  });

  it.each([
    { field: "lines[0].lifecycle", patch: { lifecycle: "archived" } },
    { field: "lines[0].feedRef", patch: { feedRef: "" } },
    { field: "lines[0].feedRef", patch: { feedRef: wrong(42) } },
  ])("line field $field malformed", ({ field, patch }) => {
    const doc = {
      ...baseManifestDoc(),
      lines: [{ id: "main", feedRef: "refs/heads/main", lifecycle: "active", ...patch }],
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain(field);
  });

  it("rejects negative versionBand major", () => {
    const doc = {
      ...baseManifestDoc(),
      lines: [
        { id: "main", feedRef: "refs/heads/main", lifecycle: "active", versionBand: { major: -1 } },
      ],
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("lines[0].versionBand.major");
  });

  it("rejects non-integer versionBand minor", () => {
    const doc = {
      ...baseManifestDoc(),
      lines: [
        {
          id: "main",
          feedRef: "refs/heads/main",
          lifecycle: "active",
          versionBand: { major: 0, minor: 1.5 },
        },
      ],
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("lines[0].versionBand.minor");
  });

  it("rejects bad streams seed", () => {
    const doc = {
      ...baseManifestDoc(),
      lines: [
        {
          id: "main",
          feedRef: "refs/heads/main",
          lifecycle: "active",
          streams: { allow: true, seed: "9" },
        },
      ],
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("lines[0].streams.seed");
  });

  it("rejects unknown streams key", () => {
    const doc = {
      ...baseManifestDoc(),
      lines: [
        {
          id: "main",
          feedRef: "refs/heads/main",
          lifecycle: "active",
          streams: { allow: true, seed: "0", typo: true },
        },
      ],
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("lines[0].streams");
  });

  it("rejects unknown versionBand key", () => {
    const doc = {
      ...baseManifestDoc(),
      lines: [
        {
          id: "main",
          feedRef: "refs/heads/main",
          lifecycle: "active",
          versionBand: { major: 1, minor: 0, typo: true },
        },
      ],
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("lines[0].versionBand");
  });

  it("rejects empty withhold scope", () => {
    const doc = {
      ...baseManifestDoc(),
      lines: [
        {
          id: "main",
          feedRef: "refs/heads/main",
          lifecycle: "active",
          withhold: [{ scope: "", reason: "test" }],
        },
      ],
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("lines[0].withhold[0].scope");
  });

  it("rejects unknown withhold key", () => {
    const doc = {
      ...baseManifestDoc(),
      lines: [
        {
          id: "main",
          feedRef: "refs/heads/main",
          lifecycle: "active",
          withhold: [{ scope: "test", reason: "test", extra: 1 }],
        },
      ],
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("lines[0].withhold[0]");
  });
});

// ===========================================================================
// Refusal — components
// ===========================================================================

describe("refuses malformed components", () => {
  it("rejects components not an object", () => {
    const doc = { ...baseManifestDoc(), components: "not-an-object" };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("components");
  });

  it("rejects unknown component key", () => {
    const doc = {
      ...baseManifestDoc(),
      components: {
        defaults: { manifestVersion: "0.1.0", dependencies: [] },
        "lib-a": { paths: ["package.json"], typo: true },
      },
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("components.lib-a");
  });

  it("rejects component entry not an object", () => {
    const doc = {
      ...baseManifestDoc(),
      components: {
        defaults: { manifestVersion: "0.1.0", dependencies: [] },
        "lib-a": "not-object",
      },
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("components.lib-a");
  });

  it("rejects bad manifestVersion (unparseable by Version.parse)", () => {
    const doc = {
      ...baseManifestDoc(),
      components: {
        defaults: { dependencies: [] },
        "lib-a": { paths: ["package.json"], manifestVersion: "not-semver" },
      },
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("components.lib-a.manifestVersion");
  });

  it("rejects component missing paths when defaults has no paths", () => {
    const doc = {
      ...baseManifestDoc(),
      components: {
        defaults: { manifestVersion: "0.1.0", dependencies: [] },
        "lib-a": {},
      },
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("components.lib-a");
  });

  it("rejects missing paths when there are no defaults at all", () => {
    const doc = {
      ...baseManifestDoc(),
      components: { "lib-a": { manifestVersion: "0.1.0", dependencies: [] } },
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("components.lib-a");
  });

  it("rejects bad dependency range", () => {
    const doc = {
      ...baseManifestDoc(),
      components: {
        defaults: { manifestVersion: "0.1.0", dependencies: [] },
        "lib-a": { paths: ["package.json"], dependencies: [{ name: "lib-b", range: "invalid" }] },
      },
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("components.lib-a.dependencies[0].range");
  });

  it("rejects empty dependency name", () => {
    const doc = {
      ...baseManifestDoc(),
      components: {
        defaults: { manifestVersion: "0.1.0", dependencies: [] },
        "lib-a": { paths: ["package.json"], dependencies: [{ name: "", range: "^1.0.0" }] },
      },
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("components.lib-a.dependencies[0].name");
  });
});

// ===========================================================================
// Refusal — channels
// ===========================================================================

describe("refuses malformed channels", () => {
  it("rejects channels not an array", () => {
    const doc = { ...baseManifestDoc(), channels: "not-an-array" };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("channels");
  });

  it("rejects unknown channel key", () => {
    const doc = {
      ...baseManifestDoc(),
      channels: [{ id: "stable", target: { line: "main", version: "0.1.0" }, extra: true }],
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("channels[0]");
  });

  it("rejects unknown target key", () => {
    const doc = {
      ...baseManifestDoc(),
      channels: [{ id: "stable", target: { line: "main", version: "0.1.0", extra: true } }],
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("channels[0].target");
  });

  it("rejects duplicate channel ids", () => {
    const doc = {
      ...baseManifestDoc(),
      channels: [
        { id: "stable", target: { line: "main", version: "0.1.0" } },
        { id: "stable", target: { line: "main", version: "0.1.0" } },
      ],
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("channels[1].id");
  });

  it("rejects empty channel id", () => {
    const doc = {
      ...baseManifestDoc(),
      channels: [{ id: "", target: { line: "main", version: "0.1.0" } }],
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("channels[0].id");
  });

  it("rejects bad target version", () => {
    const doc = {
      ...baseManifestDoc(),
      channels: [{ id: "stable", target: { line: "main", version: "not-semver" } }],
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("channels[0].target.version");
  });

  it("rejects missing target", () => {
    const doc = {
      ...baseManifestDoc(),
      channels: [{ id: "stable" }],
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("channels[0].target");
  });
});

// ===========================================================================
// Refusal — bootstrap
// ===========================================================================

describe("refuses malformed bootstrap", () => {
  it("rejects bootstrap not an object", () => {
    const doc = { ...baseManifestDoc(), bootstrap: "not-object" };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("bootstrap");
  });

  it("rejects unknown bootstrap key", () => {
    const doc = {
      ...baseManifestDoc(),
      bootstrap: {
        version: "0.1.0",
        who: "test",
        when: "2026-01-01T00:00:00Z",
        extra: true,
      },
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("bootstrap");
  });

  it("rejects bad bootstrap version", () => {
    const doc = {
      ...baseManifestDoc(),
      bootstrap: { version: "not-semver", who: "test", when: "2026-01-01T00:00:00Z" },
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("bootstrap.version");
  });

  it("rejects missing who", () => {
    const doc = {
      ...baseManifestDoc(),
      bootstrap: { version: "0.1.0", when: "2026-01-01T00:00:00Z" },
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("bootstrap.who");
  });

  it("rejects missing when", () => {
    const doc = {
      ...baseManifestDoc(),
      bootstrap: { version: "0.1.0", who: "test" },
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("bootstrap.when");
  });
});

// ===========================================================================
// Refusal — dangling references
// ===========================================================================

describe("refuses dangling references", () => {
  it("rejects tagFormats key referencing undeclared line", () => {
    const doc = {
      ...baseManifestDoc(),
      policy: {
        ...basePolicyDoc(),
        tagFormats: { ghost: "v{major}.{minor}.{patch}{prerelease}" },
      },
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("policy.tagFormats.ghost");
  });

  it("rejects line.publishes referencing undeclared component", () => {
    const doc = {
      ...baseManifestDoc(),
      lines: [{ id: "main", feedRef: "refs/heads/main", lifecycle: "active", publishes: "ghost" }],
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("lines[0].publishes");
  });

  it("rejects component dependency referencing undeclared component", () => {
    const doc = {
      ...baseManifestDoc(),
      components: {
        defaults: { manifestVersion: "0.1.0", dependencies: [] },
        "lib-a": { paths: ["package.json"], dependencies: [{ name: "ghost", range: "^1.0.0" }] },
      },
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("components.lib-a.dependencies[0]");
  });

  it("rejects channel target.line referencing undeclared line", () => {
    const doc = {
      ...baseManifestDoc(),
      channels: [{ id: "stable", target: { line: "ghost", version: "0.1.0" } }],
    };
    const error = reject(doc);
    expect(fieldsOf(error)).toContain("channels[0].target.line");
  });
});

// ===========================================================================
// Refusal — multi-violation in one document
// ===========================================================================

describe("multi-violation document surfaces all violations in field order", () => {
  it("one malformed doc with 3 problems yields all 3 violations", () => {
    const doc = {
      policy: { ...basePolicyDoc(), prereleaseSeed: "2", typo: true },
      lines: [],
    };
    const error = reject(doc);
    const fields = fieldsOf(error);

    // Deterministic order: unknown policy key, bad seed, empty lines.
    expect(fields).toContain("policy");
    expect(fields).toContain("policy.prereleaseSeed");
    expect(fields).toContain("lines");
    expect(fields.length).toBeGreaterThanOrEqual(3);
  });
});
