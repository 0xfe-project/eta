/**
 * The `plugins` plugin: the settings page's view of plugins, and the calls that change them.
 *
 * A secret goes in through `configure` and is never read back: no section and no answer here has
 * a secret's value, only whether one is set.
 */
import type { PluginAuditView, PluginValue } from "@eta/client-contracts";
import type { AgentStore } from "../agents/store";
import type { McpService } from "../mcp/service";
import type { Market } from "./market";
import type { Plugins } from "./service";
import { Args, productPlugin, publish } from "../wire";
import { Logos, readOwnLogo } from "./logo";
import { testConnection } from "./test-server";

const LEVELS = ["none", "read", "file", "value"] as const;
const AUDIT_SHOWN = 200;

export function pluginsPlugin(
  deps: { plugins: Plugins; agents: AgentStore; market: Market; mcp?: McpService },
  applied: () => void,
) {
  const { plugins, agents, market, mcp } = deps;
  /** Servers a test or a connection found to ask for a sign-in, by URL. */
  const asked = new Set<string>();
  const remoteUrl = (name: string, server: string): string => {
    const plan = plugins.testPlan(name, server);
    if ("result" in plan) throw new Error(plan.result.message);
    const url = (plan.entry as { url?: string }).url;
    if (url === undefined) throw new Error(`${server} has no URL to sign in to`);
    return url;
  };
  const logos = new Logos();
  return productPlugin(
    "plugins",
    ({ wire }) => {
      const offs = [
        publish(wire, "plugins", {
          list: () =>
            plugins.view().map((view) => ({
              ...view,
              servers: view.servers.map((server) =>
                mcp === undefined || server.url === undefined
                  ? server
                  : {
                      ...server,
                      // One source: a 401 seen after the token was stored (a test said so) beats the
                      // token's mere presence; a login that starts clears that evidence.
                      login: asked.has(server.url)
                        ? ("needs_login" as const)
                        : mcp.signedIn(server.url)
                          ? ("signed_in" as const)
                          : ("none" as const),
                    },
              ),
            })),
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
          // Sign-ins are kept per URL: read them before the plugin goes, drop only those no other server uses.
          const urlsOf = (view: { servers: { url?: string }[] }) =>
            view.servers.flatMap((server) => (server.url === undefined ? [] : [server.url]));
          const all = plugins.view();
          const mine = urlsOf(all.find((view) => view.name === name) ?? { servers: [] });
          const others = new Set(
            all.filter((view) => view.name !== name).flatMap(urlsOf),
          );
          await plugins.registry.remove(name);
          if (mcp !== undefined) await mcp.releaseUrls(mine, name, new Set([...others].map((url) => mcp.keyOf(url))));
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
          const result = await testConnection(
            {
              ...plan.entry,
              name: server,
              source: "plugin-test",
              hash: "plugin-test",
            },
            plan.secrets,
            undefined,
            (plan.entry as { url?: string }).url === undefined
              ? undefined
              : mcp?.storedAuthProvider((plan.entry as { url: string }).url),
          );
          const url = (plan.entry as { url?: string }).url;
          if (url !== undefined) {
            if (result.status === "needs_login") asked.add(url);
            else if (result.status === "ok") asked.delete(url);
            wire.pushNow?.("plugins");
          }
          return { result };
        }),
        wire.handle("plugins", "loginServer", async (call) => {
          const args = new Args(call);
          if (mcp === undefined) throw new Error("sign-in is not available");
          // The plugin must be on, usable and have the server: testPlan refuses otherwise.
          const url = remoteUrl(args.string("name"), args.string("server"));
          asked.delete(url);
          return { result: await mcp.loginUrl(url, undefined, args.optionalString("redirectOrigin")) };
        }),
        wire.handle("plugins", "logoutServer", async (call) => {
          const args = new Args(call);
          if (mcp === undefined) throw new Error("sign-in is not available");
          const url = remoteUrl(args.string("name"), args.string("server"));
          await mcp.logoutUrl(url);
          asked.delete(url);
          return { result: { name: args.string("name"), server: args.string("server") } };
        }),
        wire.handle("plugins", "logo", async (call) => {
          const args = new Args(call);
          // An installed plugin: its own file first, then its homepage's icon.
          const installed = args.optionalString("plugin");
          if (installed !== undefined) {
            const found = plugins.registry.entries().find((entry) => entry.name === installed)?.plugin;
            const own =
              found?.manifest.logo === undefined ? null : await readOwnLogo(found.root, found.manifest.logo);
            if (own) return { result: own };
            // The first remote MCP server's site is the last source before the letter.
            const remote = plugins.view().find((view) => view.name === installed)?.servers.find(
              (server) => server.url !== undefined,
            )?.url;
            return { result: await logos.find(null, found?.manifest.homepage ?? null, remote ?? null) };
          }
          return {
            result: await logos.find(
              args.optionalString("own") ?? null,
              args.optionalString("homepage") ?? null,
              args.optionalString("origin") ?? null,
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
