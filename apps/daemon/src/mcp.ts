/**
 * MCP servers as a session's tools.
 *
 * Glue, and meant to be replaced: it connects to the servers a caller names with the official
 * client, reads each one's tool list once, and wraps every tool as a kernel tool named
 * `<server>__<tool>`. A session has its own connections, closed with it (a stdio server is a child
 * process of this machine and dies with the session); nothing is shared or pooled. Elicitation is
 * always cancelled, and resources, prompts and list changes are not used.
 *
 * It lives here because the primary and a daemon both need it, and a stdio server must start on
 * the machine where the session runs. Which servers a session gets is the caller's: a function
 * from the session to a list of configs.
 */
import type { KernelTool, ToolCallInfo } from "@eta/core";
import type { SessionManagerOptions, SessionMeta } from "@eta/server";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { registerSessionTools } from "@eta/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** One MCP server: a command to start on this machine, or a URL to reach. */
export type McpServerConfig =
  | {
      /** The prefix of its tools' names; letters, digits, `_` and `-`. */
      name: string;
      command: string;
      args?: string[] | undefined;
      /** The environment the child gets, on top of the few variables a shell needs (PATH, HOME). */
      env?: Record<string, string> | undefined;
      cwd?: string | undefined;
    }
  | {
      name: string;
      /** A streamable HTTP endpoint. */
      url: string;
      headers?: Record<string, string> | undefined;
    };

/** The servers of one session, connected. */
export interface McpConnections {
  tools: KernelTool[];
  /** Disconnect everything; ends the stdio children. */
  close: () => Promise<void>;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const toolName = (server: string, tool: string): string =>
  `${server}__${tool}`.replace(/[^\w-]/g, "_").slice(0, 64);

/** MCP content as the kernel's: text and images as they are, anything else as its JSON. */
function contentOf(content: unknown): unknown[] {
  if (!Array.isArray(content)) return [];
  return content.map((block: { type?: string }) => {
    if (block.type === "text" || block.type === "image") return block;
    return { type: "text", text: JSON.stringify(block) };
  });
}

function wrap(client: Client, server: string, tool: Tool): KernelTool {
  const wrapped: KernelTool & { parameters: unknown } = {
    name: toolName(server, tool.name),
    description: tool.description ?? "",
    parameters: tool.inputSchema,
    async execute(args: unknown, call: ToolCallInfo) {
      try {
        const result = await client.callTool(
          {
            name: tool.name,
            arguments: (args ?? {}) as Record<string, unknown>,
          },
          undefined,
          call.signal === undefined ? {} : { signal: call.signal },
        );
        return {
          content: contentOf(result.content),
          ...(result.isError === true ? { isError: true } : {}),
          // The server's `_meta` goes to the front end as it came.
          ...(result._meta === undefined
            ? {}
            : { details: { _meta: result._meta } }),
        };
      } catch (error) {
        if (call.signal?.aborted === true) throw error;
        return {
          content: [{ type: "text", text: messageOf(error) }],
          isError: true,
        };
      }
    },
  };
  return wrapped;
}

async function connect(config: McpServerConfig): Promise<Client> {
  const client = new Client(
    { name: "eta", version: "0.1.0" },
    { capabilities: { elicitation: {} } },
  );
  client.setRequestHandler(ElicitRequestSchema, () => ({ action: "cancel" }));
  const transport =
    "command" in config
      ? new StdioClientTransport({
          command: config.command,
          ...(config.args === undefined ? {} : { args: config.args }),
          ...(config.env === undefined ? {} : { env: config.env }),
          ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
          stderr: "ignore",
        })
      : new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: config.headers ?? {} },
        });
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  return client;
}

/**
 * Connect to the servers and read their tool lists. A server that cannot be reached is reported
 * to `warn` and left out; the others still serve.
 */
export async function openMcp(
  servers: readonly McpServerConfig[],
  warn: (message: string) => void = () => undefined,
): Promise<McpConnections> {
  const clients: Client[] = [];
  const tools: KernelTool[] = [];
  await Promise.all(
    servers.map(async (config) => {
      let client: Client | undefined;
      try {
        client = await connect(config);
        const listed = await client.listTools();
        for (const tool of listed.tools)
          tools.push(wrap(client, config.name, tool));
        clients.push(client);
      } catch (error) {
        await client?.close().catch(() => undefined);
        warn(`[eta] MCP server ${config.name}: ${messageOf(error)}`);
      }
    }),
  );
  return {
    tools,
    close: async () => {
      await Promise.all(clients.map((client) => client.close()));
    },
  };
}

/**
 * MCP for a session manager: its `sessionTools` hook, and `settled`, which says when a session's
 * servers are in.
 *
 * A session gets the servers `serversFor` names for it (none, if it returns nothing). The
 * manager's hook is synchronous and a connection is not, so the tools are registered when the
 * connection is ready, a moment after the session opens; a caller that must not run the session
 * before that waits on `settled(sessionId)`. The connections close with the session.
 */
export function mcpSessionTools(
  serversFor: (meta: SessionMeta) => readonly McpServerConfig[],
  warn?: (message: string) => void,
): {
  sessionTools: NonNullable<SessionManagerOptions["sessionTools"]>;
  settled: (sessionId: string) => Promise<void>;
} {
  const pending = new Map<string, Promise<void>>();
  return {
    sessionTools: ({ meta, session }) => {
      const servers = serversFor(meta);
      if (servers.length === 0) return [];
      let closed = false;
      const opened = openMcp(servers, warn);
      pending.set(
        meta.id,
        opened.then((connections) => {
          if (!closed) registerSessionTools(session, connections.tools);
        }),
      );
      session.kernel.ctx.effect(() => () => {
        closed = true;
        pending.delete(meta.id);
        void opened.then((connections) => connections.close());
      });
      return [];
    },
    settled: async (sessionId) => {
      await pending.get(sessionId);
    },
  };
}
