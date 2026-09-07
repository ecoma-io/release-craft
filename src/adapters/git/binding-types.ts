/**
 * The binding's own vocabulary (contract §2.6). No new record shapes, no new
 * key spaces, no new state names beyond the doors the contract pins — the
 * types below are exactly the declared-configuration input and the returned
 * outcomes of the tag door. Engine types are consumed, never re-declared:
 * both are imported from the package barrel.
 */

import type { ClaimScope, ClaimToken } from "../../index.js";

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
