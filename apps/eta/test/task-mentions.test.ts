/**
 * Mentions on a task. The user's comment can call another agent into the task's thread: it is
 * woken in a run of its own on the task, in a session of its own that it carries on the next time,
 * and answers with `comment_task` without taking the work over. A task that came from a group can
 * only call in that group's members. Every test is a real host with scripted models.
 */
import type { BoardTaskDetail } from "@eta/client-contracts";
import type { Request } from "./support/models";
import type { World } from "./support/world";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

/** A request of a session on a task (the executor's or a mentioned agent's). */
const onTask = (request: Request): boolean =>
  request.system.includes("In this task you are");

interface RunRow {
  id: string;
  agent_id: string | null;
  status: string;
  session_id: string | null;
  continues_run_id: string | null;
}

const runsOf = (w: World, taskId: string): RunRow[] =>
  w.host.db
    .query<RunRow, [string]>(
      "SELECT * FROM task_run WHERE task_id = ? ORDER BY created_at, rowid",
    )
    .all(taskId);

const ended = (w: World, taskId: string): boolean =>
  runsOf(w, taskId).every(
    (run) => !["queued", "starting", "running"].includes(run.status),
  );

const comments = (w: World, taskId: string) =>
  w.host.product.board
    .activity(taskId)
    .filter((entry) => entry.kind === "comment")
    .map((entry) => ({ by: entry.actor.agentId, body: entry.body }));

/**
 * Ada executes and reports at once; Bea, mentioned, answers with `comment_task` (or, with
 * `silent`, only says it). Cy is an agent outside the group.
 */
async function room(options: { silent?: boolean } = {}) {
  const { models, requests } = scriptedModels((request) => {
    if (!onTask(request)) return say("ok");
    if (request.agent === "Bea") {
      if (options.silent === true || request.lastRole === "toolResult")
        return say("Use the border variable.");
      return call("comment_task", { body: "Use the border variable." });
    }
    return request.lastRole === "toolResult"
      ? say("finished")
      : call("finish_task", { summary: "Done." });
  });
  const w = await world({ models });
  const ada = await w.agent("Ada");
  const bea = await w.agent("Bea");
  const cy = await w.agent("Cy");
  const project = await w.project({ stewardId: ada.id });
  const group = await w.group(project.id, [ada.id, bea.id], "ui");
  await w.watch(group.id);
  const task: BoardTaskDetail = w.host.product.board.create(
    {
      title: "Dark mode",
      description: "Do dark mode",
      status: "todo",
      conversationId: group.id,
      workspace: "local",
    },
    { kind: "agent", agentId: ada.id },
  );
  await until(
    () =>
      runsOf(w, task.id).length === 1 &&
      ended(w, task.id) &&
      w.host.product.board.detail(task.id)?.status === "in_review",
  );
  return { w, ada, bea, cy, task, requests };
}

describe("a mention on a task", () => {
  it("wakes the mentioned agent in a run of its own, which answers in the thread and leaves the task alone", async () => {
    const r = await room();
    await r.w.client.call("tasks", "comment", {
      taskId: r.task.id,
      body: "@Bea how should dark mode look?",
      mentions: [r.bea.id],
    });
    await until(
      () => runsOf(r.w, r.task.id).length === 2 && ended(r.w, r.task.id),
    );

    const [executor, mentioned] = runsOf(r.w, r.task.id);
    expect(executor!.agent_id).toBeNull();
    expect(mentioned).toMatchObject({
      agent_id: r.bea.id,
      status: "completed",
    });
    // A session of its own, not the executor's.
    expect(mentioned!.session_id).not.toBe(executor!.session_id);
    // Her answer is in the thread in her name, and the comment remembers whom it called.
    expect(comments(r.w, r.task.id)).toContainEqual({
      by: r.bea.id,
      body: "Use the border variable.",
    });
    expect(
      r.w.host.product.board
        .activity(r.task.id)
        .find((entry) => entry.body === "@Bea how should dark mode look?")
        ?.data,
    ).toMatchObject({ mentions: [r.bea.id] });
    // She answers; she does not execute. The task stays where the executor left it, and the board
    // says how the executor's run went, not hers.
    const asked = r.requests.find((request) => request.agent === "Bea")!;
    expect(asked.tools).toEqual(
      expect.arrayContaining(["comment_task", "get_task"]),
    );
    expect(asked.tools).not.toContain("finish_task");
    expect(asked.tools).not.toContain("update_task");
    expect(asked.transcript[0]).toContain("you were mentioned on task #1");
    expect(asked.transcript[0]).toContain("@Bea how should dark mode look?");
    const detail = r.w.host.product.board.detail(r.task.id)!;
    expect(detail.status).toBe("in_review");
    expect(detail.runs.map((run) => run.agentId)).toEqual([null, r.bea.id]);
    // The comment was for Bea: the executor was not woken by it, nor by her answer.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runsOf(r.w, r.task.id)).toHaveLength(2);
  });

  it("carries on in the mentioned agent's own session the next time it is mentioned", async () => {
    const r = await room();
    for (const body of ["@Bea first?", "@Bea second?"]) {
      await r.w.client.call("tasks", "comment", {
        taskId: r.task.id,
        body,
        mentions: [r.bea.id],
      });
      await until(() => ended(r.w, r.task.id));
    }
    await until(() => runsOf(r.w, r.task.id).length === 3);
    await until(() => ended(r.w, r.task.id));
    const [, first, second] = runsOf(r.w, r.task.id);
    expect(second!.agent_id).toBe(r.bea.id);
    expect(second!.continues_run_id).toBe(first!.id);
    expect(second!.session_id).toBe(first!.session_id);
  });

  it("wakes the executor too when the comment mentions it", async () => {
    const r = await room();
    await r.w.client.call("tasks", "comment", {
      taskId: r.task.id,
      body: "@Ada @Bea both of you",
      mentions: [r.ada.id, r.bea.id],
    });
    await until(
      () => runsOf(r.w, r.task.id).length === 3 && ended(r.w, r.task.id),
    );
    expect(runsOf(r.w, r.task.id).map((run) => run.agent_id)).toEqual(
      expect.arrayContaining([null, null, r.bea.id]),
    );
  });

  it("posts what the mentioned agent said last when it stops without comment_task", async () => {
    const r = await room({ silent: true });
    await r.w.client.call("tasks", "comment", {
      taskId: r.task.id,
      body: "@Bea thoughts?",
      mentions: [r.bea.id],
    });
    await until(
      () => runsOf(r.w, r.task.id).length === 2 && ended(r.w, r.task.id),
    );
    expect(comments(r.w, r.task.id)).toContainEqual({
      by: r.bea.id,
      body: "Use the border variable.",
    });
  });

  it("can only call in members of the group the task came from", async () => {
    const r = await room();
    await expect(
      r.w.client.call("tasks", "comment", {
        taskId: r.task.id,
        body: "@Cy have a look",
        mentions: [r.cy.id],
      }),
    ).rejects.toThrow(/only members of the group/);
    expect(comments(r.w, r.task.id)).not.toContainEqual(
      expect.objectContaining({ body: "@Cy have a look" }),
    );
    expect(runsOf(r.w, r.task.id)).toHaveLength(1);
  });
});
