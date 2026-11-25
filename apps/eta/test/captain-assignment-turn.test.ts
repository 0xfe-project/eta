/**
 * An open Captain assignment binds the turn it woke the agent with, not the agent for as long as it
 * stays open. In any other turn the agent is an ordinary member of the group: it may hand a task to
 * another agent with "assignee", and a question it asks is the user's to see in the Inbox.
 */
import type { InteractionView } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const options = { captain: true, tasks: { runs: false } } as const;

describe("captain assignment turn", () => {
  it("lets an assigned agent hand a task to another agent in a turn the assignment did not start", async () => {
    let bea = "";
    let told = "";
    const { models } = scriptedModels((request) => {
      if (request.agent !== "Ada") return say("ok");
      if (request.lastRole === "toolResult") {
        if (request.transcript.join("\n").includes("hand the review"))
          told = request.last;
        return say("done");
      }
      if (request.last.includes("hand the review"))
        return call("create_task", {
          title: "Review the patch",
          description: "Read the diff",
          workspace: "local",
          assignee: bea,
        });
      return call("create_task", {
        title: "Ship the patch",
        description: "Do the implementation",
        workspace: "local",
      });
    });
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const other = await w.agent("Bea");
    bea = other.id;
    const project = await w.project();
    const group = await w.group(project.id, [ada.id, other.id], "handoff");
    await w.watch(group.id);
    const captain = w.host.product.captain;

    // The assignment's own turn makes a task, so the assignment stays open (working).
    const assigned = await captain.assign({
      conversationId: group.id,
      text: "Ada, implement it.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, assigned.replyIds[0]!);
    await until(
      () =>
        captain.store.assignment(assigned.assignment.id)!.targets[0]!.status ===
        "working",
    );
    expect(captain.store.openAssignmentFor(group.id, ada.id)).toBeDefined();

    // The user then asks Ada for something else: a turn the assignment did not start.
    await w.send(group.id, "Ada, hand the review to Bea.");
    const handed = () =>
      w.host.db
        .query<
          { assignee_agent: string; captain_assignment_id: string | null },
          [string]
        >(
          "SELECT assignee_agent, captain_assignment_id FROM task WHERE assignee_agent = ?",
        )
        .get(bea);
    await until(() => handed() !== null || told !== "");
    expect(told).not.toMatch(/do not use task.assignee/);

    // It is Bea's task, not the assignment's.
    expect(handed()).toEqual({
      assignee_agent: bea,
      captain_assignment_id: null,
    });
  });

  it("still refuses task.assignee in the turn the assignment started", async () => {
    let heard = "";
    let bea = "";
    const { models } = scriptedModels((request) => {
      if (request.agent !== "Ada") return say("ok");
      if (request.lastRole === "toolResult") {
        heard = request.last;
        return say("done");
      }
      return call("create_task", {
        title: "Wrong handoff",
        description: "Must stay with the assigned agent",
        workspace: "local",
        assignee: bea,
      });
    });
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const other = await w.agent("Bea");
    bea = other.id;
    const project = await w.project();
    const group = await w.group(project.id, [ada.id, other.id], "refused");
    await w.watch(group.id);

    const assigned = await w.host.product.captain.assign({
      conversationId: group.id,
      text: "Ada, make the fix.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, assigned.replyIds[0]!);

    expect(heard).toMatch(/do not use task.assignee/);
    expect(
      w.host.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task")
        .get()!.n,
    ).toBe(0);
  });

  it("shows the user a question asked in a turn the assignment did not start", async () => {
    const { models } = scriptedModels((request) => {
      if (request.agent !== "Ada") return say("ok");
      if (request.lastRole === "toolResult") return say("done");
      if (request.last.includes("which route"))
        return call(
          "ask_user",
          {
            question: "Which route should the task take?",
            options: [{ title: "fast" }, { title: "safe" }],
          },
          "ada-question",
        );
      return call("create_task", {
        title: "Ship the patch",
        description: "Do the implementation",
        workspace: "local",
      });
    });
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "inbox");
    await w.watch(group.id);
    w.client.subscribe("inbox");
    const captain = w.host.product.captain;

    const assigned = await captain.assign({
      conversationId: group.id,
      text: "Ada, implement it.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, assigned.replyIds[0]!);
    await until(
      () =>
        captain.store.assignment(assigned.assignment.id)!.targets[0]!.status ===
        "working",
    );
    expect(captain.store.openAssignmentFor(group.id, ada.id)).toBeDefined();

    await w.send(group.id, "Ada, which route do you prefer?");
    const asked = () =>
      w.host.db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM interaction WHERE agent_id = ? AND conversation_id = ? AND status = 'pending'",
        )
        .get(ada.id, group.id);
    await until(() => asked() !== null);
    const inbox = (): InteractionView[] =>
      w.client.section<InteractionView[]>("inbox", "list") ?? [];
    // The user's Inbox lists it: the assignment did not start this turn.
    await until(() => inbox().some((item) => item.id === asked()!.id));
  });
});
