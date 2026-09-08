/**
 * The CLI's hand-rolled argv parser (phase 12 contract §2.2): node
 * built-ins only, no argument-parser package (the repository carries no
 * runtime dependencies). The parser turns argv into a typed invocation
 * whose every field maps onto one boundary value, and it refuses — with a
 * usage fault, exit 64 — anything the closed grammar does not name.
 * Defaults are declared, never ambient: nothing is read from the
 * environment, the working directory, or anywhere else (§4).
 */

import type { ObservationQuery, OperatorIntent } from "../index.js";

import { parseIntents } from "./intents.js";
import { ASSEMBLIES, COMMANDS, GRAMMAR, type CommandName, usageText } from "./grammar.js";

/** A usage fault — the grammar's own refusal. Rendered to stderr with the
 * synopsis and mapped to exit 64; it never renders as an engine outcome
 * (§3.2: 64 is the usage band, not the `refused` kind). */
export class UsageFault extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "UsageFault";
  }
}

/** The assembly half of any invocation — what `selection.ts` consumes to
 * build the engine. The git spelling carries the demanded `--repo` and at
 * least one `--tag-namespace`; the memory spelling refuses both (a flag
 * the memory assembly cannot consume is a lie in argv — §2.2). */
export type AssemblySelection =
  | { readonly assembly: "memory"; readonly maxRetries: number }
  | {
      readonly assembly: "git";
      readonly repo: string;
      readonly tagNamespaces: readonly string[];
      readonly maxRetries: number;
    };

/** The `--resolution` spellings (§2.2): `human` carries the deciding
 * note; `revalidation` carries the fingerprint the block was raised
 * against. The pairing is exclusive — each spelling refuses the other's
 * flag. */
export type Resolution =
  | { readonly kind: "human"; readonly note: string }
  | { readonly kind: "revalidation"; readonly planFingerprint: string };

export type Invocation =
  | {
      readonly command: "plan";
      readonly world: string;
      readonly intents: readonly OperatorIntent[];
      readonly selection: AssemblySelection;
      readonly json: boolean;
    }
  | {
      readonly command: "run";
      readonly world: string;
      readonly actor: string;
      readonly line: string;
      readonly intents: readonly OperatorIntent[];
      readonly selection: AssemblySelection;
      readonly json: boolean;
    }
  | {
      readonly command: "resume";
      readonly world: string;
      readonly planId: string;
      readonly attemptId: string;
      readonly actor: string;
      readonly line: string | null;
      readonly selection: AssemblySelection;
      readonly json: boolean;
    }
  | {
      readonly command: "resolve";
      readonly planId: string;
      readonly attemptId: string;
      readonly actor: string;
      readonly stepKey: string;
      readonly resolution: Resolution;
      readonly selection: AssemblySelection;
      readonly json: boolean;
    }
  | {
      readonly command: "abort";
      readonly planId: string;
      readonly attemptId: string;
      readonly actor: string;
      readonly reason: string;
      readonly selection: AssemblySelection;
      readonly json: boolean;
    }
  | {
      readonly command: "show";
      readonly query: ObservationQuery;
      readonly selection: AssemblySelection;
      readonly json: boolean;
    };

interface Tokens {
  readonly values: Map<string, string>;
  readonly repeats: Map<string, readonly string[]>;
  readonly booleans: ReadonlySet<string>;
  readonly positionals: readonly string[];
}

const tokenize = (
  command: string,
  grammar: (typeof GRAMMAR)[keyof typeof GRAMMAR],
  rest: readonly string[],
): Tokens => {
  const values = new Map<string, string>();
  const repeats = new Map<string, readonly string[]>();
  const booleans = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) {
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    const name = equals < 0 ? body : body.slice(0, equals);
    const inline = equals < 0 ? undefined : body.slice(equals + 1);
    if (!grammar.flags.includes(name)) {
      throw new UsageFault(
        `unknown flag --${name} for command ${command} — the inventory is closed:` +
          ` ${grammar.flags.map((flag) => `--${flag}`).join(", ")}`,
      );
    }
    if (grammar.boolean.includes(name)) {
      if (inline !== undefined) {
        throw new UsageFault(`flag --${name} takes no value`);
      }
      booleans.add(name);
      continue;
    }
    const next = rest[index + 1];
    const value = inline ?? next;
    if (value === undefined) {
      throw new UsageFault(`flag --${name} demands a value`);
    }
    if (inline === undefined) {
      index += 1;
    }
    // The empty string is refused as a value everywhere except the one flag
    // whose empty value is meaningful: `--tag-namespace ""` is the declared
    // every-tag namespace root (§2.3).
    if (value.length === 0 && name !== "tag-namespace") {
      throw new UsageFault(`flag --${name} refuses the empty string as a value`);
    }
    if (grammar.repeatable.includes(name)) {
      const seen = repeats.get(name) ?? [];
      repeats.set(name, [...seen, value]);
      continue;
    }
    if (values.has(name)) {
      throw new UsageFault(`flag --${name} is declared once`);
    }
    values.set(name, value);
  }
  return { values, repeats, booleans, positionals };
};

const demandValues = (
  command: string,
  grammar: (typeof GRAMMAR)[keyof typeof GRAMMAR],
  tokens: Tokens,
): void => {
  for (const flag of grammar.demanded) {
    if (!tokens.values.has(flag)) {
      throw new UsageFault(`missing --${flag} — command ${command} demands it`);
    }
  }
};

const parseSelection = (tokens: Tokens): AssemblySelection => {
  const assembly = tokens.values.get("assembly");
  if (assembly === undefined || !(ASSEMBLIES as readonly string[]).includes(assembly)) {
    throw new UsageFault("--assembly must be memory | git");
  }
  const rawMaxRetries = tokens.values.get("max-retries");
  let maxRetries = 0;
  if (rawMaxRetries !== undefined) {
    if (!/^-?[0-9]+$/.test(rawMaxRetries)) {
      throw new UsageFault(`--max-retries "${rawMaxRetries}" is not an integer`);
    }
    const parsed = Number(rawMaxRetries);
    if (!Number.isSafeInteger(parsed)) {
      throw new UsageFault(`--max-retries "${rawMaxRetries}" is not an integer`);
    }
    maxRetries = parsed;
  }
  if (assembly === "memory") {
    if (tokens.values.has("repo")) {
      throw new UsageFault(
        "--repo feeds the git assembly only — the memory assembly carries no repository",
      );
    }
    if ((tokens.repeats.get("tag-namespace") ?? []).length > 0) {
      throw new UsageFault(
        "--tag-namespace feeds the git assembly only — the memory assembly declares no namespaces",
      );
    }
    return { assembly: "memory", maxRetries };
  }
  const repo = tokens.values.get("repo");
  if (repo === undefined) {
    throw new UsageFault("missing --repo — the git assembly demands the repository path");
  }
  const tagNamespaces = tokens.repeats.get("tag-namespace") ?? [];
  if (tagNamespaces.length === 0) {
    throw new UsageFault(
      "missing --tag-namespace — the git assembly demands at least one declared namespace root" +
        ' (the every-tag spelling is the empty string: --tag-namespace "")',
    );
  }
  return { assembly: "git", repo, tagNamespaces, maxRetries };
};

const demandExact = (command: string, flag: string, present: boolean, why: string): void => {
  if (!present) {
    throw new UsageFault(`missing --${flag} — ${why} (command ${command})`);
  }
};

const refuseIfPresent = (flag: string, present: boolean, why: string): void => {
  if (present) {
    throw new UsageFault(`--${flag} ${why}`);
  }
};

const isCommand = (value: string): value is CommandName =>
  (COMMANDS as readonly string[]).includes(value);

/** Parse argv into the typed invocation. Throws `UsageFault` for every
 * grammar violation; nothing else. */
export const parseArgv = (argv: readonly string[]): Invocation => {
  const [command, ...rest] = argv;
  if (command === undefined) {
    throw new UsageFault("no command given — one of " + COMMANDS.join(" | "));
  }
  if (!isCommand(command)) {
    throw new UsageFault(`unknown command "${command}" — one of ${COMMANDS.join(" | ")}`);
  }
  const grammar = GRAMMAR[command];
  const tokens = tokenize(command, grammar, rest);
  if (grammar.positionals.length === 0) {
    for (const positional of tokens.positionals) {
      throw new UsageFault(
        `unexpected positional "${positional}" — command ${command} takes only flags` +
          " (§2.2's grammar names no positional selector here)",
      );
    }
  } else if (tokens.positionals.length !== 1) {
    // The selector is a count, not a membership test: `show attempt
    // channels` would silently run the first and discard the second.
    throw new UsageFault(
      `command ${command} takes exactly one positional: ${grammar.positionals.join(" | ")}`,
    );
  } else {
    const selector = tokens.positionals[0];
    if (selector !== undefined && !grammar.positionals.includes(selector)) {
      throw new UsageFault(
        `unknown positional "${selector}" — command ${command} takes exactly one of: ` +
          grammar.positionals.join(" | "),
      );
    }
  }
  demandValues(command, grammar, tokens);
  const selection = parseSelection(tokens);
  const json = tokens.booleans.has("json");
  const string = (flag: string): string => {
    const value = tokens.values.get(flag);
    if (value === undefined) {
      throw new UsageFault(`missing --${flag} — command ${command} demands it`);
    }
    return value;
  };
  switch (command) {
    case "plan":
      return {
        command,
        world: string("world"),
        intents: parseIntents(tokens.repeats.get("intent") ?? []),
        selection,
        json,
      };
    case "run":
      return {
        command,
        world: string("world"),
        actor: string("actor"),
        line: string("line"),
        intents: parseIntents(tokens.repeats.get("intent") ?? []),
        selection,
        json,
      };
    case "resume":
      return {
        command,
        world: string("world"),
        planId: string("plan"),
        attemptId: string("attempt"),
        actor: string("actor"),
        line: tokens.values.get("line") ?? null,
        selection,
        json,
      };
    case "resolve": {
      const resolution = string("resolution");
      if (resolution === "human") {
        demandExact(
          command,
          "note",
          tokens.values.has("note"),
          "the human resolution carries the deciding note",
        );
        refuseIfPresent(
          "plan-fingerprint",
          tokens.values.has("plan-fingerprint"),
          "feeds the revalidation spelling only",
        );
        return {
          command,
          planId: string("plan"),
          attemptId: string("attempt"),
          actor: string("actor"),
          stepKey: string("step"),
          resolution: { kind: "human", note: string("note") },
          selection,
          json,
        };
      }
      if (resolution === "revalidation") {
        demandExact(
          command,
          "plan-fingerprint",
          tokens.values.has("plan-fingerprint"),
          "the revalidation spelling carries the fingerprint the block was raised against",
        );
        refuseIfPresent("note", tokens.values.has("note"), "feeds the human spelling only");
        return {
          command,
          planId: string("plan"),
          attemptId: string("attempt"),
          actor: string("actor"),
          stepKey: string("step"),
          resolution: { kind: "revalidation", planFingerprint: string("plan-fingerprint") },
          selection,
          json,
        };
      }
      throw new UsageFault(`--resolution "${resolution}" must be human | revalidation`);
    }
    case "abort":
      return {
        command,
        planId: string("plan"),
        attemptId: string("attempt"),
        actor: string("actor"),
        reason: string("reason"),
        selection,
        json,
      };
    case "show": {
      const selector = tokens.positionals[0];
      if (selector === undefined) {
        throw new UsageFault("command show takes exactly one positional: attempt | channels");
      }
      if (selector === "attempt") {
        demandExact(
          command,
          "plan",
          tokens.values.has("plan"),
          "the attempt query names the plan that minted it",
        );
        demandExact(
          command,
          "attempt",
          tokens.values.has("attempt"),
          "the attempt query names the attempt",
        );
        demandExact(
          command,
          "actor",
          tokens.values.has("actor"),
          "the handle is minted for an actor",
        );
        refuseIfPresent("line", tokens.values.has("line"), "is not in show's inventory");
        return {
          command,
          query: {
            kind: "attempt",
            handle: {
              planId: string("plan"),
              attemptId: string("attempt"),
              actor: string("actor"),
            },
          },
          selection,
          json,
        };
      }
      refuseIfPresent("plan", tokens.values.has("plan"), "feeds the attempt query only");
      refuseIfPresent("attempt", tokens.values.has("attempt"), "feeds the attempt query only");
      refuseIfPresent(
        "actor",
        tokens.values.has("actor"),
        "names an attempt's holder — the channels query takes none",
      );
      return { command, query: { kind: "channels" }, selection, json };
    }
  }
};

/** The rendered usage block — re-exported so the entrypoint renders the
 * synopsis from the same module that parses it. */
export { usageText };
