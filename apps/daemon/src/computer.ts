import type {
  ComputerAction,
  ComputerFrameEvent,
  ComputerMachineCapabilities,
  ComputerPickerState,
  ComputerRealmView,
  ComputerUserInput,
} from "@eta/client-contracts";
import type { CallFrame, StateSnapshot } from "@eta/client-wire-proto";
import type {
  ManagedRealm,
  ProbeWindowsCapabilitiesOptions,
  RealmDriver,
  RealmEvent,
  RealmManager,
} from "@eta/computer";
import type { WireService } from "@eta/server";
/**
 * Computer Use realms on a daemon's wire (`computer`, `computer.<realmId>`).
 *
 * Publishes `computer` (`realms`, `capabilities`) and per-realm targets `computer.<realmId>`
 * (`info` section + `frame` / `cursor` / `picker` events + actions `takeover`, `release`,
 * `pause`, `resume`, `stop`, `input`, `resolvePicker`, `close`).
 *
 * Frame traffic is strictly warm-on-subscribe: `realm.watch(...)` is attached when a pipe
 * subscriber subscribes to `computer.<realmId>` and unwatched immediately when the last
 * subscriber unsubscribes or drops, so `0` frame events are produced or sent while unwatched.
 * Any frame whose serialized link envelope would exceed `LINK_LIMITS.maxFrameBytes` (8 MiB) is
 * skipped before calling `wire.event` so it can never close the link with 1009.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { COMPUTER_ACTIONS, LINK_LIMITS } from "@eta/client-contracts";
import { probeWindowsCapabilities } from "@eta/computer";

export interface MountDaemonComputerOptions {
  capabilities?:
    | ComputerMachineCapabilities
    | (() => ComputerMachineCapabilities)
    | undefined;
  probeOptions?: ProbeWindowsCapabilitiesOptions | undefined;
  maxFrameBytes?: number | undefined;
}

interface AttachedRealm {
  readonly realm: ManagedRealm;
  unwatch: (() => void) | undefined;
  readonly offs: (() => void)[];
}

function revisionOf(value: unknown): string {
  const json = JSON.stringify(value);
  if (
    typeof globalThis.Bun !== "undefined" &&
    typeof globalThis.Bun.hash === "function"
  ) {
    return globalThis.Bun.hash(json).toString(36);
  }
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

function argsRecord(call: CallFrame): Record<string, unknown> {
  const raw = call.args ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${call.target}.${call.action} takes an object`);
  }
  return raw as Record<string, unknown>;
}

/**
 * Estimate whether a `frame` event on `target` fits within `maxFrameBytes` when wrapped in the
 * link's `{ ch: "pipe", frame: { type: "event", target, name: "frame", data, at } }` JSON
 * envelope.
 */
export function isComputerFrameWithinBudget(
  target: string,
  frame: ComputerFrameEvent,
  maxFrameBytes: number = LINK_LIMITS.maxFrameBytes,
): boolean {
  if (typeof frame.data === "string" && frame.data.length > maxFrameBytes) {
    return false;
  }
  const envelope = {
    ch: "pipe",
    frame: {
      type: "event",
      target,
      name: "frame",
      data: frame,
      at: frame.at,
    },
  };
  return Buffer.byteLength(JSON.stringify(envelope), "utf8") <= maxFrameBytes;
}

export function mountDaemonComputer(
  wire: WireService,
  manager: RealmManager,
  options: MountDaemonComputerOptions = {},
): () => void {
  const maxFrameBytes = options.maxFrameBytes ?? LINK_LIMITS.maxFrameBytes;
  let cachedCapabilities: ComputerMachineCapabilities | undefined;
  const readCapabilities = (): ComputerMachineCapabilities => {
    if (typeof options.capabilities === "function") {
      return options.capabilities();
    }
    if (options.capabilities !== undefined) {
      return options.capabilities;
    }
    if (cachedCapabilities === undefined) {
      const probed = probeWindowsCapabilities({
        machineId: manager.machineId,
        ...options.probeOptions,
      });
      cachedCapabilities = {
        machineId: probed.machineId,
        os: probed.os,
        ...(probed.edition === undefined ? {} : { edition: probed.edition }),
        browser: probed.browser,
        ...(probed.browserExecutable === undefined
          ? {}
          : { browserExecutable: probed.browserExecutable }),
        windowsChildSession: probed.windowsChildSession,
        windowsHiddenDesktop: probed.windowsHiddenDesktop,
      };
    }
    return cachedCapabilities;
  };

  const attached = new Map<string, AttachedRealm>();
  const rootOffs: (() => void)[] = [];

  const syncWatchState = (realmId: string): void => {
    const entry = attached.get(realmId);
    if (entry === undefined) return;
    const target = `computer.${realmId}`;
    const hasWatchers = wire.state.watcherCount(target) > 0;
    if (hasWatchers && entry.unwatch === undefined) {
      entry.unwatch = entry.realm.watch((event: RealmEvent) => {
        if (wire.state.watcherCount(target) === 0) {
          const stop = entry.unwatch;
          entry.unwatch = undefined;
          stop?.();
          return;
        }
        switch (event.type) {
          case "frame":
            if (
              !isComputerFrameWithinBudget(target, event.frame, maxFrameBytes)
            ) {
              return;
            }
            wire.event(target, "frame", event.frame);
            break;
          case "cursor":
            wire.event(target, "cursor", event.cursor);
            break;
          case "picker":
            wire.event(target, "picker", event.picker);
            break;
          case "state":
            break;
        }
      });
    } else if (!hasWatchers && entry.unwatch !== undefined) {
      const stop = entry.unwatch;
      entry.unwatch = undefined;
      stop();
    }
  };

  const dispatchRealmAction = async (
    realm: ManagedRealm,
    action: ComputerAction,
    args: Record<string, unknown>,
  ): Promise<ComputerRealmView | ComputerPickerState> => {
    const reason =
      typeof args.reason === "string" && args.reason.trim() !== ""
        ? args.reason
        : undefined;
    switch (action) {
      case "takeover":
        return realm.takeover(reason);
      case "release":
        return realm.release(reason);
      case "pause":
        return realm.pause(reason);
      case "resume":
        return realm.resume(reason);
      case "stop":
        return realm.stop(reason);
      case "input": {
        const input = args.input as ComputerUserInput | undefined;
        if (
          input === undefined ||
          typeof input !== "object" ||
          input === null
        ) {
          throw new Error(`computer.${realm.id}.input needs input`);
        }
        await realm.userInput(input);
        return realm.view();
      }
      case "resolvePicker": {
        const files = args.files;
        if (
          !Array.isArray(files) ||
          !files.every((item): item is string => typeof item === "string")
        ) {
          throw new Error(`computer.${realm.id}.resolvePicker needs files`);
        }
        return await realm.resolvePicker(files);
      }
      case "close":
        return await realm.close(reason);
      case "promote": {
        // The daemon owns the screen it would switch, but not the chat bridge or the host's
        // timers: overlays still work, they just cannot forward text without a conversation.
        const driver = realm.driverForPromote();
        if (driver === undefined) {
          throw new Error(
            `computer.${realm.id}.promote: this realm cannot take the screen`,
          );
        }
        realm.takeover("Brought to your screen");
        try {
          await driver.promote();
        } catch (error) {
          realm.release("Could not switch the screen");
          throw error;
        }
        realm.setPromoted(true);
        const timer = setTimeout(
          () => {
            void driver
              .demote()
              .catch(() => {})
              .finally(() => {
                realm.setPromoted(false);
                if (realm.view().controller === "user") {
                  realm.release("Promotion time limit reached");
                }
              });
          },
          30 * 60 * 1000,
        );
        timer.unref?.();
        return realm.view();
      }
      case "demote": {
        try {
          await realm.driverForPromote()?.demote();
        } finally {
          realm.setPromoted(false);
          if (realm.view().controller === "user") {
            realm.release("Back to your desktop");
          }
        }
        return realm.view();
      }
    }
  };

  const attachRealm = (realm: ManagedRealm): void => {
    if (attached.has(realm.id)) return;
    const target = `computer.${realm.id}`;
    const offs: (() => void)[] = [];
    const entry: AttachedRealm = {
      realm,
      unwatch: undefined,
      offs,
    };
    attached.set(realm.id, entry);

    offs.push(
      wire.stateOf(target, {
        project: (): StateSnapshot => {
          const info = realm.view();
          return {
            sections: { info },
            revisions: { info: revisionOf(info) },
          };
        },
      }),
      realm.onState(() => {
        wire.pushNow(target);
        wire.pushNow("computer");
      }),
    );

    for (const action of COMPUTER_ACTIONS) {
      offs.push(
        wire.handle(target, action, async (call) => {
          const args = argsRecord(call);
          const result = await dispatchRealmAction(realm, action, args);
          return { result };
        }),
      );
    }

    syncWatchState(realm.id);
    wire.pushNow("computer");
  };

  for (const realm of manager.list()) {
    attachRealm(realm);
  }

  // Intercept future realm registrations on this manager so newly created realms are published
  // onto the daemon's WireService automatically.
  const originalRegister = manager.register.bind(manager);
  const patchedRegister: typeof manager.register = (
    driver: RealmDriver,
    metadata,
  ) => {
    const realm = originalRegister(driver, metadata);
    attachRealm(realm);
    return realm;
  };
  manager.register = patchedRegister;
  rootOffs.push(() => {
    if (manager.register === patchedRegister) {
      manager.register = originalRegister;
    }
  });

  // Intercept wire.subscribe / wire.unsubscribe / wire.dropSocket so warm-on-subscribe and
  // cool-on-unsubscribe happen synchronously on subscription transitions.
  const mutableWire = wire as {
    subscribe: WireService["subscribe"];
    unsubscribe: WireService["unsubscribe"];
    dropSocket: WireService["dropSocket"];
  };
  const originalSubscribe = wire.subscribe;
  const originalUnsubscribe = wire.unsubscribe;
  const originalDropSocket = wire.dropSocket;

  const syncTargetOrAll = (target?: string): void => {
    if (target !== undefined) {
      if (!target.startsWith("computer.")) return;
      const realmId = target.slice("computer.".length);
      if (attached.has(realmId)) {
        syncWatchState(realmId);
      }
      return;
    }
    for (const realmId of attached.keys()) {
      syncWatchState(realmId);
    }
  };

  mutableWire.subscribe = (
    socketId: number,
    target: string,
    filter?: string,
  ): void => {
    if (target.startsWith("computer.")) {
      const realmId = target.slice("computer.".length);
      const existing = manager.get(realmId);
      if (existing !== undefined && !attached.has(realmId)) {
        attachRealm(existing);
      }
    }
    originalSubscribe(socketId, target, filter);
    syncTargetOrAll(target);
  };

  mutableWire.unsubscribe = (socketId: number, target: string): void => {
    originalUnsubscribe(socketId, target);
    syncTargetOrAll(target);
  };

  mutableWire.dropSocket = (socketId: number): void => {
    originalDropSocket(socketId);
    syncTargetOrAll();
  };

  rootOffs.push(() => {
    if (mutableWire.subscribe !== originalSubscribe)
      mutableWire.subscribe = originalSubscribe;
    if (mutableWire.unsubscribe !== originalUnsubscribe)
      mutableWire.unsubscribe = originalUnsubscribe;
    if (mutableWire.dropSocket !== originalDropSocket)
      mutableWire.dropSocket = originalDropSocket;
  });

  rootOffs.push(
    wire.stateOf("computer", {
      eager: true,
      project: (): StateSnapshot => {
        for (const realm of manager.list()) {
          if (!attached.has(realm.id)) attachRealm(realm);
        }
        const realms = manager.views();
        const capabilities = [readCapabilities()];
        return {
          sections: { realms, capabilities },
          revisions: {
            realms: revisionOf(realms),
            capabilities: revisionOf(capabilities),
          },
        };
      },
    }),
  );

  for (const action of COMPUTER_ACTIONS) {
    rootOffs.push(
      wire.handle("computer", action, async (call) => {
        const args = argsRecord(call);
        const realmId = args.realmId;
        if (typeof realmId !== "string" || realmId.trim() === "") {
          throw new Error(`computer.${action} needs realmId`);
        }
        const realm = manager.require(realmId);
        if (!attached.has(realm.id)) attachRealm(realm);
        const result = await dispatchRealmAction(realm, action, args);
        return { result };
      }),
    );
  }

  return () => {
    for (const entry of attached.values()) {
      const stop = entry.unwatch;
      entry.unwatch = undefined;
      stop?.();
      for (const off of entry.offs.splice(0)) off();
    }
    attached.clear();
    for (const off of rootOffs.splice(0)) off();
  };
}
