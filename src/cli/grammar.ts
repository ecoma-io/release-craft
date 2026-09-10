/**
 * The CLI's closed grammar (phase 12 contract §2.2) — the flag table as
 * executable data, not prose. One command per `Engine` door; every flag
 * maps onto exactly one boundary value, and a flag outside a command's
 * inventory is a usage fault, never an ignored token. `test/cli/grammar.test.ts`
 * pins this table against §2.2's rows and asserts the deliberately absent
 * flags (`--target`, `--naming-module`, `--declarations`) absent (§6
 * obligation 4), so a grammar drift fails the suite that names it.
 */

/** The commands — one per `Engine` door (§2.2's table, verbatim), plus
 * issue #208's two compatibility doors: `release-pr` (the Release PR
 * lifecycle's projection render) and `bootstrap` (issue #207's first-run
 * completion). */
export const COMMANDS = [
  "plan",
  "run",
  "resume",
  "resolve",
  "abort",
  "show",
  "release-pr",
  "bootstrap",
] as const;

export type CommandName = (typeof COMMANDS)[number];

/** The assembly choices — the two factories (§2.2: `assembleMemoryStores` /
 * `assembleGitBinding`). */
export const ASSEMBLIES = ["memory", "git"] as const;

export type AssemblyChoice = (typeof ASSEMBLIES)[number];

/** One command's slice of the closed inventory: the flags it accepts at
 * all, the ones it demands (usage fault when absent), the ones that
 * repeat (each occurrence is one boundary value — intents, namespace
 * roots), and the value-less ones. `positionals` is non-empty for `show`
 * alone (§2.2: the `attempt` / `channels` selector). */
export interface CommandGrammar {
  /** The closed flag inventory, `--`-less, in §2.2's table order. */
  readonly flags: readonly string[];
  /** Flags the command refuses to run without. */
  readonly demanded: readonly string[];
  /** Flags that accumulate — every occurrence is one value. */
  readonly repeatable: readonly string[];
  /** Flags that take no value. */
  readonly boolean: readonly string[];
  /** The accepted positional words, in order of mention; empty for every
   * command but `show`. */
  readonly positionals: readonly string[];
}

const ASSEMBLY_FLAGS = ["assembly", "repo", "tag-namespace", "max-retries"] as const;
const PROCESS_FLAGS = ["json"] as const;

/** The assembly flags every door accepts (the engine is constructed for
 * every door — `plan` included — so the assembly's structural check stands
 * behind every invocation), plus `--json`, the machine contract's switch
 * (§3.1). */
const COMMON_FLAGS: readonly string[] = [...ASSEMBLY_FLAGS, ...PROCESS_FLAGS];

/** §2.2's grammar block, executable. The per-command demand rules that a
 * flat list cannot carry (`resolve`'s resolution pairing, `show`'s
 * attempt-only handle flags) live beside the dispatch in `parse.ts`, with
 * this table as the closed inventory they may not exceed. */
export const GRAMMAR: Readonly<Record<CommandName, CommandGrammar>> = {
  plan: {
    flags: [...COMMON_FLAGS, "world", "intent"],
    demanded: ["assembly", "world"],
    repeatable: ["intent", "tag-namespace"],
    boolean: ["json"],
    positionals: [],
  },
  run: {
    flags: [...COMMON_FLAGS, "world", "intent", "actor", "line"],
    demanded: ["assembly", "world", "actor", "line"],
    repeatable: ["intent", "tag-namespace"],
    boolean: ["json"],
    positionals: [],
  },
  resume: {
    flags: [...COMMON_FLAGS, "world", "actor", "plan", "attempt", "line"],
    // `--line` is accepted but not demanded on resume: the carried
    // attempt's entry is authoritative for the line it executes (§2.2).
    demanded: ["assembly", "world", "actor", "plan", "attempt"],
    repeatable: ["tag-namespace"],
    boolean: ["json"],
    positionals: [],
  },
  resolve: {
    flags: [
      ...COMMON_FLAGS,
      "actor",
      "plan",
      "attempt",
      "step",
      "resolution",
      "note",
      "plan-fingerprint",
    ],
    demanded: ["assembly", "actor", "plan", "attempt", "step", "resolution"],
    repeatable: ["tag-namespace"],
    boolean: ["json"],
    positionals: [],
  },
  abort: {
    flags: [...COMMON_FLAGS, "actor", "plan", "attempt", "reason"],
    demanded: ["assembly", "actor", "plan", "attempt", "reason"],
    repeatable: ["tag-namespace"],
    boolean: ["json"],
    positionals: [],
  },
  show: {
    flags: [...COMMON_FLAGS, "actor", "plan", "attempt"],
    demanded: ["assembly"],
    repeatable: ["tag-namespace"],
    boolean: ["json"],
    positionals: ["attempt", "channels"],
  },
  "release-pr": {
    // The closed inventory maps every flag onto exactly one boundary
    // value: the identity triple (--component/--line/--target-branch),
    // the per-line scoping repeat, and the dry-run switch whose render
    // never mutates (issue #208: a "dry" run that writes is the worst
    // kind of silent failure). Release-please-shaped flags
    // (--release-type, --package-name, --token, ...) are outside the
    // inventory — a usage fault, never a defaulted input.
    flags: [
      ...COMMON_FLAGS,
      "world",
      "component",
      "line",
      "target-branch",
      "scope-line",
      "dry-run",
    ],
    demanded: ["assembly", "world", "component", "line", "target-branch"],
    repeatable: ["tag-namespace", "scope-line"],
    boolean: ["json", "dry-run"],
    positionals: [],
  },
  bootstrap: {
    // `--out` names the configuration document the door writes; the
    // pairing rule lives beside the dispatch in `parse.ts`: `--dry-run`
    // refuses `--out` (the render writes nothing) and a real run demands
    // it. The baseline policy and the line declarations the door proposes
    // are the app door's business, not flags.
    flags: [...COMMON_FLAGS, "world", "out", "dry-run"],
    demanded: ["assembly", "world"],
    repeatable: ["tag-namespace"],
    boolean: ["json", "dry-run"],
    positionals: [],
  },
};

/** The synopsis block printed with every usage fault — §2.2's grammar
 * block, wrapped to the process's own width. Diagnostics go to stderr
 * (§3.1); stdout stays empty for every fault. */
export const usageText = (): string =>
  [
    "release-craft <command> [flags]",
    "",
    "  plan    --assembly memory|git [assembly flags] --world <path|-> [--intent <i>]...",
    "  run     --assembly ... --world ... --actor <string> --line <lineId>",
    "          [--intent <i>]... [--max-retries <n>]",
    "  resume  --assembly ... --world ... --actor <string>",
    "          --plan <planId> --attempt <attemptId> [--line <lineId>]",
    "  resolve --assembly ... --actor <string>",
    "          --plan <planId> --attempt <attemptId> --step <stepKey>",
    "          ( --resolution human --note <string>",
    "          | --resolution revalidation --plan-fingerprint <fp> )",
    "  abort   --assembly ... --actor <string>",
    "          --plan <planId> --attempt <attemptId> --reason <string>",
    "  show    --assembly ... ( attempt --plan <planId> --attempt <attemptId> | channels )",
    "  release-pr --assembly ... --world ... --component <name> --line <lineId>",
    "             --target-branch <branch> [--scope-line <lineId>]... [--dry-run]",
    "  bootstrap  --assembly ... --world ... (--out <path> | --dry-run)",
    "",
    "  assembly flags: --repo <path> --tag-namespace <ns> (git only, repeatable)",
    "                  --max-retries <n> (default 0)",
  ].join("\n");
