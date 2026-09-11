/**
 * The CLI's closed grammar (phase 12 contract §2.2) — the flag table as
 * executable data, not prose. One command per `Engine` door; every flag
 * maps onto exactly one boundary value, and a flag outside a command's
 * inventory is a usage fault, never an ignored token. `test/cli/grammar.test.ts`
 * pins this table against §2.2's rows and asserts the deliberately absent
 * flags (`--target`, `--naming-module`, `--declarations`) absent (§6
 * obligation 4), so a grammar drift fails the suite that names it.
 */

/** The commands — one per `Engine` door (§2.2's table, verbatim). */
export const COMMANDS = ["plan", "run", "resume", "resolve", "abort", "show"] as const;

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
    "",
    "  assembly flags: --repo <path> --tag-namespace <ns> (git only, repeatable)",
    "                  --max-retries <n> (default 0)",
  ].join("\n");

/** The help spellings — the whole-process question, answered in the
 * command position before the grammar dispatches (§2.2). Deliberately in
 * NO command's inventory: the inventories stay closed
 * (`test/cli/grammar.test.ts` pins `help`/`h` absent), so `run --help`
 * remains the usage fault that prints the same synopsis; only the
 * whole-process question is answered, on stdout, exit 0. */
export const HELP_FLAGS: readonly string[] = ["--help", "-h"];

/** The help text (§2.2): the fault synopsis — `usageText`, reused, never
 * duplicated — plus the one block the synopsis omits, the intent
 * spellings (§2.2's five rows, the same list the intent parser's own
 * fault names). Built from the synopsis so a grammar row cannot drift
 * from help: there is one grammar text, and this is its whole rendering. */
export const helpText = (): string =>
  [
    usageText(),
    "",
    "  intents (--intent, repeatable):",
    "    release | release-anyway | prerelease:<stream>:<lineId>",
    "    release-as:<version> | promote:<lineId>",
    "",
    "  help: release-craft --help | -h prints this text and exits 0",
  ].join("\n");
