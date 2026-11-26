import type { HostTool, ServedMcpTools } from "@botiverse/oar";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import process from "node:process";
import { PassThrough } from "node:stream";
import { serveMcpTools } from "@botiverse/oar";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultMcpBridge,
  HOST_MCP_TOKEN_ENV,
  HOST_MCP_URL_ENV,
  runMcpBridge,
} from "../src/index";

function createLineReader(stream: NodeJS.ReadableStream) {
  const queue: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let buffer = "";
  stream.on("data", (chunk: string | Buffer) => {
    buffer +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl).replace(/\r$/u, "");
      buffer = buffer.slice(nl + 1);
      if (line === "") continue;
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(line);
      else queue.push(line);
    }
  });
  return {
    next: async <T = Record<string, unknown>>(timeoutMs = 5000): Promise<T> => {
      const queued = queue.shift();
      if (queued !== undefined) return JSON.parse(queued) as T;
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for bridge output line")),
          timeoutMs,
        );
        waiters.push((line) => {
          clearTimeout(timer);
          resolve(JSON.parse(line) as T);
        });
      });
    },
  };
}

function authEnvOf(served: ServedMcpTools) {
  const auth = served.server.headers?.Authorization ?? "";
  const token = auth.replace(/^Bearer\s+/iu, "");
  return {
    [HOST_MCP_URL_ENV]: served.server.url,
    [HOST_MCP_TOKEN_ENV]: token,
  };
}

describe("stdio ↔ HTTP MCP bridge", () => {
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  const serve = async (tools: HostTool[]) => {
    const served = await serveMcpTools({ name: "eta", tools });
    closers.push(() => served.close());
    return served;
  };

  it("bridges initialize, 202 notifications, tools/list, tools/call, and cancellation with mcp-session-id", async () => {
    let aborted = false;
    let slowStarted!: () => void;
    const slowReady = new Promise<void>((resolve) => {
      slowStarted = resolve;
    });
    const served = await serve([
      {
        name: "echo",
        description: "Echo text back",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        handler: async (args) => `You said: ${String(args.text)}`,
      },
      {
        name: "slow",
        description: "Wait until cancelled",
        inputSchema: { type: "object", properties: {} },
        handler: async (_args, { signal }) => {
          slowStarted();
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              aborted = true;
              resolve();
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            );
          });
          return "cancelled";
        },
      },
    ]);

    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();
    const reader = createLineReader(output);
    let stderr = "";
    error.on("data", (chunk: string | Buffer) => {
      stderr +=
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    });

    const running = runMcpBridge({
      env: authEnvOf(served),
      input,
      output,
      error,
    });

    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      })}\n`,
    );
    const initReply = await reader.next<{
      id: number;
      result: { serverInfo: { name: string } };
    }>();
    expect(initReply.id).toBe(1);
    expect(initReply.result.serverInfo.name).toBe("eta");

    // 202 notification produces zero stdout output, then tools/list uses captured mcp-session-id.
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
    );
    const listReply = await reader.next<{
      id: number;
      result: { tools: { name: string }[] };
    }>();
    expect(listReply.id).toBe(2);
    expect(listReply.result.tools.map((tool) => tool.name)).toEqual([
      "echo",
      "slow",
    ]);

    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hello" } },
      })}\n`,
    );
    const callReply = await reader.next<{
      id: number;
      result: { content: { type: string; text: string }[] };
    }>();
    expect(callReply.id).toBe(3);
    expect(callReply.result.content).toEqual([
      { type: "text", text: "You said: hello" },
    ]);

    // In-flight slow tool is aborted by notifications/cancelled sharing the same mcp-session-id.
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "slow", arguments: {} },
      })}\n`,
    );
    await slowReady;
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 4 },
      })}\n`,
    );
    const slowReply = await reader.next<{
      id: number;
      result: { content: { text: string }[] };
    }>();
    expect(slowReply.id).toBe(4);
    expect(aborted).toBe(true);

    input.end();
    expect(await running).toBe(0);
    expect(stderr).toBe("");
  });

  it("exits 1 with diagnostic on stderr when URL or token is missing", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();
    let stdout = "";
    let stderr = "";
    output.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    error.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    expect(await runMcpBridge({ env: {}, input, output, error })).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain(HOST_MCP_URL_ENV);

    expect(
      await runMcpBridge({
        env: { [HOST_MCP_URL_ENV]: "http://127.0.0.1:1/mcp" },
        input: new PassThrough(),
        output: new PassThrough(),
        error: new PassThrough(),
      }),
    ).toBe(1);
  });

  it("handles HTTP 401 and malformed JSON without losing framing on later requests", async () => {
    const served = await serve([
      {
        name: "ping_tool",
        inputSchema: { type: "object", properties: {} },
        handler: () => "pong",
      },
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();
    const reader = createLineReader(output);

    const running = runMcpBridge({
      env: {
        [HOST_MCP_URL_ENV]: served.server.url,
        [HOST_MCP_TOKEN_ENV]: "wrong-token",
      },
      input,
      output,
      error,
    });

    input.write("{not valid json\n");
    const parseErr = await reader.next<{
      id: null;
      error: { code: number; message: string };
    }>();
    expect(parseErr.id).toBeNull();
    expect(parseErr.error.code).toBe(-32700);

    // Failed notification emits nothing to stdout; failed request gets a JSON-RPC error with its id.
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" })}\n`,
    );
    const authErr = await reader.next<{
      id: number;
      error: { code: number; message: string };
    }>();
    expect(authErr.id).toBe(9);
    expect(authErr.error.message).toContain("401");

    input.end();
    expect(await running).toBe(0);
  });

  it("forwards SSE 200 responses as newline-delimited JSON-RPC", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();
    const reader = createLineReader(output);

    const fakeFetch: NonNullable<Parameters<typeof runMcpBridge>[0]>["fetch"] =
      async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(
              encoder.encode(
                'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"sse":true}}\n\n',
              ),
            );
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "mcp-session-id": "sse-sess-1",
          },
        });
      };

    const running = runMcpBridge({
      env: {
        [HOST_MCP_URL_ENV]: "http://127.0.0.1:9999/mcp",
        [HOST_MCP_TOKEN_ENV]: "tok",
      },
      input,
      output,
      error,
      fetch: fakeFetch,
    });

    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" })}\n`,
    );
    expect(await reader.next()).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { sse: true },
    });
    input.end();
    expect(await running).toBe(0);
  });

  it("waits for in-flight requests on stdin EOF before returning", async () => {
    const served = await serve([
      {
        name: "delayed",
        inputSchema: { type: "object", properties: {} },
        handler: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return "finished";
        },
      },
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const reader = createLineReader(output);
    const running = runMcpBridge({
      env: authEnvOf(served),
      input,
      output,
      error: new PassThrough(),
    });

    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      })}\n`,
    );
    await reader.next();

    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "delayed", arguments: {} },
      })}\n`,
    );
    input.end();

    expect(await running).toBe(0);
    expect(await reader.next()).toMatchObject({
      id: 2,
      result: { content: [{ type: "text", text: "finished" }] },
    });
  });

  it("runs as a spawned child process via defaultMcpBridge() and exits 0 on stdin EOF", async () => {
    const served = await serve([
      {
        name: "greet",
        inputSchema: {
          type: "object",
          properties: { who: { type: "string" } },
        },
        handler: async (args) => `hi ${String(args.who)}`,
      },
    ]);
    const launcher = defaultMcpBridge();
    const child = spawn(launcher.command, [...(launcher.args ?? [])], {
      env: { ...process.env, ...authEnvOf(served) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const reader = createLineReader(child.stdout);

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "child-test", version: "1.0.0" },
        },
      })}\n`,
    );
    expect((await reader.next<{ id: number }>()).id).toBe(1);

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
    );
    expect(
      (
        await reader.next<{
          id: number;
          result: { tools: { name: string }[] };
        }>()
      ).result.tools.map((tool) => tool.name),
    ).toEqual(["greet"]);

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "greet", arguments: { who: "Antigravity" } },
      })}\n`,
    );
    expect(await reader.next()).toMatchObject({
      id: 3,
      result: { content: [{ type: "text", text: "hi Antigravity" }] },
    });

    child.stdin.end();
    const code = await new Promise<number | null>((resolve) =>
      child.once("exit", resolve),
    );
    expect(code).toBe(0);
  });
});
