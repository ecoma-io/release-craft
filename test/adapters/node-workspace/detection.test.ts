/**
 * End-to-end tests for the detectNodeWorkspace + toComponentMeta seam:
 * pnpm-workspace.yaml / package.json evidence discovery, manifest reading,
 * edge extraction, D16-grammar refusal, and the integration into the
 * planner's propagation door. The adapter refuses loudly rather than
 * silently guessing, matching §2.1's loud-refusal rule.
 */
import { describe, expect, it } from "vitest";
import { symlinkSync } from "node:fs";
import { join } from "node:path";

import {
  detectNodeWorkspace,
  toComponentMeta,
} from "@ecoma-io/release-craft/__internal__/adapters/node-workspace/index.js";
import {
  WorkspaceDetectionError,
  type DetectedWorkspace,
  type WorkspaceDependencyKind,
} from "@ecoma-io/release-craft/__internal__/adapters/node-workspace/types.js";
import { planPropagation } from "@ecoma-io/release-craft/__internal__/planner/propagate.js";
import { Version } from "@ecoma-io/release-craft/domain";

import type { TempWorkspace } from "./temp-workspace.js";
import { withTempWorkspace } from "./temp-workspace.js";

// ---------------------------------------------------------------------------
// Fixture helpers (lockstep: consistent package.json / pnpm layout)
// ---------------------------------------------------------------------------

/** Writes a pnpm-workspace.yaml declaring `packages/*` as the sole glob. */
function addPnpmEvidence(ws: TempWorkspace): void {
  ws.write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
}

/** Writes one member package.json.  The optional `extra` object is merged
 * into the root (dependencies, devDependencies, etc.). */
function addPackage(
  ws: TempWorkspace,
  relDir: string,
  name: string,
  version: string,
  extra?: Record<string, unknown>,
): void {
  ws.write(`${relDir}/package.json`, JSON.stringify({ name, version, ...extra }));
}

/** Runs `fn`, returning whatever it threw (or `undefined`). */
function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Asserts the detection result is non-null and returns the narrowed value
 * so later member reads type-check without non-null assertions. */
function expectDetected(value: DetectedWorkspace | null): DetectedWorkspace {
  expect(value).not.toBeNull();
  return value as DetectedWorkspace;
}

/** Builds a release decision in the planner's own shape. */
function release(component: string, version: string) {
  return { component, version: Version.parse(version) };
}

// ---------------------------------------------------------------------------
// Evidence sources: pnpm / npm / yarn
// ---------------------------------------------------------------------------

describe("detectNodeWorkspace — pnpm evidence", () => {
  it("declares two members and extracts an intra-workspace dependency edge", () => {
    withTempWorkspace("pnpm-e2e", (ws) => {
      addPnpmEvidence(ws);
      addPackage(ws, "packages/a", "a", "1.0.0", {
        dependencies: { b: "^1.2.3" },
      });
      addPackage(ws, "packages/b", "b", "1.0.0");

      const detected = expectDetected(detectNodeWorkspace(ws.root));

      expect(detected.members.map((m) => m.name)).toEqual(["a", "b"]);

      const memberA = detected.members.find((m) => m.name === "a");
      expect(memberA).toBeDefined();
      if (memberA === undefined) return;
      expect(memberA.dir).toBe("packages/a");
      expect(memberA.manifestPath).toBe("packages/a/package.json");
      expect(memberA.edges).toEqual([
        {
          target: "b",
          range: "^1.2.3",
          kind: "dependencies",
          declaredIn: { file: `${ws.root}/packages/a/package.json` },
        },
      ]);

      const memberB = detected.members.find((m) => m.name === "b");
      expect(memberB).toBeDefined();
      if (memberB === undefined) return;
      expect(memberB.dir).toBe("packages/b");
      expect(memberB.edges).toEqual([]);
    });
  });

  it("honours other top-level pnpm keys without breaking the parser", () => {
    withTempWorkspace("pnpm-other-keys", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages:\n  - packages/*\ncatalog:\n  typescript: 5.5.0\n");
      addPackage(ws, "packages/core", "core", "1.0.0");
      const detected = expectDetected(detectNodeWorkspace(ws.root));
      expect(detected.members.map((m) => m.name)).toEqual(["core"]);
    });
  });
});

describe("detectNodeWorkspace — npm array evidence", () => {
  it("reads the package.json workspaces array form", () => {
    withTempWorkspace("npm-array", (ws) => {
      ws.write("package.json", JSON.stringify({ workspaces: ["packages/*"] }));
      addPackage(ws, "packages/core", "core", "2.0.0");
      const detected = expectDetected(detectNodeWorkspace(ws.root));
      expect(detected.members.map((m) => m.name)).toEqual(["core"]);
      expect(detected.members[0]?.dir).toBe("packages/core");
    });
  });
});

describe("detectNodeWorkspace — yarn {packages} evidence", () => {
  it("reads the package.json workspaces.packages object form", () => {
    withTempWorkspace("yarn-obj", (ws) => {
      ws.write("package.json", JSON.stringify({ workspaces: { packages: ["packages/*"] } }));
      addPackage(ws, "packages/ui", "ui", "1.0.0");
      const detected = expectDetected(detectNodeWorkspace(ws.root));
      expect(detected.members.map((m) => m.name)).toEqual(["ui"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Null on no evidence
// ---------------------------------------------------------------------------

describe("detectNodeWorkspace — no evidence returns null", () => {
  it("empty directory", () => {
    withTempWorkspace("empty", (ws) => {
      expect(detectNodeWorkspace(ws.root)).toBeNull();
    });
  });

  it("root package.json with no workspaces field", () => {
    withTempWorkspace("no-workspaces", (ws) => {
      ws.write("package.json", JSON.stringify({ name: "root", version: "1.0.0" }));
      expect(detectNodeWorkspace(ws.root)).toBeNull();
    });
  });

  it("pnpm-workspace.yaml without `packages` + no npm workspaces", () => {
    withTempWorkspace("pnpm-nopkg", (ws) => {
      ws.write("pnpm-workspace.yaml", "catalog:\n  typescript: 5.5.0\n");
      expect(detectNodeWorkspace(ws.root)).toBeNull();
    });
  });

  it("pnpm settings-only + npm workspaces present → npm evidence wins", () => {
    withTempWorkspace("pnpm-fall-npm", (ws) => {
      ws.write("pnpm-workspace.yaml", "catalog:\n  typescript: 5.5.0\n");
      ws.write("package.json", JSON.stringify({ workspaces: ["packages/*"] }));
      addPackage(ws, "packages/lib", "lib", "1.0.0");
      const detected = expectDetected(detectNodeWorkspace(ws.root));
      expect(detected.members.map((m) => m.name)).toEqual(["lib"]);
    });
  });

  it("wrong root: a subdirectory is provided", () => {
    withTempWorkspace("wrong-root", (ws) => {
      addPnpmEvidence(ws);
      addPackage(ws, "packages/a", "a", "1.0.0");
      expect(detectNodeWorkspace(join(ws.root, "packages", "a"))).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// External deps: not graph edges
// ---------------------------------------------------------------------------

describe("detectNodeWorkspace — external dependency omission", () => {
  it("does not emit an edge for a non-workspace package", () => {
    withTempWorkspace("external", (ws) => {
      addPnpmEvidence(ws);
      addPackage(ws, "packages/app", "app", "1.0.0", {
        dependencies: { express: "^4.21.0" },
      });
      const detected = expectDetected(detectNodeWorkspace(ws.root));
      expect(detected.members[0]?.edges).toEqual([]);
    });
  });

  // The org's real external spec forms (#286): the audited manifests'
  // shapes — a pnpm catalog reference, an npm alias, archkeep's bare
  // `>=21`-style peer range and the ecosystem's lone `~4.13.0` — ride
  // through detection untouched. None of the names is a member or the
  // root's name, so none is an edge, none refuses, and the conversion
  // carries no dependency for the member.
  it.each([
    ["react", "catalog:"],
    ["pkg", "npm:pkg@^1"],
    ["node", ">=21"],
    ["some-lib", "~4.13.0"],
  ])(
    "detects a member declaring the external peer %s: %s with zero edges and no refusal",
    (externalName, spec) => {
      withTempWorkspace("external-shape", (ws) => {
        addPnpmEvidence(ws);
        addPackage(ws, "packages/app", "app", "1.0.0", {
          peerDependencies: { [externalName]: spec },
        });
        addPackage(ws, "packages/lib", "lib", "1.0.0");

        const detected = expectDetected(detectNodeWorkspace(ws.root));
        expect(detected.members.map((m) => m.name)).toEqual(["app", "lib"]);
        const app = detected.members.find((m) => m.name === "app");
        expect(app).toBeDefined();
        if (app === undefined) return;
        expect(app.edges).toEqual([]);

        const plan = toComponentMeta(detected);
        const appPlan = plan.find((c) => c.name === "app");
        expect(appPlan).toBeDefined();
        expect(appPlan?.dependencies).toBeUndefined();
      });
    },
  );
});

// ---------------------------------------------------------------------------
// The root package's name as a dependency target (#285): the root manifest's
// `name` never enters the member-name map, so before the fix a member
// declaring it fell through the external-skip branch — no refusal, no edge,
// a real intra-workspace dependency silently classified external. The real
// shape is loom: the publishable root package "@ecoma-io/loom" is declared
// by templates/* as "workspace:*". The refusal must name the manifest file,
// the field, and the dependency name.
// ---------------------------------------------------------------------------

describe("detectNodeWorkspace — root package name as dependency target", () => {
  const ROOT_NAME = "@acme/loom";

  /** A loom-shaped workspace: publishable root package plus template
   * members under `templates/*`, mirroring the real occurrence. */
  function addLoomShapedWorkspace(ws: TempWorkspace, memberDeps: Record<string, unknown>): void {
    ws.write("pnpm-workspace.yaml", "packages:\n  - templates/*\n");
    ws.write("package.json", JSON.stringify({ name: ROOT_NAME, version: "0.5.0" }));
    addPackage(ws, "templates/analytics", "@acme/loom-analytics", "0.5.0", memberDeps);
  }

  it.each(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])(
    "refuses a %s dependency on the root package's name, naming file, field and dependency",
    (kind) => {
      withTempWorkspace(`root-target-${kind}`, (ws) => {
        addLoomShapedWorkspace(ws, { [kind]: { [ROOT_NAME]: "workspace:*" } });
        const error = capture(() => detectNodeWorkspace(ws.root));
        expect(error).toBeInstanceOf(WorkspaceDetectionError);
        const refusal = error as WorkspaceDetectionError;
        expect(refusal.file).toBe(`${ws.root}/templates/analytics/package.json`);
        expect(refusal.field).toBe(`${kind}.${ROOT_NAME}`);
        expect(refusal.message).toContain(ROOT_NAME);
        expect(refusal.message).toContain("workspace root package");
      });
    },
  );

  it("refuses a root-named dependency even when its range is inside the D16 grammar", () => {
    withTempWorkspace("root-target-canonical-range", (ws) => {
      addLoomShapedWorkspace(ws, { dependencies: { [ROOT_NAME]: "^0.5.0" } });
      const error = capture(() => detectNodeWorkspace(ws.root));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      const refusal = error as WorkspaceDetectionError;
      expect(refusal.field).toBe(`dependencies.${ROOT_NAME}`);
      expect(refusal.message).toContain("workspace root package");
    });
  });

  it("the sibling-member contrast still refuses through the D16 grammar path", () => {
    withTempWorkspace("root-target-sibling-contrast", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages:\n  - templates/*\n");
      ws.write("package.json", JSON.stringify({ name: ROOT_NAME, version: "0.5.0" }));
      addPackage(ws, "templates/starter", "@acme/loom-starter", "0.5.0");
      addPackage(ws, "templates/analytics", "@acme/loom-analytics", "0.5.0", {
        dependencies: { "@acme/loom-starter": "workspace:*" },
      });
      const error = capture(() => detectNodeWorkspace(ws.root));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      const refusal = error as WorkspaceDetectionError;
      expect(refusal.file).toBe(`${ws.root}/templates/analytics/package.json`);
      expect(refusal.field).toBe("dependencies.@acme/loom-starter");
      expect(refusal.message).toContain("D16 grammar");
    });
  });

  it("positive control: an external name with a D16 range still skips cleanly beside a named root", () => {
    withTempWorkspace("root-target-external-control", (ws) => {
      addLoomShapedWorkspace(ws, { dependencies: { express: "^4.21.0" } });
      const detected = expectDetected(detectNodeWorkspace(ws.root));
      // The root package is not a member, and the external dependency is
      // skipped without an edge or a refusal.
      expect(detected.members.map((m) => m.name)).toEqual(["@acme/loom-analytics"]);
      expect(detected.members[0]?.edges).toEqual([]);
    });
  });

  it("when the root is itself a member (the `.` glob), a dependency on the root's name stays a member edge", () => {
    withTempWorkspace("root-target-root-as-member", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages:\n  - .\n  - packages/*\n");
      ws.write("package.json", JSON.stringify({ name: "root", version: "0.0.0" }));
      addPackage(ws, "packages/app", "app", "1.0.0", {
        dependencies: { root: "^0.0.0" },
      });
      const detected = expectDetected(detectNodeWorkspace(ws.root));
      expect(detected.members.map((m) => m.name)).toEqual(["root", "app"]);
      const app = detected.members.find((m) => m.name === "app");
      expect(app?.edges).toEqual([
        {
          target: "root",
          range: "^0.0.0",
          kind: "dependencies",
          declaredIn: { file: `${ws.root}/packages/app/package.json` },
        },
      ]);
    });
  });

  it("refuses a root manifest that cannot be parsed even when the pnpm evidence alone would have sufficed at main", () => {
    withTempWorkspace("root-manifest-unreadable", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages:\n  - templates/*\n");
      // Valid evidence, truncated root manifest: reading the root's `name`
      // widens detection's failure surface by exactly this case — pinned.
      ws.write("package.json", '{"name":"@acme/root","version":');
      addPackage(ws, "templates/analytics", "@acme/loom-analytics", "0.5.0");
      const error = capture(() => detectNodeWorkspace(ws.root));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      const refusal = error as WorkspaceDetectionError;
      expect(refusal.file).toBe(`${ws.root}/package.json`);
      expect(refusal.field).toBe("(file)");
      expect(refusal.message).toContain("cannot read manifest");
    });
  });
});

// ---------------------------------------------------------------------------
// Edge kinds: dev-only excluded from ComponentMeta; peer/optional propagate
// ---------------------------------------------------------------------------

describe("detectNodeWorkspace — edge kinds", () => {
  it("devDependencies appear in raw member.edges but are filtered by toComponentMeta", () => {
    withTempWorkspace("dev-exclude", (ws) => {
      addPnpmEvidence(ws);
      addPackage(ws, "packages/lib", "lib", "1.0.0");
      addPackage(ws, "packages/app", "app", "1.0.0", {
        devDependencies: { lib: "^1.0.0" },
      });

      const detected = expectDetected(detectNodeWorkspace(ws.root));

      // Raw edges carry the dev kind.
      const app = detected.members.find((m) => m.name === "app");
      expect(app).toBeDefined();
      if (app === undefined) return;
      expect(app.edges).toEqual([
        {
          target: "lib",
          range: "^1.0.0",
          kind: "devDependencies",
          declaredIn: { file: `${ws.root}/packages/app/package.json` },
        },
      ]);

      // But toComponentMeta omits dev-only edges — a member with no
      // propagating edges carries no `dependencies` field at all.
      const plan = toComponentMeta(detected);
      const appPlan = plan.find((c) => c.name === "app");
      expect(appPlan).toBeDefined();
      expect(appPlan?.dependencies).toBeUndefined();
    });
  });

  it("peerDependencies propagate as ComponentMeta dependencies", () => {
    withTempWorkspace("peer-include", (ws) => {
      addPnpmEvidence(ws);
      addPackage(ws, "packages/ui", "ui", "1.0.0");
      addPackage(ws, "packages/app", "app", "1.0.0", {
        peerDependencies: { ui: "^1.0.0" },
      });

      const detected = expectDetected(detectNodeWorkspace(ws.root));
      const plan = toComponentMeta(detected);
      const appPlan = plan.find((c) => c.name === "app");
      expect(appPlan?.dependencies).toEqual([{ name: "ui", range: "^1.0.0" }]);
    });
  });

  it("optionalDependencies propagate as ComponentMeta dependencies", () => {
    withTempWorkspace("optional-include", (ws) => {
      addPnpmEvidence(ws);
      addPackage(ws, "packages/poly", "poly", "1.0.0");
      addPackage(ws, "packages/app", "app", "1.0.0", {
        optionalDependencies: { poly: "~1.0.0" },
      });

      const detected = expectDetected(detectNodeWorkspace(ws.root));
      const plan = toComponentMeta(detected);
      const appPlan = plan.find((c) => c.name === "app");
      expect(appPlan?.dependencies).toEqual([{ name: "poly", range: "~1.0.0" }]);
    });
  });
});

// ---------------------------------------------------------------------------
// D16 grammar: unknown range forms are loud refusals
// ---------------------------------------------------------------------------

describe("detectNodeWorkspace — D16 grammar refusal", () => {
  it.each([["workspace:*"], [">=1.0.0"], ["*"]])("refuses unsupported range %s", (range) => {
    withTempWorkspace("refuse-range", (ws) => {
      addPnpmEvidence(ws);
      addPackage(ws, "packages/lib", "lib", "1.0.0");
      addPackage(ws, "packages/app", "app", "1.0.0", {
        dependencies: { lib: range },
      });
      const error = capture(() => detectNodeWorkspace(ws.root));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      const refusal = error as WorkspaceDetectionError;
      expect(refusal.field).toBe("dependencies.lib");
      expect(refusal.message).toContain(range);
    });
  });
});

// ---------------------------------------------------------------------------
// Member-target grammar refusals across ALL FOUR dependency fields (#286):
// the declared-unsupported posture needs proof breadth, and the ecosystem's
// real intra-workspace form is `workspace:*` — declared in every field in
// the audited org, most often devDependencies — while the refused literals
// the module docstring names (`latest`, the `workspace:`-prefixed range
// forms) had no test literal at all. The describe above keeps the
// dependencies-field trio it already pinned (`workspace:*`, `>=1.0.0`,
// bare `*`); this matrix covers the remaining cells: every field times
// every docstring-named literal, plus bare `*` in the three fields that
// lacked it. The root-named four-field refusals are a different branch
// (the #285 slice) and are pinned separately above.
// ---------------------------------------------------------------------------

const MEMBER_TARGET_FIELDS: readonly WorkspaceDependencyKind[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const DOCSTRING_REFUSED_LITERALS: readonly string[] = [
  "workspace:*",
  "latest",
  "workspace:^1.0.0",
  "workspace:~1.0.0",
  "workspace:>=1.0.0",
];

describe("detectNodeWorkspace — member-target grammar refusals across all four fields (#286)", () => {
  const refusalCases: readonly (readonly [WorkspaceDependencyKind, string])[] = [
    ...MEMBER_TARGET_FIELDS.flatMap((kind) =>
      DOCSTRING_REFUSED_LITERALS.map((range) => [kind, range] as const),
    ),
    ...MEMBER_TARGET_FIELDS.filter((kind) => kind !== "dependencies").map(
      (kind) => [kind, "*"] as const,
    ),
  ];

  it.each(refusalCases)(
    "refuses a member-target %s dependency carrying the range %s, naming the declaring file and field",
    (kind, range) => {
      withTempWorkspace("refuse-member-target", (ws) => {
        addPnpmEvidence(ws);
        addPackage(ws, "packages/lib", "lib", "1.0.0");
        addPackage(ws, "packages/app", "app", "1.0.0", {
          [kind]: { lib: range },
        });
        const error = capture(() => detectNodeWorkspace(ws.root));
        expect(error).toBeInstanceOf(WorkspaceDetectionError);
        const refusal = error as WorkspaceDetectionError;
        expect(refusal.file).toBe(`${ws.root}/packages/app/package.json`);
        expect(refusal.field).toBe(`${kind}.lib`);
        expect(refusal.message).toContain(range);
        expect(refusal.message).toContain("D16 grammar");
      });
    },
  );
});

// ---------------------------------------------------------------------------
// D16 grammar: non-canonical SemVer strings refuse AT DETECTION, naming the
// declaring manifest file and field — the kernel's strict grammar
// (core/domain/version.ts, decision-log D16) is the authority, so
// leading-zero cores, leading-zero numeric prerelease identifiers, empty
// prerelease identifiers and out-of-bound cores never drift downstream to
// planPropagation's bare range error.
// ---------------------------------------------------------------------------

describe("detectNodeWorkspace — D16 grammar: non-canonical SemVer", () => {
  it.each([
    ["^01.2.3"], // leading-zero core
    ["1.2.3-01"], // leading-zero numeric prerelease identifier
    ["~1.2.3-rc."], // empty prerelease identifier
    ["^9007199254740993.0.0"], // core beyond the safe-integer bound
  ])("refuses %s naming the declaring file and field", (range) => {
    withTempWorkspace("refuse-noncanonical", (ws) => {
      addPnpmEvidence(ws);
      addPackage(ws, "packages/lib", "lib", "1.0.0");
      addPackage(ws, "packages/app", "app", "1.0.0", {
        dependencies: { lib: range },
      });
      const error = capture(() => detectNodeWorkspace(ws.root));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      const refusal = error as WorkspaceDetectionError;
      expect(refusal.file).toBe(`${ws.root}/packages/app/package.json`);
      expect(refusal.field).toBe("dependencies.lib");
      expect(refusal.message).toContain(range);
    });
  });

  it.each([["^1.2.3"], ["~0.4.1"], ["1.2.3-rc.1"], ["1.2.3+build.7"]])(
    "accepts the canonical range %s",
    (range) => {
      withTempWorkspace("accept-canonical", (ws) => {
        addPnpmEvidence(ws);
        addPackage(ws, "packages/lib", "lib", "1.0.0");
        addPackage(ws, "packages/app", "app", "1.0.0", {
          dependencies: { lib: range },
        });
        const detected = expectDetected(detectNodeWorkspace(ws.root));
        const app = detected.members.find((m) => m.name === "app");
        expect(app?.edges).toEqual([
          {
            target: "lib",
            range,
            kind: "dependencies",
            declaredIn: { file: `${ws.root}/packages/app/package.json` },
          },
        ]);
      });
    },
  );
});

// ---------------------------------------------------------------------------
// Symlink posture: the resolved path, not the entry name, decides what the
// walker enters — a hoisted tree behind a differently-named alias, a cycle
// enumerating phantom member paths, and a legitimate symlinked member.
// ---------------------------------------------------------------------------

describe("detectNodeWorkspace — symlink posture", () => {
  it("does not ingest a differently-named symlink into node_modules", () => {
    withTempWorkspace("symlink-nm", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages:\n  - **\n");
      addPackage(ws, "node_modules/hoisted", "hoisted", "1.0.0");
      addPackage(ws, "packages/app", "app", "1.0.0");
      // `vendor` is an alias into node_modules: the entry name cannot reveal
      // it, so the exclusion must judge the resolved path.
      symlinkSync(join(ws.root, "node_modules"), join(ws.root, "packages", "vendor"));
      const detected = expectDetected(detectNodeWorkspace(ws.root));
      expect(detected.members.map((m) => m.name)).toEqual(["app"]);
    });
  });

  it("a symlink cycle yields each real member once — no phantom duplicate refusal", () => {
    withTempWorkspace("symlink-cycle", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages:\n  - packages/**\n");
      addPackage(ws, "packages/a", "a", "1.0.0");
      // `packages/loop` points back at `packages`: following it enumerates
      // packages/loop/loop/…/a/package.json until the kernel gives up.
      symlinkSync(join(ws.root, "packages"), join(ws.root, "packages", "loop"));
      const detected = expectDetected(detectNodeWorkspace(ws.root));
      expect(detected.members).toHaveLength(1);
      expect(detected.members[0]?.name).toBe("a");
      expect(detected.members[0]?.manifestPath).toBe("packages/a/package.json");
    });
  });

  it("detects a legitimately symlinked workspace member (pnpm-style layout)", () => {
    withTempWorkspace("symlink-member", (ws) => {
      addPnpmEvidence(ws);
      addPackage(ws, "packages/real", "real", "1.0.0");
      addPackage(ws, "external/foo", "foo", "1.0.0");
      symlinkSync(join(ws.root, "external", "foo"), join(ws.root, "packages", "foo"));
      const detected = expectDetected(detectNodeWorkspace(ws.root));
      expect(detected.members.map((m) => m.name)).toEqual(["foo", "real"]);
      expect(detected.members.find((m) => m.name === "foo")?.dir).toBe("packages/foo");
    });
  });
});

// ---------------------------------------------------------------------------
// Workspace member name + manifest errors
// ---------------------------------------------------------------------------

describe("detectNodeWorkspace — manifest errors", () => {
  it("refuses duplicate member names across manifests", () => {
    withTempWorkspace("dup-names", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages:\n  - packages/a\n  - packages/b\n");
      addPackage(ws, "packages/a", "same", "1.0.0");
      addPackage(ws, "packages/b", "same", "2.0.0");
      const error = capture(() => detectNodeWorkspace(ws.root));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      expect((error as WorkspaceDetectionError).field).toBe("name");
      expect((error as WorkspaceDetectionError).message).toMatch(/duplicate workspace member name/);
    });
  });

  it("refuses a member manifest missing the name field", () => {
    withTempWorkspace("no-name", (ws) => {
      addPnpmEvidence(ws);
      ws.write("packages/lib/package.json", JSON.stringify({ version: "1.0.0" }));
      const error = capture(() => detectNodeWorkspace(ws.root));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      expect((error as WorkspaceDetectionError).field).toBe("name");
    });
  });

  it("refuses a member manifest missing the version field", () => {
    withTempWorkspace("no-version", (ws) => {
      addPnpmEvidence(ws);
      ws.write("packages/lib/package.json", JSON.stringify({ name: "lib" }));
      const error = capture(() => detectNodeWorkspace(ws.root));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      expect((error as WorkspaceDetectionError).field).toBe("version");
    });
  });

  it("refuses a member manifest with invalid JSON", () => {
    withTempWorkspace("bad-json", (ws) => {
      addPnpmEvidence(ws);
      ws.write("packages/lib/package.json", "{ not json }");
      const error = capture(() => detectNodeWorkspace(ws.root));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      expect((error as WorkspaceDetectionError).field).toBe("(file)");
      expect((error as WorkspaceDetectionError).message).toMatch(/cannot read manifest/);
    });
  });
});

// ---------------------------------------------------------------------------
// Workspace globs: zero-match → loud refusal
// ---------------------------------------------------------------------------

describe("detectNodeWorkspace — zero-match globs", () => {
  it("refuses when pnpm globs match no directory containing a package.json", () => {
    withTempWorkspace("no-match", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages:\n  - apps/*\n");
      // No directory called `apps/` exists at all.
      const error = capture(() => detectNodeWorkspace(ws.root));
      expect(error).toBeInstanceOf(WorkspaceDetectionError);
      expect((error as WorkspaceDetectionError).field).toBe("packages");
      expect((error as WorkspaceDetectionError).message).toMatch(/matched no directory/);
    });
  });
});

// ---------------------------------------------------------------------------
// The root `.` glob: root package.json becomes a member
// ---------------------------------------------------------------------------

describe("detectNodeWorkspace — root member via `.` pattern", () => {
  it("detects the root package.json as a member with dir `.`", () => {
    withTempWorkspace("root-member", (ws) => {
      ws.write("pnpm-workspace.yaml", "packages:\n  - .\n");
      ws.write("package.json", JSON.stringify({ name: "root", version: "0.0.0" }));
      const detected = expectDetected(detectNodeWorkspace(ws.root));
      expect(detected.members).toHaveLength(1);
      expect(detected.members[0]?.name).toBe("root");
      expect(detected.members[0]?.dir).toBe(".");
      expect(detected.members[0]?.manifestPath).toBe("package.json");
    });
  });
});

// ---------------------------------------------------------------------------
// Integration seam: toComponentMeta → planPropagation
// ---------------------------------------------------------------------------

describe("detectNodeWorkspace → planPropagation integration", () => {
  it("caret range crossing a major release emits a range-widening edge", () => {
    withTempWorkspace("prop-caret", (ws) => {
      addPnpmEvidence(ws);
      addPackage(ws, "packages/lib", "lib", "1.0.0");
      addPackage(ws, "packages/app", "app", "1.0.0", {
        dependencies: { lib: "^1.0.0" },
      });
      const detected = expectDetected(detectNodeWorkspace(ws.root));
      const components = toComponentMeta(detected);
      const plan = planPropagation(components, [release("lib", "2.0.0")]);
      expect(plan.edges).toEqual([{ from: "lib", to: "app", reason: "range-widening" }]);
      expect(plan.order).toEqual(["lib", "app"]);
    });
  });

  it("tilde range same-major release stays compatible", () => {
    withTempWorkspace("prop-tilde", (ws) => {
      addPnpmEvidence(ws);
      addPackage(ws, "packages/lib", "lib", "1.2.0");
      addPackage(ws, "packages/app", "app", "1.0.0", {
        dependencies: { lib: "~1.2.0" },
      });
      const detected = expectDetected(detectNodeWorkspace(ws.root));
      const components = toComponentMeta(detected);
      const plan = planPropagation(components, [release("lib", "1.2.3")]);
      expect(plan.edges).toEqual([]);
      expect(plan.notMoved).toEqual([{ component: "app", why: "range-compatible" }]);
    });
  });

  it("exact range with same version stays compatible", () => {
    withTempWorkspace("prop-exact", (ws) => {
      addPnpmEvidence(ws);
      addPackage(ws, "packages/lib", "lib", "1.0.0");
      addPackage(ws, "packages/app", "app", "1.0.0", {
        dependencies: { lib: "1.0.0" },
      });
      const detected = expectDetected(detectNodeWorkspace(ws.root));
      const components = toComponentMeta(detected);
      const plan = planPropagation(components, [release("lib", "1.0.0")]);
      expect(plan.edges).toEqual([]);
      expect(plan.notMoved).toEqual([{ component: "app", why: "range-compatible" }]);
    });
  });

  it("exact range with new patch emits a range-widening edge", () => {
    withTempWorkspace("prop-exact-bump", (ws) => {
      addPnpmEvidence(ws);
      addPackage(ws, "packages/lib", "lib", "1.0.0");
      addPackage(ws, "packages/app", "app", "1.0.0", {
        dependencies: { lib: "1.0.0" },
      });
      const detected = expectDetected(detectNodeWorkspace(ws.root));
      const components = toComponentMeta(detected);
      const plan = planPropagation(components, [release("lib", "1.0.1")]);
      expect(plan.edges).toEqual([{ from: "lib", to: "app", reason: "range-widening" }]);
    });
  });

  // The compatibility matrix's workspace-propagation row claims three
  // things at once — range-widening edges, the topological order, and the
  // notMoved negative evidence — and its evidence names the planner suites,
  // whose fixtures are hand-declared. This one run drives the whole claim
  // from real manifests (#286): a caret member edge propagates, the
  // devDependencies edge to a third member rides the raw graph but never
  // the plan (toComponentMeta filters it), and the untouched member carries
  // negative evidence instead of an edge.
  it("one real three-member manifest carries the whole propagation claim: the caret edge, the order and the notMoved evidence", () => {
    withTempWorkspace("prop-real-manifests", (ws) => {
      addPnpmEvidence(ws);
      addPackage(ws, "packages/lib", "lib", "1.0.0");
      addPackage(ws, "packages/tool", "tool", "1.0.0");
      addPackage(ws, "packages/app", "app", "1.0.0", {
        dependencies: { lib: "^1.0.0" },
        devDependencies: { tool: "^1.0.0" },
      });

      const detected = expectDetected(detectNodeWorkspace(ws.root));
      const components = toComponentMeta(detected);
      const plan = planPropagation(components, [release("lib", "2.0.0")]);

      expect(plan.edges).toEqual([{ from: "lib", to: "app", reason: "range-widening" }]);
      expect(plan.order).toEqual(["lib", "app"]);
      expect(plan.notMoved).toEqual([{ component: "tool", why: "no-reverse-dependency" }]);
    });
  });
});
