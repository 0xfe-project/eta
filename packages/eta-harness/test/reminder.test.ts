import type { AssistantMessage } from "@eta/core";
/**
 * TaskReminderService (ported from eta-agent's createReminderHooks + cadence.ts).
 *
 * The cadence arithmetic lives beside the harness service (and is tested separately); what is pinned here is
 * the service: it counts turns from the bus, resets on a task-tool call, reports
 * a due reminder once per cycle, and never reminds without tasks. The service
 * lives in the harness, so the test wires it the way an assembler does.
 */
import { Kernel, kernelEmit, kernelOn, Runner } from "@eta/core";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { DEFAULT_REMINDER_INTERVAL, TaskReminderService } from "../src/index";

/** What the runner reports for a context: no parts, all zeroes. */
const EMPTY_PARTS = {
  system: 0,
  persona: 0,
  user: 0,
  assistant: 0,
  toolDefs: 0,
  total: 0,
};

const toolTurn = (calls: { id: string; name: string }[]): AssistantMessage =>
  assistantMessage({
    stopReason: "toolUse",
    content: calls.map((call) => ({
      type: "toolCall" as const,
      ...call,
      arguments: {},
    })),
  });

const userMsg = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
  timestamp: 0,
});

describe("taskReminderService", () => {
  function session() {
    const kernel = Kernel.create({
      config: { model: { provider: "p", modelId: "m" } },
    });
    const taskReminder = new TaskReminderService(kernel.ctx, {
      tasks: kernel.tasks,
    });
    const due: number[] = [];
    const off = kernelOn(kernel.ctx)("task:reminder-due", (event) => {
      due.push(event.turn);
    });
    // The task tools a deployment registers; the cadence resets on their use.
    kernel.tools.register({ name: "TaskUpdate", execute: () => "ok" });
    kernel.tools.register({ name: "read", execute: () => "ok" });
    return {
      kernel,
      taskReminder,
      due,
      emit: kernelEmit(kernel.ctx),
      dispose: () => {
        off();
        void kernel.dispose();
      },
    };
  }

  it("counts turns from the bus and reports a due reminder once", () => {
    const s = session();
    s.kernel.tasks.create("review me");
    // Five tool-free turns: the cadence counts turns, not tools.
    for (let turn = 1; turn <= DEFAULT_REMINDER_INTERVAL; turn += 1) {
      s.emit("turn:start", {
        runId: "r",
        turnId: `t${turn}`,
        contextParts: EMPTY_PARTS,
      });
    }
    s.emit("tool:end", {
      runId: "r",
      turnId: "t5",
      toolCallId: "c",
      toolName: "read",
      result: "x",
      isError: false,
      terminate: false,
      durationMs: 1,
    });
    expect(s.due).toEqual([DEFAULT_REMINDER_INTERVAL]);
    // It is due once per cycle: draining takes it, then the cadence is quiet.
    expect(s.taskReminder.drain()).toBe(true);
    expect(s.taskReminder.drain()).toBe(false);
    s.dispose();
  });

  it("a task-tool call resets the cadence", () => {
    const s = session();
    s.kernel.tasks.create("review me");
    for (let turn = 1; turn <= 3; turn += 1) {
      s.emit("turn:start", {
        runId: "r",
        turnId: `t${turn}`,
        contextParts: EMPTY_PARTS,
      });
    }
    // Touching a task tool resets it, so the next due turn is five later.
    s.emit("tool:end", {
      runId: "r",
      turnId: "t3",
      toolCallId: "c",
      toolName: "TaskUpdate",
      result: "x",
      isError: false,
      terminate: false,
      durationMs: 1,
    });
    for (let turn = 4; turn <= 7; turn += 1) {
      s.emit("turn:start", {
        runId: "r",
        turnId: `t${turn}`,
        contextParts: EMPTY_PARTS,
      });
    }
    s.emit("tool:end", {
      runId: "r",
      turnId: "t7",
      toolCallId: "c2",
      toolName: "read",
      result: "x",
      isError: false,
      terminate: false,
      durationMs: 1,
    });
    expect(s.due).toEqual([]);
    s.emit("turn:start", {
      runId: "r",
      turnId: "t8",
      contextParts: EMPTY_PARTS,
    });
    s.emit("tool:end", {
      runId: "r",
      turnId: "t8",
      toolCallId: "c3",
      toolName: "read",
      result: "x",
      isError: false,
      terminate: false,
      durationMs: 1,
    });
    expect(s.due).toEqual([8]);
    s.dispose();
  });

  it("never reminds when there are no tasks", () => {
    const s = session();
    for (let turn = 1; turn <= 20; turn += 1) {
      s.emit("turn:start", {
        runId: "r",
        turnId: `t${turn}`,
        contextParts: EMPTY_PARTS,
      });
    }
    s.emit("tool:end", {
      runId: "r",
      turnId: "t20",
      toolCallId: "c",
      toolName: "read",
      result: "x",
      isError: false,
      terminate: false,
      durationMs: 1,
    });
    expect(s.due).toEqual([]);
    expect(s.taskReminder.drain()).toBe(false);
    s.dispose();
  });

  it("fires during a real run once the interval has passed", async () => {
    const kernel = Kernel.create({
      config: {
        model: { provider: "p", modelId: "m" },
        activeToolNames: ["read"],
      },
    });
    // A real session wires the cadence too; a run without it never reminds.
    const taskReminder = new TaskReminderService(kernel.ctx, {
      tasks: kernel.tasks,
    });
    kernel.tools.register({ name: "read", execute: () => "ok" });
    kernel.tasks.create("keep me in mind");
    const due: number[] = [];
    const off = kernelOn(kernel.ctx)("task:reminder-due", (event) => {
      due.push(event.turn);
    });
    // Six turns of tool work, then an answer: the interval passes along the way.
    const script = [
      ...Array.from({ length: 6 }, () =>
        toolTurn([{ id: crypto.randomUUID(), name: "read" }]),
      ),
      assistantMessage({ content: [{ type: "text", text: "done" }] }),
    ];
    const fake = fakeModels(script);
    const runner = new Runner(kernel, { models: fake });
    kernel.inject(userMsg("go"));
    await runner.run();
    off();
    expect(kernel.turns).toBeGreaterThanOrEqual(DEFAULT_REMINDER_INTERVAL);
    expect(due.length).toBeGreaterThan(0);
    // And what was announced is what a prompt would take.
    expect(taskReminder.drain()).toBe(true);
    void kernel.dispose();
  });
});
