// The Release-PR live-legs harness (issue #202; the §10 release-PR E2E chain,
// decision-log D80): the six gate legs the campaign runs against a real
// target — the checkout's own origin, dogfood-true, the self-release legs'
// precedent — captured per leg into an evidence JSONL file the caller names.
//
// This file is the HARNESS, not the live run: no token exists in the authoring
// environment by design, the live legs are executed by the coordinator, and
// the evidence this slice claims is the harness's existence plus the local
// pins over its own logic (test/release-pr-e2e-harness.test.ts). The legs:
//
//   1. detect-empty            gate.detect on a fresh identity — the gate
//                              answers `detected` (a pending release, no PR).
//                              Read-only.
//   2. create                  gate.create with `draft: true` — answers
//                              `created` with a real PR number (a DRAFT,
//                              minimizing noise and merge risk). Mutating.
//   3. detect-adopts           gate.detect again — answers `found` with the
//                              SAME number: marker-identity adoption, never
//                              title/label (issue #202 §11.5). Read-only.
//   4. update-in-place         gate.update — same number, and a following
//                              detect still resolves it. On an intact PR the
//                              gate answers `current` (the idempotent re-run:
//                              nothing needs rewriting); `updated` is the
//                              same door's answer when a repair is due. Both
//                              assert the number's invariance. Mutating.
//   5. tampered-claim-refusal  with `--expect-tampered`, gate.update MUST
//                              answer the recorded `plan-conflict` refusal —
//                              the caller corrupts the live PR's claim BETWEEN
//                              RUNS (the documented gh step in --help; this
//                              script never corrupts anything). An update
//                              that succeeds is a silent rewrite — the exact
//                              failure the leg exists to catch — and fails
//                              the harness. Mutating.
//   6. transport-failure       a SECOND adapter instance built on a bogus
//                              token (never the real one) — gate.detect
//                              answers the classified `transport-failure`
//                              outcome, not a throw, not absence. Read-only.
//
// Safety laws (each enforced here, not promised):
//   - The mutating legs demand `RELEASE_PR_E2E_MUTATE=1` explicitly; without
//     it the run is read-only, the mutating legs are recorded as skipped, and
//     the script prints what it would do. The default posture is safe.
//   - The real token enters ONLY as `RELEASE_CRAFT_GITHUB_TOKEN`; it is never
//     logged, never written to the evidence file, never echoed — every
//     evidence line is scanned and redacted before it is written (pinned).
//     The mutating legs refuse loudly, by name, without the token.
//   - The script NEVER merges the Release PR and NEVER pushes branches; it
//     prints the created PR number and URL so the coordinator can close the
//     draft after judging the legs.
//
// The plan input is computed, never hand-written: the repository's own world
// is closed exactly as the self-dogfood closes it (the
// `scripts/dogfood/close-world.mjs` closure, spawned — a subprocess, not an
// import: the gate-scripts project may not import the package, and this file
// imports nothing from it), and the planner seam computes the plan — same
// world, same plan bytes. The identity is derived from that world (the
// declared component, the declared line, the branch its feed ref names), so
// the identity is real because the world is.
//
// Home disclosure: the slice's default suggestion was `scripts/`, but
// `scripts/` is the `type-gates` Moon project whose boundary row
// (module-boundaries.config.mjs) forbids importing the package a gate would
// judge — measured, archkeep refuses the import (`gate-scripts →
// release-craft`, onlyTagsConstraintViolation). This harness DRIVES the
// driver as a consumer (the role `test/release-pr-driver.test.ts` plays in
// the same project), so it lives in the root project — `type-package`, whose
// boundary row reaches every layer — and imports the package through the
// package root barrel, the one composition root `openReleasePRDriver` is
// exported from. At runtime the self-reference resolves to the built package
// (`pnpm build` first — the fresh-clone law); under Vitest and tsc the
// specifier resolves to sources (vitest.config.ts's alias, tsconfig `paths`).
//
// Usage: `node e2e/release-pr-e2e.mjs --help`.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  MemoryRecordSink,
  openReleasePRDriver,
  renderReleasePRProjection,
} from "@ecoma-io/release-craft";
import { openGitBinding } from "@ecoma-io/release-craft/adapters/git";
import { openGitHubAdapter } from "@ecoma-io/release-craft/adapters/github";
import { plan } from "@ecoma-io/release-craft/planner";

/** @typedef {import("@ecoma-io/release-craft/planner").PlanningInput} PlanningInput */
/** @typedef {import("@ecoma-io/release-craft/planner").PlanningOutcome} PlanningOutcome */
/** @typedef {import("@ecoma-io/release-craft/planner").ReleasePlan} ReleasePlan */
/** @typedef {import("@ecoma-io/release-craft/app").ReleasePROutcome} ReleasePROutcome */
/** @typedef {import("@ecoma-io/release-craft/adapters/github").GitHubCredentials} GitHubCredentials */
/** @typedef {import("@ecoma-io/release-craft/adapters/github").GitHubResponse} GitHubResponse */
/** @typedef {import("@ecoma-io/release-craft/adapters/github").GitHubTransport} GitHubTransport */

// ---------------------------------------------------------------------------
// §1 — the legs: names, posture, expected outcome kinds
// ---------------------------------------------------------------------------

/** The six legs, in canonical order. A run may name a subset with `--legs`;
 * the canonical order is kept regardless of the caller's spelling. (Exported
 * for the harness's own pins — the vocabulary is part of the pinned
 * surface.) */
export const LEG_NAMES = Object.freeze([
  "detect-empty",
  "create",
  "detect-adopts",
  "update-in-place",
  "tampered-claim-refusal",
  "transport-failure",
]);

/** The legs that can move the remote: every leg that drives `create` or
 * `update`, including the tamper leg (it drives `update` and asserts the
 * refusal — the write it must never see IS its subject). (Exported for the
 * harness's own pins.) */
export const MUTATING_LEGS = Object.freeze(["create", "update-in-place", "tampered-claim-refusal"]);

/** Each leg's expected outcome kinds — declared, never guessed (the
 * self-release dispatch's own law: a posture is declared). Every kind is the
 * gate's own outcome vocabulary (src/app/release-pr-types.ts). One leg
 * declares two kinds, for a reason the evidence records with the observed
 * kind: `update-in-place` may answer `current` (intact PR — the idempotent
 * no-op the port's writes then skip) or `updated` (a repair was due). The
 * tamper leg declares the single recorded conflict the corrupt claim must
 * produce — a silent rewrite there is the harness's own failure. */
const EXPECTED_KINDS = /** @type {Readonly<Record<string, readonly string[]>>} */ (
  Object.freeze({
    "detect-empty": Object.freeze(["detected"]),
    create: Object.freeze(["created"]),
    "detect-adopts": Object.freeze(["found"]),
    "update-in-place": Object.freeze(["updated", "current"]),
    "tampered-claim-refusal": Object.freeze(["plan-conflict"]),
    "transport-failure": Object.freeze(["transport-failure"]),
  })
);

// ---------------------------------------------------------------------------
// §2 — argv: the declared protocol, refused loudly otherwise
// ---------------------------------------------------------------------------

/**
 * The parsed invocation's two postures and its fault, discriminated by the
 * `help` / `fault` fields.
 *
 * @typedef {object} ParsedArgvHelp
 * @property {true} help the `--help` posture: print the help, run nothing.
 * @property {undefined} repo unused under the help posture.
 * @property {undefined} evidence unused under the help posture.
 * @property {undefined} legs unused under the help posture.
 * @property {undefined} expectTampered unused under the help posture.
 */

/**
 * The parsed invocation (the run posture).
 *
 * @typedef {object} ParsedRunArgv
 * @property {false} help not the help posture.
 * @property {string} repo the repository to close the world over and to open
 *   the PR against.
 * @property {string} evidence the evidence JSONL file's path — the caller
 *   names it, the harness appends.
 * @property {string[]} legs the legs to run, canonicalized to `LEG_NAMES`
 *   order.
 * @property {boolean} expectTampered the tamper leg's declared posture (the
 *   `--expect-tampered` flag).
 */

/**
 * A usage fault: the message names the protocol the caller broke.
 *
 * @typedef {object} ArgvFault
 * @property {string} fault the protocol violation's own words.
 */

/** @typedef {ParsedArgvHelp | ParsedRunArgv | ArgvFault} ParsedInvocation */

/**
 * Parses the harness's argv. The protocol: `--repo <path>` (default `.` —
 * the workflow's posture), `--evidence <path>` (required — evidence whose
 * path the caller does not name is evidence nobody can read), `--legs`
 * (comma-separated subset), `--expect-tampered`, `--help`. Anything else is
 * a usage fault, never an ignored argument.
 *
 * @param {readonly string[]} argv the harness's argv (post `node <script>`)
 * @returns {ParsedInvocation} the parse, the help posture, or the fault
 */
export function parseArgv(argv) {
  if (argv.includes("--help")) {
    return {
      help: true,
      repo: undefined,
      evidence: undefined,
      legs: undefined,
      expectTampered: undefined,
    };
  }
  /** @type {string | undefined} */
  let repo;
  /** @type {string | undefined} */
  let evidence;
  /** @type {string | undefined} */
  let legs;
  let expectTampered = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--repo":
      case "--evidence":
      case "--legs": {
        const value = argv[index + 1];
        if (value === undefined) {
          return { fault: `${String(arg)} demands a value` };
        }
        if (arg === "--repo") repo = value;
        else if (arg === "--evidence") evidence = value;
        else legs = value;
        index += 1;
        break;
      }
      case "--expect-tampered":
        expectTampered = true;
        break;
      default:
        return { fault: `unexpected argument "${String(arg)}"` };
    }
  }
  if (evidence === undefined) {
    return { fault: "--evidence <path> is required — the caller names the evidence file" };
  }
  const requested = legs === undefined ? [...LEG_NAMES] : legs.split(",");
  for (const leg of requested) {
    if (!LEG_NAMES.includes(leg)) {
      return {
        fault: `unknown leg "${leg}" — the legs are ${LEG_NAMES.join(", ")}`,
      };
    }
  }
  if (requested.length === 0) {
    return { fault: "--legs names no leg" };
  }
  if (requested.includes("tampered-claim-refusal") && !expectTampered) {
    return {
      fault:
        "the tamper leg demands --expect-tampered — the tampered posture is declared, never " +
        "guessed (an un-declared tamper run would read the pin's refusal as a harness " +
        "failure instead of the recorded conflict it is)",
    };
  }
  const canonical = LEG_NAMES.filter((leg) => requested.includes(leg));
  return {
    help: false,
    repo: repo ?? ".",
    evidence,
    legs: [...canonical],
    expectTampered,
  };
}

/**
 * Resolves which legs this invocation may run, under the invocation's safety
 * posture. The laws: a mutating leg without `RELEASE_PR_E2E_MUTATE=1` is
 * SKIPPED (recorded, printed — the default posture is safe); a mutating leg
 * under the mutation posture without the token is a FAULT (loud, named — the
 * invocation asked for a mutation it cannot authenticate); `detect-adopts`
 * and `update-in-place` demand the same run's `create` (the legs pin the
 * created PR's number through adoption and in-place update; a stale number
 * from a previous run would pin nothing); the tamper leg's
 * `--expect-tampered` demand is checked at parse.
 *
 * @param {readonly string[]} legs the canonical legs this run names
 * @param {{ mutate: boolean, hasToken: boolean }} posture the safety posture
 * @returns {{ plan: { leg: string, run: boolean, reason: string | null }[], fault: string | null }}
 */
export function resolveLegPlan(legs, posture) {
  const hasCreate = legs.includes("create");
  /** @type {{ leg: string, run: boolean, reason: string | null }[]} */
  const plan = [];
  for (const leg of legs) {
    if (MUTATING_LEGS.includes(leg) && !posture.mutate) {
      plan.push({ leg, run: false, reason: "mutating leg without RELEASE_PR_E2E_MUTATE=1" });
      continue;
    }
    if (MUTATING_LEGS.includes(leg) && posture.mutate && !posture.hasToken) {
      return {
        plan: [],
        fault:
          `the mutating leg "${leg}" demands RELEASE_CRAFT_GITHUB_TOKEN — the real credential ` +
          "enters only as that environment variable, and a mutation without it is refused, " +
          "loudly, by name",
      };
    }
    if ((leg === "detect-adopts" || leg === "update-in-place") && !hasCreate) {
      return {
        plan: [],
        fault:
          `the leg "${leg}" pins the number the same run's create returned — name "create" ` +
          "in the same --legs set (the adoption and in-place-update pins are meaningless " +
          "over a number this run did not mint)",
      };
    }
    plan.push({ leg, run: true, reason: null });
  }
  return { plan, fault: null };
}

// ---------------------------------------------------------------------------
// §3 — the plan input: the world closure and the planner seam
// ---------------------------------------------------------------------------

/**
 * Closes the repository's world exactly as the self-dogfood closes it: the
 * `scripts/dogfood/close-world.mjs` closure, spawned as a subprocess (its
 * stdout is the document — the workflow's own posture). A failing closure is
 * a loud fault: a world that cannot be observed cannot be planned.
 *
 * @param {string} repo the repository to observe
 * @returns {PlanningInput} the closed world document
 */
export function closeWorld(repo) {
  const script = join(import.meta.dirname, "..", "scripts", "dogfood", "close-world.mjs");
  const child = spawnSync(process.execPath, [script, "--repo", repo], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.error !== undefined) {
    throw new Error(`the world closure could not be spawned: ${String(child.error)}`);
  }
  if (child.status !== 0) {
    throw new Error(`the world closure exited ${String(child.status)}: ${child.stderr.trim()}`);
  }
  try {
    return /** @type {PlanningInput} */ (JSON.parse(child.stdout));
  } catch {
    throw new Error("the world closure's stdout is not a JSON world document");
  }
}

/**
 * Computes the ReleasePlan through the planner seam — the same pure door the
 * run engine drives — and refuses every non-planned outcome loudly: a world
 * that plans no pending release is a posture the harness cannot pin the legs
 * over, and a silent fall-through would pin nothing while printing green.
 *
 * @param {PlanningInput} world the closed world document
 * @returns {ReleasePlan} the computed plan
 */
export function computePlan(world) {
  /** @type {PlanningOutcome} */
  const outcome = plan(world);
  if (outcome.kind !== "planned") {
    throw new Error(
      `the planner refused the closed world (${outcome.kind}) — the legs need a pending ` +
        "release; a checkout whose observed tags or history plan nothing cannot run them " +
        "(close the world from a checkout whose posture yields a pending release, e.g. one " +
        "that has not fetched the release tags)",
    );
  }
  return outcome.plan;
}

/**
 * Derives the Release PR identity from the closed world — the declared
 * component, the declared line, and the branch the line's feed ref names.
 * Every field is real because the world is: nothing is hardcoded, and a
 * world that cannot yield the triplet faults loudly instead of guessing.
 *
 * @param {PlanningInput} world the closed world document
 * @returns {{ component: string, releaseLine: string, targetBranch: string }}
 */
export function deriveIdentity(world) {
  const components = world.components ?? [];
  if (components.length !== 1) {
    throw new Error(
      `the world declares ${String(components.length)} components — the identity's ` +
        "component is derived from the one declared component (the D17(8) single-component " +
        "posture the self-dogfood closes), and a multi-component world needs the declared " +
        "publishes binding the harness does not guess",
    );
  }
  const component = components[0]?.name;
  const line = world.lines.find(
    (candidate) => candidate.declared && candidate.lifecycle === "active",
  );
  if (component === undefined || component.length === 0 || line === undefined) {
    throw new Error(
      "the world declares no active line or no component — the identity is underivable",
    );
  }
  const prefix = "refs/heads/";
  if (!line.feedRef.startsWith(prefix)) {
    throw new Error(
      `the line's feed ref "${line.feedRef}" does not name a branch — the identity's target ` +
        "branch is the branch the feed ref tracks",
    );
  }
  return { component, releaseLine: line.id, targetBranch: line.feedRef.slice(prefix.length) };
}

/**
 * The pre-flight every leg run owes: the computed plan must still render a
 * pending release for the derived identity. A plan whose lines no-op (the
 * `nothing-pending` posture) would turn leg one into a loud kind mismatch —
 * this turns it into a named pre-flight fault instead, before any remote
 * call, so the evidence file never records a leg run over a vacuous world.
 *
 * @param {ReleasePlan} planValue the computed plan
 * @param {{ component: string, releaseLine: string, targetBranch: string }} identity
 *   the derived identity
 * @returns {void} throws when the plan renders nothing pending
 */
export function requirePendingRelease(planValue, identity) {
  const render = renderReleasePRProjection(identity, planValue);
  if (render === null) {
    throw new Error(
      "the closed world plans no pending release for the derived identity — the legs need " +
        "a release the gate would project (a checkout whose replay is a no-op cannot run " +
        "them; see --help, THE PLAN INPUT)",
    );
  }
}

// ---------------------------------------------------------------------------
// §4 — the remote: origin parse, the caller-side transport
// ---------------------------------------------------------------------------

/**
 * Parses owner/repo out of the checkout's origin URL — the credentials the
 * adapter factory cross-checks against the Git origin at open (§2.9; the
 * checkout's origin must be the target repo). GitHub URLs only: the harness
 * is the org's dogfood, not a general client.
 *
 * @param {string} url the configured origin URL
 * @returns {{ owner: string, repo: string } | null} the parse, or null
 */
export function originOwnerRepo(url) {
  const https = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(url);
  if (https !== null) {
    const owner = https[1];
    const repo = https[2];
    if (owner !== undefined && repo !== undefined) return { owner, repo };
  }
  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(\.git)?$/.exec(url);
  if (ssh !== null) {
    const owner = ssh[1];
    const repo = ssh[2];
    if (owner !== undefined && repo !== undefined) return { owner, repo };
  }
  return null;
}

/**
 * Reads the checkout's origin through git — the same read the adapter
 * factory's open-time agreement performs.
 *
 * @param {string} repo the repository path
 * @returns {string} the configured origin URL
 */
export function readOriginUrl(repo) {
  const child = spawnSync("git", ["-C", repo, "remote", "get-url", "origin"], {
    encoding: "utf8",
  });
  if (child.error !== undefined) {
    throw new Error(`git remote get-url origin could not be spawned: ${String(child.error)}`);
  }
  if (child.status !== 0) {
    throw new Error(
      `git -C ${repo} remote get-url origin exited ${String(child.status)}: ${child.stderr.trim()} — ` +
        "the harness opens the gate against the checkout's own origin, and an origin-less " +
        "checkout names no target",
    );
  }
  return child.stdout.trim();
}

/**
 * The child that performs one HTTPS call for the synchronous transport: the
 * adapter's discipline is synchronous values (Node has no synchronous HTTPS
 * client), so the harness crosses the one asynchronous boundary in a child
 * process and blocks on it. The token travels to the child through STDIN
 * only — never argv (ps-visible), never a file on disk — and the child
 * writes the classified response as one JSON document on stdout. A
 * child-level failure (spawn, socket, timeout) is the transport's status 0:
 * the adapter's own retryable class (ADR-0010 decision 7's guarded boundary).
 */
export const TRANSPORT_CHILD = `
const payload = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
fetch(payload.url, { method: payload.method, headers: payload.headers, body: payload.body })
  .then(async (res) => {
    const headers = {};
    res.headers.forEach((value, name) => { headers[name] = value; });
    process.stdout.write(JSON.stringify({ status: res.status, headers, body: await res.text() }));
  })
  .catch((error) => {
    process.stdout.write(JSON.stringify({ status: 0, headers: {}, body: String(error) }));
  });
`;

/**
 * Builds the caller-side `GitHubTransport` over one token: every request is
 * one blocked child call against `https://api.github.com`. The token enters
 * the request headers inside the child's stdin payload and nowhere else; no
 * log or evidence path ever receives it (the evidence redaction of §5 is the
 * second guard behind this first one).
 *
 * @param {string} token the credential for this transport's requests
 * @returns {GitHubTransport} the synchronous transport
 */
export function buildTransport(token) {
  return {
    /**
     * @param {string} path the API-relative path
     * @param {{ method?: "GET" | "POST" | "PATCH" | "PUT", body?: string, headers?: Record<string, string> } | undefined} init
     * @returns {GitHubResponse} the classified response value
     */
    request(path, init) {
      /** @type {Record<string, string>} */
      const headers = {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "release-craft-e2e-harness",
      };
      if (init?.headers !== undefined) Object.assign(headers, init.headers);
      const body = init?.body;
      if (body !== undefined) headers["content-type"] = "application/json";
      const child = spawnSync(process.execPath, ["--input-type=commonjs", "-e", TRANSPORT_CHILD], {
        input: JSON.stringify({
          url: `https://api.github.com${path}`,
          method: init?.method ?? "GET",
          headers,
          body,
        }),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
      });
      if (child.error !== undefined || child.status !== 0) {
        return {
          status: 0,
          headers: {},
          body: child.stderr.trim() || "the transport child failed",
        };
      }
      try {
        const parsed =
          /** @type {{ status: number, headers: Record<string, string>, body: string }} */ (
            JSON.parse(child.stdout)
          );
        return { status: parsed.status, headers: parsed.headers, body: parsed.body };
      } catch {
        return { status: 0, headers: {}, body: "the transport child's answer is not JSON" };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// §5 — the leg verdicts: declared kinds, structural pins, redaction
// ---------------------------------------------------------------------------

/**
 * A leg's verdict: pass/fail with the observed outcome named.
 *
 * @typedef {object} LegVerdict
 * @property {boolean} pass whether every pin the leg declares held
 * @property {string | null} observedKind the gate outcome's kind, when the
 *   leg ran
 * @property {number | null} prNumber the PR the outcome speaks of, when it
 *   names one
 * @property {string[]} failures every pin that broke, in words
 */

/**
 * Extracts the evidence fields the gate's outcome union can carry: the kind,
 * and the PR number when the outcome speaks of one PR.
 *
 * @param {ReleasePROutcome} outcome the gate's answer
 * @returns {{ kind: string, prNumber: number | null }}
 */
export function outcomeFacts(outcome) {
  const withPR = /** @type {{ pr?: { number?: unknown } }} */ (/** @type {unknown} */ (outcome));
  const number = withPR.pr?.number;
  return {
    kind: outcome.kind,
    prNumber: typeof number === "number" ? number : null,
  };
}

/**
 * Judges one leg's outcome against its declared kinds and the leg's
 * structural pins — the harness's core assertion, pure over values:
 *
 *   - the observed kind must be one the leg declared (a mismatch names both);
 *   - `create` must answer a DRAFT (the harness's own safety law: the legs
 *     minimize noise and merge risk) with a positive number;
 *   - `detect-adopts` and `update-in-place` must answer the number the same
 *     run's create minted — the number's invariance IS the in-place law;
 *   - the tamper leg's conflict must carry the recorded conflict's own words
 *     — a refusal without words is a shrug.
 *
 * @param {string} leg the leg the outcome answers
 * @param {ReleasePROutcome} outcome the gate's answer
 * @param {number | null} createdPrNumber the number the same run's create minted
 * @returns {LegVerdict} the verdict
 */
export function judgeLeg(leg, outcome, createdPrNumber) {
  const expected = EXPECTED_KINDS[leg] ?? [];
  const facts = outcomeFacts(outcome);
  /** @type {string[]} */
  const failures = [];
  if (!expected.includes(facts.kind)) {
    failures.push(`expected outcome kind ${expected.join(" or ")}, observed ${facts.kind}`);
  }
  if (leg === "create") {
    const created = /** @type {{ pr?: { draft?: unknown, number?: unknown } }} */ (
      /** @type {unknown} */ (outcome)
    ).pr;
    if (created?.draft !== true) {
      failures.push("the created PR is not a draft — the harness's own safety law demands draft");
    }
    if (typeof created?.number !== "number" || created.number <= 0) {
      failures.push("the created PR carries no positive number");
    }
  }
  if (
    (leg === "detect-adopts" || leg === "update-in-place") &&
    facts.prNumber !== createdPrNumber
  ) {
    failures.push(
      `the leg must resolve the number the same run created (${String(createdPrNumber)}), ` +
        `observed ${String(facts.prNumber)}`,
    );
  }
  if (leg === "tampered-claim-refusal" && facts.kind === "plan-conflict") {
    const detail = /** @type {{ detail?: unknown }} */ (/** @type {unknown} */ (outcome)).detail;
    if (typeof detail !== "string" || detail.length === 0) {
      failures.push("the recorded conflict names no detail — a refusal without words is a shrug");
    }
  }
  return {
    pass: failures.length === 0,
    observedKind: facts.kind,
    prNumber: facts.prNumber,
    failures,
  };
}

/**
 * Judges the follow-up detect that `update-in-place` runs: the PR must still
 * resolve by its claim after the update — same number, or the in-place law
 * is broken.
 *
 * @param {ReleasePROutcome} outcome the detect's answer
 * @param {number | null} createdPrNumber the number the same run created
 * @returns {LegVerdict} the verdict
 */
export function judgeStillResolves(outcome, createdPrNumber) {
  const facts = outcomeFacts(outcome);
  /** @type {string[]} */
  const failures = [];
  if (facts.kind !== "found") {
    failures.push(`expected the PR to still resolve as found, observed ${facts.kind}`);
  } else if (facts.prNumber !== createdPrNumber) {
    failures.push(
      `the detect after update resolved ${String(facts.prNumber)}, not the created ${String(createdPrNumber)}`,
    );
  }
  return {
    pass: failures.length === 0,
    observedKind: facts.kind,
    prNumber: facts.prNumber,
    failures,
  };
}

/**
 * Serializes one evidence line and scans it for the token — the guard that
 * keeps the real credential out of the evidence file whatever the caller
 * handed the harness on argv. The scan runs over the whole serialized line
 * (argv, sink tail, details), so every field is covered by one guard, and a
 * line that survives its own redaction is refused rather than written.
 *
 * @param {{ timestamp: string, leg: string, run: boolean, reason: string | null, argv: string[], expected: string[], observed: { kind: string | null, prNumber: number | null, failures: string[] } | null, sinkTail: unknown[] }} line
 * @param {string | undefined} token the real credential, when present
 * @returns {string} the JSONL line, newline-terminated
 */
export function serializeEvidenceLine(line, token) {
  const serialized = JSON.stringify(line);
  if (token === undefined || token.length === 0) {
    return `${serialized}\n`;
  }
  const redacted = serialized.split(token).join("[redacted]");
  if (redacted.includes(token)) {
    throw new Error("the evidence line survived its own redaction — refusing to write it");
  }
  return `${redacted}\n`;
}

// ---------------------------------------------------------------------------
// §6 — the run
// ---------------------------------------------------------------------------

/** The help: the invocation protocol, the recommended two-run sequence, the
 * safety laws, and the tamper step the caller performs between the runs. */
const HELP = `the release-pr live-legs harness (issue #202) — drives the six Release PR gate legs
against the checkout's own origin and captures per-leg evidence as JSONL.

USAGE
  node e2e/release-pr-e2e.mjs --evidence <path> [flags]

FLAGS
  --repo <path>          the repository to close the world over and open the PR
                         against (default: "." — the checkout's own origin IS the
                         target; the adapter factory cross-checks them at open)
  --evidence <path>      the evidence JSONL file; lines are APPENDED, one per leg
                         (required)
  --legs <a,b,...>       a subset of the six legs, canonical order kept (default: all)
  --expect-tampered      declares the tamper posture — demanded by the
                         tampered-claim-refusal leg
  --help                 this text

THE SIX LEGS (canonical order; expected outcome kinds in parentheses)
  detect-empty            (detected)             read-only
  create                  (created, DRAFT)      mutating
  detect-adopts           (found, same number)  read-only
  update-in-place         (updated or current   mutating
                           — same number; the
                           follow-up detect must
                           still resolve it)
  tampered-claim-refusal  (plan-conflict)       mutating
  transport-failure       (transport-failure,   read-only; runs on its own
                           via a BOGUS token)   bogus token, never the real one

SAFETY LAWS
  - Mutating legs (create, update-in-place, tampered-claim-refusal) run only
    with RELEASE_PR_E2E_MUTATE=1 in the environment. Without it the run is
    read-only: the mutating legs are recorded as skipped and printed as what
    WOULD have run.
  - The real token enters only as RELEASE_CRAFT_GITHUB_TOKEN. It is never
    logged, never written to the evidence file (every line is scanned and
    redacted before the write), never echoed. The legs that can move the
    remote refuse loudly, by name, without it.
  - The script NEVER merges the Release PR and NEVER pushes branches. It
    prints the created PR number and URL; the coordinator closes the draft
    after judging the legs.
  - detect-empty requires a clean slate: an existing PR that claims the
    identity turns it into a found — a loud failure, not a skip.

THE PLAN INPUT (computed, never hand-written)
  The world is closed exactly as the self-dogfood closes it (the
  scripts/dogfood/close-world.mjs closure, spawned), and the planner seam
  computes the ReleasePlan — same world, same plan bytes. The identity is
  derived from that world: the declared component, the declared line, the
  branch its feed ref names. A world that plans no pending release (e.g. a
  checkout that has fetched the release tags, whose replay refuses at the
  planning boundary — #263) faults the run loudly BEFORE any leg runs.
  Build the package first: the harness imports the built barrel at runtime
  (pnpm build — the fresh-clone law).

THE RECOMMENDED TWO-RUN SEQUENCE
  # run A — the fresh-identity legs plus the transport leg:
  RELEASE_PR_E2E_MUTATE=1 RELEASE_CRAFT_GITHUB_TOKEN=<token> \\
    node e2e/release-pr-e2e.mjs --evidence release-pr-e2e.jsonl \\
    --legs detect-empty,create,detect-adopts,update-in-place,transport-failure

  # the tamper step — the CALLER corrupts the live PR's claim between runs
  # (this script never corrupts anything). Corrupt the BODY away from the
  # pure render of its recorded plan, keeping the claim marker parseable —
  # e.g. append a line:
  #   gh pr view <N> --json body -q .body > body.md
  #   echo "tampered" >> body.md
  #   gh pr edit <N> --body-file body.md
  # Do NOT delete or garble the marker: a garbled marker refuses discovery
  # (a transport-shaped verdict, not the conflict this leg pins), and a
  # deleted marker makes the PR invisible to claim discovery entirely.
  # <N> is the number run A printed.

  # run B — the tamper posture, declared:
  RELEASE_PR_E2E_MUTATE=1 RELEASE_CRAFT_GITHUB_TOKEN=<token> \\
    node e2e/release-pr-e2e.mjs --evidence release-pr-e2e.jsonl \\
    --legs tampered-claim-refusal --expect-tampered

  # then judge the legs from the evidence file, and close the draft PR:
  #   gh pr close <N>
`;

/** The text `--help` prints — exported so the pinned docs stay the printed
 * docs (the suite pins marker sentences, not the whole text). */
export const helpText = HELP;

/**
 * The per-leg context the run threads through the doors. The gates open
 * conditionally (the real one only when a leg needs it), so they start
 * undefined and `runLeg` refuses a leg whose gate never opened — a harness
 * bug if it ever fires, since `resolveLegPlan` gates the doors and the legs.
 *
 * @typedef {object} LegContext
 * @property {ReturnType<typeof openReleasePRDriver> | undefined} gate the
 *   gate over the real port, when the real credential was supplied
 * @property {ReturnType<typeof openReleasePRDriver> | undefined} bogusGate
 *   the transport-failure leg's canary over the bogus token
 * @property {{ component: string, releaseLine: string, targetBranch: string }} identity
 * @property {ReleasePlan} plan the computed plan
 * @property {number | null} createdPrNumber the number the same run's create
 *   minted
 */

/**
 * Runs one leg's door calls. The follow-up detect inside `update-in-place`
 * rides here; the judging stays in `judgeLeg`/`judgeStillResolves`.
 *
 * @param {string} leg the leg to run
 * @param {LegContext} context the run's leg context
 * @returns {LegVerdict} the verdict
 */
function runLeg(leg, context) {
  const { gate, bogusGate, identity, plan } = context;
  if (leg === "transport-failure") {
    if (bogusGate === undefined) {
      return {
        pass: false,
        observedKind: null,
        prNumber: null,
        failures: ["the bogus gate never opened — a harness bug: the leg plan admitted the leg"],
      };
    }
    return judgeLeg(leg, bogusGate.detect(identity, plan), context.createdPrNumber);
  }
  if (gate === undefined) {
    return {
      pass: false,
      observedKind: null,
      prNumber: null,
      failures: ["the real gate never opened — a harness bug: the leg plan admitted the leg"],
    };
  }
  switch (leg) {
    case "detect-empty":
    case "detect-adopts":
      return judgeLeg(leg, gate.detect(identity, plan), context.createdPrNumber);
    case "create":
      return judgeLeg(leg, gate.create(identity, plan, { draft: true }), context.createdPrNumber);
    case "update-in-place": {
      const update = judgeLeg(leg, gate.update(identity, plan), context.createdPrNumber);
      if (!update.pass) return update;
      return judgeStillResolves(gate.detect(identity, plan), context.createdPrNumber);
    }
    case "tampered-claim-refusal":
      return judgeLeg(leg, gate.update(identity, plan), context.createdPrNumber);
    default:
      return {
        pass: false,
        observedKind: null,
        prNumber: null,
        failures: [`unknown leg "${leg}"`],
      };
  }
}

/**
 * The run: parse, posture, world, plan, legs, evidence, summary.
 *
 * @param {readonly string[]} argv the harness's argv
 * @returns {number} the exit code (0 green or safely skipped; 1 a leg or
 *   world fault; 2 a usage fault)
 */
function run(argv) {
  const parsed = parseArgv(argv);
  if ("fault" in parsed) {
    process.stderr.write(`release-pr-e2e: ${parsed.fault}\n(run with --help)\n`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(`${helpText}\n`);
    return 0;
  }
  const token = process.env["RELEASE_CRAFT_GITHUB_TOKEN"];
  const mutate = process.env["RELEASE_PR_E2E_MUTATE"] === "1";
  const legPlan = resolveLegPlan(parsed.legs, { mutate, hasToken: token !== undefined });
  if (legPlan.fault !== null) {
    process.stderr.write(`release-pr-e2e: ${legPlan.fault}\n`);
    return 2;
  }
  const runnable = legPlan.plan.filter((entry) => entry.run).map((entry) => entry.leg);
  const runsRealGate = runnable.some((leg) => leg !== "transport-failure");
  if (runsRealGate && token === undefined) {
    process.stderr.write(
      "release-pr-e2e: the real legs need RELEASE_CRAFT_GITHUB_TOKEN — detecting nothing " +
        "without credentials would be a vacuous green, and the harness refuses vacuous greens\n",
    );
    return 2;
  }

  // The origin — the credentials' owner/repo, cross-checked by the factory
  // against this very URL at open — before any gate: the transport-failure
  // leg needs it too (its bogus instance must satisfy the same agreement to
  // open at all, which is the point: only the token differs).
  /** @type {{ owner: string, repo: string } | null} */
  let ownerRepo = null;
  if (runnable.length > 0) {
    try {
      ownerRepo = originOwnerRepo(readOriginUrl(parsed.repo));
    } catch (error) {
      process.stderr.write(
        `release-pr-e2e: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 2;
    }
    if (ownerRepo === null) {
      process.stderr.write(
        "release-pr-e2e: the checkout's origin does not name a github.com repository — the " +
          "harness opens the gate against the checkout's own origin, and the credentials " +
          "must name the same repository the factory's open-time agreement compares (§2.9)\n",
      );
      return 2;
    }
  }

  // The world, the plan, the identity — all before any remote call, so a
  // posture that cannot yield a pending release faults with zero legs run.
  /** @type {PlanningInput} */
  let world;
  /** @type {ReleasePlan} */
  let planValue;
  /** @type {{ component: string, releaseLine: string, targetBranch: string }} */
  let identity;
  try {
    world = closeWorld(parsed.repo);
    planValue = computePlan(world);
    identity = deriveIdentity(world);
    requirePendingRelease(planValue, identity);
  } catch (error) {
    process.stderr.write(
      `release-pr-e2e: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  // The gates. The REAL gate opens only when a leg needs it, over the
  // credentials the origin parse produced and the caller-side transport;
  // the bogus gate (the transport-failure leg's canary) carries the same
  // owner/repo and a token no one issued.
  const binding = () =>
    openGitBinding({ repo: parsed.repo, tagNaming: { namespaces: ["v"], tagFor: () => null } });
  const sink = new MemoryRecordSink();
  const context = /** @type {LegContext} */ ({
    identity,
    plan: planValue,
    createdPrNumber: null,
    gate: undefined,
    bogusGate: undefined,
  });
  if (runsRealGate) {
    /** @type {GitHubCredentials} */
    const credentials = {
      owner: ownerRepo?.owner ?? "",
      repo: ownerRepo?.repo ?? "",
      token: token ?? "",
    };
    context.gate = openReleasePRDriver(
      openGitHubAdapter(binding(), credentials, buildTransport(credentials.token)),
      sink,
    );
  }
  if (runnable.includes("transport-failure")) {
    context.bogusGate = openReleasePRDriver(
      openGitHubAdapter(
        binding(),
        /** @type {GitHubCredentials} */ ({
          owner: ownerRepo?.owner ?? "",
          repo: ownerRepo?.repo ?? "",
          token: "release-craft-e2e-invalid-token",
        }),
        buildTransport("release-craft-e2e-invalid-token"),
      ),
      // The same sink: the bogus instance's recorded transport-failure
      // verdict belongs in the evidence stream with every other leg's.
      sink,
    );
  }

  let exit = 0;
  /** @type {string | null} */
  let createdUrl = null;
  for (const entry of legPlan.plan) {
    const timestamp = new Date().toISOString();
    const tailBefore = sink.tail().length;
    /** @type {LegVerdict} */
    let verdict;
    if (!entry.run) {
      verdict = { pass: true, observedKind: null, prNumber: null, failures: [] };
    } else {
      try {
        verdict = runLeg(entry.leg, context);
      } catch (error) {
        // A throw crossing the run (the gate's own scope error is the one it
        // owns; the rest would be a harness bug) is the leg's failure,
        // recorded — the evidence file must outlive every failure mode the
        // run can produce.
        verdict = {
          pass: false,
          observedKind: "threw",
          prNumber: null,
          failures: [error instanceof Error ? error.message : String(error)],
        };
      }
    }
    if (entry.leg === "create" && verdict.pass && verdict.prNumber !== null) {
      context.createdPrNumber = verdict.prNumber;
      createdUrl = `https://github.com/${ownerRepo?.owner}/${ownerRepo?.repo}/pull/${String(verdict.prNumber)}`;
    }
    const sinkTail = sink.tail().slice(tailBefore);
    const line = {
      timestamp,
      leg: entry.leg,
      run: entry.run,
      reason: entry.reason,
      argv: [...argv],
      expected: [...(EXPECTED_KINDS[entry.leg] ?? [])],
      observed:
        entry.run === false
          ? null
          : { kind: verdict.observedKind, prNumber: verdict.prNumber, failures: verdict.failures },
      sinkTail,
    };
    try {
      appendFileSync(parsed.evidence, serializeEvidenceLine(line, token));
    } catch (error) {
      process.stderr.write(
        `release-pr-e2e: the evidence file refused the write: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    const posture = entry.run ? (verdict.pass ? "PASS" : "FAIL") : "SKIP";
    const observedWords =
      entry.run === false
        ? (entry.reason ?? "")
        : `${verdict.observedKind ?? "no outcome"}${
            verdict.prNumber === null ? "" : ` (pr #${String(verdict.prNumber)})`
          }${verdict.failures.map((failure) => ` — ${failure}`).join("")}`;
    process.stdout.write(`  ${posture}  ${entry.leg} — ${observedWords}\n`);
    if (!verdict.pass) exit = 1;
  }

  const skipped = legPlan.plan.filter((entry) => !entry.run);
  if (skipped.length > 0) {
    process.stdout.write(
      `\nMUTATING LEGS SKIPPED (RELEASE_PR_E2E_MUTATE is not 1) — the run stayed read-only; ` +
        `what WOULD have run: ${skipped.map((entry) => entry.leg).join(", ")}\n`,
    );
  }
  if (createdUrl !== null) {
    process.stdout.write(
      `\nthe harness opened draft PR ${createdUrl}\n` +
        "it never merges and never pushes — close the draft after judging the legs\n",
    );
  }
  return exit;
}

// The module is a script AND a test subject: the suite imports the pure half
// (parsing, posture, judging, redaction), so the run fires only on direct
// invocation, never on import.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2));
}
