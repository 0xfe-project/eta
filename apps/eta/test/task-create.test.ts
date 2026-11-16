/**
 * The user makes tasks from the page (`tasks.create`, `TaskBoard.make`): one task with its
 * executor, parent and dependencies, or a piece of work split into several, with the waits between
 * them, in one write. Pressing "Create" is the user's confirmation; an agent cannot come this way.
 */
import type { BoardTaskDetail } from "@eta/client-contracts";
import type { Request } from "./support/models";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const isRun = (request: Request): boolean =>
  request.system.includes("In this task you are");

async function room() {
  const briefed: number[] = [];
  const { models } = scriptedModels(async (request) => {
    if (!isRun(request)) return say("ok");
    const number = Number(/task #(\d+)/.exec(request.transcript[0] ?? "")?.[1]);
    if (!briefed.includes(number)) briefed.push(number);
    if (request.lastRole === "toolResult") return say("finished");
    return call("finish_task", { summary: `#${number} done.` });
  });
  const w = await world({ models });
  const ada = await w.agent("Ada");
  const project = await w.project({ stewardId: ada.id });
  const group = await w.group(project.id, [ada.id], "plan");
  const create = async (args: Record<string, unknown>) =>
    (
      (await w.client.call("tasks", "create", {
        conversationId: group.id,
        workspace: "local",
        ...args,
      })) as { tasks: BoardTaskDetail[] }
    ).tasks;
  const task = (id: string) => w.host.product.board.detail(id)!;
  return { w, ada, group, create, task, briefed };
}

describe("the user makes a task", () => {
  it("with its executor, its parent and what it waits for, and it runs once they are there", async () => {
    const r = await room();
    const [stage] = await r.create({
      status: "backlog",
      tasks: [{ title: "Release", assignee: "Ada" }],
    });
    const [first] = await r.create({
      parent: stage!.id,
      status: "backlog",
      tasks: [{ title: "Changelog", assignee: "Ada" }],
    });
    const [made] = await r.create({
      parent: `#${stage!.number}`,
      tasks: [
        {
          title: "Smoke test",
          description: "Walk it through.",
          assignee: r.ada.id,
          dependsOn: [{ task: first!.id, requireDone: true }],
        },
      ],
    });
    expect(made).toMatchObject({
      title: "Smoke test",
      description: "Walk it through.",
      status: "todo",
      createdBy: { kind: "user", agentId: null },
      assigneeAgentId: r.ada.id,
      parentId: stage!.id,
      conversationId: r.group.id,
    });
    expect(made!.dependsOn).toEqual([
      expect.objectContaining({ number: first!.number, requireDone: true }),
    ]);
    // It waits for #2; once #2 is done, the executor starts it.
    await until(() => r.task(made!.id).runs[0]?.queueReason === "waiting_deps");
    await r.w.client.call("tasks", "update", {
      taskId: first!.id,
      status: "done",
    });
    await until(() => r.task(made!.id).status === "in_review");
    expect(r.briefed).toEqual([3]);
  });

  it("splits a piece of work: a chain, side by side, under a parent of the batch", async () => {
    const r = await room();
    const made = await r.create({
      status: "backlog",
      tasks: [
        { title: "Release", assignee: "Ada" },
        { title: "Changelog", assignee: "Ada", under: 0 },
        { title: "Docs", assignee: "Ada", under: 0 },
        { title: "Regression", assignee: "Ada", under: 0, after: [1, 2] },
        { title: "Announce", assignee: "Ada", under: 0, after: [3] },
      ],
    });
    const [stage, a, b, c, d] = made.map((t) => r.task(t.id));
    expect(stage!.children!.map((t) => t.title)).toEqual([
      "Changelog",
      "Docs",
      "Regression",
      "Announce",
    ]);
    expect(stage!.subtasks).toEqual({ total: 4, done: 0 });
    expect(a!.dependsOn).toEqual([]);
    expect(b!.dependsOn).toEqual([]);
    expect(c!.dependsOn!.map((e) => e.number).sort()).toEqual([
      a!.number,
      b!.number,
    ]);
    expect(d!.dependsOn!.map((e) => e.number)).toEqual([c!.number]);
    expect(made.every((t) => t.status === "backlog")).toBe(true);
    // A parent of the batch never runs.
    expect(stage!.runs).toEqual([]);
  });

  it("starts the leaves of a split and not its parent", async () => {
    const r = await room();
    const made = await r.create({
      tasks: [
        { title: "Release", assignee: "Ada" },
        { title: "Changelog", assignee: "Ada", under: 0 },
      ],
    });
    await until(() => r.task(made[1]!.id).status === "in_review");
    expect(r.task(made[0]!.id).runs).toEqual([]);
    expect(r.task(made[0]!.id).status).toBe("in_review");
  });

  it("refuses the whole batch when one edge closes a cycle, and leaves nothing behind", async () => {
    const r = await room();
    const [stage] = await r.create({
      status: "backlog",
      tasks: [{ title: "Stage", assignee: "Ada" }],
    });
    const [later] = await r.create({
      status: "backlog",
      tasks: [
        {
          title: "Later",
          assignee: "Ada",
          dependsOn: [{ task: stage!.id }],
        },
      ],
    });
    // Under #1, and waiting for #2, which waits for #1: a cycle.
    await expect(
      r.create({
        parent: stage!.id,
        tasks: [
          { title: "Ok", assignee: "Ada" },
          { title: "Cycle", assignee: "Ada", dependsOn: [{ task: later!.id }] },
        ],
      }),
    ).rejects.toThrow(/cycle/);
    expect(
      r.w.host.product.board
        .list()
        .map((t) => t.title)
        .sort(),
    ).toEqual(["Later", "Stage"]);
  });

  it("needs an executor that exists, a project, and indexes that point back", async () => {
    const r = await room();
    await expect(
      r.create({ tasks: [{ title: "X", assignee: "Nobody" }] }),
    ).rejects.toThrow(/no agent is "Nobody"/);
    await expect(
      r.create({ tasks: [{ title: "X", assignee: "" }] }),
    ).rejects.toThrow(/needs assignee/);
    await expect(
      r.w.client.call("tasks", "create", {
        tasks: [{ title: "X", assignee: "Ada" }],
      }),
    ).rejects.toThrow(/needs a project/);
    await expect(
      r.create({ tasks: [{ title: "X", assignee: "Ada", after: [0] }] }),
    ).rejects.toThrow(/before it/);
    await expect(
      r.create({ status: "done", tasks: [{ title: "X", assignee: "Ada" }] }),
    ).rejects.toThrow(/todo or backlog/);
    expect(r.w.host.product.board.list()).toEqual([]);
  });

  it("is the user's: an agent drafts instead", async () => {
    const r = await room();
    expect(() =>
      r.w.host.product.board.make(
        {
          tasks: [{ title: "X", assignee: "Ada" }],
          conversationId: r.group.id,
        },
        { kind: "agent", agentId: r.ada.id },
      ),
    ).toThrow(/only the user makes tasks this way/);
  });
});
