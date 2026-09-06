/**
 * §2.13 — tag-history projection — and §2.5 — range derivation (PR-3), per
 * [phase2-planner-contract.md](../../docs/design/phase2-planner-contract.md),
 * ADR-0003 decision 16, and decision-log D15.
 *
 * `TagObservation[]` is the sole release-history truth (invariant 6, S-03):
 * every tag name is parsed through the kernel's grammar (`Version.parse` —
 * strict SemVer 2.0.0, the only door into a `Version`), and a parsed tag
 * joins a line's history exactly when its version falls in that line's
 * declared `versionBand` (D15): band equality on the major series,
 * optionally the minor series; an absent band — the single-line repo —
 * admits every parsed tag. Everything the projection keeps out is surfaced
 * per line as foreign (E-06): never silently dropped. The manifest is never
 * consulted: neither signature takes component metadata, so a tag whose
 * commit matches no manifest version is still history (S-03's projection
 * rule — manifest versions never bound a range, §2.5).
 *
 * Foreign-surfacing reading: a tag is surfaced on every line whose
 * evaluation rejected it. An unparseable tag has no version to band-check,
 * so every line rejects it; a parsed tag that no declared band admits is
 * rejected by every band. Both therefore appear in each line's `foreign`,
 * while a tag admitted on one line stays absent from that line's list — a
 * tag may be admissible to one line and foreign to another (S-03's 1.9.x vs
 * 2.x). A `lines: []` call cannot arrive through the input door (`normalize`
 * enforces ≥1 line, §2.6); were it forced, the projection is empty and there
 * is no explanation data to surface into.
 *
 * Determinism (invariant 2, §2.14): pure — no clock, randomness,
 * environment, filesystem, or network. Lines keep input order; a line's tags
 * sort ascending by kernel precedence, ties (equal precedence, e.g.
 * differing build metadata) broken by tag name in ASCII order — never
 * `localeCompare`, which is environment-dependent. Kernel rejections
 * (`InvalidVersionError`) are caught and surfaced as foreign data, never
 * re-thrown (§2.13; the planning-boundary posture of ADR-0003 decision 1).
 */

import { InvalidVersionError, Version } from "@ecoma-io/release-craft/domain";

import { InvalidPlanningInputError } from "./input.js";
import type {
  AdmissibleTag,
  DeriveRanges,
  ForeignTag,
  LineConfig,
  LineHistory,
  LineRange,
  LoadTagHistory,
  TagObservation,
} from "./types.js";

/** One tag's parse outcome: a kernel `Version`, or why the kernel refused. */
type ParsedTag =
  | { readonly tag: TagObservation; readonly version: Version }
  | { readonly tag: TagObservation; readonly refusal: string };

/** One caller-contract violation, as `input.ts`'s error records them. */
interface RangeProblem {
  readonly field: string;
  readonly problem: string;
}

/**
 * The band verdict for one parsed tag against one line (D15): `undefined`
 * when the tag is admitted, else the foreign detail naming the line and the
 * band it failed. No grammar is inferred from line ids or feed refs — the
 * band is the declared configuration, or nothing (decision 16).
 */
function bandRefusal(version: Version, line: LineConfig): string | undefined {
  const band = line.versionBand;
  // Absent band: the single-line namespace admits every admissible tag.
  if (band === undefined) {
    return undefined;
  }
  if (version.major === band.major && (band.minor === undefined || version.minor === band.minor)) {
    return undefined;
  }
  const series =
    band.minor === undefined
      ? `major ${String(band.major)}`
      : `major ${String(band.major)}, minor ${String(band.minor)}`;
  return `version ${version.toString()} is outside line "${line.id}"'s declared band (${series})`;
}

/**
 * Ascending kernel precedence; equal precedence — versions differing only in
 * build metadata compare as `0` — breaks by tag name in ASCII order, making
 * the line's history a total, deterministic order (§2.13's ascending
 * requirement plus invariant 2).
 */
function byPrecedenceThenName(a: AdmissibleTag, b: AdmissibleTag): number {
  const byPrecedence = a.version.compare(b.version);
  if (byPrecedence !== 0) {
    return byPrecedence;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * The locked §2.13 projection: parse each name once, adjudicate per line,
 * surface what each line kept out. `_policy` is deliberately unread — the
 * projection's truth is the tag observations and the lines' declared bands
 * alone (invariant 6); policy names no tag namespace, and per-component tag
 * formats (fork 11) name minted tags on the write side, not observed history.
 */
export const loadTagHistory: LoadTagHistory = (tags, lines, _policy) => {
  // Parse each name once — the kernel grammar runs per tag, not per
  // (tag, line). The kernel rejection is captured, not propagated: a foreign
  // tag is explanation data (§2.13, E-06), never a planner exception. The
  // captured message carries the kernel's machine reason plus a bounded echo
  // of the offending name — the detail a reader needs. Any other error is a
  // bug, not a tag defect, and propagates.
  const parsedTags = tags.map((tag): ParsedTag => {
    try {
      return { tag, version: Version.parse(tag.name) };
    } catch (error) {
      if (!(error instanceof InvalidVersionError)) {
        throw error;
      }
      return { tag, refusal: error.message };
    }
  });

  const projected = lines.map((line): LineHistory => {
    const admitted: AdmissibleTag[] = [];
    const foreign: ForeignTag[] = [];
    for (const parsed of parsedTags) {
      if ("refusal" in parsed) {
        // Unparseable: no version exists to band-check, so this line — like
        // every line — rejects the tag, naming the parse failure (E-06).
        foreign.push({
          name: parsed.tag.name,
          commit: parsed.tag.commit,
          detail: `the kernel's version grammar refused this tag name: ${parsed.refusal}`,
        });
        continue;
      }
      const refusal = bandRefusal(parsed.version, line);
      if (refusal === undefined) {
        admitted.push({
          name: parsed.tag.name,
          commit: parsed.tag.commit,
          version: parsed.version,
        });
      } else {
        foreign.push({ name: parsed.tag.name, commit: parsed.tag.commit, detail: refusal });
      }
    }
    admitted.sort(byPrecedenceThenName);
    // `foreign` keeps input tag order — the stable order for explanation data.
    return { lineId: line.id, tags: admitted, foreign };
  });

  return { lines: projected };
};

/**
 * The locked §2.5 derivation: per line, the latest admissible tag's commit
 * bounds the lower end (`null` — line birth — when the history is empty,
 * never an invented bootstrap), and the line's feed-ref head bounds the
 * upper end. Lines are independent (M-07, S-03): one line's empty history
 * says nothing about another's, and history entries pair by the stable line
 * id (invariant 7), never by position.
 */
export const deriveRanges: DeriveRanges = (history, refs, lines) => {
  const headByRef: Record<string, string> = Object.fromEntries(
    refs.map((ref) => [ref.name, ref.head]),
  );
  const problems: RangeProblem[] = [];
  const ranges: LineRange[] = [];

  for (const [index, line] of lines.entries()) {
    const head = headByRef[line.feedRef];
    if (head === undefined) {
      // The line's feed ref was never observed (§2.2) — a caller contract
      // violation, not a planning outcome.
      problems.push({
        field: `lines[${String(index)}].feedRef`,
        problem: `no observed ref named "${line.feedRef}"`,
      });
      continue;
    }
    const projected = history.lines.find((entry) => entry.lineId === line.id);
    if (projected === undefined) {
      problems.push({
        field: `lines[${String(index)}]`,
        problem: `no projected history for line "${line.id}" — supply loadTagHistory's output over the same lines`,
      });
      continue;
    }
    // History tags are already ascending (§2.13): the last entry is the
    // latest admissible release; an empty history is the line's birth.
    const latest = projected.tags.at(-1);
    ranges.push({
      lineId: line.id,
      releasedUpTo: latest === undefined ? null : latest.commit,
      head,
    });
  }

  if (problems.length > 0) {
    // Every violation is collected — in lines order — and thrown at once, so
    // a caller fixes its whole fixture in one pass (the input.ts /
    // attribute.ts posture); one root cause yields one problem.
    throw new InvalidPlanningInputError(problems);
  }
  return ranges;
};
