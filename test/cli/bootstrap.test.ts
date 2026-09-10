/**
 * The bootstrap door's CLI composition (issue #208): the parsed
 * invocation's pairing rules as typed state, the document read's
 * structural refusals, the write-only-after-planned law, and the
 * dry-run's nothing-written promise — the door's one effect ordered last.
 * The §6 process fixtures drive the built bin; the composition fixtures
 * stay in process because the write's bytes and the refusal's payload
 * are assertions a child process's exit code cannot carry.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { executeBootstrap } from "@ecoma-io/release-craft/__internal__/cli/bootstrap.js";
import { exitCodeFor } from "@ecoma-io/release-craft/__internal__/cli/exit-codes.js";
import { parseArgv, UsageFault } from "@ecoma-io/release-craft/__internal__/cli/parse.js";
import { readBootstrapDocument } from "@ecoma-io/release-craft/__internal__/cli/world.js";
import type { PlanningInput } from "@ecoma-io/release-craft/planner";
import type { BootstrapObservations } from "@ecoma-io/release-craft/app";
import { docBytes, memoryDoc, runCli, withTempDir } from "./harness.js";

/** The bootstrap document for the matrix world: the world's own evidence
 * halves verbatim, the operator's recorded digest, and the declared
 * lines — the smallest document the door can complete into a plannable
 * world. */
const bootstrapDoc = (world: PlanningInput): BootstrapObservations => ({
  repository: world.repository,
  history: world.history,
  policy: { digest: world.policy.digest },
  lines: world.lines,
  ...(world.components !== undefined ? { components: world.components } : {}),
});

const writeDoc = (dir: string, doc: BootstrapObservations): string => {
  const path = join(dir, "bootstrap-doc.json");
  writeFileSync(path, JSON.stringify(doc, null, 2), "utf8");
  return path;
};

describe("issue #208 — the bootstrap door proposes without writing on a dry run", () => {
  it("the dry run returns proposed, exit 0, and writes nothing", () => {
    withTempDir("bootstrap-dry", (dir) => {
      const docPath = writeDoc(dir, bootstrapDoc(memoryDoc("main")));
      const invocation = parseArgv([
        "bootstrap",
        "--assembly",
        "memory",
        "--world",
        docPath,
        "--dry-run",
      ]);
      if (invocation.command !== "bootstrap") {
        throw new Error("the grammar accepts the spelling");
      }
      const outcome = executeBootstrap(invocation);
      if (outcome.kind !== "proposed") {
        throw new Error("expected proposed");
      }
      expect(outcome.plan.kind).toBe("planned");
      expect(outcome.inferences.length).toBeGreaterThan(0);
      expect(exitCodeFor(outcome)).toBe(0);
    });
  });

  it("through the built bin, the dry run's --json envelope is the proposed row", () => {
    withTempDir("bootstrap-dry-bin", (dir) => {
      const docPath = writeDoc(dir, bootstrapDoc(memoryDoc("main")));
      const child = runCli([
        "bootstrap",
        "--assembly",
        "memory",
        "--world",
        docPath,
        "--dry-run",
        "--json",
      ]);
      expect(child.status).toBe(0);
      expect(child.stderr).toBe("");
      expect(JSON.parse(child.stdout)).toMatchObject({ kind: "proposed" });
    });
  });
});

describe("issue #208 — the bootstrap door writes only after a planned first plan", () => {
  it("the real run writes the proposed world as two-space JSON and renders bootstrapped", () => {
    withTempDir("bootstrap-write", (dir) => {
      const docPath = writeDoc(dir, bootstrapDoc(memoryDoc("main")));
      const outPath = join(dir, "world.out.json");
      const invocation = parseArgv([
        "bootstrap",
        "--assembly",
        "memory",
        "--world",
        docPath,
        "--out",
        outPath,
      ]);
      if (invocation.command !== "bootstrap") {
        throw new Error("the grammar accepts the spelling");
      }
      const outcome = executeBootstrap(invocation);
      if (outcome.kind !== "bootstrapped") {
        throw new Error("expected bootstrapped");
      }
      expect(outcome.out).toBe(outPath);
      expect(existsSync(outPath)).toBe(true);
      // The write's bytes are the proposed world's own serialization —
      // two-space JSON, one trailing newline — byte-equal to the docBytes
      // posture every world document in the suite carries.
      expect(readFileSync(outPath, "utf8")).toBe(docBytes(outcome.input));
      expect(exitCodeFor(outcome)).toBe(0);
    });
  });

  it("gapped evidence refuses with the gaps, exit 10, and nothing written", () => {
    withTempDir("bootstrap-gaps", (dir) => {
      const docPath = writeDoc(dir, {
        ...bootstrapDoc(memoryDoc("main")),
        policy: {}, // no digest recorded — the door proposes nothing
      });
      const outPath = join(dir, "never.json");
      const invocation = parseArgv([
        "bootstrap",
        "--assembly",
        "memory",
        "--world",
        docPath,
        "--out",
        outPath,
      ]);
      if (invocation.command !== "bootstrap") {
        throw new Error("the grammar accepts the spelling");
      }
      const outcome = executeBootstrap(invocation);
      expect(outcome.kind).toBe("refused");
      if (!("gaps" in outcome)) {
        throw new Error("the door's refusal carries its gaps");
      }
      expect(existsSync(outPath)).toBe(false);
      expect(exitCodeFor(outcome)).toBe(10);
    });
  });
});

describe("issue #208 — the bootstrap document's structural check", () => {
  it("a document without repository evidence is a usage fault", () => {
    expect(() => readBootstrapDocument('{"history":{"tags":[]}}')).toThrow(UsageFault);
  });

  it("a document without history evidence is a usage fault", () => {
    expect(() => readBootstrapDocument('{"repository":{"commits":[],"refs":[]}}')).toThrow(
      UsageFault,
    );
  });

  it("a declared prereleaseSeed outside 0|1 is a usage fault, before any proposal", () => {
    withTempDir("bootstrap-seed", (dir) => {
      const doc = bootstrapDoc(memoryDoc("main"));
      const docPath = writeDoc(dir, {
        ...doc,
        policy: { ...doc.policy, prereleaseSeed: "2" as never },
      });
      expect(() => readBootstrapDocument(docPath)).toThrow(UsageFault);
    });
  });

  it("an unreadable --world is the usage band, through the built bin", () => {
    const child = runCli(["bootstrap", "--assembly", "memory", "--world", "/no/such/document"]);
    expect(child.status).toBe(64);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("usage:");
  });
});
