# Ecosystem adoption plan — shadow-mode rollout of the release engine

Status: **plan** — nothing here ships behavior; the engine's release
behavior, provider pipelines, and per-repo adoption land through their own
issues and designs (repo AGENTS.md). This document records the rollout
posture and the promotion criteria only.

Scope: the ecoma-io organization's eight repositories. The engine serves
any software project; Ecoma is the maintainer's first-party dogfood
consumer, never a domain concept (product-boundary.md). This plan is the
consumption side of that law: how each repo starts eating the engine's
dogfood in shadow before it earns a live leg.

## Why shadow first

The release path is certified on `release-craft` itself (run 35499784625,
tag `0.4.2`, `verdict: CERTIFIED` — see the §15 addendum in
`self-release-hardening-audit.md`). Certification on the dogfood repo is a
necessary condition for rollout, not a sufficient one: every adopting repo
brings its own release model (line policy, tag namespaces, release
channels, changelog shape), and the engine's own certified run only proves
the mechanics over one model. Shadow mode exercises the mechanics over a
repo's real (but non-destructive) evidence — world closing, plan,
deterministic step walk, ledger, judge — with `publish: "false"`, so a
defect in the adopting repo's posture fails the judge, not the release.

## The shadow run (per adopting repo)

A single workflow per repo, pinned to a 40-character SHA of the org Action
(version kept in a trailing comment), with the posture the self-release/
dogfood workflows already enforce:

- least-privilege `permissions`, `persist-credentials: false`, no
  `pull_request_target`, no secrets in `run:`, concurrency declared —
  `check:workflows` scans it like every other workflow file;
- world closing over the repo's line (`main`), tag namespaces declared,
  intents declared;
- invoke with `publish: "false"` — the run door records the plan and the
  step walk into the ledger (refs/release-craft/… on the repo's own
  origin), but the publication leg never fires;
- the judge runs the four classes over the captured envelope; the
  release-object rows report NOT ASSERTED without a live publish (their
  honest state — phase 14 §7);
- the human owner of the repo reads the NOT ASSERTED rows (the log-read
  classes) on every shadow run, just as the self-release expects its own
  humans to.

Nothing in a shadow run rewrites tags, touches Releases, or changes the
repo's existing release-please lane. The two lanes coexist until promotion.

## Promotion criteria (shadow → live)

A repo promotes its workflow to `publish: "true"` only when all of these
hold, judged on evidence, not on elapsed time:

1. **Three consecutive certified shadow runs** over the repo's real line
   (`verdict: CERTIFIED`, no NOT ASSERTED row left unread by a human).
2. **Judge rows all PASS** — including the product boundary: no Ecoma
   string in the envelope's product surfaces beyond the host identity.
3. **Idempotency demonstrated**: a re-run over the same line concludes the
   same posture without rewriting tags or refs; a new line advances the
   version the plan intends.
4. **Recovery demonstrated**: a half-state (create landed, push interrupted
   or refused) resumes through the recorded ledger, exactly as
   `release-craft` recovered `0.4.0` → `0.4.1` → `0.4.2`.
5. **Peer decision recorded**: the promotion is its own issue + PR in the
   adopting repo, linking the shadow evidence; never a drive-by flag flip.
6. **Release model reconciled**: the repo's line policy, tag namespaces,
   and changelog shape are declared in its world and match what its
   release-please lane produced (release-please-baseline.md is the
   compare-and-set reference).

## Roadmap

| Phase | Repo            | Lane today                                        | Shadow target                                                              |
| ----- | --------------- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| 0     | `release-craft` | certified self-release (run #4)                   | — done, this is the template                                               |
| 1     | `ecoma-cloud`   | private; runs the harness at a pinned ref already | first consumer — its pinned-harness wiring (AGENTS.md) is the natural seam |
| 2     | `action-agents` | pre-release, nothing pinnable                     | smallest repo with real release surface                                    |
| 3     | `archkeep`      | npm `@ecoma-io/archkeep`, release-please          | boundary-verdicts repo, frequent patch churn                               |
| 4     | `runtime-trail` | release-please                                    | Rust + Vue monorepo — proves polyglot                                      |
| 5     | `loom`          | release-please                                    | UI library — proves token/docs surface                                     |
| —     | `.github`       | docs only, no toolchain                           | **never** — nothing to release; the one deliberate exception               |

Phases 1–5 do not block each other: each repo opens its own
adoption issue, brings its own world, and promotes on its own evidence.
`ecoma-cloud` goes first only because it already consumes the harness at a
pinned ref, so the shadow lane is incremental rather than new surface.

## Non-goals

- No provider-pipeline behavior is built by this plan; every mechanic it
  names (line policy, namespaces, changelog rendering, npm publishing)
  already exists or lands through its own issue + design in the engine.
- No repo is forced off release-please; promotion replaces the lane only
  when the adopting repo's own decision records say so.
- `.github` never adopts the engine — positing a release lane for a
  docs-only repo would be a category error.
