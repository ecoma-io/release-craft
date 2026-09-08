/**
 * Assembly selection (phase 12 contract §2.2): the CLI offers exactly the
 * two factories the application boundary declares — `memory`
 * (`assembleMemoryStores` over fresh in-memory stores) and `git`
 * (`assembleGitBinding` over `openGitBinding`). The selection consumes
 * only the parsed invocation's own values: `--max-retries` is the
 * assembly's declared knob (default 0, §8), `--repo` / `--tag-namespace`
 * feed the git binding alone, and the tag naming is the one declared
 * derivation in `naming.ts`. No factory beyond these two exists at this
 * surface, and none can be named from argv.
 */

import {
  assembleGitBinding,
  assembleMemoryStores,
  MemoryAttemptRegister,
  MemoryClaimStore,
  MemoryLedger,
  type Engine,
} from "../index.js";
import { openGitBinding } from "../adapters/git/index.js";

import { declaredTagNaming } from "./naming.js";
import type { AssemblySelection } from "./parse.js";

/** Build the engine the invocation names. Throws the assembly's own
 * structural error (`InvalidAssemblyConfigError`) for a config the
 * boundary refuses — which is a fault, exit 70, never a rendered
 * outcome (§3.2's fault band is not the `refused` kind). */
export const selectEngine = (selection: AssemblySelection): Engine => {
  if (selection.assembly === "memory") {
    return assembleMemoryStores(
      {
        register: new MemoryAttemptRegister(),
        ledger: new MemoryLedger(),
        claims: new MemoryClaimStore(),
      },
      { maxRetries: selection.maxRetries },
    );
  }
  return assembleGitBinding(
    openGitBinding({
      repo: selection.repo,
      tagNaming: declaredTagNaming(selection.tagNamespaces),
    }),
    { maxRetries: selection.maxRetries },
  );
};
