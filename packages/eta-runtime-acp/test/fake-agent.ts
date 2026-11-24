/**
 * A small ACP agent on stdio, for tests: the agent side of the same SDK the runtime uses.
 *
 * What it does is chosen by words in the prompt (`tool`, `write`, `slow`, `die`, `state`,
 * `[usage:...]`), and what it is by its environment:
 *
 * - `FAKE_ACP_DIR`: where it keeps its sessions (so one survives its process) and its log.
 * - `FAKE_ACP_CAPS`: `resume` (default), `load`, or `none`: how a session can be picked up.
 * - `FAKE_ACP_AUTH=1`: `session/new` answers that a sign-in is needed.
 * - `FAKE_ACP_SYSTEM_PROMPT=1`: it takes a system prompt.
 * - `FAKE_ACP_INIT_DELAY_MS`: how long `initialize` waits before it answers (none by default).
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const { methods } = acp;
const dir = process.env.FAKE_ACP_DIR ?? process.cwd();
const caps = process.env.FAKE_ACP_CAPS ?? "resume";

interface Stored {
  /** The `eta` MCP server the session was given, when it was. */
  eta?: { url: string; headers: { name: string; value: string }[] };
  prompts: string[];
  model: string;
  effort: string;
  systemPrompt: string | null;
  openedBy: string;
}

const log = (entry: Record<string, unknown>): void =>
  appendFileSync(
    join(dir, "log.jsonl"),
    `${JSON.stringify({ pid: process.pid, ...entry })}\n`,
  );
const fileOf = (sessionId: string): string => join(dir, `${sessionId}.json`);
const load = (sessionId: string): Stored => {
  if (!existsSync(fileOf(sessionId)))
    throw new acp.RequestError(-32002, `no session ${sessionId}`);
  return JSON.parse(readFileSync(fileOf(sessionId), "utf8")) as Stored;
};
const save = (sessionId: string, stored: Stored): void =>
  writeFileSync(fileOf(sessionId), JSON.stringify(stored));

const configOptions = (stored: Stored): acp.SessionConfigOption[] => [
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: stored.model,
    options: [
      { value: "model-a", name: "Model A" },
      { value: "model-b", name: "Model B" },
    ],
  },
  {
    type: "select",
    id: "effort",
    name: "Effort",
    category: "thought_level",
    currentValue: stored.effort,
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
];

const systemPromptOf = (prompt: acp.SystemPrompt | null | undefined) =>
  prompt?.content.map((b) => (b.type === "text" ? b.text : "")).join("") ??
  null;

const cancelled = new Set<string>();
const sleep = async (ms: number) =>
  await new Promise((resolve) => setTimeout(resolve, ms));

const app = acp
  .agent({ name: "fake-agent" })
  .onRequest(methods.agent.initialize, async ({ params }) => {
    await sleep(Number(process.env.FAKE_ACP_INIT_DELAY_MS ?? 0));
    return {
      protocolVersion: Math.min(params.protocolVersion, acp.PROTOCOL_VERSION),
      agentCapabilities: {
        loadSession: caps === "load",
        promptCapabilities: { image: true },
        mcpCapabilities: { http: true },
        sessionCapabilities: {
          ...(caps === "resume" ? { resume: {} } : {}),
          close: {},
          ...(process.env.FAKE_ACP_SYSTEM_PROMPT === "1"
            ? { systemPrompt: {} }
            : {}),
        },
      },
      agentInfo: { name: "fake-agent", title: "Fake Agent", version: "0.0.1" },
      authMethods:
        process.env.FAKE_ACP_AUTH === "1"
          ? [
              {
                id: "login",
                name: "Fake login",
                description: "Run `fake login`",
              },
            ]
          : [],
    };
  })
  .onRequest(methods.agent.session.new, ({ params }) => {
    if (process.env.FAKE_ACP_AUTH === "1")
      throw new acp.RequestError(-32000, "Authentication required");
    const sessionId = `fake-${crypto.randomUUID()}`;
    const stored: Stored = {
      prompts: [],
      model: "model-a",
      effort: "low",
      systemPrompt: systemPromptOf(params.systemPrompt),
      openedBy: "new",
    };
    const eta = params.mcpServers.find((server) => server.name === "eta");
    if (eta !== undefined && "url" in eta)
      stored.eta = { url: eta.url, headers: eta.headers };
    save(sessionId, stored);
    log({
      method: "session/new",
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
    });
    return { sessionId, configOptions: configOptions(stored) };
  })
  .onRequest(methods.agent.session.resume, ({ params }) => {
    const stored = load(params.sessionId);
    save(params.sessionId, { ...stored, openedBy: "resume" });
    log({ method: "session/resume", sessionId: params.sessionId });
    return { configOptions: configOptions(stored) };
  })
  .onRequest(methods.agent.session.load, async ({ params, client }) => {
    const stored = load(params.sessionId);
    save(params.sessionId, { ...stored, openedBy: "load" });
    log({ method: "session/load", sessionId: params.sessionId });
    // The replay a client that keeps its own transcript has to drop.
    for (const text of stored.prompts) {
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text },
        },
      });
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `replayed: ${text}` },
        },
      });
    }
    return { configOptions: configOptions(stored) };
  })
  .onRequest(methods.agent.session.close, ({ params }) => {
    log({ method: "session/close", sessionId: params.sessionId });
    return {};
  })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    const stored = load(params.sessionId);
    if (params.configId === "model") stored.model = String(params.value);
    if (params.configId === "effort") stored.effort = String(params.value);
    save(params.sessionId, stored);
    log({
      method: "session/set_config_option",
      configId: params.configId,
      value: params.value,
    });
    return { configOptions: configOptions(stored) };
  })
  .onNotification(methods.agent.session.cancel, ({ params }) => {
    cancelled.add(params.sessionId);
    log({ method: "session/cancel", sessionId: params.sessionId });
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const { sessionId } = params;
    const text = params.prompt
      .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
      .join("");
    // What it is asked to do is in the user's words, not in who it was told it is.
    const asked = text.replace(/^<agent>[\s\S]*<\/agent>\s*/, "");
    const stored = load(sessionId);
    stored.prompts.push(text);
    save(sessionId, stored);
    log({ method: "session/prompt", sessionId, text });
    const say = async (words: string, messageId?: string) =>
      await client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: words },
          ...(messageId === undefined ? {} : { messageId }),
        },
      });
    // `[usage:<json>]`: it works as a task's executor does (calls `finish_task` over the MCP server
    // it was given) and answers the prompt with that JSON as the turn's tokens (ACP's unstable
    // `PromptResponse.usage`); `[usage:none]` answers with none. Either way it sends a
    // `usage_update` first, which tells the context's size and the cost, never the tokens used.
    const usage = /\[usage:(.*?)\]/.exec(asked)?.[1];
    if (usage !== undefined) {
      await client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: 64_000,
          size: 128_000,
          cost: { amount: 0.5, currency: "USD" },
        },
      });
      const silent = asked.includes("[silent]");
      if (!silent) await say("worked. ");
      if (stored.eta !== undefined)
        await fetch(stored.eta.url, {
          method: "POST",
          headers: {
            ...Object.fromEntries(
              stored.eta.headers.map((h) => [h.name, h.value]),
            ),
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "finish_task", arguments: { summary: "worked" } },
          }),
        });
      if (!silent) await say("finished.");
      return usage === "none"
        ? { stopReason: "end_turn" }
        : ({
            stopReason: "end_turn",
            usage: JSON.parse(usage) as unknown,
          } as acp.PromptResponse);
    }
    if (asked.includes("late")) {
      // Ends its turn now, and asks for a permission only once the test says the turn is over
      // (by writing `late.go`): a request that belongs to no turn.
      void (async () => {
        while (!existsSync(join(dir, "late.go"))) await sleep(10);
        const decision = await client.request(
          methods.client.session.requestPermission,
          {
            sessionId,
            toolCall: {
              toolCallId: "t-late",
              title: "Write late.txt",
              kind: "edit",
            },
            options: [
              { optionId: "yes", name: "Allow", kind: "allow_once" },
              {
                optionId: "always",
                name: "Always allow",
                kind: "allow_always",
              },
              { optionId: "no", name: "Reject", kind: "reject_once" },
            ],
          },
        );
        log({
          method: "late-permission",
          outcome:
            decision.outcome.outcome === "selected"
              ? decision.outcome.optionId
              : "cancelled",
        });
      })();
      await say("Done for now.");
      return { stopReason: "end_turn" };
    }
    if (asked.includes("die")) {
      await say("about to die");
      await sleep(30);
      process.exit(7);
    }
    if (asked.includes("listing")) {
      // What the host's MCP server lists now, as an agent lists it again on `list_changed`.
      let names = "no eta server";
      if (stored.eta !== undefined) {
        const response = await fetch(stored.eta.url, {
          method: "POST",
          headers: {
            ...Object.fromEntries(
              stored.eta.headers.map((h) => [h.name, h.value]),
            ),
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        const reply = (await response.json()) as {
          result: {
            tools: {
              name: string;
              description?: string;
              inputSchema: { properties?: object };
            }[];
          };
        };
        names = reply.result.tools
          .map((tool) =>
            [
              tool.name,
              tool.description,
              JSON.stringify(tool.inputSchema.properties ?? {}),
            ]
              .filter((part) => part !== undefined)
              .join(" "),
          )
          .join(" | ");
      }
      await say(`tools: ${names}`);
      return { stopReason: "end_turn" };
    }
    if (asked.includes("state")) {
      await say(
        JSON.stringify({
          prompts: stored.prompts.length,
          model: stored.model,
          effort: stored.effort,
          openedBy: stored.openedBy,
          systemPrompt: stored.systemPrompt,
        }),
      );
      return { stopReason: "end_turn" };
    }
    await client.notify(methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking. " },
      },
    });
    await say("heard: ");
    await say(text);
    if (asked.includes("board")) {
      // One of the host's tools, called the way an agent does: over the MCP server it was given.
      await client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t-note",
          title: "note",
          kind: "other",
          status: "in_progress",
          rawInput: { text: "from the agent" },
        },
      });
      let answer = "no eta server";
      let failed = true;
      if (stored.eta !== undefined) {
        const response = await fetch(stored.eta.url, {
          method: "POST",
          headers: {
            ...Object.fromEntries(
              stored.eta.headers.map((h) => [h.name, h.value]),
            ),
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "note", arguments: { text: "from the agent" } },
          }),
        });
        const reply = (await response.json()) as {
          result?: { content: { text?: string }[]; isError?: boolean };
          error?: { message: string };
        };
        answer =
          reply.result?.content.map((part) => part.text ?? "").join("") ??
          reply.error?.message ??
          "no result";
        failed = reply.result === undefined || reply.result.isError === true;
      }
      await client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "t-note",
          status: failed ? "failed" : "completed",
          content: [
            { type: "content", content: { type: "text", text: answer } },
          ],
        },
      });
      return { stopReason: "end_turn" };
    }
    if (asked.includes("slow")) {
      for (let i = 0; i < 400 && !cancelled.has(sessionId); i++)
        await sleep(25);
      return {
        stopReason: cancelled.delete(sessionId) ? "cancelled" : "end_turn",
      };
    }
    if (asked.includes("tool")) {
      // Opened bare, filled in after, as real agents do.
      await client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t-read",
          title: "read",
          kind: "read",
          status: "pending",
          rawInput: {},
        },
      });
      await client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "t-read",
          title: "Read notes.md",
          status: "in_progress",
          rawInput: { path: "notes.md" },
        },
      });
      await client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "t-read",
          status: "completed",
          content: [
            { type: "content", content: { type: "text", text: "the notes" } },
          ],
          locations: [{ path: "notes.md" }],
        },
      });
      await say(" The notes say hi.");
    }
    if (asked.includes("write")) {
      await client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t-write",
          title: "Write out.txt",
          kind: "edit",
          status: "pending",
          rawInput: { path: "out.txt" },
        },
      });
      const decision = await client.request(
        methods.client.session.requestPermission,
        {
          sessionId,
          toolCall: {
            toolCallId: "t-write",
            title: "Write out.txt",
            kind: "edit",
            rawInput: { path: "out.txt" },
          },
          options: [
            { optionId: "yes", name: "Allow", kind: "allow_once" },
            { optionId: "always", name: "Always allow", kind: "allow_always" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        },
      );
      const outcome =
        decision.outcome.outcome === "selected"
          ? decision.outcome.optionId
          : "cancelled";
      log({ method: "permission", outcome });
      const allowed = outcome === "yes" || outcome === "always";
      await client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "t-write",
          status: allowed ? "completed" : "failed",
          content: [
            allowed
              ? {
                  type: "diff",
                  path: "out.txt",
                  oldText: null,
                  newText: "hello",
                }
              : {
                  type: "content",
                  content: { type: "text", text: `not written: ${outcome}` },
                },
          ],
        },
      });
      if (outcome === "cancelled") {
        cancelled.delete(sessionId);
        return { stopReason: "cancelled" };
      }
      await say(allowed ? " Written." : " Not written.");
    }
    return { stopReason: "end_turn" };
  });

log({ method: "started", caps, cwd: process.cwd() });
const connection = app.connect(
  acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ),
);
void connection.closed.then(() => process.exit(0));
