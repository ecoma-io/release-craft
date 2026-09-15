/**
 * The publication port (audit §7.1; D87) through the application
 * boundary: the git+GitHub assembly composes the opened git binding's
 * ports with the opened adapter's publish/verify doors, and the engine's
 * completion runs the release create after the mint — the recorded body
 * (never a re-plan), the release URL on the published outcome, the
 * one-record-per-step invariant, and the blocked/refused recovery paths.
 *
 * The live dogfood wiring — the Action's token ingress, which rewrites
 * the phase 13 hermeticity contract — is its own reviewed PR; what this
 * file pins is the kernel truth: a wired port publishes and verifies, an
 * indeterminate write suspends the attempt resumably (the recorded
 * resolution naming the recorded `publish` step re-arms it, and the
 * same-target idempotent re-mint + read-before-write create land it), and
 * a determinate refusal leaves the attempt exactly as the walk left it.
 * The defensive pre-walk refusal (port wired without the tag door) is
 * unreachable through the public factories — none can compose the pair
 * apart — so no test bodies it; the branch pins the composition law the
 * factories already uphold.
 *
 * Drive shape: `withGitHubVertical`, the publication seam's own fixture —
 * a real temp git repository (real binding doors, real subprocesses), a
 * bare origin behind the credentials' URL, and a changelog producer that
 * records a real `git-tree:` digest, so the release body resolves through
 * the binding's content seam to the recorded bytes.
 */
import { describe, expect, it } from "vitest";

import type { GitHubTransport } from "@ecoma-io/release-craft/adapters/github";
import { openPublicationDriver, type LedgerRecord, type RunRequest } from "../../src/index.js";
import { liveWorld } from "../vertical/matrix.js";
import {
  CHANGELOG_BODY,
  type GitHubVerticalState,
  openFakeRemote,
  withGitHubVertical,
} from "../vertical/matrix-github.js";
import { beta, runRequest } from "./harness.js";

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

describe("§2.2/§2.5 — the wired publication port (audit §7.1; D87)", () => {
  it(
    "ok: the completion creates the release from the recorded body and publishes with the release URL",
    { timeout: 120_000 },
    () => {
      withGitHubVertical("app-pub-ok", (vertical) => {
        const remote = openFakeRemote();
        const engine = openPublicationDriver(
          vertical.state.binding,
          vertical.adapter(remote.transport),
          { maxRetries: 2 },
        );
        const outcome = engine.run(wiredRun(vertical));
        expect(outcome.kind).toBe("published");
        if (outcome.kind !== "published" || outcome.handle === null) {
          throw new Error("expected a published outcome");
        }
        expect(outcome.tag).toBe("5.0.0-beta.1");
        expect(outcome.releaseUrl).toBe(remote.releaseUrls.get("5.0.0-beta.1"));
        // The release object exists on the remote with exactly the
        // recorded changelog bytes — the recorded tail, never a re-plan.
        expect(remote.releases.get("5.0.0-beta.1")).toBe(CHANGELOG_BODY);
        // The minted ref is real, and the engine's observation carries it.
        expect(vertical.state.binding.refs.tags().map((ref) => ref.ref)).toContain(
          "refs/tags/5.0.0-beta.1",
        );
        const observation = engine.observe({ kind: "attempt", handle: outcome.handle });
        if (observation.kind !== "attempt") {
          throw new Error(`expected an attempt observation, got ${observation.kind}`);
        }
        expect(observation.state).toBe("published");
        expect(observation.tags).toStrictEqual(["5.0.0-beta.1"]);
        // The one-record-per-step invariant: the walk recorded exactly one
        // started and one completed transition per publish/verify stage —
        // the publication effect appended nothing (the remote release and
        // the terminal attempt state are the evidence).
        const publishRecords = observation.tail.filter(
          (record): record is Extract<LedgerRecord, { readonly kind: "step" }> =>
            record.kind === "step" && record.record.stepKey === "publish",
        );
        expect(
          publishRecords.map((record) => [record.record.from, record.record.to]),
        ).toStrictEqual([
          ["pending", "started"],
          ["started", "completed"],
        ]);
        const verifyRecords = observation.tail.filter(
          (record): record is Extract<LedgerRecord, { readonly kind: "step" }> =>
            record.kind === "step" && record.record.stepKey === "verify",
        );
        expect(verifyRecords.map((record) => [record.record.from, record.record.to])).toStrictEqual(
          [
            ["pending", "started"],
            ["started", "completed"],
          ],
        );
        // The collapsed view agrees: one row per effective step, completed.
        expect(
          observation.steps.filter((step) => step.stepKey === "publish").map((step) => step.state),
        ).toStrictEqual(["completed"]);
        expect(
          observation.steps.filter((step) => step.stepKey === "verify").map((step) => step.state),
        ).toStrictEqual(["completed"]);
      });
    },
  );

  it(
    "refused create: the run refuses, the attempt stays exactly as the walk left it — the minted ref stands, no release object lands",
    { timeout: 120_000 },
    () => {
      withGitHubVertical("app-pub-refused", (vertical) => {
        const remote = openFakeRemote();
        // The provider refuses the create: 422 (release-conflict class).
        remote.failReleases(422, {});
        const engine = openPublicationDriver(
          vertical.state.binding,
          vertical.adapter(remote.transport),
          { maxRetries: 2 },
        );
        const outcome = engine.run(wiredRun(vertical));
        expect(outcome.kind).toBe("refused");
        if (outcome.kind !== "refused" || outcome.handle === null) {
          throw new Error("expected a refused outcome with a handle");
        }
        expect(outcome.detail).toContain("HTTP 422");
        // The minted ref landed (the create is keyed on it), but the
        // attempt never terminalized: still executing, claim held,
        // nothing published.
        expect(vertical.state.binding.refs.tags().map((ref) => ref.ref)).toContain(
          "refs/tags/5.0.0-beta.1",
        );
        expect(remote.releases.size).toBe(0);
        const observation = engine.observe({ kind: "attempt", handle: outcome.handle });
        if (observation.kind !== "attempt") {
          throw new Error(`expected an attempt observation, got ${observation.kind}`);
        }
        expect(observation.state).toBe("executing");
      });
    },
  );

  it(
    "ambiguous create: blocked with the cause, the recorded resolution re-arms it, and the resume's idempotent create lands published",
    { timeout: 120_000 },
    () => {
      withGitHubVertical("app-pub-ambiguous", (vertical) => {
        const remote = openFakeRemote();
        // The first create answers with a lost response (status 0 = the
        // ambiguous class); everything else delegates to the fake remote,
        // so the resumed read-before-write create lands on the real one.
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
        const engine = openPublicationDriver(vertical.state.binding, vertical.adapter(transport), {
          maxRetries: 2,
        });
        const request = wiredRun(vertical);
        const blocked = engine.run(request);
        expect(blocked.kind).toBe("blocked");
        if (blocked.kind !== "blocked" || blocked.handle === null) {
          throw new Error("expected a blocked outcome with a handle");
        }
        expect(blocked.cause).toContain("publication-ambiguous");
        expect(blocked.planId).not.toBeNull();
        // The minted ref stands; no release object landed (the write was
        // lost, not received).
        expect(vertical.state.binding.refs.tags().map((ref) => ref.ref)).toContain(
          "refs/tags/5.0.0-beta.1",
        );
        expect(remote.releases.size).toBe(0);
        // The recorded resolution names the recorded `publish` step — the
        // kernel's own resolver contract — re-arming the try.
        const resolved = engine.resolve(blocked.handle, "publish", {
          kind: "revalidation",
          planFingerprint: blocked.planId ?? "",
        });
        expect(resolved.kind).toBe("resolved");
        const resumed = engine.resume(blocked.handle, request);
        expect(resumed.kind).toBe("published");
        if (resumed.kind !== "published") {
          throw new Error("expected a published outcome");
        }
        expect(resumed.tag).toBe("5.0.0-beta.1");
        expect(resumed.releaseUrl).toBe(remote.releaseUrls.get("5.0.0-beta.1"));
        expect(remote.releases.get("5.0.0-beta.1")).toBe(CHANGELOG_BODY);
      });
    },
  );

  it(
    "transport-failure create: blocked with the cause, nothing landed",
    { timeout: 120_000 },
    () => {
      withGitHubVertical("app-pub-transport", (vertical) => {
        const remote = openFakeRemote();
        // The provider's server fails: 5xx → the transport-failure class.
        remote.failReleases(500, {});
        const engine = openPublicationDriver(
          vertical.state.binding,
          vertical.adapter(remote.transport),
          { maxRetries: 2 },
        );
        const blocked = engine.run(wiredRun(vertical));
        expect(blocked.kind).toBe("blocked");
        if (blocked.kind !== "blocked" || blocked.handle === null) {
          throw new Error("expected a blocked outcome with a handle");
        }
        expect(blocked.cause).toContain("publication-unavailable");
        expect(remote.releases.size).toBe(0);
        const observation = engine.observe({ kind: "attempt", handle: blocked.handle });
        if (observation.kind !== "attempt") {
          throw new Error(`expected an attempt observation, got ${observation.kind}`);
        }
        expect(observation.state).toBe("blocked");
        expect(observation.blockedCause).toContain("publication-unavailable");
      });
    },
  );
});
