<!--
  The title becomes the squash commit's subject: Conventional Commits,
  scope ∈ {core, scripts, workspace, docs, deps, ci} (the policy workflow
  commitlints it). Public text in English.
-->

## Description

<!-- What changes, and why. Link the issue: "Closes #N". -->

## Type of change

- [ ] Foundation / tooling
- [ ] Documentation
- [ ] Governance (gates, workflows, rulesets)
- [ ] Product (release engine — currently nothing lives here)

## Could this fail silently?

<!-- The standing question. If this change adds or touches a gate, prove the
     gate bites (a deliberate violation that turns it red, then removed). If
     it touches affected-detection inputs, say what a docs-only change now
     triggers. -->

## How was this verified?

<!-- The commands you actually ran, e.g. `pnpm check` and `pnpm check:policy`
     — not the ones you assume CI runs. -->

## Checklist

- [ ] `pnpm check` and `pnpm check:policy` pass locally
- [ ] No new runtime dependencies; no floating versions; lockfile unchanged or reviewed
- [ ] Documentation updated where behaviour it describes changed
- [ ] AI-assisted changes are disclosed in the commit trailer
