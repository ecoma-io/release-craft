// @ts-check
//
// Flat config. ESLint owns correctness and conventions; formatting belongs to
// Prettier (eslint-config-prettier is applied last to prove the split). The
// plugin roster is deliberately short — every plugin earns its place in
// docs/bootstrap/ecosystem-analysis.md, and no stylistic rule is turned on
// that Prettier already settles.
//
//   - `typescript-eslint` strictTypeChecked: the type-aware set, which is what
//     catches unsafe `any` leakage, floating promises and misuse — the failure
//     classes the task names. No `any` escape hatches in shipped sources.
//   - `@vitest/eslint-plugin`: tests that lie (focused, disabled, empty).
//   - `eslint-config-prettier`: formatting stays out of lint's verdict.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import vitest from "@vitest/eslint-plugin";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  // Flat config does not read .gitignore, so the generated trees are named.
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      ".moon/cache/**",
      ".claude/worktrees/**",
    ],
  },

  js.configs.recommended,

  // TypeScript sources — the type-aware block. `projectService` points the
  // parser at tsconfig.json without hand-listing projects.
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node, ...globals.es2024 },
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },

  // Shipped module surface: every export crosses a boundary someone will
  // depend on, so its type is written down.
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/explicit-module-boundary-types": "error",
    },
  },

  // Plain-Node configuration and gate files (.mjs). Type-aware rules are off —
  // these files carry their types as JSDoc where they matter, and the gates
  // must run with zero dependencies.
  {
    files: ["**/*.mjs", "**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.node, ...globals.es2024 },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },

  // Tests. The vitest plugin's recommended set plus a hard ban on the escape
  // hatches that make a suite look green while testing nothing.
  {
    files: ["test/**/*.ts", "**/*.test.ts"],
    plugins: { vitest },
    languageOptions: {
      globals: { ...globals.node, ...globals.es2024 },
    },
    rules: {
      ...vitest.configs.recommended.rules,
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "error",
      "vitest/expect-expect": "error",
      "vitest/valid-expect": "error",
    },
  },

  // Conventions with a reason, kept to a handful:
  //
  //   - `src/` must not print. A library that writes to the caller's terminal
  //     is a bug waiting for a log pipeline; the gates under scripts/ are the
  //     terminal's UI and are explicitly allowed to.
  //   - `eqeqeq` with a null exemption — `== null` is the idiomatic null-or-
  //     undefined test; every other loose comparison is a bug.
  //   - `prefer-const` / `no-var` — mutation of the binding, not of the value,
  //     is the thing that needs a reason.
  {
    files: ["src/**/*.ts"],
    rules: { "no-console": "error" },
  },
  {
    files: ["scripts/**/*.mjs"],
    rules: { "no-console": "off" },
  },
  {
    rules: {
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
      "no-var": "error",
    },
  },

  // Formatting is Prettier's verdict, not ESLint's.
  prettier,
);
