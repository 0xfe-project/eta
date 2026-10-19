/** The fake MCP server over streamable HTTP, for one client at a time. */
import type { IncomingHttpHeaders } from "node:http";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { fakeMcpServer } from "./fake-mcp";

export interface FakeHttp {
  url: string;
  /** The headers of the requests it got. */
  headers: IncomingHttpHeaders[];
  /** How many `hang` calls were cancelled. */
  cancelled: () => number;
  close: () => Promise<void>;
}

export async function fakeMcpHttp(): Promise<FakeHttp> {
  let cancelled = 0;
  const headers: IncomingHttpHeaders[] = [];
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await fakeMcpServer(() => cancelled++).connect(transport);
  const http = createServer((req, res) => {
    headers.push(req.headers);
    void transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers,
    cancelled: () => cancelled,
    close: async () => {
      await transport.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
