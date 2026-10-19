/**
 * A fake MCP server for tests: the same tools whether it speaks stdio (run as a script) or HTTP.
 *
 * `echo` answers with its text and a `_meta`, `fail` answers with an error result, `explode`
 * throws, `hang` never answers (and records that it was cancelled), `pid` says which process
 * serves, `env` says whether a variable is set (length and digest), `ask` asks the client a question and reports what came back.
 */
import { createHash } from "node:crypto";
import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const object = (properties: Record<string, unknown>) => ({
  type: "object" as const,
  properties,
});

export function fakeMcpServer(onCancelled: () => void = () => undefined) {
  const server = new Server(
    { name: "fake", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "echo",
        description: "Say it back",
        inputSchema: object({ text: { type: "string" } }),
      },
      { name: "fail", inputSchema: object({}) },
      { name: "explode", inputSchema: object({}) },
      { name: "hang", inputSchema: object({}) },
      { name: "pid", inputSchema: object({}) },
      { name: "env", inputSchema: object({ name: { type: "string" } }) },
      { name: "ask", inputSchema: object({}) },
    ],
  }));
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<never> => {
      const { name, arguments: args } = request.params;
      const say = (text: string, more: object = {}) =>
        ({ content: [{ type: "text", text }], ...more }) as never;
      if (name === "echo")
        return say(String(args?.text), { _meta: { "axp/ref": "r1" } });
      if (name === "fail") return say("it failed", { isError: true });
      if (name === "explode") throw new Error("exploded");
      if (name === "pid") return say(String(process.pid));
      if (name === "env") {
        // Never the value itself: its length and a digest of it, enough to tell it is the one.
        const value = process.env[String(args?.name)];
        return say(
          value === undefined
            ? "unset"
            : `set:${value.length}:${createHash("sha256").update(value).digest("hex").slice(0, 8)}`,
        );
      }
      if (name === "ask") {
        const answer = await server.elicitInput({
          message: "name?",
          requestedSchema: object({ name: { type: "string" } }) as never,
        });
        return say(`elicit:${answer.action}`);
      }
      if (name === "hang") {
        await new Promise<void>((resolve) =>
          extra.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        onCancelled();
        return say("cancelled");
      }
      throw new Error(`no tool ${name}`);
    },
  );
  return server;
}
