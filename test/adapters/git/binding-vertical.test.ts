import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CANONICAL_STAGES,
  classifyResume,
  openAttempt,
  start,
  type Attribution,
  type Claim,
  type LedgerRecord,
  type ReleaseAttempt,
  type StageKey,
} from "../../../src/index.js";
import {
  type GitTagNaming,
  type TagMintResult,
  openGitBinding,
} from "@ecoma-io/release-craft/__internal__/adapters/git/index.js";
import { withTempRepo } from "./temp-repo.js";

/**
 * The vertical proof (contract §5; ADR-0009's whole point): one release
 * attempt carried through the engine's doors on the git binding — planned,
 * claimed, walked through the canonical stages with real recorded commits
 * as the side effects, tagged through the mint door at a supplied target,
 * its content identity digested by the producer — then interrupted, reloaded
 * into a fresh binding on the same repository, and resumed to completion.
 * Nothing irreversible duplicates across the interruption (the commit and
 * the tag are on disk exactly once; the resumed walk adds only the stages
 * that never ran) and the attribution is the attempt's own throughout.
 */

/** The declared tag naming for the proof: stable versions mint `v<version>`
 * on the one declared namespace root; every other scope maps outside the
 * namespaces — the proof mints a stable version. */
const naming: GitTagNaming = {
  namespaces: [""],
  tagFor: (scope) => (scope.kind === "stable-version" ? `v${scope.version}` : null),
};

const actor = (attempt: ReleaseAttempt): Attribution => ({
  attemptId: attempt.attemptId,
  actor: "automation",
});

const completion = (attempt: ReleaseAttempt, stage: StageKey): LedgerRecord => ({
  kind: "step",
  record: {
    attemptId: attempt.attemptId,
    stepKey: stage,
    from: "started",
    to: "completed",
    guards: [],
    attribution: actor(attempt),
  },
});

const readTag = (git: (args: readonly string[]) => string): string | null =>
  git(["rev-parse", "--verify", "--quiet", "refs/tags/v1.2.3"]).trim() || null;

describe("the vertical proof — one attempt through the git binding", () => {
  it("plans, claims, walks, mints, digests, interrupts, resumes — duplicating no side effect", () => {
    withTempRepo("binding-vertical", (repo, git) => {
      writeFileSync(join(repo, "content.txt"), "the release's recorded content\n");
      git(["add", "-A"]);
      git(["commit", "-m", "ecoma: the release's recorded content"]);
      const commitCount = (): number => Number(git(["rev-list", "--count", "HEAD"]).trim());

      // Plan and execute the attempt on the first binding.
      const first = openGitBinding({ repo, tagNaming: naming });
      const attempt = start(
        openAttempt(first.register, {
          planId: "plan-vertical",
          planFingerprint: "plan_sha256:vertical",
        }),
      );
      const acquired = first.claims.acquire(
        { kind: "stable-version", lineId: "lib-a", version: "1.2.3" },
        attempt.attemptId,
      );
      if (acquired.kind !== "claim") {
        throw new Error("the vertical proof requires the claim to be held");
      }
      const held: Claim = acquired;

      // Walk the canonical stages' first half for real: write-ahead starts,
      // one recorded commit per stage, completions. The tag stage mints the
      // release tag at the attempt's recorded base — the irreversible
      // effects, on disk exactly once.
      const through = CANONICAL_STAGES.slice(0, CANONICAL_STAGES.indexOf("tag") + 1);
      let tagged = "";
      let minted: TagMintResult | undefined;
      for (const stage of through) {
        first.ledger.appendStart(attempt, stage, actor(attempt));
        writeFileSync(join(repo, `${stage}.txt`), `${attempt.attemptId} ${stage}\n`);
        git(["add", "-A"]);
        git(["commit", "--allow-empty", "-m", `ecoma: ${stage}`]);
        if (stage === "commit") {
          tagged = git(["rev-parse", "HEAD"]).trim();
        }
        first.ledger.append(completion(attempt, stage));
        if (stage === "tag") {
          minted = first.mintTag({
            attemptId: attempt.attemptId,
            token: held.token,
            tag: naming.tagFor(held.scope) ?? "",
            target: tagged,
          });
        }
      }
      expect(minted).toStrictEqual({ kind: "minted", tag: "v1.2.3", target: tagged });

      // The content identity is the recorded tree, opaque and real.
      const observed = first.producer({
        attemptId: attempt.attemptId,
        artifactId: "tarball",
        kind: "npm-tarball",
        coordinates: "registry.example.com/ecoma/lib-a",
        stage: "tag",
      });
      expect(observed.digest).toBe(`git-tree:${git(["rev-parse", "HEAD^{tree}"]).trim()}`);
      expect(observed.attribution).toStrictEqual({
        attemptId: attempt.attemptId,
        actor: "automation",
      });

      // The interruption: every countable effect so far, then a fresh
      // binding on the same repository — the reload. The reloaded tail
      // classifies exactly as the live one did.
      const effectsBefore = commitCount();
      expect(readTag(git)).toBe(tagged);
      const resumedClass = classifyResume(attempt, first.ledger);

      const second = openGitBinding({ repo, tagNaming: naming });
      expect(classifyResume(attempt, second.ledger)).toStrictEqual(resumedClass);

      // The resumed half: only the stages that never ran. The tag is never
      // minted again and the walk's commits are the only new effects.
      const rest = CANONICAL_STAGES.slice(CANONICAL_STAGES.indexOf("tag") + 1);
      for (const stage of rest) {
        second.ledger.appendStart(attempt, stage, actor(attempt));
        writeFileSync(join(repo, `${stage}.txt`), `${attempt.attemptId} ${stage}\n`);
        git(["add", "-A"]);
        git(["commit", "--allow-empty", "-m", `ecoma: ${stage}`]);
        second.ledger.append(completion(attempt, stage));
      }

      // No duplicated side effect: the fixture's root, the recorded-content
      // root, then exactly one commit per stage — the tag exactly where the
      // first half left it.
      expect(commitCount()).toBe(2 + CANONICAL_STAGES.length);
      expect(commitCount() - effectsBefore).toBe(rest.length);
      expect(readTag(git)).toBe(tagged);

      // The attribution survived the interruption: the reloaded tail is the
      // one attempt's — its plan record, then write-ahead starts and
      // completions for every stage.
      const tail = second.ledger.tail(attempt.attemptId);
      expect(tail.length).toBe(CANONICAL_STAGES.length * 2 + 1);
      const steppers = tail.filter(
        (record): record is Extract<LedgerRecord, { kind: "step" }> => record.kind === "step",
      );
      expect(steppers.length).toBe(CANONICAL_STAGES.length * 2);
      for (const record of steppers) {
        expect(record.record.attribution.attemptId).toBe(attempt.attemptId);
      }
    });
  });
});
