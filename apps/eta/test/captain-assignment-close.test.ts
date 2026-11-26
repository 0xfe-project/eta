/**
 * A Captain dispatch is open only while the work it asked for is going on:
 * - An `assign_in_group` reply that ends closes the target (`completed`) so `openAssignmentFor`
 *   stops returning it and unrelated later turns aren't treated as assigned work.
 * - A `dispatch_task` assignment starts `working` (`taskCount: 1`), follows the task's lifecycle
 *   (`blocked` -> `blocked`, `in_review` / `done` -> `completed`, `cancelled` / deleted -> `cancelled`).
 */
import type { InteractionView } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { call, gate, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const options = { captain: true, tasks: { runs: false } } as const;

describe("captain assignment closing", () => {
  it("closes an assign_in_group dispatch when the agent's reply ends", async () => {
    const { models } = scriptedModels(() => say("Looked; nothing to change."));
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "reply-only");
    await w.watch(group.id);
    const captain = w.host.product.captain;

    const assigned = await captain.assign({
      conversationId: group.id,
      text: "Ada, look at it and report.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, assigned.replyIds[0]!);
    const target = () =>
      captain.store.assignment(assigned.assignment.id)!.targets[0]!;
    await until(() => target().status === "completed");

    expect(target()).toMatchObject({ agentId: ada.id, taskCount: 0 });
    expect(captain.store.assignment(assigned.assignment.id)!.status).toBe(
      "completed",
    );
    expect(captain.store.openAssignmentFor(group.id, ada.id)).toBeUndefined();
    const asked = {
      agentId: ada.id,
      conversationId: group.id,
    } as InteractionView;
    expect(captain.assignmentForInbox(asked)).toBeUndefined();
  });

  it("is not changed back by the next board refresh", async () => {
    const { models } = scriptedModels(() => say("Done."));
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "stays-closed");
    await w.watch(group.id);
    const captain = w.host.product.captain;

    const assigned = await captain.assign({
      conversationId: group.id,
      text: "Ada, report.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, assigned.replyIds[0]!);
    await until(
      () =>
        captain.store.assignment(assigned.assignment.id)!.targets[0]!.status ===
        "completed",
    );

    captain.refreshAssignments();
    captain.refreshAssignments();

    const after = captain.store.assignment(assigned.assignment.id)!;
    expect(after.status).toBe("completed");
    expect(after.targets[0]!.status).toBe("completed");
    expect(captain.store.openAssignmentFor(group.id, ada.id)).toBeUndefined();
  });

  it("keeps the assign_in_group dispatch open only while the reply it started is running", async () => {
    const hold = gate();
    const { models } = scriptedModels(async () => {
      await hold.opened;
      return say("Done.");
    });
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "open-while-running");
    await w.watch(group.id);
    const captain = w.host.product.captain;

    const assigned = await captain.assign({
      conversationId: group.id,
      text: "Ada, report.",
      agentIds: [ada.id],
    });
    try {
      expect(captain.store.openAssignmentFor(group.id, ada.id)).toMatchObject({
        assignmentId: assigned.assignment.id,
      });
      expect(
        captain.assignmentForInbox({
          agentId: ada.id,
          conversationId: group.id,
        } as InteractionView),
      ).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        captain.store.assignment(assigned.assignment.id)!.targets[0]!.status,
      ).toBe("dispatched");
    } finally {
      hold.open();
    }
    await w.settled(group.id, assigned.replyIds[0]!);
    await until(
      () => captain.store.openAssignmentFor(group.id, ada.id) === undefined,
    );
  });

  it("closes only the target whose own reply ended", async () => {
    const first = gate();
    const second = gate();
    const { models } = scriptedModels(async ({ index }) => {
      await (index === 0 ? first : second).opened;
      return say(`Answer ${index + 1}.`);
    });
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "two-dispatches");
    await w.watch(group.id);
    const captain = w.host.product.captain;

    const one = await captain.assign({
      conversationId: group.id,
      text: "Ada, first.",
      agentIds: [ada.id],
    });
    const two = await captain.assign({
      conversationId: group.id,
      text: "Ada, second.",
      agentIds: [ada.id],
    });
    const status = (id: string) =>
      captain.store.assignment(id)!.targets[0]!.status;
    try {
      first.open();
      await w.settled(group.id, one.replyIds[0]!);
      await until(() => status(one.assignment.id) === "completed");
      expect(status(two.assignment.id)).toBe("dispatched");
      expect(captain.store.openAssignmentFor(group.id, ada.id)).toMatchObject({
        assignmentId: two.assignment.id,
      });
    } finally {
      second.open();
    }
    await w.settled(group.id, two.replyIds[0]!);
    await until(() => status(two.assignment.id) === "completed");
    expect(captain.store.openAssignmentFor(group.id, ada.id)).toBeUndefined();
  });

  it("tracks dispatch_task assignment status across blocked, in_review, done, cancelled, and deleted", async () => {
    const { models } = scriptedModels(() => say("ok"));
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "task-lifecycle");
    await w.watch(group.id);
    const captain = w.host.product.captain;

    const one = await captain.dispatchTask({
      conversationId: group.id,
      title: "Tracked task",
      description: "Moves through statuses",
      assignee: ada.id,
      workspace: "local",
    });
    await until(() => w.row(group.id, one.messageId) !== undefined);
    expect(w.row(group.id, one.messageId)).toMatchObject({
      kind: "task_card",
      data: {
        taskId: one.task.id,
        number: one.task.number,
        status: "todo",
        captainAssignmentId: one.assignment.id,
        captainRound: 1,
        taskNumber: one.task.number,
      },
    });
    expect(captain.store.assignment(one.assignment.id)).toMatchObject({
      status: "working",
      targets: [{ agentId: ada.id, taskCount: 1, status: "working" }],
    });

    await w.client.call("tasks", "update", {
      taskId: one.task.id,
      status: "blocked",
    });
    await until(
      () => w.row(group.id, one.messageId)?.data.status === "blocked",
    );
    expect(w.row(group.id, one.messageId)?.data.captainAssignmentId).toBe(
      one.assignment.id,
    );
    expect(captain.store.assignment(one.assignment.id)).toMatchObject({
      status: "blocked",
      targets: [{ agentId: ada.id, taskCount: 1, status: "blocked" }],
    });

    await w.client.call("tasks", "update", {
      taskId: one.task.id,
      status: "in_review",
    });
    await until(
      () => w.row(group.id, one.messageId)?.data.status === "in_review",
    );
    expect(captain.store.assignment(one.assignment.id)).toMatchObject({
      status: "completed",
      targets: [{ agentId: ada.id, taskCount: 1, status: "completed" }],
    });

    await w.client.call("tasks", "update", {
      taskId: one.task.id,
      status: "done",
    });
    await until(() => w.row(group.id, one.messageId)?.data.status === "done");
    expect(captain.store.assignment(one.assignment.id)).toMatchObject({
      status: "completed",
      targets: [{ agentId: ada.id, taskCount: 1, status: "completed" }],
    });

    await w.client.call("tasks", "update", {
      taskId: one.task.id,
      status: "cancelled",
    });
    await until(
      () => w.row(group.id, one.messageId)?.data.status === "cancelled",
    );
    expect(w.row(group.id, one.messageId)).toMatchObject({
      kind: "task_card",
      data: {
        status: "cancelled",
        captainAssignmentId: one.assignment.id,
        captainRound: 1,
        taskNumber: one.task.number,
      },
    });
    expect(captain.store.assignment(one.assignment.id)).toMatchObject({
      status: "cancelled",
      targets: [{ agentId: ada.id, taskCount: 1, status: "cancelled" }],
    });

    const two = await captain.dispatchTask({
      conversationId: group.id,
      title: "Deleted task",
      description: "Deleted cleanly",
      assignee: ada.id,
      status: "backlog",
      workspace: "local",
    });
    await w.client.call("tasks", "delete", { taskId: two.task.id });
    await until(() => w.row(group.id, two.messageId)?.data.deleted === true);
    expect(w.row(group.id, two.messageId)).toMatchObject({
      kind: "task_card",
      data: {
        taskId: two.task.id,
        deleted: true,
        captainAssignmentId: two.assignment.id,
        captainRound: 1,
        taskNumber: two.task.number,
      },
    });
    expect(captain.store.assignment(two.assignment.id)).toMatchObject({
      status: "cancelled",
      targets: [{ agentId: ada.id, taskCount: 0, status: "cancelled" }],
    });
    void call;
  });
});
