import type { SessionMeta } from "@eta/server";
/**
 * Request headers a user attaches to a plugin's remote MCP server: sent to that server only, over
 * the plugin file's own, never shown again, gone with the plugin, and not sent while it is off.
 */
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  plainRemote,
  resolvePluginServers,
  serversConfig,
  serversConfig as serversConfigOf,
  toMcpEntries,
} from "@eta/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { Plugins } from "../src/plugins/service";

const PLUGIN = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const SECRET = "s3cr3t-value-123";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "eta-headers-"));
  dirs.push(dataDir);
  const dir = join(dataDir, "plugins", "demo");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "plugin.json"),
    JSON.stringify({ $schema: PLUGIN, name: "demo" }),
  );
  await writeFile(
    join(dir, "mcp.json"),
    JSON.stringify({
      $schema: MCP,
      mcpServers: {
        remote: {
          type: "streamable-http",
          url: "https://example.com/mcp",
          headers: { "X-Api-Key": "from-file" },
        },
        local: { type: "stdio", command: "node" },
      },
    }),
  );
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  db.exec("PRAGMA foreign_keys = OFF");
  const logs: string[] = [];
  const plugins = new Plugins({
    db,
    dataDir,
    key: Buffer.alloc(32, 1),
    agents: { get: () => ({ runtime: "eta" }) } as never,
    machines: { list: () => [] } as never,
    hub: { onReady: () => {} } as never,
    changed: () => {},
    warn: (message) => logs.push(message),
  });
  await plugins.registry.refresh();
  plugins.rows.setEnabled("ada", ["demo"]);
  const meta = { agentId: "ada", runtime: "codex" } as SessionMeta;
  const servers = () =>
    plugins.mcpSourcesFor("ada")[0]?.servers as Record<
      string,
      { headers?: Record<string, string>; auth?: unknown }
    >;
  return { plugins, meta, servers, logs };
}

describe("headers the user attaches to a remote server", () => {
  it("sends one to its server, and the file's own header stays when no clash", async () => {
    const { plugins, servers } = await setup();
    plugins.setHeaders("demo", "remote", [
      { name: "Authorization", value: `Bearer ${SECRET}`, secret: true },
    ]);
    expect(servers()["demo-remote"]?.headers).toEqual({
      "X-Api-Key": "from-file",
      Authorization: `Bearer ${SECRET}`,
    });
  });

  it("wins over the file's header of the same name, whatever the case", async () => {
    const { plugins, servers } = await setup();
    plugins.setHeaders("demo", "remote", [
      { name: "x-api-key", value: "from-user", secret: true },
    ]);
    expect(servers()["demo-remote"]?.headers).toEqual({
      "x-api-key": "from-user",
    });
  });

  it("is never in the view, the redaction list leaves nothing to leak, and a saved secret can be kept", async () => {
    const { plugins, servers } = await setup();
    plugins.setHeaders("demo", "remote", [
      { name: "Authorization", value: `Bearer ${SECRET}`, secret: true },
      { name: "X-Team", value: "blue", secret: false },
    ]);
    const view = plugins.view().find((entry) => entry.name === "demo")!;
    expect(JSON.stringify(view)).not.toContain(SECRET);
    const secret = view.headers.find((h) => h.name === "Authorization")!;
    expect(secret).toMatchObject({ secret: true, value: null });
    expect(view.headers.find((h) => h.name === "X-Team")!.value).toBe("blue");
    // The names the file declares are in the server view; values never are.
    const remote = view.servers.find((s) => s.name === "remote")!;
    expect(remote.headers).toEqual(["X-Api-Key"]);
    expect(
      plugins.redactionsFor("ada").some((r) => r.value === `Bearer ${SECRET}`),
    ).toBe(true);
    // A null value keeps the saved one.
    plugins.setHeaders("demo", "remote", [
      { name: "Authorization", value: null, secret: true },
    ]);
    expect(servers()["demo-remote"]?.headers?.Authorization).toBe(
      `Bearer ${SECRET}`,
    );
    expect(() =>
      plugins.setHeaders("demo", "remote", [
        { name: "Nope", value: null, secret: true },
      ]),
    ).toThrow();
  });

  it("is not logged", async () => {
    const { plugins, logs, meta } = await setup();
    plugins.setHeaders("demo", "remote", [
      { name: "Authorization", value: `Bearer ${SECRET}`, secret: true },
    ]);
    await plugins.runtimeExtrasFor(meta);
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("refuses a name or value that is not a header, without echoing the value", async () => {
    const { plugins } = await setup();
    const bad = [
      { name: "", value: "x" },
      { name: "Bad Name", value: "x" },
      { name: "A:B", value: "x" },
      { name: "X-Ok", value: `a\r\nInjected: ${SECRET}` },
      { name: "X-Ok", value: `a\nb${SECRET}` },
      { name: "X-Ok", value: "" },
    ];
    for (const header of bad) {
      let message = "";
      try {
        plugins.setHeaders("demo", "remote", [{ ...header, secret: true }]);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(SECRET);
    }
    expect(plugins.rows.headers("demo")).toEqual([]);
    expect(() =>
      plugins.setHeaders("demo", "local", [
        { name: "X-A", value: "v", secret: true },
      ]),
    ).toThrow();
    expect(() =>
      plugins.setHeaders("demo", "remote", [
        { name: "X-A", value: "1", secret: true },
        { name: "x-a", value: "2", secret: true },
      ]),
    ).toThrow();
  });

  it("goes over plain http to another machine only once the user confirmed (the loader already refuses such a url in a file; this is the second guard)", () => {
    expect(plainRemote("http://example.com/mcp")).toBe(true);
    expect(plainRemote("http://127.0.0.1:8/mcp")).toBe(false);
    expect(plainRemote("http://localhost/mcp")).toBe(false);
    expect(plainRemote("https://example.com/mcp")).toBe(false);
    const plugin = {
      bindings: {},
      fields: [],
      servers: [
        {
          name: "plain",
          config: {
            type: "streamable-http",
            url: "http://example.com/mcp",
            headers: {},
          },
        },
      ],
    } as never;
    const header = (plainOk: boolean) => [
      { server: "plain", name: "X-Token", value: SECRET, plainOk },
    ];
    expect(serversConfig(plugin, {}, header(false)).plain).toBeUndefined();
    expect(serversConfig(plugin, {}, header(true)).plain?.headers).toEqual({
      "X-Token": SECRET,
    });
  });

  it("makes a 401 a refused credential, not a sign-in, once headers are set", async () => {
    const { plugins } = await setup();
    const entry = plugins.registry.get("demo")!;
    const resolve = (user: boolean) => {
      plugins.rows.saveHeaders(
        "demo",
        "remote",
        user
          ? [
              {
                server: "remote",
                name: "X-K",
                value: "v",
                secret: true,
                plainOk: false,
              },
            ]
          : [],
      );
      const config = plugins as never as { "#config"?: never };
      void config;
      return toMcpEntries(
        resolvePluginServers(
          [{ plugin: entry.plugin!, config: configOf(plugins, "demo") }],
          plugins.registry.get("demo")!.dir,
          () => {},
        ),
      )["demo-remote"] as { auth?: unknown };
    };
    expect(resolve(false).auth).toBe("oauth");
    expect(resolve(true).auth).toBeUndefined();
  });

  it("is removed with the plugin and not sent while the plugin is off", async () => {
    const { plugins, servers, meta } = await setup();
    plugins.setHeaders("demo", "remote", [
      { name: "Authorization", value: `Bearer ${SECRET}`, secret: true },
    ]);
    plugins.setEnabled("demo", false);
    expect(plugins.mcpSourcesFor("ada")).toEqual([]);
    const extras = await plugins.runtimeExtrasFor(meta);
    expect(JSON.stringify(extras)).not.toContain(SECRET);
    // Off keeps them; on sends them again.
    plugins.setEnabled("demo", true);
    expect(servers()["demo-remote"]?.headers?.Authorization).toContain(SECRET);
    plugins.rows.removeSource("demo");
    expect(plugins.rows.headers("demo")).toEqual([]);
  });
});

function configOf(plugins: Plugins, name: string) {
  const entry = plugins.registry.get(name)!;
  return serversConfigOf(
    entry.plugin!,
    plugins.rows.values(name),
    plugins.rows.headers(name),
  );
}
