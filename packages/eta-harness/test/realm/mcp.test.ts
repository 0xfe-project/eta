import type { McpSink, McpToolInfo } from "../../src/realm/hooks";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderPlatformBlock } from "../../src/prompts/platform";
import { Agent } from "../../src/realm/agent";

const tools: McpToolInfo[] = [
  { name: "read_file", description: "Read a file." },
  { name: "browser-snapshot", description: "Not an identifier." },
];

function sink(calls: unknown[] = []): McpSink {
  return {
    servers: () => [{ name: "fs", status: "cached", toolCount: tools.length }],
    load: async (server) => {
      if (server !== "fs")
        throw new Error(`unknown MCP server "${server}"; configured: fs`);
      return tools;
    },
    search: () => [{ server: "fs", tool: tools[0]!, score: 1 }],
    describe: (server) => `declare module "mcp:${server}" {}`,
    callTool: async (server, tool, args) => {
      calls.push({ server, tool: tool.name, args });
      if (tool.name === "browser-snapshot") throw new Error("boom");
      return { ok: true, path: (args as { path?: string }).path };
    },
  };
}

const root = () => mkdtempSync(join(tmpdir(), "mcp-realm-"));

describe("mcp: modules", () => {
  it("calls a tool through a named export and the default object", async () => {
    const calls: unknown[] = [];
    const agent = new Agent({ root: root(), hooks: { mcp: sink(calls) } });
    const result = await agent.run(`
      import fs, { read_file } from "mcp:fs";
      const a = await read_file({ path: "a" });
      const b = await fs["read_file"]({ path: "b" });
      export default [a.path, b.path, Array.isArray([]), typeof fs["browser-snapshot"]];
    `);
    expect(result.value).toEqual(["a", "b", true, "function"]);
    expect(calls).toHaveLength(2);
    expect(result.effects.map((e) => e.name)).toContain("mcp.fs.read_file");
  });

  it("a tool error rejects", async () => {
    const agent = new Agent({ root: root(), hooks: { mcp: sink() } });
    const result = await agent.run(`
      import fs from "mcp:fs";
      let message = "";
      try { await fs["browser-snapshot"]({}); } catch (e) { message = e.message; }
      export default message;
    `);
    expect(result.value).toContain("boom");
  });

  it("an unknown server names the configured ones", async () => {
    const agent = new Agent({ root: root(), hooks: { mcp: sink() } });
    await expect(
      agent.run(`import x from "mcp:nope"; export default x;`),
    ).rejects.toThrow(/configured: fs/);
  });

  it("without a sink the import says MCP is not on this machine", async () => {
    const agent = new Agent({ root: root(), hooks: {} });
    await expect(
      agent.run(`import x from "mcp:fs"; export default x;`),
    ).rejects.toThrow(/MCP not connected on this machine/);
  });

  it("the authorizer can refuse a call", async () => {
    const calls: unknown[] = [];
    const agent = new Agent({
      root: root(),
      hooks: {
        mcp: sink(calls),
        authorize: async (request) =>
          request.name.startsWith("mcp.") ? "not allowed" : undefined,
      },
    });
    const result = await agent.run(`
      import { read_file } from "mcp:fs";
      let message = "";
      try { await read_file({ path: "a" }); } catch (e) { message = e.message; }
      export default message;
    `);
    expect(result.value).toContain("refused: not allowed");
    expect(calls).toHaveLength(0);
  });
});

describe("eta.mcp", () => {
  it("discovers from the sink", async () => {
    const agent = new Agent({ root: root(), hooks: { mcp: sink() } });
    const result = await agent.run(`
      import eta from "eta";
      export default [eta.mcp.servers()[0].name, eta.mcp.search("read")[0].tool, eta.mcp.describe("fs")];
    `);
    expect(result.value).toEqual([
      "fs",
      "read_file",
      'declare module "mcp:fs" {}',
    ]);
  });

  it("says MCP is not on this machine without a sink", async () => {
    const agent = new Agent({ root: root(), hooks: {} });
    const result = await agent.run(`
      import eta from "eta";
      let message = "";
      try { eta.mcp.servers(); } catch (e) { message = e.message; }
      export default message;
    `);
    expect(result.value).toBe("MCP not connected on this machine");
  });
});

describe("the MCP prompt section", () => {
  const info = {
    cwd: "/w",
    home: "/h",
    configPath: "/h/.eta/config.json",
    memoryTarget: "/w/.eta/MEMORY.md",
    memoryExists: true,
    realm: true,
  };
  it("is omitted without servers", () => {
    expect(renderPlatformBlock(info)).not.toContain("mcp:");
    expect(renderPlatformBlock({ ...info, mcpServers: [] })).not.toContain(
      "mcp:",
    );
  });
  it("names the servers when there are some", () => {
    const text = renderPlatformBlock({ ...info, mcpServers: ["fs", "github"] });
    expect(text).toContain("MCP servers on this machine: `fs`, `github`");
    expect(text).toContain('import fs from "mcp:fs"');
  });
});
