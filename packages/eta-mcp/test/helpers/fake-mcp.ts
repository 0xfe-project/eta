/**
 * A fake MCP server for the tests: the protocol's JSON-RPC handling, driven by a plain-data spec so
 * the same server can run as a child process (stdio) or inside the test (HTTP, SSE).
 *
 * Tools behave as their `behavior` says: `static` answers with `result`, `echo` returns the
 * arguments, `counter` counts its calls, `elicit` asks the client a question mid-call, `sleep`
 * waits, `crash` kills the server while the call is running, `error` answers with a JSON-RPC error.
 */
import process from "node:process";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/core";

export interface FakeTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  behavior?:
    | "static"
    | "echo"
    | "counter"
    | "elicit"
    | "sleep"
    | "crash"
    | "error"
    | "announce"
    | "cwd"
    | "env";
  /** For `static`: the whole result. */
  result?: Record<string, unknown>;
  /** For `sleep`: milliseconds. */
  ms?: number;
  /** For `elicit`: the request parameters sent to the client. */
  elicit?: Record<string, unknown>;
}

export interface FakeSpec {
  tools: FakeTool[];
  instructions?: string;
  /** Tools that appear after the first `tools/list` has been answered, to test list changes. */
  laterTools?: FakeTool[];
}

type Json = Record<string, unknown>;

export interface FakeIo {
  /** Sends a message to the client. */
  send: (message: Json) => void;
  /** Called when the process (or session) should end. */
  exit?: () => void;
  /** Called for each `tools/call` (for assertions). */
  onCall?: (name: string, args: Json) => void;
}

export class FakeRpc {
  private readonly spec: FakeSpec;
  private readonly io: FakeIo;
  private listed = false;
  private counter = 0;
  private nextId = 1;
  private readonly pending = new Map<
    number | string,
    (response: Json) => void
  >();

  constructor(spec: FakeSpec, io: FakeIo) {
    this.spec = spec;
    this.io = io;
  }

  private tools(): FakeTool[] {
    return this.listed
      ? [...this.spec.tools, ...(this.spec.laterTools ?? [])]
      : this.spec.tools;
  }

  /** Handles one message from the client. Requests are answered through `io.send`. */
  async receive(raw: unknown): Promise<void> {
    const message = JSONRPCMessageSchema.parse(raw) as Json;
    if ("method" in message && "id" in message) {
      await this.request(
        message as { id: number | string; method: string; params?: Json },
      );
    } else if (!("method" in message) && "id" in message) {
      this.pending.get(message.id as number | string)?.(message);
    }
  }

  private reply(id: number | string, result: Json): void {
    this.io.send({ jsonrpc: "2.0", id, result });
  }

  private fail(id: number | string, code: number, text: string): void {
    this.io.send({ jsonrpc: "2.0", id, error: { code, message: text } });
  }

  /** Asks the client something (server-initiated request) and waits for the answer. */
  private ask(method: string, params: Json): Promise<Json> {
    const id = `s${this.nextId++}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.io.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private async request(request: {
    id: number | string;
    method: string;
    params?: Json;
  }): Promise<void> {
    const { id, method } = request;
    const params = request.params ?? {};
    switch (method) {
      case "initialize":
        this.reply(id, {
          protocolVersion: params.protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "fake", version: "1.0.0" },
          ...(this.spec.instructions === undefined
            ? {}
            : { instructions: this.spec.instructions }),
        });
        return;
      case "ping":
        this.reply(id, {});
        return;
      case "tools/list":
        this.reply(id, {
          tools: this.tools().map((tool) => ({
            name: tool.name,
            ...(tool.description === undefined
              ? {}
              : { description: tool.description }),
            inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
            ...(tool.outputSchema === undefined
              ? {}
              : { outputSchema: tool.outputSchema }),
            ...(tool.annotations === undefined
              ? {}
              : { annotations: tool.annotations }),
          })),
        });
        this.listed = true;
        return;
      case "tools/call":
        await this.call(id, params as { name: string; arguments?: Json });
        return;
      default:
        this.fail(id, -32601, `Method not found: ${method}`);
    }
  }

  private async call(
    id: number | string,
    params: { name: string; arguments?: Json },
  ): Promise<void> {
    const args = params.arguments ?? {};
    const tool = this.tools().find(
      (candidate) => candidate.name === params.name,
    );
    if (!tool) {
      this.fail(id, -32602, `Unknown tool: ${params.name}`);
      return;
    }
    this.io.onCall?.(tool.name, args);
    switch (tool.behavior ?? "static") {
      case "static":
        this.reply(
          id,
          tool.result ?? {
            content: [{ type: "text", text: `${tool.name} ok` }],
          },
        );
        return;
      case "echo":
        this.reply(id, {
          content: [{ type: "text", text: JSON.stringify(args) }],
        });
        return;
      case "counter":
        this.counter++;
        this.reply(id, {
          content: [{ type: "text", text: `count ${this.counter}` }],
        });
        return;
      case "sleep":
        await new Promise((resolve) => setTimeout(resolve, tool.ms ?? 100));
        this.reply(id, { content: [{ type: "text", text: "slept" }] });
        return;
      case "cwd":
        this.reply(id, { content: [{ type: "text", text: process.cwd() }] });
        return;
      case "env":
        this.reply(id, {
          content: [
            { type: "text", text: process.env[String(args.name)] ?? "" },
          ],
        });
        return;
      case "announce":
        // Tells the client the tool list changed, then answers.
        this.io.send({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
        });
        this.reply(id, { content: [{ type: "text", text: "announced" }] });
        return;
      case "crash":
        this.io.exit?.();
        return;
      case "error":
        this.fail(id, -32000, `${tool.name} failed on purpose`);
        return;
      case "elicit": {
        const answer = await this.ask(
          "elicitation/create",
          tool.elicit ?? {
            mode: "form",
            message: "?",
            requestedSchema: { type: "object", properties: {} },
          },
        );
        const outcome = (answer.result ?? answer.error) as Json;
        this.reply(id, {
          content: [{ type: "text", text: JSON.stringify(outcome) }],
        });
      }
    }
  }
}
