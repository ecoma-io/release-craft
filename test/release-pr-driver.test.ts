/**
 * The Release PR gate's production composition (issue #309): the driver
 * is the wiring the release run uses — the opened GitHub adapter's real
 * port behind `openReleasePRGate`, the caller's sink carrying the
 * write-ahead records. The pin executes the whole chain the production
 * caller would: a computed plan through the gate's create door onto the
 * real port, against a fake transport speaking the REST shapes, with the
 * projection's bytes asserted at the far end. The app layer's render and
 * the adapter layer's claim parser are pinned together here at the seam
 * their structural twinning leaves open.
 */

import { createTempRepo } from "./adapters/git/temp-repo.js";
import {
  openGitBinding,
  type GitBinding,
  type GitTagNaming,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import {
  openGitHubAdapter,
  type GitHubCredentials,
  type GitHubResponse,
  type GitHubTransport,
} from "@ecoma-io/release-craft/__internal__/adapters/github/index.js";
import { Version } from "@ecoma-io/release-craft/domain";
import {
  MemoryRecordSink,
  openReleasePRDriver,
  parseIdentityClaim,
  renderReleasePRProjection,
  type PlanLine,
  type ReleasePlan,
  type ReleasePRIdentity,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

/** The body field as text — the fake's reads of the port's JSON writes,
 *  which always carry strings; anything else reads as the empty string. */
const text = (value: unknown): string => (typeof value === "string" ? value : "");

const identity: ReleasePRIdentity = {
  component: "lib-a",
  releaseLine: "lib-a",
  targetBranch: "main",
};

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

function makePlan(): ReleasePlan {
  return {
    planId: "plan_sha256:aabbccdd",
    supersedes: null,
    policyDigest: "digest-1",
    inputsFingerprint: "fingerprint-1",
    refusedIntents: [],
    lines: [streamLine],
    explanation: { foreignTags: [], conflicts: [], excluded: [], withheld: [] },
  };
}

const naming: GitTagNaming = {
  namespaces: ["v"],
  tagFor: (): string | null => null,
};

const credentials: GitHubCredentials = {
  owner: "ecoma-io",
  repo: "release-craft",
  token: "t0k3n",
};

const ROOT_SHA = "a".repeat(40);
const ROOT_TREE = "b".repeat(40);
const derivedBranch = "release-craft--branches--main--lines--lib-a--components--lib-a";

/** The remote state the fake serves: the target branch, and whatever the
 *  port pushes. The subset of the REST surface the create flow crosses —
 *  the unit suite (test/adapters/github/release-pr.test.ts) owns the full
 *  fake; this one carries exactly what the wiring pin needs. */
const fakeRemote = (): {
  transport: GitHubTransport;
  state: {
    pullBodies: { body: string; labels: string[]; headRef: string }[];
    fileOnBranch: (branch: string, path: string) => string | undefined;
  };
} => {
  const refs = new Map<string, string>([["main", ROOT_SHA]]);
  const commitTrees = new Map<string, string>([[ROOT_SHA, ROOT_TREE]]);
  const treeBlobs = new Map<string, Map<string, string>>([[ROOT_TREE, new Map()]]);
  const pullBodies: { body: string; labels: string[]; headRef: string }[] = [];
  const shaOf = (blobs: ReadonlyMap<string, string>): string => {
    const names = [...blobs.keys()].sort();
    return `tree-${names.map((path) => `${path}:${blobs.get(path) ?? ""}`).join("|")}`;
  };
  const response = (status: number, body: unknown): GitHubResponse => ({
    status,
    headers: {},
    body: JSON.stringify(body),
  });
  const repo = "/repos/ecoma-io/release-craft";
  const transport: GitHubTransport = {
    request: (path, init) => {
      const body: Record<string, unknown> =
        init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>);
      if (path === `${repo}/pulls?state=open&per_page=100`) {
        return response(
          200,
          pullBodies.map((pull) => ({
            number: 101,
            title: "the pull request",
            body: pull.body,
            draft: false,
            state: "open",
            head: { ref: pull.headRef },
            labels: pull.labels.map((name) => ({ name })),
          })),
        );
      }
      if (path === `${repo}/git/ref/heads/main`) {
        return response(200, { ref: "refs/heads/main", object: { sha: refs.get("main") } });
      }
      const headRead = /^\/repos\/ecoma-io\/release-craft\/git\/ref\/heads\/(.+)$/.exec(path);
      if (headRead !== null) {
        const branch = headRead[1] ?? "";
        const sha = refs.get(branch);
        return sha === undefined
          ? response(404, { message: "Not Found" })
          : response(200, { ref: `refs/heads/${branch}`, object: { sha } });
      }
      if (path === repo) {
        return response(200, { full_name: "ecoma-io/release-craft" });
      }
      const commitRead = /^\/repos\/ecoma-io\/release-craft\/git\/commits\/(.+)$/.exec(path);
      if (commitRead !== null) {
        const tree = commitTrees.get(commitRead[1] ?? "");
        return tree === undefined
          ? response(404, { message: "Not Found" })
          : response(200, { tree: { sha: tree } });
      }
      if (path === `${repo}/git/trees` && init?.method === "POST") {
        const blobs = new Map(treeBlobs.get(text(body["base_tree"])) ?? []);
        const entries: { path: string; content: string }[] = Array.isArray(body["tree"])
          ? (body["tree"] as { path: string; content: string }[])
          : [];
        for (const entry of entries) {
          blobs.set(entry.path, entry.content);
        }
        const sha = shaOf(blobs);
        treeBlobs.set(sha, blobs);
        return response(201, { sha });
      }
      if (path === `${repo}/git/commits` && init?.method === "POST") {
        const sha = `c${String(commitTrees.size).padStart(40, "0")}`;
        commitTrees.set(sha, text(body["tree"]));
        return response(201, { sha });
      }
      if (path === `${repo}/git/refs` && init?.method === "POST") {
        const branch = text(body["ref"]).replace(/^refs\/heads\//, "");
        refs.set(branch, text(body["sha"]));
        return response(201, { ref: body["ref"] });
      }
      if (path === `${repo}/pulls` && init?.method === "POST") {
        pullBodies.push({
          body: text(body["body"]),
          labels: [],
          headRef: text(body["head"]),
        });
        return response(201, { number: 101 });
      }
      const labelsPut = /^\/repos\/ecoma-io\/release-craft\/issues\/(\d+)\/labels$/.exec(path);
      if (labelsPut !== null && init?.method === "PUT") {
        const pull = pullBodies[0];
        if (pull !== undefined) {
          pull.labels = (body["labels"] as string[]).slice();
        }
        return response(200, []);
      }
      return response(404, { message: `the fake has no handler for ${path}` });
    },
  };
  const state = {
    pullBodies,
    fileOnBranch: (branch: string, path: string): string | undefined => {
      const head = refs.get(branch);
      const tree = head === undefined ? undefined : commitTrees.get(head);
      return tree === undefined ? undefined : treeBlobs.get(tree)?.get(path);
    },
  };
  return { transport, state };
};

describe("the Release PR driver (the production composition, issue #309)", () => {
  it("drives a computed plan through the gate onto the real port — the projection lands byte-exact", () => {
    const temp = createTempRepo();
    try {
      // The binding's origin names the credentials' repository: the
      // adapter factory's open-time agreement holds.
      temp.git(["remote", "add", "origin", "https://github.com/ecoma-io/release-craft.git"]);
      const binding: GitBinding = openGitBinding({ repo: temp.repo, tagNaming: naming });
      const remote = fakeRemote();
      const adapter = openGitHubAdapter(binding, credentials, remote.transport);
      const sink = new MemoryRecordSink();
      const gate = openReleasePRDriver(adapter, sink);

      const plan = makePlan();
      const projection = renderReleasePRProjection(identity, plan);
      if (projection === null) {
        throw new Error("expected the fixture plan to render a projection");
      }
      const outcome = gate.create(identity, plan);
      if (outcome.kind !== "created") {
        throw new Error(`expected the create door to create, got ${outcome.kind}`);
      }
      // The port returned the opened PR through the gate's own envelope.
      expect(outcome.pr.headRef).toBe(derivedBranch);
      expect(outcome.pr.draft).toBe(false);
      // The projection's bytes at the far end: the branch's file, the
      // PR body, the labels.
      expect(remote.state.fileOnBranch(derivedBranch, "CHANGELOG.md")).toBe(
        projection.projection.files[0]?.content,
      );
      expect(remote.state.pullBodies).toHaveLength(1);
      const pull = remote.state.pullBodies[0];
      expect(pull?.body).toBe(projection.projection.body);
      expect(pull?.labels).toEqual(projection.projection.labels);
      // The body the app gate rendered parses in the adapter layer to the
      // identity it was rendered from — the structural twins' seam.
      const claim = parseIdentityClaim(pull?.body ?? "");
      expect(claim).not.toBeNull();
      expect(claim?.component).toBe(identity.component);
      expect(claim?.releaseLine).toBe(identity.releaseLine);
      expect(claim?.targetBranch).toBe(identity.targetBranch);
    } finally {
      temp.cleanup();
    }
  });

  it("records the write-ahead discipline through the caller's sink — gate-start before the outcome", () => {
    const temp = createTempRepo();
    try {
      temp.git(["remote", "add", "origin", "https://github.com/ecoma-io/release-craft.git"]);
      const binding: GitBinding = openGitBinding({ repo: temp.repo, tagNaming: naming });
      const remote = fakeRemote();
      const adapter = openGitHubAdapter(binding, credentials, remote.transport);
      const sink = new MemoryRecordSink();
      const gate = openReleasePRDriver(adapter, sink);
      const outcome = gate.create(identity, makePlan());
      if (outcome.kind !== "created") {
        throw new Error(`expected the create door to create, got ${outcome.kind}`);
      }
      const records = sink.tail();
      expect(records.map((record) => record.kind)).toEqual(["gate-start", "gate-outcome"]);
      expect(records[0]?.action).toBe("create");
      expect(records[0]?.planId).toBe("plan_sha256:aabbccdd");
      expect(records[0]?.identity).toEqual(identity);
      const verdict = records[1];
      expect(verdict?.kind).toBe("gate-outcome");
      if (verdict?.kind !== "gate-outcome") {
        throw new Error("expected a gate-outcome record");
      }
      if (verdict.outcome.kind !== "created") {
        throw new Error(`expected a created verdict, got ${verdict.outcome.kind}`);
      }
      expect(verdict.outcome.pr.number).toBeTypeOf("number");
    } finally {
      temp.cleanup();
    }
  });
});
