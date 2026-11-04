/**
 * An eta session on an external runtime, end to end, with oar's scripted runtime standing in for
 * Claude Code: no binary, no login, the same `Session` semantics.
 *
 * What these pin: the runtime's turn lands in the session's journal as eta turns (assistant
 * message, tool call, tool result), the model the session is on is the one the runtime is opened
 * with, a model change resumes the same runtime conversation, steering reaches the turn in flight,
 * an abort is an abort, and a reopened session picks its runtime conversation back up.
 */
import type { ScriptedTurn } from "@botiverse/oar/testing";
import type { AgentMessage, KernelTool } from "@eta/core";
import type { ManagedSession, SessionManagerOptions } from "@eta/server";
import { createRuntimeRegistry } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { kernelOn } from "@eta/core";
import { MemorySessionStore, SessionManager } from "@eta/server";
import { describe, expect, it } from "vitest";
import { createOarRuntimes } from "../src/index";

const textOf = (message: AgentMessage): string =>
  "content" in message && Array.isArray(message.content)
    ? message.content
        .map((block) =>
          block.type === "text"
            ? block.text
            : block.type === "toolCall"
              ? `[${block.name}]`
              : "",
        )
        .join("")
    : "";

function setup(
  turn: (turn: ScriptedTurn) => void | Promise<void>,
  options: Partial<SessionManagerOptions> & { refuses?: boolean } = {},
) {
  const { refuses = false, ...managerOptions } = options;
  const turns: ScriptedTurn[] = [];
  const scripted = scriptedRuntime({
    id: "claude",
    turn: async (scriptedTurn) => {
      turns.push(scriptedTurn);
      await turn(scriptedTurn);
    },
  });
  const runtimes = createOarRuntimes({
    registry: createRuntimeRegistry([
      refuses
        ? {
            ...scripted,
            session: scripted.session.bind(scripted),
            refusedSessionOptions: { appendSystemPrompt: "not on this one" },
          }
        : scripted,
    ]),
  });
  const store = new MemorySessionStore();
  const manager = new SessionManager({
    store,
    modelsFor: () => {
      throw new Error("an eta model was asked for");
    },
    runtimes,
    agentPromptFor: () => "In this conversation you are Probe.",
    ...managerOptions,
  });
  return { manager, turns, store };
}

async function run(managed: ManagedSession, prompt: string) {
  const { kernel, runner } = managed.session;
  kernel.nextRun(prompt);
  return await runner.run();
}

const hostTool = (name: string): KernelTool =>
  ({
    name,
    description: `the ${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: () => ({ content: [{ type: "text", text: "done" }] }),
  }) as KernelTool;

const platformFor = (meta: { id: string; cwd: string }) => ({
  cwd: meta.cwd,
  home: "/home/lemon",
  configPath: "/home/lemon/.eta/config.json",
  sessionDir: `/home/lemon/.eta/sessions/${meta.id}`,
  memoryTarget: `${meta.cwd}/.eta/MEMORY.md`,
  memoryExists: false,
});

/** The tools a member of a conversation and the executor of a task are given. */
const MEMBER_TOOLS = [
  "draft_task",
  "create_task",
  "update_task",
  "comment_task",
];
const EXECUTOR_TOOLS = ["update_task", "comment_task", "finish_task"];

/** Names an eta session's tools, or a memory, that a runtime does not have. */
const NOT_ON_A_RUNTIME = [
  "create_step",
  "list_steps",
  "get_step",
  "update_step",
  "memory block",
  "MEMORY.md",
  "persona",
];

const expectNoneOf = (text: string) => {
  // `meta.json`'s own description names the persona field; that is the file, not a card.
  const said = text.replace("(persona, cwd, title, model)", "");
  for (const name of NOT_ON_A_RUNTIME) expect(said).not.toContain(name);
};

const transcript = (managed: ManagedSession): string[] =>
  managed.session.journaling
    .transcript()
    .map((message) => `${message.role}:${textOf(message)}`);

describe("what an external runtime is told about the app", () => {
  it("appends the board's rules and the app's paths to the runtime's system prompt", async () => {
    const { manager, turns } = setup((turn) => turn.say("ok"), {
      platformFor,
      sessionTools: () => MEMBER_TOOLS.map(hostTool),
    });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(managed, "change a line");
    const prompt = turns[0]!.options.appendSystemPrompt ?? "";
    expect(prompt.startsWith("In this conversation you are Probe.")).toBe(true);
    expect(prompt).toContain("<platform>");
    expect(prompt).toContain("Propose it with `draft_task`");
    expect(prompt).toContain("/home/lemon/.eta/config.json");
    expect(prompt).toContain(`/home/lemon/.eta/sessions/${managed.meta.id}`);
    expectNoneOf(prompt);
    expect(prompt).not.toContain("finish_task");
    await manager.closeAll();
  });

  it("puts them in the first prompt of a runtime that refuses a system prompt", async () => {
    const { manager, turns } = setup((turn) => turn.say("ok"), {
      platformFor,
      sessionTools: () => MEMBER_TOOLS.map(hostTool),
      refuses: true,
    });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(managed, "change a line");
    await run(managed, "and another");
    expect(turns[0]!.options.appendSystemPrompt).toBeUndefined();
    expect(turns[0]!.input).toContain("Propose it with `draft_task`");
    expect(turns[0]!.input).toContain("/home/lemon/.eta/config.json");
    expect(turns[0]!.input.endsWith("change a line")).toBe(true);
    expectNoneOf(turns[0]!.input);
    expect(turns[1]!.input).toBe("and another");
    await manager.closeAll();
  });

  it("does not send the executor of a task off to draft it", async () => {
    const { manager, turns } = setup((turn) => turn.say("ok"), {
      platformFor,
      sessionTools: () => EXECUTOR_TOOLS.map(hostTool),
    });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(managed, "do the task");
    const prompt = turns[0]!.options.appendSystemPrompt ?? "";
    expect(prompt).toContain("/home/lemon/.eta/config.json");
    expect(prompt).toContain("This session is one of those");
    expect(prompt).not.toContain("draft_task");
    expect(prompt).not.toContain("create_task");
    expectNoneOf(prompt);
    await manager.closeAll();
  });

  it("tells the rules without the paths on a host that has no platform facts", async () => {
    // A daemon: it has the tools, and the app's config is on the primary.
    const { manager, turns } = setup((turn) => turn.say("ok"), {
      sessionTools: () => MEMBER_TOOLS.map(hostTool),
    });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(managed, "change a line");
    const prompt = turns[0]!.options.appendSystemPrompt ?? "";
    expect(prompt).toContain("Propose it with `draft_task`");
    expect(prompt).not.toContain("readable");
    await manager.closeAll();
  });

  it("is not told again on resume: a session opened before this has to be opened anew", async () => {
    const { manager, turns } = setup((turn) => turn.say("ok"), {
      platformFor,
      sessionTools: () => MEMBER_TOOLS.map(hostTool),
    });
    const created = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(created, "before");
    await manager.close(created.meta.id);
    const reopened = (await manager.session(created.meta.id))!;
    await run(reopened, "after");
    expect(turns[0]!.options.appendSystemPrompt).toContain("draft_task");
    expect(turns[1]!.options.resume).toBeDefined();
    expect(turns[1]!.options.appendSystemPrompt).toBeUndefined();
    await manager.closeAll();
  });
});

describe("a session on an external runtime", () => {
  it("journals the runtime's turn as eta turns", async () => {
    const { manager, turns } = setup(async (turn) => {
      turn.say("Looking.");
      await turn.tool("Bash", '{"command":"ls"}', () => "a.txt");
      turn.say("Done.");
    });
    const managed = await manager.create({
      cwd: "/work",
      runtime: "claude",
      model: "claude:sonnet",
    });
    const tools: string[] = [];
    kernelOn(managed.session.kernel.ctx)("tool:end", ({ toolName, isError }) =>
      tools.push(`${toolName}:${isError}`),
    );
    const result = await run(managed, "list the files");
    expect(result.status).toBe("completed");
    expect(transcript(managed)).toEqual([
      "user:list the files",
      "assistant:Looking.[Bash]",
      "toolResult:a.txt",
      "assistant:Done.",
    ]);
    expect(tools).toEqual(["Bash:false"]);
    expect(turns[0]!.options.model).toBe("sonnet");
    expect(turns[0]!.options.appendSystemPrompt).toBe(
      "In this conversation you are Probe.",
    );
    const meta = (await manager.list()).find(
      (row) => row.id === managed.meta.id,
    );
    expect(meta?.ok && meta.meta.runtimeSession).toBeTruthy();
    await manager.closeAll();
  });

  it("resumes the same runtime conversation on a new model", async () => {
    const { manager, turns } = setup((turn) => turn.say("ok"));
    const managed = await manager.create({
      cwd: "/work",
      runtime: "claude",
      model: "claude:sonnet",
    });
    await run(managed, "one");
    managed.session.kernel.config.update({
      model: { provider: "claude", modelId: "opus" },
    });
    await run(managed, "two");
    expect(turns.map((turn) => turn.options.model)).toEqual(["sonnet", "opus"]);
    expect(turns[1]!.options.resume).toBe(managed.meta.runtimeSession);
    // A resumed conversation keeps its prompt: claude refuses a new one on resume.
    expect(turns[0]!.options.appendSystemPrompt).toBeDefined();
    expect(turns[1]!.options.appendSystemPrompt).toBeUndefined();
    expect(transcript(managed)).toEqual([
      "user:one",
      "assistant:ok",
      "user:two",
      "assistant:ok",
    ]);
    await manager.closeAll();
  });

  it("steers the turn in flight", async () => {
    let steered: readonly string[] = [];
    const { manager } = setup(async (turn) => {
      for (let i = 0; i < 100 && turn.steered.length === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      steered = turn.steered;
      turn.say("heard");
    });
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "start");
    await new Promise((resolve) => setTimeout(resolve, 50));
    managed.session.kernel.steer("and this");
    expect((await running).status).toBe("completed");
    expect(steered).toEqual(["and this"]);
    expect(transcript(managed)).toEqual([
      "user:start",
      "user:and this",
      "assistant:heard",
    ]);
    await manager.closeAll();
  });

  it("aborts the runtime's turn", async () => {
    const { manager } = setup(
      async (turn) =>
        await new Promise<void>((resolve) =>
          turn.signal.addEventListener("abort", () => resolve()),
        ),
    );
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    const running = run(managed, "wait");
    await new Promise((resolve) => setTimeout(resolve, 50));
    managed.session.runner.abort();
    expect((await running).status).toBe("aborted");
    await manager.closeAll();
  });

  it("picks the runtime conversation back up after a close", async () => {
    const { manager, turns } = setup((turn) => turn.say("ok"));
    const created = await manager.create({ cwd: "/work", runtime: "claude" });
    await run(created, "before");
    const native = created.meta.runtimeSession;
    await manager.close(created.meta.id);
    const reopened = (await manager.session(created.meta.id))!;
    await run(reopened, "after");
    expect(turns[1]!.options.resume).toBe(native);
    // A resumed conversation already heard who the agent is.
    expect(transcript(reopened)).toEqual([
      "user:before",
      "assistant:ok",
      "user:after",
      "assistant:ok",
    ]);
    await manager.closeAll();
  });

  it("resolves the runtime's models, and refuses another provider's", async () => {
    const { manager } = setup((turn) => turn.say("ok"));
    const managed = await manager.create({ cwd: "/work", runtime: "claude" });
    expect(managed.session.models.getModel("claude", "opus")?.provider).toBe(
      "claude",
    );
    expect(managed.session.models.getModel("anthropic", "x")).toBeUndefined();
    await manager.closeAll();
  });

  it("will not open a runtime this host does not run", async () => {
    const manager = new SessionManager({
      store: new MemorySessionStore(),
      modelsFor: () => {
        throw new Error("unused");
      },
    });
    await expect(
      manager.create({ cwd: "/work", runtime: "claude" }),
    ).rejects.toThrow(/runtime_unavailable/);
  });
});
