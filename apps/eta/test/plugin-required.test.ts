import type { SessionMeta } from "@eta/server";
/**
 * A plugin with a required field nobody has filled in is "needs config": none of its servers is
 * handed to an agent, and filling it in (or clearing it again) takes effect at once.
 * Runs on a local fixture written to a temp directory, so it does not depend on file URLs.
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
const KEY = "s3cr3t-value-123";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function setup(localEnv?: Record<string, string>) {
  const dataDir = await mkdtemp(join(tmpdir(), "eta-required-"));
  dirs.push(dataDir);
  const dir = join(dataDir, "plugins", "demo");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "plugin.json"),
    JSON.stringify({
      $schema: PLUGIN,
      name: "demo",
      extensions: {
        "tech.0xfe.eta": {
          config: {
            api_key: {
              type: "string",
              title: "API key",
              required: true,
              secret: true,
            },
          },
          mcp: { local: { env: { DEMO_KEY: "api_key" } } },
        },
      },
    }),
  );
  await writeFile(
    join(dir, "mcp.json"),
    JSON.stringify({
      $schema: MCP,
      mcpServers: {
        local: {
          type: "stdio",
          command: "node",
          ...(localEnv ? { env: localEnv } : {}),
        },
      },
    }),
  );
  const db = openDatabase(":memory:");
  applyMigrations(db, loadMigrations());
  db.exec("PRAGMA foreign_keys = OFF");
  const plugins = new Plugins({
    db,
    dataDir,
    key: Buffer.alloc(32, 1),
    agents: { get: () => ({ runtime: "eta" }) } as never,
    machines: { list: () => [] } as never,
    hub: { onReady: () => {} } as never,
    changed: () => {},
    warn: () => {},
  });
  await plugins.registry.refresh();
  plugins.rows.setEnabled("ada", ["demo"]);
  const meta = { agentId: "ada", runtime: "codex" } as SessionMeta;
  return { plugins, meta };
}

describe("a required field that is missing", () => {
  it("keeps the server from being started until it is filled in", async () => {
    const { plugins, meta } = await setup();
    const entry = plugins.registry.get("demo")!;
    expect(plugins.stateOf(entry)).toBe("needs_config");
    expect(plugins.mcpSourcesFor("ada")).toEqual([]);
    expect(JSON.stringify(await plugins.runtimeExtrasFor(meta))).not.toContain(
      "demo-local",
    );

    plugins.configure("demo", { api_key: KEY });
    expect(plugins.stateOf(entry)).toBe("ready");
    const servers = plugins.mcpSourcesFor("ada")[0]?.servers as Record<
      string,
      { env?: Record<string, string> }
    >;
    expect(servers["demo-local"]?.env?.DEMO_KEY).toBe(KEY);

    plugins.configure("demo", { api_key: null });
    expect(plugins.stateOf(entry)).toBe("needs_config");
    expect(plugins.mcpSourcesFor("ada")).toEqual([]);
  });
});

describe("a stdio variable the file leaves empty", () => {
  it("is a blank to fill: needs config and no server until the user sets it", async () => {
    const { plugins, meta } = await setup({ SERVICE_TOKEN: "" });
    plugins.configure("demo", { api_key: "s3cr3t-value-123" });
    const entry = plugins.registry.get("demo")!;
    // The field is filled; the blank variable still keeps the plugin from running.
    expect(plugins.stateOf(entry)).toBe("needs_config");
    expect(plugins.canEnable("demo")).toBe(false);
    expect(plugins.mcpSourcesFor("ada")).toEqual([]);
    expect(JSON.stringify(await plugins.runtimeExtrasFor(meta))).not.toContain(
      "demo-local",
    );

    plugins.setEnv("demo", "local", [
      { name: "SERVICE_TOKEN", value: KEY, secret: true },
    ]);
    expect(plugins.stateOf(entry)).toBe("ready");
    const servers = plugins.mcpSourcesFor("ada")[0]?.servers as Record<
      string,
      { env?: Record<string, string> }
    >;
    expect(servers["demo-local"]?.env?.SERVICE_TOKEN).toBe(KEY);

    // Taking it away again stops the server again.
    plugins.setEnv("demo", "local", []);
    expect(plugins.stateOf(entry)).toBe("needs_config");
    expect(plugins.mcpSourcesFor("ada")).toEqual([]);
  });
});
