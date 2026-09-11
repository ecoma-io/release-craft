/**
 * The shared fixture for the node-workspace adapter's tests: a temporary
 * directory under the OS temp dir, with a `write` helper that creates any
 * parent directories along the way. Every test owes `cleanup()`
 * (try/finally), mirroring the git binding's temp-repo fixture.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The shape withTempWorkspace hands back. */
export interface TempWorkspace {
  /** The workspace root directory (absolute). */
  readonly root: string;
  /** Writes a file relative to the root, creating parent directories. */
  write(relativePath: string, body: string): void;
  /** Removes the temporary directory; must always be reached. */
  cleanup(): void;
}

/**
 * Runs `fn` against a fresh temporary directory tagged `name`, removing it
 * afterwards whether the body passes or fails.
 */
export function withTempWorkspace(name: string, fn: (workspace: TempWorkspace) => void): void {
  const root = mkdtempSync(join(tmpdir(), `release-craft-nws-${name}-`));
  try {
    fn({
      root,
      write(relativePath, body) {
        const full = join(root, relativePath);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, body, "utf-8");
      },
      cleanup() {
        rmSync(root, { recursive: true, force: true });
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
