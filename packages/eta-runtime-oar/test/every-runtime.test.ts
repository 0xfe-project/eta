/**
 * Every runtime eta offers, under its own id, on oar's scripted runtime: the paths that differ by
 * runtime (how a host tool is spelled back, whether a system prompt is taken) meet the same
 * session semantics as a real one, for a runtime that is not installed or signed in here. Where
 * the real runtime refuses an option, the scripted one is given the same refusal.
 */
import type { Runtime } from "@botiverse/oar";
import type { ScriptedTurn } from "@botiverse/oar/testing";
import type { AgentMessage, KernelTool } from "@eta/core";
import type { ManagedSession } from "@eta/server";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import process from "node:process";
import {
  antigravityRuntime,
  createRuntimeRegistry,
  ResumeCwdError,
  UnsupportedOptionError,
} from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import {
  HOST_MCP_TOKEN_ENV,
  HOST_MCP_URL_ENV,
  MCP_HTTP_BRIDGE_PREFIX,
  MCP_STDIO_BRIDGE_PREFIX,
} from "@eta/runtime-kit";
import { MemorySessionStore, SessionManager } from "@eta/server";
import { describe, expect, it } from "vitest";
import { createOarRuntimes, RUNTIME_IDS } from "../src/index";

const tick = async (ms = 20) =>
  await new Promise((resolve) => setTimeout(resolve, ms));

const textOf = (message: AgentMessage): string =>
  "content" in message && Array.isArray(message.content)
    ? message.content
        .map((block) =>
          block.type === "text"
            ? block.text
            : block.type === "toolCall"
              ? `[${block.name}]`
              : "",
        )
        .join("")
    : "";

/** How each runtime names a host tool in its events; Codex names it only in its native frame. */
const SPELLED: Record<string, string> = {
  claude: "mcp__eta__echo",
  pi: "mcp__eta__echo",
  opencode: "eta_echo",
  antigravity: "mcp_eta_echo",
};

/** The runtimes that call every MCP tool through one tool of their own, and what it answers. */
const GATEWAY: Record<
  string,
  { tool: string; input: string; answer: unknown }
> = {
  grok: {
    tool: "use_tool",
    input: JSON.stringify({ tool_name: "eta__echo", tool_input: {} }),
    answer: {
      type: "MCP",
      tool_name: "echo",
      server_name: "eta",
      output: { OkayOutput: "echoed" },
    },
  },
};

/** The scripted runtime under a real one's refusals. */
function asReal(id: string, scripted: Runtime): Runtime {
  if (id === "antigravity")
    return {
      ...scripted,
      refusedSessionOptions: antigravityRuntime.refusedSessionOptions,
      manualCompaction: antigravityRuntime.manualCompaction,
      session: async (installation, options, context) => {
        for (const server of options.mcpServers ?? []) {
          const creds = "type" in server ? server.headers : server.env;
          if (creds !== undefined && Object.keys(creds).length > 0)
            throw new UnsupportedOptionError(
              "mcpServers",
              "antigravity refuses MCP entries with credentials",
            );
        }
        return await scripted.session(installation, options, context);
      },
    };
  if (id === "grok")
    return {
      ...scripted,
      // Grok Build keeps a conversation's appended prompt and refuses it given again on resume.
      session: async (installation, options) => {
        if (
          options.resume !== undefined &&
          options.appendSystemPrompt !== undefined
        )
          throw new UnsupportedOptionError(
            "appendSystemPrompt",
            "Grok does not reapply appendSystemPrompt alone on resume",
          );
        return await scripted.session(installation, options);
      },
    };
  return scripted;
}

const echo = {
  name: "echo",
  description: "echo",
  parameters: { type: "object", properties: {} },
  execute: () => ({ content: [{ type: "text", text: "echoed" }] }),
} as unknown as KernelTool;

async function turnOf(turn: ScriptedTurn, id: string): Promise<void> {
  if (turn.input.includes("wait")) {
    await new Promise((resolve) =>
      turn.signal.addEventListener("abort", resolve, { once: true }),
    );
    return;
  }
  if (turn.input.includes("steer me")) {
    for (let i = 0; i < 100 && turn.steered.length === 0; i++) await tick(10);
    turn.say(`heard ${turn.steered.join(",")}`);
    return;
  }
  if (turn.input.includes("tool") && SPELLED[id] !== undefined) {
    await turn.tool(SPELLED[id], "{}", () => "echoed");
    turn.say("used it");
    return;
  }
  const gateway = GATEWAY[id];
  if (turn.input.includes("tool") && gateway !== undefined) {
    await turn.tool(gateway.tool, gateway.input, () => gateway.answer);
    turn.say("used it");
    return;
  }
  turn.say(`ok ${turn.input.split("\n").at(-1)}`);
}

async function run(managed: ManagedSession, prompt: string) {
  managed.session.kernel.nextRun(prompt);
  return await managed.session.runner.run();
}

describe.each(RUNTIME_IDS)("%s, scripted", (id) => {
  it("replies, calls a host tool, steers, stops and resumes", async () => {
    const turns: ScriptedTurn[] = [];
    const runtime = asReal(
      id,
      scriptedRuntime({
        id,
        turn: async (turn) => {
          turns.push(turn);
          await turnOf(turn, id);
        },
      }),
    );
    const manager = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => {
        throw new Error("an eta model was asked for");
      },
      runtimes: createOarRuntimes({
        registry: createRuntimeRegistry([runtime]),
      }),
      agentPromptFor: () => "You are Probe.",
      sessionTools: () => [echo],
    });
    const created = await manager.create({ cwd: "/work", runtime: id });
    const transcript = (managed: ManagedSession) =>
      managed.session.journaling
        .transcript()
        .map((message) => `${message.role}:${textOf(message)}`);

    expect((await run(created, "hello")).status).toBe("completed");
    expect(turns[0]!.options.appendSystemPrompt).toContain("You are Probe.");
    expect(turns[0]!.options.mcpServers).toHaveLength(1);
    if (id === "antigravity") {
      expect(turns[0]!.options.mcpServers?.[0]).not.toHaveProperty("env");
      expect(turns[0]!.options.env).toMatchObject({
        [HOST_MCP_URL_ENV]: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
        [HOST_MCP_TOKEN_ENV]: expect.any(String),
      });
    }

    if (SPELLED[id] !== undefined || GATEWAY[id] !== undefined) {
      expect((await run(created, "use the tool")).status).toBe("completed");
      // The host's tool is told back under the host's name, whatever the runtime called it.
      expect(transcript(created)).toContain("assistant:[echo]");
      expect(transcript(created)).toContain("toolResult:echoed");
    }

    const steering = run(created, "steer me");
    await tick(50);
    created.session.kernel.steer("now");
    expect((await steering).status).toBe("completed");
    expect(transcript(created).at(-1)).toBe("assistant:heard now");

    const waiting = run(created, "wait");
    await tick(50);
    created.session.runner.abort();
    expect((await waiting).status).toBe("aborted");
    expect((await run(created, "after the stop")).status).toBe("completed");

    const native = created.meta.runtimeSession;
    expect(native).toBeDefined();
    const heard = transcript(created);
    await manager.close(created.meta.id);
    const reopened = (await manager.session(created.meta.id))!;
    expect((await run(reopened, "again")).status).toBe("completed");
    expect(turns.at(-1)!.options.resume).toBe(native);
    // Grok keeps the prompt it was opened with; the others are told it again.
    expect(turns.at(-1)!.options.appendSystemPrompt).toBe(
      id === "grok" ? undefined : turns[0]!.options.appendSystemPrompt,
    );
    // The journal survives the close: the reopened session holds everything heard before.
    expect(transcript(reopened)).toEqual([
      ...heard,
      "user:again",
      "assistant:ok again",
    ]);
    await manager.closeAll();
  });
});

describe("the catalog's reading of Grok Build's sign-in", () => {
  /** Grok lists its built-in models signed out too: only its sign-in query tells. */
  const grok = (kind: "logged_in" | "logged_out" | "unknown"): Runtime => ({
    ...scriptedRuntime({ id: "grok", turn: (turn) => turn.say("ok") }),
    listModels: async () => ({
      kind: "ok" as const,
      models: [{ id: "grok-4.6", default: true }],
    }),
    authStatus: async () =>
      kind === "logged_in"
        ? { kind, source: "grok models", account: { method: "api_key" } }
        : { kind, source: "grok models" },
  });
  const statusOf = async (runtime: Runtime) => {
    const { catalog } = createOarRuntimes({
      registry: createRuntimeRegistry([runtime]),
    });
    return (await catalog.list(true)).find((info) => info.id === "grok");
  };

  it("is not signed in when it says it is logged out", async () => {
    expect(await statusOf(grok("logged_out"))).toMatchObject({
      status: "unauthenticated",
      detail: "is not signed in",
      models: [{ id: "grok-4.6" }],
    });
  });

  it("is available when it is logged in, or cannot tell", async () => {
    expect((await statusOf(grok("logged_in")))?.status).toBe("available");
    expect((await statusOf(grok("unknown")))?.status).toBe("available");
  });
});

async function callViaBridge(
  server: { command: string; args?: readonly string[] },
  env: Readonly<Record<string, string | null | undefined>> | undefined,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === null) delete childEnv[key];
    else if (value !== undefined) childEnv[key] = value;
  }
  const child = spawn(server.command, [...(server.args ?? [])], {
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: Record<string, unknown>[] = [];
  const waiters: ((msg: Record<string, unknown>) => void)[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  child.stdout.on("data", (chunk: Uint8Array) => {
    buffer += decoder.decode(chunk, { stream: true });
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === "") continue;
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(parsed);
      else lines.push(parsed);
    }
  });
  const next = async () =>
    lines.shift() ??
    (await new Promise<Record<string, unknown>>((resolve) =>
      waiters.push(resolve),
    ));
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "agy", version: "1.5.16" },
      },
    })}\n`,
  );
  await next();
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: tool, arguments: args },
    })}\n`,
  );
  const reply = (await next()) as {
    result: { content: { text: string }[] };
  };
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  return reply.result.content.map((part) => part.text).join("");
}

describe("a runtime that refuses MCP credentials (Antigravity)", () => {
  it("delivers host tools via credential-free stdio bridge + SessionOptions.env and strips undeclared toolSummary", async () => {
    const turns: ScriptedTurn[] = [];
    const seenArgs: unknown[] = [];
    const strictEcho = {
      name: "strict_echo",
      description: "Strict echo",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      execute: (args: Record<string, unknown>) => {
        seenArgs.push(args);
        if ("toolSummary" in args)
          return {
            content: [{ type: "text", text: "unexpected toolSummary" }],
            isError: true,
          };
        return {
          content: [{ type: "text", text: `strict:${String(args.text)}` }],
          details: { echoed: args.text },
        };
      },
    } as unknown as KernelTool;

    const manager = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => {
        throw new Error("an eta model was asked for");
      },
      runtimes: createOarRuntimes({
        registry: createRuntimeRegistry([
          asReal(
            "antigravity",
            scriptedRuntime({
              id: "antigravity",
              turn: async (turn) => {
                turns.push(turn);
                const server = turn.options.mcpServers?.find(
                  (entry) => entry.name === "eta",
                );
                if (server === undefined || "type" in server)
                  throw new Error("expected credential-free stdio eta server");
                await turn.tool(
                  "mcp_eta_strict_echo",
                  JSON.stringify({ text: "hi", toolSummary: "Echo hi" }),
                  async () =>
                    await callViaBridge(
                      server,
                      turn.options.env,
                      "strict_echo",
                      { text: "hi", toolSummary: "Echo hi" },
                    ),
                );
                turn.say("done");
              },
            }),
          ),
        ]),
      }),
      sessionTools: () => [strictEcho],
    });

    const created = await manager.create({
      cwd: "/work",
      runtime: "antigravity",
    });
    expect((await run(created, "run strict")).status).toBe("completed");
    expect(seenArgs).toEqual([{ text: "hi" }]);

    const server = turns[0]!.options.mcpServers?.find(
      (entry) => entry.name === "eta",
    );
    expect(server).toBeDefined();
    expect(server).not.toHaveProperty("env");
    expect(server).not.toHaveProperty("headers");
    expect(turns[0]!.options.env).toMatchObject({
      [HOST_MCP_URL_ENV]: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
      [HOST_MCP_TOKEN_ENV]: expect.any(String),
    });

    const assistant = created.session.journaling
      .transcript()
      .find(
        (message): message is Extract<AgentMessage, { role: "assistant" }> =>
          message.role === "assistant" &&
          message.content.some((block) => block.type === "toolCall"),
      );
    const callBlock = assistant!.content.find(
      (block): block is Extract<typeof block, { type: "toolCall" }> =>
        block.type === "toolCall",
    );
    expect(callBlock?.name).toBe("strict_echo");
    expect(callBlock?.arguments).toEqual({ text: "hi" });
    const toolResult = created.session.journaling
      .transcript()
      .find(
        (message): message is Extract<AgentMessage, { role: "toolResult" }> =>
          message.role === "toolResult",
      );
    expect(toolResult).toMatchObject({
      toolName: "strict_echo",
      details: { echoed: "hi" },
      isError: false,
    });
    await manager.closeAll();
  });

  it("bridges credentialed HTTP and stdio plugin servers through mcp-bridge + SessionOptions.env without leaking credentials", async () => {
    const httpRequests: Record<string, string | string[] | undefined>[] = [];
    const httpPluginServer = createServer((req, res) => {
      httpRequests.push({ ...req.headers });
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id?: number;
          method?: string;
        };
        if (req.headers["x-plugin-api-key"] !== "http-plugin-secret-12345") {
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("unauthorized");
          return;
        }
        if (body.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        const result =
          body.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: {},
                serverInfo: { name: "authed-http", version: "1.0.0" },
              }
            : {
                content: [
                  {
                    type: "text",
                    text: `http-ok:${String(req.headers["x-plugin-api-key"])}:${String(req.headers.authorization ?? "none")}`,
                  },
                ],
              };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, result }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      httpPluginServer.listen(0, "127.0.0.1", resolve),
    );
    const httpAddr = httpPluginServer.address();
    if (httpAddr === null || typeof httpAddr === "string")
      throw new Error("expected TCP address");

    const stdioMcpScript = [
      "let buf = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  buf += chunk;",
      "  for (let nl = buf.indexOf('\\n'); nl >= 0; nl = buf.indexOf('\\n')) {",
      "    const line = buf.slice(0, nl).trim();",
      "    buf = buf.slice(nl + 1);",
      "    if (!line) continue;",
      "    const msg = JSON.parse(line);",
      "    if (msg.method === 'initialize') {",
      "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stdio-plugin', version: '1.0.0' } } }) + '\\n');",
      "    } else if (msg.method === 'tools/call') {",
      "      const bridgeKeys = Object.keys(process.env).filter((k) => {",
      "        const u = k.toUpperCase();",
      "        return u.startsWith('ETA_HOST_MCP_') || u.startsWith('ETA_MCP_');",
      "      });",
      "      const payload = {",
      "        token: process.env.PLUGIN_TOKEN,",
      "        emptyOpt: process.env.EMPTY_OPT,",
      "        hasEmptyOpt: Object.prototype.hasOwnProperty.call(process.env, 'EMPTY_OPT'),",
      "        bridgeKeys,",
      "        argv: process.argv.slice(1),",
      "      };",
      "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }) + '\\n');",
      "    }",
      "  }",
      "});",
    ].join(" ");

    const turns: ScriptedTurn[] = [];
    const warnings: string[] = [];
    const bridgeResults: Record<string, string> = {};
    const manager = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => {
        throw new Error("an eta model was asked for");
      },
      runtimes: createOarRuntimes({
        registry: createRuntimeRegistry([
          asReal(
            "antigravity",
            scriptedRuntime({
              id: "antigravity",
              turn: async (turn) => {
                turns.push(turn);
                await Promise.all(
                  ["eta", "authed-http", "keyed-a", "keyed-b"].map(
                    async (name) => {
                      const entry = turn.options.mcpServers?.find(
                        (server) => server.name === name,
                      );
                      if (entry === undefined || "type" in entry)
                        throw new Error(
                          `expected bridged stdio entry for ${name}`,
                        );
                      bridgeResults[name] = await callViaBridge(
                        entry,
                        turn.options.env,
                        name === "eta" ? "echo" : "probe",
                        {},
                      );
                    },
                  ),
                );
                turn.say("ok");
              },
            }),
          ),
        ]),
        warn: (message) => warnings.push(message),
      }),
      sessionTools: () => [echo],
      runtimeExtrasFor: async () => ({
        mcpServers: [
          { name: "plain", command: "plain-mcp" },
          {
            name: "open-http",
            type: "http",
            url: "http://127.0.0.1:9999/mcp",
          },
          {
            name: "keyed-a",
            command: process.execPath,
            args: ["-e", stdioMcpScript, "--", "tag-a"],
            env: {
              PLUGIN_TOKEN: "stdio-secret-alpha-12345",
              EMPTY_OPT: "",
            } as Record<string, string>,
          },
          {
            name: "keyed-b",
            command: process.execPath,
            args: ["-e", stdioMcpScript, "--", "tag-b"],
            env: {
              PLUGIN_TOKEN: "stdio-secret-beta-67890",
            } as Record<string, string>,
          },
          {
            name: "authed-http",
            type: "http",
            url: `http://127.0.0.1:${httpAddr.port}/mcp`,
            headers: { "X-Plugin-Api-Key": "http-plugin-secret-12345" },
          },
        ],
      }),
    });

    try {
      const created = await manager.create({
        cwd: "/work",
        runtime: "antigravity",
      });
      expect((await run(created, "hello")).status).toBe("completed");
      expect(warnings).toEqual([]);

      const servers = turns[0]!.options.mcpServers ?? [];
      expect(servers.map((server) => server.name)).toEqual([
        "eta",
        "plain",
        "open-http",
        "keyed-a",
        "keyed-b",
        "authed-http",
      ]);

      // Credential-free entries pass through unchanged.
      expect(servers[1]).toEqual({ name: "plain", command: "plain-mcp" });
      expect(servers[2]).toEqual({
        name: "open-http",
        type: "http",
        url: "http://127.0.0.1:9999/mcp",
      });

      // Every entry handed to OAR carries no `env` or `headers` and no secret plaintext.
      for (const server of servers) {
        expect(server).not.toHaveProperty("env");
        expect(server).not.toHaveProperty("headers");
      }
      const serializedServers = JSON.stringify(servers);
      expect(serializedServers).not.toContain("stdio-secret-alpha-12345");
      expect(serializedServers).not.toContain("stdio-secret-beta-67890");
      expect(serializedServers).not.toContain("http-plugin-secret-12345");

      // Bridged env splits secrets into individual *_SECRET variables and keeps raw plugin names out of SessionOptions.env.
      const sessionEnv = turns[0]!.options.env ?? {};
      expect(sessionEnv).not.toHaveProperty("PLUGIN_TOKEN");
      expect(sessionEnv).not.toHaveProperty("X-Plugin-Api-Key");
      expect(sessionEnv).toMatchObject({
        [HOST_MCP_URL_ENV]: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
        [HOST_MCP_TOKEN_ENV]: expect.any(String),
        [`${MCP_STDIO_BRIDGE_PREFIX}0_ENAME_0`]: "PLUGIN_TOKEN",
        [`${MCP_STDIO_BRIDGE_PREFIX}0_EVAL_0_SECRET`]:
          "stdio-secret-alpha-12345",
        [`${MCP_STDIO_BRIDGE_PREFIX}0_ENAME_1`]: "EMPTY_OPT",
        [`${MCP_STDIO_BRIDGE_PREFIX}0_EVAL_1_SECRET`]: "",
        [`${MCP_STDIO_BRIDGE_PREFIX}1_ENAME_0`]: "PLUGIN_TOKEN",
        [`${MCP_STDIO_BRIDGE_PREFIX}1_EVAL_0_SECRET`]:
          "stdio-secret-beta-67890",
        [`${MCP_HTTP_BRIDGE_PREFIX}0_URL`]: `http://127.0.0.1:${httpAddr.port}/mcp`,
        [`${MCP_HTTP_BRIDGE_PREFIX}0_HNAME_0`]: "X-Plugin-Api-Key",
        [`${MCP_HTTP_BRIDGE_PREFIX}0_HVAL_0_SECRET`]:
          "http-plugin-secret-12345",
      });

      // End-to-end tool execution across host, HTTP plugin, and two conflicting-env stdio plugins.
      expect(bridgeResults.eta).toBe("echoed");
      expect(bridgeResults["authed-http"]).toBe(
        "http-ok:http-plugin-secret-12345:none",
      );
      expect(JSON.parse(bridgeResults["keyed-a"]!)).toEqual({
        token: "stdio-secret-alpha-12345",
        emptyOpt: "",
        hasEmptyOpt: true,
        bridgeKeys: [],
        argv: ["tag-a"],
      });
      expect(JSON.parse(bridgeResults["keyed-b"]!)).toEqual({
        token: "stdio-secret-beta-67890",
        hasEmptyOpt: false,
        bridgeKeys: [],
        argv: ["tag-b"],
      });
      expect(httpRequests[0]?.authorization).toBeUndefined();
    } finally {
      await manager.closeAll();
      await new Promise<void>((resolve) =>
        httpPluginServer.close(() => resolve()),
      );
    }
  }, 15_000);

  it("omits credentialed plugin servers and host tools with a warning when a runtime refuses both mcpServerCredentials and env", async () => {
    const turns: ScriptedTurn[] = [];
    const warnings: string[] = [];
    const base = asReal(
      "antigravity",
      scriptedRuntime({
        id: "antigravity",
        turn: (turn) => {
          turns.push(turn);
          turn.say("ok");
        },
      }),
    );
    const manager = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => {
        throw new Error("an eta model was asked for");
      },
      runtimes: createOarRuntimes({
        registry: createRuntimeRegistry([
          {
            ...base,
            refusedSessionOptions: {
              ...base.refusedSessionOptions,
              env: "refuses SessionOptions.env",
            },
          },
        ]),
        warn: (message) => warnings.push(message),
      }),
      sessionTools: () => [echo],
      runtimeExtrasFor: async () => ({
        mcpServers: [
          { name: "plain", command: "plain-mcp" },
          {
            name: "open-http",
            type: "http",
            url: "http://127.0.0.1:9999/mcp",
          },
          {
            name: "keyed",
            command: "keyed-mcp",
            env: { PLUGIN_TOKEN: "secret" },
          },
          {
            name: "authed-http",
            type: "http",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer secret2" },
          },
        ],
      }),
    });

    const created = await manager.create({
      cwd: "/work",
      runtime: "antigravity",
    });
    expect((await run(created, "hello")).status).toBe("completed");
    expect(turns[0]!.options.mcpServers?.map((server) => server.name)).toEqual([
      "plain",
      "open-http",
    ]);
    expect(turns[0]!.options.env).toBeUndefined();
    expect(warnings.join("\n")).toContain("host tools left out");
    expect(warnings.join("\n")).toContain("keyed");
    expect(warnings.join("\n")).toContain("authed-http");
    await manager.closeAll();
  });

  it("falls back to a fresh session on ResumeCwdError(not_listed), and rejects ResumeCwdError(other_cwd)", async () => {
    const makeResumeManager = (reason: "not_listed" | "other_cwd") => {
      const warnings: string[] = [];
      const base = scriptedRuntime({
        id: "antigravity",
        turn: (turn) => turn.say("ok"),
      });
      const runtime: Runtime = {
        ...base,
        refusedSessionOptions: antigravityRuntime.refusedSessionOptions,
        manualCompaction: antigravityRuntime.manualCompaction,
        session: async (installation, options, context) => {
          if (options.resume !== undefined) {
            throw reason === "not_listed"
              ? new ResumeCwdError("session not listed", {
                  sessionId: options.resume,
                  requestedCwd: options.cwd,
                  reason: "not_listed",
                })
              : new ResumeCwdError("session belongs to another cwd", {
                  sessionId: options.resume,
                  requestedCwd: options.cwd,
                  reason: "other_cwd",
                  savedCwd: "/elsewhere",
                });
          }
          return await base.session(installation, options, context);
        },
      };
      const manager = new SessionManager({
        store: new MemorySessionStore(),
        modelsFor: () => {
          throw new Error("an eta model was asked for");
        },
        runtimes: createOarRuntimes({
          registry: createRuntimeRegistry([runtime]),
          warn: (message) => warnings.push(message),
        }),
      });
      return { manager, warnings };
    };

    const fallback = makeResumeManager("not_listed");
    const first = await fallback.manager.create({
      cwd: "/work",
      runtime: "antigravity",
    });
    expect((await run(first, "one")).status).toBe("completed");
    const oldId = first.meta.runtimeSession;
    expect(oldId).toBeDefined();
    await fallback.manager.close(first.meta.id);
    const reopened = (await fallback.manager.session(first.meta.id))!;
    expect((await run(reopened, "two")).status).toBe("completed");
    expect(reopened.meta.runtimeSession).toBeDefined();
    expect(reopened.meta.runtimeSession).not.toBe(oldId);
    expect(fallback.warnings.join("\n")).toContain(oldId!);
    await fallback.manager.closeAll();

    const mismatch = makeResumeManager("other_cwd");
    const created = await mismatch.manager.create({
      cwd: "/work",
      runtime: "antigravity",
    });
    expect((await run(created, "one")).status).toBe("completed");
    await mismatch.manager.close(created.meta.id);
    const reopenedMismatch = (await mismatch.manager.session(created.meta.id))!;
    const failed = await run(reopenedMismatch, "two");
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("another cwd");
    await mismatch.manager.closeAll();
  });

  it("reports unsupported manual compaction on antigravity and empty on ResumeCwdError(not_listed)", async () => {
    const base = asReal(
      "antigravity",
      scriptedRuntime({ id: "antigravity", turn: (turn) => turn.say("ok") }),
    );
    const manager = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => {
        throw new Error("an eta model was asked for");
      },
      runtimes: createOarRuntimes({
        registry: createRuntimeRegistry([base]),
      }),
    });
    const managed = await manager.create({
      cwd: "/work",
      runtime: "antigravity",
    });
    await run(managed, "hello");
    expect(await manager.compactRuntime(managed)).toEqual({
      runtime: "Antigravity",
      outcome: "unsupported",
    });
    await manager.closeAll();

    const claude = scriptedRuntime({
      id: "claude",
      turn: (turn) => turn.say("ok"),
    });
    const compactingManager = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => {
        throw new Error("an eta model was asked for");
      },
      runtimes: createOarRuntimes({
        registry: createRuntimeRegistry([
          {
            ...claude,
            manualCompaction: { kind: "supported", activeTurn: "reject" },
            session: async (installation, options, context) => {
              if (options.resume !== undefined)
                throw new ResumeCwdError("not listed", {
                  sessionId: options.resume,
                  requestedCwd: options.cwd,
                  reason: "not_listed",
                });
              return await claude.session(installation, options, context);
            },
          },
        ]),
      }),
    });
    const created = await compactingManager.create({
      cwd: "/work",
      runtime: "claude",
    });
    await run(created, "before");
    await compactingManager.close(created.meta.id);
    const reopened = (await compactingManager.session(created.meta.id))!;
    expect((await compactingManager.compactRuntime(reopened)).outcome).toBe(
      "empty",
    );
    await compactingManager.closeAll();
  });

  it("surfaces input_too_large prompt rejections cleanly", async () => {
    const base = asReal(
      "antigravity",
      scriptedRuntime({ id: "antigravity", turn: (turn) => turn.say("ok") }),
    );
    const manager = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => {
        throw new Error("an eta model was asked for");
      },
      runtimes: createOarRuntimes({
        registry: createRuntimeRegistry([
          {
            ...base,
            session: async (installation, options, context) => {
              const session = await base.session(
                installation,
                options,
                context,
              );
              return new Proxy(session, {
                get: (target, key) =>
                  key === "prompt"
                    ? async () => ({
                        kind: "rejected",
                        seq: 1,
                        requestId: "r-1",
                        code: "unsupported",
                        failure: "input_too_large",
                        reason: "Prompt exceeds 185,000 UTF-8 bytes",
                        request: {} as never,
                        response: {} as never,
                      })
                    : Reflect.get(target, key, target),
              });
            },
          },
        ]),
      }),
    });
    const managed = await manager.create({
      cwd: "/work",
      runtime: "antigravity",
    });
    const result = await run(managed, "oversized");
    expect(result).toMatchObject({
      status: "failed",
      error: "input_too_large: unsupported: Prompt exceeds 185,000 UTF-8 bytes",
    });
    await manager.closeAll();
  });
});
