import type { McpToolResult } from "../src/types";
/**
 * Direct tools (visible from the cache, started on first call) and the background warm-up.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDirectTools } from "../src";
import { McpManager } from "../src/manager";
import { startFakeHttp } from "./helpers/fake-http";
import { cleanupAll, setup, tool } from "./helpers/harness";

afterEach(cleanupAll);

function text(result: McpToolResult): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

const files = {
  tools: [
    tool("read_file", {
      description: "Read a file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      behavior: "echo",
    }),
    tool("write-file", { description: "Write a file", behavior: "echo" }),
    tool("secret", { description: "Not for the model" }),
  ],
};

describe("direct tools", () => {
  it("are defined from the cache with no server running, and the first call starts it", async () => {
    const first = await setup();
    const sources = [
      first.source({
        fs: first.stdio(files, { directTools: true, excludeTools: ["secret"] }),
      }),
    ];
    await first.manager.scope({ owner: "a", sources }).connect("fs");
    await first.manager.closeAll();
    const startsBefore = first.starts();

    const second = new McpManager({
      cacheFile: `${first.dir}/cache.json`,
      outputDir: `${first.dir}/outputs`,
      checkIntervalMs: 0,
      resolvers: false,
    });
    try {
      const scope = second.scope({ owner: "a", sources });
      const tools = createDirectTools(scope);
      expect(tools.map((t) => t.name)).toEqual([
        "mcp__fs__read_file",
        "mcp__fs__write-file",
      ]);
      expect(tools[0]).toMatchObject({
        description: "Read a file",
        parameters: { type: "object", required: ["path"] },
      });
      expect(first.starts()).toBe(startsBefore);
      expect(second.servers.get("a", "fs")).toBeUndefined();

      const result = await tools[0]!.execute({ path: "/x" });
      expect(text(result)).toBe('{"path":"/x"}');
      expect(result.details).toMatchObject({
        server: "fs",
        tool: "read_file",
        name: "mcp__fs__read_file",
      });
      expect(first.starts()).toBe(startsBefore + 1);
    } finally {
      await second.closeAll();
    }
  });

  it("can be limited to named tools, folding hyphens and underscores", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [
        h.source({ fs: h.stdio(files, { directTools: ["write_file"] }) }),
      ],
    });
    await scope.connect("fs");
    expect(createDirectTools(scope).map((t) => t.name)).toEqual([
      "mcp__fs__write-file",
    ]);
  });

  it("leave out servers that are not asked for, disabled, or unknown", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [
        h.source({
          plain: h.stdio(files),
          off: h.stdio(files, { directTools: true, disabled: true }),
          fresh: h.stdio(files, { directTools: true }),
        }),
      ],
    });
    await scope.connect("plain");
    expect(createDirectTools(scope)).toEqual([]);
  });

  it("skip names the caller already has", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [h.source({ fs: h.stdio(files, { directTools: true }) })],
    });
    await scope.connect("fs");
    const names = createDirectTools(scope, {
      reserved: new Set(["mcp__fs__secret"]),
    }).map((t) => t.name);
    expect(names).toEqual(["mcp__fs__read_file", "mcp__fs__write-file"]);
  });

  it("drop a name two servers would share instead of picking one", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [
        h.source({
          "a.b": h.stdio({ tools: [tool("t")] }, { directTools: true }),
          a_b: h.stdio({ tools: [tool("t")] }, { directTools: true }),
        }),
      ],
    });
    await scope.connect("a.b");
    await scope.connect("a_b");
    expect(createDirectTools(scope)).toEqual([]);
  });

  it("keep names within 64 characters, distinct", async () => {
    const h = await setup();
    const long = "x".repeat(70);
    const scope = h.manager.scope({
      owner: "a",
      sources: [
        h.source({
          s: h.stdio(
            { tools: [tool(`${long}1`), tool(`${long}2`)] },
            { directTools: true },
          ),
        }),
      ],
    });
    await scope.connect("s");
    const names = createDirectTools(scope).map((t) => t.name);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(
      names.every((name) => name.length <= 64 && /^[\w-]+$/.test(name)),
    ).toBe(true);
  });

  it("go through approval and the veto hook like any call", async () => {
    const h = await setup();
    const seen: string[] = [];
    const scope = h.manager.scope({
      owner: "a",
      sources: [
        h.source({
          fs: h.stdio(files, {
            directTools: true,
            approveTools: ["write-file"],
          }),
        }),
      ],
      hooks: {
        onToolCall: (call) => {
          seen.push(call.name);
        },
        approve: async () => false,
      },
    });
    await scope.connect("fs");
    const [read, write] = createDirectTools(scope);
    expect(text(await read!.execute({ path: "/a" }))).toBe('{"path":"/a"}');
    const denied = await write!.execute({});
    expect(denied.details).toMatchObject({ error: "approval_denied" });
    expect(seen).toEqual(["mcp__fs__read_file", "mcp__fs__write-file"]);
  });

  it("accept arguments as a JSON string, and reject ones that fit no schema", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [h.source({ fs: h.stdio(files, { directTools: true }) })],
    });
    await scope.connect("fs");
    const [read] = createDirectTools(scope);
    expect(text(await read!.execute('{"path":"/s"}'))).toBe('{"path":"/s"}');
    const bad = await read!.execute({ path: 1 });
    expect(bad.details).toMatchObject({
      error: "call_failed",
      delivery: "not_sent",
    });
    const notObject = await read!.execute("[1]");
    expect(notObject.isError).toBe(true);
  });
});

describe("warm-up", () => {
  it("reads the tools of servers with no cache, closes lazy ones again, and tells the scope", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [
        h.source({
          lazy: h.stdio(files, { directTools: true }),
          sticky: h.stdio(files, { lifecycle: "lazy-keep-alive" }),
          forever: h.stdio(files, { idleTimeout: 0 }),
        }),
      ],
    });
    expect(createDirectTools(scope)).toEqual([]);
    let updates = 0;
    scope.onUpdated(() => {
      updates++;
    });

    const result = await scope.warmUp();
    expect(result.discovered.sort()).toEqual(["forever", "lazy", "sticky"]);
    expect(result.failed).toEqual({});
    expect(h.starts()).toBe(3);
    expect(updates).toBeGreaterThan(0);
    // Plain lazy servers stop as soon as their tools are read; the others stay.
    expect(h.manager.servers.get("a", "lazy")).toBeUndefined();
    expect(h.manager.servers.get("a", "sticky")?.status).toBe("connected");
    expect(h.manager.servers.get("a", "forever")?.status).toBe("connected");
    // The direct tools are there now, and so is offline search.
    expect(createDirectTools(scope).map((t) => t.name)).toContain(
      "mcp__lazy__read_file",
    );
    expect(scope.tools("lazy")).toHaveLength(3);
  });

  it("does not touch servers whose cache is valid", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [h.source({ s: h.stdio(files) })],
    });
    await scope.warmUp();
    expect(h.starts()).toBe(1);
    const again = await scope.warmUp();
    expect(again.discovered).toEqual([]);
    expect(h.starts()).toBe(1);
  });

  it("starts a bounded number of servers at once", async () => {
    const h = await setup();
    const servers = Object.fromEntries(
      Array.from({ length: 7 }, (_, index) => [`s${index}`, h.stdio(files)]),
    );
    const scope = h.manager.scope({ owner: "a", sources: [h.source(servers)] });
    const original = h.manager.servers.connect.bind(h.manager.servers);
    let active = 0;
    let peak = 0;
    vi.spyOn(h.manager.servers, "connect").mockImplementation(
      async (...args) => {
        active++;
        peak = Math.max(peak, active);
        try {
          return await original(...args);
        } finally {
          active--;
        }
      },
    );
    const result = await scope.warmUp({ concurrency: 3 });
    expect(result.discovered).toHaveLength(7);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("tries a failing server once per config, and a retry needs a config change", async () => {
    const h = await setup();
    const broken = h.stdio(
      files,
      {},
      { FAKE_MCP_FAIL: "1", FAKE_MCP_STDERR: "cannot start" },
    );
    const scope = h.manager.scope({
      owner: "a",
      sources: [h.source({ ok: h.stdio(files), broken })],
    });
    const result = await scope.warmUp();
    expect(result.discovered).toEqual(["ok"]);
    expect(result.failed.broken).toContain("cannot start");
    expect(h.starts()).toBe(2);

    const again = await scope.warmUp();
    expect(again).toEqual({ discovered: [], failed: {}, needsAuth: [] });
    expect(h.starts()).toBe(2);

    // The failure does not block an explicit use...
    expect((await scope.connect("broken")).ok).toBe(false);
    expect(h.starts()).toBe(3);

    // ...and a changed config is tried again.
    scope.setSources([
      h.source({
        ok: h.stdio(files),
        broken: h.stdio(files, {}, { FAKE_MCP_FAIL: "1", CHANGED: "1" }),
      }),
    ]);
    await scope.warmUp();
    expect(h.starts()).toBe(4);
  });

  it("reports servers that need sign-in without caching or failing them", async () => {
    const h = await setup();
    const http = await startFakeHttp({ spec: files, bearer: "x" });
    try {
      const scope = h.manager.scope({
        owner: "a",
        sources: [h.source({ remote: { url: http.url } })],
      });
      const result = await scope.warmUp();
      expect(result).toEqual({
        discovered: [],
        failed: {},
        needsAuth: ["remote"],
      });
      expect(scope.status()[0]?.state).toBe("needs-auth");
    } finally {
      await h.manager.closeAll();
      await http.close();
    }
  });

  it("stops when aborted", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [h.source({ a: h.stdio(files), b: h.stdio(files) })],
    });
    const controller = new AbortController();
    controller.abort();
    const result = await scope.warmUp({ signal: controller.signal });
    expect(result.discovered).toEqual([]);
    expect(h.starts()).toBe(0);
  });
});
