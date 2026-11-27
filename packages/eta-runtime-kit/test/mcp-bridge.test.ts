import type { HostTool, ServedMcpTools } from "@botiverse/oar";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { PassThrough } from "node:stream";
import { serveMcpTools } from "@botiverse/oar";
import { afterEach, describe, expect, it } from "vitest";
import {
  bridgeHttpMcpServer,
  bridgeStdioMcpServer,
  defaultMcpBridge,
  HOST_MCP_TOKEN_ENV,
  HOST_MCP_URL_ENV,
  MCP_HTTP_BRIDGE_PREFIX,
  MCP_STDIO_BRIDGE_PREFIX,
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
  }, 15_000);

  it("bridges --env-prefix HTTP mode with custom headers, case-insensitive dedup, and no Bearer requirement", async () => {
    const seenHeaders: Record<string, string>[] = [];
    const seenUrls: string[] = [];
    const fakeFetch: NonNullable<Parameters<typeof runMcpBridge>[0]>["fetch"] =
      async (input, init) => {
        seenUrls.push(String(input));
        seenHeaders.push(
          Object.fromEntries(
            Object.entries((init?.headers ?? {}) as Record<string, string>),
          ),
        );
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { ok: true },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "plugin-sess-1",
            },
          },
        );
      };

    const launcher = defaultMcpBridge();
    const bridged = bridgeHttpMcpServer(
      launcher,
      {
        name: "custom-http",
        url: "https://plugin.example/mcp",
        headers: {
          "X-API-Key": "first-secret-value",
          "x-api-key": "second-secret-value",
          "X-Empty": "",
          Accept: "application/json",
        },
      },
      0,
    );
    expect(bridged.server.args.slice(-2)).toEqual([
      "--env-prefix",
      `${MCP_HTTP_BRIDGE_PREFIX}0`,
    ]);

    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();
    const reader = createLineReader(output);

    const running = runMcpBridge({
      args: ["--env-prefix", `${MCP_HTTP_BRIDGE_PREFIX}0`],
      env: {
        [HOST_MCP_URL_ENV]: "http://127.0.0.1:1/host",
        [HOST_MCP_TOKEN_ENV]: "host-secret-must-not-leak",
        ...bridged.env,
      },
      input,
      output,
      error,
      fetch: fakeFetch,
    });

    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
    );
    expect(await reader.next()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
    input.end();
    expect(await running).toBe(0);

    expect(seenUrls).toEqual(["https://plugin.example/mcp"]);
    expect(seenHeaders[0]).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      "x-api-key": "second-secret-value",
      "x-empty": "",
    });
    expect(seenHeaders[0]).not.toHaveProperty("authorization");
  });

  it("forwards custom HTTP headers through spawned defaultMcpBridge() with --env-prefix", async () => {
    const receivedHeaders: Record<string, string | string[] | undefined>[] = [];
    const server = createServer((req, res) => {
      receivedHeaders.push({ ...req.headers });
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id?: number;
          method?: string;
        };
        if (req.headers["x-plugin-key"] !== "plugin-secret-value-12345") {
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("unauthorized");
          return;
        }
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "http-plugin-sess",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? null,
            result: { echoedMethod: body.method },
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    closers.push(
      async () =>
        await new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const addr = server.address();
    if (addr === null || typeof addr === "string")
      throw new Error("expected TCP address");

    const launcher = defaultMcpBridge();
    const bridged = bridgeHttpMcpServer(
      launcher,
      {
        name: "plugin-http",
        url: `http://127.0.0.1:${addr.port}/mcp`,
        headers: { "X-Plugin-Key": "plugin-secret-value-12345" },
      },
      2,
    );

    const child = spawn(bridged.server.command, [...bridged.server.args], {
      env: {
        ...process.env,
        [HOST_MCP_TOKEN_ENV]: "host-secret-token-99999",
        ...bridged.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const reader = createLineReader(child.stdout);

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`,
    );
    expect(await reader.next()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { echoedMethod: "initialize" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
    );
    expect(await reader.next()).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { echoedMethod: "tools/list" },
    });

    child.stdin.end();
    const code = await new Promise<number | null>((resolve) =>
      child.once("exit", resolve),
    );
    expect(code).toBe(0);
    expect(receivedHeaders).toHaveLength(2);
    expect(receivedHeaders[0]?.["x-plugin-key"]).toBe(
      "plugin-secret-value-12345",
    );
    expect(receivedHeaders[0]?.authorization).toBeUndefined();
    expect(receivedHeaders[1]?.["mcp-session-id"]).toBe("http-plugin-sess");
  }, 15_000);

  it("never prints secret values to stderr on missing bridge configuration", async () => {
    const error = new PassThrough();
    let stderr = "";
    error.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const code = await runMcpBridge({
      args: ["--env-prefix", "ETA_MCP_HTTP_0"],
      env: {
        ETA_MCP_HTTP_0_URL: "https://example.com/mcp",
        ETA_MCP_HTTP_0_HNAME_0: "X-Secret",
        ETA_MCP_HTTP_0_HVAL_0_SECRET: "super-secret-do-not-print",
        ETA_MCP_HTTP_0_HNAME_1: "X-Missing",
      },
      input: new PassThrough(),
      output: new PassThrough(),
      error,
    });
    expect(code).toBe(1);
    expect(stderr).toContain("ETA_MCP_HTTP_0_HVAL_1_SECRET");
    expect(stderr).not.toContain("super-secret-do-not-print");

    const execErr = new PassThrough();
    let execStderr = "";
    execErr.on("data", (chunk: Buffer) => {
      execStderr += chunk.toString("utf8");
    });
    const execCode = await runMcpBridge({
      args: [
        "exec",
        "--env-prefix",
        "ETA_MCP_STDIO_0",
        "--",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      env: {
        ETA_MCP_STDIO_0_ENAME_0: "GOOD",
        ETA_MCP_STDIO_0_EVAL_0_SECRET: "stdio-secret-do-not-print",
        ETA_MCP_STDIO_0_ENAME_1: "BROKEN",
      },
      error: execErr,
    });
    expect(execCode).toBe(1);
    expect(execStderr).toContain("ETA_MCP_STDIO_0_EVAL_1_SECRET");
    expect(execStderr).not.toContain("stdio-secret-do-not-print");
  });

  it("exec mode injects scoped env, preserves empty strings, strips bridge vars, isolates same-name plugins, and forwards args & exit code", async () => {
    const launcher = defaultMcpBridge();
    const dumpScript = [
      "const bridgeKeys = Object.keys(process.env).filter((k) => {",
      "  const u = k.toUpperCase();",
      "  return u.startsWith('ETA_HOST_MCP_') || u.startsWith('ETA_MCP_');",
      "});",
      "console.log(JSON.stringify({",
      "  token: process.env.SHARED_TOKEN,",
      "  emptyVal: process.env.EMPTY_VAR,",
      "  hasEmpty: Object.prototype.hasOwnProperty.call(process.env, 'EMPTY_VAR'),",
      "  normal: process.env.NORMAL_KEEP,",
      "  bridgeKeys,",
      "  argv: process.argv.slice(1),",
      "}));",
    ].join(" ");

    const pluginA = bridgeStdioMcpServer(
      launcher,
      {
        name: "plugin-a",
        command: process.execPath,
        args: ["-e", dumpScript, "--", "--env-prefix", "keep-arg", "--", "end"],
        env: {
          SHARED_TOKEN: "token-alpha-12345",
          EMPTY_VAR: "",
        },
      },
      0,
    );
    const pluginB = bridgeStdioMcpServer(
      launcher,
      {
        name: "plugin-b",
        command: process.execPath,
        args: ["-e", dumpScript, "--", "b-arg"],
        env: {
          SHARED_TOKEN: "token-beta-67890",
        },
      },
      1,
    );

    expect(pluginA.server.args).toContain(`${MCP_STDIO_BRIDGE_PREFIX}0`);
    expect(pluginB.server.args).toContain(`${MCP_STDIO_BRIDGE_PREFIX}1`);

    const sharedSessionEnv: Record<string, string | undefined> = {
      ...process.env,
      NORMAL_KEEP: "kept",
      [HOST_MCP_URL_ENV]: "http://127.0.0.1:9999/mcp",
      [HOST_MCP_TOKEN_ENV]: "host-token-secret-99999",
      ETA_MCP_HTTP_0_URL: "https://plugin.example/mcp",
      ETA_MCP_HTTP_0_HVAL_0_SECRET: "http-secret-88888",
      ...pluginA.env,
      ...pluginB.env,
    };

    const runSpawned = async (server: {
      command: string;
      args: readonly string[];
    }) => {
      const child = spawn(server.command, [...server.args], {
        env: sharedSessionEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const code = await new Promise<number | null>((resolve) =>
        child.once("close", resolve),
      );
      return { code, stdout: stdout.trim(), stderr };
    };

    const [resA, resB] = await Promise.all([
      runSpawned(pluginA.server),
      runSpawned(pluginB.server),
    ]);
    expect(resA.code).toBe(0);
    expect(resA.stderr).toBe("");
    const parsedA = JSON.parse(resA.stdout) as {
      token: string;
      emptyVal: string;
      hasEmpty: boolean;
      normal: string;
      bridgeKeys: string[];
      argv: string[];
    };
    expect(parsedA).toEqual({
      token: "token-alpha-12345",
      emptyVal: "",
      hasEmpty: true,
      normal: "kept",
      bridgeKeys: [],
      argv: ["--env-prefix", "keep-arg", "--", "end"],
    });

    expect(resB.code).toBe(0);
    expect(resB.stderr).toBe("");
    const parsedB = JSON.parse(resB.stdout) as {
      token: string;
      bridgeKeys: string[];
      argv: string[];
    };
    expect(parsedB.token).toBe("token-beta-67890");
    expect(parsedB.bridgeKeys).toEqual([]);
    expect(parsedB.argv).toEqual(["b-arg"]);

    // Non-zero exit code is forwarded verbatim.
    const exitCode = await runMcpBridge({
      args: [
        "exec",
        "--env-prefix",
        "ETA_MCP_STDIO_0",
        "--",
        process.execPath,
        "-e",
        "process.exit(42)",
      ],
      env: { ...process.env },
      output: new PassThrough(),
      error: new PassThrough(),
    });
    expect(exitCode).toBe(42);
  }, 15_000);

  it("exec mode forwards SIGTERM and SIGINT abort signals to the child process", async () => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const output = new PassThrough();
      let stdout = "";
      let ready!: () => void;
      const readyPromise = new Promise<void>((resolve) => {
        ready = resolve;
      });
      output.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.includes("READY")) ready();
      });

      const controller = new AbortController();
      const running = runMcpBridge({
        args: [
          "exec",
          "--env-prefix",
          "ETA_MCP_STDIO_0",
          "--",
          process.execPath,
          "-e",
          "console.log('READY'); setInterval(() => {}, 10_000);",
        ],
        env: { ...process.env },
        output,
        error: new PassThrough(),
        signal: controller.signal,
      });

      await readyPromise;
      controller.abort(signal);
      const code = await running;
      expect(code).toBe(signal === "SIGINT" ? 130 : 143);
    }
  });

  it.runIf(process.platform === "win32")(
    "exec mode launches Windows .cmd/.bat and extensionless PATH shims safely without shell injection",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "eta-mcp-bridge-win "));
      closers.push(async () => rmSync(dir, { recursive: true, force: true }));

      const dumpJs = join(dir, "dump.mjs");
      writeFileSync(
        dumpJs,
        [
          "const bridgeKeys = Object.keys(process.env).filter((k) => {",
          "  const u = k.toUpperCase();",
          "  return u.startsWith('ETA_HOST_MCP_') || u.startsWith('ETA_MCP_');",
          "});",
          "console.log(JSON.stringify({",
          "  argv: process.argv.slice(2),",
          "  apiKey: process.env.WIN_API_KEY,",
          "  emptyVar: process.env.WIN_EMPTY,",
          "  hasEmpty: Object.prototype.hasOwnProperty.call(process.env, 'WIN_EMPTY'),",
          "  bridgeKeys,",
          "}));",
        ].join("\n"),
      );

      // Simulate an npm/npx shim directory: both an extensionless Unix script and a .cmd shim.
      const bareShim = join(dir, "fake-npx");
      const cmdShim = join(dir, "fake-npx.cmd");
      writeFileSync(bareShim, "#!/bin/sh\necho should-not-run\n");
      writeFileSync(
        cmdShim,
        `@echo off\r\n"${process.execPath}" "${dumpJs}" %*\r\n`,
      );

      const nastyArgs = [
        "hello world",
        "a & echo PWNED",
        "b | echo PWNED",
        "%PATH%",
        'quote "inside"',
      ];

      // 1. Bare extensionless command resolved through PATH + PATHEXT to fake-npx.cmd.
      const pathKey =
        Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ??
        "PATH";
      const out1 = new PassThrough();
      let stdout1 = "";
      out1.on("data", (chunk: Buffer) => {
        stdout1 += chunk.toString("utf8");
      });
      const err1 = new PassThrough();
      let stderr1 = "";
      err1.on("data", (chunk: Buffer) => {
        stderr1 += chunk.toString("utf8");
      });
      const bridged1 = bridgeStdioMcpServer(
        defaultMcpBridge(),
        {
          name: "win-npx",
          command: "fake-npx",
          args: nastyArgs,
          env: { WIN_API_KEY: "win-secret-12345", WIN_EMPTY: "" },
        },
        0,
      );
      const code1 = await runMcpBridge({
        args: bridged1.server.args.slice(defaultMcpBridge().args?.length ?? 0),
        env: {
          ...process.env,
          [pathKey]: `${dir};${process.env[pathKey] ?? ""}`,
          [HOST_MCP_TOKEN_ENV]: "host-secret-must-strip",
          ...bridged1.env,
        },
        output: out1,
        error: err1,
      });
      expect(stderr1).toBe("");
      expect(code1).toBe(0);
      expect(stdout1.trim().split(/\r?\n/u)).toHaveLength(1);
      expect(JSON.parse(stdout1.trim())).toEqual({
        argv: nastyArgs,
        apiKey: "win-secret-12345",
        emptyVar: "",
        hasEmpty: true,
        bridgeKeys: [],
      });

      // 2. Direct .bat file path containing spaces.
      const batPath = join(dir, "my plugin.bat");
      writeFileSync(
        batPath,
        `@echo off\r\n"${process.execPath}" "${dumpJs}" %*\r\n`,
      );
      const out2 = new PassThrough();
      let stdout2 = "";
      out2.on("data", (chunk: Buffer) => {
        stdout2 += chunk.toString("utf8");
      });
      const code2 = await runMcpBridge({
        args: [
          "exec",
          "--env-prefix",
          "ETA_MCP_STDIO_0",
          "--",
          batPath,
          "arg & safe",
        ],
        env: {
          ...process.env,
          ETA_MCP_STDIO_0_ENAME_0: "WIN_API_KEY",
          ETA_MCP_STDIO_0_EVAL_0_SECRET: "bat-secret-67890",
        },
        output: out2,
        error: new PassThrough(),
      });
      expect(code2).toBe(0);
      expect(JSON.parse(stdout2.trim())).toMatchObject({
        argv: ["arg & safe"],
        apiKey: "bat-secret-67890",
        bridgeKeys: [],
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "exec mode ignores extensionless files in cwd and earlier PATH dirs and falls back when COMSPEC is empty",
    async () => {
      const rootDir = mkdtempSync(join(tmpdir(), "eta-mcp-bridge-win-shadow-"));
      closers.push(async () =>
        rmSync(rootDir, { recursive: true, force: true }),
      );

      const cwdDir = join(rootDir, "cwd");
      const earlierDir = join(rootDir, "earlier-path");
      const laterDir = join(rootDir, "later-path");
      mkdirSync(cwdDir);
      mkdirSync(earlierDir);
      mkdirSync(laterDir);

      const dumpJs = join(laterDir, "dump.mjs");
      writeFileSync(
        dumpJs,
        [
          "console.log(JSON.stringify({",
          "  argv: process.argv.slice(2),",
          "  apiKey: process.env.WIN_API_KEY,",
          "}));",
        ].join("\n"),
      );

      // Same-named extensionless files in cwd and an earlier PATH entry must not shadow later .cmd.
      writeFileSync(join(cwdDir, "mytool"), "#!/bin/sh\necho cwd-shadow\n");
      writeFileSync(
        join(earlierDir, "mytool"),
        "#!/bin/sh\necho earlier-path-shadow\n",
      );
      writeFileSync(
        join(laterDir, "mytool.cmd"),
        `@echo off\r\n"${process.execPath}" "${dumpJs}" %*\r\n`,
      );

      const pathKey =
        Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ??
        "PATH";
      const runWithEnv = async (injectedEnv: Record<string, string>) => {
        const bridged = bridgeStdioMcpServer(
          defaultMcpBridge(),
          {
            name: "win-shadow",
            command: "mytool",
            args: ["hello world", "a & b"],
            env: injectedEnv,
          },
          0,
        );
        const output = new PassThrough();
        let stdout = "";
        output.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        const error = new PassThrough();
        let stderr = "";
        error.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        const code = await runMcpBridge({
          args: bridged.server.args.slice(defaultMcpBridge().args?.length ?? 0),
          cwd: cwdDir,
          env: {
            ...process.env,
            [pathKey]: `${earlierDir};${laterDir};${process.env[pathKey] ?? ""}`,
            ...bridged.env,
          },
          output,
          error,
        });
        return { code, stdout: stdout.trim(), stderr };
      };

      const shadowed = await runWithEnv({ WIN_API_KEY: "shadow-secret-12345" });
      expect(shadowed.stderr).toBe("");
      expect(shadowed.code).toBe(0);
      expect(JSON.parse(shadowed.stdout)).toEqual({
        argv: ["hello world", "a & b"],
        apiKey: "shadow-secret-12345",
      });

      const emptyComspec = await runWithEnv({
        WIN_API_KEY: "empty-comspec-secret",
        COMSPEC: "",
      });
      expect(emptyComspec.stderr).toBe("");
      expect(emptyComspec.code).toBe(0);
      expect(JSON.parse(emptyComspec.stdout)).toEqual({
        argv: ["hello world", "a & b"],
        apiKey: "empty-comspec-secret",
      });
    },
  );
});
