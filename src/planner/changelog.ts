/**
 * The changelog renderer (issue #206) — deterministic `CHANGELOG.md` bytes
 * from the recorded plan's change set.
 *
 * The artifact pipeline records changelog digests and refuses publication of
 * unrecorded bytes (`changelog-unrecorded`, ADR-0010 decision 6); this module
 * is the producer behind those strong semantics: a pure projection of the
 * plan's declared content into conventional-changelog-compatible markdown.
 *
 * The compatibility bar is release-please's changelog builder
 * (docs/design/release-please-baseline.md §3): `## <version>` headings,
 * `###` sections derived from a declared type→section mapping
 * (`changelog-sections` equivalent), bulleted entries, a dedicated breaking
 * section, and prepend-into-existing or create-fresh updates (§3.1–§3.5).
 * Row 4 of the release-model compatibility matrix adapts that format —
 * "same output format, internally owned template", so the template lives
 * here, byte-exact, not in an external preset dependency.
 *
 * Determinism is the module's whole point (issue #206's acceptance bar):
 *
 * - same input → byte-identical output, in every process, at every time;
 *   the tests beside this file pin it by double-render and by rendering
 *   onto the render's own output (the idempotence half);
 * - no clock, no environment, no filesystem, no network — the module
 *   imports nothing at all, so no ambient value can leak into the bytes.
 *   A date stamp (`date`) and a release link (`url`) are declared per
 *   version, never read; author attribution is deliberately omitted
 *   (issue #206: "attribution is recorded evidence or omitted" — the plan
 *   records no actor, so an ambient git config read would be the one way
 *   to invent one, and this module performs none);
 * - section order is the declared `sections` order, then surfacing — never
 *   dropping — every type the declaration does not name (the planner's own
 *   posture, applied to notes: "surfaced, never invisible").
 *
 * Rendered bytes enter through the existing artifact step (ledger record,
 * digest, verification — ADR-0008): this module returns bytes; the caller's
 * artifact producer records them in the recorded tree and the generation
 * record carries the digest. No new write path exists here.
 *
 * Caller contract violations (an empty subject, an empty type, an empty
 * version string) throw {@link InvalidChangelogInputError} naming the
 * offending field — the planner's surface-the-violation posture, never a
 * malformed bullet rendered silently.
 */

/** One rendered note — the change set's member projected for the changelog.
 * The caller builds it from recorded evidence (the plan plus the extraction
 * it recorded); nothing here reads a repository or an environment to fill
 * the gaps. */
export interface ChangelogEntry {
  /** The conventional-commit type (`feat`, `fix`, …) that groups the note. */
  readonly type: string;
  /** The note's subject — one line, verbatim. */
  readonly subject: string;
  /** The conventional-commit scope, rendered parenthesized when present. */
  readonly scope?: string;
  /** Breaking notes render under the dedicated breaking section, never in
   * their type's section — release-please's own placement (§3.4). */
  readonly breaking?: boolean;
  /** The recorded change identity (change id or commit sha). When present
   * together with the declared `repository`, the note carries a commit
   * link; without either half, no link is rendered. */
  readonly id?: string;
}

/** One released version's changelog entry — a plan line's target and change
 * set, newest first, in plan order (multiple lines release together, M-02,
 * and one CHANGELOG.md carries them all in the plan's own order). */
export interface ChangelogVersion {
  /** The version heading's text, verbatim (e.g. `1.2.0`, `1.2.0-rc.2`). */
  readonly version: string;
  /** The declared release date, rendered in the heading as release-please
   * does (`(YYYY-MM-DD)`). Declared input or omitted — never ambient
   * (issue #206: "any date stamp is declared input or omitted"). */
  readonly date?: string;
  /** The declared release link; the heading becomes `## [version](url)` —
   * the release-please link form (§3.5). Declared input or omitted. */
  readonly url?: string;
  /** The version's change set, in recorded order. */
  readonly entries: readonly ChangelogEntry[];
}

/** The declared type→section mapping — release-please's
 * `changelog-sections` equivalent (baseline §3.2). Order here is the
 * sections' render order; a `hidden` section's entries are excluded from
 * the notes, the declared-intent exclusion release-please offers. */
export interface ChangelogSection {
  /** The conventional-commit type this section groups. */
  readonly type: string;
  /** The heading the type's entries appear under. */
  readonly section: string;
  /** Hidden sections contribute no heading and no entries — an explicit
   * declaration, never a silent drop (a type absent from `sections` is
   * surfaced under its own heading instead, see {@link renderChangelog}). */
  readonly hidden?: boolean;
}

/** The renderer's whole input — everything the bytes may depend on. There
 * is deliberately no timestamp, no actor, no repository state that is not
 * declared here: the module stays a pure function of this value. */
export interface ChangelogInput {
  /** The versions to render, newest first, in plan order. */
  readonly versions: readonly ChangelogVersion[];
  /** The declared section mapping, in render order. */
  readonly sections: readonly ChangelogSection[];
  /** The declared repository base URL for commit links (e.g.
   * `https://github.com/acme/widget`); omitted → no links are rendered. */
  readonly repository?: string;
  /** The existing `CHANGELOG.md` bytes to update. Omitted or empty creates
   * the file fresh with a `# Changelog` header. A version the file does
   * not yet carry is prepended in input order; a version already present
   * is replaced in place — release-please's updater shape (§3.5) and the
   * reason re-rendering the same version onto the same file is byte-
   * identical (the pinned idempotence test). Passing content before the
   * first version heading is refused — the renderer never silently drops
   * bytes it did not write. */
  readonly existing?: string;
}

/**
 * The only error the renderer raises, for every rejected input. The field
 * naming follows the planner's violation vocabulary: the violated field
 * path plus the problem, in message form.
 */
export class InvalidChangelogInputError extends Error {
  public constructor(detail: string) {
    super(`invalid changelog input — ${detail}`);
    this.name = "InvalidChangelogInputError";
  }
}

/** The file header, written on creation and kept in place on prepend —
 * release-please's first-creation shape (§3.5). */
const CHANGELOG_HEADER = "# Changelog";

/** The breaking section's heading, rendered first, before the declared
 * sections — the S-05 "upgrade-guide" placement. */
const BREAKING_SECTION = "Breaking Changes";

/** A version with no rendered notes states the emptiness explicitly
 * (S-04: "an explicit 'no user-facing changes' marker") — an empty section
 * that looks like an accident is the defect the scenario names. */
const EMPTY_NOTES = "No user-facing changes.";

/** The link text for a recorded identity — GitHub's familiar short form,
 * deterministic (a fixed prefix length, never the environment). */
const LINK_TEXT_LENGTH = 7;

/** One rendered section: its `###` heading text and its bullets, in order. */
interface RenderedSection {
  readonly heading: string;
  readonly bullets: readonly string[];
}

/** The renderer: bytes in (the plan's declared projection), bytes out (the
 * changelog). Pure — see the module header for the determinism contract. */
export const renderChangelog = (input: ChangelogInput): string => {
  validate(input);
  if (input.versions.length === 0) {
    // The identity: nothing to render leaves the existing bytes — verbatim —
    // untouched, and creates only the bare header when there is no file
    // (the pinned idempotent no-op).
    return input.existing === undefined || input.existing.trim() === ""
      ? `${CHANGELOG_HEADER}\n`
      : input.existing;
  }
  const repository = input.repository ?? null;
  const rendered = input.versions.map((version) => ({
    version: version.version,
    block: renderVersion(version, input.sections, repository),
  }));
  if (input.existing === undefined || input.existing.trim() === "") {
    return `${CHANGELOG_HEADER}\n\n${rendered.map((entry) => entry.block).join("\n")}`;
  }
  return update(input.existing, rendered);
};

/** One parsed block of the existing file: the version its `##` heading
 * names and the block's content lines, trailing blank lines dropped (the
 * canonical single-trailing-newline form the renderer writes). */
interface ExistingBlock {
  readonly version: string;
  readonly lines: readonly string[];
}

/** The update: versions the file does not carry yet are prepended in input
 * order under the header; a version the file already carries is replaced in
 * place with the freshly rendered bytes — release-please's updater shape
 * (§3.5), and the reason re-rendering the same version onto the same file
 * is the identity (the pinned idempotence test). */
function update(
  existing: string,
  rendered: readonly { readonly version: string; readonly block: string }[],
): string {
  const blocks = parseBlocks(existing);
  const carried = new Set(blocks.map((block) => block.version));
  const replacement = new Map(rendered.map((entry) => [entry.version, entry.block]));
  const out: string[] = rendered
    .filter((entry) => !carried.has(entry.version))
    .map((entry) => entry.block);
  for (const block of blocks) {
    const fresh = replacement.get(block.version);
    out.push(fresh ?? `${block.lines.join("\n")}\n`);
  }
  return `${CHANGELOG_HEADER}\n\n${out.join("\n")}`;
}

/** Splits the existing file's body into `##`-headed version blocks. The
 * header line and the blanks after it are not blocks; anything else before
 * the first heading is refused — content this renderer did not write and
 * will not silently drop (the planner's posture for bytes it would lose). */
function parseBlocks(existing: string): readonly ExistingBlock[] {
  const lines = existing.split("\n");
  const body = lines[0] === CHANGELOG_HEADER ? lines.slice(1) : lines;
  while (body.length > 0 && body[0]?.trim() === "") body.shift();
  const blocks: ExistingBlock[] = [];
  let current: { readonly version: string; readonly lines: string[] } | undefined;
  for (const line of body) {
    if (line.startsWith("## ")) {
      if (current !== undefined) blocks.push(finishBlock(current));
      current = { version: versionOfHeading(line), lines: [line] };
      continue;
    }
    if (current === undefined) {
      if (line.trim() !== "") {
        throw new InvalidChangelogInputError(
          "the field `existing` carries content before its first `##` version heading — " +
            "the renderer refuses rather than drop bytes it did not write",
        );
      }
      continue;
    }
    current.lines.push(line);
  }
  if (current !== undefined) blocks.push(finishBlock(current));
  return blocks;
}

/** A block's kept lines: trailing blank lines dropped — the block ends at
 * its last content line, and assembly re-adds the single trailing newline. */
function finishBlock(block: { readonly version: string; readonly lines: string[] }): ExistingBlock {
  const lines = [...block.lines];
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  return { version: block.version, lines };
}

/** The version token a `##` heading names — the renderer's own four forms:
 * `## version`, `## version (date)`, `## [version](url)`,
 * `## [version](url) (date)`. */
function versionOfHeading(line: string): string {
  const rest = line.slice("## ".length);
  if (rest.startsWith("[")) {
    const close = rest.indexOf("](");
    return close === -1 ? rest : rest.slice(1, close);
  }
  const space = rest.indexOf(" (");
  return space === -1 ? rest : rest.slice(0, space);
}

/** Deep-validates the declared input before any rendering — the planner's
 * caller-contract posture, one throw naming the first violation. */
function validate(input: ChangelogInput): void {
  for (const version of input.versions) {
    if (version.version.trim() === "") {
      throw new InvalidChangelogInputError(
        "the field `versions[].version` must be a non-empty string",
      );
    }
    for (const entry of version.entries) {
      if (entry.type.trim() === "") {
        throw new InvalidChangelogInputError(
          `the field \`versions[].entries[].type\` (version ${JSON.stringify(version.version)}) must be a non-empty string`,
        );
      }
      if (entry.subject.trim() === "") {
        throw new InvalidChangelogInputError(
          `the field \`versions[].entries[].subject\` (version ${JSON.stringify(version.version)}) must be a non-empty string`,
        );
      }
    }
  }
}

/** One version's block: heading, then the sections that have notes, then the
 * explicit emptiness marker when nothing rendered. The block ends with a
 * single trailing newline. */
function renderVersion(
  version: ChangelogVersion,
  sections: readonly ChangelogSection[],
  repository: string | null,
): string {
  // The `##` heading — the release-please forms (§3.5): linked with date,
  // linked, dated, or bare, in that order of presence.
  const head = version.url === undefined ? version.version : `[${version.version}](${version.url})`;
  const heading = version.date === undefined ? `## ${head}` : `## ${head} (${version.date})`;
  const lines = [heading, ""];
  const rendered = renderedSections(version, sections, repository);
  if (rendered.length === 0) {
    lines.push(EMPTY_NOTES);
  } else {
    for (const section of rendered) {
      lines.push(`### ${section.heading}`, "");
      for (const bullet of section.bullets) lines.push(bullet);
      lines.push("");
    }
  }
  // Trailing blanks (the separators above) collapse to the single terminator
  // newline — trimmed linearly over the constructed lines, never through a
  // regex: caller text may repeat `\n`, and a backtracking `\n+$` on it is
  // the polynomial scan CodeQL refuses.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

/** The version's rendered sections, in order: the breaking section first,
 * then the declared sections in declaration order (hidden ones contribute
 * nothing), then — surfaced, never dropped — every undeclared type under
 * its own heading, ordered by type so the output is a total order. */
function renderedSections(
  version: ChangelogVersion,
  sections: readonly ChangelogSection[],
  repository: string | null,
): readonly RenderedSection[] {
  const declared: Record<string, ChangelogSection> = {};
  for (const section of sections) declared[section.type] = section;
  const breaking: string[] = [];
  const grouped: Record<string, string[]> = {};
  const undeclared = new Set<string>();
  for (const entry of version.entries) {
    const bullet = bulletOf(entry, repository);
    if (entry.breaking === true) {
      breaking.push(bullet);
      continue;
    }
    if (declared[entry.type] === undefined) undeclared.add(entry.type);
    const section = declared[entry.type];
    // `section.hidden` is the declared exclusion — never a silent drop;
    // the declaration is the intent (release-please's `hidden`, §3.2).
    if (section !== undefined && section.hidden === true) continue;
    const bullets = grouped[entry.type];
    if (bullets === undefined) grouped[entry.type] = [bullet];
    else bullets.push(bullet);
  }
  const rendered: RenderedSection[] = [];
  if (breaking.length > 0) rendered.push({ heading: BREAKING_SECTION, bullets: breaking });
  for (const section of sections) {
    const bullets = grouped[section.type];
    if (bullets !== undefined && section.hidden !== true) {
      rendered.push({ heading: section.section, bullets });
    }
  }
  for (const type of [...undeclared].sort()) {
    const bullets = grouped[type];
    if (bullets !== undefined) {
      // The undeclared type's heading: the type, capitalized — the
      // conventionalcommits preset's heading pattern, applied to types
      // the declaration does not name.
      rendered.push({ heading: type.charAt(0).toUpperCase() + type.slice(1), bullets });
    }
  }
  return rendered;
}

/** `* **scope:** subject` with the scope, `* subject` without — the
 * conventional-changelog bullet; a declared repository turns the recorded
 * id into a commit link. */
function bulletOf(entry: ChangelogEntry, repository: string | null): string {
  const text = entry.scope === undefined ? entry.subject : `**${entry.scope}:** ${entry.subject}`;
  if (entry.id === undefined || entry.id === "" || repository === null) return `* ${text}`;
  const short = entry.id.length > LINK_TEXT_LENGTH ? entry.id.slice(0, LINK_TEXT_LENGTH) : entry.id;
  const base = repository.endsWith("/") ? repository.slice(0, -1) : repository;
  return `* ${text} ([${short}](${base}/commit/${entry.id}))`;
}
