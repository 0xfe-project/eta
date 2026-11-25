/**
 * What an external runtime is given for a plugin's HTTP MCP server. A Claude Code plugin's
 * `.mcp.json` (the shape firecrawl ships) goes through the real loader to the session server the
 * runtime gets; a server that signs in with OAuth is given its address and the static headers and
 * nothing else: no token comes from eta (`ResolvedServer.auth` stops at eta's own loop).
 */
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPlugin,
  resolvePluginServers,
  runtimeExtras,
  serversConfig,
  sessionServerName,
} from "../src";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "eta-http-")));
  dirs.push(dir);
  return dir;
}

/** A Claude Code plugin: `.claude-plugin/plugin.json` and a `.mcp.json`, as firecrawl's is. */
async function claudePlugin() {
  const root = await temp();
  await mkdir(join(root, ".claude-plugin"));
  await writeFile(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "firecrawl", description: "Web search" }),
  );
  await writeFile(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        firecrawl: {
          type: "http",
          url: "https://mcp.firecrawl.dev/v2/mcp-search",
        },
      },
    }),
  );
  return await loadPlugin(root);
}

async function eta(name: string, server: unknown, extension: unknown = {}) {
  const root = await temp();
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name,
      extensions: { "tech.0xfe.eta": extension },
    }),
  );
  await writeFile(
    join(root, "mcp.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { remote: server },
    }),
  );
  return await loadPlugin(root);
}

async function given(loaded: Awaited<ReturnType<typeof loadPlugin>>) {
  const warnings: string[] = [];
  const extras = await runtimeExtras(
    [
      {
        plugin: loaded,
        hash: "a".repeat(64),
        config: serversConfig(loaded, {}),
      },
    ],
    {
      dataDir: await temp(),
      runtime: "agy",
      warn: (warning) => warnings.push(warning),
    },
  );
  return { extras, warnings };
}

describe("a Claude Code plugin's .mcp.json, as firecrawl ships it", () => {
  it("loads as one HTTP server and reaches an external runtime as its address alone", async () => {
    const loaded = await claudePlugin();
    expect(
      loaded.servers.map((server) => [server.name, server.config.type]),
    ).toEqual([["firecrawl", "streamable-http"]]);
    const { extras, warnings } = await given(loaded);
    expect(warnings).toEqual([]);
    expect(extras.mcpServers).toStrictEqual([
      {
        name: sessionServerName("firecrawl", "firecrawl"),
        type: "http",
        url: "https://mcp.firecrawl.dev/v2/mcp-search",
      },
    ]);
  });
});

describe("a server that signs in with OAuth, for an external runtime", () => {
  it("is resolved as OAuth for eta's own loop, and is given no token and no header", async () => {
    const loaded = await eta(
      "demo",
      { type: "streamable-http", url: "https://example.com/mcp" },
      { mcp: { remote: { auth: "oauth" } } },
    );
    const resolved = resolvePluginServers(
      [{ plugin: loaded, config: serversConfig(loaded, {}) }],
      await temp(),
      () => undefined,
    );
    expect(resolved).toMatchObject([{ name: "demo-remote", auth: "oauth" }]);
    const { extras } = await given(loaded);
    expect(extras.mcpServers).toStrictEqual([
      { name: "demo-remote", type: "http", url: "https://example.com/mcp" },
    ]);
  });

  it("is given only the headers the plugin or the user set, never a token of eta's", async () => {
    const loaded = await eta(
      "demo",
      {
        type: "streamable-http",
        url: "https://example.com/mcp",
        headers: { "X-Fixed": "f" },
      },
      { mcp: { remote: { auth: "oauth" } } },
    );
    const { extras } = await given(loaded);
    expect(extras.mcpServers).toStrictEqual([
      {
        name: "demo-remote",
        type: "http",
        url: "https://example.com/mcp",
        headers: { "X-Fixed": "f" },
      },
    ]);
    const sent = JSON.stringify(extras.mcpServers).toLowerCase();
    expect(sent).not.toContain("authorization");
    expect(sent).not.toContain("bearer");
  });
});
