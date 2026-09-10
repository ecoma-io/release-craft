/**
 * The git binding opened on one repository (contract §2.6; ADR-0009
 * decision 8). One factory, one shared runner: every port the binding
 * exposes — the ledger, the attempt register, the claim store, the
 * channel store, the tag door, the artifact producer — is the
 * git-backed implementation of an
 * engine port over the same repository through the same hermetic runner,
 * and the read seam the remote projection reads (§2.7) enumerates the
 * same repository's recorded refs. No port here exists in the engine's
 * own surface: the assembly wires them in at ADR-0008's seams and
 * ADR-0005's kernel constructor, and the engine never learns the backing
 * is git.
 */

import type {
  ArtifactProducer,
  AttemptRegister,
  ChannelStore,
  ClaimStore,
  ExecutionLedger,
} from "@ecoma-io/release-craft/execution";

import type { BindingConfig, ContentRead, RefRead } from "./binding-types.js";
import { GitChannelStore } from "./channel-store-git.js";
import { GitClaimStore } from "./claim-store-git.js";
import { GitContentRead } from "./content-read.js";
import { GitLedger } from "./ledger-git.js";
import { GitArtifactProducer } from "./producer-git.js";
import { GitAttemptRegister } from "./register-git.js";
import { openGitRun, type GitRun } from "./git-run.js";
import { GitRefRead } from "./refs-read.js";
import { GitTagDoor, type TagMint } from "./tag-door.js";

/** The binding the assembly receives (contract §2.6): the three ports and
 * the two doors, all bound to one repository. */
export interface GitBinding {
  /** The git-backed execution ledger. */
  readonly ledger: ExecutionLedger;
  /** The git-backed attempt register. */
  readonly register: AttemptRegister;
  /** The git-backed claim store — acquire lands the claim through the
   * line's whole-register CAS (ADR-0011), and a scope the declared naming
   * maps to no tag is denied before git sees it (§2.4's namespace door at
   * the acquisition, `holder` absent). */
  readonly claims: ClaimStore;
  /** The binding's own door — the tag mint (§2.6): refused (`namespace`,
   * `unclaimed`, `foreign-token`) and conflict outcomes are returned
   * values, never exceptions. */
  readonly mintTag: TagMint;
  /** The git-backed channel store (ADR-0012 decision 6) — the
   * deliverability pointer's durable half, the port the application layer
   * drives the `channel-transition` stage's recorded moves through. The
   * kernel never consumes it (invariant 2.1). */
  readonly channels: ChannelStore;
  /** The git-backed artifact producer — the digest of the repository's
   *  recorded content (ADR-0008 decision 12's first half, §2.5). */
  readonly producer: ArtifactProducer;
  /** The repository path the binding was opened on (the Phase 9
   *  contract §2.7; D26) — its own configuration value, the remote
   *  projection's transport target. State reads never use it; they go
   *  through `refs`. */
  readonly repo: string;
  /** The recorded refs' read-only enumeration (the Phase 9 contract
   *  §2.7; D26): the claim refs and the declared-namespace tags, each
   *  with the object it names — the register blob, the tag's peeled
   *  commit. */
  readonly refs: RefRead;
  /** The content read seam (the Phase 9 contract §2.8; D27): the
   *  release projection's read-only half — the minting claim, the
   *  naming's derivation, the attempt's recorded stream, and one file
   *  out of a recorded tree. Reads only: no write is reachable
   *  through it. */
  readonly content: ContentRead;
}

/**
 * Opens the git binding on `repo` (synchronously — every door it returns
 * is synchronous, §2.1). One runner, one repository: the binding reads
 * and writes nothing beyond the repository it is opened on (ADR-0009
 * decision 7), and the tag names it can ever create are bounded by the
 * configuration's declared naming.
 */
export function openGitBinding(config: BindingConfig): GitBinding {
  const git: GitRun = openGitRun(config.repo);
  const store = new GitClaimStore(config.repo);
  // The namespace door runs at both doors, before any ref moves (§2.4): a
  // scope the declared naming maps to no tag is denied at acquire — holder
  // absent, no register move written — and a mint outside it is refused at
  // the mint door (§2.6's `namespace` refusal class).
  const claims: ClaimStore = {
    acquire: (scope, attemptId) =>
      config.tagNaming.tagFor(scope) === null
        ? { kind: "denied", scope, refusal: "namespace" }
        : store.acquire(scope, attemptId),
    verify: (token) => store.verify(token),
    release: (token) => {
      store.release(token);
    },
  };
  const ledger = new GitLedger(git);
  return {
    ledger,
    register: new GitAttemptRegister(git),
    claims,
    channels: new GitChannelStore(config.repo),
    mintTag: GitTagDoor(git, config.tagNaming),
    producer: GitArtifactProducer(config.repo),
    repo: config.repo,
    refs: GitRefRead(git, config.tagNaming.namespaces),
    content: GitContentRead(git, config.tagNaming, ledger),
  };
}
