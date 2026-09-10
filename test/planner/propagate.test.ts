/**
 * Unit tests for §2.15 dependency propagation (D16, PL-02, PL-03; ADR-0003
 * decision 17): range math at the edge level, transitive topological order,
 * and the negative-evidence record. Fixtures are self-contained; assertions
 * target the observable `PropagationPlan` only.
 */
import { describe, expect, it } from "vitest";

import { Version } from "@ecoma-io/release-craft/domain";

import { InvalidPlanningInputError } from "@ecoma-io/release-craft/__internal__/planner/input.js";
import { planPropagation } from "@ecoma-io/release-craft/__internal__/planner/propagate.js";
import type {
  ComponentDependency,
  ComponentMeta,
  PropagationPlan,
} from "@ecoma-io/release-craft/__internal__/planner/types.js";

function dependency(name: string, range: string): ComponentDependency {
  return { name, range };
}

function component(name: string, dependencies: readonly ComponentDependency[] = []): ComponentMeta {
  return {
    name,
    manifestVersion: "0.0.0",
    paths: [`packages/${name}`],
    ...(dependencies.length > 0 ? { dependencies } : {}),
  };
}

function release(
  componentName: string,
  version: string,
): { readonly component: string; readonly version: Version } {
  return { component: componentName, version: Version.parse(version) };
}

describe("planPropagation — §2.15 propagation (PL-02, PL-03; D16)", () => {
  it("keeps caret-compatible dependents still and records range-compatible evidence (PL-02 case 1)", () => {
    const result = planPropagation(
      [component("lib-a"), component("lib-b", [dependency("lib-a", "^1.2.0")])],
      [release("lib-a", "1.2.1")],
    );
    expect(result.edges).toEqual([]);
    expect(result.order).toEqual(["lib-a", "lib-b"]);
    expect(result.notMoved).toEqual([{ component: "lib-b", why: "range-compatible" }]);
  });

  it("widens a major-crossing caret and records the edge (PL-02 case 2)", () => {
    const result = planPropagation(
      [component("lib-a"), component("lib-b", [dependency("lib-a", "^1.2.0")])],
      [release("lib-a", "2.0.0")],
    );
    expect(result.edges).toEqual([{ from: "lib-a", to: "lib-b", reason: "range-widening" }]);
    expect(result.order).toEqual(["lib-a", "lib-b"]);
    expect(result.notMoved).toEqual([]);
  });

  it("holds caret 0.x to its minor series", () => {
    const components = [component("lib-a"), component("lib-b", [dependency("lib-a", "^0.2.0")])];
    expect(planPropagation(components, [release("lib-a", "0.2.9")]).edges).toEqual([]);
    expect(planPropagation(components, [release("lib-a", "0.3.0")]).edges).toEqual([
      { from: "lib-a", to: "lib-b", reason: "range-widening" },
    ]);
  });

  it("holds caret 0.0.x to its patch series", () => {
    const components = [component("lib-a"), component("lib-b", [dependency("lib-a", "^0.0.3")])];
    expect(planPropagation(components, [release("lib-a", "0.0.3")]).edges).toEqual([]);
    expect(planPropagation(components, [release("lib-a", "0.0.4")]).edges).toEqual([
      { from: "lib-a", to: "lib-b", reason: "range-widening" },
    ]);
  });

  it("holds tilde to its minor series, including on a 0.x floor", () => {
    const minor = [component("lib-a"), component("lib-b", [dependency("lib-a", "~1.2.3")])];
    expect(planPropagation(minor, [release("lib-a", "1.2.9")]).edges).toEqual([]);
    expect(planPropagation(minor, [release("lib-a", "1.3.0")]).edges).toEqual([
      { from: "lib-a", to: "lib-b", reason: "range-widening" },
    ]);
    const zero = [component("lib-a"), component("lib-b", [dependency("lib-a", "~0.2.3")])];
    expect(planPropagation(zero, [release("lib-a", "0.2.9")]).edges).toEqual([]);
    expect(planPropagation(zero, [release("lib-a", "0.3.0")]).edges).toEqual([
      { from: "lib-a", to: "lib-b", reason: "range-widening" },
    ]);
  });

  it("holds tilde 0.0.x to its patch series", () => {
    const components = [component("lib-a"), component("lib-b", [dependency("lib-a", "~0.0.3")])];
    expect(planPropagation(components, [release("lib-a", "0.0.3")]).edges).toEqual([]);
    expect(planPropagation(components, [release("lib-a", "0.0.4")]).edges).toEqual([
      { from: "lib-a", to: "lib-b", reason: "range-widening" },
    ]);
  });

  it("accepts an exact range only at precedence equality", () => {
    const components = [component("lib-a"), component("lib-b", [dependency("lib-a", "1.2.3")])];
    expect(planPropagation(components, [release("lib-a", "1.2.3")]).edges).toEqual([]);
    expect(planPropagation(components, [release("lib-a", "1.2.4")]).edges).toEqual([
      { from: "lib-a", to: "lib-b", reason: "range-widening" },
    ]);
    expect(planPropagation(components, [release("lib-a", "1.2.2")]).edges).toEqual([
      { from: "lib-a", to: "lib-b", reason: "range-widening" },
    ]);
  });

  it("widens when the new version sits below the range floor", () => {
    const result = planPropagation(
      [component("lib-a"), component("lib-b", [dependency("lib-a", "^1.2.0")])],
      [release("lib-a", "1.1.9")],
    );
    expect(result.edges).toEqual([{ from: "lib-a", to: "lib-b", reason: "range-widening" }]);
  });

  it("judges prerelease candidates by kernel precedence alone", () => {
    const components = [component("lib-a"), component("lib-b", [dependency("lib-a", "^1.2.0")])];
    expect(planPropagation(components, [release("lib-a", "1.2.3-rc.1")]).edges).toEqual([]);
    expect(planPropagation(components, [release("lib-a", "1.2.0-alpha")]).edges).toEqual([
      { from: "lib-a", to: "lib-b", reason: "range-widening" },
    ]);
  });

  it("orders a transitive chain release-first (lib-a → lib-b → app)", () => {
    const result = planPropagation(
      [
        component("lib-a"),
        component("lib-b", [dependency("lib-a", "^1.0.0")]),
        component("app", [dependency("lib-b", "^1.0.0")]),
      ],
      [release("lib-a", "2.0.0")],
    );
    expect(result.order).toEqual(["lib-a", "lib-b", "app"]);
    expect(result.edges).toEqual([{ from: "lib-a", to: "lib-b", reason: "range-widening" }]);
    expect(result.notMoved).toEqual([{ component: "app", why: "range-compatible" }]);
  });

  it("widens every direct dependent and schedules lib-a → lib-b → app (PL-02 case 2)", () => {
    const result = planPropagation(
      [
        component("lib-a"),
        component("lib-b", [dependency("lib-a", "^1.2.0")]),
        component("app", [dependency("lib-a", "^1.2.0"), dependency("lib-b", "^1.0.0")]),
      ],
      [release("lib-a", "2.0.0")],
    );
    expect(result.edges).toEqual([
      { from: "lib-a", to: "lib-b", reason: "range-widening" },
      { from: "lib-a", to: "app", reason: "range-widening" },
    ]);
    expect(result.order).toEqual(["lib-a", "lib-b", "app"]);
    expect(result.notMoved).toEqual([]);
  });

  it("proves isolation with no-reverse-dependency evidence (PL-03)", () => {
    const result = planPropagation(
      [
        component("tool-x"),
        component("lib-a"),
        component("lib-b", [dependency("lib-a", "^1.0.0")]),
      ],
      [release("lib-a", "2.0.0")],
    );
    expect(result.order).toEqual(["lib-a", "lib-b"]);
    expect(result.notMoved).toEqual([{ component: "tool-x", why: "no-reverse-dependency" }]);
  });

  it("records no-reverse-dependency for everything when nothing releases", () => {
    const result = planPropagation(
      [component("lib-a"), component("lib-b", [dependency("lib-a", "^1.0.0")])],
      [],
    );
    expect(result.edges).toEqual([]);
    expect(result.order).toEqual([]);
    expect(result.notMoved).toEqual([
      { component: "lib-a", why: "no-reverse-dependency" },
      { component: "lib-b", why: "no-reverse-dependency" },
    ]);
  });

  it("throws naming the edge when a dependency names an undeclared component", () => {
    const attempt = (): unknown =>
      planPropagation(
        [component("lib-b", [dependency("ghost", "^1.0.0"), dependency("phantom", "^1.0.0")])],
        [],
      );
    expect(attempt).toThrow(InvalidPlanningInputError);
    expect(attempt).toThrow('"lib-b" -> "ghost"');
    let caught: unknown;
    try {
      attempt();
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof InvalidPlanningInputError)) {
      throw new Error("expected InvalidPlanningInputError");
    }
    expect(caught.violations).toHaveLength(2);
    expect(caught.violations[0]?.field).toBe("components[0].dependencies[0].name");
    expect(caught.violations[1]?.problem).toContain("phantom");
  });

  it("throws when a release names an undeclared component", () => {
    const attempt = (): unknown =>
      planPropagation([component("lib-a")], [release("ghost", "1.0.0")]);
    expect(attempt).toThrow(InvalidPlanningInputError);
    expect(attempt).toThrow(/releases\[0\]\.component/);
  });

  it("throws naming the expression when a range is outside the declared grammar", () => {
    const attempt = (): unknown =>
      planPropagation(
        [component("lib-b", [dependency("lib-a", ">=1.0.0")]), component("lib-a")],
        [],
      );
    expect(attempt).toThrow(InvalidPlanningInputError);
    expect(attempt).toThrow(/>=1\.0\.0/);
  });

  it("throws naming the members when the declared graph is cyclic", () => {
    const attempt = (): unknown =>
      planPropagation(
        [
          component("lib-a", [dependency("lib-b", "^1.0.0")]),
          component("lib-b", [dependency("lib-a", "^1.0.0")]),
        ],
        [release("lib-a", "2.0.0")],
      );
    expect(attempt).toThrow(InvalidPlanningInputError);
    expect(attempt).toThrow(/cyclic among: lib-a, lib-b/);
  });

  it("records one edge when several releases or declarations break the same pair", () => {
    const result = planPropagation(
      [
        component("lib-a"),
        component("lib-b", [dependency("lib-a", "^1.0.0"), dependency("lib-a", "^1.0.0")]),
      ],
      [release("lib-a", "2.0.0"), release("lib-a", "3.0.0"), release("lib-a", "2.0.0")],
    );
    expect(result.edges).toEqual([{ from: "lib-a", to: "lib-b", reason: "range-widening" }]);
  });

  it("orders edges topologically across releases, not by release input order", () => {
    const result = planPropagation(
      [
        component("lib-a"),
        component("lib-c"),
        component("lib-b", [dependency("lib-a", "^1.0.0"), dependency("lib-c", "^1.0.0")]),
      ],
      [release("lib-c", "2.0.0"), release("lib-a", "2.0.0")],
    );
    expect(result.order).toEqual(["lib-a", "lib-c", "lib-b"]);
    expect(result.edges).toEqual([
      { from: "lib-a", to: "lib-b", reason: "range-widening" },
      { from: "lib-c", to: "lib-b", reason: "range-widening" },
    ]);
  });

  it("breaks scheduling ties by ASCII component name", () => {
    const result = planPropagation(
      [
        component("root"),
        component("zeta", [dependency("root", "^1.0.0")]),
        component("alpha", [dependency("root", "^1.0.0")]),
      ],
      [release("root", "2.0.0")],
    );
    expect(result.order).toEqual(["root", "alpha", "zeta"]);
    expect(result.edges).toEqual([
      { from: "root", to: "alpha", reason: "range-widening" },
      { from: "root", to: "zeta", reason: "range-widening" },
    ]);
    expect(result.notMoved).toEqual([]);
  });

  it("is deterministic: identical calls yield identical plans", () => {
    const run = (): PropagationPlan =>
      planPropagation(
        [
          component("lib-a"),
          component("lib-b", [dependency("lib-a", "^1.2.0")]),
          component("app", [dependency("lib-b", "^1.0.0")]),
          component("tool-x"),
        ],
        [release("lib-a", "2.0.0")],
      );
    expect(run()).toEqual(run());
  });
});
