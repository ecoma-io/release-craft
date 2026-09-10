/**
 * Slice 10.5 — the GitHub-backed vertical fixture (contract
 * docs/design/phase10-vertical-matrix-contract.md §4 "10.5").
 *
 * The assembled adapter (ADR-0010's `openGitHubAdapter`) over the matrix,
 * constructed zero-config: the binding's repository path, the supplied
 * credentials, and the caller-injected transport — nothing ambient (§5's
 * zero-config law; ADR-0010 decision 2). The run driver is 10.4's git-backed
 * one (matrix.ts's declared world through `runGitRelease`); this layer adds
 * only the remote half the adapter owns:
 *
 * - the binding's create-if-absent tag door mints real refs in the temp
 *   repository (the mint runs inside the reused run driver), and the
 *   adapter's synchronization — the git-path unit — pushes the recorded refs
 *   to a real bare `origin` the fixture stands up beside the repo. The
 *   fixture never pushes: the adapter's own runner is the only writer of the
 *   remote's refs;
 * - the injected `GitHubTransport` IS the fake GitHub remote: its two
 *   listings (paginated, D32), its release read and its one create route are
 *   the whole API surface the publication and reconciliation doors reach.
 *   No fixture spawns network anywhere;
 * - the changelog the publication door derives is recorded evidence: the
 *   changelog artifact's producer records a `git-tree:` digest of a real
 *   tree, so `binding.content.file` (§2.8's seam) resolves the exact bytes
 *   the release body must equal — bytes over values through the read doors;
 * - the concurrency rows intercept at the transport seam (§7): the
 *   arm-gated concurrent writer lands between the publication door's
 *   idempotency read and its create — ADR-0011's hostile pattern with the
 *   injected transport where 10.4 used a `git` PATH shim.
 *
 * Every golden is matrix.ts recorded data consumed verbatim — no fixture
 * computes. No clock, no environment, no randomness (§5).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openGitHubAdapter,
  type GitHubAdapter,
  type GitHubCredentials,
  type GitHubRequestInit,
  type GitHubResponse,
  type GitHubTransport,
} from "@ecoma-io/release-craft/__internal__/adapters/github/index.js";
import {
  hermeticGitEnv,
  type GitRun,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import type { ArtifactProducer } from "@ecoma-io/release-craft/__internal__/execution/index.js";
import { withTempRepo } from "../adapters/git/temp-repo.js";
import { openGitState, type Declarations, type GitState } from "./matrix-git.js";
import { artifactProducers, hookEffects, matrixArtifacts, matrixHooks } from "./matrix.js";

// ---------------------------------------------------------------------------
// The recorded changelog and the credentials — fixture data, never computed
// ---------------------------------------------------------------------------

/** The file the publication door projects (the §2.8 seam's path). */
export const CHANGELOG_PATH = "CHANGELOG.md";

/** The recorded changelog bytes: the body every release publishes, read
 * back through `binding.content.file` in the assertions — never restated. */
export const CHANGELOG_BODY = "# the recorded changelog\n\n- the matrix release\n";

/** A second recorded body — what an out-of-band writer publishes instead. */
export const DIVERGENT_BODY = "# a different history\n\n- not the recorded changelog\n";

/** The credentials supplied at open (contract §2.5) — fixture data. */
export const credentials: GitHubCredentials = {
  owner: "ecoma-io",
  repo: "release-craft",
  token: "t0k3n",
};

/** Out-of-band remote material (V10): shas and names the binding holds no
 * record of — written by no adapter door, only by the fake remote's own
 * mutation API. */
export const OUT_OF_BAND_SHA = "b".repeat(40);
export const OUT_OF_BAND_TAG = "9.9.9";

// ---------------------------------------------------------------------------
// The fake GitHub remote — the injected transport's whole backend
// ---------------------------------------------------------------------------

/** One transport call, exactly as the composed adapter issued it. */
export interface TransportCall {
  readonly path: string;
  readonly init?: GitHubRequestInit;
}

/** The fake remote the fixture injects at open. State, call log, fault
 * programming, and the hostile arm all hang off one value; the transport
 * view is what `openGitHubAdapter` receives. */
export interface FakeRemote {
  readonly transport: GitHubTransport;
  /** Every call, in order — the bytes-over-values record of what the
   * adapter asked (paths only; the transport applies the credential). */
  readonly calls: readonly TransportCall[];
  /** The remote's tags: name → commit sha. */
  readonly tags: ReadonlyMap<string, string>;
  /** The remote's releases: tag → release body. */
  readonly releases: ReadonlyMap<string, string>;
  /** The release URL the remote handed out per tag — deterministic fixture
   * data, never ambient material. */
  readonly releaseUrls: ReadonlyMap<string, string>;
  /** Writes the remote's state directly — the seeding shape after a sync
   * (the report rows having been asserted first) and the out-of-band
   * mutation shape (V10) alike. Never an adapter door. */
  putTag(name: string, sha: string): void;
  putRelease(tag: string, body: string): void;
  /** Programs the tags listing to answer `status` (0 = unreachable) with
   * the given headers — the D30 outcome legs. */
  failTags(status: number, headers?: Readonly<Record<string, string>>): void;
  /** Programs the releases listing the same way. */
  failReleases(status: number, headers?: Readonly<Record<string, string>>): void;
  /** The D32 walk's page size for both listings. */
  readonly pageEvery: number;
  /** Arms the hostile concurrent writer: the next create the publication
   * door issues finds its tag already released by another writer — `body`
   * is what that writer published. Fires once (the fired-flag world). */
  armConcurrentWriter(body: string): void;
  /** Whether the armed writer fired. */
  readonly concurrentWriterFired: () => boolean;
}

/** The listings paginate (D32): a small fixed page size forces the walk
 * through `Link: rel="next"` headers, so the vertical's comparisons run
 * over the complete surface, never one page of it. */
const PAGE_EVERY = 2;

const page = <T>(
  rows: readonly T[],
  query: string,
  base: string,
): {
  readonly rows: readonly T[];
  readonly headers: Readonly<Record<string, string>>;
} => {
  const match = /[?&]page=(\d+)/.exec(query);
  const index = match === null ? 1 : Number.parseInt(match[1] ?? "1", 10);
  const slice = rows.slice((index - 1) * PAGE_EVERY, index * PAGE_EVERY);
  const more = index * PAGE_EVERY < rows.length;
  return {
    rows: slice,
    headers: more ? { link: `<${base}?per_page=100&page=${String(index + 1)}>; rel="next"` } : {},
  };
};

/** The URL the remote hands out per release — deterministic fixture data,
 * never ambient material. */
const releaseUrlFor = (tag: string): string =>
  `https://github.fake/${credentials.owner}/${credentials.repo}/releases/tag/${tag}`;

export const openFakeRemote = (): FakeRemote => {
  const tags = new Map<string, string>();
  const releases = new Map<string, string>();
  const urls = new Map<string, string>();
  const calls: TransportCall[] = [];
  let tagFault: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
  } | null = null;
  let releaseFault: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
  } | null = null;
  /** The armed concurrent writer's body — landed in the create window. */
  let armed: string | null = null;
  let fired = false;
  const tagRow = (name: string, sha: string): unknown => ({ name, commit: { sha } });
  const releaseRow = (tag: string): unknown => ({ tag_name: tag });
  const listResponse = (rows: readonly unknown[], query: string, base: string): GitHubResponse => {
    const viewed = page(rows, query, base);
    return { status: 200, headers: viewed.headers, body: JSON.stringify(viewed.rows) };
  };
  const createRelease = (tag: string, body: string): GitHubResponse => {
    releases.set(tag, body);
    urls.set(tag, releaseUrlFor(tag));
    return { status: 201, headers: {}, body: JSON.stringify({ html_url: urls.get(tag) }) };
  };
  const transport: GitHubTransport = {
    request(path, init) {
      const call: TransportCall = init === undefined ? { path } : { path, init };
      calls.push(call);
      const queryStart = path.indexOf("?");
      const route = queryStart < 0 ? path : path.slice(0, queryStart);
      const query = queryStart < 0 ? "" : path.slice(queryStart);
      const base = route.slice(0, route.lastIndexOf("/"));
      if (route.endsWith("/tags")) {
        if (tagFault !== null) {
          return { status: tagFault.status, headers: tagFault.headers, body: "" };
        }
        const rows = [...tags.entries()]
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([name, sha]) => tagRow(name, sha));
        return listResponse(rows, query, `${base}/tags`);
      }
      if (route.includes("/releases/tags/")) {
        const tag = decodeURIComponent(route.slice(route.lastIndexOf("/") + 1));
        const body = releases.get(tag);
        if (body === undefined) {
          return { status: 404, headers: {}, body: JSON.stringify({ message: "Not Found" }) };
        }
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ html_url: urls.get(tag), body }),
        };
      }
      if (route.endsWith("/releases")) {
        if (releaseFault !== null) {
          return { status: releaseFault.status, headers: releaseFault.headers, body: "" };
        }
        if (init?.method !== "POST" || init.body === undefined) {
          const rows = [...releases.keys()].sort().map(releaseRow);
          return listResponse(rows, query, `${base}/releases`);
        }
        const parsed: unknown = JSON.parse(init.body);
        const read = (field: string): string | undefined =>
          parsed !== null &&
          typeof parsed === "object" &&
          field in parsed &&
          typeof (parsed as Record<string, unknown>)[field] === "string"
            ? (parsed as Record<string, string>)[field]
            : undefined;
        const tag = read("tag_name");
        const body = read("body");
        if (tag === undefined || body === undefined) {
          throw new Error("fixture broken: the create names no tag or no body");
        }
        if (releases.has(tag)) {
          // The provider refuses a create over an existing release — it
          // never overwrites, and it never creates a duplicate.
          return {
            status: 422,
            headers: {},
            body: JSON.stringify({ message: "already_exists" }),
          };
        }
        if (armed !== null) {
          // The concurrent writer lands in the window between the
          // publication door's idempotency read and this create: the door's
          // write loses its race, and the provider refuses it above — the
          // landing is the writer's, never the door's.
          releases.set(tag, armed);
          urls.set(tag, releaseUrlFor(tag));
          armed = null;
          fired = true;
          return { status: 422, headers: {}, body: JSON.stringify({ message: "already_exists" }) };
        }
        return createRelease(tag, body);
      }
      throw new Error(`fixture broken: the fake remote serves no route for ${path}`);
    },
  };
  return {
    transport,
    calls,
    tags,
    releases,
    releaseUrls: urls,
    putTag: (name, sha) => {
      tags.set(name, sha);
    },
    putRelease: (tag, body) => {
      releases.set(tag, body);
      urls.set(tag, releaseUrlFor(tag));
    },
    failTags: (status, headers) => {
      tagFault = { status, headers: headers ?? {} };
    },
    failReleases: (status, headers) => {
      releaseFault = { status, headers: headers ?? {} };
    },
    pageEvery: PAGE_EVERY,
    armConcurrentWriter: (body) => {
      armed = body;
      fired = false;
    },
    concurrentWriterFired: () => fired,
  };
};

// ---------------------------------------------------------------------------
// The vertical state — zero-config assembly over one repository
// ---------------------------------------------------------------------------

/** The tag rows the binding records, as the fake remote's tags read after a
 * sync landed them: name → recorded target. Seeding shape only — the sync
 * report rows are asserted first, never assumed. */
export const recordedTagRows = (state: GitState): readonly { name: string; target: string }[] =>
  state.binding.refs
    .tags()
    .filter((row) => row.ref.startsWith("refs/tags/"))
    .map((row) => ({ name: row.ref.slice("refs/tags/".length), target: row.target }));

export interface GitHubVerticalState {
  readonly repo: string;
  /** The bare repository the sync's git path transports against — `origin`,
   * ADR-0010 decision 3's default, configured by the fixture substrate. */
  readonly origin: string;
  /** The 10.4 git-backed state the adapter opens over (binding, runner,
   * line heads, standing channels). */
  readonly state: GitState;
  /** The changelog artifact's recorded digest — the `git-tree:` identity
   * the producer records, the §2.4 idempotency key's digest half. */
  readonly changelogDigest: string;
  readonly changelogBody: string;
  /** The declaration set whose changelog producer records the real tree —
   * the one override the publication seam needs. */
  readonly declarations: Declarations;
  /** Zero-config (§5): the adapter opens on the binding, the credentials,
   * and the injected transport — nothing else, nothing ambient. */
  adapter(transport: GitHubTransport): GitHubAdapter;
}

/** Records the changelog bytes as a real tree and returns its `git-tree:`
 * digest — the shape `binding.content.file` reads. Content-addressed, so
 * the digest is identical on every fresh repository (determinism, §7). */
const recordChangelogTree = (git: GitRun): string => {
  const blob = git(["hash-object", "-w", "--stdin"], CHANGELOG_BODY).trim();
  const tree = git(["mktree"], `100644 blob ${blob}\t${CHANGELOG_PATH}\n`).trim();
  return `git-tree:${tree}`;
};

/** The changelog producer the publication seam needs: it records the
 * fixture's real tree digest instead of an opaque label, so the §2.8
 * derivation resolves the recorded bytes. */
const changelogProducer =
  (digest: string): ArtifactProducer =>
  (input) => ({
    attribution: { attemptId: input.attemptId, actor: "automation" },
    digest,
    evidence: `evidence:${input.artifactId}`,
  });

const spawn = (args: readonly string[], cwd?: string): void => {
  const result = spawnSync("git", [...args], {
    ...(cwd === undefined ? {} : { cwd }),
    env: hermeticGitEnv(),
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${String(result.status ?? "unknown")}): ${result.stderr}`,
    );
  }
};

/**
 * Runs `fn` against a fresh fixture: a temp repository with the 10.4
 * git-backed state seeded on it, a bare `origin` beside it, and the
 * changelog tree recorded. Everything is removed whether the body passes or
 * fails. The repository carries the fixed identity and clock (the binding's
 * hermetic floor), so every object id a test observes is a pure function of
 * its own writes.
 */
export function withGitHubVertical(name: string, fn: (state: GitHubVerticalState) => void): void {
  withTempRepo(name, (repo, git) => {
    const origin = mkdtempSync(join(tmpdir(), `release-craft-github-vertical-origin-${name}-`));
    try {
      spawn(["init", "--bare", "--quiet", origin], origin);
      spawn(["-C", repo, "remote", "add", "origin", origin]);
      const state = openGitState(repo);
      const changelogDigest = recordChangelogTree(git);
      const hooks = matrixHooks();
      const producers = artifactProducers();
      const vertical: GitHubVerticalState = {
        repo,
        origin,
        state,
        changelogDigest,
        changelogBody: CHANGELOG_BODY,
        declarations: {
          hooks: [hooks.notify, hooks.publishHook],
          artifacts: matrixArtifacts(),
          hookEffects: hookEffects({
            notify: { evidence: "evidence:notify" },
            announce: { evidence: "evidence:announce" },
          }),
          producers: new Map([...producers, ["changelog", changelogProducer(changelogDigest)]]),
        },
        adapter: (transport) => openGitHubAdapter(state.binding, credentials, transport),
      };
      fn(vertical);
    } finally {
      rmSync(origin, { recursive: true, force: true });
    }
  });
}
