/**
 * The git-backed channel store (ADR-0012 decision 6's physical half) —
 * the deliverability pointer's durable record. One ref per channel under
 * the binding's channel namespace — `refs/ecoma/channels/<sha256 of the
 * channel id's UTF-8 bytes>`, the claim register's own mapping (ADR-0011):
 * channel ids are opaque strings a refname cannot carry verbatim, and
 * ADR-0012's `refs/ecoma/channels/<id>` names the channel the ref is for,
 * not the literal bytes. The tip commit's blob is the channel's state in
 * canonical form — `{"channel":{"id":…,"target":{…}|null}}`; a channel
 * ref whose blob is anything else refuses loudly, because a corrupted
 * recorded pointer read as the hidden state would erase a channel
 * silently (ADR-0011 decision 5's discipline).
 *
 * The move is a compare-and-set over the whole recorded state: content and
 * base in one read, the decision taken over that read, the land a pure
 * extension of the recorded history — and a lost CAS re-reads and
 * re-evaluates, never adjudicating against stale state (ADR-0011
 * decision 2's loop). A fault around the land itself leaves the store
 * unable to prove whether the move ran: the outcome is `ambiguous`, never
 * a claimed `applied` — the promotion does not race forward on
 * uncertainty (invariant 2.6; ADR-0012 decision 7), and a resume
 * re-executes against whatever the recorded state proves, converging
 * either way. Read-side faults stay throws — every fault the substrate
 * reports refuses loudly: a corrupted blob is not the hidden state, and a
 * state whose id does not map back onto its own ref is refused at the
 * read boundary (no writer of the canonical form produces one). The one
 * gap lives below the store: `readRef` swallows every git fault as
 * absence, so a ref git cannot read (a broken ref file) also reads as the
 * hidden channel — the substrate's absence-vs-fault discrimination is
 * tracked in #95 and shared with the claim register.
 */

import { createHash } from "node:crypto";

import {
  type ChannelApplyOutcome,
  type ChannelMove,
  channelStateFingerprint,
  type ChannelState,
  type ChannelStore,
} from "../../index.js";
import { canonicalJson } from "../../planner/index.js";

import { casAppendCommit, commitRecord, readRef } from "./git-refs.js";
import { deepFreeze, frozenParse } from "./freeze.js";
import { GitFaultError, openGitRun, type GitRun } from "./git-run.js";

/** The binding's channel-ref namespace: one state ref per channel. */
export const CHANNEL_REF_NAMESPACE = "refs/ecoma/channels/";

/** The channel's state ref: the sha256 over the channel id's UTF-8 bytes. */
export function channelRefFor(channelId: string): string {
  const digest = createHash("sha256").update(channelId, "utf8").digest("hex");
  return `${CHANNEL_REF_NAMESPACE}${digest}`;
}

/** The state envelope's canonical form: one channel's serialized value —
 *  exactly the fields, in canonical JSON's key order. */
const canonicalChannel = (state: ChannelState): string =>
  canonicalJson({
    channel: {
      id: state.id,
      target:
        state.target === null ? null : { line: state.target.line, version: state.target.version },
    },
  });

/** The target carries exactly the two fields — an extra field is as
 *  foreign as a missing one (the canonical form is the whole shape). */
const targetKeys = (value: object): boolean => {
  const keys = Object.keys(value).sort();
  return keys.length === 2 && keys[0] === "line" && keys[1] === "version";
};

/** One envelope's shape check — the fields the store computes over must
 *  be what the canonical form promises, exactly; anything else is
 *  corrupted recorded state and refuses loudly. */
const asChannelState = (value: unknown, ref: string): ChannelState => {
  if (
    value !== null &&
    typeof value === "object" &&
    "channel" in value &&
    value.channel !== null &&
    typeof value.channel === "object" &&
    "id" in value.channel &&
    typeof value.channel.id === "string" &&
    "target" in value.channel
  ) {
    const target: unknown = value.channel.target;
    if (target === null) {
      return { id: value.channel.id, target: null };
    }
    if (
      typeof target === "object" &&
      "line" in target &&
      typeof target.line === "string" &&
      "version" in target &&
      typeof target.version === "string" &&
      targetKeys(target)
    ) {
      return {
        id: value.channel.id,
        target: { line: target.line, version: target.version },
      };
    }
  }
  throw new TypeError(
    `the channel namespace pins channel-state envelopes ({"channel":{"id":…,"target":…|null}}); ${ref} does not`,
  );
};

/** The read boundary's one invariant: a state returned for `ref` is the
 *  state of that ref — its id maps back onto the refname. An envelope
 *  keyed to another channel under this ref is recorded corruption no
 *  writer of the canonical form could produce (the mapping is derived
 *  from the id) and refuses loudly — the ledger's idempotency key would
 *  otherwise follow the wrong channel (the register's ADR-0011 decision
 *  5 discipline). `list()`'s read of a just-listed ref takes the hidden
 *  path only when the ref vanished mid-iteration, which its blank
 *  placeholder fails here — the store never invents a channel id. */
const checkRefIdentity = (state: ChannelState, ref: string): ChannelState => {
  if (channelRefFor(state.id) !== ref) {
    throw new TypeError(
      `the channel namespace pins one channel per ref: ${ref} carries channel ${JSON.stringify(state.id)}`,
    );
  }
  return state;
};

/** The state and the base of its next compare-and-set, from one read —
 *  the pair is a move's whole opening state (the claim register's
 *  `RegisterRead` discipline). `tip` is null when the ref is absent; the
 *  absent ref reads as the hidden channel (S-02), under the caller's
 *  channel id — the sha256 mapping is one-way, so the id travels in the
 *  envelope and the hidden read takes it from the caller. */
interface ChannelRead {
  readonly tip: string | null;
  readonly state: ChannelState;
}

const readChannelAt = (git: GitRun, ref: string, channelId: string): ChannelRead => {
  const tip = readRef(git, ref);
  if (tip === null) {
    return { tip: null, state: checkRefIdentity({ id: channelId, target: null }, ref) };
  }
  const envelope: unknown = frozenParse(commitRecord(git, tip));
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    !("channel" in envelope)
  ) {
    throw new TypeError(
      `the channel namespace pins channel-state envelopes ({"channel":…}); ${ref} does not`,
    );
  }
  return { tip, state: checkRefIdentity(asChannelState(envelope, ref), ref) };
};

/** Target equality by value — line string equality plus the canonical
 *  version string. `null` equals `null` only: the hidden state is one
 *  state, and a channel the store never recorded is that same state. */
const targetsEqual = (left: ChannelState["target"], right: ChannelState["target"]): boolean => {
  if (left === null || right === null) {
    return left === null && right === null;
  }
  return left.line === right.line && left.version === right.version;
};

/**
 * Opens the git-backed channel store on `repo`. Reads are total — a
 * channel with no recorded ref reads as the hidden channel; `list`
 * enumerates the recorded refs in refname order. The move is the whole-
 * state CAS loop; its outcomes are returned values, never exceptions,
 * with the one loud class a corrupted blob demands (ADR-0012 decision 6;
 * the ambiguity law is decision 7).
 */
export class GitChannelStore implements ChannelStore {
  readonly #git: GitRun;

  constructor(repo: string) {
    this.#git = openGitRun(repo);
  }

  read(channelId: string): ChannelState {
    const { state } = readChannelAt(this.#git, channelRefFor(channelId), channelId);
    return deepFreeze(state) as ChannelState;
  }

  list(): readonly ChannelState[] {
    return this.#git(["for-each-ref", "--format=%(refname)", CHANNEL_REF_NAMESPACE])
      .split("\n")
      .filter((line) => line.length > 0)
      .map((ref) => {
        // The blank placeholder cannot pass the read boundary's identity
        // check on the hidden path — a listed ref that vanished
        // mid-iteration refuses loudly; list never invents a channel id.
        const { state } = readChannelAt(this.#git, ref, "");
        return deepFreeze(state) as ChannelState;
      });
  }

  applyTransition(move: ChannelMove): ChannelApplyOutcome {
    const ref = channelRefFor(move.channelId);
    for (;;) {
      // One read: the state and the base of this iteration's CAS together.
      const { tip, state } = readChannelAt(this.#git, ref, move.channelId);
      const fingerprint = channelStateFingerprint(state);
      if (targetsEqual(state.target, move.to)) {
        // The move already stands — the replay outcome (ADR-0012 decision
        // 4: a replay of an already-applied move is `noop`, never a
        // second move).
        return deepFreeze({ kind: "noop", contentFingerprint: fingerprint }) as ChannelApplyOutcome;
      }
      if (!targetsEqual(state.target, move.from)) {
        return deepFreeze({
          kind: "conflict",
          contentFingerprint: fingerprint,
          observed: state.target === null ? null : { ...state.target },
        }) as ChannelApplyOutcome;
      }
      const landed: ChannelState = {
        id: move.channelId,
        target: move.to === null ? null : { ...move.to },
      };
      let commit: string | null;
      try {
        commit = casAppendCommit(this.#git, ref, canonicalChannel(landed), tip);
      } catch (error) {
        // A fault around the land: whether the move ran is not provable
        // here, and the store refuses to claim it did (ADR-0012 decision
        // 7 — `ambiguous`, fail closed). A resume re-executes against the
        // recorded state: `noop` if the land quietly succeeded, a clean
        // re-apply if it did not — converging either way.
        if (error instanceof GitFaultError) {
          return deepFreeze({
            kind: "ambiguous",
            detail: `the land of ${JSON.stringify(move.channelId)} threw a git fault: ${error.message}`,
          }) as ChannelApplyOutcome;
        }
        throw error;
      }
      if (commit !== null) {
        return deepFreeze({
          kind: "applied",
          contentFingerprint: fingerprint,
        }) as ChannelApplyOutcome;
      }
      // The ref moved under the decision — a concurrent winner on the same
      // channel. Loop: re-read, re-evaluate, land or classify.
    }
  }
}
