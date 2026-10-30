/**
 * The `llm` plugin: the gateway's accounts, models and quota on the wire.
 *
 * CLIProxyAPI holds the credentials, and its routing state is the truth; the gateway derives every
 * status from it and this plugin keeps a copy of what it said and publishes it. Reading accounts
 * and models costs a few loopback requests to CPA, so they are re-read every few seconds and
 * pushed when they changed. Quota is different: it asks each provider, with the account's
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
import type { CatalogModel, Gateway } from "./gateway";
import type { GatewayModels } from "./models";
import { Args, productPlugin, publish } from "../wire";
import { LlmError } from "./problems";

export interface LlmPluginDeps {
  gateway: Gateway;
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
  const { gateway, models, warn } = deps;
  /** A failure the gateway did not explain is still one the client can name. */
  const explained = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof LlmError) throw error;
      warn(`[eta] llm: ${String(error)}`);
      throw new LlmError(
        "gateway_unavailable",
        "The gateway failed.",
        undefined,
        error,
      );
    }
  };
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
            const { connections: nextConnections, models: nextCatalog } =
              await gateway.status();
            if (!ready) {
              connectors = gateway.connectors();
              ready = true;
            }
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
          quota = await gateway.usage();
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
          const checked = await explained(() => gateway.refresh());
          connections = checked.connections;
          catalog = checked.models;
          quota = checked.quota;
          await models.update(catalog);
          wire.pushNow("llm");
          return { result: {} };
        }),
        wire.handle("llm", "loginStart", async (call) => {
          const args = new Args(call);
          const connector = args.string("connector");
          const login = await explained(() => gateway.loginStart(connector));
          return { result: { login } };
        }),
        wire.handle("llm", "loginPoll", async (call) => {
          const id = new Args(call).string("id");
          const login = await explained(() => gateway.loginPoll(id));
          // The credential is in as soon as the login succeeds; the catalog follows within
          // moments, so read it now rather than on the next tick.
          if (login.status === "succeeded") void after();
          return { result: { login } };
        }),
        wire.handle("llm", "loginSubmit", async (call) => {
          const args = new Args(call);
          const [id, apiKey] = [args.string("id"), args.string("apiKey")];
          const login = await explained(() => gateway.loginSubmit(id, apiKey));
          if (login.status === "succeeded") void after();
          return { result: { login } };
        }),
        wire.handle("llm", "loginCancel", async (call) => {
          const id = new Args(call).string("id");
          await explained(() => gateway.loginCancel(id));
          return { result: {} };
        }),
        wire.handle("llm", "setEnabled", async (call) => {
          const args = new Args(call);
          const enabled = args.optionalBoolean("enabled");
          if (enabled === undefined)
            throw new Error("llm.setEnabled needs enabled");
          const id = args.string("id");
          await explained(() => gateway.setEnabled(id, enabled));
          await sync();
          return { result: {} };
        }),
        wire.handle("llm", "remove", async (call) => {
          const id = new Args(call).string("id");
          await explained(() => gateway.remove(id));
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
