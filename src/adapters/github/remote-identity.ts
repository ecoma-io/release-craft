/**
 * The origin's repository identity, and the open-time agreement it must
 * hold with the credentials (the Phase 9 contract §2.9; ADR-0010
 * decisions 2–3 as amended for #177): the sync transports against the
 * binding's `origin` while the API doors address `owner/repo` from the
 * credentials — two remote identities nothing compared, so a credential
 * for a fork (or any same-named repository the token can write) passed
 * every classification and every `verified` outcome was true of a remote
 * that is not the binding's. The comparison here is the adapter's one
 * identity authority: the origin URL is read the way the sync transports
 * it (`git remote get-url origin`, the effective URL git rewrites
 * `insteadOf` into), normalized to host + owner + repo per git's own URL
 * grammar, and compared against the credentials' repository.
 *
 * The grammar is git's, not invented here: the "GIT URLS" section of
 * git's `Documentation/urls.adoc` lists the `ssh://`, `git://`,
 * `http[s]://` and `ftp[s]://` URL forms, the scp-like
 * `[<user>@]<host>:/<path-to-git-repo>` form — "This syntax is only
 * recognized if there are no slashes before the first colon" — and the
 * local forms `/path/to/repo.git/` and `file:///path/to/repo.git/`. The
 * scp-like rule and the local forms are what separate a repository URL
 * this adapter can compare from an origin this adapter must refuse on.
 */

import type { GitHubCredentials } from "./adapter-types.js";

/**
 * The host the open credentials address. `GitHubCredentials` (§2.5)
 * carries no host and no API base — the closed shape is token/owner/repo
 * — so the only repository any expressible credential addresses is a
 * path on github.com, and an origin on any other host names a repository
 * no expressible credential can be the same as. GitHub Enterprise
 * support is the credential type's amendment to make, never this
 * comparison's guess.
 */
export const CREDENTIALS_HOST = "github.com";

/** The repository identity a remote URL names: the host and the two
 *  GitHub path segments. */
export interface RemoteIdentity {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}

/** The URL schemes git's remote grammar carries — exactly the transports
 *  the "GIT URLS" section lists, plus `file:` (a local repository, which
 *  names no GitHub repository and refuses below). npm's `git+*`
 *  conventions are not git's grammar: a URL carrying them is one git
 *  itself cannot transport, so it reads unknown here and refuses — the
 *  grammar is git's, and the set stays exactly his. */
const KNOWN_SCHEMES: ReadonlySet<string> = new Set([
  "ssh",
  "git",
  "http",
  "https",
  "ftp",
  "ftps",
  "file",
]);

/** Strips one trailing `.git` — the conventional repository-directory
 *  suffix the URL forms carry and the API name never does (GitHub
 *  refuses repository names ending in `.git`, so one strip cannot eat a
 *  real name). */
const stripGitSuffix = (path: string): string =>
  path.toLowerCase().endsWith(".git") ? path.slice(0, -4) : path;

const trimSlashes = (path: string): string => path.replace(/^\/+/, "").replace(/\/+$/, "");

/** The two GitHub path segments (`owner/repo`) a remote path must carry —
 *  and the identities that are not repository paths at all (empty
 *  segments, the ssh `~` expansion's home paths, the remote-helper
 *  `<transport>::<address>` colon forms, paths with any other depth). The
 *  segments normalize to lower case: the identity is the comparison form,
 *  so a differently cased spelling of the same repository is the same
 *  identity. */
const pathIdentity = (path: string): { readonly owner: string; readonly repo: string } | null => {
  const segments = stripGitSuffix(trimSlashes(path))
    .split("/")
    .filter((segment) => segment !== "");
  if (segments.length !== 2) {
    return null;
  }
  const [owner, repo] = segments;
  if (owner === undefined || repo === undefined) {
    return null;
  }
  if (owner === "" || repo === "" || owner.startsWith("~")) {
    return null;
  }
  if (owner.includes(":") || repo.includes(":")) {
    return null;
  }
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase() };
};

const fromUrlForm = (url: string): RemoteIdentity | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (scheme === "file" || !KNOWN_SCHEMES.has(scheme)) {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "") {
    return null;
  }
  const identity = pathIdentity(parsed.pathname);
  return identity === null ? null : { host, ...identity };
};

const fromScpForm = (head: string, path: string): RemoteIdentity | null => {
  const at = head.lastIndexOf("@");
  const host = (at < 0 ? head : head.slice(at + 1)).trim().toLowerCase();
  if (host === "") {
    return null;
  }
  const identity = pathIdentity(path);
  return identity === null ? null : { host, ...identity };
};

/**
 * Normalizes an origin URL to the repository identity it names, or null
 * when it names no github.com-addressable repository: the local forms
 * (a path, `file:`), the ssh `~` expansions, paths that are not exactly
 * `owner/repo`, unknown schemes, and malformed URLs all read null — the
 * fault the open-time check turns into a loud refusal, never a pass.
 */
export const parseRemoteIdentity = (url: string): RemoteIdentity | null => {
  const trimmed = url.trim();
  if (trimmed === "") {
    return null;
  }
  const colon = trimmed.indexOf(":");
  if (colon < 0) {
    return null; // a bare local path
  }
  const head = trimmed.slice(0, colon);
  if (head.includes("/")) {
    return null; // slashes before the first colon: git's local-path rule
  }
  if (KNOWN_SCHEMES.has(head.toLowerCase())) {
    return fromUrlForm(trimmed);
  }
  return fromScpForm(head, trimmed.slice(colon + 1));
};

/**
 * The identity fault between an origin URL and the open credentials, or
 * null when the two name the same repository. Comparison is
 * case-insensitive (host, owner and repo alike) so a differently cased
 * spelling of the same repository does not refuse; anything that cannot
 * be proven equal refuses — fail-closed is the check's whole point.
 * The fault text names both identities: the refusal is loud, never a
 * warning.
 */
export const originIdentityFault = (
  originUrl: string,
  credentials: GitHubCredentials,
): string | null => {
  const shown = originUrl.trim();
  const owner = credentials.owner.trim().toLowerCase();
  const repo = credentials.repo.trim().toLowerCase();
  const identity = parseRemoteIdentity(shown);
  if (identity === null) {
    return (
      `the binding's origin (${shown === "" ? "<empty>" : shown}) does not name a ` +
      `${CREDENTIALS_HOST} repository, and the credentials address ` +
      `${CREDENTIALS_HOST}/${owner}/${repo} — the remote is a projection of the binding's ` +
      "own repository (ADR-0010 decisions 2–3; phase 9 contract §2.9): point the origin at " +
      "the credentials' repository"
    );
  }
  if (identity.host !== CREDENTIALS_HOST || identity.owner !== owner || identity.repo !== repo) {
    return (
      `the binding's origin (${shown}) names ${identity.host}/${identity.owner}/` +
      `${identity.repo}, not the credentials' repository ${CREDENTIALS_HOST}/${owner}/${repo} ` +
      "— the remote is a projection of the binding's own repository (ADR-0010 decisions 2–3; " +
      "phase 9 contract §2.9): align the origin and the credentials"
    );
  }
  return null;
};
