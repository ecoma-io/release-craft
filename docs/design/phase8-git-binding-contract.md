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
`AttemptRegister`, and `ClaimStore` ports; the tag-push CAS as the claim
store's one-ref accept with the binding's mint door; the ref-side
namespace door; a git-backed producer for the artifact seam;
persist–reload equivalence and double-run determinism over real
repositories; and the `channels` store port (ADR-0012 decision 6 — the
delivered slice; D37 records its physical decisions).

Non-goals: the GitHub adapter and any API/network behavior (Phase 9,
[ADR-0010](../adr/0010-github-adapter.md),
[phase9-github-adapter-contract.md](phase9-github-adapter-contract.md)); evidence
freshness rules (PR-03 — carried); any
change to `src/execution/`'s shapes (the in-memory references stay as the test
seam; if an implementation needs a port widened, that is its own reviewed
change, not a drive-by); authentication, remote synchronization, or anything
beyond local git object and ref semantics.

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

For every persisted scope — in Phase 8: an attempt's ledger records and
the register's ordinal counter. The decision-record stream is deferred
(§2.6): its discipline is fixed here for its future consumer, its
surface arrives with the consumer that needs it.

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
4. **One discipline for every scope.** Ledger and register: the same
   guarantees, no second storage format (D14's "persistence is
   adjacent" resolves as adjacency, not divergence) — and the deferred
   decision-record stream inherits exactly this discipline (§2.6).

The reference mapping (the implementation PR may refine it, never the
guarantees): each scope anchors to exactly one ref whose history is the
append sequence — every append one commit holding one new blob in
canonical form; the read path reconstructs the tail from the ref's tip
by walking the first-parent history; the ordinal counter is a
fast-forward-only ref whose tip encodes the next ordinal.

### 2.3 The tag-push CAS (E-07)

```text
accept(claim) →
  claim ref absent   → created, accepted (the ref's blob: the claim record)
  claim ref present  → refused, denied naming the winner's recorded holder

mint(tag, target) — the binding's tag door, not the port —
  no held claim on the tag   → refused, nothing written
  tag ref absent             → created at the supplied target
  tag ref present            → refused, conflict recorded
```

- The accept's atomic boundary is exactly one ref — the scope's claim
  ref under the binding's claim namespace, whose target blob is the
  claim's canonical JSON record. Check-and-set at the ref: two writers,
  one ref, exactly one winner; the deterministic winner the protocol
  already elects (ADR-0005 decisions 4–5) is physically enforced by the
  object store. An orphan object written before a refused ref update is
  unreachable and is not a claim; adjudication reads only the ref.
- The loser holds `abandoned(follower-of:<winner>)` — the shape Phase 4
  locked — and the conflict is a recorded decision (E-02's conflict
  vocabulary), never an exception crossing the door.
- A stable-version claim is a record, not a lease: `release` of its
  token is a no-op and a later `verify` still reads held — the release
  record stands (ADR-0009 decision 4; D33). The non-tag claims are leases: `release` is a
  check-and-set delete of the scope's claim ref; a later `verify` reads
  lost.
- The physical tag (`refs/tags/<tag>`) is minted at the binding's tag
  door — never inside `acquire`. The door admits the write only under a
  claim ref the calling attempt holds, takes the target (the attempt's
  recorded base) as a supplied value from the assembly — never chosen
  by the binding, no ambient `HEAD` — and creates if and only if the
  tag ref is absent.
- Force updates and re-creations under an existing ref refuse at both
  doors with the same recorded-reason discipline. Tags remain the
  authoritative record (ADR-0009 decision 4's tag door; D34): the binding never substitutes a ledger
  row for the ref, and never records a completion the ref did not take.

  Amendment proposed in #49 (ADR-0011; the implementation PR follows):
  the store holds one register ref per release line under the claim
  namespace — `refs/release-craft/claims/<sha256(lineId)>` — its blob the
  line's claim set in canonical form (`{"claims":[…]}`, sorted by the
  scope's canonical JSON), and every mutation is a compare-and-set of
  the whole set against the observed tip. The exclusion predicate and
  the accept are one atomic transition per line: the same CAS that
  creates the claim checked the line's other claims, and the scan's
  window (#47) does not exist. The CAS arbitrates one shared ref space —
  the writers of one repository, over that repository's own
  `refs/release-craft/*` — and its reach ends at the ref space's edge
  (#182): writers in different checkouts of one repository hold disjoint
  claim refs (a standard clone fetches only `refs/heads/*` and
  `refs/tags/*`; the adapter never fetches remote claim state — ADR-0010
  decision 3), so both acquire the same line and both mint, and the
  divergence surfaces at the consumer's push as a non-fast-forward
  rejection outside the engine's verdict vocabulary — the declared scope
  ADR-0011 decision 2 records and the negative capability test pins. A
  lost CAS re-reads and re-evaluates —
  it never adjudicates against stale state; releasing the last claim of
  a line leaves the empty register in place (the ref is never deleted,
  so the write path stays one primitive); and a claim-namespace blob
  that is not a register refuses loudly — the layout is total, and the
  per-scope layout's repositories fail on the first claim read rather
  than silently read as unclaimed. The exclusion-path denial carries no
  `holderSequence`; the same-scope adjudication denial carries the
  winner's sequence (issue #69's parity pin, folded into the rewrite).
  The amendment supersedes this section's stale text loudly rather
  than silently: the diagram above shows the two-step scan-then-create
  the register closes — under the register, `accept` reads "the line's
  register without the requested scope → created by a whole-set CAS,
  accepted; the register holding an excluding claim → refused, denied
  naming the winner's recorded holder"; the release paragraph's
  check-and-set delete of the scope's claim ref becomes the whole-set
  CAS removing **by token, never by scope**; the tag door's "under a
  claim ref the calling attempt holds" reads "under a claim record the
  calling attempt holds"; and §2.2's "each scope anchors to exactly
  one ref" keeps its word for the ledger, ordinal, and decision scopes
  — the claim scope's anchor is the line's register, not the scope's
  own ref.

### 2.4 The ref-side namespace door (E-08, M-11)

- The door runs at both doors, before any ref moves: a claim whose
  derived tag name lies outside the namespace the attempt's own plan
  values declare is refused before git sees it — the acquisition
  returns `ClaimDenied { refusal: "namespace" }` with `holder` absent —
  and a mint outside it returns
  `{ kind: "refused", reason: "namespace", detail }`; both name the
  tag, the namespace, and the declared source.
  A policy refusal has no winner; the claim state never moved. The
  `ClaimDenied` widening is the implementation's one reviewed port
  change (§1's non-goals, its own PR): `ClaimDenied.holder` becomes
  optional and carries the `refusal` marker; the in-memory store never
  sets it, and no engine behavior reads it.
- The global tag-namespace precondition (M-11) is honoured physically:
  two scopes racing one global namespace resolve through the same CAS —
  the second writer's accept refuses on the ref, not on a bookkeeping
  row.
- The door reads the declared tag naming from the configuration the
  binding is opened with — the plan's own declared values (D14's
  per-package naming as declared configuration) — no registry, no
  network, no working-tree reads (ADR-0009 decision 5's locality).

### 2.5 The git-backed producer (ADR-0008 decision 12's first half)

- The producer observes recorded content — the recorded tree's content,
  never working-tree state — and returns a digest of that content:
  stable across identical content, different under any content change.
- The digest is opaque to the engine (ADR-0008 decision 2, unchanged):
  the binding computes it, the engine records it verbatim into the
  generation triple and the content fingerprint.
- Registry/remote interaction stays Phase 9's: the producer's entire
  surface is content in, digest out.

### 2.6 The binding's public surface (the barrel)

The layer exports one constructor and its value through
`src/adapters/git/index.js` (consumed in tests via the package surface,
ADR-0009 decision 8):

```text
openGitBinding({ repo, tagNaming }) → GitBinding

GitBinding
  .ledger    : ExecutionLedger      (the port, git-backed)
  .register  : AttemptRegister      (the port, git-backed)
  .claims    : ClaimStore           (the port — acquire creates the claim
                                     ref; a namespace refusal returns
                                     ClaimDenied { refusal: "namespace" }
                                     with holder absent)
  .channels  : ChannelStore         (the port, ADR-0012 decision 6 — see
                                     below; the kernel never consumes it,
                                     invariant 2.1)
  .mintTag(input: { attemptId, token, tag, target }) → TagMintResult

TagMintResult =
  | { kind: "minted";   tag: string; target: string }
  | { kind: "refused";  reason: "namespace" | "unclaimed" | "foreign-token";
      tag: string; detail: string }
  | { kind: "conflict"; tag: string; detail: string }  // tag ref present —
                                                       // the existing ref wins

tagNaming: {
  namespaces: readonly string[],            // the declared namespace roots
  tagFor(scope: ClaimScope): string | null, // null = outside every declared
                                            // namespace → refused at acquire
}
```

- `refused` names the failure class — outside every declared namespace
  (`namespace`), no held claim derives that tag (`unclaimed`), or a
  claim is held but by another attempt's token (`foreign-token`); and
  `conflict` names a present tag ref. Every outcome's `detail` names
  the tag, the namespace, and the declared source. Refusals and
  conflicts are returned values, not exceptions: the caller records
  them through the ledger's own doors (E-02's conflict vocabulary).
  Nothing the door refused left state behind.
- `mintTag` is the binding's own door — it is not on the `ClaimStore`
  port. It verifies the token against a held claim whose derived tag
  name matches, requires `target` as a supplied value (a recorded base
  from the assembly — never `HEAD`, never ambient state), and creates
  the tag ref if and only if it is absent.
- The decision-record stream is explicitly out of Phase 8's surface.
  §2.2's third scope names a discipline, but no `DecisionRecord` shape
  exists in the engine today and no consumer records planner decision
  records yet — the contract invents neither. When the first consumer
  arrives, its door and its amendment land with it; the persistence
  discipline it inherits is already fixed here. Phase 8's fixture 1
  pins the two scopes the engine holds values for — the ledger tail
  and the register ordinal.

The channel store (ADR-0012 decision 6; D37): one ref per channel under
`refs/release-craft/channels/<sha256 of the channel id's UTF-8 bytes>` — the
claim register's own mapping, because channel ids are opaque strings a
refname cannot carry verbatim — whose tip commit's blob is the
canonical envelope `{"channel":{"id":…,"target":{…}|null}}`; a foreign
blob refuses loudly, and so does a shape-valid envelope whose id does
not map back onto the ref it was read from — one channel per ref, and
no writer of the canonical form produces a mis-keyed state. Reads are
total: an absent ref reads as the hidden channel, never as an error.
`applyTransition` is the whole-state compare-and-set with the store
computing the content fingerprint over the state it observed; the
outcomes are `applied` | `noop` | `conflict`
(naming the observed target) | `ambiguous` — the land-fault outcome,
decision 7's fail-closed law (read-side faults the substrate reports
stay throws: the substrate's `readRef` distinguishes an absent ref —
exit 1 with empty stderr, still the hidden channel, the total read —
from a ref git cannot read, which throws like a corrupted blob — #95,
D39). The port's
vocabulary is the serialized `ChannelState` (id + line + canonical
version string, or `null`), string-shaped like every record target; the
deterministic reference implementation (`MemoryChannelStore`) and the
shared `channelStateFingerprint` live in the execution layer beside the
port. The refs-read seam (§2.7's projection) does not enumerate the
channel family — consumers reach recorded channels through the port's
own reads.

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

1. **Persist–reload equivalence** — a completed attempt's records and
   the register's ordinal reload byte-exact into fresh values;
   `classifyResume` over the reloaded tail equals classification over
   the original; double-run over persist–reload classifies identically.
2. **Forward-only refusal** — a write that would rewrite or diverge from
   the recorded history refuses at the door with a recorded reason;
   nothing on disk moves; the refused door leaves the tail readable and
   classifiable.
3. **CAS winner/loser under concurrency** — two writers accept the same
   scope: exactly one claim ref is created, the loser records
   `abandoned(follower-of:…)` with the winner named; the ref's blob
   names the winner; a force update and a re-creation refuse. The tag
   door follows: the winner mints the tag at its supplied target
   (`minted`), a second mint of the same tag conflicts, a mint under
   another attempt's token refuses (`foreign-token`), and a mint with
   no claim refuses (`unclaimed`).
4. **Namespace door** — a claim whose derived tag name lies outside the
   declared namespaces refuses before git sees it (`ClaimDenied` with
   `refusal: "namespace"`, no holder, no ref created), naming tag,
   namespace, and source; a mint outside the namespaces refuses
   (`refused`, reason `namespace`); two scopes racing one global
   namespace resolve through the CAS; a namespace-legal claim and mint
   pass untouched.
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
