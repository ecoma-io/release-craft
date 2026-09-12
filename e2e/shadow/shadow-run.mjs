// The §12–14 Tier 1+2 shadow-comparison run harness (issue #315): release-
// craft, the READ-ONLY OBSERVER, plans the real release-please consumers
// (ecoma-io/loom, ecoma-io/archkeep, ecoma-io/action-agents) over the exact
// decision windows release-please already decided, and the harness compares
// — field by field, against release-please's RECORDED artifacts only.
//
// The laws this file enforces in code, not in promise:
//
//   Read-only observer. Every git invocation goes through `gitRead`, which
//   refuses any verb outside a read-only allowlist; every gh invocation goes
//   through `ghRead`, which refuses any shape outside `pr view` / `release
//   view`. The harness performs zero writes to any consumer repository — no
//   issues, no PRs, no comments, no branches, no tags, no stars — and it
//   never reads a credential: gh uses its own ambient auth, and no token is
//   read, stored, or echoed anywhere.
//
//   §15 no shadow implementation. Every release-please-side value is read
//   from a recorded artifact — the merged release PR (gh), the release and
//   tag (gh/git), the committed CHANGELOG.md bytes at the release commit,
//   the release-please config and manifest files at the recorded refs — and
//   each evidence value carries that source. The harness NEVER reimplements
//   release-please's logic to synthesize an expected value: it has no bump
//   calculator, no changelog writer, no title template on the
//   release-please side. The comparison lives in ./compare-fields.mjs.
//
//   The world is the caller's closed declaration (phase 12 §2.4). The plan
//   mode closes the consumer's world from the read-only clone — the FULL
//   commit ancestry of the release commit (the planner's parent-closure law
//   demands every parent observed), the tags recorded at or before the base
//   release (the release being recomputed is the decision's OUTPUT, never
//   its input — a world declaring it would re-decide nothing), and the
//   component manifest as it stood at the base commit. It then drives the
//   BUILT CLI (`plan --assembly memory --world <file> --json`) — the same
//   door the adopter journey documents and decision D66's archkeep run
//   drove — plus the two pure projection doors the planner exports
//   (`renderChangelog`, `renderReleasePRProjection`) for the fields whose
//   release-craft side is a projection rather than the plan envelope.
//
//   Recorded state, honest spellings. Observed tag names carry release-
//   please's `v` prefix; the kernel's grammar is strict SemVer 2.0.0 (a
//   leading `v` is refused — core/domain/version.ts), so the world declares
//   the version-bearing name with the prefix stripped, and the run line
//   records both spellings. The MINTED tag is a different surface: the
//   declared `tagFormats` template carries the `v`, so release-craft's
//   planned tag reproduces release-please's recorded tag byte-for-byte and
//   the tag-name field compares at full fidelity. (Decision D66's world did
//   the same: one bare `0.28.1` tag.)
//
// Modes (each one subcommand; `node e2e/shadow/shadow-run.mjs <mode> --help`
// prints the protocol):
//
//   harvest   read the release-please side of one window → an rp record
//   plan      close one consumer's world, run the planner → an rc record
//   compare   compare-fields over an rp + rc record → evidence JSONL
//   aggregate the comparisons → the §13 divergence ledger JSONL
//
// This file is the HARNESS, not the run: the evidence it produced is
// committed under e2e/evidence/ and carries the run's own metadata — the
// release-craft head, the clone heads, the plan identities, and the command
// surface this file is allowed to speak.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderChangelog } from "@ecoma-io/release-craft/planner";
import { renderReleasePRProjection } from "@ecoma-io/release-craft/app";

import { aggregateLedger, compareConsumer, FIELD_IDS } from "./compare-fields.mjs";

/** @typedef {import("./compare-fields.mjs").ClassificationTable} ClassificationTable */
/** @typedef {import("./compare-fields.mjs").Comparison} Comparison */
/** @typedef {import("./compare-fields.mjs").FieldRow} FieldRow */

// ---------------------------------------------------------------------------
// §1 — the read-only command surface, enforced
// ---------------------------------------------------------------------------

/** The git verbs the harness may speak — the read surface and nothing else.
 * Anything else is refused by name before git runs. */
// Every verb here is read-only BY ARGUMENT SHAPE, not by custom: `tag` is
// deliberately absent — `git tag <name>` writes, and the harness's tag
// reads go through `rev-parse` (the recorded tags' commits) and
// `for-each-ref refs/tags` (the declared-tag closure) instead.
const READONLY_GIT_VERBS = Object.freeze([
  "rev-parse",
  "log",
  "show",
  "for-each-ref",
  "rev-list",
  "merge-base",
  "cat-file",
  "diff-tree",
]);

/** The gh subcommands the harness may speak: reads over recorded pull-
 * request and release artifacts. No write-class subcommand exists here, and
 * no `api` escape hatch either. */
const READONLY_GH_SUBCOMMANDS = Object.freeze(["pr", "release"]);

/**
 * Runs git INSIDE the consumer clone and refuses every non-read verb. A
 * failing read is a loud fault, never an empty observation.
 *
 * @param {string} clone the consumer clone's path
 * @param {readonly string[]} args git's argv (first element the verb)
 * @returns {string} stdout
 */
const gitRead = (clone, args) => {
  const verb = args[0];
  if (verb === undefined || !READONLY_GIT_VERBS.includes(verb)) {
    throw new Error(`git verb "${String(verb)}" is outside the shadow harness's read-only surface`);
  }
  return run("git", ["-C", clone, ...args]);
};

/**
 * Runs gh with an explicitly read-only subcommand shape. The consumed
 * repository is never mutated by construction: `pr view` and `release view`
 * are GET-class reads, and nothing else passes the guard.
 *
 * @param {readonly string[]} args gh's argv (first two elements the
 *   subcommand)
 * @returns {string} stdout
 */
const ghRead = (args) => {
  const group = args[0];
  const action = args[1];
  if (group === undefined || !READONLY_GH_SUBCOMMANDS.includes(group) || action !== "view") {
    throw new Error(
      `gh "${String(group)} ${String(action)}" is outside the shadow harness's read-only surface ` +
        "(pr view / release view are the only allowed shapes)",
    );
  }
  return run("gh", args);
};

/**
 * Runs a process, failing loudly on a non-zero exit — a silent empty read
 * would be a world that under-observes and an evidence file that lies.
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @returns {string} stdout
 */
const run = (command, args) => {
  const child = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (child.error !== undefined) {
    throw new Error(`${command} ${args.join(" ")} could not be spawned: ${String(child.error)}`);
  }
  if (child.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${String(child.status)}: ${child.stderr.trim()}`,
    );
  }
  return child.stdout;
};

// ---------------------------------------------------------------------------
// §2 — argv: one mode, declared flags, loud faults
// ---------------------------------------------------------------------------

/**
 * Parses `--flag value` pairs. `--help` prints the mode's protocol and
 * stops the run with exit code 0 (the caller asked for help, got it).
 * Unknown flags and missing values fault loudly.
 *
 * @param {readonly string[]} argv the mode's argv
 * @param {readonly string[]} allowed the flag names the mode accepts
 * @returns {Record<string, string> | null} the flags, or null for `--help`
 */
const parseFlags = (argv, allowed) => {
  if (argv.includes("--help")) return null;
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined || !flag.startsWith("--")) {
      throw new Error(`unexpected argument "${String(flag)}"`);
    }
    const name = flag.slice(2);
    if (!allowed.includes(name)) {
      throw new Error(
        `unknown flag --${name} — this mode accepts: ${allowed.map((f) => `--${f}`).join(", ")}`,
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`flag --${name} demands a value`);
    }
    if (flags[name] !== undefined) {
      throw new Error(`flag --${name} is declared once`);
    }
    flags[name] = value;
    index += 1;
  }
  for (const name of allowed) {
    if (flags[name] === undefined) {
      throw new Error(`missing --${name}`);
    }
  }
  return flags;
};

/**
 * Reads one flag parseFlags guaranteed to be present — the record types
 * cannot see that guarantee (noUncheckedIndexedAccess), so the modes go
 * through here.
 *
 * @param {Record<string, string>} flags
 * @param {string} name
 * @returns {string}
 */
const req = (flags, name) => {
  const value = flags[name];
  if (value === undefined) {
    throw new Error(`missing --${name}`);
  }
  return value;
};

// ---------------------------------------------------------------------------
// §3 — shared recorded-state readers (git, read-only)
// ---------------------------------------------------------------------------

/**
 * Reads a file's bytes at one commit from the clone.
 *
 * @param {string} clone
 * @param {string} sha
 * @param {string} path
 * @returns {string}
 */
const fileAt = (clone, sha, path) => gitRead(clone, ["show", `${sha}:${path}`]);

/**
 * Resolves a tag to the commit it binds (peeled for annotated tags).
 *
 * @param {string} clone
 * @param {string} tag
 * @returns {string} the commit sha
 */
const tagCommit = (clone, tag) => gitRead(clone, ["rev-parse", `${tag}^{commit}`]).trim();

/**
 * The commits reachable from one head, newest first — sha, parents, full
 * body, committed date. This is the planner's closed parent-closure
 * universe: the world declares the FULL ancestry, because every declared
 * parent must itself be observed.
 *
 * @param {string} clone
 * @param {string} head
 * @returns {{ sha: string, parents: string[], message: string, committedAt: string }[]}
 */
const ancestryOf = (clone, head) => {
  const output = gitRead(clone, ["log", head, "--format=%x1e%H%x00%P%x00%cI%x00%B"]);
  return output
    .split("\x1e")
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const at = record.indexOf("\x00");
      const sha = record.slice(0, at).trim();
      const rest = record.slice(at + 1);
      const end = rest.indexOf("\x00");
      const parents = rest.slice(0, end).trim();
      const remainder = rest.slice(end + 1);
      const date = remainder.slice(0, remainder.indexOf("\x00"));
      const message = remainder.slice(remainder.indexOf("\x00") + 1).replace(/\n+$/, "");
      return {
        sha,
        parents: parents.length > 0 ? parents.split(/\s+/) : [],
        message,
        committedAt: date,
      };
    });
};

// ---------------------------------------------------------------------------
// §4 — `harvest`: the release-please side, from recorded artifacts only
// ---------------------------------------------------------------------------

/**
 * The release-please config fields the comparison reads, parsed from the
 * recorded config JSON at the release commit.
 *
 * @typedef {object} RpConfigView
 * @property {string} changelogPath
 * @property {string | null} packageName
 * @property {boolean} includeComponentInTag
 * @property {boolean} prerelease
 * @property {string | null} titlePattern
 * @property {boolean} bumpMinorPreMajor
 * @property {{ type: string, section: string, hidden: boolean }[] | null} sections
 */

/**
 * Parses the release-please config's comparison-relevant fields.
 *
 * @param {string} clone
 * @param {string} sha
 * @returns {RpConfigView}
 */
const readRpConfig = (clone, sha) => {
  const raw = JSON.parse(fileAt(clone, sha, "release-please-config.json"));
  const root = raw?.packages?.[""] ?? raw?.packages?.["."] ?? null;
  if (root === null || typeof root !== "object") {
    throw new Error("the recorded release-please config declares no root package");
  }
  // `changelog-sections` is valid at both scopes the recorded consumers use:
  // config-root (loom — the global default for every package) and per-package
  // (archkeep — `packages["."]`'s own list). The per-package declaration is
  // the more specific one, so it wins when both exist.
  /** @type {Record<string, unknown>[] | null} */
  const declared = /** @type {Record<string, unknown>[] | null} */ (
    Array.isArray(root["changelog-sections"])
      ? root["changelog-sections"]
      : Array.isArray(raw["changelog-sections"])
        ? raw["changelog-sections"]
        : null
  );
  const sections = declared
    ? declared.map((/** @type {Record<string, unknown>} */ section) => ({
        type: String(section["type"]),
        section: String(section["section"]),
        hidden: section["hidden"] === true,
      }))
    : null;
  const packageName = root["package-name"];
  return {
    changelogPath: String(root["changelog-path"] ?? "CHANGELOG.md"),
    packageName: typeof packageName === "string" ? packageName : null,
    includeComponentInTag: root["include-component-in-tag"] === true,
    prerelease: root["prerelease"] === true,
    // `pull-request-title-pattern` is valid at both scopes the recorded
    // consumers use — config-root and per-package (`packages["."]`'s own
    // pattern, archkeep's shape). The same dual-scope rule
    // `changelog-sections` follows above applies: the per-package
    // declaration is the more specific one, so it wins when both exist.
    titlePattern:
      typeof root["pull-request-title-pattern"] === "string"
        ? root["pull-request-title-pattern"]
        : typeof raw["pull-request-title-pattern"] === "string"
          ? raw["pull-request-title-pattern"]
          : null,
    bumpMinorPreMajor: root["bump-minor-pre-major"] === true,
    sections,
  };
};

/**
 * One rendered entry of release-please's committed changelog section.
 *
 * @typedef {object} RpChangelogEntry
 * @property {string} sha the FULL commit sha the entry links
 * @property {string} text the entry line's text (subject with scope prefix)
 */

/**
 * One `###` section of release-please's committed changelog section.
 *
 * @typedef {object} RpChangelogSection
 * @property {string} header the heading text after `### `
 * @property {RpChangelogEntry[]} entries
 */

/**
 * Parses the version section out of the committed CHANGELOG.md bytes: from
 * the `## [<version>]` heading to the next `## [` (or end of file). The
 * bytes are release-please's RECORDED output — this parser reads them; it
 * never writes like them.
 *
 * @param {string} bytes the changelog bytes at the release commit
 * @param {string} version the version whose section to lift
 * @returns {{ heading: string, date: string | null, sections: RpChangelogSection[] }}
 */
const parseRpChangelogSection = (bytes, version) => {
  const lines = bytes.split("\n");
  const headingIndex = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (headingIndex < 0) {
    throw new Error(`the committed CHANGELOG.md carries no ## [${version}] section`);
  }
  let endIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && line.startsWith("## [")) {
      endIndex = index;
      break;
    }
  }
  const heading = lines[headingIndex] ?? "";
  const date = /\((\d{4}-\d{2}-\d{2})\)/.exec(heading)?.[1] ?? null;
  /** @type {RpChangelogSection[]} */
  const sections = [];
  for (let index = headingIndex + 1; index < endIndex; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (line.startsWith("### ")) {
      sections.push({ header: line.slice(4).trim(), entries: [] });
      continue;
    }
    if (line.startsWith("* ") && sections.length > 0) {
      const target = sections[sections.length - 1];
      const sha = [...line.matchAll(/commit\/([0-9a-f]{7,40})\)/g)].at(-1)?.[1];
      if (target !== undefined && sha !== undefined) {
        target.entries.push({ sha, text: line.slice(2).trim() });
      }
    }
  }
  return { heading, date, sections };
};

/**
 * The release PR's body structure — the structural facts the comparison
 * compares, never the body bytes wholesale (the evidence stays small and
 * the comparison stays field-level).
 *
 * @typedef {object} RpBodyStructure
 * @property {boolean} botHeader the release-please robot preamble
 * @property {boolean} versionHeading the `## [<version>]` heading
 * @property {string[]} sectionHeaders the `### ` headers, in order
 * @property {number} entryCount the `* ` bullets
 * @property {boolean} claimMarker a release-craft identity claim comment
 */

/**
 * Mode `harvest`. Reads the release-please side of one decision window.
 *
 * @param {readonly string[]} argv
 */
const harvest = (argv) => {
  const flags = parseFlags(argv, ["repo", "clone", "pr", "tag", "base-tag", "head", "out"]);
  if (flags === null) {
    process.stdout.write(
      "harvest — read the release-please side of one decision window\n" +
        "--repo <owner/name> --clone <path> --pr <number> --tag <the released tag>\n" +
        "--base-tag <the tag before the release> --head <the release commit sha> --out <path>\n",
    );
    return;
  }
  const repo = req(flags, "repo");
  const clone = req(flags, "clone");
  const prNumber = req(flags, "pr");
  const releasedTag = req(flags, "tag");
  const baseTag = req(flags, "base-tag");
  const head = req(flags, "head");

  // The merged release PR — release-please's own recorded decision artifact.
  const pr = JSON.parse(
    ghRead([
      "pr",
      "view",
      prNumber,
      "-R",
      repo,
      "--json",
      "number,title,body,labels,headRefName,baseRefName,mergeCommit,state",
    ]),
  );
  const labels = (pr?.labels ?? []).map((/** @type {{ name: string }} */ label) => label.name);

  // The GitHub release the tag produced.
  const release = JSON.parse(
    ghRead([
      "release",
      "view",
      releasedTag,
      "-R",
      repo,
      "--json",
      "name,tagName,isPrerelease,isDraft,createdAt",
    ]),
  );

  // The recorded files at the release commit: changelog bytes, config,
  // manifest — and the manifest at the BASE commit (the recorded state
  // release-please decided from).
  const baseSha = tagCommit(clone, baseTag);
  const config = readRpConfig(clone, head);
  const changelogBytes = fileAt(clone, head, config.changelogPath);
  const version = releasedTag.replace(/^v(?=\d)/, "");
  const section = parseRpChangelogSection(changelogBytes, version);
  const manifestAtBase = JSON.parse(fileAt(clone, baseSha, ".release-please-manifest.json"));
  const baseVersion = String(manifestAtBase?.["."] ?? "");
  if (baseVersion === "") {
    throw new Error(`the manifest at ${baseSha} carries no root version`);
  }
  const commitCount = gitRead(clone, ["rev-list", "--count", `${baseSha}..${head}`]).trim();

  // The heading test is literal substring containment, not a pattern: the
  // version is an observed recorded string (the released tag, v-stripped),
  // and building a RegExp from it would interpret it as one — CodeQL's
  // js/regex-injection class. For the kernel's SemVer spellings (digits and
  // dots) `includes` decides every genuine `## [<version>]` heading the
  // pattern did and refuses the degenerate near-misses a dotted pattern
  // would have matched, so the test only narrows, never flips, a verdict.
  const versionHeading = (pr?.body ?? "").includes(`## [${version}]`);
  /** @type {RpBodyStructure} */
  const bodyStructure = {
    botHeader: (pr?.body ?? "").startsWith(":robot:"),
    versionHeading,
    sectionHeaders: section.sections.map((rpSection) => rpSection.header),
    entryCount: section.sections.reduce((sum, rpSection) => sum + rpSection.entries.length, 0),
    claimMarker: (pr?.body ?? "").includes("<!-- release-craft:"),
  };

  /** The rp record — every value with the recorded artifact it was read
   * from. This is the §15 evidence chain: no synthesized values exist. */
  const record = {
    consumer: repo,
    capturedAt: new Date().toISOString(),
    window: {
      baseTag,
      baseSha,
      headSha: head,
      headIsPrMergeCommit: pr?.mergeCommit?.oid === head,
      commitCount: Number(commitCount),
      source:
        "git rev-parse / rev-list over the read-only clone; the head is the release PR's merge commit (gh pr view mergeCommit)",
    },
    releaseDecision: {
      value: "release",
      source: `merged PR #${pr?.number} (${pr?.state}) + tag ${releasedTag} + GitHub release (gh pr view, gh release view)`,
    },
    pr: {
      number: pr?.number ?? null,
      title: pr?.title ?? "",
      titleSource: `config pull-request-title-pattern ${config.titlePattern === null ? "(unset: release-please's default)" : config.titlePattern}, observed on merged PR #${pr?.number} (gh pr view)`,
      labels,
      labelsSource: `merged PR #${pr?.number} labels (gh pr view)`,
      headRefName: pr?.headRefName ?? "",
      headRefNameSource: `merged PR #${pr?.number} headRefName (gh pr view)`,
      baseRefName: pr?.baseRefName ?? "",
      bodyStructure,
      bodyStructureSource: `merged PR #${pr?.number} body (gh pr view), structure only — the bytes stay in the recorded artifact`,
    },
    release: {
      tagName: release?.tagName ?? "",
      name: release?.name ?? "",
      isPrerelease: release?.isPrerelease === true,
      source: `gh release view ${releasedTag}`,
    },
    tag: {
      recorded: releasedTag,
      commit: head,
      source: `gh release view ${releasedTag} (the tag's recorded existence); commits read via rev-parse / for-each-ref over the clone`,
    },
    changelog: {
      path: config.changelogPath,
      at: head,
      version,
      heading: section.heading,
      date: section.date,
      sections: section.sections,
      source: `git show ${head}:${config.changelogPath} — the committed bytes release-please wrote`,
    },
    config: { ...config, source: `git show ${head}:release-please-config.json` },
    manifest: {
      baseVersion,
      source: `git show ${baseSha}:.release-please-manifest.json — the recorded state release-please decided from`,
    },
  };
  writeFileSync(req(flags, "out"), `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`harvest: wrote ${req(flags, "out")}\n`);
};

// ---------------------------------------------------------------------------
// §5 — `plan`: the world closure, the planner door, the rc record
// ---------------------------------------------------------------------------

/**
 * The declared policy block, fixed per run and cited in the rc record. The
 * mapping is the `default` id (the only declared mapping), pre-1.0
 * dampening mirrors the consumer's recorded `bump-minor-pre-major: true`,
 * and the tag template carries the `v` so the minted tag reproduces the
 * recorded tag's form.
 *
 * @param {string} consumer
 * @param {string} lineId
 * @returns {Record<string, unknown>}
 */
const declaredPolicy = (consumer, lineId) => ({
  digest: `shadow-tier12-${consumer}-policy-1`,
  bumpMappingId: "default",
  prereleaseLadder: ["alpha", "beta", "rc"],
  prereleaseSeed: "0",
  pre10Dampening: true,
  selfReferenceNamespace: "Release-Craft:",
  tagFormats: { [lineId]: "v{major}.{minor}.{patch}{prerelease}" },
});

/**
 * Strips the leading `v` the kernel's strict SemVer grammar refuses, for
 * the world's declared tag names (the recorded `refs/tags/<name>` rides the
 * run line; the minted tag's template keeps the `v`).
 *
 * @param {string} name
 * @returns {string}
 */
const versionBearingTagName = (name) => {
  const stripped = name.replace(/^refs\/tags\//, "").replace(/^v(?=\d)/, "");
  if (stripped === "") {
    throw new Error(`tag name ${JSON.stringify(name)} carries no version-bearing spelling`);
  }
  return stripped;
};

/**
 * The conventional-commit prefix of one subject line — the caller-side
 * extraction the changelog renderer's declared entries are composed from
 * (the renderer demands type/scope/subject as declared input; it parses
 * nothing). Returns null for an unparseable subject.
 *
 * @param {string} message
 * @returns {{ type: string, scope: string | null, subject: string } | null}
 */
const conventionalPrefix = (message) => {
  const match = /^(\w+)(?:\(([^)]+)\))?: (.+)$/.exec(message.split("\n")[0] ?? "");
  if (match === null) return null;
  const type = match[1] ?? "";
  const subject = match[3] ?? "";
  if (type === "" || subject === "") return null;
  return { type, scope: match[2] ?? null, subject };
};

/**
 * Mode `plan`. Closes one consumer's world from the read-only clone, drives
 * the built CLI's plan door over it, and writes the rc record.
 *
 * @param {readonly string[]} argv
 */
const plan = (argv) => {
  const flags = parseFlags(argv, ["repo", "clone", "base-tag", "head", "component", "line", "out"]);
  if (flags === null) {
    process.stdout.write(
      "plan — close one consumer's world and drive the built CLI's plan door\n" +
        "--repo <owner/name> --clone <path> --base-tag <tag before the release>\n" +
        "--head <the release commit sha> --component <name> --line <line id> --out <path>\n" +
        "Expects the built CLI at dist/src/cli/index.js (`pnpm build` first — the fresh-clone law).\n",
    );
    return;
  }
  const repo = req(flags, "repo");
  const clone = req(flags, "clone");
  const baseTag = req(flags, "base-tag");
  const head = req(flags, "head");
  const component = req(flags, "component");
  const lineId = req(flags, "line");

  // The universe: the FULL ancestry of the release commit (the planner's
  // parent-closure law). The recorded state: tags at or before the base
  // release only — the recomputed release's own tag is the decision's
  // output, never its input.
  const baseSha = tagCommit(clone, baseTag);
  const commits = ancestryOf(clone, head);
  const universe = new Set(commits.map((commit) => commit.sha));
  const allTags = gitRead(clone, [
    "for-each-ref",
    "--format=%(refname)%00%(*objectname)%00%(objectname)",
    "refs/tags",
  ])
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, peeled, object] = line.split("\x00");
      return {
        name: name ?? "",
        commit: (peeled !== "" && peeled !== undefined ? peeled : object) ?? "",
      };
    });
  /** @type {{ name: string, commit: string }[]} */
  const declaredTags = [];
  /** @type {{ observed: string, declared: string, commit: string }[]} */
  const tagSpellings = [];
  for (const tag of allTags) {
    if (!universe.has(tag.commit)) continue;
    // The decision window is last RP tag → observed RP release. The world
    // must not import older release-line histories (archkeep has a historical
    // 1.x rc sequence); the last produced RP tag is the sole recorded base
    // for this recomputation, just as D66's one-tag world did.
    if (tag.commit !== baseSha) continue;
    const declared = versionBearingTagName(tag.name);
    declaredTags.push({ name: declared, commit: tag.commit });
    tagSpellings.push({ observed: tag.name, declared, commit: tag.commit });
  }
  const manifestAtBase = JSON.parse(fileAt(clone, baseSha, "package.json"));
  const manifestVersion = String(manifestAtBase?.version ?? "");
  if (manifestVersion === "") {
    throw new Error(`package.json at ${baseSha} carries no version`);
  }

  const world = {
    policy: declaredPolicy(repo, lineId),
    repository: {
      commits: commits.map((commit) => ({
        sha: commit.sha,
        message: commit.message,
        committedAt: commit.committedAt,
        parents: commit.parents,
        containingRefs: ["refs/heads/main"],
      })),
      refs: [{ name: "refs/heads/main", head }],
    },
    history: { tags: declaredTags },
    lines: [{ id: lineId, feedRef: "refs/heads/main", lifecycle: "active", declared: true }],
    components: [{ name: component, manifestVersion, paths: ["package.json"] }],
  };

  // The world document is run-time input, never committed: a temp file on
  // the caller's TMPDIR, removed before this mode exits.
  const scratch = mkdtempSync(join(tmpdir(), "shadow-world-"));
  const worldPath = join(scratch, "world.json");
  writeFileSync(worldPath, JSON.stringify(world, null, 2));
  try {
    const envelope = JSON.parse(
      run("node", [
        "dist/src/cli/index.js",
        "plan",
        "--assembly",
        "memory",
        "--world",
        worldPath,
        "--json",
      ]),
    );

    /** @type {any} */
    const planValue = envelope?.plan ?? null;
    if (envelope?.kind !== "planned" || planValue === null) {
      throw new Error(
        `the plan door answered ${JSON.stringify(envelope?.kind ?? "nothing")} — ` +
          "the run records the refusal verbatim in the evidence, never as an absent plan",
      );
    }
    const line = planValue.lines.find(
      (/** @type {{ lineId: string }} */ candidate) => candidate.lineId === lineId,
    );
    if (line === undefined || line?.stable === null) {
      throw new Error(`the plan carries no stable target for line ${lineId}`);
    }
    const baseVersion = versionBearingTagName(baseTag);

    // The release-PR projection — release-craft's deterministic render over
    // the plan (the gate's own projection door; no production caller exists,
    // which the evidence says plainly).
    const rendered = renderReleasePRProjection(
      { component, releaseLine: lineId, targetBranch: "main" },
      planValue,
    );
    if (rendered === null) {
      throw new Error("the projection door rendered nothing for a planned line");
    }

    // The changelog projection — the renderer over the plan's change set,
    // sections declared from the consumer's OWN recorded changelog-sections
    // (loom and archkeep declare them; action-agents declares none, so the
    // declared list is empty and the renderer surfaces each type under its
    // own capitalized heading). Date and url are OMITTED — declaring the
    // recorded date would feed release-please's output into release-craft's
    // render, the exact synthesis §15 forbids.
    const declaredSections = readRpConfig(clone, head).sections ?? [];
    /** @type {{ type: string, section: string, hidden?: boolean }[]} */
    const sections = declaredSections.map((section) =>
      section.hidden
        ? { type: section.type, section: section.section, hidden: true }
        : { type: section.type, section: section.section },
    );
    /** @type {{ type: string, subject: string, scope?: string, id: string }[]} */
    const entries = [];
    for (const change of line.changes) {
      const commit = commits.find((candidate) => candidate.sha === change.id);
      const parsed = commit === undefined ? null : conventionalPrefix(commit.message);
      if (parsed === null) {
        throw new Error(`plan change ${change.id} carries no conventional prefix to render`);
      }
      /** @type {{ type: string, subject: string, scope?: string, id: string }} */
      const entry = { type: parsed.type, subject: parsed.subject, id: change.id };
      if (parsed.scope !== null) entry.scope = parsed.scope;
      entries.push(entry);
    }
    const renderedChangelog = renderChangelog({
      versions: [
        {
          version: String(line.stable.version),
          entries,
        },
      ],
      sections,
      repository: `https://github.com/${repo}`,
    });
    const renderedHeaders = renderedChangelog
      .split("\n")
      .filter((row) => row.startsWith("### "))
      .map((row) => row.slice(4).trim());
    const renderedShas = [...renderedChangelog.matchAll(/commit\/([0-9a-f]{7,40})\)/g)].map(
      (match) => match[1] ?? "",
    );

    // The head branch: the port's derivation grammar, instantiated over the
    // declared identity — corroborated against the recorded live form the
    // D81 create leg captured, so the harness's spelling is never the only
    // witness.
    const headBranch = `release-craft--branches--main--lines--${lineId}--components--${component}`;
    const d81Evidence = "e2e/evidence/release-pr-e2e-2026-09-12.jsonl";
    const d81Bytes = existsSync(d81Evidence) ? readFileSync(d81Evidence, "utf8") : "";
    const liveBranch = /release-craft--branches--[a-zA-Z0-9./@_-]+/.exec(d81Bytes)?.[0] ?? null;
    const liveFormMatches =
      liveBranch !== null && liveBranch.startsWith("release-craft--branches--");

    const rcHead = gitReadInCwd(["rev-parse", "HEAD"]).trim();
    const record = {
      consumer: repo,
      capturedAt: new Date().toISOString(),
      releaseCraft: {
        head: rcHead,
        cli: "dist/src/cli/index.js plan --assembly memory --world <world> --json (the built CLI, the adopter journey's door)",
      },
      world: {
        commits: commits.length,
        declaredTags: tagSpellings,
        componentManifestVersion: manifestVersion,
        componentManifestSource: `git show ${baseSha}:package.json — the component's manifest as the recorded state held it`,
        policy: declaredPolicy(repo, lineId),
        tagClosure:
          "tags at or before the base release; the recomputed release's own tag is the decision's output, never its input",
      },
      plan: {
        kind: envelope.kind,
        planId: planValue.planId,
        inputsFingerprint: planValue.inputsFingerprint,
        policyDigest: planValue.policyDigest,
        decisions: envelope.decisions,
        foreignTags: planValue.explanation.foreignTags,
        excludedCount: planValue.explanation.excluded.length,
        withheldCount: planValue.explanation.withheld.length,
      },
      values: {
        "release-decision": {
          rcValue: envelope.kind === "planned" ? "release" : envelope.kind,
          rcSource: "the plan envelope's kind + the line's planned stable target",
        },
        version: {
          rcValue: line.stable.version,
          rcSource: `plan line ${lineId} stable.version`,
        },
        "bump-type": {
          rcValue: bumpBetween(baseVersion, String(line.stable.version)),
          rcSource: `the recorded base ${baseVersion} → the plan's target ${String(line.stable.version)}`,
        },
        "tag-name": {
          rcValue: line.stable.tag,
          rcSource: `plan line ${lineId} stable.tag (the declared tagFormats template)`,
        },
        "commit-range": {
          rcValue: {
            releasedUpTo: baseSha,
            head,
            commitCount: commits.findIndex((candidate) => candidate.sha === baseSha),
          },
          rcSource:
            "the declared world's recorded range (tag binding + feed-ref head); the count is the ancestry newer than the base tag's commit",
        },
        "selected-changes": {
          rcValue: {
            items: line.changes.map((/** @type {{ id: string, type: string }} */ change) => ({
              id: change.id,
              value: change.type,
            })),
          },
          rcSource: `plan line ${lineId} changes (the plan's recorded change set)`,
        },
        "release-pr-title": {
          rcValue: rendered.projection.title,
          rcSource:
            "renderReleasePRProjection over the plan (src/app/release-pr.ts, the gate's deterministic render)",
        },
        "release-pr-body-structure": {
          rcValue: {
            claimMarker: true,
            planHeading: true,
            lineSections: rendered.pendingLines.length,
            bulletCount: rendered.pendingLines
              .map((pending) => pending.changes.length)
              .reduce((sum, count) => sum + count, 0),
            changelogFile: rendered.projection.files.some((file) => file.path === "CHANGELOG.md"),
          },
          rcSource: "renderReleasePRProjection over the plan (structure only)",
        },
        "release-pr-labels": {
          rcValue: rendered.projection.labels,
          rcSource:
            "renderReleasePRProjection labels (the constant, state-free organizational label)",
        },
        "head-branch-naming": {
          rcValue: headBranch,
          rcSource:
            "the GitHub port's head-branch derivation (src/adapters/github/release-pr.ts §3), instantiated over the declared identity; the live form is corroborated by " +
            d81Evidence,
        },
        "changelog-path": {
          rcValue: "CHANGELOG.md",
          rcSource:
            "the declared artifact coordinates (the wired publication demands CHANGELOG.md; the renderer itself is pathless by law)",
        },
        "changelog-section-headers": {
          rcValue: renderedHeaders,
          rcSource:
            "renderChangelog over the plan's change set, sections declared from the consumer's recorded changelog-sections; parsed from the rendered bytes",
        },
        "changelog-entry-ordering": {
          rcValue: { items: renderedShas.map((sha) => ({ id: sha, value: sha })) },
          rcSource:
            "the entry order of the rendered changelog bytes (commit links, in render order)",
        },
        "commit-to-section-assignment": {
          rcValue: {
            items: renderedShas.map((sha) => {
              // The entry's section is the LAST ### header at or before the
              // sha's position — the header whose body the entry rendered
              // inside, not the first header the bytes happen to precede.
              const at = renderedChangelog.indexOf(sha);
              const header = renderedHeaders
                .map((candidate) => ({
                  candidate,
                  at: renderedChangelog.indexOf(`### ${candidate}`),
                }))
                .filter(({ at: headerAt }) => headerAt >= 0 && headerAt < at)
                .reduceRight(
                  (found, { candidate, at: headerAt }) =>
                    found === null || headerAt > found.at ? { candidate, at: headerAt } : found,
                  /** @type {{ candidate: string, at: number } | null} */ (null),
                );
              return { id: sha, value: header?.candidate ?? null };
            }),
          },
          rcSource: "the rendered bytes: each entry's sha → the ### section it rendered under",
        },
        "component-scoping": {
          rcValue: {
            component,
            // The tag carries the component only when the declared template
            // spells it — read off the planned tag itself, never assumed.
            tagCarriesComponent: String(line.stable.tag).startsWith(`${component}-`),
          },
          rcSource:
            "the planned tag read against the declared component (the tagFormats template spells the component only when the consumer's recorded posture declares it)",
        },
        "prerelease-channel": {
          rcValue: null,
          rcSource:
            "not exercised: the declared world's line carries no stream and the window mints no prerelease",
        },
      },
      projection: {
        headBranchCorroboratedByLiveRecord: liveFormMatches,
        liveBranchForm: liveBranch,
        declaredChangelogSections: sections,
        renderedChangelogBytes: renderedChangelog,
        renderedTitle: rendered.projection.title,
        renderedLabels: rendered.projection.labels,
        files: rendered.projection.files,
      },
    };
    writeFileSync(req(flags, "out"), `${JSON.stringify(record, null, 2)}\n`);
    process.stdout.write(
      `plan: ${repo} → ${planValue.planId} (${String(line.stable.version)} / ${String(line.stable.tag)}), wrote ${req(flags, "out")}\n`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

/**
 * gitRead against the process's own working directory — the release-craft
 * checkout the harness runs in (the recorded rc head).
 *
 * @param {readonly string[]} args
 * @returns {string} stdout
 */
const gitReadInCwd = (args) => gitRead(".", args);

/**
 * The bump class between two versions — arithmetic over recorded values,
 * never a release-please reimplementation.
 *
 * @param {string} base
 * @param {string} target
 * @returns {"major" | "minor" | "patch" | null}
 */
const bumpBetween = (base, target) => {
  const parts = (/** @type {string} */ version) =>
    version.split("-")[0]?.split(".").map(Number) ?? [];
  const [baseMajor, baseMinor, basePatch] = parts(base);
  const [targetMajor, targetMinor, targetPatch] = parts(target);
  if (targetMajor === undefined || baseMajor === undefined) return null;
  if (targetMajor > baseMajor) return "major";
  if (
    targetMinor === undefined ||
    baseMinor === undefined ||
    targetPatch === undefined ||
    basePatch === undefined
  ) {
    return null;
  }
  if (targetMinor > baseMinor) return "minor";
  if (targetPatch > basePatch) return "patch";
  return null;
};

// ---------------------------------------------------------------------------
// §6 — `compare` and `aggregate`: the §13 ledger
// ---------------------------------------------------------------------------

/**
 * Mode `compare`. Compares one consumer's rp + rc records under the
 * classification table and writes the evidence JSONL: the run line, one
 * line per field, the counts line.
 *
 * @param {readonly string[]} argv
 */
const compare = (argv) => {
  const flags = parseFlags(argv, ["rp", "rc", "classifications", "out"]);
  if (flags === null) {
    process.stdout.write(
      "compare — compare-fields over an rp + rc record pair\n" +
        "--rp <rp.json> --rc <rc.json> --classifications <table.json> --out <evidence.jsonl>\n" +
        "A divergent field the table does not cover — or covers without a citation — records unexplained.\n",
    );
    return;
  }
  const rp = JSON.parse(readFileSync(req(flags, "rp"), "utf8"));
  const rc = JSON.parse(readFileSync(req(flags, "rc"), "utf8"));
  /** @type {ClassificationTable} */
  const classifications = JSON.parse(readFileSync(req(flags, "classifications"), "utf8"));
  const declaredSections = rc?.projection?.declaredChangelogSections ?? null;
  /** @type {Record<string, { rpSource: string, rpValue: unknown, rcSource: string, rcValue: unknown }>} */
  const values = {};
  for (const id of FIELD_IDS) {
    const rpValue = rpValueFor(rp, id);
    const rcValue = rc?.values?.[id]?.rcValue;
    const rcSource = rc?.values?.[id]?.rcSource ?? "";
    values[id] = {
      rpSource: rpSourceFor(rp, id),
      rpValue,
      rcSource,
      rcValue: rcValue === undefined ? null : rcValue,
    };
  }
  const comparison = compareConsumer({ consumer: rp.consumer, values, classifications });
  const strict = compareConsumer({ consumer: rp.consumer, values, classifications: {} });
  const runLine = {
    record: "run",
    consumer: rp.consumer,
    capturedAt: new Date().toISOString(),
    releaseCraftHead: rc?.releaseCraft?.head ?? null,
    planId: rc?.plan?.planId ?? null,
    inputsFingerprint: rc?.plan?.inputsFingerprint ?? null,
    window: rp?.window ?? null,
    rpArtifacts: {
      pr: rp?.pr?.number ?? null,
      tag: rp?.tag?.recorded ?? null,
      changelogAt: rp?.changelog?.at ?? null,
      manifestAtBase: rp?.manifest?.source ?? null,
    },
    commandSurface: {
      git: `read verbs only (${READONLY_GIT_VERBS.join(", ")}) — enforced by the harness's verb allowlist before git runs`,
      gh: "pr view / release view only — enforced by the harness's subcommand allowlist; ambient gh auth, no token read or stored",
      writesToConsumer: 0,
    },
    classificationLaw:
      "a divergent field is classified only with a citation; the table below was authored after the strict pass and every entry cites its covering row/contract",
    strictPassUnexplained: strict.counts.unexplained,
    declaredChangelogSections: declaredSections,
  };
  const lines = [JSON.stringify(runLine)];
  for (const row of comparison.fields) {
    lines.push(JSON.stringify({ record: "field", ...row }));
  }
  lines.push(JSON.stringify({ record: "counts", ...comparison.counts }));
  writeFileSync(req(flags, "out"), `${lines.join("\n")}\n`);
  process.stdout.write(
    `compare: ${comparison.consumer} — ${comparison.counts.compared} compared, ${comparison.counts.equal} equal, ` +
      `${comparison.counts.divergent} divergent (${comparison.counts.unexplained} unexplained), ` +
      `${comparison.counts.notExercised} not exercised → ${req(flags, "out")}\n`,
  );
};

/**
 * The rp record's value for one field id — the harvest record's shape
 * mapped onto the fixed field list.
 *
 * @param {any} rp
 * @param {string} id
 * @returns {unknown} null when release-please produced no observable output
 */
const rpValueFor = (rp, id) => {
  switch (id) {
    case "release-decision":
      return rp?.releaseDecision?.value ?? null;
    case "version":
      return rp?.changelog?.version ?? null;
    case "bump-type":
      return bumpBetween(
        String(rp?.manifest?.baseVersion ?? ""),
        String(rp?.changelog?.version ?? ""),
      );
    case "tag-name":
      return rp?.tag?.recorded ?? null;
    case "commit-range":
      return {
        baseTag: rp?.window?.baseTag ?? null,
        baseSha: rp?.window?.baseSha ?? null,
        headSha: rp?.window?.headSha ?? null,
        commitCount: rp?.window?.commitCount ?? null,
      };
    case "selected-changes":
      return {
        // The recorded entries are the changelog's lines as release-please
        // wrote them, duplicates included — a commit landing under two
        // entries (a squash chain, a cherry-pick, a double record) is part of
        // release-please's recorded output, never filtered here.
        items: (rp?.changelog?.sections ?? []).flatMap(
          (/** @type {{ entries: { sha: string, text: string }[] }} */ section) =>
            section.entries.map((entry) => ({ id: entry.sha, value: entry.text })),
        ),
      };
    case "release-pr-title":
      return rp?.pr?.title ?? null;
    case "release-pr-body-structure":
      return rp?.pr?.bodyStructure ?? null;
    case "release-pr-labels":
      return rp?.pr?.labels ?? null;
    case "head-branch-naming":
      return rp?.pr?.headRefName ?? null;
    case "changelog-path":
      return rp?.config?.changelogPath ?? null;
    case "changelog-section-headers":
      return (rp?.changelog?.sections ?? []).map(
        (/** @type {{ header: string }} */ section) => section.header,
      );
    case "changelog-entry-ordering":
      return {
        items: (rp?.changelog?.sections ?? []).flatMap(
          (/** @type {{ entries: { sha: string }[] }} */ section) =>
            section.entries.map((entry) => ({ id: entry.sha, value: entry.sha })),
        ),
      };
    case "commit-to-section-assignment":
      return {
        items: (rp?.changelog?.sections ?? []).flatMap(
          (/** @type {{ header: string, entries: { sha: string }[] }} */ section) =>
            section.entries.map((entry) => ({ id: entry.sha, value: section.header })),
        ),
      };
    case "component-scoping":
      return {
        package:
          rp?.config?.packageName ?? rp?.pr?.headRefName?.split("--components--")?.[1] ?? null,
        tagCarriesComponent: rp?.config?.includeComponentInTag === true,
      };
    case "prerelease-channel":
      return rp?.config?.prerelease === true ? "prerelease" : null;
    default:
      return null;
  }
};

/**
 * The rp record's source citation for one field id.
 *
 * @param {any} rp
 * @param {string} id
 * @returns {string}
 */
const rpSourceFor = (rp, id) => {
  switch (id) {
    case "release-decision":
      return String(rp?.releaseDecision?.source ?? "");
    case "version":
    case "changelog-section-headers":
    case "changelog-entry-ordering":
    case "commit-to-section-assignment":
      return String(rp?.changelog?.source ?? "");
    case "bump-type":
      return `the manifest at the base records ${String(rp?.manifest?.baseVersion ?? "")} (${String(
        rp?.manifest?.source ?? "",
      )}); the recorded release at the head records ${String(
        rp?.changelog?.version ?? "",
      )} (${String(rp?.changelog?.source ?? "")}); the bump is the derivation between them`;
    case "tag-name":
      return String(rp?.tag?.source ?? "");
    case "commit-range":
      return String(rp?.window?.source ?? "");
    case "selected-changes":
      return String(rp?.changelog?.source ?? "");
    case "release-pr-title":
      return String(rp?.pr?.titleSource ?? "");
    case "release-pr-body-structure":
      return String(rp?.pr?.bodyStructureSource ?? "");
    case "release-pr-labels":
      return String(rp?.pr?.labelsSource ?? "");
    case "head-branch-naming":
      return String(rp?.pr?.headRefNameSource ?? "");
    case "changelog-path":
      return String(rp?.config?.source ?? "");
    case "component-scoping":
      return `${String(rp?.config?.source ?? "")}; the branch token (${String(rp?.pr?.headRefNameSource ?? "")})`;
    case "prerelease-channel":
      return String(rp?.config?.source ?? "");
    default:
      return "";
  }
};

/**
 * Mode `aggregate`. Folds the per-consumer evidence JSONLs into the §13
 * divergence ledger.
 *
 * @param {readonly string[]} argv
 */
const aggregate = (argv) => {
  const flags = parseFlags(argv, ["comparisons", "out"]);
  if (flags === null) {
    process.stdout.write(
      "aggregate — fold per-consumer comparisons into the divergence ledger\n" +
        "--comparisons <a.jsonl,b.jsonl,c.jsonl> --out <ledger.jsonl>\n",
    );
    return;
  }
  /** @type {Comparison[]} */
  const comparisons = req(flags, "comparisons")
    .split(",")
    .map((path) => {
      const lines = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      /** @type {any[]} */
      const records = lines.map((line) => JSON.parse(line));
      const fields = /** @type {FieldRow[]} */ (
        records.filter((record) => record.record === "field")
      );
      const counts = records.find((record) => record.record === "counts");
      const run = records.find((record) => record.record === "run");
      return { consumer: String(run?.consumer ?? path), fields, counts };
    });
  const ledger = aggregateLedger(comparisons);
  const lines = [
    JSON.stringify({
      record: "ledger",
      capturedAt: new Date().toISOString(),
      consumers: ledger.consumers,
      totals: ledger.totals,
      law: "Tier 3 reads unexplained as a stop — the ledger is the gate's input, and every classified row carries its citation",
    }),
  ];
  for (const divergence of ledger.divergences) {
    lines.push(JSON.stringify({ record: "divergence", ...divergence }));
  }
  writeFileSync(req(flags, "out"), `${lines.join("\n")}\n`);
  process.stdout.write(
    `aggregate: ${ledger.totals.consumers} consumers, ${ledger.totals.fieldsPerConsumer} fields each, ` +
      `${ledger.totals.divergent} divergent (${ledger.totals.unexplained} unexplained) → ${req(flags, "out")}\n`,
  );
};

// ---------------------------------------------------------------------------
// §7 — dispatch
// ---------------------------------------------------------------------------

const [mode = "", ...rest] = process.argv.slice(2);
if (mode === "harvest") harvest(rest);
else if (mode === "plan") plan(rest);
else if (mode === "compare") compare(rest);
else if (mode === "aggregate") aggregate(rest);
else {
  process.stdout.write(
    "usage: node e2e/shadow/shadow-run.mjs <harvest|plan|compare|aggregate> [--help]\n" +
      "The §12–14 Tier 1+2 shadow comparison run harness (issue #315). Read-only over the consumers.\n",
  );
  if (mode !== "") process.exitCode = 64;
}
