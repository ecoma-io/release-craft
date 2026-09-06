---
id: "0009"
title: "The git binding — persistence, the tag-push CAS, and the ref-side namespace door"
status: Proposed
implements: "https://github.com/ecoma-io/release-craft/issues/39"
created: 2026-09-06
updated: 2026-09-06
---

# ADR-0009: The git binding — persistence, the tag-push CAS, and the ref-side namespace door

## Context

Every durable value the engine records — ledger transitions (ADR-0006),
attempt ordinals (ADR-0005), claim allocations (ADR-0005 decision 4),
decision records (ADR-0003), and the generation records of ADR-0008 —
currently lives in an in-memory reference, and `release-model.md` has
carried the question of where they persist since Phase 2: "Where decision
records and ledgers persist at all is open fork 16, outside `core/domain/`
in any case." Beside it two more obligations were pinned, not resolved:
Phase 4's claim–verify–write protocol decided collisions in the domain and
deferred "the physical primitive (the tag-push CAS)" to "the Phase 8
adapter ADR" (release-model.md's unresolved question 1, updated at Phase 4;
ADR-0005), and E-08's tag-namespace enforcement was carried with the note
"tag-namespace enforcement is Phase 8". ADR-0008 decision 12 named the
adapters as the owners of real content: the artifact producer is
caller-injected, and "producing npm tarballs, pushing containers,
computing real digests — all adapter territory (Phase 8's git binding,
Phase 9's GitHub adapter)".

The ports to implement already exist and are load-bearing: the
`ExecutionLedger` port (phase5 contract §2), the `AttemptRegister` and
`ClaimStore` ports (ADR-0005 decisions 4–5), and the producer seam
(ADR-0008 decision 2). The engine's discipline — append-only records,
write-ahead at step granularity, deep-frozen values, resume as pure
classification over the tail — is already contract and code; the binding's
job is to express that discipline over git, not to invent a second one.

## Decision

1. **The binding is an adapter layer beside the engine.** Its home is
   fixed in the contract's §2 (`src/adapters/git/`); what the ADR fixes is
   the shape: it consumes the ports `src/execution/` exports and owns no
   vocabulary of its own — no new record shapes, no new key spaces, no new
   state names. The layering rules hold unchanged: nothing under
   `core/domain/` reaches it (ADR-0001's boundary is structural), and the
   package gains no runtime dependency (the house rule).
2. **Persistence is git-native and append-only by construction.** Whatever
   physical mapping the implementation chooses (the contract's §2
   constrains it), the binding must guarantee: records persist in their
   canonical serialized form — the same canonical form the fingerprints
   already pin; a persisted history only ever moves forward — any write
   that is not an extension of the recorded history is refused by the
   binding before it reaches git; and reloading is byte-exact — the
   reloaded tail must equal the recorded tail, and resume classification
   over a reloaded ledger must equal classification over the original.
   Where a decision record's home is needed (Phase 2's records; D14's
   "persistence is adjacent"), the same guarantees serve it — no second
   storage format.
3. **The mapping is invisible through the port.** Engine code cannot tell
   `MemoryLedger` from the git-backed one; the provider-isolation gate
   keeps it that way (the engine runs green with the binding absent, as it
   does today). Persisted scopes map to git state through a mapping the
   binding owns and tests pin — the engine never names a ref, an object,
   or a path.
4. **The tag-push CAS is the `ClaimStore` port's git-backed accept.** The
   atomic accept is git's ref creation: a tag is created if and only if
   the ref is absent at the recorded base — check-and-set at the ref, so
   the deterministic winner the protocol already elects is physically
   enforced by the object store, and the loser's conflict is a recorded
   decision (E-07's `abandoned(follower-of:…)`), never a thrown surprise.
   Force updates, deletions, and re-creations under an existing ref are
   refused at the same door. Tags remain the authoritative record (P-01's
   state requirement) exactly as the taxonomy locks.
5. **The namespace door sits at the ref, before any write.** The binding
   refuses to create a tag outside the namespace the plan declares, and
   honours the global tag-namespace precondition (M-11) as the physical
   half of the plan-level `version-collision` gate: a plan that passed the
   gate can no longer collide at the ref, and a ref-shaped collision the
   plan never declared is refused with a recorded reason (E-08's carried
   enforcement). The check is local to the binding — it reads declared
   namespaces from the attempt's own values, never from a registry or the
   network.
6. **The git-backed producer computes content identity from recorded
   content.** The producer the binding injects at the seam observes
   recorded content — never working-tree state — and returns a digest of
   that content as the artifact's digest, stable across identical content
   and different under any content change. The digest is opaque to the
   engine exactly as ADR-0008 decision 2 fixed: it arrives, it is never
   computed inside the engine; the binding merely makes it a real digest
   of real content.
7. **No provider behavior enters this layer.** No API calls, no
   environments, no registry interactions, no scheduling — the GitHub
   adapter (Phase 9) consumes this binding and stays its own phase, its
   own ADR. The binding's surface is: local git object and ref
   operations, the four ports, and the producer seam. How the binding
   talks to git (executable, library) is the implementation PR's choice,
   constrained only by the no-runtime-dependency rule and the isolation
   gate.
8. **The public surface is the barrel; determinism is re-proven two ways.**
   The binding exports through its own barrel consumed via the package
   surface in tests; and the contract's exit evidence requires both
   double-run determinism over fresh repositories and persist–reload
   equivalence (classify the same tail two ways, require one answer).

### Amendments this ADR makes (loud, in this PR)

- [decision-log.md](../design/decision-log.md): D24 records the decision
  set above.
- [release-model.md](../design/release-model.md): unresolved question 2
  (fork 16) gains its Phase 8 update — the persistence half resolves
  here; question 1's physical half (the tag-push CAS) resolves here; the
  "not yet designed" persistence line narrows accordingly.
- [matrix-coverage.md](../design/matrix-coverage.md): E-07 and E-08 move
  to **partial** with the binding named (ADR-0009); their fixtures pin
  with the implementation PR, when the class columns can cite tests
  instead of contracts.

## Consequences

- The engine's records survive a process restart, and resume over a
  reloaded tail is definitionally the same computation — Phase 5's
  classification has a durable substrate, and fork 16 closes.
- The claim protocol's last open half is physical: two writers, one ref,
  exactly one winner — E-07's half-published class is now refused by the
  object store instead of the process.
- Namespace enforcement has two independent doors — the planner's gate
  (M-11) and the binding's ref-side door — and neither can be silently
  bypassed by the other's absence.
- The in-memory references stay: they are the test seam and the kernel's
  determinism harness; the binding is a second implementation behind the
  same doors, and nothing in `src/execution/` changes shape for it.
- What this ADR deliberately does not decide: the GitHub adapter's API
  surface and any E2E flows (Phase 9, ADR-0010), artifact freshness rules
  (PR-03, carried), channel semantics (PR-04's door), and any remote
  synchronization of the persisted scopes beyond git's own push/fetch
  semantics.
