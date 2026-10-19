/**
 * A fake MCP server over HTTP, in-process: streamable HTTP (JSON responses, one session id per
 * client) and the legacy SSE transport, on one port.
 *
 * `mode: "sse-only"` answers the streamable endpoint with 404, which is what a legacy server does,
 * so a client has to fall back. `bearer` makes every request without that token a 401.
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FakeSpec } from "./fake-mcp";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { FakeRpc } from "./fake-mcp";

export interface FakeHttpOptions {
  spec: FakeSpec;
  mode?: "both" | "sse-only";
  bearer?: string;
}

export interface FakeHttp {
  /** The streamable HTTP endpoint. */
  url: string;
  /** The legacy SSE endpoint. */
  sseUrl: string;
  /** Headers of every request received, in order. */
  requests: Array<{
    method: string;
    path: string;
    headers: Record<string, string | string[] | undefined>;
  }>;
  /** Names of tools called. */
  calls: string[];
  /** How many sessions were initialised. */
  sessions: () => number;
  /** Makes the server forget every streamable HTTP session, as a restart would. */
  forgetSessions: () => void;
  close: () => Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFakeHttp(
  options: FakeHttpOptions,
): Promise<FakeHttp> {
  const requests: FakeHttp["requests"] = [];
  const calls: string[] = [];
  const streamable = new Map<
    string,
    {
      rpc: FakeRpc;
      waiters: Map<unknown, (message: Record<string, unknown>) => void>;
    }
  >();
  const legacy = new Map<string, { rpc: FakeRpc; response: ServerResponse }>();
  let sessions = 0;

  const unauthorized = (
    request: IncomingMessage,
    response: ServerResponse,
  ): boolean => {
    if (
      options.bearer === undefined ||
      request.headers.authorization === `Bearer ${options.bearer}`
    ) {
      return false;
    }
    response.writeHead(401, {
      "content-type": "application/json",
      "www-authenticate": "Bearer",
    });
    response.end(JSON.stringify({ error: "unauthorized" }));
    return true;
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      requests.push({
        method: request.method ?? "",
        path: url.pathname,
        headers: { ...request.headers },
      });
      if (unauthorized(request, response)) return;

      if (url.pathname === "/mcp" && options.mode !== "sse-only") {
        if (request.method === "POST") {
          const message = JSON.parse(await readBody(request)) as Record<
            string,
            unknown
          >;
          const isRequest = "method" in message && "id" in message;
          let sessionId = request.headers["mcp-session-id"] as
            | string
            | undefined;
          if (message.method === "initialize") {
            sessionId = randomUUID();
            sessions++;
            const waiters = new Map<
              unknown,
              (message: Record<string, unknown>) => void
            >();
            streamable.set(sessionId, {
              waiters,
              rpc: new FakeRpc(options.spec, {
                send: (reply) => waiters.get(reply.id)?.(reply),
                onCall: (name) => calls.push(name),
              }),
            });
          }
          const session =
            sessionId === undefined ? undefined : streamable.get(sessionId);
          if (!session) {
            response.writeHead(404, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "unknown session" }));
            return;
          }
          if (!isRequest) {
            response.writeHead(202).end();
            return;
          }
          // The reply to this request goes back on this response.
          const answer = await new Promise<Record<string, unknown>>(
            (resolve) => {
              session.waiters.set(message.id, resolve);
              void session.rpc.receive(message);
            },
          );
          session.waiters.delete(message.id);
          response.writeHead(200, {
            "content-type": "application/json",
            ...(message.method === "initialize"
              ? { "mcp-session-id": sessionId }
              : {}),
          });
          response.end(JSON.stringify(answer));
          return;
        }
        if (request.method === "DELETE") {
          const sessionId = request.headers["mcp-session-id"] as
            | string
            | undefined;
          if (sessionId) streamable.delete(sessionId);
          response.writeHead(200).end();
          return;
        }
        response.writeHead(405).end();
        return;
      }

      if (url.pathname === "/sse" && request.method === "GET") {
        const id = randomUUID();
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const rpc = new FakeRpc(options.spec, {
          send: (message) =>
            response.write(
              `event: message\ndata: ${JSON.stringify(message)}\n\n`,
            ),
          onCall: (name) => calls.push(name),
        });
        legacy.set(id, { rpc, response });
        sessions++;
        response.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`);
        request.on("close", () => legacy.delete(id));
        return;
      }
      if (url.pathname === "/messages" && request.method === "POST") {
        const session = legacy.get(url.searchParams.get("sessionId") ?? "");
        if (!session) {
          response.writeHead(404).end();
          return;
        }
        const message = JSON.parse(await readBody(request)) as unknown;
        response.writeHead(202).end("Accepted");
        await session.rpc.receive(message);
        return;
      }
      response.writeHead(404).end();
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    sseUrl: `http://127.0.0.1:${port}/sse`,
    requests,
    calls,
    sessions: () => sessions,
    forgetSessions: () => streamable.clear(),
    close: async () => {
      for (const { response } of legacy.values()) response.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
