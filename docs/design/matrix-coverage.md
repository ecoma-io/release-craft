# 53-Scenario Matrix Coverage Inventory

Phase 3 close-out artifact (issue #25, decision-log D19): the full
reconciliation of the planner contract's scenario matrix
([Table 1](phase2-planner-contract.md), 53 rows) against the planner test
suite (`test/planner/`, 15 files), the gap ledger it produced, and each
gap's resolution in the close-out.

Provenance: the inventory was built by an independent read-only sweep over
the contract's Table 1 rows and every planner test file; the orchestrator
verified the risky rows verbatim against the contract before ruling.

## The three golden tiers

The suite pins the matrix at three tiers, and the tiers are the point:

- **End-to-end goldens** — `assemble.test.ts`, `plan.golden.test.ts`,
  `scenario.golden.test.ts`, `line-policy.test.ts`: full inputs through the
  door `plan()`, asserting decision records, targets, and versions verbatim.
- **Attribution-layer pins** — `golden.test.ts`,
  `attribute.adversarial.test.ts`, `extract.adversarial.test.ts`: the M-01..M-09
  attribution mechanics (attribution ≠ decision pin; the close-out adds the
  decision-level pins where Table 1 owns them).
- **Per-mechanism pins** — `decide.test.ts`, `plan.test.ts`, `state.test.ts`,
  `history.test.ts`, `identity.test.ts`, `propagate.test.ts`,
  `isolation.test.ts`, `input.test.ts`: individual mechanisms under scenario
  names, plus the cross-cutting purity/fingerprint contracts.

## Row inventory (53)

Legend — **status**:
`pinned` = an assertion pins the row's expected planner decision + versions;
`mechanics` = the planner mechanics are pinned but the scenario's
decision-level expectation is not (closed by a close-out fixture);
`execution-only` = Table 1 assigns the row no planner fragment; the suite
correctly asserts nothing (verified in "Execution-only cleanliness");
`ruled` = resolved by a D19 ruling rather than a fixture.

### Stable line (S)

| ID   | Class | Status             | Owner / resolution                                                                                                                                                 |
| ---- | ----- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S-01 | full  | pinned             | `scenario.golden.test.ts` (no-op record, ignored commits, nothing minted) + `assemble.test.ts` door (`lines: []`) + `decide.test.ts`                               |
| S-02 | full  | pinned             | `assemble.test.ts` (recorded bootstrap `1.0.0` verbatim, `releasedUpTo: null`) + `scenario.golden.test.ts` + `decide.test.ts` + `input.test.ts` bootstrap boundary |
| S-03 | full  | pinned             | `assemble.test.ts` (`1.9.6`, hotfixes not re-listed) + `history.test.ts` band admission + `isolation.test.ts` double-run                                           |
| S-04 | full  | mechanics → pinned | Close-out fixture: fix → patch `1.0.5` on 1.x, bump-driving classification independent of changelog-worthiness                                                     |
| S-05 | full  | mechanics → pinned | Close-out fixture: major `2.0.0` on the new 2.x line beside a live 1.x line, interleaved tags, no interference                                                     |

### Prerelease (P)

| ID   | Class   | Status                      | Owner / resolution                                                                                                                                                                                                                      |
| ---- | ------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-01 | full    | pinned                      | `plan.golden.test.ts` — `1.2.0-alpha.10`, SemVer §11.4 numeric precedence                                                                                                                                                               |
| P-02 | full    | pinned                      | `plan.golden.test.ts` — fresh sequence per identifier (`beta.0`, `rc.0`); deliberate zero-change-set publication                                                                                                                        |
| P-03 | partial | pinned (planner half)       | `assemble.test.ts` promote door (`1.2.0`, empty change set, `bump: null`) + `decide.test.ts` routing + `plan.test.ts`; execution half (promoted-from edge, stream close, channels) correctly absent                                     |
| P-04 | full    | pinned                      | `plan.golden.test.ts` + `plan.test.ts` + `state.test.ts` — in-flight target stands, sequence continues                                                                                                                                  |
| P-05 | full    | pinned (supersession ruled) | `plan.golden.test.ts` — target recomputes to `2.0.0`, rc re-based at seed; the abandoned target's supersession record is the execution-side `supersedes` relation (D19(4)); the abandoned rc-key retention is pinned in `state.test.ts` |
| P-06 | full    | pinned                      | `plan.golden.test.ts` + `assemble.test.ts` + `plan.test.ts` — only the demanded stream advances                                                                                                                                         |
| P-07 | full    | pinned                      | `plan.golden.test.ts` + `assemble.test.ts` + `plan.test.ts` — `1.2.4-rc.0` from the maintenance line's own tags                                                                                                                         |

### Maintenance (M)

| ID   | Class   | Status             | Owner / resolution                                                                                                                                                                                                  |
| ---- | ------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M-01 | full    | mechanics → pinned | `golden.test.ts` attribution; close-out adds the decision pin: `1.9.1`, main empty-effective no-op at `2.3.0`                                                                                                       |
| M-02 | full    | mechanics → pinned | Close-out fixture: three lines release independently — `1.9.1`, `2.2.4`, `2.4.0`, no cross-dependency                                                                                                               |
| M-03 | full    | mechanics → pinned | Identity/pending/legality pins (`golden.test.ts`, `extract.adversarial.test.ts`, `attribute.adversarial.test.ts`); close-out adds the three-line release decisions                                                  |
| M-04 | full    | mechanics → pinned | `golden.test.ts` pending-split; close-out adds "release 1.9 only" — `1.9.1`, main unchanged with F pending                                                                                                          |
| M-05 | full    | mechanics → pinned | Conflict-never-merged pins; close-out adds "release 1.9 (F′)" — `1.9.1`                                                                                                                                             |
| M-06 | full    | mechanics → pinned | `golden.test.ts` releasedness-is-per-line; close-out adds "release 1.9; no re-release on main"                                                                                                                      |
| M-07 | full    | pinned             | `assemble.test.ts` (`1.10.0`) + `scenario.golden.test.ts` + `golden.test.ts` — all three tiers                                                                                                                      |
| M-08 | full    | pinned             | `line-policy.test.ts` (`2.4.0-rc.1` + `1.9.1` + recorded stable-only refusal, double-run) + `assemble.test.ts` + `plan.test.ts` + `state.test.ts`                                                                   |
| M-09 | full    | mechanics → pinned | `golden.test.ts` lineage-is-traceability; close-out adds "release main" — `2.3.0`→`2.3.1` despite `1.9.1` shipping the same fix                                                                                     |
| M-10 | partial | mechanics → pinned | D18 retire records exist (`decide.test.ts`, `line-policy.test.ts`, `assemble.test.ts`); close-out adds the rename half (`1.9-lts` releases `1.9.1` normally) and the withheld-record form of the retire half        |
| M-11 | full    | ruled + pinned     | D19(1): the plan-level `version-collision` gate — two lines minting one tag is a self-conflicting plan; refused naming tag, both lines, both heads; split namespaces legal (`version-collision.test.ts`, both ways) |

### Package / monorepo (PL)

| ID    | Class | Status                 | Owner / resolution                                                                                                                                                                                                                                                                  |
| ----- | ----- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PL-01 | full  | pinned                 | `plan.golden.test.ts` — per-package tag format `1.2.1`; neighbors-unchanged negative evidence                                                                                                                                                                                       |
| PL-02 | full  | pinned                 | `plan.golden.test.ts` (both cases, edges, topo order) + `propagate.test.ts` + `assemble.test.ts` ambiguous-mapping refusal                                                                                                                                                          |
| PL-03 | full  | pinned                 | `plan.golden.test.ts` — `0.3.1` alone; docs filtered; second-run no-op                                                                                                                                                                                                              |
| PL-04 | full  | mechanics → pinned     | `golden.test.ts` self-reference exclusion; close-out adds the decision pin: no release attributable to R; the plan proceeds without R (else the PL-06 no-op)                                                                                                                        |
| PL-05 | full  | partial → pinned       | (b) breaking-marker dominance pinned (`decide.test.ts`, `identity.test.ts`); close-out adds (a) the blocked-pending-config record and (c) the normal release from the deduplicated set                                                                                              |
| PL-06 | full  | mechanics → pinned     | Shape existed under S-01/PL-03 names; close-out adds the named pin: no-op + reason + per-commit classification, `2.3.0` remains released                                                                                                                                            |
| PL-07 | full  | pinned                 | `line-policy.test.ts` (prefix pinning, all-withheld, unfreeze) + `decide.test.ts` + `assemble.test.ts` — the most thoroughly pinned row                                                                                                                                             |
| PL-08 | full  | pinned (outcome ruled) | `identity.test.ts` fingerprint sensitivity (docs-only invariance + complement); the regeneration outcome's P1→P2 linkage is the execution-side `supersedes` relation — the door always emits `supersedes: null` (D19(4)); plan-identity change at the same target pinned under E-11 |

### Artifacts (AR)

| ID    | Class          | Status             | Owner / resolution                                                                                                                                                                                                                                                                                                                                         |
| ----- | -------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AR-01 | execution-only | execution-only     | Decision trivial per Table 1                                                                                                                                                                                                                                                                                                                               |
| AR-02 | partial        | owned (phase 7)    | D19(6) closed by ADR-0008 (D23): the artifact-dependency-DAG + verify-precondition fragment is the phase 7 contract — the DAG as closed declared input validated at the `openAttempt` door (§2.1), the verify precondition as the dependency digests being recorded in the same generation first (§2.4); fixture pin lands with the implementation PR      |
| AR-03 | execution-only | execution-only     |                                                                                                                                                                                                                                                                                                                                                            |
| AR-04 | partial        | ruled              | D19(5): structural pin — the closed §2.1 input cannot express a schedule, so "nightly: a scheduled build, not a release (no version allocation on the line)" holds by construction; no nightly fixture. The `1.2.4-nightly.0` mint in `plan.test.ts` is fork 4's opaque stream identifier (the D18 knob), a different surface — never conflated with AR-04 |
| AR-05 | execution-only | execution-only     |                                                                                                                                                                                                                                                                                                                                                            |
| AR-06 | partial        | mechanics → pinned | Close-out fixture: the plan's change set over the union range `b1..b2` (the notes source); note rendering is execution's half                                                                                                                                                                                                                              |

### Execution (E)

| ID                                                                         | Class          | Status                      | Owner / resolution                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | -------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E-01                                                                       | execution-only | execution-only              | Phase 4 (state shapes): `failed(unknown)` exists as data and `tag` is the guard table's no-return boundary (ADR-0005 decisions 3 and 6; phase4 contract §2.2, §2.5) — recovery doctrine and crash classification are Phase 5's (ADR-0006 decision 5; phase5 contract §2.4)                                                                                                                                       |
| E-02                                                                       | execution-only | execution-only              | Phase 4 (state shapes): step states `pending`/`started`/`completed`/`failed` verbatim and the append-only `TransitionRecord` (ADR-0005 decision 7) — the durable ledger that resumes them is Phase 5's (ADR-0006 decisions 1–3; phase5 contract §2.1, §2.3)                                                                                                                                                      |
| E-03                                                                       | execution-only | execution-only              | Phase 4: the replay classification contract — `noop` / `satisfied-externally` / `conflict` among the seven pure outcomes (ADR-0005 decision 8; phase4 contract §2.7) — evidence verification and fingerprint mechanics are Phase 5's (ADR-0006 decisions 8; phase5 contract §2.6)                                                                                                                                |
| E-04                                                                       | execution-only | execution-only (primitives) | `identity.test.ts` inputsFingerprint describe + `plan.golden.test.ts` + `assemble.test.ts` + `isolation.test.ts` — §2.11 primitives only; no revalidation semantics asserted; Phase 4 adds the `validate` guard shape and the `blocked(precondition-delta)` classification — revalidation recording is Phase 5's (ADR-0006 decision 9; phase5 contract §2.7)                                                     |
| E-05                                                                       | partial        | mechanics → pinned          | Purity (double-run deep-equal) + hash identity pinned; close-out adds the `committedAt` variance pin — frozen time is a fingerprint input; Phase 4 owns the attempt half: `attempt_sha256` over `{planId, ordinal}` via the register port, fingerprint carried never recomputed — the ledger equality proof is Phase 5's (ADR-0006 decision 4; phase5 contract §2.2–§2.3)                                        |
| E-06                                                                       | execution-only | execution-only (name-drops) | Foreign-tag naming + band admission + explanation surfacing; no adopt/void/re-tag semantics asserted; Phase 4 locks the `blocked(unattributed-state)` edges and the human-resolution path — adoption mechanics are Phase 5's (ADR-0006 decisions 6–7; phase5 contract §2.5)                                                                                                                                      |
| E-07                                                                       | execution-only | owned (phase 8)             | Phase 4 (full, domain level): claim scopes, claim–verify–write, deterministic winner/loser, `abandoned(follower-of:…)` (ADR-0005 decisions 4–5; phase4 contract §2.3–§2.4) — the physical tag CAS is the phase 8 contract (ADR-0009 §2.3, D24): the accept's atomic boundary is one claim ref (ADR-0009 §2.3, D24) and the physical tag is minted at the binding's door; fixtures pin with the implementation PR |
| E-08                                                                       | execution-only | owned (phase 8)             | Phase 4 (full, domain level): sequence-scope claims, claim-verify-write allocation, bounded `maxRetries` retry, explicit conflict record (ADR-0005 decision 4, E-08's declared-policy alternative) — tag-namespace enforcement is the phase 8 contract's ref-side door (ADR-0009 §2.4, D24), the physical half of M-11's gate; fixtures pin with the implementation PR                                           |
| E-09                                                                       | execution-only | execution-only              | Phase 4 (full): `abandoned` terminal with no outgoing edge, human attribution precedence, supersede at the step boundary with the `tag` exception, orphans recorded (ADR-0005 decisions 3 and 10) — the orphan registry is Phase 5's (ADR-0006 decisions 6–7; phase5 contract §2.5)                                                                                                                              |
| E-10                                                                       | partial        | mechanics → pinned          | Ordering policy pinned in `history.test.ts`; close-out adds the anomalous-clock history fixture over the range walk (nightly-stamp-never-for-ordering stays execution's half); Phase 4 locks timestamps as caller-supplied metadata with structural ordering (ADR-0005 decision 11) — the nightly stamp itself is phase 7's declared artifact step (ADR-0008 decision 12: declared, opaque, never ordered)       |
| E-11                                                                       | partial        | pinned (linkage ruled)      | `plan.golden.test.ts` + `assemble.test.ts` + `identity.test.ts` — same `1.5.0`, different change sets → different planId ("the version is not the plan"); the P1-superseded `supersedes` linkage is execution-side (D19(4)); execution consumes the recorded supersession relation, never re-derives it (phase4 contract §2.8)                                                                                   |
| Phase 4's contract (issue #27, ADR-0005) re-owns the execution rows above; |
| the class columns record the Phase 3 close-out classification and are      |
| unchanged by the re-owning.                                                |

### Promotion (PR)

| ID           | Class          | Status                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR-01..PR-05 | execution-only | execution-only — Table 1 rows 491–495 assign the promotion axis no planner fragment (D19(7): no channels amendment; the gate stays with the execution phase); Phase 4 locks the promotion-adjacent state shapes (`blocked(validation)`, attribution, evidence refs), the artifact phase (7) implements the generation semantics (ADR-0008, D23 — contract landed; fixture pin with the implementation PR) |

### Remote (R)

| ID                                                                       | Class   | Status          | Owner / resolution                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------ | ------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R-01                                                                     | adapter | owned (phase 9) | Remote ref push — the adapter pushes the binding's minted tag and claim refs; the remote has the expected refs at expected targets; retry returns ok (ADR-0010 decisions 4–5; phase9 contract §4, scenario 1–2)                                                                                                                                  |
| R-02                                                                     | adapter | owned (phase 9) | Idempotent retry — after a successful push, the same push retries and returns ok without a remote call (ADR-0010 decision 4; phase9 contract §4, scenario 2)                                                                                                                                                                                     |
| R-03                                                                     | adapter | owned (phase 9) | Remote already has tag at different target — the adapter refuses (ADR-0010 decision 5; phase9 contract §4, scenario 3)                                                                                                                                                                                                                           |
| R-04                                                                     | adapter | owned (phase 9) | GitHub Release creation — release for a pushed tag, body matches recorded changelog (ADR-0010 decision 6; phase9 contract §4, scenario 4)                                                                                                                                                                                                        |
| R-05                                                                     | adapter | owned (phase 9) | Idempotent release creation — retry returns ok, verifies match (ADR-0010 decision 6; phase9 contract §4, scenario 5)                                                                                                                                                                                                                             |
| R-06                                                                     | adapter | owned (phase 9) | Release conflict — remote release with different body; adapter refuses (ADR-0010 decision 7; phase9 contract §4, scenario 6)                                                                                                                                                                                                                     |
| R-07                                                                     | adapter | owned (phase 9) | Transport failure — remote unreachable; adapter returns transport-failure (ADR-0010 decision 7; phase9 contract §4, scenario 7)                                                                                                                                                                                                                  |
| R-08                                                                     | adapter | owned (phase 9) | Rate-limit refusal — GitHub API rate-limit response; adapter returns refused(rate-limited) (ADR-0010 decision 9; phase9 contract §4, scenario 8)                                                                                                                                                                                                 |
| R-09                                                                     | adapter | owned (phase 9) | Auth expiry — invalid or expired credential; adapter returns refused(auth-expired) (ADR-0010 decision 2; phase9 contract §4, scenario 9)                                                                                                                                                                                                         |
| R-10                                                                     | adapter | owned (phase 9) | Reconciliation — clean: remote matches binding's recorded state, no divergence (ADR-0010 decision 8; phase9 contract §4, scenario 10)                                                                                                                                                                                                            |
| R-11                                                                     | adapter | owned (phase 9) | Reconciliation — unadopted remote tag: remote has a tag the binding has no record of (ADR-0010 decision 8; phase9 contract §4, scenario 11)                                                                                                                                                                                                      |
| R-12                                                                     | adapter | owned (phase 9) | Reconciliation — unadopted remote release: remote release for tag binding has no record of (ADR-0010 decision 8; phase9 contract §4, scenario 12)                                                                                                                                                                                                |
| R-13                                                                     | adapter | owned (phase 9) | Ambiguous outcome — timeout returns ambiguous; caller must verify (ADR-0010 decision 7; phase9 contract §4, scenario 13)                                                                                                                                                                                                                         |
| R-14                                                                     | adapter | owned (phase 9) | Isolation — engine suite green without adapter; no engine module imports it (phase9 contract §4, scenario 14)                                                                                                                                                                                                                                    |
| R-15                                                                     | adapter | owned (phase 9) | Reconciliation — unobserved listing: a listing that never became a usable observation claims no comparison over it (issue #66; D30; phase9 contract §4, scenario 15)                                                                                                                                                                             |
| R-16                                                                     | adapter | owned (phase 9) | Reconciliation — refused listing: rate-limit/auth refusal on a listing claims no comparison over it (issue #66; D30; phase9 contract §4, scenario 16)                                                                                                                                                                                            |
| R-17                                                                     | adapter | owned (phase 9) | Reconciliation — truncated listing: a listing exceeding one page is followed across its pagination; a page that never becomes usable makes the whole listing transport-failure, never a partial comparison (issue #68; D32; phase9 contract §4, scenario 17)                                                                                     |
| R-18                                                                     | adapter | owned (phase 9) | Permission denial — a 403 with a valid credential (budget standing, no Retry-After) is refused(permission-denied), never auth-expired; the git-path classifier anchors on structured stderr shapes, never a bare status substring (issue #178; D51; phase9 contract §4, scenario 18)                                                             |
| R-19                                                                     | adapter | owned (phase 9) | Secondary rate limit — a 403 with Retry-After and the budget standing is refused(rate-limited) with the Retry-After detail, on every door (issue #178; D51; phase9 contract §4, scenario 19)                                                                                                                                                     |
| R-20                                                                     | adapter | owned (phase 9) | Unobservable remote — the release read's 404 probes the repository: observable → absent, unobservable → refused(unobservable-remote); a repo-scoped listing's 404 and the create's 404 are the same refusal, never a retryable failure or a determinate absence (issue #176; D50; phase9 contract §4, scenario 20)                               |
| R-21                                                                     | adapter | owned (phase 9) | Determinate create refusals — the create's 422 (already_exists, the raced duplicate) and 409 are refused(release-conflict) with the provider's detail; the idempotent re-run resolves a raced duplicate (issue #178; D51; phase9 contract §4, scenario 21)                                                                                       |
| R-22                                                                     | adapter | owned (phase 9) | Reconciliation — completeness evidence: a walk ending on a full-size final page with no next link is pagination: truncated over the rows observed (their divergences claimed), never a clean complete; a full page declaring a next is still followed, and the walk reads the final page only (issue #179; D53; phase9 contract §4, scenario 22) |
| R-23                                                                     | adapter | owned (phase 9) | Reconciliation — the chain's faults and the no-throw law: a cycling next chain and a next target that is no API-relative path fault the whole listing transport-failure (no hang, no silent stop, no blind follow); a throwing transport lands every door in its returned failure class (issue #179; D53; phase9 contract §4, scenario 23)       |
| Class census: 29 full, 8 partial (P-03, M-10, AR-02, AR-04, AR-06, E-05, |
| E-10, E-11), 16 execution-only — 53 total.                               |

### Phase 9 extension — 23 adapter scenarios

The 23 Remote (R) scenarios above are the Phase 9 adapter's coverage,
added after the 53-scenario sweep. They are not part of the original
inventory; the class `adapter` is the Phase 9 layer's own. The 53-row
census and the gap ledger above are unchanged. The 9.5 assembly (#65,
D29) composed the three units behind the §2.6 barrel: R-14's adapter
half is pinned by `test/adapters/github/adapter.test.ts` (the barrel's
runtime surface is the factory), and the classifier pins behind §4
scenarios 8–9 moved to the white-box suite the contract §4 names as its one
exception. R-15/R-16 (issue #66, D30) pin the reconciliation's
listing-failure outcomes — their fixtures land with the shape-change PR
that re-pins scenarios 10–12 on the amended report. R-17 (issue #68,
D32) pins the pagination walk — follow-across-pages and a page-two
failure unclaiming the whole listing — in the reconciliation unit's
suite (`test/adapters/github/reconciliation.test.ts`). R-18–R-21
(issues #176/#178, D50/D51) pin the refusal vocabulary's split — the
repository probe behind `absent`, `permission-denied` and the
secondary limit, and the determinate create refusals — in the
publication, reconciliation, and white-box classifier suites
(`test/adapters/github/`). R-22/R-23 (issue #179, D53) pin the walk's
completeness evidence — the full-final-page truncation and the
declaration-over-size rule — and the chain faults and the no-throw
conformance (the cycle, the malformed next, the hostile transport on
every door) in the reconciliation and publication suites
(`test/adapters/github/`).

## Gap ledger and resolution

The sweep produced 22 gaps (G-1..G-22); the close-out resolved all of them:

| Gap  | Row        | Resolution                                                                                                                                                                                                                                                                                                                                   |
| ---- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-1  | S-04       | Fixture: patch release `1.0.5` (bump-driving ≠ changelog-worthiness)                                                                                                                                                                                                                                                                         |
| G-2  | S-05       | Fixture: major `2.0.0` on 2.x beside live 1.x, no interference                                                                                                                                                                                                                                                                               |
| G-3  | M-01       | Decision-level fixture: `1.9.1`; main empty-effective no-op                                                                                                                                                                                                                                                                                  |
| G-4  | M-02       | Fixture: three independent releases `1.9.1` / `2.2.4` / `2.4.0`                                                                                                                                                                                                                                                                              |
| G-5  | M-03       | Decision-level fixture: release all three lines                                                                                                                                                                                                                                                                                              |
| G-6  | M-04       | Decision-level fixture: `1.9.1` only; main keeps F pending                                                                                                                                                                                                                                                                                   |
| G-7  | M-05       | Decision-level fixture: release `1.9` (F′)                                                                                                                                                                                                                                                                                                   |
| G-8  | M-06       | Decision-level fixture: `1.9.1`; no re-release on main                                                                                                                                                                                                                                                                                       |
| G-9  | M-09       | Decision-level fixture: main `2.3.0`→`2.3.1` despite shared fix                                                                                                                                                                                                                                                                              |
| G-10 | M-10       | Fixtures: rename half (`1.9-lts` → `1.9.1`) + retire-withheld record form                                                                                                                                                                                                                                                                    |
| G-11 | M-11       | D19(1): `version-collision` refusal gate + `version-collision.test.ts` (probe-discovered defect: the door previously planned colliding tags)                                                                                                                                                                                                 |
| G-12 | PL-04      | Decision-level fixture: no release attributable to R; proceeds without R                                                                                                                                                                                                                                                                     |
| G-13 | PL-05      | Sub-case fixtures: (a) blocked-pending-config record; (c) deduplicated-set release                                                                                                                                                                                                                                                           |
| G-14 | PL-06      | Named pin: no-op + reason + per-commit classification; `2.3.0` remains                                                                                                                                                                                                                                                                       |
| G-15 | PL-08      | D19(4): regeneration outcome is execution-side; door emits `supersedes: null`; identity change at same target already pinned (E-11)                                                                                                                                                                                                          |
| G-16 | AR-02      | D19(6) → closed by ADR-0008 (D23): owned as the phase 7 contract's §2.1 door validation and §2.4 verify precondition — artifact coordinates are execution vocabulary; fixtures with the implementation PR                                                                                                                                    |
| G-17 | AR-04      | D19(5): structural pin — the closed input cannot express a schedule; no allocation by construction                                                                                                                                                                                                                                           |
| G-18 | AR-06      | Fixture: change set over the union range `b1..b2` (notes source)                                                                                                                                                                                                                                                                             |
| G-19 | E-05       | Fixture: committedAt variance → fingerprint UNCHANGED (the D17(7)/§2.11 closed enumerations exclude committedAt by design — change identity is sha/Change-Id; "frozen time is input data, never a clock read"); bootstrap `when` variance → fingerprint CHANGES (recorded time IS enumerated input — the row's "incl. frozen time" fragment) |
| G-20 | E-10       | Fixture: anomalous-clock history over the range walk                                                                                                                                                                                                                                                                                         |
| G-21 | P-05       | D19(4): the supersession record is the `supersedes` relation (execution-side); abandoned-key retention already pinned                                                                                                                                                                                                                        |
| G-22 | E-11/PL-08 | D19(4), shared with G-15                                                                                                                                                                                                                                                                                                                     |

## Adversarial pass (issue #25's attack set)

The ten attacks and where each resolved:

1. **Inert withhold rule** — probed: the release proceeds, `withheld: []` (a
   rule matching nothing is a no-op, never a refusal). Golden-pinned.
2. **Bootstrap × withhold composition** — probed: composes; birth mints from
   the bootstrap commit, the second line's demand defers as a recorded
   refusal with an `explanation.withheld` entry. Golden-pinned.
3. **Duplicate prerelease intents** — probed: idempotent; identical planId,
   exactly one `refusedIntents` record for single and duplicate demand.
   Golden-pinned.
4. **Line-less prerelease intent** — probed: the input contract refuses
   (`intents[N].lineId` must be a non-empty line id); "global stream demand"
   is unreachable by construction. Door-refusal pin (`input.test.ts`).
5. **Per-line seed isolation** — probed: the same stream id on two lines
   keys seed and sequence per line (`rc.1` declared vs `rc.0` default,
   independent pointers). Golden-pinned.
6. **All-deferred release (breaking + docs under withhold)** — close-out
   fixture: everything defers, nothing mints, the explanation enumerates.
7. **Retired line × prerelease demand** — close-out fixture: the retire
   refusal composes with the recorded stream refusal; neither fabricates a
   target.
8. **Binding-alias gap naming** — close-out fixture: the ambiguous-mapping
   refusal names the declared components and the binding gap (D18 decision 4).
9. **Empty component universe × declared publishes** — close-out fixture:
   the door refuses a binding to nothing rather than dropping the
   declaration.
10. **Zero-declaration ≡ explicit-defaults** — close-out fixture: a plan
    computed from an absent declaration deep-equals one computed from the
    spelled-out defaults.

## Execution-only cleanliness

Verified: none of PR-01..05, AR-01, AR-03, AR-05, E-01..E-04, E-06..E-09 has
any planner test asserting channel moves, digest comparison, generation ids,
promotion/trigger evidence, adoption, ledger resume, CAS bindings, or nightly
scheduling. Token sweep over `test/planner/`:

- `promot` → the planner-owned promote intent (P-03/D17(4)) and `state.test.ts`'s
  §2.13 promotion-tag state rebuild. No promoted-from edge, stream close, or
  channel membership anywhere.
- `evidence` → propagation negative-evidence records (PL-02/PL-03, §2.15/D16).
  Not PR-05 trigger evidence.
- `digest` → `policy.digest` input identity only; never an artifact digest.
- `nightly` → the fork-4 opaque stream identifier (`1.2.4-nightly.0`, the D18
  allow-list knob) — not an AR-04 assertion.
- E-04/E-06/E-08 name-drops → §2.11/§2.13/seed-policy primitives only.
- Zero token hits: `channel`, `ledger`, `generation`, `draft`, `rollback`.

No execution semantics is fictionally asserted. The planner's absence of
promotion/artifact behavior is the contract's Table 1 posture, not an
oversight.
