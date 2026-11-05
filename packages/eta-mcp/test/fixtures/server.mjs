#!/usr/bin/env node
// An MCP server over stdio with a tool for each thing that can happen to a client.
import process from "node:process";
import { createInterface } from "node:readline";

if (process.env.FIXTURE_FAIL_START !== undefined) {
  process.stderr.write(`${process.env.FIXTURE_FAIL_START}\n`);
  process.exit(3);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const text = (value) => ({ content: [{ type: "text", text: value }] });

const tools = {
  env: () => text(`${process.env.FIXTURE_VALUE}:${process.pid}`),
  secret_echo: () => text(`the key is ${process.env.FIXTURE_VALUE}`),
  fail: () => ({ ...text("it did not work"), isError: true }),
  structured: () => ({
    ...text("{}"),
    structuredContent: { count: 2 },
  }),
  image: () => ({
    content: [
      { type: "text", text: "a dot" },
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
    ],
  }),
  crash: () => {
    process.stderr.write(`dying with ${process.env.FIXTURE_VALUE}\n`);
    process.exit(1);
  },
  hang: () => new Promise(() => undefined),
};

createInterface({ input: process.stdin }).on("line", async (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize")
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      },
    });
  else if (method === "tools/list")
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: Object.keys(tools).map((name) => ({
          name,
          description: `The ${name} tool.`,
          inputSchema: { type: "object" },
        })),
      },
    });
  else if (method === "tools/call")
    send({ jsonrpc: "2.0", id, result: await tools[params.name]() });
  else send({ jsonrpc: "2.0", id, error: { code: -32601, message: method } });
});
