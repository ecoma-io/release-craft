/**
 * The publish test's stateful wire stub (issue #336), run as its own
 * process so the CLI child's synchronously-blocked spawns never
 * deadlock this server (a test-harness worker blocks its own event loop
 * while `spawnSync` runs — a stub inside that worker would never serve
 * its own socket, and the request would hang). The API's statefulness
 * is real: the release read answers 404 until the create lands, then
 * echoes the created body back with the resource's URL; the git-ref
 * read answers the recorded head the controller arms.
 *
 * The control protocol over stdin (one line per command):
 *   `ref <sha>`  — arm the ref head (told once the seeded repo exists)
 *   `bye`        — stop serving and exit
 * and over stdout:
 *   `READY <port>`      — once listening
 *   `PLAY <METHOD> <path>` — one line per served request
 *   `CREATED <json>`    — the release body the create landed, relayed
 *                         the moment it is recorded
 */
import { createServer } from "node:http";

const TAG = "5.0.0-beta.1";
const OWNER = "ecoma-io";
const REPO = "release-craft";
const RELEASE_URL = `https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`;
let refHead = "0".repeat(40);
let created = undefined;
/** Armed by the controller's `missing` command: the git-ref read
 *  answers 404 until the create lands — the wire shape of a tag the
 *  origin does not hold yet, the case where the create itself mints
 *  the tag at the sent commitish. The release read keeps answering 404
 *  until the create in both modes. */
let tagMissing = false;

const server = createServer((req, res) => {
  const method = req.method ?? "GET";
  const path = req.url?.split("?")[0] ?? "";
  process.stdout.write(`PLAY ${method} ${path}\n`);
  const refsPath = `/repos/${OWNER}/${REPO}/git/refs/tags/${TAG}`;
  const releasePath = `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`;
  if (method === "GET" && path === refsPath) {
    if (tagMissing && created === undefined) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ref: `refs/tags/${TAG}`, object: { sha: refHead, type: "commit" } }));
    return;
  }
  if (method === "GET" && path === `/repos/${OWNER}/${REPO}`) {
    // The repository probe the adapter runs when a read 404s (issue
    // #176): an observable repository is what makes `release-tag-missing`
    // determinate — the tag the create is about to mint.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ full_name: `${OWNER}/${REPO}` }));
    return;
  }
  if (method === "GET" && path === releasePath) {
    res.writeHead(created === undefined ? 404 : 200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        created === undefined ? { message: "Not Found" } : { ...created, html_url: RELEASE_URL },
      ),
    );
    return;
  }
  if (method === "POST" && path === `/repos/${OWNER}/${REPO}/releases`) {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        // A malformed create body is a test bug made visible, never a
        // crash that takes the whole stub down with it — answer 400 so
        // the relay shows the played wire and the failure surface names
        // the transport, instead of vanishing in an EPIPE.
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: `malformed create body: ${body.slice(0, 120)}` }));
        return;
      }
      created = parsed;
      process.stdout.write(`CREATED ${JSON.stringify(created)}\n`);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ html_url: RELEASE_URL }));
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: `unexpected ${method} ${path}` }));
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = address === null || typeof address === "string" ? 0 : address.port;
  process.stdout.write(`READY ${port}\n`);
});

process.stdin.setEncoding("utf8");
let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let newline;
  while ((newline = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (line.startsWith("ref ")) {
      refHead = line.slice("ref ".length);
    } else if (line === "missing") {
      tagMissing = true;
    } else if (line === "bye") {
      server.close(() => process.exit(0));
    }
  }
});
process.stdin.on("end", () => {
  server.close(() => process.exit(0));
});
