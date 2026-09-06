/**
 * The extension step-key vocabulary (phase 6 and phase 7 contracts §2.1;
 * ADR-0007 decision 3, ADR-0008 decision 3): the `hook:<id>` and
 * `artifact:<id>` key spaces and their predicates, in one dependency-free
 * module — the single authority both extension modules and the resume
 * classification read, so no extension module depends on another.
 *
 * Pure values only: no clock, randomness, environment, filesystem, or
 * network reads (§2.10).
 */
import type { ArtifactStepKey, HookStepKey, StepKey } from "./types.js";

/** The hook's ledger key (§2.1): `hook:<id>`, unique per attempt. */
export const hookStepKey = (id: string): HookStepKey => `hook:${id}`;

/** The key-space test: is this step key a hook's rather than a stage's?
 * The resume classification reads it to route failed records (§2.5) —
 * canonical failed stages keep E-01's crash doctrine; hook failures are
 * the blocked(validation) escalation. */
export const isHookStepKey = (stepKey: StepKey): stepKey is HookStepKey =>
  stepKey.startsWith("hook:");

/** The artifact step's ledger key (§2.1): `artifact:<id>`, unique per
 * attempt — the key the generation record is filed under. */
export const artifactStepKey = (id: string): ArtifactStepKey => `artifact:${id}`;

/** The key-space test: is this step key an artifact step's? The resume
 * classification routes a failed artifact record exactly as a hook's
 * (§2.5: "exactly as a hook's does"), and the scheduler's replay answers
 * from the generation record this key names. */
export const isArtifactStepKey = (stepKey: StepKey): stepKey is ArtifactStepKey =>
  stepKey.startsWith("artifact:");
