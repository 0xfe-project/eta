/**
 * The per-session hooks a host product wires into the manager: what it adds to a session's
 * prompt and toolset, the policy on its tool calls, who hears about its questions, and the two
 * ids that say whose session it is.
 *
 * Each one is checked where it matters to a run: the model's request carries the prompt and the
 * tool, the middleware sees the call, the observer sees the question, and the meta file keeps the
 * ids across a reopen.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { KernelTool } from "@eta/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "../src/file-store";
import { registerSessionTools, SessionManager } from "../src/manager";
import { MemorySessionStore } from "../src/memory-store";
import { assembleServer } from "../src/server";

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

const answer = (text: string): AssistantMessage =>
  assistantMessage({ content: [{ type: "text", text }] });

const toolTurn = (
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): AssistantMessage =>
  assistantMessage({
    stopReason: "toolUse",
    content: [{ type: "toolCall", id, name, arguments: args }],
  });

async function until(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs)
      throw new Error("timed out waiting for the run");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** A tool the model can call: a name, a schema it sees, and a body that records what it got. */
function recordingTool(name: string, calls: unknown[]): KernelTool {
  return {
    name,
    description: `the ${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: (args: unknown) => {
      calls.push(args);
      return { content: [{ type: "text", text: `${name} done` }] };
    },
  } as KernelTool;
}

describe("whose session it is", () => {
  it("keeps the agent and the conversation in the session's row, across a reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "eta-hooks-"));
    roots.push(root);
    const store = new FileSessionStore({ root });
    const sessions = new SessionManager({
      store,
      modelsFor: () => fakeModels([]) as never,
    });
    const created = await sessions.create({
      cwd: "/work",
      agentId: "agent-1",
      conversationId: "conversation-1",
    });
    expect(created.meta).toMatchObject({
      agentId: "agent-1",
      conversationId: "conversation-1",
    });
    await sessions.closeAll();
    await store.close();

    const reopenedStore = new FileSessionStore({ root });
    const reopened = new SessionManager({
      store: reopenedStore,
      modelsFor: () => fakeModels([]) as never,
    });
    const found = await reopened.session(created.meta.id);
    expect(found?.meta).toMatchObject({
      agentId: "agent-1",
      conversationId: "conversation-1",
    });
    // The listing a sidebar reads carries them without opening anything.
    const listing = (await reopened.list())[0];
    expect(listing?.ok === true ? listing.meta.agentId : undefined).toBe(
      "agent-1",
    );
    await reopened.closeAll();
    await reopenedStore.close();
  });

  it("does not hand them to a fork: a fork is a session of its own", async () => {
    const sessions = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => fakeModels([]) as never,
    });
    const source = await sessions.create({
      cwd: "/work",
      agentId: "agent-1",
      conversationId: "conversation-1",
    });
    source.session.log.recordMessage(userMsg("something to fork"));
    const forked = await sessions.fork(source.meta.id);
    expect(forked.meta.agentId).toBeUndefined();
    expect(forked.meta.conversationId).toBeUndefined();
    await sessions.closeAll();
  });
});

describe("baseSystemPromptFor", () => {
  it("starts one session's prompt from what the host says, and leaves the others alone", async () => {
    const models = fakeModels([answer("one"), answer("two")]);
    const sessions = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => models as never,
      baseSystemPromptFor: (meta) =>
        meta.agentId === undefined
          ? undefined
          : `You are the reviewer. (${meta.agentId})`,
    });
    const plain = await sessions.create({ cwd: "/work" });
    const reviewer = await sessions.create({ cwd: "/work", agentId: "rev" });

    plain.session.kernel.inject(userMsg("hi"));
    await until(() => models.calls.length === 1);
    reviewer.session.kernel.inject(userMsg("hi"));
    await until(() => models.calls.length === 2);

    const prompts = models.calls.map((call) => call.context.systemPrompt ?? "");
    expect(prompts[0]).not.toContain("You are the reviewer.");
    expect(prompts[1]).toContain("You are the reviewer. (rev)");
    await sessions.closeAll();
  });
});

describe("sessionTools", () => {
  it("offers the model a tool the harness does not have, and runs it when it is called", async () => {
    const calls: unknown[] = [];
    const models = fakeModels([
      toolTurn("c1", "mention", { who: "Ada" }),
      answer("sent"),
    ]);
    const sessions = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => models as never,
      sessionTools: ({ meta }) =>
        meta.agentId === undefined ? [] : [recordingTool("mention", calls)],
    });
    const bare = await sessions.create({ cwd: "/work" });
    const agent = await sessions.create({ cwd: "/work", agentId: "a" });
    expect(bare.session.kernel.tools.get("mention")).toBeUndefined();

    agent.session.kernel.inject(userMsg("tell Ada"));
    await until(() => models.calls.length === 2);
    await until(() => !agent.session.runner.running);

    // The request offered it, which is the half `registerSessionTools` exists for: a tool that
    // is registered but not named in `activeToolNames` reaches nobody.
    expect(models.calls[0]?.context.tools?.map((tool) => tool.name)).toContain(
      "mention",
    );
    expect(calls).toEqual([{ who: "Ada" }]);
    await sessions.closeAll();
  });

  it("names a tool once, however many times the session is opened", async () => {
    const store = new MemorySessionStore();
    const open = () =>
      new SessionManager({
        store,
        modelsFor: () => fakeModels([]) as never,
        sessionTools: () => [recordingTool("mention", [])],
      });
    const first = open();
    const created = await first.create({ cwd: "/work" });
    await first.closeAll();
    const second = open();
    const again = await second.session(created.meta.id);
    const names = again?.session.kernel.config.read("activeToolNames") ?? [];
    expect(names.filter((name) => name === "mention")).toHaveLength(1);
    await second.closeAll();
  });

  it("registerSessionTools leaves an unpinned session's selection alone", async () => {
    const sessions = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => fakeModels([]) as never,
    });
    const created = await sessions.create({ cwd: "/work" });
    // Pretend the harness pinned nothing: an empty selection means "everything registered".
    created.session.kernel.config.update({ activeToolNames: [] });
    registerSessionTools(created.session, [recordingTool("extra", [])]);
    expect(created.session.kernel.config.read("activeToolNames")).toEqual([]);
    expect(created.session.kernel.tools.get("extra")).toBeDefined();
    await sessions.closeAll();
  });
});

describe("toolMiddleware", () => {
  it("sits in front of the session's tools, and can refuse a call", async () => {
    const calls: unknown[] = [];
    const seen: string[] = [];
    const models = fakeModels([
      toolTurn("c1", "mention"),
      answer("understood"),
    ]);
    const sessions = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => models as never,
      sessionTools: () => [recordingTool("mention", calls)],
      toolMiddleware: ({ meta }) => [
        {
          name: `gate-${meta.id}`,
          before: (name) => {
            seen.push(name);
            return { ok: false, blockReason: "not on the list" };
          },
        },
      ],
    });
    const created = await sessions.create({ cwd: "/work" });
    created.session.kernel.inject(userMsg("go"));
    await until(() => models.calls.length === 2);
    await until(() => !created.session.runner.running);

    expect(seen).toEqual(["mention"]);
    expect(calls).toEqual([]);
    // The model was told why, in the tool result it read on the next turn.
    expect(JSON.stringify(models.calls[1]?.context.messages)).toContain(
      "not on the list",
    );
    await sessions.closeAll();
  });
});

describe("askObserve", () => {
  it("tells the host when a question is asked and when it is answered, and still journals the answer", async () => {
    const events: string[] = [];
    const store = new MemorySessionStore();
    const models = fakeModels([
      toolTurn("q1", "ask_user", { question: "Which one?" }),
      answer("thanks"),
    ]);
    const sessions = new SessionManager({
      store,
      modelsFor: () => models as never,
      askObserve: (meta) => (action, payload) => {
        events.push(`${meta.agentId}:${action}:${payload.questionId}`);
      },
    });
    const created = await sessions.create({ cwd: "/work", agentId: "a" });
    created.session.kernel.inject(userMsg("pick"));
    await until(() => created.session.ask?.waiting === true);
    expect(events).toEqual(["a:asked:q1"]);

    expect(
      created.session.ask?.answer("q1", {
        kind: "selection",
        selections: ["left"],
      }),
    ).toBe(true);
    await until(() => !created.session.runner.running);
    expect(events).toEqual(["a:asked:q1", "a:answered:q1"]);

    // The harness's own registry records answers in the journal; the host's registry has to as
    // well, or a replay would ask the same question again.
    await created.session.journaling.flush();
    const entries = await (await store.open(
      created.meta.id,
    ))!.storage.scanEntries({});
    expect(entries.map((entry) => entry.type)).toEqual(
      expect.arrayContaining(["ask", "answer"]),
    );
    await sessions.closeAll();
  });

  it("hears about a question that is abandoned with its run", async () => {
    const events: string[] = [];
    const models = fakeModels([toolTurn("q1", "ask_user", { question: "?" })]);
    const sessions = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => models as never,
      askObserve: () => (action) => {
        events.push(action);
      },
    });
    const created = await sessions.create({ cwd: "/work" });
    created.session.kernel.inject(userMsg("pick"));
    await until(() => created.session.ask?.waiting === true);
    created.session.runner.abort();
    await until(() => !created.session.runner.running);
    expect(events).toEqual(["asked", "canceled"]);
    await sessions.closeAll();
  });

  it("leaves the harness's own registry in place when nobody is watching", async () => {
    const sessions = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => fakeModels([]) as never,
    });
    const created = await sessions.create({ cwd: "/work" });
    expect(created.session.ask).toBeDefined();
    expect(created.session.kernel.tools.get("ask_user")).toBeDefined();
    await sessions.closeAll();
  });
});

describe("assembleServer", () => {
  it("passes the hooks through and lets a host mount its own plugin beside the bundled ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "eta-hooks-"));
    roots.push(root);
    const calls: unknown[] = [];
    const asked: string[] = [];
    const models = fakeModels([
      toolTurn("c1", "mention", { who: "Ada" }),
      toolTurn("q1", "ask_user", { question: "Sure?" }),
      answer("done"),
    ]);
    const server = await assembleServer({
      dataDir: root,
      configPath: join(root, "no-config.json"),
      home: root,
      network: false,
      models: models as never,
      baseSystemPromptFor: () => "HOST PROMPT",
      sessionTools: () => [recordingTool("mention", calls)],
      askObserve: () => (action) => {
        asked.push(action);
      },
    });
    try {
      const applied: string[] = [];
      server.mount("product", {
        name: "product",
        inject: ["wire", "sessions"],
        apply(ctx: { wire: unknown; sessions: unknown }) {
          applied.push(
            `${typeof ctx.wire}/${typeof (ctx.sessions as { prompt?: unknown }).prompt}`,
          );
        },
      });
      // Listed beside the bundled ones, and applied once what it injects exists.
      expect(server.mounted().map((plugin) => plugin.name)).toEqual(
        expect.arrayContaining(["sessions", "providers", "product"]),
      );
      await until(() => applied.length > 0);
      expect(applied).toEqual(["object/function"]);

      const created = await server.sessions.create({ cwd: root });
      created.session.kernel.inject(userMsg("go"));
      await until(() => created.session.ask?.waiting === true);
      expect(models.calls[0]?.context.systemPrompt).toContain("HOST PROMPT");
      expect(calls).toEqual([{ who: "Ada" }]);
      expect(asked).toEqual(["asked"]);
      created.session.ask?.answer("q1", { kind: "freeform", text: "yes" });
      await until(() => !created.session.runner.running);
      expect(asked).toEqual(["asked", "answered"]);
    } finally {
      await server.close();
    }
  });
});
