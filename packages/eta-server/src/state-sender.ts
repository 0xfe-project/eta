/**
 * The state sender: per-socket baselines, and the frames a subscription earns.
 *
 * One job: for each socket that subscribed to a target, send the *smallest* frame that gets
 * it up to date — a snapshot when it holds nothing, a patch when some sections moved, and
 * nothing at all when they did not. The rule lives in `stateDiff`; this file is the
 * bookkeeping around it (which socket holds which revisions, and who is subscribed).
 *
 * It deliberately does not decide *when* to send: a caller that owns a run or a timer calls
 * `push`. Pacing (how often a frame may go out) is the pacer's business, a layer above this.
 */
import {
  type ServerFrame,
  type StatePatch,
  type StateSnapshot,
  stateDiff,
} from "@eta/client-wire-proto";

/** What one subscriber holds, as far as this sender knows. */
interface Baseline {
  revisions: Record<string, string> | undefined;
  /** The event-name filter this subscriber asked for, if any. */
  filter?: string | undefined;
}

export interface StateSenderOptions {
  /** Look one target's state up. Undefined means the target shows nothing (any more). */
  snapshot(target: string): StateSnapshot | undefined;
  /** Diagnostics: a push for a target nobody has. */
  warn?(message: string): void;
}

/** One frame, and the socket it is for. The sender decides; the pipe delivers. */
export interface AddressedFrame {
  socketId: number;
  frame: ServerFrame;
}

export interface StateSender {
  /**
   * A socket wants a target's state. Returns what to send it now (a full snapshot, or
   * nothing when it was already current), and from then on `push` keeps it up to date.
   */
  subscribe(socketId: number, target: string, filter?: string): ServerFrame[];
  /** The event filter a socket asked for on a target. */
  filterOf(socketId: number, target: string): string | undefined;
  /** Whether this socket is already subscribed to this target. */
  watches(socketId: number, target: string): boolean;
  unsubscribe(socketId: number, target: string): void;
  /** Which targets one socket is subscribed to. */
  subscriptions(socketId: number): string[];
  /** Say that a target's state may have moved: whoever is behind gets what it is missing. */
  push(target: string): AddressedFrame[];
  /**
   * What one socket is owed for one target, right now — the same decision `push` makes,
   * for one subscriber. `undefined` when it is current (or not subscribed). This is the
   * seam a frame budget sits on: pacing decides *when* to ask, this decides *what*.
   */
  pending(socketId: number, target: string): AddressedFrame | undefined;
  /** Every socket watching a target, with the event filter each one asked for. */
  watchersOf(
    target: string,
  ): { socketId: number; filter?: string | undefined }[];
  /**
   * How many sockets are watching a target.
   *
   * Deliberately separate from `watchersOf`, which returns the sockets *with their filters*:
   * delivery needs the filter (to decide whether this subscriber wants this event), while
   * "is anybody watching" needs a number.
   */
  watcherCount(target: string): number;
  /** Forget a socket (it disconnected). */
  drop(socketId: number): void;
}

export function createStateSender(options: StateSenderOptions): StateSender {
  /** socket → target → what that socket holds. */
  const subscriptions = new Map<number, Map<string, Baseline>>();

  const frameFor = (
    socketId: number,
    target: string,
    version: number,
    snapshot: StateSnapshot,
    held: Baseline,
  ): AddressedFrame | undefined => {
    const diff = stateDiff(held.revisions, snapshot);
    if (diff === undefined) return undefined;
    if (diff === "full") {
      held.revisions = snapshot.revisions;
      return { socketId, frame: { type: "state", target, version, snapshot } };
    }
    held.revisions = (diff as StatePatch).revisions;
    return { socketId, frame: { type: "state", target, version, patch: diff } };
  };

  return {
    subscribe(socketId, target, filter): ServerFrame[] {
      const held = subscriptions.get(socketId) ?? new Map<string, Baseline>();
      subscriptions.set(socketId, held);
      // Already watching: the client is current by construction, so nothing is owed. A
      // filter that changed is worth re-reading, though — it is a different question.
      const watching = held.get(target);
      if (watching !== undefined) {
        if (watching.filter === filter) return [];
        watching.filter = filter;
        return [];
      }
      const baseline: Baseline = {
        revisions: undefined,
        ...(filter === undefined ? {} : { filter }),
      };
      held.set(target, baseline);
      const snapshot = options.snapshot(target);
      if (snapshot === undefined) {
        options.warn?.(
          `[eta-server] subscribe to a target with no state: ${target}`,
        );
        return [];
      }
      const addressed = frameFor(socketId, target, 1, snapshot, baseline);
      return addressed === undefined ? [] : [addressed.frame];
    },

    unsubscribe(socketId, target): void {
      const held = subscriptions.get(socketId);
      held?.delete(target);
      if (held?.size === 0) subscriptions.delete(socketId);
    },

    watches(socketId, target): boolean {
      return subscriptions.get(socketId)?.has(target) === true;
    },

    filterOf(socketId, target): string | undefined {
      return subscriptions.get(socketId)?.get(target)?.filter;
    },

    subscriptions(socketId): string[] {
      return [...(subscriptions.get(socketId)?.keys() ?? [])].sort();
    },

    push(target): AddressedFrame[] {
      const snapshot = options.snapshot(target);
      if (snapshot === undefined) {
        options.warn?.(
          `[eta-server] state push for a target nobody has: ${target}`,
        );
        return [];
      }
      const out: AddressedFrame[] = [];
      for (const [socketId, targets] of subscriptions) {
        const baseline = targets.get(target);
        if (baseline === undefined) continue;
        const addressed = frameFor(socketId, target, 1, snapshot, baseline);
        if (addressed !== undefined) out.push(addressed);
      }
      return out;
    },

    pending(socketId, target): AddressedFrame | undefined {
      const baseline = subscriptions.get(socketId)?.get(target);
      if (baseline === undefined) return undefined;
      const snapshot = options.snapshot(target);
      if (snapshot === undefined) return undefined;
      return frameFor(socketId, target, 1, snapshot, baseline);
    },

    watchersOf(target): { socketId: number; filter?: string | undefined }[] {
      const out: { socketId: number; filter?: string | undefined }[] = [];
      for (const [socketId, targets] of subscriptions) {
        const baseline = targets.get(target);
        if (baseline === undefined) continue;
        out.push({
          socketId,
          ...(baseline.filter === undefined ? {} : { filter: baseline.filter }),
        });
      }
      return out.sort((left, right) => left.socketId - right.socketId);
    },

    drop(socketId): void {
      subscriptions.delete(socketId);
    },

    watcherCount(target): number {
      let count = 0;
      for (const targets of subscriptions.values())
        if (targets.has(target)) count += 1;
      return count;
    },
  };
}
