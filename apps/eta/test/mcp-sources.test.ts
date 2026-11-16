/**
 * The order of a session's MCP sources: the agent's plugins, then `~/.eta/mcp.json`, then the
 * project's `.mcp.json`. A later one replaces an earlier server of the same name, so the user's
 * files are how a plugin's server is overridden; this pins that it is not the other way round.
 */
import type { McpConfigSource } from "@eta/mcp";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { McpHost } from "@eta/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "./support/host";

const hosts: McpHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

const NAME = "demo-remote";
const plugin: McpConfigSource = {
  name: "plugin:demo",
  servers: {
    [NAME]: {
      type: "streamable-http",
      url: "https://plugin.test/mcp",
      auth: "oauth",
    },
  },
};

const mcpJson = (url: string) =>
  JSON.stringify({ mcpServers: { [NAME]: { url } } });

async function setUp(files: { user?: boolean; project?: boolean }) {
  const home = await tempDir("eta-home-");
  const dataDir = await tempDir("eta-data-");
  const cwd = await tempDir("eta-project-");
  if (files.user === true) {
    await mkdir(join(home, ".eta"), { recursive: true });
    await writeFile(
      join(home, ".eta", "mcp.json"),
      mcpJson("https://user.test/mcp"),
    );
  }
  if (files.project === true)
    await writeFile(
      join(cwd, ".mcp.json"),
      mcpJson("https://project.test/mcp"),
    );
  const host = new McpHost({
    dataDir,
    home,
    warn: () => undefined,
    pluginSources: ({ agentId }) => (agentId === "ada" ? [plugin] : []),
    manager: { resolvers: false, checkIntervalMs: 0 },
  });
  hosts.push(host);
  return { host, cwd };
}

describe("where a session's MCP servers come from", () => {
  it("puts the plugin's sources first, the user's file next, the project's last", async () => {
    const { host, cwd } = await setUp({ user: true, project: true });
    expect(
      host.sourcesFor({ agentId: "ada" }, cwd).map((source) => source.name),
    ).toEqual(["plugin:demo", "~/.eta/mcp.json", ".mcp.json"]);
  });

  it("lets the user's file override a plugin's server, and says so", async () => {
    const { host } = await setUp({ user: true });
    const scope = host.inspect("ada");
    expect(scope.definition(NAME)).toMatchObject({
      source: "~/.eta/mcp.json",
      url: "https://user.test/mcp",
    });
    expect(scope.definition(NAME)?.auth).toBeUndefined();
    expect(scope.issues).toContain(
      `server "${NAME}": "~/.eta/mcp.json" overrides "plugin:demo"`,
    );
  });

  it("lets the project's file override both, in a session", async () => {
    const { host, cwd } = await setUp({ user: true, project: true });
    const wiring = host.sessionMcp({
      id: "s1",
      createdAt: 0,
      cwd,
      agentId: "ada",
    } as never);
    expect(wiring).toBeDefined();
    const [{ scope }] = host.scopes();
    expect(scope!.definition(NAME)).toMatchObject({
      source: ".mcp.json",
      url: "https://project.test/mcp",
    });
    wiring!.dispose?.();
  });

  it("keeps the plugin's server when nothing overrides it", async () => {
    const { host } = await setUp({});
    expect(host.inspect("ada").definition(NAME)).toMatchObject({
      source: "plugin:demo",
      auth: "oauth",
    });
    expect(host.inspect("bo").definition(NAME)).toBeUndefined();
  });
});
