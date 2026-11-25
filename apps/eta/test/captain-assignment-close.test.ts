/**
 * A Captain dispatch is open only while the work it asked for is going on. An agent that answers
 * the instruction without making a task has finished with it: the target must close when its reply
 * ends, or `openAssignmentFor` stays set for the whole group (refusing `task.assignee`, hiding the
 * agent's questions from the Inbox, and keeping Captain's review watching it).
 */
import type { InteractionView } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { call, gate, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const options = { captain: true, tasks: { runs: false } } as const;

describe("captain assignment closing", () => {
  it("closes a dispatch the agent answered without making a task", async () => {
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
    // What `assignment()` in create_task / draft_task asks, and what the Inbox filter asks.
    expect(captain.store.openAssignmentFor(group.id, ada.id)).toBeUndefined();
    expect(captain.assignmentForAgent(group.id, ada.id)).toBeUndefined();
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

  it("keeps the dispatch open while the agent's reply is still running", async () => {
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
      // Where a task made in this turn is linked to the dispatch, and where a question is relayed.
      expect(captain.assignmentForAgent(group.id, ada.id)).toMatchObject({
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
      () => captain.assignmentForAgent(group.id, ada.id) === undefined,
    );
  });

  it("leaves a dispatch that has a task working", async () => {
    const { models } = scriptedModels((request) =>
      request.lastRole === "toolResult"
        ? say("I made the task.")
        : call("create_task", {
            title: "Ship the patch",
            description: "Do the implementation",
            workspace: "local",
          }),
    );
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "with-task");
    await w.watch(group.id);
    const captain = w.host.product.captain;

    const assigned = await captain.assign({
      conversationId: group.id,
      text: "Ada, implement it.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, assigned.replyIds[0]!);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(
      captain.store.assignment(assigned.assignment.id)!.targets[0],
    ).toMatchObject({ agentId: ada.id, taskCount: 1, status: "working" });
    expect(captain.assignmentForAgent(group.id, ada.id)).toMatchObject({
      assignmentId: assigned.assignment.id,
    });
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

  it("reopens the target when a task the agent drafted is confirmed after the reply", async () => {
    const { models } = scriptedModels((request) =>
      request.lastRole === "toolResult"
        ? say("Drafted.")
        : call("draft_task", {
            title: "Drafted under Captain",
            goal: "Keep the source visible",
            acceptance: "The task names the assignment",
            workspace: "local",
          }),
    );
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "draft-after-reply");
    await w.watch(group.id);
    const captain = w.host.product.captain;

    const assigned = await captain.assign({
      conversationId: group.id,
      text: "Ada, draft the follow-up.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, assigned.replyIds[0]!);
    // A draft is a proposal, not a task: the reply ended with none, so the dispatch closes.
    await until(
      () =>
        captain.store.assignment(assigned.assignment.id)!.targets[0]!.status ===
        "completed",
    );
    const draft = w.rows(group.id).find((row) => row.kind === "task_draft")!;
    await w.client.call("tasks", "confirmDraft", {
      conversationId: group.id,
      messageId: draft.id,
    });

    const after = captain.store.assignment(assigned.assignment.id)!;
    expect(after.targets[0]).toMatchObject({ taskCount: 1, status: "working" });
    expect(after.status).toBe("working");
  });
});
