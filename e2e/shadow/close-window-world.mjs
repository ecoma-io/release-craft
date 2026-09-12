// The Tier 3 world closure (issue #317; decision-log D83): closes ONE
// consumer's decision-window world — the exact world shape the §12–14
// Tier 1+2 harness's plan mode closes (decision D82) — and WRITES it as the
// world document the Release-PR harness reads through `--world`. The Tier 3
// producer act needs the window's world as a file, because phase 12 §2.4's
// law is that the CALLER closes the world and the engine discovers nothing:
// the Release-PR harness reads documents, it never authors them.
//
// The closure laws are D82's, mirrored (each cited at its use below):
//
//   Read-only observer. Every git invocation goes through `gitRead`, which
//   refuses any verb outside the read-only allowlist (the same list the
//   shadow harness enforces — read-only BY ARGUMENT SHAPE, `tag` absent
//   because `git tag <name>` writes). The consumer clone receives zero
//   writes; the only file this script touches is `--out`.
//
//   The window's world, not the checkout's. The declared universe is the
//   FULL ancestry of the window head (the planner's parent-closure law
//   demands every declared parent observed); the recorded state is the BASE
//   release tag alone — the last produced release tag is the sole recorded
//   base for the recomputation, and the recomputed release's own tag is the
//   decision's OUTPUT, never its input; the component manifest is read at
//   the base commit, the recorded state the decision was made from.
//
//   Recorded state, honest spellings. Observed tag names carry the `v`
//   prefix; the kernel's grammar is strict SemVer 2.0.0, so the world
//   declares the version-bearing name with the prefix stripped and the
//   observed refname rides `--out`'s summary line. The policy block is
//   DECLARED (the planner carries its digest verbatim into the plan's
//   identity, never interprets it) but DERIVED from the consumer's recorded
//   release-please config: `bump-minor-pre-major` → the pre-1.0 dampening
//   posture, `include-component-in-tag` + the observed tag spelling → the
//   tagFormats template. A config whose derivation facts disagree with the
//   declared block faults the closure — a policy copied from habit instead
//   of derived from the consumer is exactly the foreign-world lie this
//   instrument exists to prevent.
//
// Usage: `node e2e/shadow/close-window-world.mjs --help`.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

/** The read-only git verbs — the shadow harness's allowlist, verbatim
 * (e2e/shadow/shadow-run.mjs §1; D82's recorded command surface). */
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
    throw new Error(`git verb "${String(verb)}" is outside the closure's read-only surface`);
  }
  return run("git", ["-C", clone, ...args]);
};

/**
 * Runs a process, failing loudly on a non-zero exit.
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

/**
 * Parses `--flag value` pairs; `--help` prints the protocol and stops.
 *
 * @param {readonly string[]} argv
 * @returns {Record<string, string> | null}
 */
const parseFlags = (argv) => {
  const allowed = ["clone", "base-tag", "head", "component", "line", "policy-digest", "out"];
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
        `unknown flag --${name} — this closure accepts: ${allowed.map((f) => `--${f}`).join(", ")}`,
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
 * Reads one flag parseFlags guaranteed to be present.
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
 * body, committed date. The planner's closed parent-closure universe.
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

/**
 * Strips the leading `v` the kernel's strict SemVer grammar refuses, for
 * the world's declared tag names (the observed `refs/tags/<name>` rides
 * the summary line; the declared tagFormats template keeps the `v`).
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

function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags === null) {
    process.stdout.write(
      "close-window-world — close one consumer's decision-window world (D82's laws) as a " +
        "world document\n" +
        "--clone <path> --base-tag <the tag before the release> --head <the release commit>\n" +
        "--component <name> --line <id> --policy-digest <label> --out <path>\n" +
        "Read-only over the clone; the only write is --out. The policy block is derived from\n" +
        "the consumer's recorded release-please-config.json at --head and faults on a " +
        "disagreement.\n",
    );
    return;
  }
  const clone = req(flags, "clone");
  const baseTag = req(flags, "base-tag");
  const head = req(flags, "head");
  const component = req(flags, "component");
  const lineId = req(flags, "line");
  const policyDigest = req(flags, "policy-digest");
  if (lineId.includes("/")) {
    throw new Error(
      `line id ${JSON.stringify(lineId)} carries a slash — this closure declares the ` +
        "single-component main-line posture (feedRef refs/heads/<line>)",
    );
  }

  // The recorded base (D82: the base tag is the sole recorded base; the
  // recomputed release's own tag is the decision's output, never its input).
  const baseSha = tagCommit(clone, baseTag);
  if (baseSha === head) {
    throw new Error(
      `the base tag ${baseTag} binds the head ${head} — the window is empty; the base release ` +
        "and the recomputed release cannot be the same commit",
    );
  }
  const headSha = gitRead(clone, ["rev-parse", `${head}^{commit}`]).trim();

  // The universe: the FULL ancestry of the window head (the planner's
  // parent-closure law).
  const commits = ancestryOf(clone, headSha);
  const universe = new Set(commits.map((commit) => commit.sha));
  if (!universe.has(baseSha)) {
    throw new Error(
      `the base tag's commit ${baseSha} is not in the head's ancestry — the window's base is ` +
        "unobservable from the declared head",
    );
  }

  // The declared tags: the base tag alone (D82's one-tag world law).
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
  const baseTagRef = allTags.find(
    (tag) =>
      tag.commit === baseSha &&
      versionBearingTagName(tag.name) === versionBearingTagName(`refs/tags/${baseTag}`),
  );
  if (baseTagRef === undefined) {
    throw new Error(
      `no observed tag binds the base commit ${baseSha} under the spelling ${baseTag} — the ` +
        "recorded base is a declared lie the closure refuses to write",
    );
  }
  const declaredTagName = versionBearingTagName(baseTagRef.name);

  // The component manifest as the BASE held it (D82: the recorded state the
  // decision was made from).
  const manifest = /** @type {{ name?: unknown, version?: unknown }} */ (
    JSON.parse(gitRead(clone, ["show", `${baseSha}:package.json`]))
  );
  const manifestVersion = String(manifest.version ?? "");
  if (manifestVersion === "") {
    throw new Error(`package.json at ${baseSha} carries no version`);
  }

  // The policy block: declared, derived from the consumer's recorded
  // release-please config at the window head. The derivation facts fault
  // the closure when they disagree with the declared values.
  const config = /** @type {Record<string, unknown>} */ (
    JSON.parse(gitRead(clone, ["show", `${headSha}:release-please-config.json`]))
  );
  const root = /** @type {Record<string, unknown>} */ (
    /** @type {Record<string, Record<string, unknown>>} */ (config.packages)?.["."] ??
      /** @type {Record<string, Record<string, unknown>>} */ (config.packages)?.[""]
  );
  if (root === undefined || typeof root !== "object") {
    throw new Error("the recorded release-please config declares no root package");
  }
  const bumpMinorPreMajor = root["bump-minor-pre-major"] === true;
  const includeComponentInTag = root["include-component-in-tag"] === true;
  if (bumpMinorPreMajor !== true) {
    throw new Error(
      "the recorded config carries bump-minor-pre-major: false — the declared pre-1.0 " +
        "dampening posture does not derive from this consumer; the closure refuses to guess",
    );
  }
  if (includeComponentInTag !== false) {
    throw new Error(
      "the recorded config carries include-component-in-tag: true — the declared tagFormats " +
        "template (no component token) does not derive from this consumer",
    );
  }
  const policy = {
    digest: policyDigest,
    bumpMappingId: "default",
    prereleaseLadder: ["alpha", "beta", "rc"],
    prereleaseSeed: "0",
    pre10Dampening: true,
    selfReferenceNamespace: "Release-Craft:",
    // The recorded tags' `v` spelling, minted form; no component token (the
    // recorded include-component-in-tag: false).
    tagFormats: { [lineId]: "v{major}.{minor}.{patch}{prerelease}" },
  };

  const feedRef = `refs/heads/${lineId}`;
  const world = {
    policy,
    repository: {
      commits: commits.map((commit) => ({
        sha: commit.sha,
        message: commit.message,
        committedAt: commit.committedAt,
        parents: commit.parents,
        containingRefs: [feedRef],
      })),
      refs: [{ name: feedRef, head: headSha }],
    },
    history: { tags: [{ name: declaredTagName, commit: baseSha }] },
    lines: [{ id: lineId, feedRef, lifecycle: "active", declared: true }],
    components: [{ name: component, manifestVersion, paths: ["package.json"] }],
  };
  writeFileSync(req(flags, "out"), `${JSON.stringify(world, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify(
      {
        out: req(flags, "out"),
        baseTag,
        baseSha,
        head: headSha,
        observedBaseTagRef: baseTagRef.name,
        declaredTagName,
        commits: commits.length,
        component,
        manifestAtBase: manifestVersion,
        manifestNameAtBase: typeof manifest.name === "string" ? manifest.name : null,
        policy,
        policyDerivation: {
          pre10Dampening: `release-please-config.json at ${headSha}: bump-minor-pre-major: true`,
          tagFormats: `the observed tag spelling ${baseTagRef.name} + include-component-in-tag: false`,
        },
        commandSurface: `git read verbs only (${READONLY_GIT_VERBS.join(", ")}) — enforced before git runs; the only write is --out`,
      },
      null,
      2,
    )}\n`,
  );
}

try {
  main();
} catch (error) {
  // A closure fault is loud, never an empty world: the failing step's own
  // words are the evidence.
  process.stderr.write(
    `close-window-world: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
