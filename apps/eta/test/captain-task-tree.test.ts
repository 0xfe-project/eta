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
  const project = await w.project();
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
  it("changes or cancels an archived task as asked, and says in the result that it brought it back", async () => {
    const { w, make, use } = await setup();
    const renamed = make("Away");
    const continued = make("Also away");
    const plain = make("On the board");
    for (const task of [renamed, continued])
      w.host.product.board.archive(task.id, { kind: "user", agentId: null });

    const listed = await use("captain_list_tasks", { archived: "only" });
    expect(listed.text).toContain('"archivedBy": "user"');
    expect(listed.text).toContain('"archivedAt": ');

    // No confirmation parameter: the call goes through as it is.
    const updated = await use("update_task_fields", {
      taskId: renamed.id,
      title: "Renamed",
    });
    expect(updated.isError).toBe(false);
    expect(updated.text).toMatch(
      /^Task #1 updated\.\n\nNote: #1 was archived: the user archived it by hand at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC: they put it away on purpose\. This change brought it back onto the board; tell the user\. If they want it put away again, archive_task does that\.$/,
    );
    expect(w.host.product.board.find(renamed.id)).toMatchObject({
      title: "Renamed",
      archivedAt: null,
    });

    const resumed = await use("control_task", {
      taskId: continued.id,
      action: "cancel",
    });
    expect(resumed.isError).toBe(false);
    expect(resumed.text).toMatch(
      /^Task #2 cancel: cancelled\.\n\nNote: #2 was archived: the user archived it by hand at .*This change brought it back onto the board; tell the user\./,
    );
    expect(w.host.product.board.find(continued.id)!.archivedAt).toBeNull();

    const untouched = await use("update_task_fields", {
      taskId: plain.id,
      title: "Still on the board",
    });
    expect(untouched.text).toBe("Task #3 updated.");
  });

  it("refuses assignee and unknown fields on update_task_fields without mutating the task or recording activity", async () => {
    const { w, make, use } = await setup();
    const bola = await w.agent("Bola");
    const task = make("Target");
    const beforeTask = w.host.product.board.detail(task.id)!;
    const beforeActivityCount = w.host.product.board.activity(task.id).length;

    const nonexistentAssignee = await use("update_task_fields", {
      taskId: task.id,
      title: "Should not change",
      assignee: "zzz-not-an-agent",
    });
    expect(nonexistentAssignee.isError).toBe(true);
    expect(nonexistentAssignee.text).toMatch(
      /invalid arguments for update_task_fields:.*\/assignee.*must not have additional properties/,
    );

    const realAssignee = await use("update_task_fields", {
      taskId: task.id,
      status: "done",
      assignee: bola.id,
    });
    expect(realAssignee.isError).toBe(true);
    expect(realAssignee.text).toMatch(
      /invalid arguments for update_task_fields:.*\/assignee.*must not have additional properties/,
    );

    const unknownFields = await use("update_task_fields", {
      taskId: task.id,
      title: "Should not change",
      foo: "bar",
      bar: 1,
    });
    expect(unknownFields.isError).toBe(true);
    expect(unknownFields.text).toMatch(
      /invalid arguments for update_task_fields:.*\/foo.*\/bar.*must not have additional properties/,
    );

    expect(w.host.product.board.detail(task.id)).toMatchObject({
      title: beforeTask.title,
      status: beforeTask.status,
      assigneeAgentId: beforeTask.assigneeAgentId,
    });
    expect(w.host.product.board.activity(task.id)).toHaveLength(
      beforeActivityCount,
    );

    const allowed = await use("update_task_fields", {
      taskId: task.id,
      title: "Allowed",
    });
    expect(allowed.isError).toBe(false);
    expect(allowed.text).toBe("Task #1 updated.");
    expect(w.host.product.board.detail(task.id)!.title).toBe("Allowed");
  });
});
