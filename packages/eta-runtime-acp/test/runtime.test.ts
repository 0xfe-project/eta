/**
 * An eta session on an ACP agent, end to end: a real `SessionManager`, the real ask registry, and
 * the fake agent as a real stdio child speaking the protocol through the same SDK.
 *
 * What these pin: a prompt's updates land in the journal as eta turns while they stream; a tool
 * call becomes a call and its result; a permission request is answered yes at once, and nobody
 * is asked; the process starts in the session's directory; a cancel ends the turn; a process that died is replaced and the agent's
 * session picked up again, three ways; and the model the session is on is set on the agent.
 */
import type { AcpAgentConfig } from "@eta/client-contracts";
import type { AgentMessage, KernelTool } from "@eta/core";
import type { AskObserver } from "@eta/harness";
import type { ManagedSession, SessionManagerOptions } from "@eta/server";
import { realpathSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { kernelOn } from "@eta/core";
import { listenServed } from "@eta/runtime-kit/testing";
import { MemorySessionStore, SessionManager } from "@eta/server";
import { afterEach, describe, expect, it } from "vitest";
import { createAcpRuntimes } from "../src/index";
import { configFile, fakeAgent, until } from "./support";

const textOf = (message: AgentMessage): string =>
  "content" in message && Array.isArray(message.content)
    ? message.content
        .map((block) =>
          block.type === "text"
            ? block.text
            : block.type === "toolCall"
              ? `[${block.name} ${JSON.stringify(block.arguments)}]`
              : "",
        )
        .join("")
    : "";

const transcript = (managed: ManagedSession): string[] =>
  managed.session.journaling
    .transcript()
    .map((message) => `${message.role}:${textOf(message)}`);

const managers: SessionManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.closeAll();
});

function setup(
  agentOptions: Partial<AcpAgentConfig> = {},
  managerOptions: Partial<SessionManagerOptions> = {},
) {
  const agent = fakeAgent("fake", agentOptions);
  const warnings: string[] = [];
  const asked: { action: string; questionId: string; question: string }[] = [];
  const observe: AskObserver = (action, payload) => {
    asked.push({
      action,
      questionId: payload.questionId,
      question: payload.question,
    });
  };
  const runtimes = createAcpRuntimes({
    configPath: configFile([agent.config]),
    warn: (message) => warnings.push(message),
  });
  const store = new MemorySessionStore();
  const manager = new SessionManager({
    store,
    modelsFor: () => {
      throw new Error("an eta model was asked for");
    },
    runtimes,
    askObserve: () => observe,
    agentPromptFor: () => "In this conversation you are Probe.",
    ...managerOptions,
  });
  managers.push(manager);
  return { manager, agent, warnings, asked, runtimes, store };
}

async function run(managed: ManagedSession, prompt: string) {
  managed.session.kernel.nextRun(prompt);
  return await managed.session.runner.run();
}

const stateOf = (managed: ManagedSession) => {
  const last = managed.session.journaling
    .transcript()
    .filter((message) => message.role === "assistant")
    .at(-1);
  return JSON.parse(textOf(last!)) as {
    prompts: number;
    model: string;
    effort: string;
    openedBy: string;
    systemPrompt: string | null;
  };
};

describe("a session on an ACP agent", () => {
  it("publishes the ACP pair while billing stays unknown, then records field coverage", async () => {
    const { manager } = setup();
    const managed = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    await run(managed, "[usage:none]");
    const view = () => managed.session.view.snapshot().sections;
    expect(view().context).toMatchObject({
      source: "acp",
      session: managed.meta.id,
      model: "acp.fake:model-a",
      used: 64000,
      window: 128000,
      reason: null,
    });
    expect(view().spend).toEqual({ input: null, output: null, cache: null });
    await run(
      managed,
      '[usage:{"inputTokens":10,"outputTokens":0,"cachedReadTokens":0,"totalTokens":10}]',
    );
    expect(view().spend).toEqual({
      input: { value: 10, coverage: "partial" },
      output: { value: 0, coverage: "partial" },
      cache: { value: 0, coverage: "partial" },
    });
  });

  it("keeps a silent prompt's explicit zeros and a later gap in coverage", async () => {
    const { manager } = setup();
    const managed = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    const spend = () => managed.session.view.snapshot().sections.spend;
    await run(
      managed,
      '[silent][usage:{"inputTokens":0,"outputTokens":0,"cachedReadTokens":0,"cachedWriteTokens":0,"totalTokens":0}]',
    );
    const zero = { value: 0, coverage: "complete" };
    expect(spend()).toEqual({ input: zero, output: zero, cache: zero });
    await run(managed, "[silent][usage:none]");
    const partial = { value: 0, coverage: "partial" };
    expect(spend()).toEqual({
      input: partial,
      output: partial,
      cache: partial,
    });
  });

  it("streams the agent's turn into the journal as an eta turn", async () => {
    const { manager, agent } = setup();
    const managed = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    const deltas: string[] = [];
    const events: string[] = [];
    const on = kernelOn(managed.session.kernel.ctx);
    on("message:update", ({ event }) => {
      if (event.type === "text_delta") deltas.push(event.delta);
    });
    on("turn:start", () => void events.push("turn:start"));
    on("turn:end", () => void events.push("turn:end"));
    const result = await run(managed, "hello there");
    expect(result.status).toBe("completed");
    // The agent's words arrived in pieces, the first one carrying who it is: it takes no
    // system prompt.
    expect(deltas[0]).toBe("heard: ");
    expect(deltas.join("")).toContain("In this conversation you are Probe.");
    expect(deltas.join("")).toContain("hello there");
    expect(events).toEqual(["turn:start", "turn:end"]);
    const lines = transcript(managed);
    expect(lines[0]).toBe("user:hello there");
    expect(lines[1]).toMatch(/^assistant:heard: <agent>/);
    const message = managed.session.journaling.transcript()[1]!;
    expect(message).toMatchObject({
      role: "assistant",
      provider: "acp.fake",
      model: "model-a",
      stopReason: "stop",
    });
    expect(
      "content" in message &&
        Array.isArray(message.content) &&
        message.content[0],
    ).toMatchObject({ type: "thinking", thinking: "thinking. " });
    // The agent's own session is remembered, and it was opened in the session's directory.
    expect(managed.meta.runtimeSession).toMatch(/^fake-/);
    expect(
      agent.log().find((entry) => entry.method === "session/new"),
    ).toMatchObject({ cwd: "/tmp", mcpServers: [] });
  });

  it("tells a tool call as a call and its result, with the agent's last word on it", async () => {
    const { manager } = setup();
    const managed = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    await run(managed, "first");
    const tools: string[] = [];
    const on = kernelOn(managed.session.kernel.ctx);
    on("tool:start", ({ toolName }) => void tools.push(`start ${toolName}`));
    on(
      "tool:end",
      ({ toolName, isError }) => void tools.push(`end ${toolName} ${isError}`),
    );
    expect((await run(managed, "use a tool")).status).toBe("completed");
    const messages = managed.session.journaling.transcript().slice(2);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(textOf(messages[1]!)).toBe(
      'heard: use a tool[read {"path":"notes.md"}]',
    );
    expect(messages[1]).toMatchObject({ stopReason: "toolUse" });
    expect(messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "t-read",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "the notes" }],
      details: {
        acp: {
          title: "Read notes.md",
          kind: "read",
          locations: [{ path: "notes.md" }],
        },
      },
    });
    expect(textOf(messages[3]!)).toBe(" The notes say hi.");
    expect(tools).toEqual(["start read", "end read false"]);
  });

  it("sets the agent to the session's model and thinking level", async () => {
    const { manager, agent } = setup();
    const managed = await manager.create({
      cwd: "/tmp",
      runtime: "acp.fake",
      model: "acp.fake:model-b",
    });
    managed.session.kernel.config.update({ thinkingLevel: "high" });
    await run(managed, "state");
    expect(stateOf(managed)).toMatchObject({
      model: "model-b",
      effort: "high",
    });
    expect(
      agent
        .log()
        .filter((entry) => entry.method === "session/set_config_option")
        .map((entry) => `${String(entry.configId)}=${String(entry.value)}`),
    ).toEqual(["model=model-b", "effort=high"]);
    expect(managed.session.journaling.transcript().at(-1)).toMatchObject({
      model: "model-b",
    });
  });

  it("hands a system prompt to an agent that takes one", async () => {
    const { manager } = setup({ env: { FAKE_ACP_SYSTEM_PROMPT: "1" } });
    const managed = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    await run(managed, "state");
    expect(stateOf(managed).systemPrompt).toContain(
      "In this conversation you are Probe.",
    );
    expect(transcript(managed)[0]).toBe("user:state");
  });

  it("says why when the agent cannot be started, or is not configured", async () => {
    const { manager } = setup({ command: "/nonexistent/acp-agent" });
    const managed = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    const failed = await run(managed, "hello");
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("/nonexistent/acp-agent is not installed");
    const other = await manager.create({ cwd: "/tmp", runtime: "acp.gone" });
    const unconfigured = await run(other, "hello");
    expect(unconfigured.error).toMatch(
      /the ACP agent gone is not configured on this machine \(.*acp\.json\)/,
    );
  });

  it("says a sign-in is needed, and where to do it", async () => {
    const { manager } = setup({ env: { FAKE_ACP_AUTH: "1" } });
    const managed = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    const failed = await run(managed, "hello");
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/Fake Agent is not signed in.*terminal/);
  });
});

describe("the host's tools", () => {
  const note = {
    name: "note",
    description: "write a note on the board",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
    },
    execute: (args: { text: string }) => ({
      content: [{ type: "text", text: `noted: ${args.text}` }],
    }),
  } as unknown as KernelTool;

  it("reach the agent as an MCP server, and run through the session's middleware", async () => {
    const seen: string[] = [];
    const { manager, agent } = setup(
      {},
      {
        sessionTools: () => [note],
        toolMiddleware: () => [
          {
            name: "probe",
            before: (name, args) => {
              seen.push(`${name} ${JSON.stringify(args)}`);
              return { ok: true, args };
            },
          },
        ],
      },
    );
    const managed = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    expect((await run(managed, "put it on the board")).status).toBe(
      "completed",
    );
    const opened = agent
      .log()
      .find((entry) => entry.method === "session/new") as unknown as {
      mcpServers: { name: string; type?: string; url?: string }[];
    };
    expect(opened.mcpServers).toHaveLength(1);
    expect(opened.mcpServers[0]).toMatchObject({ name: "eta", type: "http" });
    expect(opened.mcpServers[0]!.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(seen).toEqual(['note {"text":"from the agent"}']);
    expect(
      managed.session.journaling
        .transcript()
        .find((message) => message.role === "toolResult"),
    ).toMatchObject({
      isError: false,
      content: [{ type: "text", text: "noted: from the agent" }],
    });
  });

  it("are refused where the host's policy refuses them", async () => {
    const { manager } = setup(
      {},
      {
        sessionTools: () => [note],
        toolMiddleware: () => [
          {
            name: "no-notes",
            before: () => ({ ok: false, blockReason: "notes are closed" }),
          },
        ],
      },
    );
    const managed = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    await run(managed, "put it on the board");
    const result = managed.session.journaling
      .transcript()
      .find((message) => message.role === "toolResult");
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("notes are closed");
  });

  it("are listed anew, with list_changed, when they change mid-session", async () => {
    // A host tool whose definition changes under a running session (#177: a parameter added).
    const state = { description: "pin a note", properties: {} as object };
    const pin = {
      name: "pin",
      get description() {
        return state.description;
      },
      get parameters() {
        return { type: "object", properties: state.properties };
      },
      execute: () => ({ content: [{ type: "text", text: "pinned" }] }),
    } as unknown as KernelTool;
    const { manager, agent } = setup({}, { sessionTools: () => [note, pin] });
    const managed = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    await run(managed, "listing");
    expect(transcript(managed).at(-1)).toBe(
      'assistant:tools: note write a note on the board {"text":{"type":"string"}} | pin pin a note {}',
    );
    const opened = agent
      .log()
      .find((entry) => entry.method === "session/new") as unknown as {
      mcpServers: {
        name: string;
        url: string;
        headers: { name: string; value: string }[];
      }[];
    };
    const eta = opened.mcpServers.find((server) => server.name === "eta")!;
    const stream = await listenServed({
      url: eta.url,
      headers: Object.fromEntries(eta.headers.map((h) => [h.name, h.value])),
    });

    // Nothing changed: nothing is said.
    await run(managed, "listing");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stream.heard).toEqual([]);

    // A parameter is added on the host: the next run serves it and tells the agent.
    state.properties = { at: { type: "string" } };
    await run(managed, "listing");
    expect(transcript(managed).at(-1)).toBe(
      'assistant:tools: note write a note on the board {"text":{"type":"string"}} | pin pin a note {"at":{"type":"string"}}',
    );
    await until(() => stream.heard.length > 0);
    expect(stream.heard).toEqual(["notifications/tools/list_changed"]);

    // A description counts as much as a schema.
    state.description = "pin a note, at a place";
    await run(managed, "listing");
    expect(transcript(managed).at(-1)).toContain("pin pin a note, at a place");
    await until(() => stream.heard.length > 1);

    // One process and one agent session throughout: the list changed, nothing was reopened.
    const seen = agent.log().map((entry) => entry.method);
    expect(seen.filter((method) => method === "started")).toHaveLength(1);
    expect(
      seen.filter((method) => /^session\/(?:new|resume|load)$/.test(method)),
    ).toEqual(["session/new"]);
    stream.close();
  });
});

describe("a permission request", () => {
  it("is allowed at once, this once, and nobody is asked", async () => {
    const { manager, agent, asked } = setup();
    const managed = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    expect((await run(managed, "write it")).status).toBe("completed");
    // Not the session's ask channel, so not the Inbox either.
    expect(asked).toEqual([]);
    expect(managed.session.ask!.pendingAsks()).toEqual([]);
    // The agent's "allow once", not its "always".
    expect(
      agent.log().find((entry) => entry.method === "permission"),
    ).toMatchObject({ outcome: "yes" });
    const result = managed.session.journaling
      .transcript()
      .find((message) => message.role === "toolResult");
    expect(result).toMatchObject({
      isError: false,
      details: {
        acp: { kind: "edit", diffs: [{ path: "out.txt", newText: "hello" }] },
      },
    });
    expect(transcript(managed).at(-1)).toBe("assistant: Written.");
  });

  it("is allowed whatever an older acp.json says about asking", async () => {
    // `autoAllow: false` from a file written before the field went: read past, not obeyed.
    const { manager, agent, asked } = setup({
      autoAllow: false,
    } as Partial<AcpAgentConfig>);
    const managed = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    expect((await run(managed, "write it")).status).toBe("completed");
    expect(asked).toEqual([]);
    expect(
      agent.log().find((entry) => entry.method === "permission"),
    ).toMatchObject({ outcome: "yes" });
  });
});

describe("a permission request after the turn has ended", () => {
  it("is answered cancelled, and nobody is asked", async () => {
    const { manager, agent, asked } = setup();
    const managed = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    expect((await run(managed, "late")).status).toBe("completed");
    // The turn is over: only now does the agent ask.
    writeFileSync(join(agent.dir, "late.go"), "");
    await until(
      () => agent.log().find((entry) => entry.method === "late-permission"),
      "the late request's answer",
    );
    expect(
      agent.log().find((entry) => entry.method === "late-permission"),
    ).toMatchObject({ outcome: "cancelled" });
    expect(asked).toEqual([]);
  });
});

describe("where the agent's process starts", () => {
  it("is the session's directory, whatever an older acp.json says", async () => {
    const { manager, agent } = setup({
      cwd: "/nonexistent-old-cwd",
    } as Partial<AcpAgentConfig>);
    const dir = await mkdtemp(join(tmpdir(), "eta-acp-cwd-"));
    const managed = await manager.create({ cwd: dir, runtime: "acp.fake" });
    expect((await run(managed, "hello")).status).toBe("completed");
    const started = agent.log().find((entry) => entry.method === "started");
    expect(realpathSync(started!.cwd as string)).toBe(realpathSync(dir));
    expect(
      agent.log().find((entry) => entry.method === "session/new"),
    ).toMatchObject({ cwd: dir });
  });
});

describe("cancelling and losing the agent", () => {
  it("cancels the agent's turn, and the session goes on after", async () => {
    const { manager, agent } = setup();
    const managed = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    const running = run(managed, "a slow one");
    await until(
      () => agent.log().some((entry) => entry.method === "session/prompt"),
      "the prompt",
    );
    await until(
      () => transcript(managed).length > 0 && managed.session.runner.running,
      "the run",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    managed.session.runner.abort();
    expect((await running).status).toBe("aborted");
    expect(agent.log().some((entry) => entry.method === "session/cancel")).toBe(
      true,
    );
    expect(
      managed.session.journaling
        .transcript()
        .filter((message) => message.role === "assistant")
        .at(-1),
    ).toMatchObject({ stopReason: "aborted" });
    await run(managed, "state");
    // The same process, the same session: this is its second prompt.
    expect(stateOf(managed)).toMatchObject({ prompts: 2, openedBy: "new" });
    expect(new Set(agent.log().map((entry) => entry.pid)).size).toBe(1);
  });

  it("starts another process and resumes the agent's session when the process was killed", async () => {
    const { manager, agent, warnings } = setup();
    const managed = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    await run(managed, "one");
    const pid = agent.log()[0]!.pid;
    process.kill(pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await run(managed, "state");
    expect(stateOf(managed)).toMatchObject({ prompts: 2, openedBy: "resume" });
    expect(new Set(agent.log().map((entry) => entry.pid)).size).toBe(2);
    expect(warnings.join("\n")).toContain("is gone; starting another");
  });

  it("fails the run the agent died under, and picks up on the next", async () => {
    const { manager } = setup();
    const managed = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    const failed = await run(managed, "die now");
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("Fake Agent failed");
    await run(managed, "state");
    expect(stateOf(managed)).toMatchObject({ prompts: 2, openedBy: "resume" });
  });

  it("resumes when the session is closed and opened again", async () => {
    const { manager, agent } = setup();
    const created = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    await run(created, "one");
    await manager.close(created.meta.id);
    await until(
      () => agent.log().some((entry) => entry.method === "session/close"),
      "the close",
    );
    const reopened = (await manager.session(created.meta.id))!;
    await run(reopened, "state");
    expect(stateOf(reopened)).toMatchObject({ prompts: 2, openedBy: "resume" });
  });

  it("lets an idle agent's process go and picks its session up at the next run", async () => {
    const policy = { idleMs: 60_000, maxResident: 0, everyMs: 3_600_000 };
    for (const caps of ["resume", "load"]) {
      const { manager } = setup(
        { env: { FAKE_ACP_CAPS: caps } },
        { runtimeIdle: policy },
      );
      const managed = await manager.create({
        cwd: "/tmp",
        runtime: "acp.fake",
      });
      await run(managed, "one");
      expect(await manager.sweepRuntimes()).toEqual([]);
      expect(await manager.sweepRuntimes(Date.now() + 120_000)).toEqual([
        managed.meta.id,
      ]);
      await run(managed, "state");
      expect(stateOf(managed)).toMatchObject({ prompts: 2, openedBy: caps });
    }
  });

  it("never lets go of an agent that could not pick its session up again", async () => {
    const { manager } = setup(
      { env: { FAKE_ACP_CAPS: "none" } },
      { runtimeIdle: { idleMs: 60_000, maxResident: 0, everyMs: 3_600_000 } },
    );
    const managed = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    await run(managed, "one");
    expect(await manager.sweepRuntimes(Date.now() + 120_000)).toEqual([]);
    await run(managed, "state");
    expect(stateOf(managed)).toMatchObject({ prompts: 2, openedBy: "new" });
  });

  it("loads where the agent cannot resume, and drops the replay", async () => {
    const { manager } = setup({ env: { FAKE_ACP_CAPS: "load" } });
    const created = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    await run(created, "one");
    await manager.close(created.meta.id);
    const reopened = (await manager.session(created.meta.id))!;
    await run(reopened, "state");
    expect(stateOf(reopened)).toMatchObject({ prompts: 2, openedBy: "load" });
    expect(transcript(reopened).join("\n")).not.toContain("replayed:");
    expect(transcript(reopened)).toHaveLength(4);
  });

  it("starts a new agent session where it can do neither, and says so", async () => {
    const { manager, warnings } = setup({ env: { FAKE_ACP_CAPS: "none" } });
    const created = await manager.create({ cwd: "/tmp", runtime: "acp.fake" });
    await run(created, "one");
    const before = created.meta.runtimeSession;
    await manager.close(created.meta.id);
    const reopened = (await manager.session(created.meta.id))!;
    await run(reopened, "state");
    expect(stateOf(reopened)).toMatchObject({ prompts: 1, openedBy: "new" });
    expect(warnings.join("\n")).toContain("cannot pick a session up again");
    await until(
      () => reopened.meta.runtimeSession !== before,
      "the new session id",
    );
  });
});

describe("the catalog", () => {
  it("lists each configured agent as a runtime with what it can be set to", async () => {
    const good = fakeAgent("good");
    const locked = fakeAgent("locked", { env: { FAKE_ACP_AUTH: "1" } });
    const runtimes = createAcpRuntimes({
      configPath: configFile([
        good.config,
        locked.config,
        {
          id: "gone",
          label: "Gone",
          command: "eta-no-such-acp-agent",
          args: [],
          env: {},
        },
      ]),
    });
    // Before anyone looked: whether the command is there.
    expect(
      runtimes.catalog.snapshot().map((view) => [view.runtime, view.status]),
    ).toEqual([
      ["acp.good", "available"],
      ["acp.locked", "available"],
      ["acp.gone", "missing"],
    ]);
    const list = await runtimes.catalog.list();
    expect(list.map((info) => [info.id, info.label, info.status])).toEqual([
      ["acp.good", "Fake Agent", "available"],
      ["acp.locked", "Fake Agent", "unauthenticated"],
      ["acp.gone", "Gone", "missing"],
    ]);
    expect(list[0]).toMatchObject({
      version: "0.0.1",
      models: [
        {
          id: "model-a",
          name: "Model A",
          default: true,
          efforts: ["low", "high"],
        },
        {
          id: "model-b",
          name: "Model B",
          default: false,
          efforts: ["low", "high"],
        },
      ],
    });
    expect(list[1]!.detail).toMatch(/not signed in \(Run `fake login`\)/);
    expect(list[2]!.detail).toContain("is not installed");
    // Kept: a second listing starts no process.
    const started = good.log().filter((e) => e.method === "started").length;
    await runtimes.catalog.list();
    expect(good.log().filter((e) => e.method === "started")).toHaveLength(
      started,
    );
    expect(runtimes.catalog.stale()).toBe(false);
    runtimes.catalog.invalidate("good");
    expect(runtimes.catalog.stale()).toBe(true);
  });

  it("tests a configuration with a handshake and nothing more", async () => {
    const good = fakeAgent("good");
    const runtimes = createAcpRuntimes({ configPath: configFile([]) });
    expect(await runtimes.catalog.test(good.config)).toEqual({
      ok: true,
      status: "available",
      agentName: "Fake Agent",
      version: "0.0.1",
    });
    expect(good.log().map((entry) => entry.method)).toEqual(["started"]);
    expect(
      await runtimes.catalog.test({ ...good.config, command: "eta-no-such" }),
    ).toMatchObject({ ok: false, status: "missing" });
    expect(
      await runtimes.catalog.test({
        ...good.config,
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
      }),
    ).toMatchObject({ ok: false, status: "error" });
  });
});
