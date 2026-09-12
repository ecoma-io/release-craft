/**
 * The Release PR port's unit suite (issue #309). The port is the Release
 * PR gate's remote half, so every law the issue binds is pinned here
 * against a fake transport speaking the real REST shapes: discovery by
 * the embedded claim marker only (never title, never label) with the
 * loud refusals for a malformed marker, a duplicate pair, and an
 * incomplete listing; the create's honesty about its partial states
 * (the branch-pushed-PR-unopened fault, the already-exists adoption and
 * its foreign-occupier refusal, the branch reused without a second
 * commit); and the update's files-first ordering with its byte-exact
 * idempotent re-run. The conformance pin closes the structural-twin
 * loose end: a body the application gate's own render produced parses
 * here to the identity it was rendered from.
 */

import { createHash } from "node:crypto";

import {
  GitReleasePR,
  GitHubReleasePRFault,
} from "@ecoma-io/release-craft/__internal__/adapters/github/release-pr.js";
import type {
  GitHubCredentials,
  GitHubReleasePRIdentity,
  GitHubRequestInit,
  GitHubResponse,
  GitHubTransport,
} from "@ecoma-io/release-craft/__internal__/adapters/github/index.js";
import { Version } from "@ecoma-io/release-craft/domain";
import { renderReleasePRProjection, type PlanLine, type ReleasePlan } from "../../../src/index.js";
import { describe, expect, it } from "vitest";

const credentials: GitHubCredentials = {
  owner: "ecoma-io",
  repo: "release-craft",
  token: "t0k3n",
};

const identity: GitHubReleasePRIdentity = {
  component: "lib-a",
  releaseLine: "lib-a",
  targetBranch: "main",
};

/** The branch grammar the port owns (issue #309): derived from the
 *  identity, injective over it. */
const derivedBranch = "release-craft--branches--main--lines--lib-a--components--lib-a";

const ROOT_SHA = "a".repeat(40);
const ROOT_TREE = "b".repeat(40);

const markerFor = (
  component: string,
  line: string,
  target: string,
  plan = "plan_sha256:aabbccdd",
): string =>
  `<!-- release-craft: identity component=${component} line=${line} target=${target} plan=${plan} -->`;

const bodyWith = (marker: string): string =>
  `## Release\n\n${marker}\n\nThe gate's projection body.\n`;

// ---------------------------------------------------------------------------
// The fake GitHub: an in-memory remote speaking the REST shapes the port
// reads. State (refs, commits, trees, pulls) evolves exactly as the real
// provider's would, so the pins are behavioral — a pin asserts what holds
// remotely, not which call sequence produced it.
// ---------------------------------------------------------------------------

interface FakePull {
  number: number;
  title: string;
  body: string;
  draft: boolean;
  state: string;
  headRef: string;
  labels: string[];
}

/** The remote's state plus the fault switches a pin sets to reproduce one
 *  failure mode. `failPullOpen` reproduces the create's partial states:
 *  `lost` throws mid-call after the branch landed, `conflict` records the
 *  PR and answers the provider's already-exists 422 (a lost 201),
 *  `no-commits` refuses the open and leaves the branch pushed. */
class FakeGitHub {
  readonly refs = new Map<string, string>([["main", ROOT_SHA]]);
  readonly commitTrees = new Map<string, string>([[ROOT_SHA, ROOT_TREE]]);
  readonly treeBlobs = new Map<string, Map<string, string>>([[ROOT_TREE, new Map()]]);
  readonly pulls: FakePull[] = [];
  #nextNumber = 101;
  #nextCommit = 0;
  failPullOpen: "lost" | "conflict" | "no-commits" | null = null;
  failPullPatch: "lost" | "refused" | null = null;
  failLabelsPut: "lost" | "refused" | null = null;
  probeStatus = 200;

  /** The tree sha for a composed tree's content — pure over the entries,
   *  exactly as git's object identity is: two trees holding the same
   *  bytes are the same object, so an unchanged projection re-derives the
   *  same sha no matter which base it was built on (the idempotent
   *  re-run's evidence). */
  treeShaForBlobs(blobs: ReadonlyMap<string, string>): string {
    const hash = createHash("sha1");
    for (const path of [...blobs.keys()].sort()) {
      hash.update(`${path}\0${blobs.get(path) ?? ""}\0`);
    }
    return `tree-${hash.digest("hex")}`;
  }

  branchHead(branch: string): string | undefined {
    return this.refs.get(branch);
  }

  /** The bytes a path carries on a branch, read through the commit's
   *  tree — the byte-exact pins' read seam. */
  fileOnBranch(branch: string, path: string): string | undefined {
    const head = this.refs.get(branch);
    if (head === undefined) return undefined;
    const tree = this.commitTrees.get(head);
    if (tree === undefined) return undefined;
    return this.treeBlobs.get(tree)?.get(path);
  }

  transport(): { transport: GitHubTransport; calls: { path: string; init?: GitHubRequestInit }[] } {
    const calls: { path: string; init?: GitHubRequestInit }[] = [];
    const response = (status: number, body: unknown): GitHubResponse => ({
      status,
      headers: {},
      body: JSON.stringify(body),
    });
    const transport: GitHubTransport = {
      request: (path, init) => {
        calls.push(init === undefined ? { path } : { path, init });
        const body: Record<string, unknown> =
          init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>);
        const repo = "/repos/ecoma-io/release-craft";

        // The pull-request listing (the discovery walk's entry).
        if (path === `${repo}/pulls?state=open&per_page=100`) {
          return response(200, this.pulls.filter((pull) => pull.state === "open").map(toRow));
        }
        // The repository probe (the 404 discrimination).
        if (path === repo) {
          return response(this.probeStatus, { message: "Not Found" });
        }
        // A single pull request read.
        const singlePull = /^\/repos\/ecoma-io\/release-craft\/pulls\/(\d+)$/.exec(path);
        if (singlePull !== null) {
          const pull = this.pulls.find(
            (candidate) => candidate.number === Number(singlePull[1] ?? ""),
          );
          if (pull === undefined) {
            return response(404, { message: "Not Found" });
          }
          if (init?.method === "PATCH") {
            if (this.failPullPatch === "lost") {
              throw new Error("socket hang up");
            }
            if (this.failPullPatch === "refused") {
              return response(403, { message: "Resource not accessible" });
            }
            pull.title = textOr(body["title"], pull.title);
            pull.body = textOr(body["body"], pull.body);
          }
          return response(200, toRow(pull));
        }
        // The pull request open (with the partial-create fault switches).
        if (path === `${repo}/pulls` && init?.method === "POST") {
          const headRef = text(body["head"]);
          if (this.failPullOpen === "lost") {
            throw new Error("socket hang up");
          }
          if (this.pulls.some((pull) => pull.headRef === headRef && pull.state === "open")) {
            return response(422, {
              message: `A pull request already exists for ecoma-io:${headRef}.`,
            });
          }
          if (this.failPullOpen === "conflict") {
            this.openPull(body);
            return response(422, {
              message: `A pull request already exists for ecoma-io:${headRef}.`,
            });
          }
          if (this.failPullOpen === "no-commits") {
            return response(422, { message: "No commits between main and the branch." });
          }
          const pull = this.openPull(body);
          return response(201, { number: pull.number });
        }
        // The label set replace (the issues API owns pull requests' labels).
        const labelsPut = /^\/repos\/ecoma-io\/release-craft\/issues\/(\d+)\/labels$/.exec(path);
        if (labelsPut !== null && init?.method === "PUT") {
          const pull = this.pulls.find(
            (candidate) => candidate.number === Number(labelsPut[1] ?? ""),
          );
          if (pull === undefined) {
            return response(404, { message: "Not Found" });
          }
          if (this.failLabelsPut === "lost") {
            throw new Error("socket hang up");
          }
          if (this.failLabelsPut === "refused") {
            return response(403, { message: "Resource not accessible" });
          }
          pull.labels = (body["labels"] as string[]).slice();
          return response(200, toRow(pull));
        }
        // The ref read (the branch head), with the probe behind its 404.
        const refRead = /^\/repos\/ecoma-io\/release-craft\/git\/ref\/heads\/(.+)$/.exec(path);
        if (refRead !== null) {
          const branch = refRead[1] ?? "";
          const sha = this.refs.get(branch);
          if (sha === undefined) {
            return response(404, { message: "Not Found" });
          }
          return response(200, { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } });
        }
        // The ref create and the fast-forward-only move.
        if (path === `${repo}/git/refs` && init?.method === "POST") {
          const ref = text(body["ref"]);
          const branch = ref.replace(/^refs\/heads\//, "");
          if (this.refs.has(branch)) {
            return response(422, { message: "Reference already exists" });
          }
          this.refs.set(branch, text(body["sha"]));
          return response(201, { ref });
        }
        const refPatch = /^\/repos\/ecoma-io\/release-craft\/git\/refs\/heads\/(.+)$/.exec(path);
        if (refPatch !== null && init?.method === "PATCH") {
          const branch = refPatch[1] ?? "";
          if (!this.refs.has(branch)) {
            return response(422, { message: "Reference does not exist" });
          }
          this.refs.set(branch, text(body["sha"]));
          return response(200, { ref: `refs/heads/${branch}` });
        }
        // A commit read (its tree).
        const commitRead = /^\/repos\/ecoma-io\/release-craft\/git\/commits\/([0-9a-f-]+)$/.exec(
          path,
        );
        if (commitRead !== null) {
          const tree = this.commitTrees.get(commitRead[1] ?? "");
          if (tree === undefined) {
            return response(404, { message: "Not Found" });
          }
          return response(200, { tree: { sha: tree } });
        }
        // The tree write: derived content, never committed until a commit
        // names it — the sha is the composed tree content's identity.
        if (path === `${repo}/git/trees` && init?.method === "POST") {
          const baseTree = text(body["base_tree"]);
          const entries: { path: string; content: string }[] = Array.isArray(body["tree"])
            ? (body["tree"] as { path: string; content: string }[])
            : [];
          const blobs = new Map<string, string>(this.treeBlobs.get(baseTree) ?? []);
          for (const entry of entries) {
            blobs.set(entry.path, entry.content);
          }
          const sha = this.treeShaForBlobs(blobs);
          if (!this.treeBlobs.has(sha)) {
            this.treeBlobs.set(sha, blobs);
          }
          return response(201, { sha });
        }
        // The commit write.
        if (path === `${repo}/git/commits` && init?.method === "POST") {
          const sha = `c${String(this.#nextCommit++).padStart(40, "0")}`;
          this.commitTrees.set(sha, text(body["tree"]));
          return response(201, { sha });
        }
        return response(404, { message: `the fake has no handler for ${path}` });
      },
    };
    return { transport, calls };
  }

  /** Records a pull request from an open's body — the one place the fake
   *  mints numbers. */
  private openPull(body: Record<string, unknown>): FakePull {
    const pull: FakePull = {
      number: this.#nextNumber++,
      title: text(body["title"]),
      body: text(body["body"]),
      draft: body["draft"] === true,
      state: "open",
      headRef: text(body["head"]),
      labels: [],
    };
    this.pulls.push(pull);
    return pull;
  }

  /** Seeds a pull request from the outside (a foreign PR, an existing
   *  claim, a duplicate pair). */
  seedPull(pull: Partial<FakePull> & { body: string; headRef: string }): FakePull {
    const row: FakePull = {
      number: this.#nextNumber++,
      title: pull.title ?? "a pull request",
      body: pull.body,
      draft: pull.draft ?? false,
      state: pull.state ?? "open",
      headRef: pull.headRef,
      labels: pull.labels ?? [],
    };
    this.pulls.push(row);
    return row;
  }
}

/** The body field as text — the fake's reads of the port's JSON writes,
 *  which always carry strings; anything else reads as the empty string. */
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The body field as text with a fallback — the PATCH form, whose body
 *  names only the fields being written. */
const textOr = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

const toRow = (pull: FakePull): unknown => ({
  number: pull.number,
  title: pull.title,
  body: pull.body,
  draft: pull.draft,
  state: pull.state,
  head: { ref: pull.headRef },
  labels: pull.labels.map((name) => ({ name })),
});

/** A listing page fault: the pulls read answers `status` with `body`
 *  (or throws, for the guarded boundary's status 0). */
const listingAlways = (
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): GitHubTransport => ({
  request: () => ({ status, headers, body: JSON.stringify(body) }),
});

const faultOf = (run: () => unknown): GitHubReleasePRFault => {
  try {
    run();
  } catch (error) {
    if (error instanceof GitHubReleasePRFault) {
      return error;
    }
    throw new Error(`expected a GitHubReleasePRFault, got ${String(error)}`, { cause: error });
  }
  throw new Error("expected the door to throw, but it returned");
};

// ---------------------------------------------------------------------------
// Discovery (findPR)
// ---------------------------------------------------------------------------

describe("the Release PR port's discovery (findPR)", () => {
  it("finds the PR whose body claims the exact identity triplet", () => {
    const github = new FakeGitHub();
    github.seedPull({
      body: bodyWith(markerFor("lib-a", "lib-a", "main")),
      headRef: derivedBranch,
      title: "chore(release): lib-a",
      labels: ["release-craft"],
    });
    const port = GitReleasePR(credentials, github.transport().transport);
    const found = port.findPR(identity);
    expect(found).not.toBeNull();
    expect(found?.number).toBeTypeOf("number");
    expect(found?.headRef).toBe(derivedBranch);
    expect(found?.title).toBe("chore(release): lib-a");
    expect(found?.labels).toEqual(["release-craft"]);
  });

  it("skips foreign PRs — a body with no marker is never adopted, and a triplet mismatch is no match", () => {
    const github = new FakeGitHub();
    github.seedPull({
      body: "A human PR about something else entirely — no marker anywhere.",
      headRef: "feature/human",
    });
    github.seedPull({
      body: bodyWith(markerFor("lib-b", "lib-b", "main")), // another component
      headRef: "release-craft--branches--main--lines--lib-b--components--lib-b",
    });
    github.seedPull({
      body: bodyWith(markerFor("lib-a", "lib-a", "develop")), // another target
      headRef: "release-craft--branches--develop--lines--lib-a--components--lib-a",
    });
    const port = GitReleasePR(credentials, github.transport().transport);
    expect(port.findPR(identity)).toBeNull();
  });

  it("never consults a title or a label — identity is the marker (issue #202 §11.5)", () => {
    const github = new FakeGitHub();
    // A PR titled and labeled exactly as the projection would, carrying
    // no claim: found nothing.
    github.seedPull({
      body: "The title and the label are not the claim.",
      headRef: derivedBranch,
      title: "chore(release): lib-a",
      labels: ["release-craft"],
    });
    const port = GitReleasePR(credentials, github.transport().transport);
    expect(port.findPR(identity)).toBeNull();
  });

  it("refuses loudly when a body carries the marker's signature but does not parse", () => {
    const github = new FakeGitHub();
    github.seedPull({
      body: "## Release\n\n<!-- release-craft: identity component=lib-a line=>\n",
      headRef: derivedBranch,
    });
    const port = GitReleasePR(credentials, github.transport().transport);
    const fault = faultOf(() => port.findPR(identity));
    expect(fault.operation).toBe("findPR");
    expect(fault.state).toBe("refused");
    expect(fault.reason).toBe("release-conflict");
    expect(fault.message).toMatch(/does not parse/);
    expect(fault.message).toMatch(/duplicate/);
  });

  it("refuses over a truncated listing — a full final page with no next is no clean null", () => {
    const github = new FakeGitHub();
    for (let index = 0; index < 100; index += 1) {
      github.seedPull({ body: `foreign PR ${String(index)}`, headRef: `feature/${String(index)}` });
    }
    const port = GitReleasePR(credentials, github.transport().transport);
    const fault = faultOf(() => port.findPR(identity));
    expect(fault.state).toBe("transport-failure");
    expect(fault.message).toMatch(/full page with no next link/);
    expect(fault.message).toMatch(/duplicate PR/);
  });

  it("refuses over a cycling page chain — the walk never spins, and claims nothing", () => {
    let pageTwoRequested = false;
    const link = (target: string): string => `<${target}>; rel="next"`;
    const transport: GitHubTransport = {
      request(path) {
        if (path.includes("page=2")) {
          pageTwoRequested = true;
          return {
            status: 200,
            headers: { link: link("/repos/ecoma-io/release-craft/pulls?state=open&per_page=100") },
            body: JSON.stringify([]),
          };
        }
        return {
          status: 200,
          headers: {
            link: link("/repos/ecoma-io/release-craft/pulls?state=open&per_page=100&page=2"),
          },
          body: JSON.stringify([]),
        };
      },
    };
    const port = GitReleasePR(credentials, transport);
    const fault = faultOf(() => port.findPR(identity));
    expect(fault.state).toBe("transport-failure");
    expect(pageTwoRequested).toBe(true);
  });

  it("refuses over a malformed next — an absolute URL names no requestable page", () => {
    const transport: GitHubTransport = {
      request: () => ({
        status: 200,
        headers: {
          link: '<https://api.github.com/repos/ecoma-io/release-craft/pulls?page=2>; rel="next"',
        },
        body: JSON.stringify([]),
      }),
    };
    const port = GitReleasePR(credentials, transport);
    expect(faultOf(() => port.findPR(identity)).state).toBe("transport-failure");
  });

  it("classifies the listing's refusals through the one table — 401, 403, 404, and a thrown transport", () => {
    const authExpired = faultOf(() =>
      GitReleasePR(credentials, listingAlways(401, { message: "Bad credentials" })).findPR(
        identity,
      ),
    );
    expect(authExpired.state).toBe("refused");
    expect(authExpired.reason).toBe("auth-expired");

    const permission = faultOf(() =>
      GitReleasePR(credentials, listingAlways(403, { message: "Resource not accessible" })).findPR(
        identity,
      ),
    );
    expect(permission.reason).toBe("permission-denied");

    const unobservable = faultOf(() =>
      GitReleasePR(credentials, listingAlways(404, { message: "Not Found" })).findPR(identity),
    );
    expect(unobservable.reason).toBe("unobservable-remote");

    const hostile: GitHubTransport = {
      request: () => {
        throw new Error("ECONNRESET");
      },
    };
    const thrown = faultOf(() => GitReleasePR(credentials, hostile).findPR(identity));
    expect(thrown.state).toBe("transport-failure");
    expect(thrown.detail).toContain("ECONNRESET");
  });

  it("refuses a duplicate pair — two open PRs claiming one identity is the defect state", () => {
    const github = new FakeGitHub();
    github.seedPull({
      body: bodyWith(markerFor("lib-a", "lib-a", "main")),
      headRef: derivedBranch,
    });
    github.seedPull({
      body: bodyWith(markerFor("lib-a", "lib-a", "main")),
      headRef: derivedBranch,
    });
    const port = GitReleasePR(credentials, github.transport().transport);
    const fault = faultOf(() => port.findPR(identity));
    expect(fault.state).toBe("refused");
    expect(fault.reason).toBe("release-conflict");
    expect(fault.message).toMatch(/2 open pull requests claiming the identity/);
  });

  it("parses a body the application gate's own render produced — the structural twins' conformance pin", () => {
    const plan = makePlan();
    const projection = renderReleasePRProjection(identity, plan);
    if (projection === null) {
      throw new Error("expected the fixture plan to render a projection");
    }
    const github = new FakeGitHub();
    github.seedPull({ body: projection.projection.body, headRef: derivedBranch });
    const port = GitReleasePR(credentials, github.transport().transport);
    const found = port.findPR(identity);
    expect(found).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The minimal plan fixture (the app suite's own shape) for the render pins.
// ---------------------------------------------------------------------------

const streamLine: PlanLine = {
  lineId: "lib-a",
  stable: null,
  streams: [
    {
      identifier: "rc",
      version: Version.parse("1.2.1-rc.0"),
      tag: "lib-a-1.2.1-rc.0",
      seed: ".0",
      pointerBase: "1.2.0",
      movesPointer: false,
    },
  ],
  changes: [{ id: "feat-a", lineage: [], type: "feat", bump: "minor" }],
  propagation: { edges: [], order: [], notMoved: [] },
  preconditions: [],
  artifacts: ["changelog"],
};

function makePlan(overrides: Partial<ReleasePlan> = {}): ReleasePlan {
  return {
    planId: "plan_sha256:aabbccdd",
    supersedes: null,
    policyDigest: "digest-1",
    inputsFingerprint: "fingerprint-1",
    refusedIntents: [],
    lines: [streamLine],
    explanation: { foreignTags: [], conflicts: [], excluded: [], withheld: [] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Create (createPR)
// ---------------------------------------------------------------------------

const files = (content: string): { path: string; content: string }[] => [
  { path: "CHANGELOG.md", content },
];

const createParams = (
  overrides: Partial<Parameters<ReturnType<typeof GitReleasePR>["createPR"]>[0]> = {},
): Parameters<ReturnType<typeof GitReleasePR>["createPR"]>[0] => ({
  identity,
  title: "chore(release): lib-a",
  body: bodyWith(markerFor("lib-a", "lib-a", "main")),
  labels: ["release-craft"],
  draft: false,
  files: files("# Changelog\n\n- lib-a: the notes\n"),
  ...overrides,
});

const commitPosts = (calls: readonly { path: string; init?: GitHubRequestInit }[]): number =>
  calls.filter((call) => call.path.endsWith("/git/commits") && call.init?.method === "POST").length;

describe("the Release PR port's create (createPR)", () => {
  it("derives the head branch, commits the projection over the git data API, opens the PR, applies the labels", () => {
    const github = new FakeGitHub();
    const { transport, calls } = github.transport();
    const created = GitReleasePR(credentials, transport).createPR(createParams());
    expect(created.number).toBeTypeOf("number");
    expect(created.headRef).toBe(derivedBranch);
    expect(created.draft).toBe(false);
    expect(created.labels).toEqual(["release-craft"]);
    // The remote holds what the projection said: the branch, its file
    // bytes, the open PR, and its label set.
    expect(github.branchHead(derivedBranch)).toBeDefined();
    expect(github.fileOnBranch(derivedBranch, "CHANGELOG.md")).toBe(
      "# Changelog\n\n- lib-a: the notes\n",
    );
    expect(github.pulls).toHaveLength(1);
    expect(github.pulls[0]?.headRef).toBe(derivedBranch);
    expect(github.pulls[0]?.body).toBe(createParams().body);
    expect(github.pulls[0]?.labels).toEqual(["release-craft"]);
    // The write order the port owns: target read, head read, probe, then
    // the git data API (tree, commit, ref), then the PR, then the labels.
    const paths = calls.map((call) => call.path);
    expect(paths.indexOf("/repos/ecoma-io/release-craft/git/ref/heads/main")).toBeLessThan(
      paths.indexOf(`/repos/ecoma-io/release-craft/git/ref/heads/${derivedBranch}`),
    );
    expect(commitPosts(calls)).toBe(1);
    expect(paths.indexOf("/repos/ecoma-io/release-craft/pulls")).toBeGreaterThan(
      paths.findIndex(
        (path) => path.endsWith("/git/refs") && path !== "/repos/ecoma-io/release-craft/git/refs",
      ),
    );
    expect(paths.at(-1)).toBe("/repos/ecoma-io/release-craft/issues/101/labels");
  });

  it("respects the draft flag through the open", () => {
    const github = new FakeGitHub();
    const created = GitReleasePR(credentials, github.transport().transport).createPR(
      createParams({ draft: true }),
    );
    expect(created.draft).toBe(true);
    expect(github.pulls[0]?.draft).toBe(true);
  });

  it("refuses a body that carries no claim, a mismatched claim, or a malformed marker — before any transport call", () => {
    for (const body of [
      "A body with no marker at all.",
      bodyWith(markerFor("lib-b", "lib-b", "main")),
      "## Release\n\n<!-- release-craft: identity component=lib-a broken -->\n",
    ]) {
      const github = new FakeGitHub();
      const { transport, calls } = github.transport();
      const fault = faultOf(() =>
        GitReleasePR(credentials, transport).createPR(createParams({ body })),
      );
      expect(fault.operation).toBe("createPR");
      expect(fault.state).toBe("refused");
      expect(fault.reason).toBe("release-conflict");
      expect(calls).toHaveLength(0);
    }
  });

  it("refuses a target branch the observable repository does not have — absence is claimed only over the probe", () => {
    const github = new FakeGitHub();
    github.refs.delete("main");
    const { transport, calls } = github.transport();
    const fault = faultOf(() => GitReleasePR(credentials, transport).createPR(createParams()));
    expect(fault.state).toBe("refused");
    expect(fault.message).toMatch(/target branch main does not exist/);
    expect(calls.some((call) => call.path === "/repos/ecoma-io/release-craft")).toBe(true);
  });

  it("classifies an unobservable repository — the branch read's 404 is discriminated by a 404 probe", () => {
    const github = new FakeGitHub();
    github.refs.delete("main");
    github.probeStatus = 404;
    const fault = faultOf(() =>
      GitReleasePR(credentials, github.transport().transport).createPR(createParams()),
    );
    expect(fault.state).toBe("refused");
    expect(fault.reason).toBe("unobservable-remote");
  });

  it("the retry after a partial create adopts the branch — and commits nothing a second time", () => {
    const github = new FakeGitHub();
    // Attempt one: the branch lands, the PR open's response is lost
    // mid-call. The door refuses loudly — never a success — and names
    // exactly what landed.
    github.failPullOpen = "lost";
    const first = github.transport();
    const fault = faultOf(() =>
      GitReleasePR(credentials, first.transport).createPR(createParams()),
    );
    expect(fault.state).toBe("ambiguous");
    expect(fault.message).toMatch(/socket hang up/);
    expect(fault.message).toMatch(/was pushed with the projection/);
    expect(fault.message).toMatch(/findPR/);
    expect(github.branchHead(derivedBranch)).toBeDefined();
    expect(github.pulls).toHaveLength(0);
    // Attempt two: the branch is found carrying the projection, the tree
    // sha is identical, so no commit exists to create — the open proceeds
    // and exactly one commit exists across both attempts.
    github.failPullOpen = null;
    const second = github.transport();
    const created = GitReleasePR(credentials, second.transport).createPR(createParams());
    expect(created.number).toBe(101);
    expect(commitPosts([...first.calls, ...second.calls])).toBe(1);
    expect(github.pulls).toHaveLength(1);
    // The ref create happened once (attempt one); the retry wrote no ref.
    const refCreates = [...first.calls, ...second.calls].filter(
      (call) =>
        call.path === "/repos/ecoma-io/release-craft/git/refs" && call.init?.method === "POST",
    );
    expect(refCreates).toHaveLength(1);
  });

  it("at the provider's already-exists answer, discovery adopts the claim-matching PR — never a second create", () => {
    const github = new FakeGitHub();
    // A lost 201: the PR was recorded remotely, but the answer that came
    // back is the provider's already-exists 422.
    github.failPullOpen = "conflict";
    const created = GitReleasePR(credentials, github.transport().transport).createPR(
      createParams(),
    );
    expect(created.headRef).toBe(derivedBranch);
    expect(github.pulls).toHaveLength(1);
    expect(github.pulls[0]?.body).toBe(createParams().body);
  });

  it("at the provider's already-exists answer over a foreign occupier, the port refuses — the foreign PR is never adopted", () => {
    const github = new FakeGitHub();
    github.seedPull({
      body: "A human PR that happens to sit on the derived branch.",
      headRef: derivedBranch,
    });
    const fault = faultOf(() =>
      GitReleasePR(credentials, github.transport().transport).createPR(createParams()),
    );
    expect(fault.state).toBe("refused");
    expect(fault.reason).toBe("release-conflict");
    expect(fault.message).toMatch(/foreign PR occupies the branch/);
    expect(github.pulls).toHaveLength(1);
  });

  it("a PR open refused after the branch landed is a loud partial create naming the branch, never a success", () => {
    const github = new FakeGitHub();
    github.failPullOpen = "no-commits";
    const fault = faultOf(() =>
      GitReleasePR(credentials, github.transport().transport).createPR(createParams()),
    );
    expect(fault.state).toBe("refused");
    expect(fault.reason).toBe("release-conflict");
    expect(fault.message).toMatch(/was pushed with the projection/);
    expect(fault.message).toMatch(/No commits/);
    expect(github.branchHead(derivedBranch)).toBeDefined();
    expect(github.pulls).toHaveLength(0);
  });

  it("a label write failing after the PR opened is a partial, never a created", () => {
    const github = new FakeGitHub();
    github.failLabelsPut = "refused";
    const fault = faultOf(() =>
      GitReleasePR(credentials, github.transport().transport).createPR(createParams()),
    );
    expect(fault.state).toBe("partial");
    expect(fault.message).toMatch(/opened/);
    expect(fault.message).toMatch(/refused \(permission-denied\)/);
    expect(github.pulls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Update (updatePR)
// ---------------------------------------------------------------------------

/** A fixture that has already created the PR remotely, with the port
 *  still pointed at the same fake — the update pins' common ground. A pin
 *  that counts writes mints its own phase recorder (github.transport())
 *  and runs the phase's door over that recorder's transport. */
const withCreatedPR = (
  fn: (github: FakeGitHub, params: ReturnType<typeof createParams>) => void,
): void => {
  const github = new FakeGitHub();
  GitReleasePR(credentials, github.transport().transport).createPR(createParams());
  fn(github, createParams());
};

const updateParams = (
  github: FakeGitHub,
  overrides: Partial<Parameters<ReturnType<typeof GitReleasePR>["updatePR"]>[0]> = {},
): Parameters<ReturnType<typeof GitReleasePR>["updatePR"]>[0] => ({
  prNumber: github.pulls[0]?.number ?? 0,
  title: "chore(release): lib-a",
  body: bodyWith(markerFor("lib-a", "lib-a", "main")),
  labels: ["release-craft"],
  draft: false,
  files: files("# Changelog\n\n- lib-a: the notes\n"),
  ...overrides,
});

describe("the Release PR port's update (updatePR)", () => {
  it("is idempotent when nothing differs — no commit, no field patch, no label write", () => {
    withCreatedPR((github, params) => {
      const phase = github.transport();
      const headBefore = github.branchHead(derivedBranch);
      const updated = GitReleasePR(credentials, phase.transport).updatePR(updateParams(github));
      expect(updated.title).toBe(params.title);
      expect(github.branchHead(derivedBranch)).toBe(headBefore);
      // The re-run performed no write: the commit count stays at the
      // create's one, and no PATCH, no PUT followed.
      expect(commitPosts(phase.calls)).toBe(0);
      expect(phase.calls.some((call) => call.init?.method === "PATCH")).toBe(false);
      expect(phase.calls.some((call) => call.init?.method === "PUT")).toBe(false);
    });
  });

  it("writes the projected files byte-exact, then the fields, then the labels", () => {
    withCreatedPR((github) => {
      const newBody = bodyWith(markerFor("lib-a", "lib-a", "main", "plan_sha256:eeff0011"));
      const updated = GitReleasePR(credentials, github.transport().transport).updatePR(
        updateParams(github, {
          title: "chore(release): lib-a 1.2.1-rc.0",
          body: newBody,
          labels: ["release-craft", "priority:high"],
          files: files("# Changelog\n\n- lib-a: the new notes\n"),
        }),
      );
      // The bytes on the branch are the projection's, exactly.
      expect(github.fileOnBranch(derivedBranch, "CHANGELOG.md")).toBe(
        "# Changelog\n\n- lib-a: the new notes\n",
      );
      // The fields and the label set match too.
      expect(updated.title).toBe("chore(release): lib-a 1.2.1-rc.0");
      expect(github.pulls[0]?.title).toBe("chore(release): lib-a 1.2.1-rc.0");
      expect(github.pulls[0]?.body).toBe(newBody);
      expect(github.pulls[0]?.labels).toEqual(["release-craft", "priority:high"]);
    });
  });

  it("moves the files before the claim: a failed field patch leaves the branch ahead and the body unrewritten", () => {
    withCreatedPR((github) => {
      github.failPullPatch = "refused";
      const phase = github.transport();
      const fault = faultOf(() =>
        GitReleasePR(credentials, phase.transport).updatePR(
          updateParams(github, {
            title: "chore(release): lib-a next",
            body: bodyWith(markerFor("lib-a", "lib-a", "main", "plan_sha256:eeff0011")),
            files: files("# Changelog\n\n- lib-a: the new notes\n"),
          }),
        ),
      );
      expect(fault.state).toBe("refused");
      expect(fault.reason).toBe("permission-denied");
      // The branch carries the new projection; the body does not claim it
      // yet — a crash after the files never leaves the claim ahead.
      expect(commitPosts(phase.calls)).toBe(1);
      expect(github.fileOnBranch(derivedBranch, "CHANGELOG.md")).toBe(
        "# Changelog\n\n- lib-a: the new notes\n",
      );
      expect(github.pulls[0]?.title).toBe("chore(release): lib-a");
      // The retry writes the fields and succeeds.
      github.failPullPatch = null;
      const updated = GitReleasePR(credentials, github.transport().transport).updatePR(
        updateParams(github, {
          title: "chore(release): lib-a next",
          body: bodyWith(markerFor("lib-a", "lib-a", "main", "plan_sha256:eeff0011")),
          files: files("# Changelog\n\n- lib-a: the new notes\n"),
        }),
      );
      expect(updated.title).toBe("chore(release): lib-a next");
      expect(github.pulls[0]?.body).toContain("plan_sha256:eeff0011");
    });
  });

  it("refuses to overwrite a body that lost its claim mid-flight — a human edit is not the gate's to clobber", () => {
    withCreatedPR((github) => {
      if (github.pulls[0] === undefined) {
        throw new Error("expected the created pull request");
      }
      github.pulls[0].body = "A human rewrote the description; the claim is gone.";
      const phase = github.transport();
      const fault = faultOf(() =>
        GitReleasePR(credentials, phase.transport).updatePR(updateParams(github)),
      );
      expect(fault.state).toBe("refused");
      expect(fault.reason).toBe("release-conflict");
      expect(fault.message).toMatch(/no release-craft identity claim/);
      // The refusal preceded every write: the recorder holds only reads.
      expect(phase.calls.some((call) => call.init?.method !== undefined)).toBe(false);
      expect(github.pulls[0].body).toBe("A human rewrote the description; the claim is gone.");
    });
  });

  it("refuses to overwrite a malformed marker mid-flight — the loud class follows the body, not the door", () => {
    withCreatedPR((github) => {
      if (github.pulls[0] === undefined) {
        throw new Error("expected the created pull request");
      }
      github.pulls[0].body = "<!-- release-craft: identity component=lib-a oops -->";
      const fault = faultOf(() =>
        GitReleasePR(credentials, github.transport().transport).updatePR(updateParams(github)),
      );
      expect(fault.state).toBe("refused");
      expect(fault.message).toMatch(/does not parse/);
    });
  });

  it("refuses a marker whose own identity disagrees with the head branch it sits on — the tampered PR", () => {
    withCreatedPR((github) => {
      if (github.pulls[0] === undefined) {
        throw new Error("expected the created pull request");
      }
      github.pulls[0].body = bodyWith(markerFor("lib-a", "lib-a", "develop"));
      const fault = faultOf(() =>
        GitReleasePR(credentials, github.transport().transport).updatePR(updateParams(github)),
      );
      expect(fault.state).toBe("refused");
      expect(fault.message).toMatch(/the marker and the branch disagree/);
    });
  });

  it("refuses a draft flip — the gate passes the PR's own draft", () => {
    withCreatedPR((github) => {
      const fault = faultOf(() =>
        GitReleasePR(credentials, github.transport().transport).updatePR(
          updateParams(github, { draft: true }),
        ),
      );
      expect(fault.state).toBe("refused");
      expect(fault.message).toMatch(/cannot flip a draft/);
      expect(github.pulls[0]?.draft).toBe(false);
    });
  });

  it("refuses to update a PR that is no longer open", () => {
    withCreatedPR((github) => {
      if (github.pulls[0] === undefined) {
        throw new Error("expected the created pull request");
      }
      github.pulls[0].state = "closed";
      const fault = faultOf(() =>
        GitReleasePR(credentials, github.transport().transport).updatePR(updateParams(github)),
      );
      expect(fault.state).toBe("refused");
      expect(fault.message).toMatch(/closed/);
    });
  });

  it("refuses when the head branch is gone — absence over the observable repository is determinate", () => {
    withCreatedPR((github) => {
      github.refs.delete(derivedBranch);
      const fault = faultOf(() =>
        GitReleasePR(credentials, github.transport().transport).updatePR(updateParams(github)),
      );
      expect(fault.state).toBe("refused");
      expect(fault.message).toMatch(/head branch .* is gone/);
    });
  });

  it("classifies a vanished PR through the one table, and a thrown transport as the retryable failure", () => {
    withCreatedPR((github) => {
      github.pulls.length = 0;
      const fault = faultOf(() =>
        GitReleasePR(credentials, github.transport().transport).updatePR(updateParams(github)),
      );
      expect(fault.state).toBe("refused");
      expect(fault.reason).toBe("unobservable-remote");
    });
    withCreatedPR((github) => {
      const hostile: GitHubTransport = {
        request: () => {
          throw new Error("ECONNRESET");
        },
      };
      const thrown = faultOf(() =>
        GitReleasePR(credentials, hostile).updatePR(updateParams(github)),
      );
      expect(thrown.state).toBe("transport-failure");
      expect(thrown.detail).toContain("ECONNRESET");
    });
  });

  it("a label write failing after the fields were written is a partial, never a quiet success", () => {
    withCreatedPR((github) => {
      github.failLabelsPut = "lost";
      const pull = github.pulls[0];
      if (pull === undefined) {
        throw new Error("expected the created pull request");
      }
      const fault = faultOf(() =>
        GitReleasePR(credentials, github.transport().transport).updatePR(
          updateParams(github, { labels: ["release-craft", "priority:high"] }),
        ),
      );
      expect(fault.state).toBe("partial");
      expect(fault.message).toMatch(/was updated in place/);
      expect(fault.message).toMatch(/socket hang up/);
      // The write the failure interrupted was the labels': the set is
      // unchanged, and nothing else moved either.
      expect(pull.labels).toEqual(["release-craft"]);
    });
  });
});
