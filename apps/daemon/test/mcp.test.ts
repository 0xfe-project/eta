import type { KernelTool } from "@eta/core";
import type { McpServerConfig } from "../src/mcp";
import type { FakeHttp } from "./fixtures/fake-mcp-http";
import { fileURLToPath } from "node:url";
import { fakeModels } from "@eta/core/testing";
import { MemorySessionStore, SessionManager } from "@eta/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpSessionTools, openMcp } from "../src/mcp";
import { fakeMcpHttp } from "./fixtures/fake-mcp-http";

// A child process starting under a loaded machine (the whole repo's tests at once) is slow.
vi.setConfig({ testTimeout: 30_000 });

const script = fileURLToPath(
  new URL("./fixtures/fake-mcp-stdio.ts", import.meta.url),
);
const stdio: McpServerConfig = {
  name: "fake",
  command: process.execPath,
  args: [script],
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(predicate: () => boolean, timeoutMs = 10_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const call = (
  tool: KernelTool | undefined,
  args: unknown = {},
  signal?: AbortSignal,
) =>
  tool!.execute(args, {
    turn: 0,
    toolCallId: "c1",
    ...(signal === undefined ? {} : { signal }),
  }) as Promise<{
    content: { type: string; text?: string }[];
    isError?: boolean;
    details?: unknown;
  }>;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

let http: FakeHttp | undefined;
async function httpConfig(): Promise<McpServerConfig> {
  http = await fakeMcpHttp();
  closers.push(http.close);
  return { name: "web", url: http.url, headers: { "x-key": "secret" } };
}

describe.each([
  ["stdio", async () => stdio],
  ["streamable HTTP", httpConfig],
])("an MCP server over %s", (_name, config) => {
  const open = async () => {
    const connections = await openMcp([await config()]);
    closers.push(connections.close);
    const tool = (name: string) =>
      connections.tools.find((t) => t.name.endsWith(`__${name}`));
    return { connections, tool };
  };

  it("lists its tools under the server's name and calls them, with _meta passed through", async () => {
    const { connections, tool } = await open();
    expect(connections.tools.map((t) => t.name)).toContain(
      `${tool("echo")!.name.split("__")[0]}__echo`,
    );
    expect(tool("echo")).toMatchObject({ description: "Say it back" });
    const result = await call(tool("echo"), { text: "hi" });
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
    expect(result.details).toEqual({ _meta: { "axp/ref": "r1" } });
  });

  it("reports an error result and a thrown error as errors the model can read", async () => {
    const { tool } = await open();
    const failed = await call(tool("fail"));
    expect(failed).toMatchObject({ isError: true });
    expect(failed.content[0]?.text).toBe("it failed");
    const exploded = await call(tool("explode"));
    expect(exploded.isError).toBe(true);
    expect(exploded.content[0]?.text).toContain("exploded");
  });

  it("stops a call that is aborted, and tells the server", async () => {
    const { tool } = await open();
    const controller = new AbortController();
    const pending = call(tool("hang"), {}, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    if (http !== undefined) await until(() => http!.cancelled() === 1);
  });
});

describe("the MCP glue", () => {
  it("sends the configured headers", async () => {
    const config = await httpConfig();
    const connections = await openMcp([config]);
    closers.push(connections.close);
    expect(http!.headers.every((h) => h["x-key"] === "secret")).toBe(true);
    expect(http!.headers.length).toBeGreaterThan(0);
  });

  it("answers a server's question with cancel", async () => {
    const connections = await openMcp([stdio]);
    closers.push(connections.close);
    const asked = await call(
      connections.tools.find((t) => t.name === "fake__ask"),
    );
    expect(asked.content[0]?.text).toBe("elicit:cancel");
  });

  it("leaves out a server it cannot reach and keeps the others", async () => {
    const warnings: string[] = [];
    const connections = await openMcp(
      [
        { name: "gone", command: "/nonexistent/mcp-server" },
        { name: "dead", url: "http://127.0.0.1:1/mcp" },
        stdio,
      ],
      (message) => warnings.push(message),
    );
    closers.push(connections.close);
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toContain("gone");
    expect(connections.tools.every((t) => t.name.startsWith("fake__"))).toBe(
      true,
    );
    expect(connections.tools.length).toBeGreaterThan(0);
  });

  it("ends the child process when its connections close", async () => {
    const connections = await openMcp([stdio]);
    const pid = Number(
      (await call(connections.tools.find((t) => t.name === "fake__pid")))
        .content[0]?.text,
    );
    expect(alive(pid)).toBe(true);
    await connections.close();
    await until(() => !alive(pid));
  });
});

describe("a session with MCP servers", () => {
  it("gets the tools, and loses the child when the session closes", async () => {
    const mcp = mcpSessionTools((meta) =>
      meta.agentId === undefined ? [] : [stdio],
    );
    const sessions = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => fakeModels([]) as never,
      sessionTools: mcp.sessionTools,
    });
    const bare = await sessions.create({ cwd: "/work" });
    const agent = await sessions.create({ cwd: "/work", agentId: "a" });
    await mcp.settled(agent.meta.id);
    expect(bare.session.kernel.tools.get("fake__echo")).toBeUndefined();
    const active = agent.session.kernel.config.read("activeToolNames");
    expect(active).toContain("fake__echo");
    const pid = Number(
      (await call(agent.session.kernel.tools.get("fake__pid"))).content[0]
        ?.text,
    );
    expect(alive(pid)).toBe(true);
    await sessions.closeAll();
    await until(() => !alive(pid));
  });
});
