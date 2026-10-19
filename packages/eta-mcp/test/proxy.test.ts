import type { McpToolResult } from "../src/types";
/**
 * The `mcp` proxy tool: every action, name matching, and answering from the cache without a server.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createProxyTool } from "../src";
import { McpManager } from "../src/manager";
import { startFakeHttp } from "./helpers/fake-http";
import { cleanupAll, setup, tool } from "./helpers/harness";

afterEach(cleanupAll);

function text(result: McpToolResult): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
    .join("\n");
}

const files = {
  instructions: "Use absolute paths. Prefer read_file before write_file.",
  tools: [
    tool("read_file", {
      description: "Read the contents of a file",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Where" },
          limit: { type: "integer" },
        },
        required: ["path"],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        title: "Reader",
      },
      behavior: "echo",
    }),
    tool("write_file", {
      description: "Write contents to a file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, data: { type: "string" } },
        required: ["path", "data"],
      },
      annotations: { destructiveHint: true },
    }),
    tool("list-directory", {
      description: "List the files in a directory",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    }),
  ],
};

const web = {
  tools: [
    tool("fetch_url", { description: "Download a web page" }),
    tool("read_file", { description: "Read a cached page" }),
  ],
};

async function twoServers() {
  const h = await setup();
  const scope = h.manager.scope({
    owner: "a",
    sources: [
      h.source({
        fs: h.stdio(files, { description: "Local files" }),
        web: h.stdio(web, {
          searchKeywords: { fetch_url: ["download", "curl"] },
        }),
      }),
    ],
  });
  const proxy = createProxyTool(scope);
  const run = async (args: Record<string, unknown>) =>
    await proxy.execute(args);
  return { h, scope, proxy, run };
}

describe("the tool definition", () => {
  it("is small and depends only on the configured servers", async () => {
    const { proxy, scope, h } = await twoServers();
    expect(proxy.name).toBe("mcp");
    expect(proxy.description).toContain("Servers: fs, web");
    expect(proxy.description.length).toBeLessThan(900);
    expect(proxy.parameters).toMatchObject({ type: "object" });
    const before = proxy.description;
    await scope.connect("fs");
    await scope.callTool("fs", scope.tools("fs")![0]!, { path: "/" });
    expect(createProxyTool(scope).description).toBe(before);
    h.advance(1);
  });

  it("leaves disabled servers out of the description", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [
        h.source({ on: h.stdio(web), off: h.stdio(web, { disabled: true }) }),
      ],
    });
    expect(createProxyTool(scope).description).toContain("Servers: on");
    expect(createProxyTool(scope).description).toMatch(/Servers: on\n/);
  });
});

describe("status", () => {
  it("shows servers whose tools are not known, then connected and cached ones", async () => {
    const { h, scope, run } = await twoServers();
    let result = await run({});
    expect(text(result)).toContain("MCP: 0/2 servers, 0 tools");
    expect(text(result)).toContain("○ fs (not connected; tools unknown)");

    await scope.connect("fs");
    result = await run({});
    expect(text(result)).toContain("MCP: 1/2 servers, 3 tools");
    expect(text(result)).toContain("✓ fs (3 tools)");

    h.advance(11 * 60_000);
    await h.manager.sweep();
    result = await run({});
    expect(text(result)).toContain("○ fs (3 tools, cached; not connected)");
    expect(result.details).toMatchObject({
      mode: "status",
      totalTools: 3,
      connectedCount: 0,
    });
  });

  it("marks disabled servers", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [h.source({ off: h.stdio(web, { disabled: true }) })],
    });
    const result = await createProxyTool(scope).execute({});
    expect(text(result)).toContain("⊘ off (disabled)");
    expect(text(result)).toContain("(1 disabled)");
  });
});

describe("list, instructions and connect", () => {
  it("connect lists the server's tools with parameter names and instructions", async () => {
    const { h, run } = await twoServers();
    const result = await run({ connect: "fs" });
    expect(h.starts()).toBe(1);
    const out = text(result);
    expect(out).toContain("fs (3 tools):");
    expect(out).toContain("Description: Local files");
    expect(out).toContain(
      "- read_file(path, limit?) - Read the contents of a file",
    );
    expect(out).toContain(
      "- write_file(path, data) - Write contents to a file",
    );
    expect(out).toContain(
      "- list-directory(path?) - List the files in a directory",
    );
    expect(out).toContain("Server instructions:");
    expect(result.details).toMatchObject({
      mode: "list",
      count: 3,
      hasInstructions: true,
    });
  });

  it("lists from the cache once the server is stopped, with a note", async () => {
    const { h, run } = await twoServers();
    await run({ connect: "fs" });
    h.advance(11 * 60_000);
    await h.manager.sweep();
    const out = text(await run({ server: "fs" }));
    expect(out).toContain(
      "fs (3 tools (lazy: tools from cache, not connected yet",
    );
    expect(h.starts()).toBe(1);
  });

  it("explains a server whose tools are not known", async () => {
    const { run } = await twoServers();
    const result = await run({ server: "fs" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('mcp({ connect: "fs" })');
  });

  it("reports an unknown server", async () => {
    const { run } = await twoServers();
    for (const args of [
      { server: "nope" },
      { connect: "nope" },
      { instructions: "nope" },
    ]) {
      const result = await run(args);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('Server "nope" not found');
    }
  });

  it("returns the full instructions", async () => {
    const { run } = await twoServers();
    await run({ connect: "fs" });
    const result = await run({ instructions: "fs" });
    expect(text(result)).toBe(`fs instructions:\n\n${files.instructions}`);
  });

  it("says when a server has no instructions, or none are cached", async () => {
    const { run } = await twoServers();
    expect(text(await run({ instructions: "web" }))).toContain(
      'No instructions cached for "web"',
    );
    await run({ connect: "web" });
    expect(text(await run({ instructions: "web" }))).toContain(
      "does not provide instructions",
    );
  });

  it("reports a failed connect with the server's own message", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [
        h.source({
          s: h.stdio(
            web,
            {},
            { FAKE_MCP_FAIL: "1", FAKE_MCP_STDERR: "no api key" },
          ),
        }),
      ],
    });
    const result = await createProxyTool(scope).execute({ connect: "s" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Failed to connect to "s"');
    expect(text(result)).toContain("no api key");
    expect(result.details).toMatchObject({ error: "connect_failed" });
  });

  it("tells a server that needs sign-in apart from one that is down", async () => {
    const h = await setup();
    const http = await startFakeHttp({ spec: web, bearer: "x" });
    try {
      const scope = h.manager.scope({
        owner: "a",
        sources: [h.source({ remote: { url: http.url } })],
      });
      const result = await createProxyTool(scope).execute({
        connect: "remote",
      });
      expect(result.details).toMatchObject({ error: "auth_required" });
      expect(text(result)).toContain("requires authentication");
    } finally {
      await h.manager.closeAll();
      await http.close();
    }
  });
});

describe("search", () => {
  it("ranks across servers and shows the server, the shape and the approval marker", async () => {
    const { run } = await twoServers();
    await run({ connect: "fs" });
    await run({ connect: "web" });
    const result = await run({ search: "read file" });
    const out = text(result);
    expect(out).toContain("Found ");
    expect(out.indexOf("read_file [fs]")).toBeLessThan(
      out.indexOf("read_file [web]"),
    );
    expect(out).toContain("{ path: string; limit?: number; }");
    expect(result.details).toMatchObject({ mode: "search", hasMore: false });
  });

  it("uses searchKeywords, which appear nowhere else", async () => {
    const { run } = await twoServers();
    await run({ connect: "web" });
    expect(text(await run({ search: "curl" }))).toContain("fetch_url [web]");
    expect(text(await run({ describe: "fetch_url" }))).not.toContain("curl");
  });

  it("pages through results", async () => {
    const h = await setup();
    const many = {
      tools: Array.from({ length: 30 }, (_, index) =>
        tool(`item_${String(index).padStart(2, "0")}`, {
          description: "an item",
        }),
      ),
    };
    const scope = h.manager.scope({
      owner: "a",
      sources: [h.source({ s: h.stdio(many) })],
    });
    const proxy = createProxyTool(scope);
    await proxy.execute({ connect: "s" });
    const first = await proxy.execute({ search: "item", limit: 12 });
    expect(first.details).toMatchObject({
      count: 30,
      hasMore: true,
      nextOffset: 12,
    });
    expect(text(first)).toContain("12 of 30, offset: 12 for more");
    const third = await proxy.execute({
      search: "item",
      limit: 12,
      offset: 24,
    });
    expect(third.details).toMatchObject({ hasMore: false, nextOffset: null });
    expect((third.details.matches as unknown[]).length).toBe(6);
  });

  it("searches by regular expression, unranked", async () => {
    const { run } = await twoServers();
    await run({ connect: "fs" });
    const result = await run({ search: "^(read|write)_", regex: true });
    expect(text(result)).toContain("read_file");
    expect(text(result)).toContain("write_file");
    expect(text(result)).not.toContain("list-directory");
    expect(text(await run({ search: "[", regex: true }))).toContain(
      "Invalid regex",
    );
    expect(text(await run({ search: "(a+)+$", regex: true }))).toContain(
      "unsafe",
    );
    expect(text(await run({ search: "x".repeat(300), regex: true }))).toContain(
      "too long",
    );
  });

  it("limits to a server, and lists a whole server for an empty query", async () => {
    const { run } = await twoServers();
    await run({ connect: "fs" });
    await run({ connect: "web" });
    const scoped = await run({ search: "read", server: "web" });
    expect(text(scoped)).toContain("read_file [web]");
    expect(text(scoped)).not.toContain("[fs]");
    const all = await run({ search: "", server: "fs" });
    expect(text(all)).toContain("list-directory [fs]");
    expect(text(await run({ search: "" }))).toContain(
      "Search query cannot be empty",
    );
  });

  it("says nothing matched, and which servers have not been read", async () => {
    const { run } = await twoServers();
    await run({ connect: "fs" });
    const out = text(await run({ search: "banana" }));
    expect(out).toContain('No tools matching "banana"');
    expect(out).toContain('"web" are not known yet');
  });
});

describe("describe", () => {
  it("returns the original input schema, hints and the approval marker", async () => {
    const { h, scope, run } = await twoServers();
    scope.setSources([
      h.source({
        fs: h.stdio(files, { approveTools: "destructive" }),
        web: h.stdio(web),
      }),
    ]);
    await run({ connect: "fs" });
    const result = await run({ describe: "write_file" });
    const out = text(result);
    expect(out).toContain("write_file (requires approval)");
    expect(out).toContain("Hints: destructive");
    expect(out).toContain(JSON.stringify(files.tools[1]!.inputSchema, null, 2));
    expect(result.details).toMatchObject({
      mode: "describe",
      server: "fs",
      name: "mcp__fs__write_file",
    });

    const read = text(await run({ describe: "read_file", server: "fs" }));
    expect(read).toContain('Hints: read-only, non-destructive, title "Reader"');
    expect(read).not.toContain("requires approval");
  });

  it("matches hyphens and underscores either way", async () => {
    const { run } = await twoServers();
    await run({ connect: "fs" });
    expect(text(await run({ describe: "list_directory" }))).toContain(
      "list-directory",
    );
    expect(text(await run({ describe: "list-directory" }))).toContain(
      "list-directory",
    );
    expect(text(await run({ describe: "mcp__fs__list_directory" }))).toContain(
      "list-directory",
    );
    expect(text(await run({ describe: "fs_list_directory" }))).toContain(
      "list-directory",
    );
  });

  it("connects a server named in the request that was never read", async () => {
    const { h, run } = await twoServers();
    expect(text(await run({ describe: "fetch_url", server: "web" }))).toContain(
      "Download a web page",
    );
    expect(h.starts()).toBe(1);
  });

  it("asks which server when two have the tool", async () => {
    const { run } = await twoServers();
    await run({ connect: "fs" });
    await run({ connect: "web" });
    const result = await run({ describe: "read_file" });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      error: "ambiguous_tool",
      servers: ["fs", "web"],
    });
    expect(text(await run({ describe: "read_file", server: "web" }))).toContain(
      "Read a cached page",
    );
  });

  it("suggests names for a miss", async () => {
    const { run } = await twoServers();
    await run({ connect: "fs" });
    const result = await run({ describe: "read_fle" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Tool "read_fle" not found');
    expect(text(result)).toContain("Did you mean: read_file");
    expect(result.details).toMatchObject({
      error: "tool_not_found",
      suggestions: ["read_file"],
    });
  });

  it("shows the output schema when there is one, and the shape seen otherwise", async () => {
    const h = await setup();
    const spec = {
      tools: [
        tool("typed", {
          outputSchema: {
            type: "object",
            properties: { n: { type: "number" } },
            required: ["n"],
          },
          result: {
            content: [{ type: "text", text: "{}" }],
            structuredContent: { n: 1 },
          },
        }),
        tool("plain", {
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ id: 1, name: "x", tags: ["a"] }),
              },
            ],
          },
        }),
      ],
    };
    const scope = h.manager.scope({
      owner: "a",
      sources: [h.source({ s: h.stdio(spec) })],
    });
    const proxy = createProxyTool(scope);
    await proxy.execute({ connect: "s" });
    expect(text(await proxy.execute({ describe: "typed" }))).toContain(
      "Output schema (JSON Schema)",
    );
    expect(text(await proxy.execute({ describe: "plain" }))).not.toContain(
      "Observed output",
    );

    await proxy.execute({ tool: "plain" });
    const out = text(await proxy.execute({ describe: "plain" }));
    expect(out).toContain(
      "Observed output (JSON text result, from earlier calls, not a contract)",
    );
    expect(out).toContain("{ id: number; name: string; tags: string[]; }");
  });
});

describe("call", () => {
  it("calls by name, with object or JSON-string args, and by qualified name", async () => {
    const { run } = await twoServers();
    const object = await run({
      tool: "read_file",
      server: "fs",
      args: { path: "/a" },
    });
    expect(text(object)).toBe('{"path":"/a"}');
    const string = await run({
      tool: "read_file",
      server: "fs",
      args: '{"path":"/b"}',
    });
    expect(text(string)).toBe('{"path":"/b"}');
    const qualified = await run({
      tool: "mcp__fs__read_file",
      args: { path: "/c" },
    });
    expect(text(qualified)).toBe('{"path":"/c"}');
    expect(object.details).toMatchObject({
      mode: "call",
      server: "fs",
      tool: "read_file",
      name: "mcp__fs__read_file",
    });
    expect(object.isError).toBeUndefined();
  });

  it("finds a tool across servers when only one has it, loading what it must", async () => {
    const { h, run } = await twoServers();
    // Nothing is known yet: the prefix names the server, which is read on demand.
    const result = await run({ tool: "web_fetch_url" });
    expect(text(result)).toBe("fetch_url ok");
    expect(h.starts()).toBe(1);
  });

  it("rejects arguments that do not fit the schema, showing the schema", async () => {
    const { run } = await twoServers();
    const result = await run({
      tool: "read_file",
      server: "fs",
      args: { limit: "many" },
    });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      error: "call_failed",
      delivery: "not_sent",
    });
    expect(text(result)).toContain("Failed to call tool");
    expect(text(result)).toContain('"path"');
  });

  it("rejects args that are not an object", async () => {
    const { run } = await twoServers();
    const result = await run({ tool: "read_file", server: "fs", args: "[1]" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("expected a JSON object");
  });

  it("suggests tools for a miss, and names the servers it could not read", async () => {
    const { run } = await twoServers();
    await run({ connect: "fs" });
    const result = await run({ tool: "write_fil", server: "fs" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Did you mean: write_file");
    const lost = await run({ tool: "nothing_like_it" });
    expect(text(lost)).toContain("not known yet");
  });

  it("reports an unknown server", async () => {
    const { run } = await twoServers();
    const result = await run({ tool: "x", server: "nope" });
    expect(result.details).toMatchObject({ error: "server_not_found" });
  });
});

describe("answering without a server", () => {
  it("lists, searches and describes from the cache of an earlier process", async () => {
    const first = await setup();
    const sources = [
      first.source({ fs: first.stdio(files), web: first.stdio(web) }),
    ];
    const scope = first.manager.scope({ owner: "a", sources });
    await createProxyTool(scope).execute({ connect: "fs" });
    await createProxyTool(scope).execute({ connect: "web" });
    await first.manager.closeAll();
    const startsBefore = first.starts();

    // A new manager on the same cache file: nothing is connected.
    const second = new McpManager({
      cacheFile: `${first.dir}/cache.json`,
      outputDir: `${first.dir}/outputs`,
      checkIntervalMs: 0,
      resolvers: false,
    });
    try {
      const proxy = createProxyTool(second.scope({ owner: "a", sources }));
      expect(text(await proxy.execute({}))).toContain(
        "○ fs (3 tools, cached; not connected)",
      );
      expect(text(await proxy.execute({ server: "fs" }))).toContain(
        "- read_file(path, limit?)",
      );
      expect(
        text(await proxy.execute({ search: "download", server: "web" })),
      ).not.toContain("No tools");
      expect(
        text(await proxy.execute({ describe: "write_file", server: "fs" })),
      ).toContain("Input schema (JSON Schema)");
      expect(text(await proxy.execute({ instructions: "fs" }))).toContain(
        "Use absolute paths",
      );
      expect(first.starts()).toBe(startsBefore);
    } finally {
      await second.closeAll();
    }
  });

  it("drops the cache of a server whose config changed", async () => {
    const first = await setup();
    const scope = first.manager.scope({
      owner: "a",
      sources: [first.source({ fs: first.stdio(files) })],
    });
    await scope.connect("fs");
    expect(scope.tools("fs")).toHaveLength(3);

    scope.setSources([
      first.source({ fs: first.stdio(files, {}, { CHANGED: "1" }) }),
    ]);
    expect(scope.tools("fs")).toBeUndefined();
    // Runtime-only changes keep it.
    scope.setSources([first.source({ fs: first.stdio(files, {}) })]);
    expect(scope.tools("fs")).toHaveLength(3);
    scope.setSources([
      first.source({
        fs: first.stdio(files, {
          lifecycle: "lazy",
          idleTimeout: 3,
          description: "x",
        }),
      }),
    ]);
    expect(scope.tools("fs")).toHaveLength(3);
  });

  it("applies includeTools and excludeTools", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [
        h.source({
          fs: h.stdio(files, {
            includeTools: ["read_*", "write_file"],
            excludeTools: ["write_*"],
          }),
        }),
      ],
    });
    await scope.connect("fs");
    expect(scope.tools("fs")?.map((t) => t.name)).toEqual(["read_file"]);
  });
});
