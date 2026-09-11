/**
 * The origin shim — the `git` PATH shim behind the credentials' repository
 * URL (the Phase 9 contract §2.9; #177; D55).
 *
 * The composed adapter's open-time identity agreement reads `origin` the
 * way the sync transports it, so a fixture whose sync must land in a local
 * bare repository configures the remote under the credentials' URL and
 * points a `git` PATH shim at the local mirror: every argv delegates to
 * the real git except `ls-remote`/`push` of the mapped URL, which the shim
 * re-points with an environment `insteadOf` rule (a repository-level
 * `insteadOf` would expand under `git remote get-url origin` — the very
 * read the agreement makes — and refuse the fixture's own URL).
 *
 * The adapter's transport git freezes its child environment when the
 * github barrel is first evaluated, so the shim must sit on PATH before
 * that evaluation. This module does exactly that, as a side effect of its
 * import: a fixture imports it BEFORE the github barrel — plain ESM import
 * order, no dynamic import (one anywhere would make archkeep judge the
 * whole library lazy-loaded and forbid every static import of it).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "vitest";

/** The URL `origin` is configured under: the credentials' own repository —
 *  the identity the adapter's open-time agreement reads. */
export const ORIGIN_URL = "https://github.com/ecoma-io/release-craft.git";

const shimRoot = mkdtempSync(join(tmpdir(), "release-craft-github-origin-shim-"));
mkdirSync(shimRoot, { recursive: true });
const MAP_PATH = join(shimRoot, "map");

const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
if (realGit === "") {
  rmSync(shimRoot, { recursive: true, force: true });
  throw new Error("the fixture needs a real git to delegate to");
}

/** The shim: `ls-remote`/`push` of a mapped URL are re-pointed at the
 *  map's mirror with an environment `insteadOf` rule (the argv passes to
 *  the real git untouched); a github-shaped URL with no mapping is
 *  refused loudly — no fixture reaches the network, not even by accident. */
const shimScript = [
  "#!/bin/sh",
  `REAL="${realGit}"`,
  `MAP="${MAP_PATH}"`,
  "i=0; sub=0",
  'for a in "$@"; do',
  "  i=$((i+1))",
  '  if [ "$sub" = 0 ] && { [ "$a" = "ls-remote" ] || [ "$a" = "push" ]; }; then sub=$i; fi',
  "done",
  'if [ "$sub" != 0 ]; then',
  "  total=$#; u=$((sub+1))",
  '  if [ "$u" -le "$total" ]; then',
  "    n=0; url=''",
  '    for a in "$@"; do n=$((n+1)); if [ "$n" = "$u" ]; then url="$a"; break; fi; done',
  '    mirror=""',
  '    if [ -f "$MAP" ]; then',
  '      mirror=$(grep -F "$url" "$MAP" 2>/dev/null | head -n 1 | cut -d\' \' -f2-)',
  "    fi",
  '    if [ -n "$mirror" ]; then',
  "      base=${GIT_CONFIG_COUNT:-0}",
  "      export GIT_CONFIG_COUNT=$((base+1))",
  '      eval "export GIT_CONFIG_KEY_$base=\\"url.$mirror.insteadOf\\""',
  '      eval "export GIT_CONFIG_VALUE_$base=\\"$url\\""',
  '      exec "$REAL" "$@"',
  "    fi",
  '    case "$url" in',
  "      *://*|*github.com*)",
  '        echo "fatal: fixture: no mirror mapping for $url (the hermetic gate refuses the network)" >&2',
  "        exit 128 ;;",
  "    esac",
  "  fi",
  "fi",
  'exec "$REAL" "$@"',
  "",
].join("\n");

const shimBin = join(shimRoot, "git");
writeFileSync(shimBin, shimScript);
chmodSync(shimBin, 0o755);

const ambientPath = process.env.PATH ?? "";
process.env.PATH = `${shimRoot}:${ambientPath}`;

afterAll(() => {
  process.env.PATH = ambientPath;
  rmSync(shimRoot, { recursive: true, force: true });
});

/** Points the shim's map at one fixture's mirror (one line, rewritten per
 *  fixture — the tests of a file run sequentially). */
export const mapOriginTo = (mirror: string): void => {
  writeFileSync(MAP_PATH, `${ORIGIN_URL} ${mirror}\n`);
};
