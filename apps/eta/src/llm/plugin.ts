/**
 * The `llm` plugin: the gateway's accounts, models and quota on the wire.
 *
 * The gateway holds the credentials and derives every status itself (CLIProxyAPI's routing state
 * is the truth); this plugin keeps a copy of what it said and publishes it. Reading accounts and
 * models costs nothing (it is memory in the same process), so they are re-read every few seconds
 * and pushed when they changed. Quota is different: it asks each provider, with the account's
 * token, what the subscription has left. That costs no quota, but it is a request, so it is read
 * once at start, after a login, on `refresh`, and every ten minutes.
 *
 * The catalog also feeds the model layer (`GatewayModels`), so an account connected here is
 * usable by the next generation without a restart.
 */
import type {
  LlmConnection,
  LlmConnector,
  LlmModel,
  LlmQuota,
} from "@eta/client-contracts";
import type { CatalogModel, GatewayClient } from "./client";
import type { GatewayModels } from "./models";
import { Args, productPlugin, publish } from "../wire";

export interface LlmPluginDeps {
  client: GatewayClient;
  models: GatewayModels;
  warn: (message: string) => void;
  /** How often accounts and models are re-read. */
  pollMs?: number | undefined;
  /** How often quota is re-read. */
  quotaMs?: number | undefined;
}

/** What a client sees of a catalog entry: no model-layer facts. */
function view(model: CatalogModel): LlmModel {
  const { reasoningLevels: _levels, image: _image, ...rest } = model;
  return rest;
}

export function llmPlugin(deps: LlmPluginDeps, applied: () => void) {
  const { client, models, warn } = deps;
  return productPlugin(
    "llm",
    ({ wire }) => {
      let ready = false;
      let connectors: LlmConnector[] = [];
      let connections: LlmConnection[] = [];
      let catalog: CatalogModel[] = [];
      let quota: LlmQuota[] = [];
      let closed = false;

      const stop = publish(
        wire,
        "llm",
        {
          accounts: () => ({ ready, connectors, connections }),
          models: () => catalog.map(view),
          quota: () => quota,
        },
        { eager: true },
      );

      /** Re-read accounts and models; tell the pipe and the model layer if they moved. */
      let syncing: Promise<void> | undefined;
      const sync = (): Promise<void> => {
        syncing ??= (async () => {
          try {
            if (!ready) {
              if (!(await client.ready())) return;
              connectors = await client.connectors();
              ready = true;
            }
            const [nextConnections, nextCatalog] = await Promise.all([
              client.connections(),
              client.models(),
            ]);
            const modelsMoved =
              JSON.stringify(nextCatalog) !== JSON.stringify(catalog);
            connections = nextConnections;
            catalog = nextCatalog;
            if (modelsMoved) await models.update(catalog);
            if (!closed) wire.pushNow("llm");
          } catch (error) {
            warn(`[eta] llm: could not read the gateway: ${String(error)}`);
          } finally {
            syncing = undefined;
          }
        })();
        return syncing;
      };
      const readQuota = async (): Promise<void> => {
        try {
          quota = await client.quota();
          if (!closed) wire.pushNow("llm");
        } catch (error) {
          warn(`[eta] llm: could not read quota: ${String(error)}`);
        }
      };

      void sync().then(readQuota);
      const poll = setInterval(() => void sync(), deps.pollMs ?? 5_000);
      const slow = setInterval(() => void readQuota(), deps.quotaMs ?? 600_000);
      poll.unref();
      slow.unref();

      const after = async (): Promise<void> => {
        await sync();
        void readQuota();
      };

      const registrations = [
        wire.handle("llm", "refresh", async () => {
          const checked = await client.refresh();
          connections = checked.connections;
          catalog = checked.models;
          quota = checked.quota;
          await models.update(catalog);
          wire.pushNow("llm");
          return { result: {} };
        }),
        wire.handle("llm", "loginStart", async (call) => {
          const args = new Args(call);
          const login = await client.loginStart(args.string("connector"));
          return { result: { login } };
        }),
        wire.handle("llm", "loginPoll", async (call) => {
          const login = await client.loginPoll(new Args(call).string("id"));
          // The credential is in as soon as the login succeeds; the catalog follows within
          // moments, so read it now rather than on the next tick.
          if (login.status === "succeeded") void after();
          return { result: { login } };
        }),
        wire.handle("llm", "loginSubmit", async (call) => {
          const args = new Args(call);
          const login = await client.loginSubmit(
            args.string("id"),
            args.string("apiKey"),
          );
          if (login.status === "succeeded") void after();
          return { result: { login } };
        }),
        wire.handle("llm", "loginCancel", async (call) => {
          await client.loginCancel(new Args(call).string("id"));
          return { result: {} };
        }),
        wire.handle("llm", "setEnabled", async (call) => {
          const args = new Args(call);
          const enabled = args.optionalBoolean("enabled");
          if (enabled === undefined)
            throw new Error("llm.setEnabled needs enabled");
          await client.setEnabled(args.string("id"), enabled);
          await sync();
          return { result: {} };
        }),
        wire.handle("llm", "remove", async (call) => {
          await client.remove(new Args(call).string("id"));
          await sync();
          return { result: {} };
        }),
      ];

      return () => {
        closed = true;
        clearInterval(poll);
        clearInterval(slow);
        for (const off of registrations) off();
        stop();
      };
    },
    applied,
  );
}
