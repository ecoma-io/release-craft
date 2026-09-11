/**
 * The Release PR gate (issue #202) — behavior tests exercising the gate
 * door end-to-end: projection determinism, detect/create/update flows,
 * claim identity enforcement (never labels), the four refusal shapes,
 * and the write-ahead sink discipline.
 *
 * Tests import through the app barrel (§2.9 obligation 7) and never
 * reach past it into internal modules.
 */
import { describe, expect, it } from "vitest";
import { Version } from "@ecoma-io/release-craft/domain";

import {
  MemoryRecordSink,
  openReleasePRGate,
  parseIdentityClaim,
  renderReleasePRProjection,
  ReleasePRScopeError,
  type ExistingPR,
  type PlanLine,
  type ReleasePlan,
  type ReleasePRIdentity,
  type ReleasePRPort,
} from "../../src/index.js";

// ---------------------------------------------------------------------------
// Fixtures: minimal plan lines and plans
// ---------------------------------------------------------------------------

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

const stableLine: PlanLine = {
  lineId: "lib-b",
  stable: { version: "2.0.0", tag: "lib-b-2.0.0" },
  streams: [],
  changes: [{ id: "feat-b", lineage: [], type: "feat", bump: "major" }],
  propagation: { edges: [], order: [], notMoved: [] },
  preconditions: [],
  artifacts: ["changelog"],
};

const noopLine: PlanLine = {
  lineId: "lib-c",
  stable: null,
  streams: [],
  changes: [],
  propagation: { edges: [], order: [], notMoved: [] },
  preconditions: [],
  artifacts: [],
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
// Fake port: in-memory tracker for findPR/createPR/updatePR
// ---------------------------------------------------------------------------

interface FakePort extends ReleasePRPort {
  readonly created: { pr: ExistingPR; draft: boolean }[];
  readonly updates: { prNumber: number; draft: boolean; title: string }[];
  shouldThrow: boolean;
  findPRThrows: boolean;
}

function fakePort(existing: ExistingPR | null = null): FakePort {
  const state = {
    created: [] as { pr: ExistingPR; draft: boolean }[],
    updates: [] as { prNumber: number; draft: boolean; title: string }[],
    existing,
    shouldThrow: false,
    findPRThrows: false,
  };
  return {
    get created() {
      return state.created;
    },
    get updates() {
      return state.updates;
    },
    get shouldThrow() {
      return state.shouldThrow;
    },
    set shouldThrow(v: boolean) {
      state.shouldThrow = v;
    },
    get findPRThrows() {
      return state.findPRThrows;
    },
    set findPRThrows(v: boolean) {
      state.findPRThrows = v;
    },
    findPR: () => {
      if (state.findPRThrows) throw new Error("findPR failed");
      return state.existing;
    },
    createPR: (params) => {
      if (state.shouldThrow) throw new Error("create failed");
      const pr: ExistingPR = {
        number: 1,
        title: params.title,
        body: params.body,
        headRef: `release/${params.identity.component}`,
        draft: params.draft,
        labels: [...params.labels],
      };
      state.created.push({ pr, draft: params.draft });
      state.existing = pr;
      return pr;
    },
    updatePR: (params) => {
      if (state.shouldThrow) throw new Error("update failed");
      state.updates.push({ prNumber: params.prNumber, draft: params.draft, title: params.title });
      const pr: ExistingPR = {
        number: params.prNumber,
        title: params.title,
        body: params.body,
        headRef: state.existing?.headRef ?? "release/lib",
        draft: params.draft,
        labels: [...params.labels],
      };
      state.existing = pr;
      return pr;
    },
  };
}

// ---------------------------------------------------------------------------
// §1 — Projection determinism
// ---------------------------------------------------------------------------

describe("renderReleasePRProjection", () => {
  it("produces byte-identical output on repeated renders", () => {
    const plan = makePlan();
    const first = renderReleasePRProjection(identity, plan);
    const second = renderReleasePRProjection(identity, plan);
    expect(first).toEqual(second);
  });

  it("returns null when no lines are pending after scoping", () => {
    const plan = makePlan({ lines: [noopLine] });
    expect(renderReleasePRProjection(identity, plan)).toBeNull();
  });

  it("throws ReleasePRScopeError for unknown scope ids", () => {
    const plan = makePlan();
    expect(() => renderReleasePRProjection(identity, plan, { lines: ["nonexistent"] })).toThrow(
      ReleasePRScopeError,
    );
  });

  it("renders the title with the component and body with the plan id", () => {
    const plan = makePlan();
    const render = renderReleasePRProjection(identity, plan);
    if (render === null) throw new Error("expected a render");
    expect(render.projection.title).toContain("lib-a");
    expect(render.projection.title).toContain("chore(release):");
    expect(render.projection.body).toContain(plan.planId);
    expect(parseIdentityClaim(render.projection.body)).not.toBeNull();
  });

  it("carries a constant state-free label set", () => {
    const plan = makePlan();
    const render = renderReleasePRProjection(identity, plan);
    if (render === null) throw new Error("expected a render");
    expect(render.projection.labels).toEqual(["release-craft"]);
  });

  it("heads a stable line with its minted tag (the promotion form)", () => {
    const plan = makePlan({ lines: [stableLine] });
    const render = renderReleasePRProjection(identity, plan);
    if (render === null) throw new Error("expected a render");
    expect(render.projection.body).toContain("lib-b-2.0.0");
    expect(render.projection.files[0]?.path).toBe("CHANGELOG.md");
  });
});

// ---------------------------------------------------------------------------
// §2 — parseIdentityClaim
// ---------------------------------------------------------------------------

describe("parseIdentityClaim", () => {
  it("round-trips through the rendered body's marker", () => {
    const plan = makePlan();
    const render = renderReleasePRProjection(identity, plan);
    if (render === null) throw new Error("expected a render");
    const claim = parseIdentityClaim(render.projection.body);
    expect(claim).toEqual({
      component: "lib-a",
      releaseLine: "lib-a",
      targetBranch: "main",
      planId: plan.planId,
    });
  });

  it("returns null for a body with no marker", () => {
    expect(parseIdentityClaim("just a body")).toBeNull();
  });

  it("returns null for a malformed marker", () => {
    expect(parseIdentityClaim("<!-- no release-craft claim here -->")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §3 — detect
// ---------------------------------------------------------------------------

describe("openReleasePRGate.detect", () => {
  it("returns detected when a pending release has no existing PR", () => {
    const port = fakePort(null);
    const gate = openReleasePRGate(port, new MemoryRecordSink());
    const result = gate.detect(identity, makePlan());
    expect(result.kind).toBe("detected");
  });

  it("returns found when an existing PR matches the identity", () => {
    const plan = makePlan();
    const render = renderReleasePRProjection(identity, plan);
    if (render === null) throw new Error("expected a render");
    const existing: ExistingPR = {
      number: 42,
      title: render.projection.title,
      body: render.projection.body,
      headRef: "release/lib-a",
      draft: false,
      labels: ["release-craft"],
    };
    const port = fakePort(existing);
    const gate = openReleasePRGate(port, new MemoryRecordSink());
    const outcome = gate.detect(identity, plan);
    expect(outcome.kind).toBe("found");
  });

  it("returns nothing-pending for a plan with no pending lines", () => {
    const port = fakePort();
    const gate = openReleasePRGate(port, new MemoryRecordSink());
    const plan = makePlan({ lines: [noopLine] });
    expect(gate.detect(identity, plan).kind).toBe("nothing-pending");
  });

  it("writes no records (read-only)", () => {
    const sink = new MemoryRecordSink();
    const port = fakePort();
    const gate = openReleasePRGate(port, sink);
    gate.detect(identity, makePlan());
    expect(sink.tail()).toEqual([]);
  });
  it("returns a recorded transport-failure when findPR throws", () => {
    const sink = new MemoryRecordSink();
    const port = fakePort();
    port.findPRThrows = true;
    const gate = openReleasePRGate(port, sink);
    const outcome = gate.detect(identity, makePlan());
    expect(outcome.kind).toBe("transport-failure");
    if (outcome.kind !== "transport-failure") throw new Error("expected transport-failure");
    expect(outcome.detail).toContain("findPR failed");
    const end = sink.tail()[0];
    if (end === undefined || end.kind !== "gate-outcome") {
      throw new Error("expected gate-outcome record");
    }
    expect(end.action).toBe("detect");
    expect(end.outcome.kind).toBe("transport-failure");
  });
});

// ---------------------------------------------------------------------------
// §4 — create
// ---------------------------------------------------------------------------

describe("openReleasePRGate.create", () => {
  it("creates a PR and writes gate-start + gate-outcome records", () => {
    const sink = new MemoryRecordSink();
    const port = fakePort();
    const gate = openReleasePRGate(port, sink);
    const plan = makePlan();
    const outcome = gate.create(identity, plan, { draft: true });
    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") throw new Error("expected created");
    expect(outcome.pr.draft).toBe(true);
    const records = sink.tail();
    expect(records).toHaveLength(2);
    const start = records[0];
    const end = records[1];
    if (start === undefined || end === undefined || end.kind !== "gate-outcome") {
      throw new Error("expected gate-start + gate-outcome records");
    }
    expect(start.kind).toBe("gate-start");
    expect(start.action).toBe("create");
    expect(end.outcome.kind).toBe("created");
  });

  it("returns found when a PR already exists (never duplicates)", () => {
    const plan = makePlan();
    const render = renderReleasePRProjection(identity, plan);
    if (render === null) throw new Error("expected a render");
    const existing: ExistingPR = {
      number: 10,
      title: render.projection.title,
      body: render.projection.body,
      headRef: "release/lib-a",
      draft: false,
      labels: ["release-craft"],
    };
    const port = fakePort(existing);
    const gate = openReleasePRGate(port, new MemoryRecordSink());
    const outcome = gate.create(identity, plan);
    expect(outcome.kind).toBe("found");
    expect(port.created).toHaveLength(0); // no duplicate
  });

  it("records a transport-failure when the port throws", () => {
    const sink = new MemoryRecordSink();
    const port = fakePort();
    port.shouldThrow = true;
    const gate = openReleasePRGate(port, sink);
    const outcome = gate.create(identity, makePlan());
    expect(outcome.kind).toBe("transport-failure");
    const records = sink.tail();
    expect(records[0]?.kind).toBe("gate-start");
    const end = records[1];
    if (end === undefined || end.kind !== "gate-outcome") {
      throw new Error("expected gate-outcome record");
    }
    expect(end.outcome.kind).toBe("transport-failure");
  });
  it("records transport-failure when findPR throws (no mutation, no duplicate)", () => {
    const sink = new MemoryRecordSink();
    const port = fakePort();
    port.findPRThrows = true;
    const gate = openReleasePRGate(port, sink);
    const outcome = gate.create(identity, makePlan());
    expect(outcome.kind).toBe("transport-failure");
    if (outcome.kind !== "transport-failure") throw new Error("expected transport-failure");
    expect(outcome.detail).toContain("findPR failed");
    const end = sink.tail()[0];
    if (end === undefined || end.kind !== "gate-outcome") {
      throw new Error("expected gate-outcome record");
    }
    expect(end.action).toBe("create");
    expect(end.outcome.kind).toBe("transport-failure");
    expect(port.created).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §5 — update
// ---------------------------------------------------------------------------

describe("openReleasePRGate.update", () => {
  it("detects when no existing PR is found", () => {
    const port = fakePort(null);
    const gate = openReleasePRGate(port, new MemoryRecordSink());
    expect(gate.update(identity, makePlan()).kind).toBe("detected");
  });

  it("is current when the PR matches the projection exactly", () => {
    const plan = makePlan();
    const render = renderReleasePRProjection(identity, plan);
    if (render === null) throw new Error("expected a render");
    const existing: ExistingPR = {
      number: 5,
      title: render.projection.title,
      body: render.projection.body,
      headRef: "release/lib-a",
      draft: false,
      labels: [...render.projection.labels],
    };
    const port = fakePort(existing);
    const gate = openReleasePRGate(port, new MemoryRecordSink());
    const outcome = gate.update(identity, plan);
    expect(outcome.kind).toBe("current");
    expect(port.updates).toHaveLength(0); // no write
  });

  it("repairs a stale title (the plan is unchanged; the render is re-applied)", () => {
    const plan = makePlan();
    const render = renderReleasePRProjection(identity, plan);
    if (render === null) throw new Error("expected a render");
    const existing: ExistingPR = {
      number: 13,
      title: "outdated title", // title differs → repairable drift
      body: render.projection.body,
      headRef: "release/lib-a",
      draft: true,
      labels: [...render.projection.labels],
    };
    const port = fakePort(existing);
    const gate = openReleasePRGate(port, new MemoryRecordSink());
    const outcome = gate.update(identity, plan, { draft: false });
    expect(outcome.kind).toBe("updated");
    if (outcome.kind !== "updated") throw new Error("expected updated");
    expect(port.updates).toEqual([{ prNumber: 13, draft: true, title: render.projection.title }]);
    expect(port.created).toHaveLength(0);
  });
  it("returns a recorded transport-failure when findPR throws", () => {
    const sink = new MemoryRecordSink();
    const port = fakePort();
    port.findPRThrows = true;
    const gate = openReleasePRGate(port, sink);
    const outcome = gate.update(identity, makePlan());
    expect(outcome.kind).toBe("transport-failure");
    if (outcome.kind !== "transport-failure") throw new Error("expected transport-failure");
    expect(outcome.detail).toContain("findPR failed");
    const end = sink.tail()[0];
    if (end === undefined || end.kind !== "gate-outcome") {
      throw new Error("expected gate-outcome record");
    }
    expect(end.action).toBe("update");
    expect(end.outcome.kind).toBe("transport-failure");
    expect(port.updates).toHaveLength(0);
  });

  it("preserves human-added labels across a stale-title repair", () => {
    const plan = makePlan();
    const render = renderReleasePRProjection(identity, plan);
    if (render === null) throw new Error("expected a render");
    const existing: ExistingPR = {
      number: 14,
      title: "outdated title", // stale title → repairable write
      body: render.projection.body,
      headRef: "release/lib-a",
      draft: false,
      labels: ["do-not-merge"], // human-added, absent from the projection
    };
    const port = fakePort(existing);
    const gate = openReleasePRGate(port, new MemoryRecordSink());
    const outcome = gate.update(identity, plan);
    expect(outcome.kind).toBe("updated");
    if (outcome.kind !== "updated") throw new Error("expected updated");
    expect(port.updates).toHaveLength(1);
    // the write carries the union: the human label survives, in place
    expect(outcome.pr.labels).toEqual(["do-not-merge", "release-craft"]);
  });

  it("merges labels without duplicating the projection label", () => {
    const plan = makePlan();
    const render = renderReleasePRProjection(identity, plan);
    if (render === null) throw new Error("expected a render");
    const existing: ExistingPR = {
      number: 15,
      title: "outdated title", // stale title → repairable write
      body: render.projection.body,
      headRef: "release/lib-a",
      draft: false,
      labels: ["do-not-merge", "release-craft"], // projection label already present
    };
    const port = fakePort(existing);
    const gate = openReleasePRGate(port, new MemoryRecordSink());
    const outcome = gate.update(identity, plan);
    expect(outcome.kind).toBe("updated");
    if (outcome.kind !== "updated") throw new Error("expected updated");
    expect(outcome.pr.labels).toEqual(["do-not-merge", "release-craft"]);
  });

  it("refuses when the body has drifted from the plan it claims", () => {
    const plan = makePlan();
    const render = renderReleasePRProjection(identity, plan);
    if (render === null) throw new Error("expected a render");
    const existing: ExistingPR = {
      number: 6,
      title: render.projection.title,
      body: render.projection.body.replace("Changes:", "## My manual notes"),
      headRef: "release/lib-a",
      draft: false,
      labels: [...render.projection.labels],
    };
    const port = fakePort(existing);
    const gate = openReleasePRGate(port, new MemoryRecordSink());
    const outcome = gate.update(identity, plan);
    expect(outcome.kind).toBe("plan-conflict");
    if (outcome.kind !== "plan-conflict") throw new Error("expected plan-conflict");
    expect(outcome.detail).toContain("drifted");
    expect(port.updates).toHaveLength(0);
  });

  it("refuses when the body has no identity claim (foreign or edited)", () => {
    const port = fakePort({
      number: 7,
      title: "manual title",
      body: "no marker here",
      headRef: "release/lib",
      draft: false,
      labels: [],
    });
    const gate = openReleasePRGate(port, new MemoryRecordSink());
    const outcome = gate.update(identity, makePlan());
    expect(outcome.kind).toBe("plan-conflict");
    if (outcome.kind !== "plan-conflict") throw new Error("expected plan-conflict");
    expect(outcome.recordedPlanId).toBeNull();
  });

  it("refuses identity mismatch: changed identity is a new PR, not a rewrite", () => {
    const plan = makePlan();
    const render = renderReleasePRProjection(identity, plan);
    if (render === null) throw new Error("expected a render");
    const existing: ExistingPR = {
      number: 8,
      title: render.projection.title,
      body: render.projection.body,
      headRef: "release/lib-a",
      draft: false,
      labels: [...render.projection.labels],
    };
    const port = fakePort(existing);
    const gate = openReleasePRGate(port, new MemoryRecordSink());
    const differentIdentity: ReleasePRIdentity = {
      component: "lib-b",
      releaseLine: "lib-b",
      targetBranch: "main",
    };
    const outcome = gate.update(differentIdentity, plan);
    expect(outcome.kind).toBe("identity-mismatch");
    if (outcome.kind !== "identity-mismatch") throw new Error("expected identity-mismatch");
    expect(outcome.existingIdentity.component).toBe("lib-a");
    expect(outcome.newIdentity.component).toBe("lib-b");
    expect(port.updates).toHaveLength(0);
  });

  it("refuses plan conflict when recomputed plan does not supersede recorded", () => {
    const recorded = makePlan({ planId: "plan_sha256:aaaa" });
    const render = renderReleasePRProjection(identity, recorded);
    if (render === null) throw new Error("expected a render");
    const existing: ExistingPR = {
      number: 9,
      title: render.projection.title,
      body: render.projection.body,
      headRef: "release/lib-a",
      draft: false,
      labels: [...render.projection.labels],
    };
    const port = fakePort(existing);
    const gate = openReleasePRGate(port, new MemoryRecordSink());
    const recomputed = makePlan({
      planId: "plan_sha256:bbbb",
      supersedes: null, // not superseding the recorded plan
    });
    const outcome = gate.update(identity, recomputed);
    expect(outcome.kind).toBe("plan-conflict");
    expect(port.updates).toHaveLength(0);
  });

  it("allows update when recomputed plan supersedes the recorded one", () => {
    const recorded = makePlan({ planId: "plan_sha256:aaaa" });
    const render = renderReleasePRProjection(identity, recorded);
    if (render === null) throw new Error("expected a render");
    const existing: ExistingPR = {
      number: 11,
      title: render.projection.title,
      body: render.projection.body,
      headRef: "release/lib-a",
      draft: false,
      labels: [...render.projection.labels],
    };
    const port = fakePort(existing);
    const sink = new MemoryRecordSink();
    const gate = openReleasePRGate(port, sink);
    const recomputed = makePlan({
      planId: "plan_sha256:cccc",
      supersedes: "plan_sha256:aaaa", // legitimate supersession
    });
    const outcome = gate.update(identity, recomputed);
    expect(outcome.kind).toBe("updated");
    expect(port.updates).toHaveLength(1);
    const records = sink.tail();
    expect(records[0]?.kind).toBe("gate-start");
    expect(records[0]?.action).toBe("update");
    expect(records[1]?.kind).toBe("gate-outcome");
  });

  it("treats label drift as cosmetic (labels are not identity)", () => {
    const plan = makePlan();
    const render = renderReleasePRProjection(identity, plan);
    if (render === null) throw new Error("expected a render");
    const existing: ExistingPR = {
      number: 12,
      title: render.projection.title,
      body: render.projection.body,
      headRef: "release/lib-a",
      draft: false,
      labels: ["human-added-label", "something-else"], // labels differ from projection
    };
    const port = fakePort(existing);
    const gate = openReleasePRGate(port, new MemoryRecordSink());
    const outcome = gate.update(identity, plan);
    // body and title match the projection → current (label drift is cosmetic)
    expect(outcome.kind).toBe("current");
    expect(port.updates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §6 — Write-ahead sink
// ---------------------------------------------------------------------------

describe("MemoryRecordSink", () => {
  it("returns frozen records in insertion order", () => {
    const sink = new MemoryRecordSink();
    const start = sink.append({
      kind: "gate-start",
      action: "create",
      identity,
      planId: "p1",
    });
    expect(Object.isFrozen(start)).toBe(true);
    const end = sink.append({
      kind: "gate-outcome",
      action: "create",
      identity,
      planId: "p1",
      outcome: { kind: "nothing-pending" },
    });
    expect(Object.isFrozen(end)).toBe(true);
    expect(sink.tail()).toHaveLength(2);
    expect(sink.tail()[0]?.kind).toBe("gate-start");
    expect(sink.tail()[1]?.kind).toBe("gate-outcome");
  });

  it("tail returns a defensive copy", () => {
    const sink = new MemoryRecordSink();
    sink.append({ kind: "gate-start", action: "update", identity, planId: "p2" });
    const snapshot = sink.tail();
    expect(snapshot).toHaveLength(1);
    sink.append({
      kind: "gate-outcome",
      action: "update",
      identity,
      planId: "p2",
      outcome: { kind: "nothing-pending" },
    });
    expect(snapshot).toHaveLength(1); // snapshot is stale, not mutated
    expect(sink.tail()).toHaveLength(2);
  });
});
// ---------------------------------------------------------------------------
// §7 — door assembly (the write-ahead discipline is not opt-in)
// ---------------------------------------------------------------------------

describe("openReleasePRGate assembly", () => {
  it("demands a record sink at the door (a sink-less gate does not typecheck)", () => {
    // The sink is a required parameter: an optional sink would make the
    // write-ahead discipline a choice, and a crash mid-mutation would leave
    // no evidence. The refusal is compile-time — @ts-expect-error turns an
    // unused directive into a typecheck failure (tsc compiles test/**/*), so
    // this test fails the moment a sink-less call becomes legal again.
    // @ts-expect-error openReleasePRGate requires a ReleasePRRecordSink
    const gate = openReleasePRGate(fakePort());
    // Still the door's shape at runtime; the refusal is a type error.
    expect(typeof gate.detect).toBe("function");
    expect(typeof gate.update).toBe("function");
  });
});
