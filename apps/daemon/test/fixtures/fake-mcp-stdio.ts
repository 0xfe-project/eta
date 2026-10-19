/**
 * A fake MCP server on stdio, for a test to start as a child process: newline-delimited JSON-RPC,
 * no SDK. `echo` says its text back, `pid` says which process serves, `env` says whether a
 * variable is set (its length and a digest, never the value), `ask` asks the client for a name
 * (or the form its `schema` argument describes) and reports what came back.
 */
import { createHash } from "node:crypto";
import process from "node:process";

type Json = Record<string, unknown>;

const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
});

const TOOLS = [
  {
    name: "echo",
    description: "Say it back",
    inputSchema: object({ text: { type: "string" } }),
  },
  { name: "pid", inputSchema: object({}) },
  { name: "env", inputSchema: object({ name: { type: "string" } }) },
  { name: "ask", inputSchema: object({ schema: { type: "object" } }) },
];

const send = (message: Json): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};
const say = (text: string, more: Json = {}): Json => ({
  content: [{ type: "text", text }],
  ...more,
});

let nextId = 1;
const asked = new Map<number, (result: Json) => void>();

async function call(name: string, args: Json): Promise<Json> {
  if (name === "echo")
    return say(String(args.text), { _meta: { "axp/ref": "r1" } });
  if (name === "pid") return say(String(process.pid));
  if (name === "env") {
    const value = process.env[String(args.name)];
    return say(
      value === undefined
        ? "unset"
        : `set:${value.length}:${createHash("sha256").update(value).digest("hex").slice(0, 8)}`,
    );
  }
  if (name === "ask") {
    const id = nextId++;
    const answer = new Promise<Json>((resolve) => asked.set(id, resolve));
    send({
      id,
      method: "elicitation/create",
      params: {
        message: "name?",
        requestedSchema: args.schema ?? object({ name: { type: "string" } }),
      },
    });
    const result = await answer;
    return say(
      `elicit:${String(result.action)}:${JSON.stringify(result.content ?? null)}`,
    );
  }
  throw new Error(`no tool ${name}`);
}

async function receive(message: Json): Promise<void> {
  const { id, method } = message as { id?: number; method?: string };
  if (method === undefined) {
    // The client's answer to something this server asked.
    if (typeof id === "number") asked.get(id)?.((message.result ?? {}) as Json);
    return;
  }
  if (id === undefined) return;
  const params = (message.params ?? {}) as Json;
  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1.0.0" },
      },
    });
  } else if (method === "tools/list") {
    send({ id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    try {
      send({
        id,
        result: await call(
          String(params.name),
          (params.arguments ?? {}) as Json,
        ),
      });
    } catch (error) {
      send({ id, error: { code: -32603, message: String(error) } });
    }
  } else {
    send({ id, error: { code: -32601, message: "no such method" } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) void receive(JSON.parse(line) as Json);
  }
});
process.stdin.on("end", () => process.exit(0));
