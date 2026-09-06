# Phase 8 contract — the git binding

Phase 8 lands the git binding: persistence for everything the engine
records, the physical tag-push CAS behind the claim store, the ref-side
namespace door, and the git-backed artifact producer (ADR-0009;
[release-model.md](release-model.md) fork 16 and unresolved question 1's
physical half, [phase5-ledger-contract.md](phase5-ledger-contract.md)'s
carried persistence note). Everything here consumes the ports Phases
4–7 already locked — nothing re-decides the kernel, the ledger's
discipline, the claim protocol's domain half, or the artifact graph.

## 1. Scope and non-goals

In scope: a git-backed adapter layer implementing the `ExecutionLedger`,
`AttemptRegister`, and `ClaimStore` ports with the decision-record home
alongside; the tag-push CAS as the claim store's atomic accept; the
ref-side namespace door; a git-backed producer for the artifact seam;
persist–reload equivalence and double-run determinism over real
repositories.

Non-goals: the GitHub adapter and any API/network behavior (Phase 9,
ADR-0010); evidence freshness rules (PR-03 — carried); channels and
promotion (PR-04's door); any change to `src/execution/`'s shapes (the
in-memory references stay as the test seam; if an implementation needs a
port widened, that is its own reviewed change, not a drive-by);
authentication, remote synchronization, or anything beyond local git
object and ref semantics.

## 2. Shapes

### 2.1 The adapter layer

```text
src/adapters/git/          // the only new layer; consumes, never re-owns
  index.ts                 // barrel; the tests' only entry
  <implementation modules> // the mapping the binding owns
```

- The layer implements the ports as they exist: `ExecutionLedger`
  construction over a repository path, `AttemptRegister` ordinal
  allocation, `ClaimStore` accept/reject, the artifact producer —
  signatures unchanged. A port widened only if implementation demands
  it, through its own PR (§1 non-goals).
- Layering: nothing under `core/domain/` reaches the layer (structural,
  ADR-0001); `src/execution/` does not import it; the package gains no
  runtime dependency (the house rule — how the binding invokes git is
  the implementation PR's choice under that rule).
- The isolation gate extends to the layer: the engine's suite runs green
  with the binding absent, and no engine module names a ref, an object,
  or a repository path (ADR-0009 decision 3).

### 2.2 The persistence guarantees (fork 16)

For every persisted scope — an attempt's ledger records, the register's
ordinal counter, the decision-record stream:

1. **Canonical form.** Records persist exactly as the engine holds them:
   the canonical serialized form the fingerprints already pin. The
   binding adds no fields, no wrappers, no envelope of its own.
2. **Forward-only.** A persisted history only ever extends: any write
   that is not an extension of the recorded history is refused by the
   binding before git sees it. The refusal is a recorded decision, never
   a thrown surprise outside the door.
3. **Byte-exact reload.** Reloading a scope yields the same values the
   writer held — `toStrictEqual` equality is the test's shape — and
   `classifyResume` over a reloaded tail must equal classification over
   the original, record for record.
4. **One discipline for every scope.** Ledger, register, decision
   records: the same guarantees, no second storage format (D14's
   "persistence is adjacent" resolves as adjacency, not divergence).

The reference mapping (the implementation PR may refine it, never the
guarantees): each scope anchors to exactly one ref whose history is the
append sequence — every append one commit holding one new blob in
canonical form; the read path reconstructs the tail from the ref's tip
by walking the first-parent history; the ordinal counter is a
fast-forward-only ref whose tip encodes the next ordinal.

### 2.3 The tag-push CAS (E-07)

```text
accept(claim) →
  tag absent at the recorded base  → created, accepted
  tag present                      → refused, conflict recorded
```

- The atomic accept is git's ref creation — check-and-set at the ref.
  The deterministic winner the protocol already elects (ADR-0005
  decisions 4–5) is physically enforced by the object store: two
  writers, one ref, exactly one winner.
- The loser holds `abandoned(follower-of:<winner>)` — the shape Phase 4
  locked — and the conflict is a recorded decision (E-02's conflict
  vocabulary), never an exception crossing the door.
- Force updates, deletions, and re-creations under an existing ref
  refuse at the same door with the same recorded-reason discipline.
- Tags remain the authoritative record (P-01): the binding never
  substitutes a ledger row for the ref, and never records a completion
  the ref did not take.

### 2.4 The ref-side namespace door (E-08, M-11)

- The door precedes every tag write: a tag outside the namespace the
  attempt's own plan values declare is refused before git sees it, with
  the refusal naming the tag, the namespace, and the declared source.
- The global tag-namespace precondition (M-11) is honoured physically:
  two scopes racing one global namespace resolve through the same CAS —
  the second writer's accept refuses on the ref, not on a bookkeeping
  row.
- The door reads declared namespaces from the attempt's carried values
  only — no registry, no network, no working-tree reads (ADR-0009
  decision 5's locality).

### 2.5 The git-backed producer (ADR-0008 decision 12's first half)

- The producer observes recorded content — the recorded tree's content,
  never working-tree state — and returns a digest of that content:
  stable across identical content, different under any content change.
- The digest is opaque to the engine (ADR-0008 decision 2, unchanged):
  the binding computes it, the engine records it verbatim into the
  generation triple and the content fingerprint.
- Registry/remote interaction stays Phase 9's: the producer's entire
  surface is content in, digest out.

## 3. Laws

- No clock, randomness, environment, network, or registry reads in the
  binding beyond the repository it is opened on; no provider behavior
  (ADR-0009 decision 7). The isolation gate extends in the
  implementation PR.
- Determinism twice over: double-run over fresh repositories
  classifies identically; persist–reload equivalence — the reloaded
  tail classifies identically (§2.2.3).
- Forward-only is absolute: no rewrite, no truncate-and-reappend, no
  history surgery through any public door of the binding.
- Records deep-freeze on append (the ledger's discipline, unchanged);
  values crossing the binding freeze on the same terms.
- Tests import through the barrels only — `../src/index.ts` for the
  engine, the adapter barrel for the binding (ADR-0001 decision 9's
  shape, extended).
- No runtime dependencies; the kernel's purity layering is untouched.

## 4. Test obligations

All engine-facing tests import through `../src/index.ts` only; binding
tests use the adapter barrel and real (temporary) repositories. The
phase's named fixtures:

1. **Persist–reload equivalence** — a completed attempt's records, the
   register's ordinal, and the decision-record stream reload byte-exact
   into fresh values; `classifyResume` over the reloaded tail equals
   classification over the original; double-run over persist–reload
   classifies identically.
2. **Forward-only refusal** — a write that would rewrite or diverge from
   the recorded history refuses at the door with a recorded reason;
   nothing on disk moves; the refused door leaves the tail readable and
   classifiable.
3. **CAS winner/loser under concurrency** — two writers accept the same
   tag: exactly one creation lands, the loser records
   `abandoned(follower-of:…)` with the winner named; the ref's tip names
   the winner; a force update and a re-creation refuse.
4. **Namespace door** — a tag outside the declared namespace refuses
   before git sees it (no ref created), naming tag, namespace, and
   source; two scopes racing one global namespace resolve through the
   CAS; a namespace-legal tag passes untouched.
5. **Digest-sourced generations** — the git-backed producer's digest
   changes with content and is stable across identical content;
   `scheduleArtifacts` over the binding's producer completes the
   generation through the same public doors; the publish gate accepts
   only over the completed generation (Phase 7's gate, now fed by real
   content).
6. **Isolation** — the engine suite runs green with the adapter absent;
   no engine module imports the adapter (the isolation gate's new
   layer); the adapter suite never imports engine internals beyond the
   barrel.
