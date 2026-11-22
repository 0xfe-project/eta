import type { SessionMeta } from "@eta/server";
/**
 * Environment variables a user sets on a plugin's stdio MCP server: sent to that server only, never shown
 * again, gone with the plugin, not started while it is off, and never in a log.
 */
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
        local: { type: "stdio", command: "node", env: { FIXED: "from-file" } },
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
      { env?: Record<string, string>; headers?: Record<string, string> }
    >;
  return { plugins, meta, servers, logs };
}

describe("variables the user sets on a stdio server", () => {
  it("reach that server, and the file's own variable cannot be overridden", async () => {
    const { plugins, servers } = await setup();
    plugins.setEnv("demo", "local", [
      { name: "API_TOKEN", value: SECRET, secret: true },
    ]);
    expect(servers()["demo-local"]?.env).toMatchObject({
      API_TOKEN: SECRET,
      FIXED: "from-file",
    });
    expect(() =>
      plugins.setEnv("demo", "local", [
        { name: "FIXED", value: "x", secret: false },
      ]),
    ).toThrow(/set by the plugin/);
    expect(() =>
      plugins.setEnv("demo", "local", [
        { name: "PLUGIN_ROOT", value: "x", secret: false },
      ]),
    ).toThrow();
  });

  it("is never in the view, is redacted, and a saved secret can be kept", async () => {
    const { plugins, servers } = await setup();
    plugins.setEnv("demo", "local", [
      { name: "API_TOKEN", value: SECRET, secret: true },
      { name: "TEAM", value: "blue", secret: false },
    ]);
    const view = plugins.view().find((entry) => entry.name === "demo")!;
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(view.env!.find((one) => one.name === "API_TOKEN")).toMatchObject({
      secret: true,
      value: null,
    });
    expect(view.env!.find((one) => one.name === "TEAM")!.value).toBe("blue");
    expect(
      plugins.redactionsFor("ada").some((one) => one.value === SECRET),
    ).toBe(true);
    plugins.setEnv("demo", "local", [
      { name: "API_TOKEN", value: null, secret: true },
    ]);
    expect(servers()["demo-local"]?.env?.API_TOKEN).toBe(SECRET);
    expect(() =>
      plugins.setEnv("demo", "local", [
        { name: "NOPE", value: null, secret: true },
      ]),
    ).toThrow();
  });

  it("refuses a bad name, an empty value, a duplicate and a remote server, without echoing the value", async () => {
    const { plugins } = await setup();
    for (const one of [
      { name: "", value: "x" },
      { name: "A B", value: "x" },
      { name: "1A", value: "x" },
      { name: "OK", value: "" },
      { name: "OK", value: `${SECRET}\0` },
    ]) {
      let message = "";
      try {
        plugins.setEnv("demo", "local", [{ ...one, secret: true }]);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(SECRET);
    }
    expect(plugins.rows.env("demo")).toEqual([]);
    expect(() =>
      plugins.setEnv("demo", "remote", [
        { name: "A", value: "v", secret: true },
      ]),
    ).toThrow();
    expect(() =>
      plugins.setEnv("demo", "local", [
        { name: "A", value: "1", secret: true },
        { name: "A", value: "2", secret: true },
      ]),
    ).toThrow();
  });

  it("is not logged, is not started while the plugin is off, and goes with the plugin", async () => {
    const { plugins, servers, logs, meta } = await setup();
    plugins.setEnv("demo", "local", [
      { name: "API_TOKEN", value: SECRET, secret: true },
    ]);
    await plugins.runtimeExtrasFor(meta);
    expect(logs.join("\n")).not.toContain(SECRET);
    plugins.setEnabled("demo", false);
    expect(plugins.mcpSourcesFor("ada")).toEqual([]);
    expect(JSON.stringify(await plugins.runtimeExtrasFor(meta))).not.toContain(
      SECRET,
    );
    plugins.setEnabled("demo", true);
    expect(servers()["demo-local"]?.env?.API_TOKEN).toBe(SECRET);
    plugins.rows.removeSource("demo");
    expect(plugins.rows.env("demo")).toEqual([]);
  });
});
