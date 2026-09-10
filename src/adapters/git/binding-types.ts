/**
 * The binding's own vocabulary (contract §2.6). No new record shapes, no new
 * key spaces, no new state names beyond the doors the contract pins — the
 * types below are exactly the declared-configuration input and the returned
 * outcomes of the tag door. Engine types are consumed, never re-declared:
 * both are imported from the package barrel.
 */

import type { ClaimScope, ClaimToken, LedgerRecord } from "@ecoma-io/release-craft/execution";
import type { ClaimRecord } from "./claim-store-git.js";

/**
 * The declared tag naming (D14's per-package naming as declared
 * configuration): the namespace roots the opened configuration declares, and
 * the derivation from a claim scope to its physical tag name. `tagFor`
 * returns null when the scope maps outside every declared namespace — the
 * namespace door refuses such a claim before git sees it (E-08; ADR-0009
 * decision 5).
 */
export interface GitTagNaming {
  readonly namespaces: readonly string[];
  tagFor(scope: ClaimScope): string | null;
}

/**
 * The tag door's outcomes (contract §2.6): minted at the supplied target;
 * refused with the failure class named — outside every declared namespace
 * (`namespace`), no held claim derives the tag (`unclaimed`), or the claim
 * is held but by another attempt's token (`foreign-token`); or `conflict`,
 * a present tag ref — the existing ref wins. Every outcome is a returned
 * value, never an exception; nothing a door refused left state behind.
 */
export type TagMintResult =
  | { readonly kind: "minted"; readonly tag: string; readonly target: string }
  | {
      readonly kind: "refused";
      readonly reason: "namespace" | "unclaimed" | "foreign-token";
      readonly tag: string;
      readonly detail: string;
    }
  | { readonly kind: "conflict"; readonly tag: string; readonly detail: string };

/**
 * The tag door's input: the calling attempt, its held token, the tag to
 * mint, and the target — the attempt's recorded base, supplied by the
 * assembly, never chosen by the binding (no ambient HEAD; ADR-0009
 * decision 4).
 */
export interface TagMintInput {
  readonly attemptId: string;
  readonly token: ClaimToken;
  readonly tag: string;
  readonly target: string;
}

/** The configuration the binding is opened with (contract §2.6). */
export interface BindingConfig {
  readonly repo: string;
  readonly tagNaming: GitTagNaming;
}

/**
 * One recorded ref the remote projection reads (the Phase 9 contract
 * §2.7; D26): the binding's own recorded state — a claim ref under its
 * namespace or a tag within the declared namespaces — with the object it
 * names. For a claim ref that object is the register ref's tip commit
 * (the per-line claim register of ADR-0011 grows one commit per
 * mutation, the envelope blob riding the commit's tree); for a tag it is
 * the commit — the tag object itself for a lightweight tag (the mint
 * door's shape), the peeled commit for an annotated one.
 */
export interface RecordedRef {
  /** The full ref name — `refs/release-craft/claims/<record>` or
   *  `refs/tags/<tag>`. */
  readonly ref: string;
  /** The object the ref names — the register ref's tip commit for a
   *  claim ref (not the envelope blob, which sits in that commit's tree
   *  as `record`); the commit for a tag, peeled from the tag object for
   *  an annotated one. */
  readonly target: string;
  /** Which recorded namespace the ref came from. */
  readonly kind: "claim" | "tag";
}

/**
 * The binding's read-only ref enumeration (the Phase 9 contract §2.7;
 * D26): what the remote projection reads to determine what to push.
 * Pure reads over the recorded refs — no write, no `HEAD` resolution, no
 * working-tree state (ADR-0009 decision 4's discipline, read side).
 */
export interface RefRead {
  /** Every claim ref under the binding's claim-ref namespace, each with
   *  the register ref's tip commit as its target (the per-line claim
   *  register of ADR-0011 — the envelope blob rides that commit's tree,
   *  and reads as `content.claims`, not here). */
  claims(): readonly RecordedRef[];
  /** Every tag within the configuration's declared namespaces (the mint
   *  door's namespace rule) the repository holds, each with its peeled
   *  target. */
  tags(): readonly RecordedRef[];
}

/**
 * The binding's content read seam (the Phase 9 contract §2.8; D27): the
 * read-only surface the release projection reads to resolve a recorded
 * tag's changelog — the minting claim, the naming's own derivation, the
 * holding attempt's recorded stream, and one file out of the recorded
 * tree a digest names. Reads only: the ledger's `append` is unreachable
 * through it (structural, not by convention).
 */
export interface ContentRead {
  /** The claim records a claim ref holds — the per-line register of
   *  ADR-0011 — or the empty set when the ref is absent. A blob that is
   *  not a register throws (the layout is total; ADR-0011 decision 5). */
  claims(ref: string): readonly ClaimRecord[];
  /** The tag name the declared naming derives for a scope, or null when
   *  the scope maps outside every declared namespace — the mint door's
   *  own rule, exposed as a pure read. */
  tagFor(scope: ClaimScope): string | null;
  /** The attempt's recorded stream — the ledger tail, read-only. */
  tail(attemptId: string): readonly LedgerRecord[];
  /** One file's content out of the recorded tree the digest names, or
   *  null when the tree holds no such path. The digest must be a
   *  recorded tree digest (`git-tree:<oid>`); anything else is a caller
   *  fault. Recorded objects only — never the working tree, never
   *  `HEAD` (ADR-0009 decision 4). */
  file(digest: string, path: string): string | null;
}
