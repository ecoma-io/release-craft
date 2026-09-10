/**
 * The factories (phase 11 contract §2.2): one per port bundle, each the
 * only door that composes a bundle into an engine value. The factories
 * wire, they do not build: every port arrives opened — the memory bundle
 * carries the kernel's reference stores, the git factory consumes an
 * already-opened binding exactly as the binding's adapter door does
 * (ADR-0010 decision 2) — and the returned engine re-owns nothing, shares
 * nothing, and reads nothing ambient (§2.3; §3's law: no clock, no
 * environment, no HEAD, no path beyond the binding's own).
 *
 * The assembly checks its own closed config structurally at the door
 * (§4 question 4): a `maxRetries` that is not a non-negative integer, or
 * any key outside `{ maxRetries }`, is
 * [`InvalidAssemblyConfigError`](./types.html#class-invalidassemblyconfigerror)
 * — the boundary's own thrown contract violation, before any store is
 * touched.
 */
import type { GitBinding } from "@ecoma-io/release-craft/adapters/git";
import { createEngine } from "./engine.js";
import {
  InvalidAssemblyConfigError,
  type AssemblyConfig,
  type Engine,
  type EnginePorts,
  type MemoryStores,
} from "./types.js";

/**
 * The closed-set structural check (§2.2 "and nothing else"; §4 question
 * 4). Returns a normalized config carrying exactly the declared keys, or
 * throws the boundary's named violation.
 */
const validatedConfig = (config: AssemblyConfig): AssemblyConfig => {
  const unexpected = Object.keys(config).filter((key) => key !== "maxRetries");
  if (unexpected.length > 0) {
    throw new InvalidAssemblyConfigError(
      `unknown keys ${unexpected.map((key) => JSON.stringify(key)).join(", ")}`,
    );
  }
  const { maxRetries } = config;
  if (typeof maxRetries !== "number" || !Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new InvalidAssemblyConfigError(
      `maxRetries ${JSON.stringify(maxRetries)} is not a non-negative integer`,
    );
  }
  return { maxRetries };
};

/**
 * The memory factory (§2.2): the kernel's reference stores — the
 * zero-persistence assembly for embedders and the contract tests. No
 * channel store wired means §2.4's pre-walk refusal for any plan that
 * declares moves; no tag door wired means a completed walk publishes
 * without minting; no producer wired means the run declarations must name
 * one per declared artifact id.
 */
export const assembleMemoryStores = (stores: MemoryStores, config: AssemblyConfig): Engine =>
  createEngine(
    {
      register: stores.register,
      ledger: stores.ledger,
      claims: stores.claims,
      channels: stores.channels ?? null,
      mint: null,
      producer: null,
    },
    validatedConfig(config),
  );

/**
 * The git factory (§2.2): consumes an opened binding, wiring each engine
 * port from the binding's own — ledger, register, claims, the channel
 * store (ADR-0012 decision 6), the tag door (`mintTag`), and the artifact
 * producer as the per-id fallback under the run declarations' producers
 * map (ADR-0008 decision 2). The binding's read seams (`refs`, `content`)
 * stay unwired: the boundary derives the claim view from the store's own
 * doors (§2.3), and no observation reaches past the ports.
 */
export const assembleGitBinding = (binding: GitBinding, config: AssemblyConfig): Engine =>
  createEngine(
    {
      register: binding.register,
      ledger: binding.ledger,
      claims: binding.claims,
      channels: binding.channels,
      mint: binding.mintTag,
      producer: binding.producer,
    } satisfies EnginePorts,
    validatedConfig(config),
  );
