import type { Codex, Notification, Request } from "./appserver.ts";
import { describe, expect, test } from "bun:test";
import { Agent } from "./agent.ts";
import { RpcError } from "./appserver.ts";
import { openThread } from "./thread.ts";

const THREAD = "thread-1";

/** A scripted app-server: the test writes Codex's notifications and requests. */
class FakeCodex implements Codex {
  requests: { method: string; params: Record<string, unknown> }[] = [];
  answers: Record<
    string,
    (params: Record<string, unknown>) => Promise<unknown>
  > = {};
  private notified: (n: Notification) => void = () => {};
  private asked: (r: Request) => Promise<unknown> = async () => ({});
  private exit: (code: number | null) => void = () => {};
  readonly exited = new Promise<number | null>(
    (resolve) => (this.exit = resolve),
  );

  request = (async (method: string, params: Record<string, unknown>) => {
    this.requests.push({ method, params });
    const answer = this.answers[method];
    return answer ? answer(params) : {};
  }) as Codex["request"];

  onNotification(handler: (n: Notification) => void): void {
    this.notified = handler;
  }

  onRequest(handler: (r: Request) => Promise<unknown>): void {
    this.asked = handler;
  }

  close(): void {}

  notify(method: string, params: Record<string, unknown>): void {
    this.notified({ method, params } as Notification);
  }

  ask(
    method: string,
    params: Record<string, unknown>,
    id: number | string = 7,
  ): Promise<unknown> {
    return this.asked({ method, id, params } as Request);
  }

  die(code: number | null): void {
    this.exit(code);
  }

  sent(method: string) {
    return this.requests
      .filter((r) => r.method === method)
      .map((r) => r.params);
  }
}

function setUp(timing = { flushMs: 5, steerAnswerMs: 50 }) {
  const codex = new FakeCodex();
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const agent = new Agent(
    codex,
    THREAD,
    (type, payload) => events.push({ type, payload }),
    timing,
  );
  const types = () => events.map((e) => e.type);
  const turnStarted = async (id = "turn-1") => {
    codex.notify("turn/started", { threadId: THREAD, turn: { id } });
    await agent.settled();
  };
  const turnCompleted = async (status = "completed", id = "turn-1") => {
    codex.notify("turn/completed", { threadId: THREAD, turn: { id, status } });
    await agent.settled();
  };
  const item = async (
    method: string,
    item: Record<string, unknown>,
    threadId = THREAD,
  ) => {
    codex.notify(method, { threadId, turnId: "turn-1", item });
    await agent.settled();
  };
  return { codex, agent, events, types, turnStarted, turnCompleted, item };
}

describe("a turn", () => {
  test("reports its start, its items and its end for the command", async () => {
    const { codex, agent, events, types, turnStarted, turnCompleted, item } =
      setUp();
    expect(await agent.prompt("c1", "hi")).toEqual({ accepted: true });
    expect(codex.sent("turn/start")).toEqual([
      {
        threadId: THREAD,
        clientUserMessageId: "c1",
        input: [{ type: "text", text: "hi", text_elements: [] }],
      },
    ]);
    await turnStarted();
    codex.notify("item/agentMessage/delta", {
      threadId: THREAD,
      itemId: "m1",
      delta: "Hel",
    });
    codex.notify("item/agentMessage/delta", {
      threadId: THREAD,
      itemId: "m1",
      delta: "lo",
    });
    await item("item/started", {
      id: "x1",
      type: "commandExecution",
      command: "ls",
      status: "inProgress",
    });
    await item("item/completed", {
      id: "x1",
      type: "commandExecution",
      command: "ls",
      aggregatedOutput: "a\nb",
      status: "completed",
    });
    await item("item/completed", {
      id: "m1",
      type: "agentMessage",
      text: "Hello",
    });
    await turnCompleted();
    expect(types()).toEqual([
      "turn.started",
      "item.updated",
      "item.updated",
      "item.updated",
      "item.updated",
      "turn.completed",
    ]);
    expect(events[1]!.payload).toEqual({
      command_id: "c1",
      item: {
        id: "m1",
        kind: "agent_message",
        status: "running",
        text: "Hello",
      },
    });
    expect(events[3]!.payload.item).toEqual({
      id: "x1",
      kind: "command",
      status: "completed",
      input: "ls",
      output: "a\nb",
    });
    expect(events[5]!.payload).toEqual({
      command_id: "c1",
      turn_id: "turn-1",
      status: "completed",
    });
    expect(agent.status()).toEqual({ command_id: null, turn_id: null });
  });

  test("streams text between items at most every flush", async () => {
    const { codex, agent, events, turnStarted } = setUp({
      flushMs: 20,
      steerAnswerMs: 50,
    });
    await agent.prompt("c1", "hi");
    await turnStarted();
    codex.notify("item/agentMessage/delta", {
      threadId: THREAD,
      itemId: "m1",
      delta: "a",
    });
    codex.notify("item/agentMessage/delta", {
      threadId: THREAD,
      itemId: "m1",
      delta: "b",
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await agent.settled();
    expect(
      events
        .filter((e) => e.type === "item.updated")
        .map((e) => (e.payload.item as { text: string }).text),
    ).toEqual(["ab"]);
  });

  test("an interrupted or failed turn says so", async () => {
    const { agent, events, turnStarted, turnCompleted } = setUp();
    await agent.prompt("c1", "hi");
    await turnStarted();
    await turnCompleted("interrupted");
    await agent.prompt("c2", "again");
    await turnStarted("turn-2");
    await turnCompleted("failed", "turn-2");
    expect(
      events
        .filter((e) => e.type === "turn.completed")
        .map((e) => e.payload.status),
    ).toEqual(["interrupted", "failed"]);
  });

  test("sub-agents' threads stay out of the transcript", async () => {
    const { agent, types, turnStarted, turnCompleted, item } = setUp();
    await agent.prompt("c1", "hi");
    await turnStarted();
    await item(
      "item/completed",
      { id: "m9", type: "agentMessage", text: "child" },
      "child-thread",
    );
    await turnCompleted();
    expect(types()).toEqual(["turn.started", "turn.completed"]);
  });

  test("compacting is a turn of its own", async () => {
    const { codex, agent, events, turnStarted, turnCompleted, item } = setUp();
    expect(await agent.prompt("c1", "/compact", "compact")).toEqual({
      accepted: true,
    });
    expect(codex.sent("thread/compact/start")).toEqual([{ threadId: THREAD }]);
    await turnStarted();
    await item("item/completed", { id: "k1", type: "contextCompaction" });
    await turnCompleted();
    expect(events.map((e) => [e.type, e.payload.command_id])).toEqual([
      ["turn.started", "c1"],
      ["item.updated", "c1"],
      ["turn.completed", "c1"],
    ]);
  });

  test("Codex exiting is reported", async () => {
    const { codex, agent } = setUp();
    let exited: number | null | undefined;
    agent.onExit = (code) => (exited = code);
    codex.die(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exited).toBe(1);
  });
});

describe("prompts", () => {
  test("one turn at a time", async () => {
    const { codex, agent, turnStarted } = setUp();
    await agent.prompt("c1", "hi");
    await turnStarted();
    expect(await agent.prompt("c2", "more")).toEqual({
      accepted: false,
      code: "busy",
    });
    expect(codex.sent("turn/start").length).toBe(1);
  });

  test("asking again for the same command changes nothing", async () => {
    const { codex, agent } = setUp();
    await agent.prompt("c1", "hi");
    expect(await agent.prompt("c1", "hi")).toEqual({ accepted: true });
    expect(codex.sent("turn/start").length).toBe(1);
  });

  test("a prompt Codex refuses leaves the thread free", async () => {
    const { codex, agent } = setUp();
    codex.answers["turn/start"] = async () => {
      throw new RpcError("turn/start", -32600, "no");
    };
    const refused = await agent.prompt("c1", "hi");
    expect(refused).toMatchObject({ accepted: false, code: "runtime_refused" });
    delete codex.answers["turn/start"];
    expect(await agent.prompt("c2", "hi")).toEqual({ accepted: true });
  });
});

describe("steers", () => {
  test("join the running turn, which then answers them", async () => {
    const { codex, agent, events, turnStarted, turnCompleted, item } = setUp();
    await agent.prompt("c1", "hi");
    await turnStarted();
    expect(await agent.steer("s1", "also this")).toEqual({ accepted: true });
    expect(codex.sent("turn/steer")).toEqual([
      {
        threadId: THREAD,
        expectedTurnId: "turn-1",
        clientUserMessageId: "s1",
        input: [{ type: "text", text: "also this", text_elements: [] }],
      },
    ]);
    await item("item/started", {
      id: "u1",
      type: "userMessage",
      clientId: "s1",
    });
    await item("item/completed", {
      id: "m1",
      type: "agentMessage",
      text: "done",
    });
    await turnCompleted();
    expect(events.map((e) => [e.type, e.payload.command_id])).toEqual([
      ["turn.started", "c1"],
      ["turn.steered", "c1"],
      ["item.updated", "s1"],
      ["turn.completed", "s1"],
    ]);
  });

  test("an accepted steer Codex never echoed still belongs to the turn", async () => {
    const { agent, events, turnStarted, turnCompleted } = setUp();
    await agent.prompt("c1", "hi");
    await turnStarted();
    await agent.steer("s1", "also this");
    await turnCompleted();
    expect(events.map((e) => [e.type, e.payload.command_id])).toEqual([
      ["turn.started", "c1"],
      ["turn.steered", "c1"],
      ["turn.completed", "s1"],
    ]);
  });

  test("a steer still unanswered at the turn's end is waited for", async () => {
    const { codex, agent, events, turnStarted } = setUp();
    let refuse: () => void = () => {};
    codex.answers["turn/steer"] = () =>
      new Promise(
        (_, reject) =>
          (refuse = () =>
            reject(new RpcError("turn/steer", -32600, "not steerable"))),
      );
    await agent.prompt("c1", "hi");
    await turnStarted();
    const steered = agent.steer("s1", "too late");
    codex.notify("turn/completed", {
      threadId: THREAD,
      turn: { id: "turn-1", status: "completed" },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events.map((e) => e.type)).toEqual(["turn.started"]);
    refuse();
    expect(await steered).toMatchObject({
      accepted: false,
      code: "runtime_refused",
    });
    await agent.settled();
    expect(events.map((e) => [e.type, e.payload.command_id])).toEqual([
      ["turn.started", "c1"],
      ["turn.completed", "c1"],
    ]);
  });

  test("need a running turn", async () => {
    const { codex, agent } = setUp();
    expect(await agent.steer("s1", "hi")).toEqual({
      accepted: false,
      code: "no_active_turn",
    });
    await agent.prompt("c1", "hi");
    expect(await agent.steer("s1", "hi")).toEqual({
      accepted: false,
      code: "no_active_turn",
    });
    expect(codex.sent("turn/steer")).toEqual([]);
  });
});

describe("stops", () => {
  test("interrupt the running turn", async () => {
    const { codex, agent, turnStarted } = setUp();
    await agent.prompt("c1", "hi");
    await turnStarted();
    await agent.abort("c1");
    expect(codex.sent("turn/interrupt")).toEqual([
      { threadId: THREAD, turnId: "turn-1" },
    ]);
  });

  test("before the turn started, interrupt it once it does", async () => {
    const { codex, agent, turnStarted } = setUp();
    await agent.prompt("c1", "hi");
    await agent.abort("c1");
    expect(codex.sent("turn/interrupt")).toEqual([]);
    await turnStarted();
    expect(codex.sent("turn/interrupt").length).toBe(1);
  });

  test("of a steer not yet taken in interrupt the turn when it takes over", async () => {
    const { codex, agent, events, turnStarted, item } = setUp();
    await agent.prompt("c1", "hi");
    await turnStarted();
    await agent.steer("s1", "also");
    await agent.abort("s1");
    expect(codex.sent("turn/interrupt")).toEqual([]);
    await item("item/started", {
      id: "u1",
      type: "userMessage",
      clientId: "s1",
    });
    expect(codex.sent("turn/interrupt").length).toBe(1);
    expect(events.at(-1)!.type).toBe("turn.steered");
  });

  test("of other commands do nothing", async () => {
    const { codex, agent, turnStarted } = setUp();
    await agent.prompt("c1", "hi");
    await turnStarted();
    await agent.abort("c2");
    expect(codex.sent("turn/interrupt")).toEqual([]);
  });
});

describe("approvals", () => {
  async function asking(method: string, params: Record<string, unknown>) {
    const s = setUp();
    await s.agent.prompt("c1", "hi");
    await s.turnStarted();
    const answer = s.codex.ask(method, {
      threadId: THREAD,
      turnId: "turn-1",
      ...params,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const requested = s.events.find((e) => e.type === "approval.requested")!;
    return {
      ...s,
      answer,
      requested,
      approvalId: requested?.payload.approval_id as string,
    };
  }

  test("a command waits for the user's decision", async () => {
    const { agent, answer, requested, approvalId, events } = await asking(
      "item/commandExecution/requestApproval",
      {
        itemId: "x1",
        command: "rm -rf build",
        reason: "clean up",
      },
    );
    expect(requested.payload).toEqual({
      approval_id: approvalId,
      command_id: "c1",
      kind: "command",
      summary: { reason: "clean up", command: "rm -rf build" },
    });
    expect(agent.decide(approvalId, "accept")).toBe("accepted");
    expect(await answer).toEqual({ decision: "accept" });
    expect(events.at(-1)).toEqual({
      type: "approval.applied",
      payload: { approval_id: approvalId, decision: "accept" },
    });
    expect(agent.decide(approvalId, "accept")).toBe("not_pending");
  });

  test("a file change can be declined", async () => {
    const { agent, answer, approvalId } = await asking(
      "item/fileChange/requestApproval",
      { itemId: "f1" },
    );
    agent.decide(approvalId, "decline");
    expect(await answer).toEqual({ decision: "decline" });
  });

  test("a plugin's confirmation is a form without fields", async () => {
    const { agent, answer, requested, approvalId } = await asking(
      "mcpServer/elicitation/request",
      {
        serverName: "approval",
        mode: "form",
        message: "删除表？",
        requestedSchema: { type: "object", properties: {} },
        _meta: null,
      },
    );
    expect(requested.payload.summary).toEqual({
      server: "approval",
      message: "删除表？",
    });
    agent.decide(approvalId, "accept");
    expect(await answer).toEqual({
      action: "accept",
      content: {},
      _meta: null,
    });
  });

  test("forms with fields are declined without asking", async () => {
    const { answer, requested } = await asking(
      "mcpServer/elicitation/request",
      {
        serverName: "x",
        mode: "form",
        message: "name?",
        requestedSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
        _meta: null,
      },
    );
    expect(requested).toBeUndefined();
    expect(await answer).toEqual({
      action: "decline",
      content: null,
      _meta: null,
    });
  });

  test("stopping cancels the command approval, which ends the turn", async () => {
    const { codex, agent, answer } = await asking(
      "item/commandExecution/requestApproval",
      { itemId: "x1", command: "ls" },
    );
    await agent.abort("c1");
    expect(await answer).toEqual({ decision: "cancel" });
    expect(codex.sent("turn/interrupt")).toEqual([]);
  });

  test("stopping cancels a plugin's confirmation and interrupts the turn", async () => {
    const { codex, agent, answer } = await asking(
      "mcpServer/elicitation/request",
      {
        serverName: "approval",
        mode: "form",
        message: "ok?",
        requestedSchema: { type: "object", properties: {} },
        _meta: null,
      },
    );
    await agent.abort("c1");
    expect(await answer).toEqual({
      action: "cancel",
      content: null,
      _meta: null,
    });
    expect(codex.sent("turn/interrupt").length).toBe(1);
  });

  test("one Codex withdraws is cancelled", async () => {
    const { codex, agent, answer } = await asking(
      "item/commandExecution/requestApproval",
      { itemId: "x1", command: "ls" },
    );
    codex.notify("serverRequest/resolved", { threadId: THREAD, requestId: 7 });
    await agent.settled();
    expect(await answer).toEqual({ decision: "cancel" });
  });

  test("other requests get a conservative no", async () => {
    const { codex } = setUp();
    expect(await codex.ask("item/tool/requestUserInput", {})).toEqual({
      answers: {},
    });
    expect(await codex.ask("item/tool/call", {})).toEqual({
      contentItems: [],
      success: false,
    });
  });

  test("with no command running, a request is declined", async () => {
    const { codex } = setUp();
    expect(
      await codex.ask("item/commandExecution/requestApproval", {
        command: "ls",
      }),
    ).toEqual({ decision: "decline" });
  });
});

describe("the agent's thread", () => {
  const settings = {
    workspace: "/agent/workspace",
    model: "m",
    instructions: "be brief",
  };

  test("is the workspace's latest root thread, resumed", async () => {
    const codex = new FakeCodex();
    codex.answers["thread/list"] = async () => ({
      data: [
        { id: "child", parentThreadId: "root", ephemeral: false },
        { id: "root", parentThreadId: null, ephemeral: false },
      ],
    });
    expect(await openThread(codex, settings)).toEqual({
      threadId: "root",
      resumed: true,
    });
    expect(codex.sent("thread/list")[0]).toMatchObject({
      cwd: "/agent/workspace",
      sortKey: "updated_at",
      sortDirection: "desc",
    });
    expect(codex.sent("thread/resume")).toEqual([
      {
        threadId: "root",
        excludeTurns: true,
        cwd: "/agent/workspace",
        model: "m",
        developerInstructions: "be brief",
      },
    ]);
  });

  test("is started when there is none yet", async () => {
    const codex = new FakeCodex();
    codex.answers["thread/list"] = async () => ({ data: [] });
    codex.answers["thread/start"] = async () => ({ thread: { id: "new" } });
    expect(await openThread(codex, settings)).toEqual({
      threadId: "new",
      resumed: false,
    });
  });

  test("is never replaced when it cannot be resumed", async () => {
    const codex = new FakeCodex();
    codex.answers["thread/list"] = async () => ({
      data: [{ id: "root", parentThreadId: null, ephemeral: false }],
    });
    codex.answers["thread/resume"] = async () => {
      throw new RpcError("thread/resume", -32600, "broken");
    };
    await expect(openThread(codex, settings)).rejects.toThrow("broken");
    expect(codex.sent("thread/start")).toEqual([]);
  });
});
