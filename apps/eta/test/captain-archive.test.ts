/**
 * Captain archives and restores tasks with its own tools, through the board's archiving: done work
 * goes, several at once, with Captain on the timeline and in `archivedBy`; a task that is running is
 * not stopped behind the user's back; a name that matches nothing changes nothing; and the list
 * shows what is archived, so it can be brought back.
 */
import type {
  BoardTaskDetail,
  BoardTaskStatus,
  BoardTaskView,
} from "@eta/client-contracts";
import type { KernelTool } from "@eta/core";
import type { Request } from "./support/models";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { HANG, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const isRun = (request: Request): boolean =>
  request.system.includes("In this task you are");

async function setup() {
  /** Task runs say nothing until they are stopped. */
  let asked = 0;
  const { models } = scriptedModels((request) => {
    if (!isRun(request)) return say("ok");
    asked += 1;
    return HANG;
  });
  const w = await world({ models, captain: true });
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
  const board = w.host.product.board;
  const make = (
    title: string,
    extra: { status?: BoardTaskStatus; parent?: string } = {},
  ): BoardTaskDetail =>
    board.create(
      {
        title,
        status: extra.status ?? "backlog",
        conversationId: group.id,
        workspace: "local",
        parent: extra.parent,
      },
      { kind: "agent", agentId: ada.id },
    );
  /** A task made and moved to done by the user. */
  const done = async (title: string, parent?: string) => {
    const task = make(title, { parent });
    await w.client.call("tasks", "update", { taskId: task.id, status: "done" });
    return task;
  };
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
  const archived = (id: string): boolean =>
    (board.detail(id)!.archivedAt ?? null) !== null;
  return {
    w,
    board,
    make,
    done,
    use,
    archived,
    captain: identity.agentId,
    asked: () => asked,
  };
}

describe("captain archives tasks", () => {
  it("archives a done task, as Captain", async () => {
    const r = await setup();
    const task = await r.done("Finished");
    const result = await r.use("archive_task", {
      taskIds: [`#${task.number}`],
    });
    expect(result).toEqual({
      isError: false,
      text: `Archived #${task.number}.`,
    });
    expect(r.archived(task.id)).toBe(true);
    expect(r.board.detail(task.id)).toMatchObject({
      status: "done",
      archivedBy: r.captain,
    });
    expect(r.board.activity(task.id).at(-1)).toMatchObject({
      kind: "archived",
      actor: { kind: "agent", agentId: r.captain },
      data: { by: r.captain, reason: "manual" },
    });
  });

  it("archives several at once, by number or id, and leaves one archived already as it is", async () => {
    const r = await setup();
    const a = await r.done("A");
    const b = await r.done("B");
    const c = await r.done("C");
    await r.w.client.call("tasks", "archive", { taskId: c.id });
    const result = await r.use("archive_task", {
      taskIds: [`#${a.number}`, b.id, String(c.number), a.id],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      `Archived #${a.number}, #${b.number}. #${c.number} was archived already.`,
    );
    expect([a, b, c].map((t) => r.archived(t.id))).toEqual([true, true, true]);
    // The one the user archived is still theirs.
    expect(r.board.detail(c.id)!.archivedBy).toBe("user");
    expect(
      r.board.activity(a.id).filter((e) => e.kind === "archived"),
    ).toHaveLength(1);
  });

  it("brings archived tasks back, with their subtasks", async () => {
    const r = await setup();
    const stage = await r.done("Stage");
    const sub = await r.done("Sub", stage.id);
    const other = await r.done("Other");
    const kept = await r.done("Kept");
    await r.use("archive_task", { taskIds: [stage.id, other.id, kept.id] });
    expect(r.archived(sub.id)).toBe(true);
    const result = await r.use("unarchive_task", {
      taskIds: [`#${stage.number}`, other.id],
    });
    expect(result).toEqual({
      isError: false,
      text: `Restored #${stage.number}, #${other.number}.`,
    });
    expect([stage, sub, other].map((t) => r.archived(t.id))).toEqual([
      false,
      false,
      false,
    ]);
    expect(r.archived(kept.id)).toBe(true);
    expect(r.board.detail(stage.id)).toMatchObject({
      status: "done",
      archivedBy: null,
    });
    expect(r.board.activity(stage.id).at(-1)).toMatchObject({
      kind: "unarchived",
      actor: { kind: "agent", agentId: r.captain },
      data: { cause: "manual" },
    });
    expect((await r.use("unarchive_task", { taskIds: [other.id] })).text).toBe(
      `#${other.number} was not archived.`,
    );
  });

  it("does not stop a running task unless asked to, and says archiving would", async () => {
    const r = await setup();
    const finished = await r.done("Finished");
    const running = r.make("Running", { status: "todo" });
    await until(() => r.asked() > 0);
    const refused = await r.use("archive_task", {
      taskIds: [finished.id, running.id],
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(
      `#${running.number} is running: archiving stops its run. Nothing was archived.`,
    );
    expect(refused.text).toContain("stopRuns: true");
    // Nothing moved: neither the finished task nor the running one, and its run still goes.
    expect(r.archived(finished.id)).toBe(false);
    expect(r.archived(running.id)).toBe(false);
    expect(r.board.detail(running.id)!.runs[0]!.status).toBe("running");

    const stopped = await r.use("archive_task", {
      taskIds: [finished.id, running.id],
      stopRuns: true,
    });
    expect(stopped.isError).toBe(false);
    expect(r.archived(finished.id)).toBe(true);
    expect(r.archived(running.id)).toBe(true);
    await until(
      () => r.board.detail(running.id)!.runs[0]!.status === "interrupted",
    );
    expect(r.board.detail(running.id)!.archivedBy).toBe(r.captain);
  });

  it("refuses a running subtask too: the parent takes it with it", async () => {
    const r = await setup();
    const stage = r.make("Stage");
    const sub = r.make("Sub", { status: "todo", parent: stage.id });
    await until(() => r.asked() > 0);
    const refused = await r.use("archive_task", { taskIds: [stage.id] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`#${sub.number} is running`);
    expect(r.archived(stage.id)).toBe(false);
    expect(r.board.detail(sub.id)!.runs[0]!.status).toBe("running");
  });

  it("changes nothing when a task does not exist", async () => {
    const r = await setup();
    const task = await r.done("Finished");
    for (const name of ["archive_task", "unarchive_task"]) {
      const result = await r.use(name, { taskIds: [task.id, "#99"] });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("No such task: #99.");
    }
    expect(r.archived(task.id)).toBe(false);
  });

  it("lists archived tasks when asked, with who archived them", async () => {
    const r = await setup();
    const a = await r.done("A");
    const b = await r.done("B");
    const open = r.make("Open");
    await r.use("archive_task", { taskIds: [a.id] });
    await r.w.client.call("tasks", "archive", { taskId: b.id });
    const listed = async (archived?: "only" | "include") =>
      JSON.parse(
        (
          await r.use(
            "captain_list_tasks",
            archived === undefined ? {} : { archived },
          )
        ).text,
      ) as BoardTaskView[];
    expect((await listed()).map((t) => t.number)).toEqual([open.number]);
    expect((await listed("only")).map((t) => [t.number, t.archivedBy])).toEqual(
      [
        [b.number, "user"],
        [a.number, r.captain],
      ],
    );
    expect((await listed("include")).map((t) => t.number).sort()).toEqual(
      [a.number, b.number, open.number].sort(),
    );
  });
});
