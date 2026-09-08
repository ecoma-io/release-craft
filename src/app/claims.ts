/**
 * The claim half of the application boundary (phase 11 contract §2.3, §2.5
 * step 3): the one scope derivation the boundary owns, the one claim view
 * derivation the boundary owns, and the bounded sequence retry driven
 * through the kernel's own clause. The fixtures derive the same plan's
 * scope two different ways — `matrix.ts`'s `scopeFor` names the stream's
 * `pointerBase`, `matrix-git.ts`'s `claimScopeFor` names the rendered
 * version's base, so the mint door's naming derivation reproduces the
 * plan's own tag. The divergence is evidence, not precedent (§2.3): the
 * boundary owns the second derivation, constrained by the opened binding's
 * declared naming, and a scope whose derived tag the naming refuses
 * surfaces exactly as the store's namespace door returns it —
 * `ClaimDenied { refusal: "namespace" }`, holder absent, a returned
 * outcome the walk stops on. The boundary never repairs a denial with a
 * second derivation.
 *
 * No clock, no environment, no randomness: pure values over the plan line
 * and the wired store (§3's law).
 */
import {
  retrySequence,
  type Claim,
  type ClaimScope,
  type ClaimStore,
  type ClaimView,
  type PlanLine,
} from "../index.js";
import type { AssemblyConfig } from "./types.js";

/** One acquisition's verdict (§2.5 step 3): `held` carries the claim; the
 * other rows are the outcome table's — `denied` names the winner when one
 * exists, `refused` is the namespace door's policy refusal, `conflict` is
 * E-08's explicit conflict past the declared bound. */
export type ClaimAcquisition =
  | { readonly kind: "held"; readonly claim: Claim }
  | { readonly kind: "denied"; readonly holder: string | null }
  | { readonly kind: "refused"; readonly detail: string }
  | { readonly kind: "conflict"; readonly detail: string };

/**
 * The claim scope a plan line's decision demands (§2.3), in the shape the
 * binding's naming reproduces the plan's own tag from: a prerelease
 * stream's sequence scope keyed to the rendered version's own base — the
 * minted tag's base is the version up to its first `-` (for `5.0.0-beta.1`
 * that base is `5.0.0`) and the sequence is read off the version's
 * `-<stream>.<n>` suffix — else the stable version's record scope. Null
 * when the line plans no release at all (no stream, no stable): there is
 * nothing to claim, and inventing a scope would be a second derivation.
 */
export const claimScopeForLine = (planLine: PlanLine): ClaimScope | null => {
  const stream = planLine.streams[0];
  if (stream !== undefined) {
    const rendered = stream.version.toString();
    const dash = rendered.indexOf("-");
    const base = dash < 0 ? rendered : rendered.slice(0, dash);
    const suffix = dash < 0 ? "" : rendered.slice(dash + 1);
    const sequence = Number.parseInt(suffix.split(".")[1] ?? "0", 10);
    return {
      kind: "prerelease-sequence",
      lineId: planLine.lineId,
      target: base,
      streamId: stream.identifier,
      sequence,
    };
  }
  if (planLine.stable === null) {
    return null;
  }
  return { kind: "stable-version", lineId: planLine.lineId, version: planLine.stable.version };
};

/**
 * The claim view `requestStep`/`ledgerRequestStep` and both schedulers
 * consume (§2.3; §2.7): the attempt's held claim plus the store's
 * current-state token re-verification, holder-checked. Derived from the
 * wired store and the engine's own acquisition — no caller ever sees a
 * `ClaimView`, and neither store implementation's helper door is consumed
 * (the derivation is port-level, identical for both assemblies).
 */
export const claimViewFor = (
  claim: Claim | null,
  claims: ClaimStore,
  attemptId: string,
): ClaimView => ({
  held: claim,
  verify: (token) => {
    const verification = claims.verify(token);
    return verification.kind === "held" && verification.claim.holder === attemptId;
  },
});

/**
 * One acquisition with E-08's bounded retry driven (§2.5 step 3): the
 * derived scope is acquired before any mutation; a denial that is the
 * namespace door's refusal surfaces as `refused` (holder absent, §2.3); a
 * denied `prerelease-sequence` scope re-acquires at the winner's
 * `sequence + 1` through the kernel's `retrySequence` under the declared
 * `maxRetries` — never a new retry invented at the boundary — and an
 * explicit conflict past the bound; every other denial names the winner
 * (E-07). The store's idempotent same-holder re-acquisition makes the
 * pre-walk acquire on a resume the replay it already was.
 */
export const acquireClaim = (
  claims: ClaimStore,
  scope: ClaimScope,
  attemptId: string,
  config: AssemblyConfig,
): ClaimAcquisition => {
  let retries = 0;
  let demand: ClaimScope = scope;
  for (;;) {
    const settled = claims.acquire(demand, attemptId);
    if (settled.kind === "claim") {
      return { kind: "held", claim: settled };
    }
    if (settled.refusal === "namespace") {
      return {
        kind: "refused",
        detail:
          `the claim store's namespace door refused the derived scope ${JSON.stringify(
            settled.scope,
          )} — the declared naming derives no tag for it, holder absent ` +
          `(ClaimDenied { refusal: "namespace" }, phase 11 contract §2.3)`,
      };
    }
    if (demand.kind !== "prerelease-sequence") {
      // E-08's retry is the prerelease-sequence clause alone: every other
      // denied scope loses the race outright, and the denial names the
      // winner — holder absent only when no winner exists to name.
      return { kind: "denied", holder: settled.holder ?? null };
    }
    const decision = retrySequence(settled, retries, { maxRetries: config.maxRetries });
    if (decision.kind === "conflict") {
      return { kind: "conflict", detail: decision.detail };
    }
    retries += 1;
    demand = { ...demand, sequence: decision.sequence };
  }
};
