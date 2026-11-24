/**
 * A task's steps: the plan its executor keeps with `create_step` / `update_step`, read for the page
 * from the session of the executor's latest run (`tasks.<id>` `steps` section).
 *
 * What these pin: the last write of the ledger in a journal is the one that counts (a delete is
 * empty, a malformed row is dropped); the run read is the executor's latest, and one that has no
 * session yet has no steps; a session whose journal is not here has none either; and the ones
 * listening are told which task moved, only for a session that belongs to a task.
 */
import type { BoardTaskDetail, TaskStepView } from "@eta/client-contracts";
import type { Request } from "./support/models";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  executorSessionOf,
  stepsOfJournal,
  TaskSteps,
} from "../src/tasks/steps";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const LEDGER = "eta.tasks.state";

const line = (...writes: object[]) => JSON.stringify({ w: writes, t: 0 });
const ledger = (value: unknown) => ({
  kind: "value",
  op: "set",
  namespace: LEDGER,
  key: "",
  value,
});
const step = (id: string, content: string, status: string) => ({
  id,
  content,
  status,
  dependsOn: [],
  blocks: [],
});

describe("the steps in a journal", () => {
  it("are the last write of the ledger, in the order they were made", () => {
    const text = [
      line(ledger([step("t1", "read", "in_progress")])),
      line({ kind: "entry", entry: { id: "e1", type: "message" } }),
      line(
        ledger([
          step("t1", "read", "completed"),
          step("t2", "write", "in_progress"),
          step("t3", "check", "pending"),
          step("t4", "skip", "cancelled"),
        ]),
      ),
      line({ kind: "entry", entry: { id: "e2", type: "message" } }),
    ].join("\n");
    expect(stepsOfJournal(text)).toEqual([
      { id: "t1", content: "read", status: "completed" },
      { id: "t2", content: "write", status: "in_progress" },
      { id: "t3", content: "check", status: "pending" },
      { id: "t4", content: "skip", status: "cancelled" },
    ]);
  });

  it("are none when the ledger was never written, or was deleted", () => {
    expect(stepsOfJournal("")).toEqual([]);
    expect(
      stepsOfJournal(line({ kind: "entry", entry: { id: "e1" } })),
    ).toEqual([]);
    expect(
      stepsOfJournal(
        [
          line(ledger([step("t1", "read", "pending")])),
          line({ kind: "value", op: "delete", namespace: LEDGER, key: "" }),
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("leave out a row that is not a step, and a torn last line", () => {
    const text = [
      line(
        ledger([
          step("t1", "read", "pending"),
          { id: "t2", content: "odd", status: "someday" },
          { id: 3, content: "no id", status: "pending" },
          null,
        ]),
      ),
      '{"w":[{"kind":"value","op":"set","namespace":"eta.tasks.st',
    ].join("\n");
    expect(stepsOfJournal(text)).toEqual([
      { id: "t1", content: "read", status: "pending" },
    ]);
  });
});

describe("the run whose steps a task shows", () => {
  it("is the executor's latest, not a mentioned agent's", () => {
    expect(
      executorSessionOf([
        { agentId: null, sessionId: "s1" },
        { agentId: null, sessionId: "s2" },
        { agentId: "agent-b", sessionId: "s3" },
      ]),
    ).toBe("s2");
  });

  it("has no session while the latest run has not started one", () => {
    expect(
      executorSessionOf([
        { agentId: null, sessionId: "s1" },
        { agentId: null, sessionId: null },
      ]),
    ).toBeNull();
    expect(executorSessionOf([])).toBeNull();
  });
});

describe("taskSteps", () => {
  const journalOf = (dir: string, session: string, text: string) => {
    mkdirSync(join(dir, "sessions", session), { recursive: true });
    writeFileSync(join(dir, "sessions", session, "journal.jsonl"), text);
  };

  it("reads the latest run's session, and sees the ledger move", async () => {
    const dir = await tempDir();
    const steps = new TaskSteps({ dataDir: dir, taskOfSession: () => "k1" });
    const runs = [{ agentId: null, sessionId: "s1" }];
    journalOf(dir, "s1", `${line(ledger([step("t1", "read", "pending")]))}\n`);
    expect(steps.ofRuns(runs)).toEqual([
      { id: "t1", content: "read", status: "pending" },
    ]);
    journalOf(
      dir,
      "s1",
      `${line(ledger([step("t1", "read", "completed")]))}\n${line({
        kind: "entry",
        entry: { id: "e9" },
      })}\n`,
    );
    expect(steps.ofRuns(runs)).toEqual([
      { id: "t1", content: "read", status: "completed" },
    ]);
  });

  it("has none for a session whose journal is not here, or that is not a name", async () => {
    const steps = new TaskSteps({
      dataDir: await tempDir(),
      taskOfSession: () => undefined,
    });
    expect(steps.ofRuns([{ agentId: null, sessionId: "daemon-s" }])).toEqual(
      [],
    );
    expect(steps.ofRuns([{ agentId: null, sessionId: "../escape" }])).toEqual(
      [],
    );
  });

  it("tells the listeners the task of a session that moved, and nobody for another", async () => {
    const steps = new TaskSteps({
      dataDir: await tempDir(),
      taskOfSession: (session) => (session === "s1" ? "k1" : undefined),
    });
    const told: string[] = [];
    const off = steps.onChange((taskId) => told.push(taskId));
    steps.changed("s1");
    steps.changed("chat-session");
    off();
    steps.changed("s1");
    expect(told).toEqual(["k1"]);
  });

  it("tells a moment later, and not at all once stopped", async () => {
    vi.useFakeTimers();
    try {
      const steps = new TaskSteps({
        dataDir: await tempDir(),
        taskOfSession: () => "k1",
      });
      const told: string[] = [];
      steps.onChange((taskId) => told.push(taskId));
      steps.changedSoon("s1", 100);
      expect(told).toEqual([]);
      vi.advanceTimersByTime(100);
      expect(told).toEqual(["k1"]);
      steps.changedSoon("s1", 100);
      steps.stop();
      vi.advanceTimersByTime(1000);
      expect(told).toEqual(["k1"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

const isRun = (request: Request): boolean =>
  request.system.includes("In this task you are");

describe("a task's steps, on a real host", () => {
  it("are the plan its executor made in its run, pushed as they move and kept after the run", async () => {
    // The executor plans two steps, finishes the first, and ends with the second still open.
    let turn = 0;
    const { models } = scriptedModels((request) => {
      if (!isRun(request)) return say("ok");
      const step = turn++;
      if (step === 0) return call("create_step", { content: "read it" });
      if (step === 1) return call("create_step", { content: "check it" });
      if (step === 2)
        return call("update_step", { id: "t1", status: "completed" });
      if (step === 3) return call("finish_task", { summary: "ok" });
      return say("done");
    });
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "plan");
    const task: BoardTaskDetail = w.host.product.board.create(
      {
        title: "Plan",
        description: "Do Plan",
        status: "todo",
        conversationId: group.id,
        workspace: "local",
      },
      { kind: "agent", agentId: ada.id },
    );
    w.client.subscribe(`tasks.${task.id}`);
    const seen = () =>
      w.client.section<TaskStepView[]>(`tasks.${task.id}`, "steps");
    const plan: TaskStepView[] = [
      { id: "t1", content: "read it", status: "completed" },
      { id: "t2", content: "check it", status: "pending" },
    ];
    await until(() => JSON.stringify(seen()) === JSON.stringify(plan));
    await until(() =>
      w.host.product.board
        .detail(task.id)!
        .runs.every(
          (run) => !["queued", "starting", "running"].includes(run.status),
        ),
    );
    // Over, the last known plan stays.
    expect(seen()).toEqual(plan);
  });
});
