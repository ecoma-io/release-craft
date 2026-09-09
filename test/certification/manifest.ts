/**
 * The certification fixture's executable census (phase 14 contract §5) —
 * one committed row per cell, and the laws that make the manifest
 * enforced rather than decorative.
 *
 * Row schema (§5): id, kind, walk, windows, assembly, transports, classes,
 * expectedFiles, provenance, status, and — per status — reachability
 * (typed rows), enforcement (census-only), refusal (refused).
 *
 * The laws this module computes and `census.test.ts` asserts:
 *
 * - the **executable census**: every row's window claim is a (window,
 *   carrier-scope) pair. An earned row (any non-refused status) claims its
 *   windows at its transports; a refused row claims its windows at the
 *   scope its refusal names — so a window refused on the process
 *   transports and earned on the boundary is two pairs, not a
 *   contradiction (I3ext's exact shape). `earned ∪ refused == taxonomy`
 *   (coverage against the recorded taxonomy of `matrix.ts`, never against
 *   this manifest's own copy) and `earned ∩ refused == ∅` (disjointness at
 *   pair granularity).
 * - **manifest completeness**: unique ids; non-refused rows carry an
 *   assembly and transports; every class is on the recorded pinned-class
 *   list (R4); typed rows name a reachability note and mover; census-only
 *   rows name their enforcement; refused rows name their refusing rule.
 * - **expected/ orphans, either direction**: no file without a row, no row
 *   naming an absent file.
 * - **produced by a test**: every `live` or `typed-row` cell id is claimed
 *   by a test name in its assembly's suite (census-only and refused rows
 *   are exempt — they carry their named enforcement instead).
 * - **the isolation probe**: no environment, clock, or randomness read,
 *   and no non-barrel `src/` import, anywhere under the fixture's own
 *   modules (phase 14 §9).
 * - **the refusal-inventory probe**: no fixture module names a refused
 *   input (phase 12 §6.4 and phase 13 §6.6's pattern, inherited).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { TAXONOMY, type WindowId } from "./matrix.js";

/** The fixture directory — every law here reads the fixture's own modules
 * from this directory, fresh, so a new file is judged without registration. */
export const FIXTURE_DIR = import.meta.dirname;

// ---------------------------------------------------------------------------
// The recorded vocabularies
// ---------------------------------------------------------------------------

export const ASSEMBLIES = [
  "A-memory",
  "A-git",
  "A-cross-process",
  "the repository itself",
] as const;
export type Assembly = (typeof ASSEMBLIES)[number];

export const TRANSPORTS = ["CLI", "boundary", "Action"] as const;
export type Transport = (typeof TRANSPORTS)[number];

export const STATUSES = ["live", "typed-row", "census-only", "refused"] as const;
export type RowStatus = (typeof STATUSES)[number];

export const ROW_KINDS = ["windowed", "posture"] as const;
export type RowKind = (typeof ROW_KINDS)[number];

/** §4.2's class list — the pinned-class list R4 judges against. Closed. */
export const EXPECTATION_CLASSES = [
  "exit codes",
  "outcome kinds and envelope shapes",
  "envelope bytes",
  "pass-through equality",
  "tag mints",
  "ledger projections",
  "action conclusions and output bytes",
] as const;
export type ExpectationClass = (typeof EXPECTATION_CLASSES)[number];

// ---------------------------------------------------------------------------
// The row schema
// ---------------------------------------------------------------------------

export interface ManifestRow {
  /** The cell id — and the expected/ file's name for byte-pinned cells. */
  readonly id: string;
  readonly kind: RowKind;
  /** The walk, when the cell walks one; posture rows carry null. */
  readonly walk: string | null;
  /** The windows the cell claims — empty for the declared posture rows,
   * which make no window claim and so stay outside R0's reach. */
  readonly windows: readonly WindowId[];
  /** Null only on refused rows whose refusal spans assemblies. */
  readonly assembly: Assembly | null;
  readonly transports: readonly Transport[];
  readonly classes: readonly ExpectationClass[];
  /** The committed byte files, when the cell has them — paths relative to
   * the fixture directory (`expected/git-01.json`). */
  readonly expectedFiles: readonly string[];
  /** The owning contract sections. */
  readonly provenance: readonly string[];
  readonly status: RowStatus;
  /** Typed rows: the declared-unreachable note and its mover. */
  readonly reachability?: { readonly note: string; readonly mover: string };
  /** Census-only rows: where the pin lives instead. */
  readonly enforcement?: string;
  /** Refused rows: the refusing rule and the carrier scope it claims. */
  readonly refusal?: {
    readonly rule: string;
    readonly scopes: readonly string[];
    readonly note: string;
  };
}

// ---------------------------------------------------------------------------
// The manifest — §3.3's thirty-four earned cells, §3.4's eleven refusals
// ---------------------------------------------------------------------------

export const MANIFEST: readonly ManifestRow[] = [
  // — A-memory (phase 14 §3.3) —
  {
    id: "memory-01",
    kind: "windowed",
    walk: "W4",
    windows: [],
    assembly: "A-memory",
    transports: ["CLI"],
    classes: ["exit codes", "envelope bytes"],
    expectedFiles: ["expected/memory-01.json"],
    provenance: ["phase 14 §3.3", "phase 2 §2.14 (the planner's purity at the process)"],
    status: "live",
  },
  {
    id: "memory-02",
    kind: "windowed",
    walk: "W1",
    windows: [],
    assembly: "A-memory",
    transports: ["CLI", "boundary"],
    classes: ["exit codes", "envelope bytes", "outcome kinds and envelope shapes", "tag mints"],
    expectedFiles: ["expected/memory-02.json"],
    provenance: [
      "phase 14 §3.3",
      "R2 (memory's published-without-mint distinction; `assembleMemoryStores` wires `mint: null`, verified)",
    ],
    status: "live",
  },
  {
    id: "memory-03",
    kind: "windowed",
    walk: "W5",
    windows: ["I1"],
    assembly: "A-memory",
    transports: ["boundary"],
    classes: ["exit codes", "envelope bytes", "outcome kinds and envelope shapes"],
    expectedFiles: ["expected/memory-03.json"],
    provenance: [
      "phase 14 §3.3",
      "phase 4 §2.4 (E-07 at the process; the pass-through on a stop)",
      // Recorded transport narrowing: the contract's CLI half is
      // unreachable on A-memory — a one-shot process builds a FRESH
      // MemoryClaimStore (selectEngine) whose seed is constructor-only, so
      // no process can ever render another run's denial; empirically the
      // second identical CLI run publishes with exit 0, never 11. The exit
      // 11 row is earned at the CLI by git-04 over the durable register.
    ],
    status: "live",
  },
  {
    id: "memory-04",
    kind: "windowed",
    walk: "W5",
    windows: ["I2"],
    assembly: "A-memory",
    transports: ["boundary"],
    classes: ["exit codes"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "phase 4 §2.4 item 5 (E-08's declared bound, both sides; the flag-to-kernel-clause crossing)",
      // Recorded transport narrowing: the contract's CLI half is
      // unreachable on A-memory for the same reason as memory-03 — the
      // fresh per-process claim store never denies, so the retry bound is
      // never crossed and exit 14 cannot render; empirically confirmed.
      // The exit 14 row is earned at the CLI by git-05 over the durable
      // register; the raised-bound side publishes here (the 0 row).
    ],
    status: "live",
  },
  {
    id: "memory-05",
    kind: "windowed",
    walk: "W1",
    windows: ["I3"],
    assembly: "A-memory",
    transports: ["boundary"],
    classes: ["exit codes", "ledger projections"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "ADR-0006 decision 2 (the write-ahead discipline)",
      "phase 11 §5 obligation 5 (the crash posture, cell-ized)",
      "R2 (the fault seats at the memory factory's declared store parameters)",
    ],
    status: "live",
  },
  {
    id: "memory-06",
    kind: "windowed",
    walk: "W1",
    windows: ["I3ext"],
    assembly: "A-memory",
    transports: ["boundary"],
    classes: ["exit codes", "ledger projections"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "phase 10 §3.5 (the resumed hook)",
      "ADR-0007 decision 6",
      "phase 14 §8 (the fixture's only declared-injection cell class — a caller posture, not a user-code surface)",
    ],
    status: "live",
  },
  {
    id: "memory-07",
    kind: "windowed",
    walk: "W1",
    windows: ["I7"],
    assembly: "A-memory",
    transports: ["boundary"],
    classes: ["exit codes", "outcome kinds and envelope shapes"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "phase 5 §2.3 (E-05's refusal rendered at the surface)",
      "R2 (through the declared port-seam window — the ShiftingLedger-class wrapper, the app harness's own pattern)",
    ],
    status: "live",
  },
  {
    id: "memory-08",
    kind: "windowed",
    walk: "W1",
    windows: ["I8"],
    assembly: "A-memory",
    transports: ["boundary"],
    classes: ["exit codes", "ledger projections"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "phase 5 §2.7 (the blocked loop live)",
      "R1's declared-injection note, satisfied (the typed rows `blocked` and `resolved` made reachable on the embedder surface)",
    ],
    status: "live",
  },
  {
    id: "memory-09",
    kind: "posture",
    walk: null,
    windows: [],
    assembly: "A-memory",
    transports: ["CLI"],
    classes: ["exit codes", "outcome kinds and envelope shapes"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "phase 12 §2.7 (the store-less channels corner; never a null that reads as no channels recorded)",
    ],
    status: "live",
  },
  {
    id: "memory-10",
    kind: "posture",
    walk: null,
    windows: [],
    assembly: "A-memory",
    transports: ["CLI", "boundary"],
    classes: ["envelope bytes"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "phase 14 §4.3 (the zero-random assembly's determinism — the control that proves the projection rule is the only delta between recorded and live git bytes)",
    ],
    status: "live",
  },

  // — A-git —
  {
    id: "git-01",
    kind: "windowed",
    walk: "W2",
    windows: [],
    assembly: "A-git",
    transports: ["CLI"],
    classes: ["exit codes", "envelope bytes", "outcome kinds and envelope shapes", "tag mints"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "phase 12 §3.1 (the envelope pinned as reviewed bytes; the minted 5.0.0; the drives list riding verbatim)",
      "ADR-0012 (the promote door end to end)",
    ],
    status: "live",
  },
  {
    id: "git-02",
    kind: "windowed",
    walk: "W3",
    windows: [],
    assembly: "A-git",
    transports: ["CLI"],
    classes: ["exit codes", "envelope bytes", "tag mints"],
    expectedFiles: [],
    provenance: ["phase 14 §3.3", "P-07's shape; M-02's cross-line independence at the process"],
    status: "live",
  },
  {
    id: "git-03",
    kind: "windowed",
    walk: "W1",
    windows: [],
    assembly: "A-git",
    transports: ["CLI"],
    classes: ["exit codes", "tag mints"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "P-06 across processes (the durable claim register's recorded sequence is the only memory the second process has)",
    ],
    status: "live",
  },
  {
    id: "git-04",
    kind: "windowed",
    walk: "W5",
    windows: ["I1"],
    assembly: "A-git",
    transports: ["CLI", "boundary"],
    classes: ["exit codes", "outcome kinds and envelope shapes", "ledger projections"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "phase 4 §2.4 (E-07 over the durable register; the loser's records stand)",
    ],
    status: "live",
  },
  {
    id: "git-05",
    kind: "windowed",
    walk: "W5",
    windows: ["I2"],
    assembly: "A-git",
    transports: ["CLI", "boundary"],
    classes: ["exit codes", "outcome kinds and envelope shapes"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "phase 4 §2.4 item 5 (E-08 over the durable register; the fold parity pin — a denial with no recorded holder sequence conflicts immediately, D31's exclusion-path denials)",
    ],
    status: "live",
  },
  {
    id: "git-06",
    kind: "windowed",
    walk: "W2",
    windows: ["I10"],
    assembly: "A-git",
    transports: ["boundary"],
    classes: ["ledger projections"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "ADR-0012 decisions 3–4 (the moves land exactly in the write-ahead window; the replay classifies, never moves twice)",
    ],
    status: "live",
  },
  {
    id: "git-07",
    kind: "windowed",
    walk: "W2",
    windows: ["I9"],
    assembly: "A-git",
    transports: ["CLI", "boundary"],
    classes: ["exit codes"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "invariant 2.6; ADR-0012 decision 7 (the deterministic `.lock` fault — the CLI harness's own mechanism — pinned twice: the stop, and the read a proceeding caller would have had to misread)",
    ],
    status: "live",
  },
  {
    id: "git-08",
    kind: "windowed",
    walk: "W1",
    windows: ["I3"],
    assembly: "A-git",
    transports: ["boundary"],
    classes: ["envelope bytes", "ledger projections"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "ADR-0006 decision 2; E-01's crash doctrine",
      "phase 10 §3.4 (V7 — the 10.3/10.4 bytes-over-values law at the fixture: the resumed classification matches the uninterrupted run's; the tails compare byte-exact over the reloaded recorded evidence)",
    ],
    status: "live",
  },
  {
    id: "git-09",
    kind: "windowed",
    walk: "W2",
    windows: ["I4"],
    assembly: "A-git",
    transports: ["boundary"],
    classes: ["outcome kinds and envelope shapes"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "phase 4 §2.5 (E-01's no-return boundary live — tag recorded, plan valid, the doctrine resumes with the tag already satisfied; the one window whose verdict is not a re-run)",
    ],
    status: "live",
  },
  {
    id: "git-10",
    kind: "windowed",
    walk: "W3",
    windows: ["I5"],
    assembly: "A-git",
    transports: ["boundary", "CLI"],
    classes: ["exit codes", "ledger projections"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "ADR-0013 decision 4 (the fresh process re-running an aborted plan refuses, quoting the recorded actor, reason, and attempt id; the burned ordinal recorded explicitly)",
    ],
    status: "live",
  },
  {
    id: "git-11",
    kind: "windowed",
    walk: null,
    windows: ["I6"],
    assembly: "A-git",
    transports: ["boundary", "CLI"],
    classes: ["exit codes", "outcome kinds and envelope shapes"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "ADR-0013 decision 3 (terminal from the ledger alone — the named violation on a later resume of the carried attempt)",
      "phase 11 §2.7 and phase 12 §2.7 (the attempt store's posture beside it: one doctrine, both renderings, neither translated into the other)",
    ],
    status: "live",
  },
  {
    id: "git-12",
    kind: "windowed",
    walk: "W1",
    windows: ["I11"],
    assembly: "A-git",
    transports: ["CLI"],
    classes: ["exit codes", "envelope bytes"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "phase 12 §2.5 and §2.4 (the declared lie's two fault bands, each to its recorded section; two rows that must never collapse into one cell — the second leaves recorded evidence, the first leaves none)",
    ],
    status: "live",
  },
  {
    id: "git-13",
    kind: "posture",
    walk: null,
    windows: [],
    assembly: "A-git",
    transports: ["CLI"],
    classes: ["outcome kinds and envelope shapes"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "phase 12 §6.2 (the exit table's seven unreachable-today rows, exactly that class's letter)",
      "phase 12 §3.2 (the table the census counts)",
    ],
    status: "census-only",
    enforcement:
      "the exit-table cross-pin in the CLI's own suite (test/cli/exit-codes.test.ts) — the fixture's recorded copy of the table (test/certification/exit-table.ts) asserted equal to the CLI's EXIT_CODES record; the §8 import law bars a fixture-level pin and none is owed",
  },
  {
    id: "git-14",
    kind: "windowed",
    walk: null,
    windows: ["I12"],
    assembly: "A-git",
    transports: ["boundary"],
    classes: ["outcome kinds and envelope shapes"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "phase 11 §2.5 (the engine's own pre-walk refusal on the hand-built-request path — `handle: null`, `drives: []`; the row the CLI's planner-classified lie deliberately does not render, git-12's other half)",
    ],
    status: "live",
  },

  // — A-cross-process (phase 14 §3.5's posture) —
  {
    id: "x-01",
    kind: "posture",
    walk: null,
    windows: [],
    assembly: "A-cross-process",
    transports: ["CLI"],
    classes: ["exit codes", "pass-through equality"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.5",
      "phase 12 §6.7 (the pass-through pin, cell-ized: equality with what a fresh engine returns, so the durable attempt lookup moves the value and not the cell)",
      "phase 12 §2.7",
    ],
    status: "live",
  },
  {
    id: "x-02",
    kind: "posture",
    walk: null,
    windows: [],
    assembly: "A-cross-process",
    transports: ["CLI"],
    classes: ["exit codes", "outcome kinds and envelope shapes"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.5",
      "the one observation that works cross-process today: `show channels` reads the wired store's recorded states, not the carried entry",
    ],
    status: "live",
  },
  {
    id: "x-03",
    kind: "windowed",
    walk: null,
    windows: ["I5"],
    assembly: "A-cross-process",
    transports: ["CLI"],
    classes: ["exit codes"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.5",
      "ADR-0013 decision 4 (the abandonment refusal read by a stranger process — the derived-ordinal scan reads the ledger alone, so the process-local store's absence does not mute it)",
    ],
    status: "live",
  },
  {
    id: "x-04",
    kind: "posture",
    walk: null,
    windows: [],
    assembly: "A-cross-process",
    transports: ["CLI"],
    classes: ["outcome kinds and envelope shapes"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.5",
      "phase 12 §6.6's second half (the recorded replay — the exact expectation derived by hand before the first run, the goldens discipline, never asserted loosely)",
    ],
    status: "live",
  },

  // — the Action transport's scenario cells (phase 14 §6) —
  {
    id: "action-01",
    kind: "windowed",
    walk: "W2",
    windows: [],
    assembly: "A-git",
    transports: ["Action"],
    classes: ["action conclusions and output bytes"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "phase 13 §6 fixture 3 (the byte-equality and parse-replay scenario cell: the promote scenario's output write replayed against the runner's documented parse, byte-equal to git-01's recorded stdout; conclusion success)",
    ],
    status: "typed-row",
    reachability: {
      note: "The Action transport's mechanisms — the invocation script, the env construction, the output write, and the runner-parse replay — are the Action implementation's (phase 14 §2.2 transport 3, §6). The fixture owns the scenario data; the scenario's expected bytes are pinned here against git-01's committed stdout.",
      mover: "the Action implementation slice (phase 13's composite and invocation script)",
    },
  },
  {
    id: "action-02",
    kind: "windowed",
    walk: "W5",
    windows: ["I1", "I2", "I12"],
    assembly: "A-git",
    transports: ["Action"],
    classes: ["action conclusions and output bytes"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "phase 13 §6 fixture 2 (the conclusion table's reachable rows instantiated with this contract's scenarios: `denied`, `refused`, `conflict` — each with its exit, its envelope kind, and its annotation fields verbatim)",
    ],
    status: "typed-row",
    reachability: {
      note: "The conclusion table's rows are recorded data owned here (phase 14 §6); the invocation script that drives them is the Action implementation's.",
      mover: "the Action implementation slice (phase 13's composite and invocation script)",
    },
  },
  {
    id: "action-03",
    kind: "windowed",
    walk: null,
    windows: ["I11"],
    assembly: "A-git",
    transports: ["Action"],
    classes: ["action conclusions and output bytes"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "phase 13 §3.2 (the fault rows: exit 64 and exit 70 scenarios conclude failure with the fault text verbatim, stdout empty — pinned by the render module's own law)",
    ],
    status: "typed-row",
    reachability: {
      note: "The fault scenarios are recorded data owned here; the invocation script and its stderr capture are the Action implementation's.",
      mover: "the Action implementation slice (phase 13's composite and invocation script)",
    },
  },
  {
    id: "action-04",
    kind: "posture",
    walk: null,
    windows: [],
    assembly: "A-git",
    transports: ["Action"],
    classes: ["action conclusions and output bytes"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "phase 13 §3.2 (the no-verdict row instantiated: a killed child, an unparseable envelope, a kind↔exit mismatch — each fails with the raw evidence, never green, never neutral)",
    ],
    status: "typed-row",
    reachability: {
      note: "The no-verdict scenarios are recorded data owned here; the killed-child and unparseable-envelope mechanisms are the Action implementation's.",
      mover: "the Action implementation slice (phase 13's composite and invocation script)",
    },
  },
  {
    id: "action-05",
    kind: "windowed",
    walk: "W2",
    windows: [],
    assembly: "A-git",
    transports: ["Action"],
    classes: ["action conclusions and output bytes"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "phase 13 §6 fixture 4 (the hostile ambient, verbatim: lying `GITHUB_*` values, `ACTIONS_*`, `RUNNER_*`, `CI=true`, an `INPUT_WORLD` naming a different document, a `GIT_DIR` pointing elsewhere, a `NODE_OPTIONS` carrying a marker, a token-shaped `GH_TOKEN` — and no planted value reachable in the envelope, the annotation, or the conclusion; the envelope equals the clean run, byte for byte)",
    ],
    status: "typed-row",
    reachability: {
      note: "The hostile scenario's planted ambient is recorded data owned here; the env -i construction that starves it is the Action implementation's (phase 13 §4).",
      mover: "the Action implementation slice (phase 13's composite and invocation script)",
    },
  },
  {
    id: "action-06",
    kind: "posture",
    walk: null,
    windows: [],
    assembly: "the repository itself",
    transports: ["Action"],
    classes: ["action conclusions and output bytes"],
    expectedFiles: [],
    provenance: [
      "phase 14 §3.3",
      "phase 13 §6 fixture 1 (the drift row as scenario data: the composite's declared toolchain values paired with the repository's `.node-version` and `packageManager`; the row's data — which files, which fields — is owned here, the mechanism is the Action implementation's)",
    ],
    status: "typed-row",
    reachability: {
      note: "The drift pairing's data is owned here (which files, which fields); the composite whose declared values the pairing reads does not exist on this base.",
      mover: "the Action implementation slice (phase 13's composite front door)",
    },
  },

  // — the refusals (phase 14 §3.4) —
  {
    id: "refused-01",
    kind: "windowed",
    walk: null,
    windows: ["I3ext"],
    assembly: null,
    transports: [],
    classes: [],
    expectedFiles: [],
    provenance: ["phase 14 §3.4", "R1"],
    status: "refused",
    refusal: {
      rule: "R1",
      scopes: ["CLI", "Action"],
      note: "Any hook or artifact window (I3ext) on a process transport: the CLI v1 executes the empty declaration (phase 12 §2.6); the Action inherits it (phase 13 §2.3's refused `declarations`). The window is the boundary transport's, with declared injection.",
    },
  },
  {
    id: "refused-02",
    kind: "windowed",
    walk: null,
    windows: ["I4"],
    assembly: "A-memory",
    transports: [],
    classes: [],
    expectedFiles: [],
    provenance: ["phase 14 §3.4", "R2"],
    status: "refused",
    refusal: {
      rule: "R2",
      scopes: ["A-memory"],
      note: "Any tag, mint, or post-tag window on A-memory: the memory assembly wires no tag door (`mint: null`, verified) — the tag boundary is the git assembly's.",
    },
  },
  {
    id: "refused-03",
    kind: "posture",
    walk: null,
    windows: [],
    assembly: "A-memory",
    transports: [],
    classes: [],
    expectedFiles: [],
    provenance: ["phase 14 §3.4", "R2"],
    status: "refused",
    refusal: {
      rule: "R2",
      scopes: ["A-memory"],
      note: "Any cross-process cell on A-memory: nothing persists; a second memory process is a second universe, and pinning it would certify amnesia (the durability reasoning phase 13 §2.6 used to pin the Action's assembly to git).",
    },
  },
  {
    id: "refused-04",
    kind: "posture",
    walk: null,
    windows: [],
    assembly: null,
    transports: [],
    classes: [],
    expectedFiles: [],
    provenance: ["phase 14 §3.4", "R1"],
    status: "refused",
    refusal: {
      rule: "R1",
      scopes: [],
      note: "Supersession windows (E-11, PL-08): the boundary has no supersede door (phase 11 §6) — the fixture cannot pin what no door performs; the slice that lands the door owns the cells.",
    },
  },
  {
    id: "refused-05",
    kind: "posture",
    walk: null,
    windows: [],
    assembly: null,
    transports: [],
    classes: [],
    expectedFiles: [],
    provenance: ["phase 14 §3.4", "R1"],
    status: "refused",
    refusal: {
      rule: "R1",
      scopes: [],
      note: "Multi-line and whole-plan cells: one line per run is the boundary's declared posture (phase 11 §4 question 7); a whole-plan cell would design the cross-line claim-ordering decision that slice owns.",
    },
  },
  {
    id: "refused-06",
    kind: "posture",
    walk: null,
    windows: [],
    assembly: null,
    transports: [],
    classes: [],
    expectedFiles: [],
    provenance: ["phase 14 §3.4", "R1"],
    status: "refused",
    refusal: {
      rule: "R1",
      scopes: [],
      note: "World-reader cells (a world derived from the repository): no alternative world source exists (phase 12 §7's slice); the fixture's worlds are declared documents, exactly the surfaces' posture.",
    },
  },
  {
    id: "refused-07",
    kind: "posture",
    walk: null,
    windows: [],
    assembly: null,
    transports: [],
    classes: [],
    expectedFiles: [],
    provenance: ["phase 14 §3.4", "R1"],
    status: "refused",
    refusal: {
      rule: "R1",
      scopes: [],
      note: "Publication and remote cells: nothing remote exists (ADR-0010's adapter is not wired to the run; phase 13 §2.8's token journey is decided empty).",
    },
  },
  {
    id: "refused-08",
    kind: "posture",
    walk: null,
    windows: [],
    assembly: null,
    transports: [],
    classes: [],
    expectedFiles: [],
    provenance: ["phase 14 §3.4", "R1"],
    status: "refused",
    refusal: {
      rule: "R1",
      scopes: [],
      note: "A cell for the durable attempt lookup before it lands: the fixture pins today's refused posture (§3.5); the future cell is the change protocol's business, not a speculative pin.",
    },
  },
  {
    id: "refused-09",
    kind: "posture",
    walk: null,
    windows: [],
    assembly: null,
    transports: [],
    classes: [],
    expectedFiles: [],
    provenance: ["phase 14 §3.4", "R0"],
    status: "refused",
    refusal: {
      rule: "R0",
      scopes: [],
      note: "Any window outside the §3.1 taxonomy. A suspected missing window is filed against the contract that should record it, then it enters here — the census's coverage half makes an unrecorded-but-claimed window impossible and this row makes a claimed-but-unrecorded one a defect on sight.",
    },
  },
  {
    id: "refused-10",
    kind: "posture",
    walk: null,
    windows: [],
    assembly: null,
    transports: [],
    classes: [],
    expectedFiles: [],
    provenance: ["phase 14 §3.4", "phase 10 §1's law, inherited"],
    status: "refused",
    refusal: {
      rule: "standing refusal — not a performance suite",
      scopes: [],
      note: "Duration, timing, and performance assertions are refused outright (phase 10 §1's law, inherited).",
    },
  },
  {
    id: "refused-11",
    kind: "posture",
    walk: null,
    windows: [],
    assembly: null,
    transports: [],
    classes: [],
    expectedFiles: [],
    provenance: ["phase 14 §3.4", "R3"],
    status: "refused",
    refusal: {
      rule: "R3",
      scopes: [],
      note: "The kernel's and planner's own scenario matrices re-pinned end to end: the fixture pins crossings; the floors have their suites.",
    },
  },
];

// ---------------------------------------------------------------------------
// The executable census
// ---------------------------------------------------------------------------

/** One (window, carrier-scope) claim. */
export interface CensusPair {
  readonly window: WindowId;
  readonly scope: string;
  readonly row: string;
}

const pairKey = (pair: CensusPair): string => `${pair.window} @ ${pair.scope}`;

/** §5's census: the earned and refused (window, carrier-scope) claims over
 * the manifest's rows. Earned rows claim at their transports; refused rows
 * claim at the scopes their refusals name. */
export const censusPairs = (): {
  readonly earned: CensusPair[];
  readonly refused: CensusPair[];
} => {
  const earned: CensusPair[] = [];
  const refused: CensusPair[] = [];
  for (const row of MANIFEST) {
    if (row.status === "refused") {
      for (const window of row.windows) {
        for (const scope of row.refusal?.scopes ?? []) {
          refused.push({ window, scope, row: row.id });
        }
      }
      continue;
    }
    for (const window of row.windows) {
      for (const transport of row.transports) {
        earned.push({ window, scope: transport, row: row.id });
      }
    }
  }
  return { earned, refused };
};

/** The census verdict: `uncovered` lists taxonomy windows no pair claims;
 * `conflicts` lists pairs both earned and refused. Both empty is the law. */
export const census = (): {
  readonly uncovered: readonly WindowId[];
  readonly conflicts: readonly CensusPair[];
} => {
  const { earned, refused } = censusPairs();
  const refusedKeys = new Set(refused.map(pairKey));
  const claimedWindows = new Set<WindowId>([...earned, ...refused].map((pair) => pair.window));
  return {
    uncovered: TAXONOMY.filter((window) => !claimedWindows.has(window.id)).map(
      (window) => window.id,
    ),
    conflicts: earned.filter((pair) => refusedKeys.has(pairKey(pair))),
  };
};

// ---------------------------------------------------------------------------
// The completeness laws
// ---------------------------------------------------------------------------

/** Per-row field laws and cross-row uniqueness. Empty is the law. */
export const manifestDefects = (): string[] => {
  const defects: string[] = [];
  const ids = new Set<string>();
  for (const row of MANIFEST) {
    if (ids.has(row.id)) {
      defects.push(`${row.id}: duplicate manifest id`);
    }
    ids.add(row.id);
    if (!/^[a-z]+-\d{2}$/.test(row.id)) {
      defects.push(`${row.id}: the id is not in the fixture's <assembly>-<nn> shape`);
    }
    if (row.classes.length === 0 && row.status !== "refused") {
      defects.push(`${row.id}: a cell with no pinned class pins nothing (R4)`);
    }
    for (const klass of row.classes) {
      if (!EXPECTATION_CLASSES.includes(klass)) {
        defects.push(`${row.id}: class "${klass}" is not on §4.2's pinned-class list`);
      }
    }
    if (row.status === "refused") {
      if (row.refusal === undefined || row.refusal.rule.length === 0) {
        defects.push(`${row.id}: a refused row must name the rule that refuses it`);
      }
      if (row.expectedFiles.length > 0) {
        defects.push(`${row.id}: a refused row carries no expectation files`);
      }
      continue;
    }
    if (row.assembly === null) {
      defects.push(`${row.id}: a non-refused row names its assembly`);
    }
    if (row.transports.length === 0) {
      defects.push(`${row.id}: a non-refused row names its transports`);
    }
    if (row.status === "typed-row") {
      const note = row.reachability;
      if (note === undefined || note.note.length === 0 || note.mover.length === 0) {
        defects.push(`${row.id}: a typed row names its reachability note and its mover`);
      }
    }
    if (
      row.status === "census-only" &&
      (row.enforcement === undefined || row.enforcement.length === 0)
    ) {
      defects.push(`${row.id}: a census-only row names where its pin lives instead`);
    }
    if (row.kind === "posture" && row.windows.length > 0) {
      defects.push(`${row.id}: a posture row makes no window claim (R0 governs window claims)`);
    }
    if (row.kind === "windowed") {
      for (const window of row.windows) {
        if (!TAXONOMY.some((candidate) => candidate.id === window)) {
          defects.push(`${row.id}: window ${window} is not in the recorded taxonomy (R0)`);
        }
      }
    }
  }
  return defects;
};

/** The expected/ orphan law, both directions. `existingFiles` is the
 * listing of the fixture's `expected/` directory (relative names). */
export const expectedFileDefects = (existingFiles: readonly string[]): string[] => {
  const defects: string[] = [];
  const named = new Set<string>();
  for (const row of MANIFEST) {
    for (const file of row.expectedFiles) {
      named.add(file);
      if (!existingFiles.includes(file)) {
        defects.push(`${row.id}: names expected file ${file}, which does not exist`);
      }
    }
  }
  for (const file of existingFiles) {
    if (!named.has(file)) {
      defects.push(`expected file ${file} has no manifest row`);
    }
  }
  return defects;
};

/** The produced-by-a-test law: every `live` or `typed-row` cell id is
 * claimed by a test name in its assembly's suite. `suites` maps a suite
 * file's relative name to its text. Census-only and refused rows carry
 * their named enforcement instead and are exempt. Empty is the law. */
export const unproducedRows = (suites: Readonly<Record<string, string>>): string[] => {
  const defects: string[] = [];
  const suiteFor = (row: ManifestRow): string => {
    if (row.id.startsWith("memory-")) return "memory.test.ts";
    if (row.id.startsWith("git-")) return "git.test.ts";
    if (row.id.startsWith("x-")) return "cross-process.test.ts";
    return "action.test.ts";
  };
  for (const row of MANIFEST) {
    if (row.status !== "live" && row.status !== "typed-row") continue;
    const suite = suiteFor(row);
    const text = suites[suite];
    if (text === undefined) {
      defects.push(`${row.id}: its suite ${suite} does not exist yet`);
      continue;
    }
    const claims = new RegExp(
      `(?:it|test)(?:\\.skip|\\.todo)?\\(\\s*["'\`][^"'\`]*\\b${row.id}\\b`,
    );
    if (!claims.test(text)) {
      defects.push(`${row.id}: no test in ${suite} names it`);
    }
  }
  return defects;
};

// ---------------------------------------------------------------------------
// The executable laws over the fixture's own modules
// ---------------------------------------------------------------------------

/** Every fixture module's text, keyed by file name relative to the fixture
 * directory — the source set the probes judge, read fresh on each call.
 * `expected/` is data, not modules. `manifest.ts` — this module, the laws'
 * home — is the one exemption: the inventories must name what they ban
 * (the banned tokens and the refused inputs are data here), so the probes
 * scan every fixture module except their own inventory's home. This is the
 * same exemption phase 12 §6.4's negative inventory needs to state its own
 * list; the exemption covers exactly one file, and the drives, the
 * generator, and the suites are all judged. */
export const fixtureModules = (): Record<string, string> => {
  const modules: Record<string, string> = {};
  for (const entry of readdirSync(FIXTURE_DIR)) {
    if (!entry.endsWith(".ts") || entry === "manifest.ts") continue;
    modules[entry] = readFileSync(join(FIXTURE_DIR, entry), "utf8");
  }
  return modules;
};

const ISOLATION_BANNED: readonly { readonly token: string; readonly why: string }[] = [
  { token: "process.env", why: "an environment read" },
  { token: "Date.now", why: "a clock read" },
  { token: "new Date", why: "a clock read" },
  { token: "Math.random", why: "a randomness read" },
  { token: "randomBytes", why: "a randomness read" },
  { token: "hrtime", why: "a clock read" },
  { token: "performance.now", why: "a clock read" },
];

/** The isolation probe (phase 14 §9): no environment, clock, or randomness
 * read anywhere under the fixture's own modules. Empty is the law. */
export const isolationViolations = (): string[] => {
  const violations: string[] = [];
  for (const [file, text] of Object.entries(fixtureModules())) {
    for (const { token, why } of ISOLATION_BANNED) {
      if (text.includes(token)) {
        violations.push(
          `${file}: ${why} (${token}) — the fixture reads no environment, clock, or randomness`,
        );
      }
    }
  }
  return violations;
};

/** The fixture's import law (phase 14 §8): the fixture enters `src/` only
 * through the package barrel and the adapter barrel; the CLI enters only
 * as the built bin in a subprocess, never as an import. Empty is the law. */
export const importViolations = (): string[] => {
  const violations: string[] = [];
  const allowed = new Set(["index.js", "adapters/git/index.js"]);
  for (const [file, text] of Object.entries(fixtureModules())) {
    for (const match of text.matchAll(/from\s+"([^"]*\/src\/[^"]+)"/g)) {
      const spec = match[1] as string;
      const path = spec.replace(/^(?:\.\.\/)+src\//, "");
      if (!allowed.has(path)) {
        violations.push(
          `${file}: imports "${spec}" — only the package barrel and the adapter barrel are legal`,
        );
      }
    }
  }
  return violations;
};

/** The refusal-inventory probe (phase 14 §9, phase 12 §6.4 and phase 13
 * §6.6's pattern): a fixture module naming a refused input fails the suite
 * that names the inventory. Empty is the law. */
export const refusalInventoryViolations = (): string[] => {
  const refusedSpellings: readonly { readonly token: string; readonly input: string }[] = [
    { token: "--declarations", input: "the declarations surface input" },
    { token: "--target", input: "the run target input" },
    { token: "--naming-module", input: "the naming module input" },
    { token: "INPUT_ASSEMBLY", input: "the assembly Action input" },
  ];
  const violations: string[] = [];
  for (const [file, text] of Object.entries(fixtureModules())) {
    for (const { token, input } of refusedSpellings) {
      if (text.includes(token)) {
        violations.push(`${file}: names the refused ${input} (${token})`);
      }
    }
  }
  return violations;
};

/** The expected/ directory's listing — the orphan law's input. An absent
 * directory reads as empty: the law's finding is computed, not thrown. */
export const expectedFiles = (): string[] => {
  const dir = join(FIXTURE_DIR, "expected");
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `expected/${entry.name}`)
      .sort();
  } catch {
    return [];
  }
};

/** The suite sources the produced-by law judges, read fresh. */
export const suiteSources = (): Record<string, string> => {
  const suites: Record<string, string> = {};
  for (const suite of [
    "memory.test.ts",
    "git.test.ts",
    "cross-process.test.ts",
    "action.test.ts",
  ]) {
    const path = join(FIXTURE_DIR, suite);
    try {
      suites[suite] = readFileSync(path, "utf8");
    } catch {
      // A suite that does not exist yet is the produced-by law's finding,
      // not a probe crash.
    }
  }
  return suites;
};
