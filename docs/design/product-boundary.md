# Product boundary

One sentence every other document may quote instead of improvising its own.

> **release-craft is a general-purpose, open-source release engine for
> software projects, developed and maintained by
> [ecoma-io](https://github.com/ecoma-io).**

## Inside the boundary, outside it

| Concern                                          | Where it stands                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/domain`, the planner, the execution kernel | The release domain. Customer-neutral by construction: [ADR-0001](../adr/0001-domain-kernel-and-semantic-version.md) bans every external import from the kernel, and [ADR-0002](../adr/0002-release-model-and-domain-vocabulary.md) keeps provider concepts out of the vocabulary. |
| Ecoma — the fair-code labor OS                   | Maintainer, origin, first-party dogfood consumer. Never a domain concept: no Ecoma term belongs in the domain vocabulary, the planner, or the execution kernel.                                                                                                                   |
| GitHub, GitLab, npm, PyPI, registries, CI        | Integration and provider concerns. They bind at adapter tiers, in their own phases; naming one as domain identity is a boundary violation, not a feature.                                                                                                                         |

## Why this document exists

The bootstrap encoded the product's identity in three places independently —
the README, `AGENTS.md`, and `package.json` — and they drifted apart: two
introduced the engine as ecoma-io-internal, the package manifest as release
engineering for the Ecoma labor OS (#43, corrected 2026-09). One authoritative
statement replaces three improvisations. Status honesty is unchanged — the
[README](../../README.md) remains the truthful account of what ships.

## Rules for documentation that follows

- State the positioning at most once per document: quote the sentence above or
  link here. Never restate it as Ecoma-specific.
- Ecoma references are legitimate only as maintainer, origin, or dogfood
  context.
- Providers are named only as integration concerns, matching the release
  model's provider isolation ([release-model.md](./release-model.md)).
