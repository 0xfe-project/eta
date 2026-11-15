/**
 * Captain sees the task graph and steers it with the tools it has: `captain_list_tasks` lists one
 * tree with `under` and carries each task's parent, subtasks and edges, `captain_read_task` says
 * where a task sits, and `update_task_fields` sets any status, done included, with no grant of
 * any kind, as it always could.
 */
import type { BoardTaskDetail, BoardTaskView } from "@eta/client-contracts";
import type { KernelTool } from "@eta/core";
import { describe, expect, it } from "vitest";
import { world } from "./support/world";

async function setup() {
  const w = await world({ captain: true, tasks: { runs: false } });
  const ada = await w.agent("Ada");
  const project = await w.project({ stewardId: ada.id });
  const group = await w.group(project.id, [ada.id], "plan");
  const { identity } = (await w.client.call("captain", "ensure", {})) as {
    identity: { agentId: string };
  };
  const { conversationId: direct } = (await w.client.call(
    "captain",
    "direct",
    {},
  )) as { conversationId: string };
  const make = (
    title: string,
    extra: {
      parent?: string;
      dependsOn?: { task: string; requireDone?: boolean }[];
    } = {},
  ): BoardTaskDetail =>
    w.host.product.board.create(
      {
        title,
        description: title,
        status: "todo",
        conversationId: group.id,
        workspace: "local",
        ...extra,
      },
      { kind: "agent", agentId: ada.id },
    );
  const tools = new Map(
    w.host.product.sessionHooks
      .sessionTools({
        meta: {
          id: "captain-session",
          createdAt: 0,
          cwd: project.path,
          agentId: identity.agentId,
          conversationId: direct,
        },
        session: undefined as never,
      })
      .map((tool) => [tool.name, tool] as const),
  );
  const use = async (name: string, args: unknown) => {
    const tool: KernelTool | undefined = tools.get(name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    const result = (await tool.execute(args, {
      turn: 1,
      toolCallId: "t1",
      signal: new AbortController().signal,
      toolContext: {},
    })) as { content: { text: string }[]; isError?: boolean };
    return {
      text: result.content.map((block) => block.text).join(""),
      isError: result.isError === true,
    };
  };
  return { w, make, use, tools };
}

describe("captain and the task graph", () => {
  it("lists one tree with its parents, subtasks and edges, and reads where a task sits", async () => {
    const { make, use } = await setup();
    const stage = make("Stage");
    const a = make("A", { parent: stage.id });
    const b = make("B", { parent: stage.id, dependsOn: [{ task: a.id }] });
    make("Elsewhere");
    const listed = await use("captain_list_tasks", {
      under: `#${stage.number}`,
    });
    const tasks = JSON.parse(listed.text) as BoardTaskView[];
    expect(tasks.map((t) => t.number).sort()).toEqual([1, 2, 3]);
    expect(tasks.find((t) => t.id === stage.id)?.subtasks).toEqual({
      total: 2,
      done: 0,
    });
    expect(tasks.find((t) => t.id === b.id)?.dependsOn).toEqual([
      expect.objectContaining({ number: a.number, state: "waiting" }),
    ]);
    const read = JSON.parse(
      (await use("captain_read_task", { taskId: b.id })).text,
    ) as { task: BoardTaskDetail };
    expect(read.task.ancestors!.map((t) => t.number)).toEqual([stage.number]);
    expect((await use("captain_list_tasks", { under: "#99" })).isError).toBe(
      true,
    );
  });

  it("sets a task done with update_task_fields, with no grant of any kind", async () => {
    const { w, make, use } = await setup();
    const task = make("A");
    await w.client.call("tasks", "update", {
      taskId: task.id,
      status: "in_review",
    });
    const set = await use("update_task_fields", {
      taskId: task.id,
      status: "done",
    });
    expect(set.isError).toBe(false);
    expect(w.host.product.board.detail(task.id)!.status).toBe("done");
  });

  it("has no tools of a grant to accept work: it needs none", async () => {
    const { tools } = await setup();
    expect(tools.has("accept_task")).toBe(false);
    expect(
      [...tools.keys()].filter((name) => name.startsWith("propose_task_")),
    ).toEqual([]);
  });
});
