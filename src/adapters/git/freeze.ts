/**
 * The freeze discipline over persisted values (contract §3: records
 * deep-freeze on append; values crossing the binding freeze on the same
 * terms). This is the reload path's guarantee: a value reconstructed from a
 * persisted scope is frozen before anything can hold a mutable alias to it.
 */

/**
 * Freezes `value` and every nested plain-JSON value in place. Plain JSON
 * only — objects and arrays; the binding never freezes anything else, so
 * cycles and exotic builtins are out of contract.
 */
export function deepFreeze(value: unknown): unknown {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Parses `text` and freezes the result — the reload path: what comes back
 * from the repository is read-only from the first reference onward.
 */
export function frozenParse(text: string): unknown {
  return deepFreeze(JSON.parse(text) as unknown);
}
