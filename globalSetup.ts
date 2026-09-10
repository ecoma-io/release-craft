/**
 * Preflight guard: the CLI, action, and certification suites spawn the built
 * binary (`dist/src/cli/index.js`) as a subprocess. Without a prior build
 * every one of those ~96 tests fails with an exit code indistinguishable
 * from a real regression (#144). This guard fails fast with an actionable
 * message instead.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The actionable error body — exported for the message contract test. */
export const missingBuildMessage = (cliBin: string): string =>
  `The built CLI (${cliBin}) is missing. The CLI, action, and ` +
  `certification test suites spawn it as a subprocess and will fail ` +
  `without it.\n\nRun \`pnpm build\` before running vitest directly, ` +
  `or use \`pnpm test\` which builds automatically via the Moon graph.`;

const CLI_BIN = join(process.cwd(), "dist", "src", "cli", "index.js");

export default function preflight(): void {
  if (!existsSync(CLI_BIN)) {
    throw new Error(missingBuildMessage(CLI_BIN));
  }
}
