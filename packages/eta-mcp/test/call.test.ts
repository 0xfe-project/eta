import type { ApproveTools, McpHooks, McpToolResult } from "../src/types";
/**
 * Calls: delivery semantics, output schema validation, `_meta`, approveTools (now inert),
 * the veto hook, elicitation, reconnecting and cancelling.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupAll, setup, tool } from "./helpers/harness";

afterEach(cleanupAll);

function text(result: McpToolResult): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
    .join("\n");
}

async function one(
  spec: Parameters<Awaited<ReturnType<typeof setup>>["stdio"]>[0],
  options: {
    extra?: Parameters<Awaited<ReturnType<typeof setup>>["stdio"]>[1];
    hooks?: McpHooks;
    setupOptions?: Parameters<typeof setup>[0];
  } = {},
) {
  const h = await setup(options.setupOptions);
  const scope = h.manager.scope({
    owner: "a",
    sources: [h.source({ s: h.stdio(spec, options.extra) })],
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
  const call = async (
    name: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
    toolCallId?: string,
  ) => {
    const known = await scope.toolsOrConnect("s", signal);
    const meta = (known.ok ? known.tools : []).find(
      (candidate) => candidate.name === name,
    ) ?? { name, description: "", inputSchema: { type: "object" } };
    return await scope.callTool("s", meta, args, {
      ...(signal ? { signal } : {}),
      ...(toolCallId ? { toolCallId } : {}),
    });
  };
  return { h, scope, call };
}

describe("delivery", () => {
  it("a JSON-RPC error from the server is server_error", async () => {
    const { call } = await one({
      tools: [tool("boom", { behavior: "error" })],
    });
    const result = await call("boom");
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      error: "call_failed",
      delivery: "server_error",
      protocolCode: -32000,
    });
    expect(text(result)).toContain('returned an error for tool "boom"');
    expect(text(result)).toContain("failed on purpose");
  });

  it("a server that dies mid-call is may_have_run, and the model is told not to retry", async () => {
    const { call, h } = await one({
      tools: [tool("die", { behavior: "crash" })],
    });
    const result = await call("die");
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      error: "call_failed",
      delivery: "may_have_run",
    });
    expect(text(result)).toContain("may have run");
    expect(text(result)).toContain("Do not retry automatically");
    expect(h.starts()).toBe(1);
  });

  it("a server that cannot be started is not_sent, and the model may retry", async () => {
    const h = await setup();
    const scope = h.manager.scope({
      owner: "a",
      sources: [
        h.source({
          s: h.stdio({ tools: [tool("x")] }, {}, { FAKE_MCP_FAIL: "1" }),
        }),
      ],
    });
    const result = await scope.callTool(
      "s",
      { name: "x", description: "" },
      {},
    );
    expect(result.details).toMatchObject({
      delivery: "not_sent",
      error: "connect_failed",
    });
  });

  it("a result that breaks the output schema is invalid_result", async () => {
    const outputSchema = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    };
    const { call } = await one({
      tools: [
        tool("good", {
          outputSchema,
          result: {
            content: [{ type: "text", text: "ok" }],
            structuredContent: { n: 1 },
          },
        }),
        tool("wrong", {
          outputSchema,
          result: {
            content: [{ type: "text", text: "ok" }],
            structuredContent: { n: "one" },
          },
        }),
        tool("missing", {
          outputSchema,
          result: { content: [{ type: "text", text: "ok" }] },
        }),
        tool("failing", {
          outputSchema,
          result: { isError: true, content: [{ type: "text", text: "nope" }] },
        }),
      ],
    });
    const good = await call("good");
    expect(good.isError).toBeUndefined();
    expect(text(good)).toContain("structuredContent:");

    for (const name of ["wrong", "missing"]) {
      const result = await call(name);
      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({ delivery: "invalid_result" });
      expect(text(result)).toContain(
        "returned an invalid result, so it may have run",
      );
    }
    // An error result is not held to the schema of a success.
    const failing = await call("failing");
    expect(failing.details).toMatchObject({ error: "tool_error" });
    expect(failing.details.delivery).toBeUndefined();
  });

  it("an error result from the tool is tool_error with its text", async () => {
    const { call } = await one({
      tools: [
        tool("bad", {
          result: {
            isError: true,
            content: [{ type: "text", text: "file not found" }],
          },
        }),
      ],
    });
    const result = await call("bad");
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("file not found");
    expect(result.details).toMatchObject({
      error: "tool_error",
      server: "s",
      tool: "bad",
    });
  });

  it("a call cancelled before it is sent is not_sent; one cancelled while running may have run", async () => {
    const { call, scope } = await one({
      tools: [tool("slow", { behavior: "sleep", ms: 5000 })],
    });
    const early = new AbortController();
    early.abort();
    const before = await call("slow", {}, early.signal);
    expect(before.details).toMatchObject({
      error: "aborted",
      delivery: "not_sent",
    });

    await scope.connect("s");
    const later = new AbortController();
    const running = call("slow", {}, later.signal);
    setTimeout(() => later.abort(), 150);
    const during = await running;
    expect(during.details).toMatchObject({
      error: "aborted",
      delivery: "may_have_run",
    });
  });

  it("reconnects on the next use after the server went away", async () => {
    const { call, h } = await one({
      tools: [tool("die", { behavior: "crash" }), tool("ok")],
    });
    await call("die");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await call("ok");
    expect(text(result)).toBe("ok ok");
    expect(h.starts()).toBe(2);
  });
});

describe("results", () => {
  it("passes _meta through and maps other content to text", async () => {
    const { call } = await one({
      tools: [
        tool("rich", {
          result: {
            content: [
              { type: "text", text: "hello" },
              { type: "image", data: "AAAA", mimeType: "image/jpeg" },
              {
                type: "resource",
                resource: { uri: "file:///a.txt", text: "inside" },
              },
              { type: "resource_link", uri: "file:///b", name: "b" },
              { type: "audio", data: "AAAA", mimeType: "audio/wav" },
            ],
            _meta: { "com.example/trace": "t-1" },
          },
        }),
      ],
    });
    const result = await call("rich");
    expect(result.content[0]).toEqual({ type: "text", text: "hello" });
    expect(result.content[1]).toEqual({
      type: "image",
      data: "AAAA",
      mimeType: "image/jpeg",
    });
    expect(text(result)).toContain("[Resource: file:///a.txt]\ninside");
    expect(text(result)).toContain("[Resource Link: b]\nURI: file:///b");
    expect(text(result)).toContain("[Audio content: audio/wav]");
    expect(result.details._meta).toEqual({ "com.example/trace": "t-1" });
  });

  it("falls back to structuredContent when there is no content", async () => {
    const { call } = await one({
      tools: [
        tool("only", { result: { content: [], structuredContent: { a: 1 } } }),
      ],
    });
    expect(text(await call("only"))).toBe('{\n  "a": 1\n}');
  });

  it("says so when a result is empty", async () => {
    const { call } = await one({
      tools: [tool("nothing", { result: { content: [] } })],
    });
    expect(text(await call("nothing"))).toBe("(empty result)");
  });
});

describe("approveTools", () => {
  const tools = [
    tool("read", { annotations: { readOnlyHint: true } }),
    tool("write", { annotations: { destructiveHint: true } }),
    tool("plain"),
  ];

  // Still read from mcp.json, but MCP no longer gates on it: every tool runs.
  const settings: ApproveTools[] = [true, ["write", "pl*"], "destructive"];
  for (const approveTools of settings)
    it(`runs every tool with approveTools ${JSON.stringify(approveTools)}`, async () => {
      const { call } = await one({ tools }, { extra: { approveTools } });
      for (const name of ["read", "write", "plain"])
        expect(text(await call(name))).toBe(`${name} ok`);
    });
});

describe("onToolCall", () => {
  it("is called with the qualified name and the arguments, and can veto", async () => {
    const seen: Array<{
      name: string;
      args: Record<string, unknown>;
      toolCallId: string | undefined;
    }> = [];
    const { call } = await one(
      {
        tools: [
          tool("danger", { behavior: "echo" }),
          tool("fine", { behavior: "echo" }),
        ],
      },
      {
        hooks: {
          onToolCall: async (call) => {
            seen.push({
              name: call.name,
              args: call.args,
              toolCallId: call.toolCallId,
            });
            if (call.tool === "danger") return { block: "policy forbids it" };
          },
        },
      },
    );
    const blocked = await call("danger", { x: 1 }, undefined, "t1");
    expect(blocked.isError).toBe(true);
    expect(blocked.details).toMatchObject({
      error: "blocked",
      delivery: "not_sent",
      reason: "policy forbids it",
    });
    expect(text(blocked)).toContain("mcp__s__danger");
    expect(text(blocked)).toContain("policy forbids it");

    const allowed = await call("fine", { y: 2 });
    expect(text(allowed)).toBe('{"y":2}');
    expect(seen).toEqual([
      { name: "mcp__s__danger", args: { x: 1 }, toolCallId: "t1" },
      { name: "mcp__s__fine", args: { y: 2 }, toolCallId: undefined },
    ]);
  });

  it("treats a throwing hook as a veto", async () => {
    const { call } = await one(
      { tools: [tool("t")] },
      {
        hooks: {
          onToolCall: () => {
            throw new Error("rule engine down");
          },
        },
      },
    );
    const result = await call("t");
    expect(result.details).toMatchObject({
      error: "blocked",
      delivery: "not_sent",
    });
    expect(text(result)).toContain("rule engine down");
  });
});

describe("elicitation", () => {
  const form = {
    mode: "form",
    message: "Which one?",
    requestedSchema: {
      type: "object",
      properties: { pick: { type: "string", enum: ["a", "b"] } },
    },
  };

  it("hands the request to the hook and returns its answer to the server", async () => {
    const requests: unknown[] = [];
    const { call } = await one(
      { tools: [tool("ask", { behavior: "elicit", elicit: form })] },
      {
        hooks: {
          elicit: async (request) => {
            requests.push({
              server: request.server,
              message: request.params.message,
            });
            return { action: "accept", content: { pick: "b" } };
          },
        },
      },
    );
    const result = await call("ask");
    expect(JSON.parse(text(result))).toEqual({
      action: "accept",
      content: { pick: "b" },
    });
    expect(requests).toEqual([{ server: "s", message: "Which one?" }]);
  });

  it("returns decline, and cancels when the hook throws or there is no hook", async () => {
    const declined = await one(
      { tools: [tool("ask", { behavior: "elicit", elicit: form })] },
      {
        hooks: { elicit: async () => ({ action: "decline" }) },
      },
    );
    expect(JSON.parse(text(await declined.call("ask")))).toEqual({
      action: "decline",
    });

    const broken = await one(
      { tools: [tool("ask", { behavior: "elicit", elicit: form })] },
      {
        hooks: {
          elicit: async () => {
            throw new Error("no ui");
          },
        },
      },
    );
    expect(JSON.parse(text(await broken.call("ask")))).toEqual({
      action: "cancel",
    });

    // Without a hook the client does not claim elicitation, and the server's request is refused.
    const none = await one({
      tools: [tool("ask", { behavior: "elicit", elicit: form })],
    });
    const result = await none.call("ask");
    expect(text(result)).not.toContain("accept");
  });

  it("does not count the time a user takes to answer against the request timeout", async () => {
    const { call } = await one(
      { tools: [tool("ask", { behavior: "elicit", elicit: form })] },
      {
        // The answer takes longer than the timeout; the margin is for a loaded test machine,
        // where the round trip around the answer alone can take a few hundred milliseconds.
        extra: { requestTimeoutMs: 1000 },
        hooks: {
          elicit: async () => {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            return { action: "accept", content: { pick: "a" } };
          },
        },
      },
    );
    const result = await call("ask");
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(text(result))).toMatchObject({ action: "accept" });
  });
});

describe("tool list changes", () => {
  it("picks up tools a server announces and writes them to the cache", async () => {
    const { scope, call, h } = await one({
      tools: [tool("a"), tool("announce", { behavior: "announce" })],
      laterTools: [tool("b")],
    });
    await scope.connect("s");
    expect(scope.tools("s")?.map((t) => t.name)).toEqual(["a", "announce"]);
    let updates = 0;
    scope.onUpdated(() => {
      updates++;
    });

    await call("announce");
    await vi.waitFor(() =>
      expect(scope.tools("s")?.map((t) => t.name)).toEqual([
        "a",
        "announce",
        "b",
      ]),
    );
    expect(updates).toBeGreaterThan(0);

    // A new manager reading the same file sees the new list.
    const cached = JSON.parse(readFileSync(`${h.dir}/cache.json`, "utf8")) as {
      servers: { s: { tools: Array<{ name: string }> } };
    };
    expect(cached.servers.s.tools.map((t) => t.name)).toEqual([
      "a",
      "announce",
      "b",
    ]);
  });
});
