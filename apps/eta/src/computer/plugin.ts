import type { ComputerAction, ComputerUserInput } from "@eta/client-contracts";
import type { CallFrame } from "@eta/client-wire-proto";
import type { ManagedRealm, RealmDriver, RealmEvent } from "@eta/computer";
import type { WireService } from "@eta/server";
import type { ComputerService } from "./service";
/**
 * The `computer` plugin (`apps/eta/src/computer/plugin.ts`):
 *
 * Publishes:
 * - `computer` target (`realms`, `capabilities`, `groundingModel`)
 * - `computer.<realmId>` targets (`info` section + `frame`, `cursor`, `picker` events)
 *
 * Handles:
 * - `computer.<realmId>` actions (`takeover`, `release`, `pause`, `resume`, `stop`, `input`,
 *   `resolvePicker`, `close`)
 * - `computer` actions (`setGroundingModel`, plus `takeover`, `release`, `pause`, `resume`,
 *   `stop`, `input`, `resolvePicker`, `close` taking `realmId`)
 *
 * Warm-on-subscribe: attaches `realm.watch(...)` only while at least one client is subscribed
 * to `computer.<realmId>`, and detaches immediately when the last watcher leaves.
 */
import { COMPUTER_ACTIONS, LINK_LIMITS } from "@eta/client-contracts";
import { Args, productPlugin, publish } from "../wire";
import { isWithinFrameBudget } from "./mirror";

export interface ComputerPluginDeps {
  service: ComputerService;
  maxFrameBytes?: number | undefined;
}

interface AttachedLocalRealm {
  readonly realm: ManagedRealm;
  unwatch: (() => void) | undefined;
  readonly offs: (() => void)[];
}

function parseActionArgs(call: CallFrame): {
  reason?: string | undefined;
  input?: ComputerUserInput | undefined;
  files?: string[] | undefined;
  realmId?: string | undefined;
} {
  const args = new Args(call);
  const raw = (call.args ?? {}) as Record<string, unknown>;
  const reason = args.optionalString("reason");
  const realmId = args.optionalString("realmId");
  const files = args.optionalStrings("files");
  const input =
    raw.input !== undefined &&
    typeof raw.input === "object" &&
    raw.input !== null &&
    !Array.isArray(raw.input)
      ? (raw.input as ComputerUserInput)
      : undefined;
  return { reason, input, files, realmId };
}

export function computerPlugin(deps: ComputerPluginDeps, applied: () => void) {
  const { service } = deps;
  const maxFrameBytes = deps.maxFrameBytes ?? LINK_LIMITS.maxFrameBytes;

  return productPlugin(
    "computer",
    (ctx) => {
      const { wire } = ctx;
      const attached = new Map<string, AttachedLocalRealm>();
      const offs: (() => void)[] = [];

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
                if (!isWithinFrameBudget(target, event.frame, maxFrameBytes)) {
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

      const attachLocalRealm = (realm: ManagedRealm): void => {
        if (attached.has(realm.id)) return;
        const target = `computer.${realm.id}`;
        const realmOffs: (() => void)[] = [];
        const entry: AttachedLocalRealm = {
          realm,
          unwatch: undefined,
          offs: realmOffs,
        };
        attached.set(realm.id, entry);

        realmOffs.push(
          publish(wire, target, {
            info: () => realm.view(),
          }),
          realm.onState(() => {
            wire.pushNow(target);
            wire.pushNow("computer");
          }),
        );

        for (const action of COMPUTER_ACTIONS) {
          realmOffs.push(
            wire.handle(target, action, async (call) => {
              const parsed = parseActionArgs(call);
              if (action === "input" && parsed.input === undefined) {
                throw new Error(`${target}.input needs input`);
              }
              if (action === "resolvePicker" && parsed.files === undefined) {
                throw new Error(`${target}.resolvePicker needs files`);
              }
              const result = await service.dispatchAction(realm.id, action, {
                reason: parsed.reason,
                input: parsed.input,
                files: parsed.files,
              });
              return { result };
            }),
          );
        }

        syncWatchState(realm.id);
        if (wire.registry.hasState("computer")) {
          wire.pushNow("computer");
        }
      };

      for (const realm of service.manager.list()) {
        attachLocalRealm(realm);
      }

      offs.push(
        service.onRealmAdded((realm) => {
          attachLocalRealm(realm);
        }),
        service.onChange(() => {
          if (wire.registry.hasState("computer")) {
            wire.pushNow("computer");
          }
        }),
      );

      // Also intercept direct `service.manager.register` calls so realms registered directly on
      // the underlying RealmManager are automatically attached to the wire.
      const manager = service.manager;
      const originalRegister = manager.register.bind(manager);
      const patchedRegister: typeof manager.register = (
        driver: RealmDriver,
        metadata,
      ) => {
        const realm = originalRegister(driver, metadata);
        attachLocalRealm(realm);
        return realm;
      };
      manager.register = patchedRegister;
      offs.push(() => {
        if (manager.register === patchedRegister) {
          manager.register = originalRegister;
        }
      });

      // Hook wire subscription transitions for warm-on-subscribe on local realms.
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
          const existing = service.manager.get(realmId);
          if (existing !== undefined && !attached.has(realmId)) {
            attachLocalRealm(existing);
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

      offs.push(() => {
        if (mutableWire.subscribe !== originalSubscribe)
          mutableWire.subscribe = originalSubscribe;
        if (mutableWire.unsubscribe !== originalUnsubscribe)
          mutableWire.unsubscribe = originalUnsubscribe;
        if (mutableWire.dropSocket !== originalDropSocket)
          mutableWire.dropSocket = originalDropSocket;
      });

      offs.push(
        publish(
          wire,
          "computer",
          {
            realms: () => {
              for (const realm of service.manager.list()) {
                if (!attached.has(realm.id)) attachLocalRealm(realm);
              }
              return service.realms();
            },
            capabilities: () => service.capabilities(),
            groundingModel: () => service.groundingModel(),
          },
          { eager: true },
        ),

        wire.handle("computer", "setGroundingModel", (call) => {
          const args = new Args(call);
          const model =
            args.nullableString("model") ??
            args.nullableString("modelId") ??
            args.nullableString("groundingModel") ??
            null;
          const groundingModel = service.setGroundingModel(model);
          wire.pushNow("computer");
          return { result: { groundingModel } };
        }),
      );

      for (const action of COMPUTER_ACTIONS) {
        offs.push(
          wire.handle("computer", action, async (call) => {
            const args = new Args(call);
            const realmId = args.string("realmId");
            const parsed = parseActionArgs(call);
            if (action === "input" && parsed.input === undefined) {
              throw new Error(`computer.${action} needs input`);
            }
            if (action === "resolvePicker" && parsed.files === undefined) {
              throw new Error(`computer.${action} needs files`);
            }
            const local = service.manager.get(realmId);
            if (local !== undefined && !attached.has(local.id)) {
              attachLocalRealm(local);
            }
            const result = await service.dispatchAction(
              realmId,
              action as ComputerAction,
              {
                reason: parsed.reason,
                input: parsed.input,
                files: parsed.files,
              },
            );
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
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );
}
