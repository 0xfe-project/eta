/**
 * The `plugins` plugin: the settings page's view of plugins, and the calls that change them.
 *
 * A secret goes in through `configure` and is never read back: no section and no answer here has
 * a secret's value, only whether one is set.
 */
import type { PluginAuditView, PluginValue } from "@eta/client-contracts";
import type { AgentStore } from "../agents/store";
import type { Market } from "./market";
import type { Plugins } from "./service";
import { Args, productPlugin, publish } from "../wire";
import { Logos } from "./logo";
import { testConnection } from "./test-server";

const LEVELS = ["none", "read", "file", "value"] as const;
const AUDIT_SHOWN = 200;

export function pluginsPlugin(
  deps: { plugins: Plugins; agents: AgentStore; market: Market },
  applied: () => void,
) {
  const { plugins, agents, market } = deps;
  const logos = new Logos();
  return productPlugin(
    "plugins",
    ({ wire }) => {
      const offs = [
        publish(wire, "plugins", {
          list: () => plugins.view(),
          audit: (): PluginAuditView[] =>
            plugins.rows.audits(AUDIT_SHOWN).map((row) => ({
              ...row,
              agentName:
                row.agentId === null
                  ? null
                  : (agents.get(row.agentId)?.name ?? null),
            })),
        }),
        wire.handle("plugins", "configure", (call) => {
          const name = new Args(call).string("name");
          const { values } = (call.args ?? {}) as { values?: unknown };
          if (
            typeof values !== "object" ||
            values === null ||
            Array.isArray(values)
          )
            throw new Error("plugins.configure needs values");
          return {
            result: {
              name,
              ...plugins.configure(
                name,
                values as Record<string, PluginValue | null>,
              ),
            },
          };
        }),
        wire.handle("plugins", "setLevel", (call) => {
          const args = new Args(call);
          const name = args.string("name");
          const level = args.string("level");
          if (!LEVELS.includes(level as never))
            throw new Error(`unknown level: ${level}`);
          plugins.setLevel(
            name,
            args.string("field"),
            level as (typeof LEVELS)[number],
          );
          return { result: { name } };
        }),
        wire.handle("plugins", "setEnabled", (call) => {
          const args = new Args(call);
          const name = args.string("name");
          const enabled = args.optionalBoolean("enabled");
          if (enabled === undefined) throw new Error("plugins.setEnabled needs enabled");
          plugins.setEnabled(name, enabled);
          return { result: { name, enabled } };
        }),
        wire.handle("plugins", "setHeaders", (call) => {
          const args = new Args(call);
          const name = args.string("name");
          const server = args.string("server");
          const { headers } = (call.args ?? {}) as { headers?: unknown };
          if (!Array.isArray(headers))
            throw new Error("plugins.setHeaders needs headers");
          plugins.setHeaders(
            name,
            server,
            headers.map((raw) => {
              const header = (raw ?? {}) as Record<string, unknown>;
              if (typeof header.name !== "string")
                throw new Error("a header needs a name");
              if (header.value !== null && typeof header.value !== "string")
                throw new Error("a header value is text, or null to keep it");
              return {
                name: header.name,
                value: header.value as string | null,
                secret: header.secret === true,
                plainOk: header.plainOk === true,
              };
            }),
          );
          return { result: { name, server } };
        }),
        wire.handle("plugins", "add", async (call) => {
          const args = new Args(call);
          const name = await plugins.registry.add(
            args.string("repo"),
            args.optionalString("rev") ?? "",
            args.optionalString("path") ?? "",
          );
          return { result: { name } };
        }),
        wire.handle("plugins", "update", async (call) => {
          const names = await plugins.update(
            new Args(call).optionalString("name"),
          );
          return { result: { names } };
        }),
        wire.handle("plugins", "remove", async (call) => {
          const name = new Args(call).string("name");
          await plugins.registry.remove(name);
          return { result: { name } };
        }),
        wire.handle("plugins", "marketSettings", async () => ({
          result: market.settings(),
        })),
        wire.handle("plugins", "marketAddSource", async (call) => {
          const args = new Args(call);
          return {
            result: market.addSource(
              args.string("url"),
              args.optionalString("name") ?? "",
            ),
          };
        }),
        wire.handle("plugins", "marketRemoveSource", async (call) => ({
          result: market.removeSource(new Args(call).string("url")),
        })),
        wire.handle("plugins", "marketSetSourceEnabled", async (call) => {
          const args = new Args(call);
          return {
            result: market.setSourceEnabled(
              args.string("url"),
              args.optionalBoolean("enabled") ?? true,
            ),
          };
        }),
        wire.handle("plugins", "marketSetProxy", async (call) => ({
          result: market.setProxy(new Args(call).optionalString("proxy") ?? ""),
        })),
        wire.handle("plugins", "marketCatalog", async () => ({
          result: await market.catalog(),
        })),
        wire.handle("plugins", "marketPreview", async (call) => {
          const args = new Args(call);
          return {
            result: await market.preview(args.string("name"), args.string("source")),
          };
        }),
        wire.handle("plugins", "marketInstall", async (call) => {
          const args = new Args(call);
          const name = await market.install(
            args.string("name"),
            args.string("source"),
            args.string("sha"),
          );
          return { result: { name } };
        }),
        wire.handle("plugins", "testServer", async (call) => {
          const args = new Args(call);
          const name = args.string("name");
          const server = args.string("server");
          const plan = plugins.testPlan(name, server);
          if ("result" in plan) return { result: plan.result };
          return {
            result: await testConnection(
              {
                ...plan.entry,
                name: server,
                source: "plugin-test",
                hash: "plugin-test",
              },
              plan.secrets,
            ),
          };
        }),
        wire.handle("plugins", "logo", async (call) => {
          const args = new Args(call);
          return {
            result: await logos.find(
              args.optionalString("own") ?? null,
              args.optionalString("homepage") ?? null,
            ),
          };
        }),
        wire.handle("plugins", "recheck", async () => {
          await plugins.registry.refresh();
          await plugins.recheck();
          return { result: {} };
        }),
      ];
      return () => {
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );
}
