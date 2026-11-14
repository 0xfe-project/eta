/**
 * The toolset a session installs (H11d).
 *
 * A session used to open with *no* tools: every tool existed, every tool was tested,
 * and installing them was left to a host that had not been written. What is pinned
 * here is the battery a session gets, that its names are what the model is told it
 * may call, and that a deployment's own choice of a narrower toolset is not overwritten.
 * File and shell work happens inside the ESM realm, not through harness tools.
 */
import { SessionLog } from "@eta/core/session";
import { MemoryStorage } from "@eta/core/storage";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { AskRegistry } from "../src/ask";
import { openSession } from "../src/open";
import { defineTool } from "../src/tools/tool";

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

const toolCallTurn = (name: string, args: Record<string, unknown> = {}) =>
  assistantMessage({
    stopReason: "toolUse",
    content: [
      { type: "toolCall" as const, id: `c-${name}`, name, arguments: args },
    ],
  });
const stopTurn = (text = "done") =>
  assistantMessage({ content: [{ type: "text", text }] });

const registered = (session: {
  kernel: { tools: { list: () => { name: string }[] } };
}): string[] => session.kernel.tools.list().map((tool) => tool.name);

describe("what a session installs", () => {
  it("installs the standard battery, and says so in activeToolNames", async () => {
    const session = await openSession({
      storage: new MemoryStorage(),
      models: fakeModels([]) as never,
    });
    expect(registered(session).sort()).toEqual(
      ["create_step", "get_step", "list_steps", "update_step"].sort(),
    );
    expect(session.tools).toEqual(registered(session));
    // What the model may call is exactly what was installed.
    expect(session.config.activeToolNames).toEqual(session.tools);
    await session.kernel.dispose();
    session.stop();
  });

  it("installs the ask tool when the session has an ask channel", async () => {
    const session = await openSession({
      storage: new MemoryStorage(),
      models: fakeModels([]) as never,
      ask: true,
    });
    expect(registered(session)).toContain("ask_user");
    expect(session.ask).toBeDefined();
    await session.kernel.dispose();
    session.stop();
  });

  it("records the answer, so a replayed question that was answered is not asked again", async () => {
    const storage = new MemoryStorage();
    const models = fakeModels([
      toolCallTurn("ask_user", { question: "which port?" }),
      stopTurn(),
    ]);
    const session = await openSession({
      storage,
      models: models as never,
      ask: true,
      askTimeoutMs: 5_000,
    });
    session.kernel.inject(userMsg("go"));
    const run = session.runner.run();
    // The UI answers while the tool waits.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [waiting] = session.ask!.pendingAsks();
    expect(waiting?.question).toBe("which port?");
    expect(
      session.ask!.answer(waiting!.questionId, {
        kind: "freeform",
        text: "8080",
      }),
    ).toBe(true);
    await run;
    await session.journaling.flush();

    const entries = await storage.scanEntries({});
    expect(entries.some((entry) => entry.type === "ask")).toBe(true);
    expect(entries.some((entry) => entry.type === "answer")).toBe(true);
    // Both halves are on disk, so a restart knows this question is settled.
    const replaying = new AskRegistry();
    replaying.replay((await SessionLog.load(storage)).graph.pathOldestFirst());
    expect(replaying.pendingAsks()).toEqual([]);
    await session.kernel.dispose();
    session.stop();
  });

  it("appends a caller's own tools after the standard ones", async () => {
    const custom = defineTool({
      name: "custom_echo",
      description: "echo",
      parameters: Type.Object({ text: Type.String() }),
      execute: (args: { text: string }) => ({
        content: [{ type: "text" as const, text: args.text }],
      }),
    });
    const session = await openSession({
      storage: new MemoryStorage(),
      models: fakeModels([]) as never,
      tools: [custom as never],
    });
    expect(registered(session)).toContain("custom_echo");
    expect(session.config.activeToolNames).toContain("custom_echo");
    await session.kernel.dispose();
    session.stop();
  });
});

describe("the journal and the toolset", () => {
  it("records a question before it waits, so a replay still finds it", async () => {
    const storage = new MemoryStorage();
    const models = fakeModels([
      toolCallTurn("ask_user", {
        question: "which port?",
        options: [{ title: "8080" }],
      }),
      stopTurn(),
    ]);
    const session = await openSession({
      storage,
      models: models as never,
      ask: true,
      askTimeoutMs: 50,
    });
    expect(session.ask).toBeDefined();
    session.kernel.inject(userMsg("go"));
    await session.runner.run();
    await session.journaling.flush();

    // The question is an entry (the tool timed out as `none`, which is an answer the
    // model can read rather than a hang)…
    const entries = await storage.scanEntries({});
    expect(entries.some((entry) => entry.type === "ask")).toBe(true);
    expect(JSON.stringify(entries)).toContain("which port?");
    // …and a registry rebuilt over that journal knows what is still waiting.
    const replaying = new AskRegistry();
    replaying.replay((await SessionLog.load(storage)).graph.pathOldestFirst());
    expect(replaying.pendingAsks().map((ask) => ask.question)).toEqual([
      "which port?",
    ]);
    await session.kernel.dispose();
    session.stop();
  });

  it("keeps a narrower toolset a journal already chose", async () => {
    const storage = new MemoryStorage();
    const first = await openSession({
      storage,
      models: fakeModels([]) as never,
    });
    // Somebody narrows the session down to `list_steps` and that decision is journalled.
    first.kernel.config.update({ activeToolNames: ["list_steps"] });
    await first.journaling.flush();
    await first.kernel.dispose();
    first.stop();

    const warnings: string[] = [];
    const again = await openSession({
      storage,
      models: fakeModels([]) as never,
      kernel: { warn: (message) => warnings.push(message) },
    });
    expect(again.config.activeToolNames).toEqual(["list_steps"]);
    // Everything is still installed; the selection is what the model is told.
    expect(registered(again)).toContain("update_step");
    expect(warnings.join(" ")).not.toContain("not installed");
    await again.kernel.dispose();
    again.stop();
  });

  it("carries a session pinned to a renamed tool along to the new name", async () => {
    const storage = new MemoryStorage();
    const first = await openSession({
      storage,
      models: fakeModels([]) as never,
    });
    // A journal written before the rename: the session asked for what is now `create_step`.
    first.kernel.config.update({
      activeToolNames: ["get_step", "TaskCreate", "TaskList"],
    });
    await first.journaling.flush();
    await first.kernel.dispose();
    first.stop();

    const warnings: string[] = [];
    const again = await openSession({
      storage,
      models: fakeModels([]) as never,
      kernel: { warn: (message) => warnings.push(message) },
    });
    // The pin moved with the name, so the run has nothing missing — the alternative is a session
    // that answers `configured_tools_unavailable: TaskCreate` on every run from now on.
    expect(again.config.activeToolNames).toEqual([
      "get_step",
      "create_step",
      "list_steps",
    ]);
    expect(warnings.join(" ")).toContain("TaskCreate → create_step");
    expect(warnings.join(" ")).not.toContain("not installed");
    await again.kernel.dispose();
    again.stop();
  });

  it("drops a pin to a removed tool instead of failing every run", async () => {
    const storage = new MemoryStorage();
    const first = await openSession({
      storage,
      models: fakeModels([]) as never,
    });
    // A journal from before the ESM refactor and the GitHub connection's removal: file, shell,
    // state, subagent and GitHub tools are gone.
    first.kernel.config.update({
      activeToolNames: [
        "read",
        "bash",
        "update_state",
        "Agent",
        "open_pull_request",
        "draft_issue",
        "list_steps",
      ],
    });
    await first.journaling.flush();
    await first.kernel.dispose();
    first.stop();

    const warnings: string[] = [];
    const again = await openSession({
      storage,
      models: fakeModels([]) as never,
      kernel: { warn: (message) => warnings.push(message) },
    });
    expect(again.config.activeToolNames).toEqual(["list_steps"]);
    expect(warnings.join(" ")).toContain("removed tools dropped");
    expect(warnings.join(" ")).not.toContain("not installed");
    await again.kernel.dispose();
    again.stop();
  });

  it("warns when a configured tool is not installed instead of quietly dropping it", async () => {
    const storage = new MemoryStorage();
    const first = await openSession({
      storage,
      models: fakeModels([]) as never,
    });
    first.kernel.config.update({ activeToolNames: ["mystery_tool"] });
    await first.journaling.flush();
    await first.kernel.dispose();
    first.stop();

    const warnings: string[] = [];
    // Same journal: the tool it was configured for is not here.
    const again = await openSession({
      storage,
      models: fakeModels([]) as never,
      kernel: { warn: (message) => warnings.push(message) },
    });
    expect(warnings.join(" ")).toContain("mystery_tool");
    await again.kernel.dispose();
    again.stop();
  });
});
