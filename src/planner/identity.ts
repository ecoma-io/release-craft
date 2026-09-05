/**
 * Plan identity (§2.10, §2.11, §2.14; ADR-0003 decisions 9–10, D12): the
 * canonical JSON serializer and the two content fingerprints — the plan's
 * (`plan_sha256:<hex>`) and the input world's (`inputs_sha256:<hex>`).
 *
 * Canonical form: recursively key-sorted JSON with no insignificant
 * whitespace (§2.11). Object keys sort in UTF-16 code-unit order (the
 * default `.sort()` comparison — identical in every process, invariant 2);
 * arrays keep their order (E-10: ordering is data, never incidental);
 * object fields whose value is `undefined` are omitted (absent and
 * `undefined` are the same semantic fact); strings serialize through
 * `JSON.stringify` and numbers through `String(n)`, so `1` and `1.0`
 * collapse to one canonical token. A value that is neither a JSON scalar,
 * an array, nor a plain object rides its own canonical `toString` when it
 * has one — the kernel's `Version` serializes as its canonical string
 * (`1.2.3-rc.1`), the same representation tags carry (§2.13) — and
 * everything else (functions, symbols, bigints, `undefined` at the top,
 * `Date`/`Map`/`Set`, toString-less exotica, cyclic graphs) is not
 * plan-eligible and throws: a fingerprint over a mangled value would look
 * deterministic while lying.
 *
 * Hashing lives in the planner layer on purpose. ADR-0001's purity ban is
 * scoped to `core/domain/` — the kernel imports nothing (no Node built-ins,
 * no entropy source), and D5 places the planner one layer up, in the
 * package, whose plan identity is *defined as* a digest (§2.11). SHA-256 via
 * `node:crypto` is a pure function of its input — no clock, environment,
 * filesystem, or network — so invariant 2 holds with the hash here while the
 * kernel stays import-free.
 *
 * Fingerprints:
 * - `planFingerprint` hashes the plan's closed tuple (§2.11): supersedes,
 *   policy digest, inputs fingerprint, and per line the frozen `PlanLine`
 *   fields. Version equality implies nothing about plan equality (E-11) —
 *   the same target version over a different change set fingerprints
 *   differently.
 * - `inputsFingerprint` hashes the whole `PlanningInput` — every semantic
 *   field, minus nothing — so a stored plan re-judged against a world whose
 *   inputs fingerprint differs is stale (E-04's recognition data).
 *
 * Contract: docs/design/phase2-planner-contract.md §2.10–§2.11, §2.14;
 * docs/adr/0003-deterministic-release-planner.md decisions 9–10; D12.
 */

import { createHash } from "node:crypto";

import type { CanonicalJson, InputsFingerprint, PlanFingerprint, PlanningInput } from "./types.js";

/**
 * The ancestors of the value currently being serialized — path-based, so a
 * shared subvalue that is not a cycle (a DAG) serializes fine and only a
 * true cycle throws.
 */
type Ancestors = Set<object>;

/**
 * The locked `CanonicalJson` implementation (§2.11): recursively key-sorted,
 * whitespace-free, deterministic across processes (invariant 2).
 */
export const canonicalJson: CanonicalJson = (value) => serialize(value, new Set<object>());

function serialize(value: unknown, ancestors: Ancestors): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    // `String(n)`, not `JSON.stringify(n)`: they agree on every plan-eligible
    // number and `String` is the contract's spelling — `1` and `1.0` collapse
    // to one token, `-0` serializes as `"0"`. Non-finite numbers are not
    // plan-eligible; `String` still renders them deterministically, so a
    // caller bug stays a stable (wrong) token rather than a coin flip.
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value !== "object") {
    throw new TypeError(`canonical JSON: ${typeof value} is not a plan-eligible value`);
  }
  const obj: object = value;
  if (ancestors.has(obj)) {
    throw new TypeError("canonical JSON: cyclic value — the §2.11 tuple is a tree");
  }
  if (Array.isArray(obj)) {
    ancestors.add(obj);
    const items = obj.map((item) => (item === undefined ? "null" : serialize(item, ancestors)));
    ancestors.delete(obj);
    return `[${items.join(",")}]`;
  }
  if (isPlainObject(obj)) {
    ancestors.add(obj);
    // UTF-16 code-unit order — the same order in every process (invariant 2).
    const keys = Object.keys(obj).sort();
    const fields: string[] = [];
    for (const key of keys) {
      const member: unknown = obj[key];
      if (member === undefined) continue;
      fields.push(`${JSON.stringify(key)}:${serialize(member, ancestors)}`);
    }
    ancestors.delete(obj);
    return `{${fields.join(",")}}`;
  }
  // Not an array, not a plain object: a class instance rides its own
  // canonical `toString` when it has one — the kernel `Version`'s is its
  // canonical serialization, the exact string `parse` accepts. Values whose
  // string form is the Object default ("[object Object]") are
  // indistinguishable mush, so they are refused — as are the built-ins whose
  // string form is clock-shaped (`Date`) or unordered (`Map`, `Set`): none
  // of them is plan-eligible. `Reflect.get`/`Reflect.apply` keep the method
  // bound to its instance.
  if (obj instanceof Date || obj instanceof Map || obj instanceof Set) {
    throw new TypeError(`canonical JSON: ${obj.constructor.name} is not a plan-eligible value`);
  }
  const toString: unknown = Reflect.get(obj, "toString");
  const text: unknown =
    typeof toString === "function" ? Reflect.apply(toString, obj, []) : undefined;
  if (typeof text !== "string" || text === "[object Object]") {
    throw new TypeError("canonical JSON: value has no canonical serialization");
  }
  return JSON.stringify(text);
}

/** True for the `{...}` objects canonical JSON sorts by key — the guard that
 * lets the serializer treat everything else as a leaf or a refusal. */
function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Reflect.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The locked `PlanFingerprint` (§2.11): SHA-256 over the canonical JSON of
 * the closed tuple — everything but `planId`, which is this hash. The hex
 * digest is lowercase by definition: 64 characters, the frozen `<hex>`.
 */
export const planFingerprint: PlanFingerprint = (plan) => {
  return `plan_sha256:${createHash("sha256").update(canonicalJson(plan)).digest("hex")}`;
};

/**
 * The locked `InputsFingerprint` (§2.11, E-04): SHA-256 over the canonical
 * JSON of the whole planning input, minus nothing.
 */
export const inputsFingerprint: InputsFingerprint = (input: PlanningInput): string => {
  return `inputs_sha256:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`;
};
