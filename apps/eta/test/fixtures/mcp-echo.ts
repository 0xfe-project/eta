/**
 * The smallest MCP server over stdio, for the host's MCP test: newline-delimited JSON-RPC with
 * one tool, `echo`, that answers its arguments back as structured content.
 */
import process from "node:process";

type Json = Record<string, unknown>;
const send = (message: Json): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

function answer(request: {
  id?: number | string;
  method: string;
  params?: Json;
}): void {
  if (request.id === undefined) return;
  const { id, method } = request;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: request.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "echo", version: "1.0.0" },
      },
    });
  } else if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Answer the arguments back.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
            },
          },
        ],
      },
    });
  } else if (method === "tools/call") {
    const args = (request.params?.arguments ?? {}) as Json;
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(args) }],
        structuredContent: { echoed: args, pid: process.pid },
      },
    });
  } else if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
  } else {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `no ${method}` },
    });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (
    let newline = buffer.indexOf("\n");
    newline >= 0;
    newline = buffer.indexOf("\n")
  ) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line)
      answer(
        JSON.parse(line) as { id?: number; method: string; params?: Json },
      );
  }
});
process.stdin.on("end", () => process.exit(0));
