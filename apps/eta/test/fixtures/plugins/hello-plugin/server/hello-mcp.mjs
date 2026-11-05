#!/usr/bin/env node
// A small MCP server over stdio: enough protocol to list one tool and answer it.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import process from "node:process";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function hello(name) {
  const key = process.env.HELLO_API_KEY ?? "";
  appendFileSync(process.env.HELLO_STATE, `${name}\n`);
  return {
    greeting: `Hello ${name} from ${process.env.HELLO_TEAM ?? "nobody"}`,
    max: process.env.HELLO_MAX ?? null,
    cwd: process.cwd(),
    root: process.env.PLUGIN_ROOT,
    data: process.env.PLUGIN_DATA,
    pid: process.pid,
    // Proves the server got the key without saying what it is.
    keySha256: createHash("sha256").update(key).digest("hex"),
  };
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize")
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "hello", version: "1.0.0" },
      },
    });
  else if (method === "tools/list")
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "say_hello",
            description: "Greet someone from the configured team.",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        ],
      },
    });
  else if (method === "tools/call")
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify(hello(params.arguments?.name ?? "you")),
          },
        ],
      },
    });
  else send({ jsonrpc: "2.0", id, error: { code: -32601, message: method } });
});
