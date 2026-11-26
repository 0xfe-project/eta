/**
 * `assign_in_group` is pure group communication/coordination: it does not block `assignee` on or
 * attach `captainAssignmentId` to `create_task` or `draft_task`.
 *
 * Meanwhile, Inbox relay stays strictly scoped: questions asked inside a turn woken by
 * `assign_in_group`, or inside a task run created via `dispatch_task`, relay through Captain,
 * whereas questions from user-started turns or non-Captain tasks go directly to the user's Inbox.
 */
import type { InteractionView } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { call, gate, HANG, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const options = { captain: true, tasks: { runs: false } } as const;

describe("captain assignment turn decoupling", () => {
  it("allows create_task and draft_task with or without assignee during an assign_in_group turn without linking captainAssignmentId", async () => {
    let bea = "";
    const results: string[] = [];
    const { models } = scriptedModels((request) => {
      if (request.agent !== "Ada") return say("ok");
      if (request.lastRole === "toolResult") {
        results.push(request.last);
        if (results.length === 1)
          return call("draft_task", {
            title: "Delegated draft",
            goal: "Confirm ordinary drafting works with assignee",
            acceptance: "Drafted cleanly",
            workspace: "local",
            assignee: bea,
          });
        if (results.length === 2)
          return call("create_task", {
            title: "Self task",
            description: "Creator executes",
            workspace: "local",
            assignee: "   ",
          });
        return say("done");
      }
      return call("create_task", {
        title: "Delegated task",
        description: "Read the diff",
        workspace: "local",
        assignee: bea,
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

    const assigned = await captain.assign({
      conversationId: group.id,
      text: "Ada, coordinate with Bea and propose/create what is needed.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, assigned.replyIds[0]!);

    expect(results).toHaveLength(3);
    expect(results[0]).toBe(
      'Created task #1 "Delegated task", executed by Bea.',
    );
    expect(results[1]).toContain("executed by Bea");
    expect(results[2]).toBe('Created task #2 "Self task".');

    const rows = w.host.db
      .query<
        {
          number: number;
          assignee_agent: string | null;
          captain_assignment_id: string | null;
        },
        []
      >(
        "SELECT number, assignee_agent, captain_assignment_id FROM task ORDER BY number",
      )
      .all();
    expect(rows).toEqual([
      { number: 1, assignee_agent: bea, captain_assignment_id: null },
      { number: 2, assignee_agent: null, captain_assignment_id: null },
    ]);

    const draft = w.rows(group.id).find((row) => row.kind === "task_draft")!;
    expect(draft.data.assignee).toBe(bea);
    expect(draft.data.captainAssignmentId).toBeUndefined();
  });

  it("shows the user a question asked in a turn an assign_in_group did not start", async () => {
    const hold = gate();
    const { models } = scriptedModels(async (request) => {
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
      await hold.opened;
      return say("Investigated.");
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
      text: "Ada, investigate.",
      agentIds: [ada.id],
    });
    expect(
      captain.store.openAssignmentFor(group.id, ada.id, assigned.replyIds[0]!),
    ).toBeDefined();

    // Release Captain's turn so Ada answers a separate user turn in the group.
    hold.open();
    await w.settled(group.id, assigned.replyIds[0]!);

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

  it("relays ask_user from a dispatch_task run through Captain while keeping non-Captain task runs in the user's Inbox", async () => {
    let dispatchedTitle = "";
    const { models } = scriptedModels((request) => {
      if (request.agent === "Captain") {
        const field = (key: string) =>
          new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(
            request.transcript.join("\n"),
          )?.[1];
        if (request.lastRole === "toolResult") return say("Relayed.");
        const id = field("interactionId");
        return id === undefined
          ? say("ok")
          : call("relay_inbox_to_user", { interactionId: id });
      }
      if (request.system.includes("In this task you are")) {
        if (request.lastRole === "toolResult") return say("waiting");
        if (request.transcript[0]?.includes(dispatchedTitle))
          return call(
            "ask_user",
            { question: "Captain question?" },
            "cap-task-q",
          );
        return call("ask_user", { question: "User question?" }, "user-task-q");
      }
      return say("ok");
    });

    const w = await world({ captain: true, models });
    const ada = await w.agent("Ada");
    const bea = await w.agent("Bea");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id, bea.id], "inbox-scope");
    await w.watch(group.id);
    w.client.subscribe("inbox");
    const direct = await w.host.product.captain.direct();
    await w.watch(direct.conversationId);

    dispatchedTitle = "Captain work";
    const dispatched = await w.host.product.captain.dispatchTask({
      conversationId: group.id,
      title: dispatchedTitle,
      description: "Needs clarification",
      assignee: ada.id,
      workspace: "local",
    });

    // Unrelated ordinary task in the SAME group executed by Bea.
    w.host.product.board.create(
      {
        title: "Ordinary work",
        description: "Direct user ask",
        conversationId: group.id,
        workspace: "local",
        assignee: bea.id,
      },
      { kind: "agent", agentId: ada.id },
    );

    const inbox = (): InteractionView[] =>
      w.client.section<InteractionView[]>("inbox", "list") ?? [];

    // Bea's ordinary task question goes directly to the user's Inbox.
    await until(() =>
      inbox().some(
        (item) =>
          item.status === "pending" &&
          item.agentId === bea.id &&
          item.prompt === "User question?",
      ),
    );
    // Ada's dispatch_task question is relayed by Captain and hidden directly as Ada's pending ask.
    await until(() =>
      inbox().some(
        (item) =>
          item.status === "pending" &&
          item.agentId === direct.agentId &&
          item.prompt === "Captain question?",
      ),
    );
    expect(
      inbox().some(
        (item) =>
          item.agentId === ada.id && item.prompt === "Captain question?",
      ),
    ).toBe(false);

    const capAsk = w.host.db
      .query<{ id: string; session_id: string }, [string]>(
        "SELECT id, session_id FROM interaction WHERE agent_id = ? AND prompt = 'Captain question?'",
      )
      .get(ada.id)!;
    expect(
      w.host.product.captain.assignmentForInbox({
        id: capAsk.id,
        sessionId: capAsk.session_id,
        agentId: ada.id,
        conversationId: group.id,
      } as InteractionView),
    ).toMatchObject({ assignmentId: dispatched.assignment.id });

    void HANG;
  });
});
