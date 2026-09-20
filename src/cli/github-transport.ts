/**
 * The publish leg's live transport (issue #336): the GitHub REST client
 * the CLI's `--publish` dispatch carries. The engine's synchronous
 * discipline holds at the composition root — the adapter's doors return
 * values, never promises, and Node has no synchronous HTTPS client, so
 * each request is one `node -e` child of the running process (the same
 * shape the CLI already uses to run its own bin), speaking the process's
 * global `fetch` (Node ≥ 24). The token crosses to the child as an
 * environment variable, never an argv — the credential discipline the
 * adapter's own transport ships (`remote-git.ts`: `RELEASE_CRAFT_GITHUB_TOKEN`
 * in the spawned git's environment, `GIT_TERMINAL_PROMPT=0`). The child's
 * whole environment is exactly that one name; the token is never on a
 * command line, never in a file, never in the parent's ambient layer
 * (phase 13 §2.8's "child-scoped transport is the in-tree precedent",
 * extended: the closure is the child's own allowlist, not the parent's).
 *
 * The transport reads the ambient names that define the publish leg —
 * `GITHUB_TOKEN`, `GITHUB_API_URL` — from the process's own environment,
 * and ONLY at this door: the CLI's hermeticity law (phase 12 §4) is
 * amended for the one declared leg, gated on the operator's explicit
 * `--publish` (the token never reaches any other door, and a run without
 * `--publish` never so much as names the name). The invocation's allowlist
 * forwards the same two names when the consumer declared `publish: "true"`
 * (phase 13 §2.8 as amended) — the value rides the reviewable env block,
 * never an input, never an argv.
 */

import { spawnSync } from "node:child_process";

import type {
  GitHubRequestInit,
  GitHubResponse,
  GitHubTransport,
} from "@ecoma-io/release-craft/adapters/github";

/** Ledger tails and release bodies are small; the ceiling exists so a
 *  runaway response fails loudly instead of truncating silently — the
 *  binding runner's own ceiling. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** A request that outlives it returns the transport's own "no determinate
 *  response" shape: the create's ambiguous window, the read's
 *  transport-failure — the same wall the adapter's git transport runs
 *  against (remote-git.ts's `GIT_TIMEOUT_MS`). */
export const PUBLISH_TIMEOUT_MS = 30_000;

/** The default API base. `GITHUB_API_URL` (the runner's enterprise
 *  spelling) overrides it; a trailing slash is trimmed so the API-relative
 *  path joins without doubling it. */
export const DEFAULT_API_BASE_URL = "https://api.github.com";
/** The child program: one fetch — the request surface (base, path, method,
 *  headers) as argv, the request BODY on stdin (a changelog record can run
 *  past ARG_MAX's per-argument ceiling; stdin has none — the same
 *  "large payloads ride the pipe, not the command line" rule the binding's
 *  runner applies to hash-object) — and the response relayed as one JSON
 *  document (status, headers, body) on stdout. A thrown fetch is not an
 *  exception past the child: it renders the transport's status-0 "no
 *  determinate response" shape with the thrown words in the body's message
 *  channel, the exact reading the adapter's doors already give it (§2.3's
 *  `transport-failure` on a read, the `ambiguous` window on a write; the
 *  adapter additionally guards every call through `guardedRequest`). The
 *  child's environment is exactly `{ GITHUB_TOKEN }`: the published
 *  credential flows nowhere else, the ambient layer's proxies and exports
 *  cannot reroute the request, and a hostile ambient cannot plant a name
 *  the child would read. */
const REQUEST_SCRIPT = String.raw`
const [base, path, method, headersJson] = process.argv.slice(1);
const forwarded = headersJson === "" ? {} : JSON.parse(headersJson);
(async () => {
  let body = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) { body += chunk; }
  const init = {};
  if (method !== "GET") { init.method = method; }
  if (body !== "") { init.body = body; }
  const res = await fetch(base + path, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "release-craft-cli",
      Authorization: "Bearer " + (process.env.GITHUB_TOKEN ?? ""),
      ...forwarded,
    },
  });
  const text = await res.text();
  // The write's callback closes the child only once the bytes are flushed:
  // a bare process.exit right after the write would truncate a large
  // response, and undici's keep-alive pool would otherwise hold the caller's
  // blocking spawnSync open until the transport timeout.
  process.stdout.write(
    JSON.stringify({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: text }),
    () => process.exit(0),
  );
})().catch((error) => {
  const thrown = error instanceof Error ? error.name + ": " + error.message : String(error);
  process.stdout.write(JSON.stringify({ status: 0, headers: {}, body: JSON.stringify({ message: thrown }) }), () =>
    process.exit(0),
  );
});
`.trim();

/** The publish environment, read at the one door that may read it. A
 *  declared-but-tokenless publish is a fault before any wire: the
 *  operator's declaration ("publish this run") and an absent credential
 *  cannot both hold, and a request that would determinately 401 is never
 *  fired. */
export const readPublishEnvironment = (): { readonly token: string; readonly baseUrl: string } => {
  const token = process.env.GITHUB_TOKEN;
  if (token === undefined || token === "") {
    throw new Error(
      "the publish leg needs GITHUB_TOKEN in the environment — a token is declared in the caller's " +
        "workflow (github.token), never an input, never a command line",
    );
  }
  const baseUrl = (process.env.GITHUB_API_URL ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  return { token, baseUrl };
};

/** One synchronous GitHub REST call through the process's own node. The
 *  response is a returned value, never a throw: every failure — an
 *  unspawnable child, a lost response, a thrown fetch, a malformed relay —
 *  becomes the status-0 shape the adapter already reads (§2.3), with the
 *  failure's own words riding the body's message channel. */
export const openGitHubTransport = (baseUrl: string, token: string): GitHubTransport => ({
  request(path: string, init?: GitHubRequestInit): GitHubResponse {
    const method = init?.method ?? "GET";
    const result = spawnSync(
      process.execPath,
      ["-e", REQUEST_SCRIPT, baseUrl, path, method, JSON.stringify(init?.headers ?? {})],
      {
        // The child's whole environment: the token and nothing else — the
        // ambient layer's proxy variables and exports cannot reroute or
        // read the request. The body rides the pipe (input), never argv —
        // and the stdio row must be a REAL pipe or the `input` option is
        // silently dropped and the POST goes out bodiless: the create is
        // the one request that carries a body, and an empty one answers
        // the provider's 422 instead of the recorded publication.
        env: { GITHUB_TOKEN: token },
        input: init?.body ?? "",

        encoding: "utf8",
        timeout: PUBLISH_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const lost = (why: string): GitHubResponse => ({
      status: 0,
      headers: {},
      body: JSON.stringify({ message: `the publish transport lost its response (${why})` }),
    });
    if (result.error !== undefined) {
      return lost(result.error.message);
    }
    if (result.status !== 0 || result.stdout === "") {
      const detail =
        result.stderr !== "" ? result.stderr.trim() : "the node child exited without a response";
      return lost(detail);
    }
    try {
      return JSON.parse(result.stdout) as GitHubResponse;
    } catch {
      return lost("the node child relayed a malformed document");
    }
  },
});
