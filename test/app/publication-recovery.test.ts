/**
 * The crash-window matrix carried up over the publication effects window
 * (audit §7.3: "iterate the existing crash-window suite over the newly
 * wired publish path") — the engine door, not the adapter door. The walk
 * completes, the mint lands, and the interruption strikes inside
 * completeRun's publication effects: the create's lost answer, the
 * create's dead transport, the verify read failing after the create
 * landed, or the release vanishing between create and verify. Each window
 * suspends the attempt `blocked` with its cause, the recorded resolution
 * (revalidation naming the stored plan fingerprint) re-arms it, and the
 * resume lands published — with the resumed run's completions (the
 * one-record-per-step publish/verify pairs and the collapsed steps) and
 * publication trace (release bytes, release URL, minted refs) byte-equal
 * the uninterrupted run's.
 *
 * The matrix is the phase 11 obligation 5 recovery claim (application
 * boundary contract §5) demonstrated on the publication effects: the
 * resumed run's outcome matches the uninterrupted run's, and the resumed
 * tail is not required byte-equal — the resolution record is an appended,
 * attributed ledger event (phase 10 §3.6), so the equality asserted here
 * is the completions and the effects, not the whole tail.
 *
 * This is addendum record 3's proof: the publication effects'
 * crash-safety rides the idempotent re-execution — the same-target
 * idempotent re-mint and the read-before-write create land the same
 * release the uninterrupted run landed, with no effect-boundary ledger
 * records added (the one-record-per-step invariant, phase 5 §2.8). The
 * transport bound stays the fake remote (#336): what rides on a live
 * REST transport is its own reviewed PR under the live-publish issue;
 * this file pins the kernel truth.
 *
 * Drive shape mirrors publication-port.test.ts: `withGitHubVertical` (a
 * real temp git repository — real binding doors, real subprocesses), the
 * fake remote over the injected transport, and fault wrappers that arm
 * once then delegate, so the resumed read-before-write create lands on
 * the real fixture state. Determinism (§7): the fixture's fixed identity
 * and clock make the two verticals' traces byte-equal by construction.
 */
import { describe, expect, it } from "vitest";

import type { GitHubTransport } from "@ecoma-io/release-craft/adapters/github";
import {
  openPublicationDriver,
  type Engine,
  type LedgerRecord,
  type RunOutcome,
  type RunRequest,
  type StepKey,
} from "../../src/index.js";
import { liveWorld } from "../vertical/matrix.js";
import {
  CHANGELOG_BODY,
  credentials,
  type FakeRemote,
  type GitHubVerticalState,
  openFakeRemote,
  withGitHubVertical,
} from "../vertical/matrix-github.js";
import { beta, runRequest } from "./harness.js";

/** The tag the fixture's plan mints on the beta line (the seeded ref). */
const TAG = "5.0.0-beta.1";

/** One run through the wired engine: the beta line against the recorded
 * main head, the fixture's declarations recording the real changelog
 * tree. */
const wiredRun = (vertical: GitHubVerticalState): RunRequest => {
  const target = vertical.state.lineHeads.main;
  if (target === undefined) {
    throw new Error("fixture broken: no recorded head for main");
  }
  return {
    ...runRequest(liveWorld(), "main", [beta], vertical.declarations),
    targets: { main: target },
  };
};

/** Seeds the fake remote's git-ref surface with the tag the run mints —
 * the create's precondition (issue #338) reads the remote ref at the
 * binding's recorded target before any write, and verification asserts it
 * again. */
const seedRemoteTag = (vertical: GitHubVerticalState, remote: FakeRemote): void => {
  const target = vertical.state.lineHeads.main;
  if (target === undefined) {
    throw new Error("fixture broken: no recorded head for main");
  }
  remote.putTag(TAG, target);
};

const isStepRecord = (
  record: LedgerRecord,
  key: string,
): record is Extract<LedgerRecord, { readonly kind: "step" }> =>
  record.kind === "step" && record.record.stepKey === key;

/** The byte-equal trace of a completed run: the published outcome, the
 * release object and URL the remote holds, the minted ref rows, and the
 * completions — the publish/verify step-record pairs (one started + one
 * completed per stage, the one-record-per-step invariant) and the
 * collapsed steps. The resolution record a resumed run appends is *not*
 * in the trace: it is an attributed ledger event of the recovery, not a
 * completion (phase 10 §3.6 — the resumed tail is not required
 * byte-equal, the completions and effects are). */
const traceOf = (
  vertical: GitHubVerticalState,
  engine: Engine,
  remote: FakeRemote,
  outcome: RunOutcome,
): string => {
  if (outcome.kind !== "published") {
    throw new Error(`expected a published outcome, got ${outcome.kind}`);
  }
  if (outcome.handle === null) {
    throw new Error("fixture broken: a published outcome carries no handle");
  }
  const observation = engine.observe({ kind: "attempt", handle: outcome.handle });
  if (observation.kind !== "attempt") {
    throw new Error(`expected an attempt observation, got ${observation.kind}`);
  }
  const recordPairs = (key: string): readonly (readonly [string, string])[] =>
    observation.tail
      .filter((record) => isStepRecord(record, key))
      .map((record) => [record.record.from, record.record.to]);
  const stepStates = (key: string): readonly string[] =>
    observation.steps.filter((step) => step.stepKey === key).map((step) => step.state);
  return JSON.stringify({
    outcome: { kind: outcome.kind, tag: outcome.tag, releaseUrl: outcome.releaseUrl ?? null },
    release: { body: remote.releases.get(TAG) ?? null, url: remote.releaseUrls.get(TAG) ?? null },
    refs: vertical.state.binding.refs
      .tags()
      .filter((row) => row.ref.startsWith("refs/tags/"))
      .map((row) => ({ ref: row.ref, target: row.target })),
    observation: {
      state: observation.state,
      // The mint log is attempt memory, not durable evidence: the
      // resumed run's same-target re-mint appends a second entry
      // (engine.ts — the re-entry's re-mint push), the exact phase 10
      // §3.6 resumed-tail drift this file deliberately does not compare.
      // The durable evidence — the single idempotent ref row, the release
      // object, the completions — is what `refs` and the stages above
      // carry, so the distinct tags collapse to the run's one.
      tags: [...new Set(observation.tags)],
      publish: { records: recordPairs("publish"), steps: stepStates("publish") },
      verify: { records: recordPairs("verify"), steps: stepStates("verify") },
    },
  });
};

/** The uninterrupted run's trace — the byte-equal target of every crash
 * window. */
const cleanTrace = (name: string): string => {
  let trace = "";
  withGitHubVertical(name, (vertical) => {
    const remote = openFakeRemote();
    seedRemoteTag(vertical, remote);
    const engine = openPublicationDriver(
      vertical.state.binding,
      vertical.adapter(remote.transport),
      { maxRetries: 2 },
    );
    trace = traceOf(vertical, engine, remote, engine.run(wiredRun(vertical)));
  });
  return trace;
};
/** The crashed-then-resumed run's trace: the faulted transport arms once
 * then delegates; the blocked attempt is resolved with the revalidation
 * naming the stored plan fingerprint, then resumed; the trace is captured
 * after the published terminal. */
const crashedTrace = (
  name: string,
  transport: (remote: FakeRemote) => GitHubTransport,
  stepKey: StepKey,
  expectBlocked: (cause: string, remote: FakeRemote, vertical: GitHubVerticalState) => void,
): string => {
  let trace = "";
  withGitHubVertical(name, (vertical) => {
    const remote = openFakeRemote();
    seedRemoteTag(vertical, remote);
    const engine = openPublicationDriver(
      vertical.state.binding,
      vertical.adapter(transport(remote)),
      { maxRetries: 2 },
    );
    const request = wiredRun(vertical);
    const blocked = engine.run(request);
    if (blocked.kind !== "blocked" || blocked.handle === null) {
      throw new Error("expected a blocked outcome with a handle");
    }
    expectBlocked(blocked.cause, remote, vertical);
    const resolved = engine.resolve(blocked.handle, stepKey, {
      kind: "revalidation",
      planFingerprint: blocked.planId ?? "",
    });
    expect(resolved.kind).toBe("resolved");
    const resumed = engine.resume(blocked.handle, request);
    trace = traceOf(vertical, engine, remote, resumed);
  });
  return trace;
};

describe("audit §7.3 — crash-window recovery over the publication effects window (addendum record 3)", () => {
  it(
    "create transport-failure: blocked publication-unavailable, nothing landed, the resolution + resume land the re-run's create byte-equal the uninterrupted run",
    { timeout: 120_000 },
    () => {
      const crashed = crashedTrace(
        "w1b-create-500",
        (remote) => {
          // The provider's server fails the create once (5xx — nothing
          // landed, the transport-failure class); everything after
          // delegates, so the resumed create lands on the real fixture.
          let faulted = false;
          const transport: GitHubTransport = {
            request(path, init) {
              const route = path.split("?")[0] as string;
              if (!faulted && init?.method === "POST" && route.endsWith("/releases")) {
                faulted = true;
                return { status: 500, headers: {}, body: "" };
              }
              return remote.transport.request(path, init);
            },
          };
          return transport;
        },
        "publish",
        (cause, remote) => {
          expect(cause).toContain("publication-unavailable");
          // Nothing landed: the lost create left no release object.
          expect(remote.releases.size).toBe(0);
        },
      );
      const clean = cleanTrace("w1b-create-500-clean");
      expect(crashed).toStrictEqual(clean);
    },
  );

  it(
    "create ambiguous: blocked publication-ambiguous, the resolution + resume's read-before-write create lands published byte-equal the uninterrupted run",
    { timeout: 120_000 },
    () => {
      const crashed = crashedTrace(
        "w1b-create-0",
        (remote) => {
          // The first create answers with a lost response (status 0 = the
          // ambiguous class — the write may have landed); everything else
          // delegates, so the resumed read-before-write create lands on
          // the real fixture.
          let faulted = false;
          const transport: GitHubTransport = {
            request(path, init) {
              const route = path.split("?")[0] as string;
              if (!faulted && init?.method === "POST" && route.endsWith("/releases")) {
                faulted = true;
                return { status: 0, headers: {}, body: "" };
              }
              return remote.transport.request(path, init);
            },
          };
          return transport;
        },
        "publish",
        (cause, remote) => {
          expect(cause).toContain("publication-ambiguous");
          // Nothing landed: the lost create left no release object.
          expect(remote.releases.size).toBe(0);
        },
      );
      const clean = cleanTrace("w1b-create-0-clean");
      expect(crashed).toStrictEqual(clean);
    },
  );
  it(
    "create lands server-side, 201 lost: blocked publication-ambiguous over the landed release, the resolution + resume's idempotent read verifies it — one release object, never a second create, byte-equal the uninterrupted run",
    { timeout: 120_000 },
    () => {
      const crashed = crashedTrace(
        "w1b-create-landed-lost",
        (remote) => {
          // The first create is performed server-side — the release
          // lands in the remote's own map with the metadata the remote
          // constructs, the door's own body — but the create answer is
          // lost (status 0): the server-side-landed + lost-response
          // class (issue #354), which the status-0 arms above leave
          // unlanded and the concurrent writer's determinate 422 never
          // reaches. The arm fires once; everything after delegates, so
          // the resumed idempotent read finds the landed release.
          remote.armLandedLost201();
          return remote.transport;
        },
        "publish",
        (cause, remote) => {
          expect(cause).toContain("publication-ambiguous");
          // Exactly one create was issued — and it landed: the release
          // object is on the remote despite the lost answer.
          expect(remote.landedLost201Fired()).toBe(true);
          expect(
            remote.calls.filter(
              (call) => call.init?.method === "POST" && call.path.endsWith("/releases"),
            ),
          ).toHaveLength(1);
          expect(remote.releases.size).toBe(1);
          expect(remote.releases.get(TAG)).toBe(CHANGELOG_BODY);
        },
      );
      const clean = cleanTrace("w1b-create-landed-lost-clean");
      expect(crashed).toStrictEqual(clean);
    },
  );

  it(
    "verify transport-failure after a landed create: blocked publication-verify-unavailable over an existing release, the resolution + resume re-verify without re-creating, byte-equal the uninterrupted run",
    { timeout: 120_000 },
    () => {
      const crashed = crashedTrace(
        "w1b-verify-500",
        (remote) => {
          // The create delegates (the release lands); the verify read
          // that follows it fails once (5xx — the transport-failure
          // class). Everything after delegates, so the resumed verify
          // reads the release the create landed.
          let created = false;
          let faulted = false;
          const transport: GitHubTransport = {
            request(path, init) {
              const route = path.split("?")[0] as string;
              if (init?.method === "POST" && route.endsWith("/releases")) {
                created = true;
                return remote.transport.request(path, init);
              }
              if (created && !faulted && route.includes("/releases/tags/")) {
                faulted = true;
                return { status: 500, headers: {}, body: "" };
              }
              return remote.transport.request(path, init);
            },
          };
          return transport;
        },
        "verify",
        (cause, remote) => {
          expect(cause).toContain("publication-verify-unavailable");
          // The create landed before the verify read failed — the release
          // object is already on the remote.
          expect(remote.releases.size).toBe(1);
          expect(remote.releases.get(TAG)).toBe(CHANGELOG_BODY);
        },
      );
      const clean = cleanTrace("w1b-verify-500-clean");
      expect(crashed).toStrictEqual(clean);
    },
  );

  it(
    "verify absent between a landed create and its read: blocked publication-absent, the resolution + resume's idempotent create re-lands it byte-equal the uninterrupted run",
    { timeout: 120_000 },
    () => {
      const crashed = crashedTrace(
        "w1b-verify-absent",
        (remote) => {
          // The create delegates (the release lands); then the release's
          // first read after it — the verify's — answers 404 once, the
          // absent read (D28). The fake remote serves no repository probe
          // route, so the wrapper answers it 200 — the observable-
          // repository verdict issue #176's probe discriminates (absent,
          // not unobservable-remote). Everything after the armed 404
          // delegates, so the resumed read-before-write create finds the
          // landed release, byte-equal the uninterrupted run's.
          let created = false;
          let faulted = false;
          const repository = `/repos/${credentials.owner}/${credentials.repo}`;
          const transport: GitHubTransport = {
            request(path, init) {
              const route = path.split("?")[0] as string;
              // The repository probe the 404 discriminates against — the
              // fake remote serves no route for it, so the wrapper answers
              // the observable fixture repository itself.
              if (route === repository) {
                return { status: 200, headers: {}, body: "{}" };
              }
              if (init?.method === "POST" && route.endsWith("/releases")) {
                created = true;
                return remote.transport.request(path, init);
              }
              if (created && !faulted && route.includes("/releases/tags/")) {
                faulted = true;
                return { status: 404, headers: {}, body: "{}" };
              }
              return remote.transport.request(path, init);
            },
          };
          return transport;
        },
        "verify",
        (cause, remote) => {
          expect(cause).toContain("publication-absent");
          // The create landed; the absent read observed no release at the
          // moment it queried — the release object still stands.
          expect(remote.releases.size).toBe(1);
          expect(remote.releases.get(TAG)).toBe(CHANGELOG_BODY);
        },
      );
      const clean = cleanTrace("w1b-verify-absent-clean");
      expect(crashed).toStrictEqual(clean);
    },
  );
});
