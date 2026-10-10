import type { RawEvent, Session } from "@botiverse/oar";
import { describe, expect, test } from "bun:test";
import { Agent } from "./agent.ts";

const THREAD = "thread-1";

type Outcome =
  | { kind: "accepted" }
  | { kind: "rejected"; code: string; reason: string };

/** A scripted oar session: the test writes Codex's notifications. */
class FakeSession {
  readonly id = THREAD;
  private observers: ((event: RawEvent) => void)[] = [];
  private seq = 0;
  prompts: { text: string; inputId?: string }[] = [];
  steered: { text: string; inputId?: string }[] = [];
  aborts = 0;
  promptAnswer: Outcome = { kind: "accepted" };
  steerAnswer: () => Promise<Outcome> = async () => ({ kind: "accepted" });

  rawEvents(observer: (event: RawEvent) => void): () => void {
    this.observers.push(observer);
    return () => {};
  }

  async prompt(text: string, options?: { inputId?: string }): Promise<Outcome> {
    this.prompts.push({ text, inputId: options?.inputId });
    return this.promptAnswer;
  }

  async steer(text: string, options?: { inputId?: string }): Promise<Outcome> {
    this.steered.push({ text, inputId: options?.inputId });
    return this.steerAnswer();
  }

  async abort(): Promise<Outcome> {
    this.aborts += 1;
    return { kind: "accepted" };
  }

  frame(type: string, native: unknown, sessionId = THREAD): void {
    this.seq += 1;
    const event = {
      kind: "frame",
      sessionId,
      agentPath: [],
      seq: this.seq,
      receivedAt: 0,
      body: { type, native, events: [] },
    };
    for (const observer of this.observers) {
      observer(event as unknown as RawEvent);
    }
  }

  exit(code: number | null): void {
    const event = {
      kind: "response",
      sessionId: THREAD,
      agentPath: [],
      seq: ++this.seq,
      receivedAt: 0,
      requestId: "",
      body: { kind: "exited", code },
    };
    for (const observer of this.observers) {
      observer(event as unknown as RawEvent);
    }
  }
}

function setUp(timing = { flushMs: 5, steerAnswerMs: 50 }) {
  const session = new FakeSession();
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const agent = new Agent(
    session as unknown as Session,
    (type, payload) => events.push({ type, payload }),
    timing,
  );
  return { session, agent, events, types: () => events.map((e) => e.type) };
}

const turnStarted = (s: FakeSession, id = "turn-1") =>
  s.frame("turn/started", { threadId: THREAD, turn: { id } });
const turnCompleted = (s: FakeSession, status = "completed", id = "turn-1") =>
  s.frame("turn/completed", { threadId: THREAD, turn: { id, status } });

describe("a turn", () => {
  test("reports its start, its items and its end for the command", async () => {
    const { session, agent, events, types } = setUp();
    expect(await agent.prompt("c1", "hi")).toEqual({ accepted: true });
    expect(session.prompts).toEqual([{ text: "hi", inputId: "c1" }]);
    turnStarted(session);
    await agent.settled();
    session.frame("item/agentMessage/delta", { itemId: "m1", delta: "Hel" });
    session.frame("item/agentMessage/delta", { itemId: "m1", delta: "lo" });
    session.frame("item/started", {
      item: {
        id: "x1",
        type: "commandExecution",
        command: "ls",
        status: "inProgress",
      },
    });
    session.frame("item/completed", {
      item: {
        id: "x1",
        type: "commandExecution",
        command: "ls",
        aggregatedOutput: "a\nb",
        status: "completed",
      },
    });
    session.frame("item/completed", {
      item: { id: "m1", type: "agentMessage", text: "Hello" },
    });
    turnCompleted(session);
    await agent.settled();
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
    expect(events[4]!.payload.item).toEqual({
      id: "m1",
      kind: "agent_message",
      status: "completed",
      text: "Hello",
    });
    expect(events[5]!.payload).toEqual({
      command_id: "c1",
      turn_id: "turn-1",
      status: "completed",
    });
    expect(agent.status()).toEqual({ command_id: null, turn_id: null });
  });

  test("streams text between items at most every flush", async () => {
    const { session, agent, events } = setUp({
      flushMs: 20,
      steerAnswerMs: 50,
    });
    await agent.prompt("c1", "hi");
    turnStarted(session);
    await agent.settled();
    session.frame("item/agentMessage/delta", { itemId: "m1", delta: "a" });
    session.frame("item/agentMessage/delta", { itemId: "m1", delta: "b" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await agent.settled();
    expect(
      events
        .filter((e) => e.type === "item.updated")
        .map((e) => (e.payload.item as { text: string }).text),
    ).toEqual(["ab"]);
  });

  test("an interrupted or failed turn says so", async () => {
    const { session, agent, events } = setUp();
    await agent.prompt("c1", "hi");
    turnStarted(session);
    await agent.settled();
    turnCompleted(session, "interrupted");
    await agent.settled();
    await agent.prompt("c2", "again");
    turnStarted(session, "turn-2");
    await agent.settled();
    turnCompleted(session, "failed", "turn-2");
    await agent.settled();
    expect(
      events
        .filter((e) => e.type === "turn.completed")
        .map((e) => e.payload.status),
    ).toEqual(["interrupted", "failed"]);
  });

  test("sub-agents' threads stay out of the transcript", async () => {
    const { session, agent, types } = setUp();
    await agent.prompt("c1", "hi");
    turnStarted(session);
    await agent.settled();
    session.frame(
      "item/completed",
      { item: { id: "m9", type: "agentMessage", text: "child" } },
      "child-thread",
    );
    turnCompleted(session);
    await agent.settled();
    expect(types()).toEqual(["turn.started", "turn.completed"]);
  });

  test("Codex exiting is reported", async () => {
    const { session, agent } = setUp();
    let exited: number | null | undefined;
    agent.onExit = (code) => (exited = code);
    session.exit(1);
    await agent.settled();
    expect(exited).toBe(1);
  });
});

describe("prompts", () => {
  test("one turn at a time", async () => {
    const { session, agent } = setUp();
    await agent.prompt("c1", "hi");
    turnStarted(session);
    await agent.settled();
    expect(await agent.prompt("c2", "more")).toEqual({
      accepted: false,
      code: "busy",
    });
    expect(session.prompts.length).toBe(1);
  });

  test("asking again for the same command changes nothing", async () => {
    const { session, agent } = setUp();
    await agent.prompt("c1", "hi");
    expect(await agent.prompt("c1", "hi")).toEqual({ accepted: true });
    expect(session.prompts.length).toBe(1);
  });

  test("a prompt Codex refuses leaves the session free", async () => {
    const { session, agent } = setUp();
    session.promptAnswer = {
      kind: "rejected",
      code: "runtime_refused",
      reason: "no",
    };
    expect(await agent.prompt("c1", "hi")).toEqual({
      accepted: false,
      code: "runtime_refused",
      reason: "no",
    });
    session.promptAnswer = { kind: "accepted" };
    expect(await agent.prompt("c2", "hi")).toEqual({ accepted: true });
  });
});

describe("steers", () => {
  test("join the running turn, which then answers them", async () => {
    const { session, agent, events } = setUp();
    await agent.prompt("c1", "hi");
    turnStarted(session);
    await agent.settled();
    expect(await agent.steer("s1", "also this")).toEqual({ accepted: true });
    expect(session.steered).toEqual([{ text: "also this", inputId: "s1" }]);
    session.frame("item/started", {
      item: { id: "u1", type: "userMessage", clientId: "s1" },
    });
    session.frame("item/completed", {
      item: { id: "m1", type: "agentMessage", text: "done" },
    });
    turnCompleted(session);
    await agent.settled();
    expect(events.map((e) => [e.type, e.payload.command_id])).toEqual([
      ["turn.started", "c1"],
      ["turn.steered", "c1"],
      ["item.updated", "s1"],
      ["turn.completed", "s1"],
    ]);
    expect(events[1]!.payload).toEqual({
      command_id: "c1",
      steer_command_id: "s1",
      turn_id: "turn-1",
    });
  });

  test("an accepted steer Codex never echoed still belongs to the turn", async () => {
    const { session, agent, events } = setUp();
    await agent.prompt("c1", "hi");
    turnStarted(session);
    await agent.settled();
    await agent.steer("s1", "also this");
    turnCompleted(session);
    await agent.settled();
    expect(events.map((e) => [e.type, e.payload.command_id])).toEqual([
      ["turn.started", "c1"],
      ["turn.steered", "c1"],
      ["turn.completed", "s1"],
    ]);
  });

  test("a steer still unanswered at the turn's end is waited for", async () => {
    const { session, agent, events } = setUp();
    let refuse: (outcome: Outcome) => void = () => {};
    session.steerAnswer = () => new Promise((resolve) => (refuse = resolve));
    await agent.prompt("c1", "hi");
    turnStarted(session);
    await agent.settled();
    const steered = agent.steer("s1", "too late");
    turnCompleted(session);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events.map((e) => e.type)).toEqual(["turn.started"]);
    refuse({
      kind: "rejected",
      code: "runtime_refused",
      reason: "not_steerable",
    });
    expect(await steered).toEqual({
      accepted: false,
      code: "runtime_refused",
      reason: "not_steerable",
    });
    await agent.settled();
    expect(events.map((e) => [e.type, e.payload.command_id])).toEqual([
      ["turn.started", "c1"],
      ["turn.completed", "c1"],
    ]);
  });

  test("need a running turn", async () => {
    const { agent, session } = setUp();
    expect(await agent.steer("s1", "hi")).toEqual({
      accepted: false,
      code: "no_active_turn",
    });
    await agent.prompt("c1", "hi");
    expect(await agent.steer("s1", "hi")).toEqual({
      accepted: false,
      code: "no_active_turn",
    });
    expect(session.steered).toEqual([]);
  });
});

describe("stops", () => {
  test("interrupt the running turn", async () => {
    const { session, agent } = setUp();
    await agent.prompt("c1", "hi");
    turnStarted(session);
    await agent.settled();
    await agent.abort("c1");
    expect(session.aborts).toBe(1);
  });

  test("before the turn started, interrupt it once it does", async () => {
    const { session, agent } = setUp();
    await agent.prompt("c1", "hi");
    await agent.abort("c1");
    expect(session.aborts).toBe(0);
    turnStarted(session);
    await agent.settled();
    expect(session.aborts).toBe(1);
  });

  test("of a steer not yet taken in interrupt the turn when it takes over", async () => {
    const { session, agent, events } = setUp();
    await agent.prompt("c1", "hi");
    turnStarted(session);
    await agent.settled();
    await agent.steer("s1", "also");
    await agent.abort("s1");
    expect(session.aborts).toBe(0);
    session.frame("item/started", {
      item: { id: "u1", type: "userMessage", clientId: "s1" },
    });
    await agent.settled();
    expect(session.aborts).toBe(1);
    expect(events.at(-1)!.type).toBe("turn.steered");
  });

  test("of other commands do nothing", async () => {
    const { session, agent } = setUp();
    await agent.prompt("c1", "hi");
    turnStarted(session);
    await agent.settled();
    await agent.abort("c2");
    expect(session.aborts).toBe(0);
  });
});
