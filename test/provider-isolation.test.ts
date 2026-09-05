import { describe, expect, it } from "vitest";
import * as surface from "../src/index.ts";
import { Artifact, Change, ChangeSet, Channel, ReleaseLine, Version } from "../src/index.ts";

/**
 * Provider isolation, executable — invariant 15's kernel half made
 * runnable, as the adversarial Phase 0 review demanded (release-model.md:
 * "the kernel half holds by inspection of `Version` today and must be
 * asserted by Phase 1's tests for every new value"). ADR-0001's import ban
 * polices what the kernel imports; nothing polices what it *names*. This
 * suite is that something: for every exported value class, no field name —
 * the value's own, and one bounded walk into its object fields — may be
 * provider vocabulary. A field that could carry provider state
 * (`branch`, `ref`, `pullRequest`, `distTag`, `registry`, `runner`,
 * `workflow`, …) is how the invariant would be violated structurally; its
 * absence is what "the kernel names no provider state" means.
 *
 * The subject is names, not values: an `Artifact`'s opaque coordinates may
 * legitimately read `ghcr.io/x/app:2.0.0` (AR-03 — coordinates are labels
 * the kernel never parses, compares, or dereferences); what the invariant
 * forbids is a field that would hold a branch name or a PR number as
 * state.
 */

/**
 * The provider vocabulary invariant 15 refuses, normalized for comparison:
 * camelCase and kebab-case collapse onto one form (`distTag`/`dist-tag` →
 * `disttag`, `pullRequest` → `pullrequest`).
 */
const PROVIDER_TOKENS = [
  "branch",
  "ref",
  "pr",
  "pull",
  "pullrequest",
  "github",
  "disttag",
  "registry",
  "runner",
  "workflow",
] as const;

/**
 * `pr` is matched as a whole name or a whole word part, never as a bare
 * substring: `prerelease` is the vocabulary lock's own term (SemVer's,
 * invariant 8's — `PrereleaseStreamState`), not provider state, and a
 * substring rule would condemn the kernel's correct name. Word-part matching
 * still catches `prNumber`/`pr_number`/`pr-number` — case and separators are
 * spelling, not meaning. Every other token is unambiguous enough to refuse
 * as a substring too (`branchName`, `registryUrl`, `refKind` are all
 * provider concepts arriving in pieces).
 */
const WHOLE_WORD_ONLY = new Set(["pr"]);

/** One field name in normal form: lower-cased, non-alphanumerics stripped. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * One field name split into word parts at camelCase and separator
 * boundaries: `prNumber`/`pr_number`/`pr-number`/`PR NUMBER` all yield
 * ["pr", "number"]. A whole-word match on any part is a violation however
 * the boundary was spelled.
 */
function partsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The provider tokens `name` violates, as a whole name, a word part, or a substring. */
function providerVocabularyIn(name: string): string[] {
  const normalized = normalize(name);
  const parts = partsOf(name);
  return PROVIDER_TOKENS.filter(
    (token) =>
      normalized === token ||
      parts.includes(token) ||
      (!WHOLE_WORD_ONLY.has(token) && normalized.includes(token)),
  );
}

/**
 * Every property name a provider could reach on the value: its own names
 * (enumerable or not) and symbols, the accessor and method names on its
 * prototype chain down to `Object.prototype`, plus one bounded walk into
 * its object and array fields. Three levels deep covers every kernel
 * value's actual shape — `ChangeSet.changes[] → Change → lineage`,
 * `ReleaseLine.streams[] → state → target` — so a nested provider field
 * cannot hide one layer down. A prototype getter is state (`line.released`
 * reads one), so its name belongs in the harvest; `Object.keys` alone is
 * blind to non-enumerable names and accessors alike. True `#private` fields
 * are not properties at all — no property walk reaches them, and neither
 * could provider-adjacent code without the class body.
 */
function fieldNames(value: unknown, depth = 0): string[] {
  if (depth > 3 || value === null || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((element) => fieldNames(element, depth + 1));
  }
  const record = value as Record<string, unknown>;
  const own = Object.getOwnPropertyNames(record);
  const symbols = Object.getOwnPropertySymbols(record).map((symbol) => String(symbol));
  const prototypeNames: string[] = [];
  let proto: unknown = Object.getPrototypeOf(record);
  while (proto !== null && proto !== Object.prototype) {
    prototypeNames.push(...Object.getOwnPropertyNames(proto));
    for (const symbol of Object.getOwnPropertySymbols(proto)) {
      prototypeNames.push(String(symbol));
    }
    proto = Object.getPrototypeOf(proto);
  }
  const nested = own.flatMap((key) => fieldNames(record[key], depth + 1));
  return [...own, ...symbols, ...prototypeNames, ...nested];
}

/** The provider tokens found anywhere in one value's harvested field names. */
function offendersIn(names: string[]): string[] {
  const offenders = new Set<string>();
  for (const name of names) {
    for (const token of providerVocabularyIn(name)) {
      offenders.add(`${token} (in "${name}")`);
    }
  }
  return [...offenders].sort();
}

/** One representative instance per exported value class, at its richest. */
function representatives(): Array<[string, object]> {
  const change = Change.of("chg:F", { parent: "chg:E", originCommit: "aaa111", originLine: "1.9" });
  const line = ReleaseLine.create("1.x")
    .withReleased(Version.parse("1.9.0"))
    .advanceStream(Version.parse("1.10.0"), "alpha")
    .freeze();

  return [
    ["Version", Version.parse("1.0.0-rc.1+build.2")],
    ["Change", change],
    ["ChangeSet", ChangeSet.of([change], "patch")],
    ["ReleaseLine", line],
    ["Channel", Channel.of("stable", { line: "1.x", version: Version.parse("1.9.0") })],
    ["Artifact", Artifact.of("npm", "ghcr.io/x/app:2.0.0", "sha256:9f2c4a1e")],
  ];
}

describe("invariant 15, kernel half — no value's fields name provider state", () => {
  for (const [name, value] of representatives()) {
    it(`carries no provider vocabulary in ${name}'s field names`, () => {
      expect(offendersIn(fieldNames(value))).toEqual([]);
    });
  }

  it("harvests real field names — the assertions above judge a non-empty set", () => {
    // The walker's own sanity: it must reach the deepest kernel fields
    // (lineage inside a Change inside a ChangeSet; a stream record's
    // target), or the per-value assertions would be vacuously green over
    // an empty harvest.
    const [, changeSet] = representatives().find(([name]) => name === "ChangeSet") as [
      string,
      object,
    ];
    const [, line] = representatives().find(([name]) => name === "ReleaseLine") as [string, object];

    const changeSetFields = fieldNames(changeSet);
    for (const expected of ["changes", "id", "lineage", "originLine"]) {
      expect(changeSetFields).toContain(expected);
    }

    const lineFields = fieldNames(line);
    for (const expected of [
      "id",
      "lifecycle",
      "released",
      "streams",
      "target",
      "identifier",
      "sequence",
    ]) {
      expect(lineFields).toContain(expected);
    }

    // The prototype walk must reach accessor names too — `Version` exposes
    // `prerelease` and `build` as prototype getters, invisible to an
    // own-enumerable-only walk.
    expect(fieldNames(Version.parse("1.0.0-rc.1+b.2"))).toContain("prerelease");
    expect(fieldNames(Version.parse("1.0.0-rc.1+b.2"))).toContain("build");
  });

  it("catches provider vocabulary arriving in pieces — the matcher's own contract", () => {
    // The matcher this suite stands on: `prNumber` escapes a substring rule
    // that exempts `pr` for `prerelease`'s sake, and word-part matching is
    // what closes it — without condemning `prerelease` itself.
    expect(providerVocabularyIn("prNumber")).toEqual(["pr"]);
    expect(providerVocabularyIn("pr_number")).toEqual(["pr"]);
    expect(providerVocabularyIn("branchName")).toEqual(["branch"]);
    expect(providerVocabularyIn("distTag")).toEqual(["disttag"]);
    expect(providerVocabularyIn("prerelease")).toEqual([]);
    expect(providerVocabularyIn("streamPrerelease")).toEqual([]);
  });

  it("exports no provider vocabulary from the package surface", () => {
    // The seam's names matter as much as the fields: a provider-named
    // export would be a provider concept entering the kernel's contract.
    const exportNames = Object.keys(surface);

    expect(exportNames.length).toBeGreaterThan(0);
    expect(offendersIn(exportNames)).toEqual([]);
  });
});
