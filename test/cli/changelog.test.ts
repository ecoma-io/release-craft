/**
 * The `--changelog` seam (issue #381): the CLI's changelog declaration is
 * answered by a producer whose digest holds the run's own planned
 * changelog's exact rendered bytes — the release body's read resolves the
 * rendered change set, never a committed header template. The test runs
 * the harness CLI child over a seeded repository, then re-opens the
 * binding and replays publication's own recorded-changelog projection
 * (claims → completed step record → digest → file) against the changelog
 * the direct side's plan renders. Under the pre-fix wiring the same
 * projection resolves nothing — the identity producer's tree holds no
 * `CHANGELOG.md` — so the byte equality below is the regression itself,
 * and the completed record's context seal (issue #294) pins the same
 * bytes independent of the tree.
 */

import { describe, expect, it } from "vitest";

import type { LedgerRecord, TransitionRecord } from "../../src/index.js";
import { contentSha256 } from "@ecoma-io/release-craft/execution";
import {
  claimRegisterRefFor,
  openGitBinding,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import { declaredTagNaming } from "@ecoma-io/release-craft/__internal__/cli/naming.js";
import { changelogOf, renderChangelog } from "@ecoma-io/release-craft/planner";
import {
  cliJson,
  directPlan,
  docBytes,
  gitDoc,
  gitSelection,
  runCli,
  withSeededRepo,
} from "./harness.js";

/** The git run's argv for the main line with the changelog declaration —
 * the surface suite's own argv plus `--changelog`. */
const changelogRunArgs = (repo: string, namespace = ""): string[] => [
  "run",
  "--assembly",
  "git",
  "--repo",
  repo,
  "--tag-namespace",
  namespace,
  "--world",
  "-",
  "--actor",
  "automation",
  "--line",
  "main",
  "--changelog",
  "--json",
];

/** The test's own narrowing: asserts the value exists and returns it, so
 * the recorded-shape reads need no non-null assertions. */
const present = <T>(value: T | null | undefined, message: string): T => {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
};

/** The completed changelog step record on the attempt that minted `tag` —
 * the exact projection publication.ts replays (§3.4). */
const completedChangelogRecord = (
  binding: ReturnType<typeof openGitBinding>,
  lineId: string,
  tag: string,
): { readonly record: TransitionRecord; readonly bytes: string } => {
  const claims = binding.content.claims(claimRegisterRefFor(lineId));
  const claim = present(
    claims.find((candidate) => binding.content.tagFor(candidate.scope) === tag),
    "the run's claim register holds the minting attempt",
  );
  const records = binding.content.tail(claim.holder);
  const completed = present(
    records
      .filter(
        (entry): entry is Extract<LedgerRecord, { readonly kind: "step" }> => entry.kind === "step",
      )
      .map((entry) => entry.record)
      .find((record) => record.stepKey === "artifact:changelog" && record.to === "completed"),
    "the attempt recorded the completed changelog step",
  );
  const digest = present(
    completed.contentFingerprint ?? completed.artifact?.digest,
    "the completed changelog record carries the content fingerprint",
  );
  const bytes = present(
    binding.content.file(digest, "CHANGELOG.md"),
    "the digest resolves the changelog bytes",
  );
  return { record: completed, bytes };
};

describe("the --changelog declaration over the git assembly", () => {
  it(
    "records the run's own planned changelog bytes, not a committed header",
    { timeout: 45_000 },
    () => {
      withSeededRepo("cli-changelog", (repo, _git, heads) => {
        const doc = gitDoc("main", [], heads);
        const docText = docBytes(doc);

        const result = runCli([...changelogRunArgs(repo), "--changelog"], { input: docText });
        expect(result.status).toBe(0);
        const outcome = cliJson(result) as { readonly kind: string; readonly tag: string };
        expect(outcome.kind).toBe("published");
        // The direct side's own plan over the same document — the
        // changelog the run itself planned and walked.
        const planning = directPlan(gitSelection(repo), docText);
        expect(planning.kind).toBe("planned");
        if (planning.kind !== "planned") return;
        const planLine = present(
          planning.plan.lines.find((candidate) => candidate.lineId === "main"),
          "the world's main line plans a release",
        );
        const expected = renderChangelog(changelogOf([planLine]));

        const binding = openGitBinding({
          repo,
          tagNaming: declaredTagNaming([""], doc.policy.tagFormats),
        });
        const { record, bytes } = completedChangelogRecord(binding, "main", outcome.tag);
        // The release body reads the rendered change set, exactly —
        // never the committed header template (issue #381).
        expect(bytes).toBe(expected);
        // The byte-level witness (issue #294) seals the same bytes.
        expect(record.contentSha256).toBe(contentSha256(expected));
        expect(record.contentFingerprint).toMatch(/^git-tree:[0-9a-f]{40}$/);
      });
    },
  );
});
