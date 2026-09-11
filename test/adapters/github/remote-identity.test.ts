/**
 * The origin-identity parser's own pins (the Phase 9 contract §2.9;
 * #177; D54): which origin URL spelling reads as which repository
 * identity, and which read no github.com repository at all. This suite
 * is the one deliberate exception to the barrel-only rule alongside the
 * failure classifier's (`remote-git.test.ts`): the URL grammar is a pure
 * mapping no public outcome carries — the composition-level refusals it
 * feeds stay pinned through the public factory (`adapter.test.ts`). The
 * grammar normalized here is git's own (the "GIT URLS" section of
 * git's `Documentation/urls.adoc`): the URL forms, the scp-like
 * `[<user>@]<host>:/<path>` form with its no-slash-before-the-first-
 * colon recognition rule, and the local forms that name no GitHub
 * repository.
 */
import {
  CREDENTIALS_HOST,
  originIdentityFault,
  parseRemoteIdentity,
} from "@ecoma-io/release-craft/__internal__/adapters/github/remote-identity.js";
import type { GitHubCredentials } from "@ecoma-io/release-craft/__internal__/adapters/github/index.js";

import { describe, expect, it } from "vitest";

const credentials: GitHubCredentials = {
  owner: "ecoma-io",
  repo: "release-craft",
  token: "t0k3n",
};

const identity = (url: string): unknown => parseRemoteIdentity(url);

const github = (owner: string, repo: string): unknown => ({
  host: CREDENTIALS_HOST,
  owner,
  repo,
});

describe("the origin-identity parser (§2.9; #177)", () => {
  it("reads the https forms — with and without the .git suffix and a trailing slash", () => {
    expect(identity("https://github.com/ecoma-io/release-craft.git")).toEqual(
      github("ecoma-io", "release-craft"),
    );
    expect(identity("https://github.com/ecoma-io/release-craft")).toEqual(
      github("ecoma-io", "release-craft"),
    );
    expect(identity("https://github.com/ecoma-io/release-craft/")).toEqual(
      github("ecoma-io", "release-craft"),
    );
    expect(identity("https://github.com/ecoma-io/release-craft.git/")).toEqual(
      github("ecoma-io", "release-craft"),
    );
  });

  it("reads the scp-like forms git recognizes — user and no user, .git and not", () => {
    expect(identity("git@github.com:ecoma-io/release-craft.git")).toEqual(
      github("ecoma-io", "release-craft"),
    );
    expect(identity("git@github.com:ecoma-io/release-craft")).toEqual(
      github("ecoma-io", "release-craft"),
    );
    expect(identity("github.com:ecoma-io/release-craft.git")).toEqual(
      github("ecoma-io", "release-craft"),
    );
  });

  it("reads the ssh:// forms — with the default port and with embedded userinfo", () => {
    expect(identity("ssh://git@github.com/ecoma-io/release-craft.git")).toEqual(
      github("ecoma-io", "release-craft"),
    );
    expect(identity("ssh://git@github.com:22/ecoma-io/release-craft.git")).toEqual(
      github("ecoma-io", "release-craft"),
    );
    expect(identity("https://x-access-token:t0k3n@github.com/ecoma-io/release-craft.git")).toEqual(
      github("ecoma-io", "release-craft"),
    );
  });

  it("reads a differently cased spelling of the same repository as the same identity", () => {
    expect(identity("https://GitHub.com/Ecoma-IO/Release-Craft")).toEqual(
      github("ecoma-io", "release-craft"),
    );
    expect(identity("GIT@GitHub.com:Ecoma-IO/Release-Craft.git")).toEqual(
      github("ecoma-io", "release-craft"),
    );
  });

  it("refuses a repository path that is not exactly owner/repo", () => {
    expect(identity("https://github.com/ecoma-io")).toBeNull();
    expect(identity("https://github.com/ecoma-io/release-craft/extra")).toBeNull();
    expect(identity("https://github.com/ecoma-io/release-craft/deeper/path.git")).toBeNull();
    expect(identity("git@github.com:~/release-craft.git")).toBeNull();
  });

  it("refuses the local forms — a bare path and file:// name no GitHub repository", () => {
    expect(identity("/srv/git/release-craft.git")).toBeNull();
    expect(identity("./release-craft")).toBeNull();
    expect(identity("file:///srv/git/release-craft.git")).toBeNull();
    // git's own recognition rule (urls.adoc): slashes before the first
    // colon make it a local path, even one that contains a colon.
    expect(identity("/srv/git/scratch:repo.git")).toBeNull();
  });

  it("refuses a colon form that is neither a known scheme nor a repository path", () => {
    // git would read this as ssh to the host `foo`; as an identity it
    // names no owner/repo pair on any host.
    expect(identity("foo:bar")).toBeNull();
    expect(identity("ext::vsh://x")).toBeNull();
    expect(identity("")).toBeNull();
    expect(identity("   ")).toBeNull();
    expect(identity("https://")).toBeNull();
  });

  it("names the wrong repository as the fault — the owner half first", () => {
    const fault = originIdentityFault(
      "https://github.com/fork-owner/release-craft.git",
      credentials,
    );
    expect(fault).toContain("fork-owner/release-craft");
    expect(fault).toContain("github.com/ecoma-io/release-craft");
    expect(parseRemoteIdentity("https://github.com/fork-owner/release-craft.git")).toEqual(
      github("fork-owner", "release-craft"),
    );
  });

  it("names the wrong repository as the fault — the repo half on the same owner", () => {
    expect(
      originIdentityFault("https://github.com/ecoma-io/release-craft-fork.git", credentials),
    ).toContain("ecoma-io/release-craft-fork");
  });

  it("refuses a GitHub Enterprise host even when the path matches — the host must compare", () => {
    expect(
      originIdentityFault("https://ghe.acme.example/ecoma-io/release-craft.git", credentials),
    ).toContain("ghe.acme.example/ecoma-io/release-craft");
    expect(
      originIdentityFault("git@ghe.acme.example:ecoma-io/release-craft.git", credentials),
    ).toContain("the credentials' repository");
    // GitHub's own ssh-over-443 alias is a different host spelling, and
    // the hostless credentials cannot vouch for it (the contract's
    // recorded residual): it parses — as a different identity.
    expect(identity("ssh://git@ssh.github.com:443/ecoma-io/release-craft.git")).toEqual({
      host: "ssh.github.com",
      owner: "ecoma-io",
      repo: "release-craft",
    });
  });

  it("refuses an unnameable origin loudly, never with a pass", () => {
    const fault = originIdentityFault("/srv/git/release-craft.git", credentials);
    expect(fault).toContain("/srv/git/release-craft.git");
    expect(fault).toContain("github.com/ecoma-io/release-craft");
    expect(originIdentityFault("", credentials)).toContain("<empty>");
  });

  it("reads no fault when the origin names the credentials' repository", () => {
    expect(
      originIdentityFault("https://github.com/ecoma-io/release-craft.git", credentials),
    ).toBeNull();
    expect(originIdentityFault("git@github.com:ecoma-io/release-craft", credentials)).toBeNull();
    expect(
      originIdentityFault("ssh://GitHub.com/Ecoma-IO/Release-Craft.git", credentials),
    ).toBeNull();
  });
});
