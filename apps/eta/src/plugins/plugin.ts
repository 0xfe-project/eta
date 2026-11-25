/**
 * The `plugins` plugin: the settings page's view of plugins, and the calls that change them.
 *
 * A secret goes in through `configure` and is never read back: no section and no answer here has
 * a secret's value, only whether one is set.
 */
import type {
  ComposioPluginView,
  PluginAuditView,
  PluginToolkitView,
  PluginValue,
} from "@eta/client-contracts";
import type { AgentStore } from "../agents/store";
import type { McpService } from "../mcp/service";
import type { SettingStore } from "../settings/store";
import type { Composio } from "./composio";
import type { IconCache } from "./icon-cache";
import type { Market } from "./market";
import type { Plugins } from "./service";
import { Args, productPlugin, publish } from "../wire";

import {
  CURSOR_AUTH_HEADER,
  CursorLogin,
  isCursorServer,
} from "./cursor-login";
import { Logos, readOwnLogo } from "./logo";
import { testConnection } from "./test-server";

const LEVELS = ["none", "read", "file", "value"] as const;
const AUDIT_SHOWN = 200;

/**
 * What a check found out about one server's sign-in, kept in the settings so a restart still knows it:
 * the conclusion, the address it was found for, and when. Never a token, a header or an answer.
 */
interface KeptLogin {
  status: "needs_login";
  url: string;
  at: number;
}
const keptKey = (plugin: string) => `plugins.login.${plugin}`;

export function pluginsPlugin(
  deps: {
    plugins: Plugins;
    agents: AgentStore;
    market: Market;
    composio?: Composio;
    mcp?: McpService;
    icons?: IconCache;
    /** Where a server's needs-login finding is kept between runs; nothing is kept without it. */
    settings?: SettingStore;
    /** Tests only: the Cursor sign-in with its fake network. */
    cursorLogin?: CursorLogin;
  },
  applied: () => void,
) {
  const { plugins, agents, market, composio, mcp } = deps;
  const needComposio = (): Composio => {
    if (composio === undefined) throw new Error("Composio is not available");
    return composio;
  };
  /**
   * The connected toolkits as plugins of the agents, with the user's switch. Nothing without
   * Composio or while its source is off. What the `toolkits` section and `composioPlugins` both say.
   */
  const composioPlugins = (
    source: Composio | undefined,
  ): ComposioPluginView[] => {
    const off = plugins.rows.disabled();
    return (source?.virtuals() ?? []).map((one) => ({
      ...one,
      enabled: !off.has(one.name),
    }));
  };
  /**
   * Servers a test found to refuse their stored sign-in, by URL, with the stamp of the sign-in it
   * refused: a login made later (from any entry) has another stamp, so it is not shown as expired.
   */
  const asked = new Map<string, string>();
  /** A plugin's kept findings by server name; what is stored is read as untrusted and checked on use. */
  const keptOf = (plugin: string): Record<string, KeptLogin | undefined> =>
    (deps.settings?.get(keptKey(plugin)) ?? {}) as Record<
      string,
      KeptLogin | undefined
    >;
  /** Whether a finding is kept for this server at its present address. */
  const kept = (plugin: string, server: string, url: string): boolean => {
    const one = keptOf(plugin)[server];
    return one?.status === "needs_login" && one.url === url;
  };
  /** Keep a server's finding, or (null) drop it; a plugin with none left has no row. */
  const keep = (plugin: string, server: string, one: KeptLogin | null) => {
    const all = { ...keptOf(plugin) };
    if (one === null) delete all[server];
    else all[server] = one;
    if (Object.keys(all).length === 0) deps.settings?.delete(keptKey(plugin));
    else deps.settings?.set(keptKey(plugin), all);
  };
  const remoteOf = (
    name: string,
    server: string,
  ): { url: string; headers: Record<string, string> | undefined } => {
    const plan = plugins.testPlan(name, server);
    if ("result" in plan) throw new Error(plan.result.message);
    const { url, headers } = plan.entry as {
      url?: string;
      headers?: Record<string, string>;
    };
    if (url === undefined)
      throw new Error(`${server} has no URL to sign in to`);
    return { url, headers };
  };
  /**
   * One connection test of a plugin server, and what it says about sign-in kept in `asked`. A manual
   * test and the check after an install both go through here. `wire` is only for the push.
   */
  const probe = async (
    wire: { pushNow?: (target: string) => void },
    name: string,
    server: string,
  ) => {
    const plan = plugins.testPlan(name, server);
    if ("result" in plan) return plan.result;
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
      if (result.status === "needs_login") {
        asked.set(url, mcp?.signInStamp(url) ?? "");
        // A refused stored sign-in is "expired", which a stored sign-in already shows: keep only the
        // finding that there is none.
        if (mcp?.signedIn(url) !== true)
          keep(name, server, { status: "needs_login", url, at: Date.now() });
      } else if (result.status === "ok") {
        asked.delete(url);
        keep(name, server, null);
      }
      wire.pushNow?.("plugins");
    }
    return result;
  };
  /**
   * After a plugin is added, ask each of its remote servers once whether it wants a sign-in, so the
   * card says so without a test being pressed. Never a stdio server (that would run the plugin's
   * command before the user chose to), and never waited for: the install has already succeeded.
   * A plugin that is off or needs setup is skipped by `testPlan`, silently.
   */
  const checkLogins = (
    wire: { pushNow?: (target: string) => void },
    name: string,
  ) => {
    // A new install starts without what an earlier one found, checked or not.
    deps.settings?.delete(keptKey(name));
    const view = plugins.view().find((one) => one.name === name);
    for (const server of view?.servers ?? [])
      if (server.url !== undefined)
        probe(wire, name, server.name).catch((error: unknown) =>
          console.warn(
            `plugins: login check of ${name}/${server.name} failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
  };
  const cursorLogin = deps.cursorLogin ?? new CursorLogin();
  const logos = new Logos(
    deps.icons === undefined ? {} : { store: deps.icons },
  );
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
                      login:
                        asked.has(server.url) &&
                        asked.get(server.url) ===
                          (mcp.signInStamp(server.url) ?? "")
                          ? mcp.signedIn(server.url)
                            ? ("expired" as const)
                            : ("needs_login" as const)
                          : mcp.signedIn(server.url)
                            ? ("signed_in" as const)
                            : kept(view.name, server.name, server.url)
                              ? ("needs_login" as const)
                              : ("none" as const),
                    },
              ),
            })),
          // A toolkit's session is made after the start, so this section moving is what tells a
          // client that has the page open: it is sent when its content changes, like any section.
          // Each entry names its provider; Composio is the only one there is.
          toolkits: (): PluginToolkitView[] =>
            composioPlugins(composio).map((one) => ({
              ...one,
              provider: "composio",
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
          if (enabled === undefined)
            throw new Error("plugins.setEnabled needs enabled");
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
        wire.handle("plugins", "setTokenHeader", (call) => {
          const args = new Args(call);
          const name = args.string("name");
          const server = args.string("server");
          const { header } = (call.args ?? {}) as { header?: unknown };
          if (
            header !== null &&
            (typeof header !== "object" || header === undefined)
          )
            throw new Error("plugins.setTokenHeader needs header (or null)");
          const one = header as { name?: unknown; format?: unknown } | null;
          if (
            one !== null &&
            (typeof one.name !== "string" ||
              (one.format !== "raw" && one.format !== "bearer"))
          )
            throw new Error(
              "a token header needs a name and a format (raw or bearer)",
            );
          plugins.setTokenHeader(
            name,
            server,
            one === null
              ? null
              : {
                  name: one.name as string,
                  format: one.format as "raw" | "bearer",
                },
          );
          return { result: { name, server } };
        }),
        wire.handle("plugins", "setEnv", (call) => {
          const args = new Args(call);
          const name = args.string("name");
          const server = args.string("server");
          const { env } = (call.args ?? {}) as { env?: unknown };
          if (!Array.isArray(env)) throw new Error("plugins.setEnv needs env");
          plugins.setEnv(
            name,
            server,
            env.map((raw) => {
              const one = (raw ?? {}) as Record<string, unknown>;
              if (typeof one.name !== "string")
                throw new Error("a variable needs a name");
              if (one.value !== null && typeof one.value !== "string")
                throw new Error("a variable value is text, or null to keep it");
              return {
                name: one.name,
                value: one.value as string | null,
                secret: one.secret === true,
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
          checkLogins(wire, name);
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
            view.servers.flatMap((server) =>
              server.url === undefined ? [] : [server.url],
            );
          const all = plugins.view();
          const mine = urlsOf(
            all.find((view) => view.name === name) ?? { servers: [] },
          );
          const others = new Set(
            all.filter((view) => view.name !== name).flatMap(urlsOf),
          );
          await plugins.registry.remove(name);
          deps.settings?.delete(keptKey(name));
          if (mcp !== undefined)
            await mcp.releaseUrls(
              mine,
              name,
              new Set([...others].map((url) => mcp.keyOf(url))),
            );
          return { result: { name } };
        }),
        // Reads only what the host keeps; it must not wait behind a slow call of the connection.
        wire.handle(
          "plugins",
          "marketSettings",
          async () => ({ result: market.settings() }),
          { unordered: true },
        ),
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
        wire.handle(
          "plugins",
          "marketCatalog",
          async (call) => ({
            // "cached": only what is kept, at once; otherwise read again (asking the server first).
            result: await market.catalog(
              new Args(call).optionalString("mode") === "cached"
                ? "cached"
                : "refresh",
              new Args(call).optionalString("source"),
            ),
          }),
          { unordered: true },
        ),
        wire.handle("plugins", "marketClearCache", async () => ({
          result: { cleared: market.clearCache(), icons: logos.clear() },
        })),
        wire.handle(
          "plugins",
          "marketPreview",
          async (call) => {
            const args = new Args(call);
            return {
              result: await market.preview(
                args.string("name"),
                args.string("source"),
              ),
            };
          },
          { unordered: true },
        ),
        wire.handle("plugins", "marketInstall", async (call) => {
          const args = new Args(call);
          const name = await market.install(
            args.string("name"),
            args.string("source"),
            args.string("sha"),
          );
          checkLogins(wire, name);
          return { result: { name } };
        }),
        // The key goes in and is never read back: only whether one is set.
        wire.handle("plugins", "composioSetKey", async (call) => {
          needComposio().setKey(new Args(call).string("key"));
          // The sessions of the old key are gone: make them again, for what is connected.
          void needComposio()
            .follow()
            .catch(() => undefined);
          return { result: { hasKey: true } };
        }),
        wire.handle("plugins", "composioClearKey", async () => {
          needComposio().clearKey();
          return { result: { hasKey: false } };
        }),
        // Reads only what the host keeps; it must not wait behind a slow call of the connection.
        wire.handle(
          "plugins",
          "composioStatus",
          async () => ({
            result: {
              hasKey: needComposio().hasKey(),
              enabled: needComposio().source().enabled,
            },
          }),
          { unordered: true },
        ),
        wire.handle("plugins", "composioConnected", async () => ({
          result: await needComposio().follow(),
        })),
        wire.handle("plugins", "composioDisconnect", async (call) => ({
          result: await needComposio().disconnect(
            new Args(call).string("slug"),
          ),
        })),
        wire.handle("plugins", "composioAdd", async (call) => ({
          result: await needComposio().add(new Args(call).string("slug")),
        })),
        wire.handle("plugins", "composioRemove", async (call) => ({
          result: needComposio().remove(new Args(call).string("slug")),
        })),
        wire.handle("plugins", "composioAdded", async () => ({
          result: { slugs: needComposio().added() },
        })),
        wire.handle("plugins", "composioPlugins", async () => ({
          result: { plugins: composioPlugins(needComposio()) },
        })),
        wire.handle("plugins", "composioToolkits", (call) => {
          const { slugs } = (call.args ?? {}) as { slugs?: unknown };
          if (!Array.isArray(slugs))
            throw new Error("plugins.composioToolkits needs slugs");
          return {
            result: {
              toolkits: needComposio().toolkitsOf(
                slugs
                  .filter((one): one is string => typeof one === "string")
                  .slice(0, 500),
              ),
            },
          };
        }),
        wire.handle("plugins", "composioLink", async (call) => ({
          result: {
            redirectUrl: await needComposio().link(
              new Args(call).string("slug"),
            ),
          },
        })),
        wire.handle("plugins", "testServer", async (call) => {
          const args = new Args(call);
          return {
            result: await probe(
              wire,
              args.string("name"),
              args.string("server"),
            ),
          };
        }),
        wire.handle("plugins", "loginServer", async (call) => {
          const args = new Args(call);
          if (mcp === undefined) throw new Error("sign-in is not available");
          // The plugin must be on, usable and have the server: testPlan refuses otherwise.
          const name = args.string("name");
          const server = args.string("server");
          const { url, headers } = remoteOf(name, server);
          asked.delete(url);
          const result = await mcp.loginUrl(
            url,
            headers,
            args.optionalString("redirectOrigin"),
          );
          keep(name, server, null);
          return { result };
        }),
        wire.handle("plugins", "cursorLoginStart", (call) => {
          const args = new Args(call);
          const name = args.string("name");
          const server = args.string("server");
          const header = args.optionalString("header") ?? CURSOR_AUTH_HEADER;
          // A Cursor credential goes only to Cursor's own servers.
          if (!isCursorServer(remoteOf(name, server).url))
            throw new Error(`${server} is not a Cursor server`);
          const started = cursorLogin.start((token) => {
            // The server answers a bare token as missing; it wants Bearer here (seen on a real sign-in).
            const value = `Bearer ${token}`;
            // The Cursor credential is the host's: one sign-in serves every Cursor server.
            if (header.toLowerCase() === CURSOR_AUTH_HEADER)
              plugins.setCursorCredential(value);
            else plugins.setSecretHeader(name, server, header, value);
          });
          return {
            result: {
              id: started.id,
              url: started.url,
              timeoutSeconds: 120,
            },
          };
        }),
        wire.handle("plugins", "cursorLoginStatus", (call) => {
          const args = new Args(call);
          return { result: cursorLogin.status(args.string("id")) };
        }),
        wire.handle("plugins", "cursorLoginCancel", (call) => {
          const args = new Args(call);
          cursorLogin.cancel(args.string("id"));
          return { result: { id: args.string("id") } };
        }),
        wire.handle("plugins", "logoutServer", async (call) => {
          const args = new Args(call);
          if (mcp === undefined) throw new Error("sign-in is not available");
          const { url } = remoteOf(args.string("name"), args.string("server"));
          await mcp.logoutUrl(url);
          asked.delete(url);
          keep(args.string("name"), args.string("server"), null);
          return {
            result: {
              name: args.string("name"),
              server: args.string("server"),
            },
          };
        }),
        wire.handle(
          "plugins",
          "logo",
          async (call) => {
            const args = new Args(call);
            // An installed plugin: its own file first, then its homepage's icon.
            const installed = args.optionalString("plugin");
            if (installed !== undefined) {
              const found = plugins.registry
                .entries()
                .find((entry) => entry.name === installed)?.plugin;
              const own =
                found?.manifest.logo === undefined
                  ? null
                  : await readOwnLogo(found.root, found.manifest.logo);
              if (own) return { result: own };
              // The first remote MCP server's site is the last source before the letter.
              const remote = plugins
                .view()
                .find((view) => view.name === installed)
                ?.servers.find((server) => server.url !== undefined)?.url;
              return {
                result: await logos.find(
                  null,
                  found?.manifest.homepage ?? null,
                  remote ?? null,
                ),
              };
            }
            // A Composio toolkit: the address comes from the host's own list, over https only.
            const toolkit = args.optionalString("composio");
            if (toolkit !== undefined) {
              const address = composio?.logoOf(toolkit) ?? null;
              return {
                result: address === null ? null : await logos.fromUrl(address),
              };
            }
            // A market entry that is a path in a GitHub repository: the plugin's own logo from its manifest.
            const repo = args.optionalString("repo");
            if (repo !== undefined) {
              const found = await logos.forEntry(
                repo,
                args.optionalString("ref") ?? "HEAD",
                args.optionalString("path") ?? "",
                args.nullableString("homepage") ?? null,
              );
              return { result: found };
            }
            return {
              result: await logos.find(
                args.optionalString("own") ?? null,
                args.nullableString("homepage") ?? null,
                args.optionalString("origin") ?? null,
              ),
            };
          },
          { unordered: true },
        ),
        wire.handle(
          "plugins",
          "logosCached",
          (call) => {
            const { entries } = (call.args ?? {}) as { entries?: unknown };
            if (!Array.isArray(entries))
              throw new Error("plugins.logosCached needs entries");
            const text = (value: unknown): string =>
              typeof value === "string" ? value : "";
            const asked = entries.map((raw) => {
              const one = (raw ?? {}) as Record<string, unknown>;
              // A Composio toolkit: the address comes from the host's own list, as for `logo`.
              if (typeof one.composio === "string")
                return { url: composio?.logoOf(one.composio) ?? "" };
              return {
                repo: text(one.repo),
                ref: text(one.ref) || "HEAD",
                path: text(one.path),
                homepage: text(one.homepage) || null,
              };
            });
            return {
              result: {
                logos: logos.cached(asked).map((one) =>
                  one.status === "hit"
                    ? {
                        status: "hit",
                        type: one.logo.type,
                        data: one.logo.data,
                      }
                    : { status: one.status },
                ),
              },
            };
          },
          { unordered: true },
        ),
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
