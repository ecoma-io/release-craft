/**
 * The binding's commit door (issue #339; phase 11 §2.5's new
 * mint-preceding door): the mutation-carrying release commit — the most
 * specific commit that still has the repository as its subject. The door
 * mints the commit from the assembly's supplied files overlaid on the
 * recorded base tree — never ambient HEAD, never the working tree (issue
 * #339's class 1): `git ls-tree -r` reads the base tree's entries, each
 * supplied file's bytes go through `git hash-object -w`, and the whole
 * tree (kept base entries plus the overlaid files) is rebuilt recursively
 * through `git mktree`. The commit is the base-parented `commit-tree` at
 * the rebuilt tree with the runner's fixed identity and clock (COMMIT_ENV,
 * baked into every spawn) — so same base, same files, same message: same
 * oid. A resumed completion re-commits idempotently; the tag door's CAS
 * then re-mints at the same oid. No ref moves: the commit lands as an
 * object, and the tag ref the plan mints is the only ref the run creates
 * (issue #339 class 2 — the commit exists before the tag can point at
 * it).
 *
 * The namespace door does not run here (§2.4): tags belong to the mint
 * door — the commit message names the plan's own tag, which the caller
 * derived from the held claim, and the door reproduces it verbatim onto
 * the message. Refusals are returned values, never exceptions; nothing a
 * door refused left state behind.
 */

import { canonicalJson } from "@ecoma-io/release-craft/planner";

import type { GitTagNaming, ReleaseCommitInput, ReleaseCommitOutcome } from "./binding-types.js";
import { allRegisterRecords, type ClaimRecord } from "./claim-store-git.js";
import { GitFaultError, type GitRun } from "./git-run.js";
import { writeBlob } from "./git-refs.js";

/** The function an opened door hands the assembly: input in, returned
 * outcome out. */
export type ReleaseCommit = (input: ReleaseCommitInput) => ReleaseCommitOutcome;

/** The empty tree's canonical oid — `git mktree` refuses empty input, so
 * the door emits git's well-known constant instead. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Opens the commit door on the binding's runner and the configuration's
 * declared naming. The door reads only the claim refs the claim store owns
 * — no working tree, no ambient state, no registry (ADR-0009 decisions 5
 * and 7). The base is a supplied value, the attempt's recorded target;
 * the files are supplied values, the assembly's recorded updater
 * completions.
 */
export function GitCommitDoor(git: GitRun, naming: GitTagNaming): ReleaseCommit {
  return (input: ReleaseCommitInput): ReleaseCommitOutcome => {
    // Fail closed: a commit is admitted only under a claim the calling
    // attempt holds and whose derived name is the plan's tag — the same
    // held-claim lookup as the mint door's (ADR-0011 decision 3's named
    // exception to the read narrowing). A mint for the plan's tag later
    // runs against the same claim, so this gate is what lets the commit
    // and the tag land on the same claim's name (issue #339 class 2).
    const walk = allRegisterRecords(git);
    const passedBy = new Map(
      walk.supersessions.map((entry) => [
        canonicalJson(entry.superseded.scope),
        entry.supersededBy.holder,
      ]),
    );
    const isHeldBy = (record: ClaimRecord): boolean => record.holder === input.attemptId;
    const held = walk.claims.filter(
      (record) => isHeldBy(record) && !passedBy.has(canonicalJson(record.scope)),
    );
    const match = held.find((record) => naming.tagFor(record.scope) === input.tag);
    if (match === undefined) {
      return {
        kind: "refused",
        reason: "unclaimed",
        detail:
          `no claim held by attempt ${input.attemptId} derives tag ${input.tag} under the ` +
          `binding's declared tag naming — the commit door refuses a commit it names no ` +
          `claim for (issue #339)`,
      };
    }
    if (match.token !== input.token) {
      return {
        kind: "refused",
        reason: "foreign-token",
        detail:
          `the claim deriving tag ${input.tag} is held under a different token — the ` +
          `commit door refuses a foreign attempt's commit (issue #339)`,
      };
    }
    // The base is canonicalized once, before any object is written: the
    // supplied target resolves to the recorded commit's oid — the same
    // quiet verification the tag door keys absence on (D39). A base the
    // declared world does not hold is the door's declared lie: the door
    // raises its own GitFaultError naming the base, never a returned
    // refusal (phase 12 §2.4's posture, exit 70 at the surface).
    let resolved: string | null;
    try {
      resolved = git(["rev-parse", "--verify", "--quiet", `${input.base}^{commit}`]).trim();
    } catch (error) {
      if (error instanceof GitFaultError && error.status === 1 && error.stderr === "") {
        resolved = null;
      } else {
        throw error;
      }
    }
    if (resolved === null || resolved === "") {
      throw new GitFaultError(
        ["rev-parse", "--verify", `${input.base}^{commit}`],
        null,
        `the commit base ${input.base} does not resolve to a commit`,
      );
    }
    const message = `release-craft: release ${input.tag} for ${input.lineId} (${input.planId})`;
    // The supplied files, in stable order: bytes to blobs first (no tree
    // moves yet), then the tree overlay below reconstructs the commit.
    const fileBlobs = Object.entries(input.files)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, bytes]) => ({ path, oid: writeBlob(git, bytes) }));
    // The kept entries: the base tree's recursive listing, minus the paths
    // the supplied files overwrite (issue #339 class 1 — nothing ambient,
    // nothing else, enters the committed tree). Each listing row is
    // `<mode> <type> <oid>\t<path>`; subtree rows (`type tree`) are
    // skipped — the rebuild recurses from the flat entries alone. The `-z`
    // spelling keeps every path raw (the default quoting would C-quote
    // paths with special bytes, and a quoted path must never reach the
    // overlay comparison).
    const listing = git(["ls-tree", "-r", "-z", resolved]);
    const overlaid = new Set(fileBlobs.map(({ path }) => path));
    const kept: Array<{ readonly path: string; readonly oid: string }> = [];
    for (const line of listing.split("\0")) {
      if (line.length === 0) {
        continue;
      }
      const tab = line.indexOf("\t");
      const [, type, oid] = line.slice(0, tab).split(" ");
      if (type === "tree" || type === "commit") {
        continue;
      }
      const path = line.slice(tab + 1);
      if (!overlaid.has(path)) {
        kept.push({ path, oid: oid ?? "" });
      }
    }
    // One flat path → blob map over kept and overlaid files alike; the
    // tree builder recurses it into git's directory ordering (a directory
    // sorts as though it had a trailing slash — `git mktree`'s own
    // ordering, so the built tree round-trips `ls-tree -r` byte-equal).
    const flat = new Map<string, string>();
    for (const { path, oid } of [...kept, ...fileBlobs]) {
      flat.set(path, oid);
    }
    const buildTree = (paths: Map<string, string>): string => {
      const dirs = new Map<string, Map<string, string>>();
      const files: Array<{ readonly name: string; readonly oid: string }> = [];
      for (const [path, oid] of paths) {
        const slash = path.indexOf("/");
        if (slash < 0) {
          files.push({ name: path, oid });
          continue;
        }
        const head = path.slice(0, slash);
        const tail = path.slice(slash + 1);
        let child = dirs.get(head);
        if (child === undefined) {
          child = new Map();
          dirs.set(head, child);
        }
        child.set(tail, oid);
      }
      const rows: Array<
        | { readonly kind: "file"; readonly name: string; readonly payload: string }
        | { readonly kind: "dir"; readonly name: string; readonly payload: string }
      > = [];
      for (const { name, oid } of files) {
        rows.push({ kind: "file", name, payload: `100644 blob ${oid}\t${name}` });
      }
      for (const [name, child] of dirs) {
        const subtree = buildTree(child);
        rows.push({ kind: "dir", name, payload: `040000 tree ${subtree}\t${name}` });
      }
      rows.sort((a, b) => {
        const aKey = a.kind === "dir" ? `${a.name}/` : a.name;
        const bKey = b.kind === "dir" ? `${b.name}/` : b.name;
        return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
      });
      const lines = rows.map((row) => row.payload);
      if (lines.length === 0) {
        return EMPTY_TREE;
      }
      return git(["mktree"], `${lines.join("\n")}\n`).trim();
    };
    const tree = buildTree(flat);
    // The commit: deterministic (COMMIT_ENV baked into every spawn at the
    // runner), parented on the recorded base, messaged with the plan's own
    // tag. No ref moves and no CAS — the oid is content-addressed, so the
    // same inputs re-derive the same oid: the resume idempotency.
    const oid = git(["commit-tree", tree, "-p", resolved, "-m", message]).trim();
    return { kind: "committed", oid };
  };
}
