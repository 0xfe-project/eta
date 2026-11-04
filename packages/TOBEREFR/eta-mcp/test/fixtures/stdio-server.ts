/**
 * A fake MCP server over stdio: newline-delimited JSON-RPC on stdin and stdout.
 *
 * The spec comes from the FAKE_MCP environment variable (JSON). Each start appends a line to the
 * file named by FAKE_MCP_STARTS, so a test can count how often the server was spawned.
 */

import type { FakeSpec } from "../helpers/fake-mcp";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { FakeRpc } from "../helpers/fake-mcp";

const spec = JSON.parse(process.env.FAKE_MCP ?? '{"tools":[]}') as FakeSpec;
if (process.env.FAKE_MCP_STARTS)
  appendFileSync(process.env.FAKE_MCP_STARTS, `${process.pid}\n`);
if (process.env.FAKE_MCP_STDERR)
  process.stderr.write(`${process.env.FAKE_MCP_STDERR}\n`);
if (process.env.FAKE_MCP_FAIL) process.exit(1);

const rpc = new FakeRpc(spec, {
  send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
  exit: () => process.exit(3),
});

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) void rpc.receive(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
