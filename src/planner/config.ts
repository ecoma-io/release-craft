/**
 * The manifest configuration door (issue #204): parses a closed, authored
 * configuration document into the planner's own vocabulary.
 *
 * Two exits:
 * 1. `InvalidManifestError` — the manifest is malformed, contains unknown
 *    keys, or has dangling component/line references. Every violation carries
 *    a named field and a readable problem string (same vocabulary as
 *    `InvalidPlanningInputError`), surfaced together so a second malformed
 *    manifest fixes one round-trip. Never absorbed into defaults.
 * 2. `ManifestInput` — a declared half of `PlanningInput`: `{ ...declared,
 *    repository, history }` → `plan()`. The ADR-0004 deterministic door
 *    re-validates; this is the *authoring* door that surfaces doc-level
 *    problems (dangling refs, closed-schema checks) early.
 *
 * §2.1.a contract — config reuses the planner's own vocabulary (the manifest
 * keys ARE the planner field names, no invented aliases); unknown keys are
 * refused; `declared: true` is emitted for every line; component
 * `manifestVersion` rides as a projection (invariant 6).
 *
 * Module boundary: `src/planner/config.ts` imports ONLY `./types.js`,
 * `InputViolation` from `./input.js`, and `Version` from the domain barrel —
 * isolation test gate (ADR-0001 §4).
 */

import type {
  BootstrapDecision,
  ChannelObservation,
  ComponentMeta,
  LineConfig,
  ManifestDependency,
  ManifestInput,
  PolicyInput,
} from "./types.js";

import type { InputViolation } from "./input.js";
import { Version } from "@ecoma-io/release-craft/domain";

// ---------------------------------------------------------------------------
// §2.1.a — InvalidManifestError
// ---------------------------------------------------------------------------

/** "Malformed manifest" — the authoring door's own refusal, distinct from
 * the planner door's `InvalidPlanningInputError`. Same violation shape for
 * tooling consistency, but a distinct name so diagnostics never confuse the
 * two doors. */
export class InvalidManifestError extends Error {
  override readonly name = "InvalidManifestError";
  /** Every violation the manifest door surfaced, in the order the schema
   * was traversed (deterministic — the same document always yields the
   * same field/problem pairs in the same order). */
  readonly violations: readonly InputViolation[];
  constructor(violations: readonly InputViolation[]) {
    super(
      `invalid manifest — ${String(violations.length)} violation${violations.length === 1 ? "" : "s"}: ${violations.map((v) => `${v.field}: ${v.problem}`).join("; ")}`,
    );
    Object.defineProperty(this, "name", { value: "InvalidManifestError" });
    this.violations = violations;
  }
}

// ---------------------------------------------------------------------------
// §2.1.a — internal value predicates
// ---------------------------------------------------------------------------

const COMPONENT_ENTRY_KEYS = new Set(["paths", "manifestVersion", "dependencies"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Runtime shape guard for the arrays the traversal walks — narrows to
 * `readonly unknown[]`, never `any[]`, so element access stays `unknown`
 * (the input seam's lint posture). */
const isArray = (v: unknown): v is readonly unknown[] => Array.isArray(v);

const isNonNegInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

const parsesAsVersion = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  try {
    Version.parse(v);
    return true;
  } catch {
    return false;
  }
};

const isValidRangeExpression = (v: unknown): boolean => {
  if (typeof v !== "string" || v === "") return false;
  try {
    Version.parse(v.startsWith("^") || v.startsWith("~") ? v.slice(1) : v);
    return true;
  } catch {
    return false;
  }
};

const isNonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

// ---------------------------------------------------------------------------
// §2.1.a — policy validation (mirrors input.ts checkPolicy §2.6, §2.8)
// ---------------------------------------------------------------------------

function checkPolicy(policy: unknown, add: (field: string, problem: string) => void): void {
  if (!isObject(policy)) {
    add("policy", "must be an object");
    return;
  }

  if (!("digest" in policy)) add("policy.digest", "missing");
  else if (!isNonEmptyStr(policy.digest)) add("policy.digest", "must be a non-empty string");
  else if (policy.digest.includes("\n") || policy.digest !== policy.digest.trim())
    add("policy.digest", "must not contain newlines or leading/trailing whitespace");

  if (!("bumpMappingId" in policy)) add("policy.bumpMappingId", "missing");
  else if (policy.bumpMappingId !== "default")
    add("policy.bumpMappingId", `must be "default" (got ${JSON.stringify(policy.bumpMappingId)})`);

  // Independent of bumpMappingId (mirrors input.ts checkPolicy §2.8): the
  // ladder is checked on its own so a malformed or missing ladder is
  // reported even when the mapping id is not "default" — one round-trip.
  if (!isArray(policy.prereleaseLadder) || policy.prereleaseLadder.length === 0)
    add("policy.prereleaseLadder", "must be a non-empty array of strings");
  else {
    for (const rung of policy.prereleaseLadder) {
      if (!isNonEmptyStr(rung))
        add("policy.prereleaseLadder", "each rung must be a non-empty string");
    }
  }

  if (!("prereleaseSeed" in policy)) add("policy.prereleaseSeed", "missing");
  else if (policy.prereleaseSeed !== "0" && policy.prereleaseSeed !== "1")
    add(
      "policy.prereleaseSeed",
      `must be "0" or "1" (got ${JSON.stringify(policy.prereleaseSeed)})`,
    );

  if (!("pre10Dampening" in policy)) add("policy.pre10Dampening", "missing");
  else if (typeof policy.pre10Dampening !== "boolean")
    add("policy.pre10Dampening", `must be a boolean (got ${typeof policy.pre10Dampening})`);

  if (!("selfReferenceNamespace" in policy)) add("policy.selfReferenceNamespace", "missing");
  else if (!isNonEmptyStr(policy.selfReferenceNamespace))
    add("policy.selfReferenceNamespace", "must be a non-empty string");
  else if (!policy.selfReferenceNamespace.endsWith(":"))
    add("policy.selfReferenceNamespace", "must end with ':'");

  if (!("tagFormats" in policy)) add("policy.tagFormats", "missing");
  else if (!isObject(policy.tagFormats))
    add("policy.tagFormats", "must be a map of line-id → format string");

  // refuse unknown policy keys (closed schema) — hoisted out of the
  // tagFormats branch so a missing/malformed tagFormats cannot hide them
  const known = new Set([
    "digest",
    "bumpMappingId",
    "prereleaseLadder",
    "prereleaseSeed",
    "pre10Dampening",
    "selfReferenceNamespace",
    "tagFormats",
  ]);
  for (const key of Object.keys(policy)) {
    if (!known.has(key)) add("policy", `unknown policy key ${JSON.stringify(key)}`);
  }
}

// Dangling tagFormats check (requires lineIds — done after line parsing)
function checkTagFormatsDangling(
  policy: unknown,
  lineIds: ReadonlySet<string>,
  add: (field: string, problem: string) => void,
): void {
  if (!isObject(policy) || !isObject(policy.tagFormats)) return;
  for (const [key, val] of Object.entries(policy.tagFormats)) {
    if (key === "") add("policy.tagFormats", "key must be a non-empty string");
    else if (!isNonEmptyStr(val))
      add(`policy.tagFormats.${key}`, "value must be a non-empty string");
    else if (!val.includes("{prerelease}"))
      add(`policy.tagFormats.${key}`, "must contain the {prerelease} token");
    if (key !== "" && !lineIds.has(key))
      add(`policy.tagFormats.${key}`, `references undeclared line ${JSON.stringify(key)}`);
  }
}

// ---------------------------------------------------------------------------
// §2.1.a — line validation (mirrors input.ts checkLines §2.4)
// ---------------------------------------------------------------------------
function checkLines(lines: unknown, add: (field: string, problem: string) => void): LineConfig[] {
  if (!isArray(lines)) {
    add("lines", "must be an array");
    return [];
  }
  if (lines.length === 0) {
    add("lines", "must declare at least one release line");
    return [];
  }

  const result: LineConfig[] = [];
  const seenIds = new Set<string>();
  for (const [i, line] of lines.entries()) {
    const pfx = `lines[${String(i)}]`;
    if (!isObject(line)) {
      add(pfx, "must be an object");
      continue;
    }

    // id — required, non-empty, unique
    const id = line.id;
    if (!isNonEmptyStr(id)) add(`${pfx}.id`, "must be a non-empty string");
    else if (seenIds.has(id)) add(`${pfx}.id`, `duplicate line id ${JSON.stringify(id)}`);
    else seenIds.add(id);

    // feedRef — required, non-empty
    if (!("feedRef" in line)) add(`${pfx}.feedRef`, "missing");
    else if (!isNonEmptyStr(line.feedRef)) add(`${pfx}.feedRef`, "must be a non-empty string");

    // lifecycle — required, enum
    if (!("lifecycle" in line)) add(`${pfx}.lifecycle`, "missing");
    else if (
      line.lifecycle !== "active" &&
      line.lifecycle !== "frozen" &&
      line.lifecycle !== "retired"
    )
      add(
        `${pfx}.lifecycle`,
        `must be "active", "frozen", or "retired" (got ${JSON.stringify(line.lifecycle)})`,
      );

    // versionBand — optional; { major: non-neg-int, minor?: non-neg-int }
    if ("versionBand" in line) {
      const vb = line.versionBand;
      if (!isObject(vb)) {
        add(`${pfx}.versionBand`, "must be an object");
      } else {
        if (!("major" in vb)) add(`${pfx}.versionBand.major`, "missing");
        else if (!isNonNegInt(vb.major))
          add(`${pfx}.versionBand.major`, "must be a non-negative integer");
        if ("minor" in vb && !isNonNegInt(vb.minor))
          add(`${pfx}.versionBand.minor`, "must be a non-negative integer");
        for (const k of Object.keys(vb)) {
          if (k !== "major" && k !== "minor")
            add(`${pfx}.versionBand`, `unknown versionBand key ${JSON.stringify(k)}`);
        }
      }
    }

    // streams — optional; { allow: "all"|"none"|string[] unique, seed: "0"|"1" }
    if ("streams" in line) {
      const st = line.streams;
      if (!isObject(st)) {
        add(`${pfx}.streams`, "must be an object");
      } else {
        if (!("allow" in st)) add(`${pfx}.streams.allow`, "missing");
        else if (
          st.allow !== "all" &&
          st.allow !== "none" &&
          !(isArray(st.allow) && st.allow.length > 0)
        )
          add(`${pfx}.streams.allow`, 'must be "all", "none", or a non-empty array of unique ids');
        else if (isArray(st.allow)) {
          const sids = new Set<string>();
          for (const sid of st.allow) {
            if (!isNonEmptyStr(sid))
              add(`${pfx}.streams.allow`, "each id must be a non-empty string");
            else if (sids.has(sid))
              add(`${pfx}.streams.allow`, `duplicate stream id ${JSON.stringify(sid)}`);
            else sids.add(sid);
          }
        }
        if ("seed" in st && st.seed !== "0" && st.seed !== "1")
          add(`${pfx}.streams.seed`, `must be "0" or "1" (got ${JSON.stringify(st.seed)})`);
        for (const k of Object.keys(st)) {
          if (k !== "allow" && k !== "seed")
            add(`${pfx}.streams`, `unknown streams key ${JSON.stringify(k)}`);
        }
      }
    }

    // withhold — optional array; each { scope, reason } non-empty
    if ("withhold" in line) {
      if (!isArray(line.withhold)) add(`${pfx}.withhold`, "must be an array");
      else {
        for (const [j, r] of line.withhold.entries()) {
          const rpfx = `${pfx}.withhold[${String(j)}]`;
          if (!isObject(r)) {
            add(rpfx, "must be an object");
            continue;
          }
          if (!isNonEmptyStr(r.scope)) add(`${rpfx}.scope`, "must be a non-empty string");
          if (!isNonEmptyStr(r.reason)) add(`${rpfx}.reason`, "must be a non-empty string");
          for (const key of Object.keys(r)) {
            if (key !== "scope" && key !== "reason")
              add(rpfx, `unknown withhold key ${JSON.stringify(key)}`);
          }
        }
      }
    }

    // publishes — optional; when present must be a non-empty component
    // name. The dangling reference check is deferred to parseManifest
    // step 5, where the full declared component set is known (checkLines
    // receives no component names — the map is parsed after the lines).
    if ("publishes" in line && !isNonEmptyStr(line.publishes))
      add(`${pfx}.publishes`, "must be a non-empty component name");

    // refuse unknown line keys (closed schema)
    const knownLineKeys = new Set([
      "id",
      "feedRef",
      "lifecycle",
      "versionBand",
      "streams",
      "withhold",
      "publishes",
    ]);
    for (const key of Object.keys(line)) {
      if (!knownLineKeys.has(key)) add(pfx, `unknown line key ${JSON.stringify(key)}`);
    }

    // Build the LineConfig (declared: true — §2.1.a) if structural checks
    // pass; optional fields join via conditional spread (readonly shape).
    if (!isNonEmptyStr(id) || !isNonEmptyStr(line.feedRef)) continue;
    if (line.lifecycle !== "active" && line.lifecycle !== "frozen" && line.lifecycle !== "retired")
      continue;

    const vb: { major: number; minor?: number } | undefined =
      "versionBand" in line && isObject(line.versionBand) && isNonNegInt(line.versionBand.major)
        ? {
            major: line.versionBand.major,
            ...("minor" in line.versionBand && isNonNegInt(line.versionBand.minor)
              ? { minor: line.versionBand.minor }
              : {}),
          }
        : undefined;

    const rawStreams = "streams" in line && isObject(line.streams) ? line.streams : undefined;
    const rawAllow = rawStreams?.allow;
    const allow: "all" | "none" | readonly string[] | undefined =
      rawAllow === "all" || rawAllow === "none"
        ? rawAllow
        : Array.isArray(rawAllow) && rawAllow.every(isNonEmptyStr)
          ? rawAllow
          : undefined;
    const seed: "0" | "1" | undefined =
      rawStreams?.seed === "0" || rawStreams?.seed === "1" ? rawStreams.seed : undefined;
    const streams: LineConfig["streams"] =
      allow !== undefined || seed !== undefined
        ? {
            ...(allow !== undefined ? { allow } : {}),
            ...(seed !== undefined ? { seed } : {}),
          }
        : undefined;

    const withhold = Array.isArray(line.withhold)
      ? line.withhold
          .filter(
            (r): r is { scope: string; reason: string } =>
              isObject(r) && isNonEmptyStr(r.scope) && isNonEmptyStr(r.reason),
          )
          .map((r) => ({ scope: r.scope, reason: r.reason }))
      : undefined;

    const publishes =
      "publishes" in line && isNonEmptyStr(line.publishes) ? line.publishes : undefined;

    result.push({
      id,
      feedRef: line.feedRef,
      lifecycle: line.lifecycle,
      declared: true,
      ...(vb !== undefined ? { versionBand: vb } : {}),
      ...(streams !== undefined ? { streams } : {}),
      ...(withhold !== undefined ? { withhold } : {}),
      ...(publishes !== undefined ? { publishes } : {}),
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// §2.1.a — component validation (packages-map, baseline §5.2)
// ---------------------------------------------------------------------------
function checkComponents(
  components: unknown,
  add: (field: string, problem: string) => void,
): readonly ComponentMeta[] {
  // components is an optional section — absent means no declared components.
  if (components === undefined) return [];
  if (!isObject(components)) {
    add("components", "must be an object (packages-map pattern)");
    return [];
  }

  const rawDefaults = "defaults" in components ? components.defaults : undefined;
  const entries = Object.entries(components).filter(([k]) => k !== "defaults");

  // Validate defaults block (optional — per-field inheritance)
  let defPaths: readonly string[] | undefined;
  let defVersion: string | undefined;
  let defDeps: readonly ManifestDependency[] | undefined;

  if (rawDefaults !== undefined) {
    if (!isObject(rawDefaults)) {
      add("components.defaults", "must be an object");
    } else {
      for (const k of Object.keys(rawDefaults)) {
        if (!COMPONENT_ENTRY_KEYS.has(k))
          add("components.defaults", `unknown component key ${JSON.stringify(k)}`);
      }
      // Validate defaults fields only when present — entries inherit from
      // defaults, so a defaults without paths is legal (entries provide them).
      if ("paths" in rawDefaults)
        defPaths = validatePathsField("components.defaults.paths", rawDefaults.paths, add);
      if ("manifestVersion" in rawDefaults)
        defVersion = validateVersionField(
          "components.defaults.manifestVersion",
          rawDefaults.manifestVersion,
          add,
        );
      if ("dependencies" in rawDefaults)
        defDeps = validateDepsField(
          "components.defaults.dependencies",
          rawDefaults.dependencies,
          add,
        );
    }
  }
  // "defaults" is the reserved defaults key (release-please's top-level
  // default keys, baseline §5.2): the entry-filter above routes it to the
  // inheritance block, so a component by that name is not expressible in
  // the map grammar — the pattern's own constraint, not a silent rename.
  const result: ComponentMeta[] = [];
  const declaredNames = new Set<string>();

  for (const [name, entry] of entries) {
    if (name === "defaults") continue;

    if (!isNonEmptyStr(name)) {
      add("components", "each component must have a non-empty string name");
      continue;
    }
    if (declaredNames.has(name)) {
      add("components", `duplicate component name ${JSON.stringify(name)}`);
      continue;
    }

    if (!isObject(entry)) {
      add(`components.${name}`, "must be an object");
      continue;
    }

    for (const k of Object.keys(entry)) {
      if (!COMPONENT_ENTRY_KEYS.has(k))
        add(`components.${name}`, `unknown component key ${JSON.stringify(k)}`);
    }

    // Per-field merge: entry field present → entry value; else defaults; else violation
    const paths =
      "paths" in entry
        ? validatePathsField(`components.${name}.paths`, entry.paths, add)
        : defPaths;
    const manifestVersion =
      "manifestVersion" in entry
        ? validateVersionField(`components.${name}.manifestVersion`, entry.manifestVersion, add)
        : defVersion;
    const dependencies =
      "dependencies" in entry
        ? validateDepsField(`components.${name}.dependencies`, entry.dependencies, add)
        : defDeps;

    if (paths === undefined)
      add(`components.${name}`, "paths is required (provide in entry or defaults)");
    if (manifestVersion === undefined)
      add(`components.${name}`, "manifestVersion is required (provide in entry or defaults)");
    if (dependencies === undefined)
      add(`components.${name}`, "dependencies is required (provide in entry or defaults)");

    if (paths !== undefined && manifestVersion !== undefined && dependencies !== undefined) {
      declaredNames.add(name);
      result.push({ name, manifestVersion, paths, dependencies });
    }
  }

  return result;
}

// Dangling component dependency checks (requires full declaredNames set)
function checkComponentDepsDangling(
  components: unknown,
  declaredNames: ReadonlySet<string>,
  add: (field: string, problem: string) => void,
): void {
  if (!isObject(components)) return;
  for (const [name, entry] of Object.entries(components)) {
    if (
      name === "defaults" ||
      !isObject(entry) ||
      !("dependencies" in entry) ||
      !isArray(entry.dependencies)
    )
      continue;
    for (const [i, d] of entry.dependencies.entries()) {
      if (isObject(d) && isNonEmptyStr(d.name) && !declaredNames.has(d.name))
        add(
          `components.${name}.dependencies[${String(i)}]`,
          `references undeclared component ${JSON.stringify(d.name)}`,
        );
    }
  }
}

function validatePathsField(
  pfx: string,
  paths: unknown,
  add: (field: string, problem: string) => void,
): readonly string[] | undefined {
  if (!isArray(paths)) {
    add(pfx, "must be a non-empty array of path strings");
    return undefined;
  }
  if (paths.length === 0) {
    add(pfx, "must be a non-empty array");
    return undefined;
  }
  for (const [i, path] of paths.entries()) {
    if (!isNonEmptyStr(path)) add(`${pfx}[${String(i)}]`, "each path must be a non-empty string");
  }
  const valid = paths.filter((p): p is string => isNonEmptyStr(p));
  return valid.length > 0 ? valid : undefined;
}

function validateVersionField(
  pfx: string,
  version: unknown,
  add: (field: string, problem: string) => void,
): string | undefined {
  if (!isNonEmptyStr(version)) {
    add(pfx, "must be a non-empty semver string");
    return undefined;
  }
  if (!parsesAsVersion(version)) {
    add(pfx, `${JSON.stringify(version)} does not parse as a kernel Version`);
    return undefined;
  }
  return version;
}

function validateDepsField(
  pfx: string,
  deps: unknown,
  add: (field: string, problem: string) => void,
): readonly ManifestDependency[] | undefined {
  if (!isArray(deps)) {
    add(pfx, "must be an array of dependency edges");
    return undefined;
  }
  for (const [i, d] of deps.entries()) {
    const dpfx = `${pfx}[${String(i)}]`;
    if (!isObject(d)) {
      add(dpfx, "must be an object");
      continue;
    }
    if (!isNonEmptyStr(d.name)) add(`${dpfx}.name`, "must be a non-empty component name");
    if (!isNonEmptyStr(d.range) || !isValidRangeExpression(d.range))
      add(
        `${dpfx}.range`,
        isNonEmptyStr(d.range)
          ? `${JSON.stringify(d.range)} is not a valid range (use ^x.y.z, ~x.y.z, or exact x.y.z)`
          : "must be a non-empty range expression (^, ~, or exact)",
      );
  }
  return deps
    .filter(
      (d): d is ManifestDependency =>
        isObject(d) &&
        isNonEmptyStr(d.name) &&
        isNonEmptyStr(d.range) &&
        isValidRangeExpression(d.range),
    )
    .map((d) => ({ name: d.name, range: d.range }));
}

// ---------------------------------------------------------------------------
// §2.1.a — channel validation (mirrors input.ts checkChannels)
// ---------------------------------------------------------------------------

function checkChannels(
  channels: unknown,
  lineIds: ReadonlySet<string>,
  add: (field: string, problem: string) => void,
): readonly ChannelObservation[] {
  if (!isArray(channels)) {
    add("channels", "must be an array");
    return [];
  }
  const seen = new Set<string>();
  const result: ChannelObservation[] = [];

  for (const [i, ch] of channels.entries()) {
    const pfx = `channels[${String(i)}]`;
    if (!isObject(ch)) {
      add(pfx, "must be an object");
      continue;
    }

    if (!isNonEmptyStr(ch.id)) add(`${pfx}.id`, "must be a non-empty string");
    else if (seen.has(ch.id)) add(`${pfx}.id`, `duplicate channel id ${JSON.stringify(ch.id)}`);
    else seen.add(ch.id);

    if (!("target" in ch) || !isObject(ch.target)) {
      add(`${pfx}.target`, "must be an object");
    } else {
      if (!isNonEmptyStr(ch.target.line)) add(`${pfx}.target.line`, "must be a non-empty string");
      else if (!lineIds.has(ch.target.line))
        add(`${pfx}.target.line`, `references undeclared line ${JSON.stringify(ch.target.line)}`);

      if (!("version" in ch.target)) add(`${pfx}.target.version`, "missing");
      else if (!parsesAsVersion(ch.target.version))
        add(
          `${pfx}.target.version`,
          `${JSON.stringify(ch.target.version)} does not parse as a kernel Version`,
        );
    }

    // refuse unknown channel/target keys (closed schema)
    for (const key of Object.keys(ch)) {
      if (key !== "id" && key !== "target") add(pfx, `unknown channel key ${JSON.stringify(key)}`);
    }
    if (isObject(ch.target)) {
      for (const key of Object.keys(ch.target)) {
        if (key !== "line" && key !== "version")
          add(`${pfx}.target`, `unknown target key ${JSON.stringify(key)}`);
      }
    }

    if (
      isNonEmptyStr(ch.id) &&
      isObject(ch.target) &&
      isNonEmptyStr(ch.target.line) &&
      parsesAsVersion(ch.target.version)
    )
      result.push({ id: ch.id, target: { line: ch.target.line, version: ch.target.version } });
  }
  return result;
}

// ---------------------------------------------------------------------------
// §2.1.a — bootstrap validation
// ---------------------------------------------------------------------------

function checkBootstrap(
  bootstrap: unknown,
  add: (field: string, problem: string) => void,
): BootstrapDecision | undefined {
  if (!isObject(bootstrap)) {
    add("bootstrap", "must be an object");
    return undefined;
  }

  if (!("version" in bootstrap)) add("bootstrap.version", "missing");
  else if (!parsesAsVersion(bootstrap.version))
    add(
      "bootstrap.version",
      `${JSON.stringify(bootstrap.version)} does not parse as a kernel Version`,
    );

  if (!isNonEmptyStr(bootstrap.who)) add("bootstrap.who", "must be a non-empty string");
  if (!isNonEmptyStr(bootstrap.when)) add("bootstrap.when", "must be a non-empty string");

  // refuse unknown bootstrap keys (closed schema)
  for (const key of Object.keys(bootstrap)) {
    if (key !== "version" && key !== "who" && key !== "when")
      add("bootstrap", `unknown bootstrap key ${JSON.stringify(key)}`);
  }

  if (
    parsesAsVersion(bootstrap.version) &&
    isNonEmptyStr(bootstrap.who) &&
    isNonEmptyStr(bootstrap.when)
  )
    return { version: bootstrap.version, who: bootstrap.who, when: bootstrap.when };
  return undefined;
}

// ---------------------------------------------------------------------------
// §2.1.a — public API: parseManifest
// ---------------------------------------------------------------------------

/** The closed set of valid top-level manifest keys. */
const MANIFEST_KEYS = new Set(["policy", "lines", "components", "channels", "bootstrap"]);

/**
 * Parses a manifest configuration document into the planner's own vocabulary.
 *
 * Single-pass approach (deterministic):
 * 1. Top-level schema: refuse unknown keys.
 * 2. Policy structure: refuse missing/malformed fields (tagFormats values
 *    validated here; dangling line-ref check deferred to step 5).
 * 3. Lines structure: refuse missing/malformed fields (publishes deferred);
 *    build `LineConfig[]`.
 * 4. Components structure: refuse missing/malformed/reserved; build
 *    `ComponentMeta[]`; collect declared component names and line ids.
 * 5. Dangling reference checks: tagFormats → line ids, line.publishes →
 *    component names, component deps → component names, channel target.line
 *    → line ids.
 * 6. Only if zero violations: project into `ManifestInput`.
 *
 * @throws InvalidManifestError if any violation was surfaced.
 */
export function parseManifest(document: unknown): ManifestInput {
  const violations: InputViolation[] = [];
  const add = (field: string, problem: string) => {
    violations.push({ field, problem });
  };

  if (!isObject(document)) {
    add("input", "must be a manifest object");
    throw new InvalidManifestError(violations);
  }

  // Step 1 — refuse unknown top-level keys (closed schema)
  for (const key of Object.keys(document)) {
    if (!MANIFEST_KEYS.has(key)) add("input", `unknown manifest key ${JSON.stringify(key)}`);
  }

  // Step 2 — policy structure (tagFormats dangling deferred)
  if (!("policy" in document)) add("policy", "missing");
  else checkPolicy(document.policy, add);

  // Step 3 — lines structure (publishes dangling deferred)
  const lines = "lines" in document ? document.lines : undefined;
  const parsedLines = checkLines(lines, add);

  // Step 4 — components structure (deps dangling deferred)
  const components = "components" in document ? document.components : undefined;
  const parsedComponents = checkComponents(components, add);
  const declaredComponentNames = new Set(parsedComponents.map((c) => c.name));
  const declaredLineIds = new Set(parsedLines.map((l) => l.id));

  // Step 5 — dangling reference checks (single pass over known sets)
  checkTagFormatsDangling("policy" in document ? document.policy : undefined, declaredLineIds, add);
  // line.publishes dangling (re-check with real componentNames)
  if (isArray(lines)) {
    for (const [i, line] of lines.entries()) {
      if (!isObject(line)) continue;
      if (
        "publishes" in line &&
        isNonEmptyStr(line.publishes) &&
        !declaredComponentNames.has(line.publishes)
      )
        add(
          `lines[${String(i)}].publishes`,
          `references undeclared component ${JSON.stringify(line.publishes)}`,
        );
    }
  }
  checkComponentDepsDangling(components, declaredComponentNames, add);

  // Step 5b — channels (optional; needs lineIds for dangling target.line)
  const parsedChannels =
    "channels" in document ? checkChannels(document.channels, declaredLineIds, add) : [];

  // Step 5c — bootstrap (optional)
  const parsedBootstrap =
    "bootstrap" in document ? checkBootstrap(document.bootstrap, add) : undefined;

  // Step 6 — violations → throw (one round-trip, input.ts §3 principle)
  if (violations.length > 0) throw new InvalidManifestError(violations);

  // ---------- zero violations → project to vocabulary ----------

  // Policy: ManifestPolicy → PolicyInput (verbatim — same field names)
  const rawP = document.policy as Record<string, unknown>;
  const policy: PolicyInput = {
    digest: String(rawP.digest),
    bumpMappingId: "default",
    prereleaseLadder: rawP.prereleaseLadder as readonly string[],
    prereleaseSeed: rawP.prereleaseSeed as "0" | "1",
    pre10Dampening: Boolean(rawP.pre10Dampening),
    selfReferenceNamespace: String(rawP.selfReferenceNamespace),
    tagFormats: rawP.tagFormats as Readonly<Record<string, string>>,
  };

  // Build ManifestInput — the declared half of PlanningInput (readonly
  // shape; optional fields join via conditional spread).
  return {
    policy,
    lines: parsedLines,
    ...(parsedComponents.length > 0 ? { components: parsedComponents } : {}),
    ...(parsedChannels.length > 0 ? { channels: parsedChannels } : {}),
    ...(parsedBootstrap !== undefined ? { bootstrap: parsedBootstrap } : {}),
  };
}
