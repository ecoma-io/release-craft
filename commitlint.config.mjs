// Conventional Commits, enforced by lefthook's commit-msg hook and — for the
// pull request title, which becomes the squash commit's subject — by CI. Rules
// and examples: CONTRIBUTING.md.
//
// The scope carries routing information the type cannot: it says which part of
// the substrate a change belongs to, so the maintainer and the triage labels
// can sort on it without reading the diff.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      [
        "core", // src/ — the future release engine's home; a canary today
        "scripts", // the repository gates under scripts/
        "workspace", // root tooling, package metadata, Moon graph, hooks
        "docs", // documentation, including docs/bootstrap/
        "deps", // Renovate writes chore(deps):
        "ci", // Renovate writes chore(ci): for workflow action bumps
      ],
    ],
    "body-max-line-length": [0],
  },
};
