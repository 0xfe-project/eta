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
    await until(() => handed() !== null && told !== "");
    expect(told).not.toMatch(
      /cannot set assignee during a turn bound to an active dispatch assignment/,
    );
    expect(told).toBe('Created task #2 "Review the patch", executed by Bea.');

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

    expect(heard).toBe(
      "cannot set assignee during a turn bound to an active dispatch assignment; omit assignee so you remain both creator and executor",
    );
    expect(
      w.host.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task")
        .get()!.n,
    ).toBe(0);
  });

  it("refuses non-blank assignee on draft_task in the turn the assignment started", async () => {
    let heard = "";
    let bea = "";
    const { models } = scriptedModels((request) => {
      if (request.agent !== "Ada") return say("ok");
      if (request.lastRole === "toolResult") {
        heard = request.last;
        return say("done");
      }
      return call("draft_task", {
        title: "Wrong draft handoff",
        goal: "Must stay with the assigned agent",
        acceptance: "Never drafted",
        workspace: "local",
        assignee: bea,
      });
    });
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const other = await w.agent("Bea");
    bea = other.id;
    const project = await w.project();
    const group = await w.group(
      project.id,
      [ada.id, other.id],
      "draft-refused",
    );
    await w.watch(group.id);

    const assigned = await w.host.product.captain.assign({
      conversationId: group.id,
      text: "Ada, draft the fix.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, assigned.replyIds[0]!);

    expect(heard).toBe(
      "cannot set assignee during a turn bound to an active dispatch assignment; omit assignee so you remain both creator and executor",
    );
    expect(w.rows(group.id).some((row) => row.kind === "task_draft")).toBe(
      false,
    );
  });

  it("normalizes blank and whitespace assignee on create_task and draft_task during an active dispatch turn", async () => {
    const results: string[] = [];
    const { models } = scriptedModels((request) => {
      if (request.agent !== "Ada") return say("ok");
      if (request.lastRole === "toolResult") {
        results.push(request.last);
        return results.length >= 2
          ? say("done")
          : call("draft_task", {
              title: "Blank assignee draft",
              goal: "Keep assignment provenance",
              acceptance: "Drafted cleanly",
              workspace: "local",
              assignee: "   ",
            });
      }
      return call("create_task", {
        title: "Blank assignee task",
        description: "Keep assignment provenance",
        workspace: "local",
        assignee: "",
      });
    });
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "blank-assignee");
    await w.watch(group.id);

    const assigned = await w.host.product.captain.assign({
      conversationId: group.id,
      text: "Ada, handle both.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, assigned.replyIds[0]!);

    expect(results).toHaveLength(2);
    expect(results[0]).toBe('Created task #1 "Blank assignee task".');
    expect(results[1]).not.toContain("executed by");

    const taskRow = w.host.db
      .query<
        { assignee_agent: string | null; captain_assignment_id: string | null },
        []
      >(
        "SELECT assignee_agent, captain_assignment_id FROM task WHERE number = 1",
      )
      .get();
    expect(taskRow).toEqual({
      assignee_agent: null,
      captain_assignment_id: assigned.assignment.id,
    });

    const draft = w.rows(group.id).find((row) => row.kind === "task_draft")!;
    expect(draft.data.assignee).toBeUndefined();
    expect(draft.data.captainAssignmentId).toBe(assigned.assignment.id);
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
  it("keeps an assignment off the tasks a later turn makes without an assignee", async () => {
    const told: string[] = [];
    const { models } = scriptedModels((request) => {
      if (request.agent !== "Ada") return say("ok");
      if (request.lastRole === "toolResult") {
        told.push(request.last);
        if (request.last.includes("Unrelated own task"))
          return call("draft_task", {
            title: "Unrelated own draft",
            goal: "Ada's own work",
            acceptance: "Never the assignment's",
            workspace: "local",
          });
        return say("done");
      }
      if (request.last.includes("for yourself"))
        return call("create_task", {
          title: "Unrelated own task",
          description: "Ada's own work",
          workspace: "local",
        });
      return call("create_task", {
        title: "Ship the patch",
        description: "Do the implementation",
        workspace: "local",
      });
    });
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "unbound-turn");
    await w.watch(group.id);
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

    // The assignment's own turn: the task it makes is the assignment's.
    const own = () =>
      w.host.db
        .query<{ captain_assignment_id: string | null }, []>(
          "SELECT captain_assignment_id FROM task WHERE title = 'Ship the patch'",
        )
        .get();
    await until(() => own() !== null);
    expect(own()!.captain_assignment_id).toBe(assigned.assignment.id);

    // A later turn the assignment did not start: naming nobody means the agent itself,
    // not the assignment that is still open.
    await w.send(group.id, "Ada, also do something else for yourself.");
    const later = () =>
      w.host.db
        .query<{ captain_assignment_id: string | null }, []>(
          "SELECT captain_assignment_id FROM task WHERE title = 'Unrelated own task'",
        )
        .get();
    await until(() => later() !== null);
    await until(() => told.length >= 3);
    expect(later()!.captain_assignment_id).toBeNull();
    const draft = w.rows(group.id).find((row) => row.kind === "task_draft")!;
    expect(draft.data.captainAssignmentId).toBeUndefined();

    // Nor does the assignment count a task it never asked for.
    expect(
      w.host.db
        .query<{ task_count: number }, [string]>(
          "SELECT task_count FROM captain_assignment_target WHERE assignment_id = ?",
        )
        .get(assigned.assignment.id)!.task_count,
    ).toBe(1);
  });
});
