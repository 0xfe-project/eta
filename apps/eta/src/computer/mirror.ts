import type {
  ComputerAction,
  ComputerFrameEvent,
  ComputerMachineCapabilities,
  ComputerRealmView,
} from "@eta/client-contracts";
import type { StatePatch, StateSnapshot } from "@eta/client-wire-proto";
import type { WireService } from "@eta/server";
import type { MachineHub, MachineLink } from "../machines/hub";
/**
 * Remote Computer Use realms on the primary's own wire (`computer.<realmId>`).
 *
 * Follows the exact warm-on-subscribe discipline of `apps/eta/src/machines/mirror.ts`:
 *
 * - For each remote realm on a daemon, registers `computer.<realmId>` on the primary's
 *   `WireService` (state + `takeover` / `release` / `pause` / `resume` / `stop` / `input` /
 *   `resolvePicker` / `close` actions).
 * - Warm only while someone is watching: when a browser client subscribes to `computer.<realmId>`
 *   on the primary, subscribes to `computer.<realmId>` on the daemon's `link.pipe` (so the
 *   daemon's `RealmManager` enables `setWatched(true)` and streams frames).
 * - When the last browser watcher leaves (`wire.state.watcherCount(target) === 0`) or the link
 *   drops (`hub.onLost`), unsubscribes/cools the mirror immediately so 0 frame traffic crosses
 *   the link when unwatched.
 * - Enforces `LINK_LIMITS.maxFrameBytes` (8 MiB): drops or skips any frame event exceeding the
 *   frame budget so it can never close a link with 1009.
 * - Deduplicates replayed events after a reconnect using strictly increasing `at` timestamps
 *   (`at > mirror.lastAt`), ensuring the browser never sees duplicate `frame`, `cursor`, or
 *   `picker` events.
 * - Also follows the daemon's `computer` target (`realms` and `capabilities`) while the link is
 *   up so the primary can aggregate remote realms and machine capabilities alongside local ones.
 */
import { Buffer } from "node:buffer";
import { COMPUTER_ACTIONS, LINK_LIMITS } from "@eta/client-contracts";

export interface ComputerRealmMirrorEntry {
  readonly machineId: string;
  readonly target: string;
  snapshot: StateSnapshot | undefined;
  off: () => void;
  warm: boolean;
  /** The timestamp of the newest event republished; replayed events with `at <= lastAt` are ignored. */
  lastAt: number;
}

interface FollowedComputer {
  snapshot: StateSnapshot | undefined;
  online: boolean;
}

export interface ComputerRealmMirrorsOptions {
  maxFrameBytes?: number | undefined;
  nameOf?: ((machineId: string) => string | undefined) | undefined;
}

/**
 * Check whether an incoming `frame` event payload fits within `maxFrameBytes` when serialized as a
 * link / wire frame.
 */
export function isWithinFrameBudget(
  target: string,
  data: unknown,
  maxFrameBytes: number = LINK_LIMITS.maxFrameBytes,
): boolean {
  if (data === null || typeof data !== "object") {
    return false;
  }
  const frame = data as Partial<ComputerFrameEvent>;
  if (typeof frame.data === "string" && frame.data.length > maxFrameBytes) {
    return false;
  }
  const envelope = {
    ch: "pipe",
    frame: {
      type: "event",
      target,
      name: "frame",
      data,
      at: typeof frame.at === "number" ? frame.at : 0,
    },
  };
  return Buffer.byteLength(JSON.stringify(envelope), "utf8") <= maxFrameBytes;
}

/** Extract an event's monotonic timestamp (`frame.at`, payload `.at` / `.updatedAt`). */
function extractEventTimestamp(
  data: unknown,
  wireAt: number | undefined,
): number | undefined {
  if (data !== null && typeof data === "object") {
    const record = data as { at?: unknown; updatedAt?: unknown };
    if (typeof record.at === "number" && Number.isFinite(record.at)) {
      return record.at;
    }
    if (
      typeof record.updatedAt === "number" &&
      Number.isFinite(record.updatedAt)
    ) {
      return record.updatedAt;
    }
  }
  if (typeof wireAt === "number" && Number.isFinite(wireAt)) {
    return wireAt;
  }
  return undefined;
}

export class ComputerRealmMirrors {
  readonly #hub: MachineHub;
  readonly #maxFrameBytes: number;
  readonly #mirrors = new Map<string, ComputerRealmMirrorEntry>();
  readonly #followed = new Map<string, FollowedComputer>();
  #wire: WireService | undefined;
  #stops: (() => void)[] = [];

  constructor(hub: MachineHub, options: ComputerRealmMirrorsOptions = {}) {
    this.#hub = hub;
    this.#maxFrameBytes = options.maxFrameBytes ?? LINK_LIMITS.maxFrameBytes;
  }

  /** Inspect a registered mirror entry by `realmId`. */
  get(realmId: string): ComputerRealmMirrorEntry | undefined {
    return this.#mirrors.get(realmId);
  }

  /** Whether `realmId` is registered as a remote mirror. */
  owns(realmId: string): boolean {
    return this.#mirrors.has(realmId);
  }

  /** Machine ID that owns `realmId`, if registered. */
  machineOf(realmId: string): string | undefined {
    return this.#mirrors.get(realmId)?.machineId;
  }

  /** Remote realms reported by connected (or previously connected) daemons. */
  realms(): ComputerRealmView[] {
    const out: ComputerRealmView[] = [];
    const seen = new Set<string>();
    for (const [machineId, followed] of this.#followed) {
      const list = followed.snapshot?.sections.realms;
      if (!Array.isArray(list)) continue;
      for (const view of list as ComputerRealmView[]) {
        seen.add(view.id);
        out.push({
          ...view,
          machineId: view.machineId || machineId,
        });
      }
    }
    for (const [realmId, mirror] of this.#mirrors) {
      if (seen.has(realmId)) continue;
      const info = mirror.snapshot?.sections.info as
        | ComputerRealmView
        | undefined;
      if (info !== undefined) {
        out.push({
          ...info,
          machineId: info.machineId || mirror.machineId,
        });
      }
    }
    return out;
  }

  /** Remote machine capabilities reported by connected daemons. */
  capabilities(): ComputerMachineCapabilities[] {
    const out: ComputerMachineCapabilities[] = [];
    for (const [machineId, followed] of this.#followed) {
      const list = followed.snapshot?.sections.capabilities;
      if (!Array.isArray(list)) continue;
      for (const cap of list as ComputerMachineCapabilities[]) {
        out.push({
          ...cap,
          machineId: cap.machineId || machineId,
        });
      }
    }
    return out;
  }

  /**
   * Attach to the primary's `WireService`. Registers any known remote realms, hooks `WireService`
   * subscription transitions for immediate warm/cool, and listens to `hub.onReady` / `hub.onLost`.
   */
  attach(
    wire: WireService,
    known: () => { realmId: string; machineId: string }[] = () => [],
  ): void {
    this.#wire = wire;
    this.#hookWireSubscriptions(wire);
    for (const { realmId, machineId } of known()) {
      this.register(realmId, machineId);
    }
    this.#stops.push(
      this.#hub.onReady((link) => {
        this.#follow(link);
        for (const mirror of this.#mirrors.values()) {
          if (mirror.machineId === link.machineId && this.#watched(mirror)) {
            this.#warm(mirror, link);
          }
        }
      }),
      this.#hub.onLost((machineId) => {
        const followed = this.#followed.get(machineId);
        if (followed !== undefined) {
          followed.online = false;
          if (wire.registry.hasState("computer")) {
            wire.push("computer");
          }
        }
        for (const mirror of this.#mirrors.values()) {
          if (mirror.machineId === machineId) {
            mirror.warm = false;
          }
        }
      }),
    );

    // If any machine links are already ready when attach() is called, follow and warm them now.
    const alreadyReady = new Set<string>();
    for (const mirror of this.#mirrors.values()) {
      alreadyReady.add(mirror.machineId);
    }
    for (const machineId of alreadyReady) {
      const link = this.#hub.link(machineId);
      if (link !== undefined) {
        this.#follow(link);
        for (const mirror of this.#mirrors.values()) {
          if (mirror.machineId === machineId && this.#watched(mirror)) {
            this.#warm(mirror, link);
          }
        }
      }
    }
  }

  detach(): void {
    for (const stop of this.#stops.splice(0)) stop();
    for (const mirror of this.#mirrors.values()) {
      this.#cool(mirror);
      mirror.off();
    }
    this.#mirrors.clear();
    this.#followed.clear();
    this.#wire = undefined;
  }

  /**
   * Register `computer.<realmId>` on the primary's wire (state + all `COMPUTER_ACTIONS`).
   * Idempotent for a given `realmId`.
   */
  register(realmId: string, machineId: string): void {
    const wire = this.#wire;
    if (wire === undefined || this.#mirrors.has(realmId)) return;
    const target = `computer.${realmId}`;
    const offs: (() => void)[] = [];
    const mirror: ComputerRealmMirrorEntry = {
      machineId,
      target,
      snapshot: undefined,
      off: () => {
        for (const dispose of offs.splice(0)) dispose();
      },
      warm: false,
      lastAt: 0,
    };

    offs.push(
      wire.stateOf(target, {
        project: () => {
          // Only warm when an actual watcher is subscribed (or subscribing);
          // avoid warming if snapshot() is queried while nobody is watching.
          if (this.#watched(mirror)) {
            const link = this.#hub.link(machineId);
            if (link !== undefined && !mirror.warm) {
              this.#warm(mirror, link);
            }
          }
          return mirror.snapshot ?? { sections: {}, revisions: {} };
        },
      }),
    );

    for (const action of COMPUTER_ACTIONS) {
      offs.push(
        wire.handle(target, action, async (call) => ({
          result: await this.forward(realmId, action, call.args),
        })),
      );
    }

    this.#mirrors.set(realmId, mirror);

    if (this.#watched(mirror)) {
      const link = this.#hub.link(machineId);
      if (link !== undefined && !mirror.warm) {
        this.#warm(mirror, link);
      }
    }
  }

  /** Forward one `computer.<realmId>` action over `link.pipe.call("computer.<realmId>", action, args)`. */
  async forward(
    realmId: string,
    action: ComputerAction,
    args?: unknown,
  ): Promise<unknown> {
    const mirror = this.#mirrors.get(realmId);
    if (mirror === undefined) {
      throw new Error(`Unknown computer realm: "${realmId}"`);
    }
    const link = this.#hub.link(mirror.machineId);
    if (link === undefined) {
      throw new Error(
        `Machine "${mirror.machineId}" is offline: computer realm "${realmId}" cannot be reached`,
      );
    }
    return await link.pipe.call(mirror.target, action, args ?? {});
  }

  #watched(mirror: ComputerRealmMirrorEntry): boolean {
    const wire = this.#wire;
    if (wire === undefined) return false;
    return wire.state.watchersOf(mirror.target).length > 0;
  }

  #warm(mirror: ComputerRealmMirrorEntry, link: MachineLink): void {
    const wire = this.#wire;
    if (wire === undefined || mirror.warm) return;
    mirror.warm = true;
    link.pipe.subscribe(mirror.target, {
      state: (frame) => {
        mirror.snapshot = frame.snapshot ?? merge(mirror.snapshot, frame.patch);
        if (!this.#watched(mirror)) {
          this.#cool(mirror, link);
          return;
        }
        wire.pushNow(mirror.target);
        if (wire.registry.hasState("computer")) {
          wire.push("computer");
        }
      },
      event: (name, data, at) => {
        if (!this.#watched(mirror)) {
          this.#cool(mirror, link);
          return;
        }
        if (
          name === "frame" &&
          !isWithinFrameBudget(mirror.target, data, this.#maxFrameBytes)
        ) {
          return;
        }
        const eventAt = extractEventTimestamp(data, at);
        if (eventAt !== undefined) {
          if (eventAt <= mirror.lastAt) return;
          mirror.lastAt = eventAt;
        }
        wire.event(mirror.target, name, data);
      },
    });
  }

  #cool(mirror: ComputerRealmMirrorEntry, activeLink?: MachineLink): void {
    if (!mirror.warm) return;
    mirror.warm = false;
    const link = activeLink ?? this.#hub.link(mirror.machineId);
    link?.pipe.unsubscribe(mirror.target);
  }

  #hookWireSubscriptions(wire: WireService): void {
    const mutableWire = wire as {
      subscribe: WireService["subscribe"];
      unsubscribe: WireService["unsubscribe"];
      dropSocket: WireService["dropSocket"];
    };
    const originalSubscribe = wire.subscribe;
    const originalUnsubscribe = wire.unsubscribe;
    const originalDropSocket = wire.dropSocket;

    const syncTarget = (target: string): void => {
      if (!target.startsWith("computer.")) return;
      const realmId = target.slice("computer.".length);
      const mirror = this.#mirrors.get(realmId);
      if (mirror === undefined) return;
      if (this.#watched(mirror)) {
        const link = this.#hub.link(mirror.machineId);
        if (link !== undefined && !mirror.warm) {
          this.#warm(mirror, link);
        }
      } else if (mirror.warm) {
        this.#cool(mirror);
      }
    };

    mutableWire.subscribe = (
      socketId: number,
      target: string,
      filter?: string,
    ): void => {
      originalSubscribe(socketId, target, filter);
      syncTarget(target);
    };

    mutableWire.unsubscribe = (socketId: number, target: string): void => {
      originalUnsubscribe(socketId, target);
      syncTarget(target);
    };

    mutableWire.dropSocket = (socketId: number): void => {
      originalDropSocket(socketId);
      for (const mirror of this.#mirrors.values()) {
        if (!this.#watched(mirror) && mirror.warm) {
          this.#cool(mirror);
        }
      }
    };

    this.#stops.push(() => {
      if (mutableWire.subscribe !== originalSubscribe)
        mutableWire.subscribe = originalSubscribe;
      if (mutableWire.unsubscribe !== originalUnsubscribe)
        mutableWire.unsubscribe = originalUnsubscribe;
      if (mutableWire.dropSocket !== originalDropSocket)
        mutableWire.dropSocket = originalDropSocket;
    });
  }

  /** Follow the daemon's own `computer` target (`realms`, `capabilities`) while its link is up. */
  #follow(link: MachineLink): void {
    const wire = this.#wire;
    if (wire === undefined) return;
    const followed = this.#followed.get(link.machineId) ?? {
      snapshot: undefined,
      online: true,
    };
    followed.online = true;
    this.#followed.set(link.machineId, followed);
    link.pipe.subscribe("computer", {
      state: (frame) => {
        followed.snapshot =
          frame.snapshot ?? merge(followed.snapshot, frame.patch);
        const realms = followed.snapshot?.sections.realms;
        if (Array.isArray(realms)) {
          for (const view of realms as ComputerRealmView[]) {
            if (typeof view?.id === "string" && view.id !== "") {
              this.register(view.id, link.machineId);
            }
          }
        }
        if (wire.registry.hasState("computer")) {
          wire.push("computer");
        }
      },
      event: () => undefined,
    });
  }
}

/** A patch laid over the state it patches; what the patch's revisions do not name is gone. */
function merge(
  previous: StateSnapshot | undefined,
  patch: StatePatch | undefined,
): StateSnapshot | undefined {
  if (patch === undefined) return previous;
  const sections: Record<string, unknown> = {};
  for (const name of Object.keys(patch.revisions)) {
    sections[name] =
      name in patch.sections ? patch.sections[name] : previous?.sections[name];
  }
  return { sections, revisions: patch.revisions };
}
