/**
 * El Capitan's product boundary: one system identity, visible group authorization, task
 * provenance, protected prompts/settings, memory pauses and the operational supervisor.
 *
 * These tests use the real host/database/wire path where that is useful. Captain's session tools
 * themselves are exercised through the scripted model in the assignment tests, so the important
 * distinction is observable: Captain sends the instruction; the assigned agent creates the task.
 */
import type {
  CaptainIdentityView,
  InboxResponse,
  InteractionView,
} from "@eta/client-contracts";
import { describe, expect, it, vi } from "vitest";
import { taskKey } from "../src/session-owner";
import { until } from "./support/client";
import { call, gate, HANG, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const options = { captain: true, tasks: { runs: false } } as const;

/**
 * Rows in `captain_notification`. Captain raises no alerts any more (what one said is already on the
 * board, in the Inbox or on the task), so none of these paths writes one.
 */
function notificationCount(w: Awaited<ReturnType<typeof world>>): number {
  return w.host.db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM captain_notification")
    .get()!.n;
}

async function captainWorld() {
  const { models, requests } = scriptedModels(() => say("Captain ready."));
  const w = await world({ ...options, models });
  return { w, models, requests };
}

describe("captain identity", () => {
  it("is one system agent and cannot be managed as an ordinary agent", async () => {
    const { w } = await captainWorld();
    const identity = (await w.client.call("captain", "ensure", {})) as {
      identity: CaptainIdentityView;
      created: boolean;
    };
    const again = (await w.client.call("captain", "ensure", {})) as {
      identity: CaptainIdentityView;
      created: boolean;
    };
    expect(identity.created).toBe(false);
    expect(again.identity.agentId).toBe(identity.identity.agentId);
    expect(
      w.host.db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM agent WHERE system_role = 'captain'",
        )
        .get()!.n,
    ).toBe(1);

    await expect(
      w.client.call("agents", "update", {
        agentId: identity.identity.agentId,
        model: "fake:not-captain",
      }),
    ).rejects.toThrow(/Captain/);
    await expect(
      w.client.call("agents", "delete", {
        agentId: identity.identity.agentId,
      }),
    ).rejects.toThrow(/Captain/);
    expect(
      w.host.server.mounted().some((plugin) => plugin.name === "captain"),
    ).toBe(true);
    const direct = (await w.client.call("captain", "direct", {})) as {
      identity: CaptainIdentityView;
      conversationId: string;
    };
    w.client.subscribe(`conversations.${direct.conversationId}`);
    await until(
      () =>
        w.client.section(`conversations.${direct.conversationId}`, "info") !==
        undefined,
    );
    expect(
      w.client.section(`conversations.${direct.conversationId}`, "info"),
    ).toMatchObject({ id: direct.conversationId, kind: "captain" });
  });

  it("has its conversation as soon as the host starts, before anyone opens it", async () => {
    const { w } = await captainWorld();
    // Nothing on this side asks for Captain: the page shows what the host started with.
    w.client.subscribe("captain");
    await until(
      () =>
        w.client.section<CaptainIdentityView | null>("captain", "identity")
          ?.conversationId != null,
    );
    const identity = w.client.section<CaptainIdentityView>(
      "captain",
      "identity",
    )!;
    expect(
      w.host.db
        .query<{ kind: string; archived: number; agent_id: string }, [string]>(
          `SELECT c.kind, c.archived, p.agent_id FROM conversation c
             JOIN participant p ON p.conversation_id = c.id WHERE c.id = ?`,
        )
        .all(identity.conversationId!),
    ).toEqual([{ kind: "captain", archived: 0, agent_id: identity.agentId }]);
    const direct = (await w.client.call("captain", "direct", {})) as {
      conversationId: string;
    };
    expect(direct.conversationId).toBe(identity.conversationId);
  });

  it("refuses to archive its conversation, and nobody else's", async () => {
    const { w } = await captainWorld();
    const { conversationId } = (await w.client.call(
      "captain",
      "direct",
      {},
    )) as {
      conversationId: string;
    };
    await expect(
      w.client.call("conversations", "update", {
        conversationId,
        archived: true,
      }),
    ).rejects.toThrow(/Captain's conversation cannot be changed/);
    expect(
      w.host.db
        .query<{ archived: number }, [string]>(
          "SELECT archived FROM conversation WHERE id = ?",
        )
        .get(conversationId)!.archived,
    ).toBe(0);
    // Nor is it renamed: nothing about it is edited (`captain/policy.ts`).
    await expect(
      w.client.call("conversations", "update", {
        conversationId,
        name: "Bridge",
      }),
    ).rejects.toThrow(/Captain's conversation cannot be changed/);

    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id]);
    await w.client.call("conversations", "update", {
      conversationId: group.id,
      archived: true,
    });
    expect(
      w.host.db
        .query<{ archived: number }, [string]>(
          "SELECT archived FROM conversation WHERE id = ?",
        )
        .get(group.id)!.archived,
    ).toBe(1);
  });

  it("gives back a conversation an older build left missing or archived", async () => {
    const { w } = await captainWorld();
    const first = (await w.client.call("captain", "direct", {})) as {
      conversationId: string;
    };
    // An older build archived it, before archiving it was refused.
    w.host.db
      .query("UPDATE conversation SET archived = 1 WHERE id = ?")
      .run(first.conversationId);
    const unarchived = (await w.client.call("captain", "ensure", {})) as {
      identity: CaptainIdentityView;
    };
    expect(unarchived.identity.conversationId).toBe(first.conversationId);
    expect(
      w.host.db
        .query<{ archived: number }, [string]>(
          "SELECT archived FROM conversation WHERE id = ?",
        )
        .get(first.conversationId)!.archived,
    ).toBe(0);

    // An older build made Captain with no conversation at all; the drawer used to make it.
    w.host.db
      .query("DELETE FROM participant WHERE conversation_id = ?")
      .run(first.conversationId);
    w.host.db
      .query("DELETE FROM conversation WHERE id = ?")
      .run(first.conversationId);
    const remade = (await w.client.call("captain", "ensure", {})) as {
      identity: CaptainIdentityView;
      created: boolean;
    };
    expect(remade.created).toBe(false);
    expect(remade.identity.conversationId).not.toBeNull();
    expect(remade.identity.conversationId).not.toBe(first.conversationId);
  });
});

describe("captain assignment", () => {
  it("addresses the group steward when no agent is named", async () => {
    const { models } = scriptedModels(() => say("On it."));
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const bola = await w.agent("Bola");
    const project = await w.project();
    const group = await w.group(
      project.id,
      [ada.id, bola.id],
      "steward-default",
      bola.id,
    );
    await w.watch(group.id);

    const assigned = await w.host.product.captain.assign({
      conversationId: group.id,
      text: "Please handle this.",
    });
    await w.settled(group.id, assigned.replyIds[0]!);
    expect(assigned.assignment.targets.map((target) => target.agentId)).toEqual(
      [bola.id],
    );
    expect(
      w.host.product.captain.store
        .assignment(assigned.assignment.id)!
        .targets.map((target) => target.agentId),
    ).toEqual([bola.id]);
  });

  it("with no steward, addresses the only member, and refuses a larger group without pulling anyone in", async () => {
    const { models } = scriptedModels(() => say("On it."));
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const bola = await w.agent("Bola");
    const cy = await w.agent("Cy");
    const project = await w.project();
    const solo = await w.group(project.id, [ada.id], "solo", null);
    const crowd = await w.group(project.id, [bola.id, cy.id], "crowd", null);
    await w.watch(solo.id);

    const assigned = await w.host.product.captain.assign({
      conversationId: solo.id,
      text: "Please handle this.",
    });
    await w.settled(solo.id, assigned.replyIds[0]!);
    expect(assigned.assignment.targets.map((target) => target.agentId)).toEqual(
      [ada.id],
    );

    await expect(
      w.host.product.captain.assign({
        conversationId: crowd.id,
        text: "Someone take this.",
      }),
    ).rejects.toThrow(/no steward/);
    const members = w.host.db
      .query<{ agent_id: string }, [string]>(
        "SELECT agent_id FROM participant WHERE conversation_id = ? ORDER BY invited_at",
      )
      .all(crowd.id)
      .map((row) => row.agent_id);
    expect([...members].sort()).toEqual([bola.id, cy.id].sort());
  });

  it("lets Captain omit agentIds and address the steward through its tool", async () => {
    let targetGroupId = "";
    const { models } = scriptedModels((request) => {
      if (request.agent === "Captain")
        return request.lastRole === "toolResult"
          ? say("Instruction sent.")
          : call("assign_in_group", {
              conversationId: targetGroupId,
              text: "Please own the next step.",
            });
      return say("On it.");
    });
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "captain-tool-steward");
    targetGroupId = group.id;
    await w.watch(group.id);
    const captain = await w.host.product.captain.direct();
    await w.watch(captain.conversationId);

    const sent = await w.send(captain.conversationId, "Handle the group.");
    await w.settled(captain.conversationId, sent.replies[0]!.id);
    const assignment = w.host.product.captain.store.assignments()[0]!;
    expect(assignment.targets.map((target) => target.agentId)).toEqual([
      ada.id,
    ]);
    await until(() =>
      w
        .rows(group.id)
        .some((row) => row.author === "captain" && row.status === "done"),
    );
  });

  it("dispatches a task directly through dispatch_task without waking a chat turn", async () => {
    let targetGroupId = "";
    const { models } = scriptedModels((request) => {
      if (request.agent === "Captain")
        return request.lastRole === "toolResult"
          ? say(`Result: ${request.last}`)
          : call("dispatch_task", {
              conversationId: targetGroupId,
              title: "Ship the Captain patch",
              description: "Implement and verify the patch",
              assignee: "Ada",
              workspace: "local",
            });
      return say("Unexpected chat reply.");
    });
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "release");
    targetGroupId = group.id;
    await w.watch(group.id);
    const captain = await w.host.product.captain.direct();
    await w.watch(captain.conversationId);

    const sent = await w.send(captain.conversationId, "Dispatch Ada to ship.");
    const reply = await w.settled(captain.conversationId, sent.replies[0]!.id);
    expect(reply.text).toContain(
      'Dispatched task #1 "Ship the Captain patch" to Ada',
    );

    const groupRows = w.rows(group.id);
    // Visible Captain announcement in the group, without waking an agent chat reply.
    expect(groupRows.some((row) => row.author === "captain")).toBe(true);
    expect(groupRows.some((row) => row.author === "agent")).toBe(false);

    const captainMsg = groupRows.find((row) => row.author === "captain")!;
    const assignment = w.host.product.captain.store.assignments()[0]!;
    expect(captainMsg.kind).toBe("task_card");
    expect(captainMsg.agentId).toBe(captain.agentId);
    expect(captainMsg.mentions).toEqual([ada.id]);
    expect(captainMsg.text).toBe(
      'Dispatched task "Ship the Captain patch" to Ada.',
    );
    expect(captainMsg.data).toEqual({
      taskId: expect.any(String),
      number: 1,
      title: "Ship the Captain patch",
      status: "todo",
      runStatus: null,
      conversationId: group.id,
      comments: 0,
      summary: "",
      artifacts: [],
      captainAssignmentId: assignment.id,
      captainRound: 1,
      taskNumber: 1,
    });
    expect(captainMsg.data.captainNote).toBeUndefined();

    const task = w.host.db
      .query<
        {
          id: string;
          created_by_agent: string;
          assignee_agent: string | null;
          captain_assignment_id: string;
          captain_message_id: string;
        },
        []
      >(
        `SELECT id, created_by_agent, assignee_agent, captain_assignment_id,
                captain_message_id
           FROM task`,
      )
      .get()!;
    expect(task).toEqual({
      id: task.id,
      created_by_agent: captain.agentId,
      assignee_agent: ada.id,
      captain_assignment_id: assignment.id,
      captain_message_id: captainMsg.id,
    });
    expect(assignment.status).toBe("working");
    expect(assignment.targets[0]).toMatchObject({
      agentId: ada.id,
      taskCount: 1,
      status: "working",
    });
  });

  it("defaults dispatch_task assignee to steward or sole member, supports staged trees, and validates boundaries", async () => {
    const { models } = scriptedModels(() => say("ok"));
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const bola = await w.agent("Bola");
    const outsider = await w.agent("Outsider");
    const project = await w.project();
    const stewarded = await w.group(
      project.id,
      [ada.id, bola.id],
      "stewarded",
      bola.id,
    );
    const crowd = await w.group(
      project.id,
      [ada.id, bola.id],
      "no-steward",
      null,
    );
    await w.watch(stewarded.id);
    const captain = await w.host.product.captain.direct();

    // Omitted assignee picks steward (Bola).
    const parent = await w.host.product.captain.dispatchTask({
      conversationId: stewarded.id,
      title: "Stage 1",
      description: "Parent stage",
      status: "backlog",
      workspace: "local",
    });
    expect(parent.task.assigneeAgentId).toBe(bola.id);
    expect(parent.task.status).toBe("backlog");

    // Child under parent with dependency inside the same dispatch.
    const stepA = await w.host.product.captain.dispatchTask({
      conversationId: stewarded.id,
      title: "Step A",
      description: "First step",
      assignee: ada.id,
      parent: `#${parent.task.number}`,
      status: "backlog",
      workspace: "local",
    });
    const stepB = await w.host.product.captain.dispatchTask({
      conversationId: stewarded.id,
      title: "Step B",
      description: "Second step",
      assignee: "Bola",
      parent: `#${parent.task.number}`,
      dependsOn: [{ task: stepA.task.id, requireDone: true }],
      status: "backlog",
      workspace: "local",
      message: "Bola takes Step B after Step A.",
    });
    expect(stepB.task.parentId).toBe(parent.task.id);
    expect(stepB.task.dependsOn).toEqual([
      expect.objectContaining({ taskId: stepA.task.id, requireDone: true }),
    ]);
    await until(() => w.row(stewarded.id, stepB.messageId) !== undefined);
    expect(w.row(stewarded.id, parent.messageId)).toMatchObject({
      kind: "task_card",
    });
    expect(
      w.row(stewarded.id, parent.messageId)?.data.captainNote,
    ).toBeUndefined();
    expect(w.row(stewarded.id, stepB.messageId)).toMatchObject({
      kind: "task_card",
      text: "Bola takes Step B after Step A.",
      data: {
        taskId: stepB.task.id,
        number: stepB.task.number,
        captainAssignmentId: stepB.assignment.id,
        captainNote: "Bola takes Step B after Step A.",
        taskNumber: stepB.task.number,
      },
    });

    // Refuses non-member, Captain, multi-member with no steward, Captain's direct chat, and archived group.
    const beforeCount = w.host.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task")
      .get()!.n;
    const beforeAssignments = w.host.product.captain.store.assignments().length;
    const beforeSeq = w.rows(stewarded.id).length;

    await expect(
      w.host.product.captain.dispatchTask({
        conversationId: stewarded.id,
        title: "Bad outsider",
        description: "x",
        assignee: outsider.id,
      }),
    ).rejects.toThrow(/not a member/);
    for (const target of [captain.agentId, "Captain"])
      await expect(
        w.host.product.captain.dispatchTask({
          conversationId: stewarded.id,
          title: "Bad captain",
          description: "x",
          assignee: target,
        }),
      ).rejects.toThrow(/Captain cannot be assigned/);
    await expect(
      w.host.product.captain.dispatchTask({
        conversationId: crowd.id,
        title: "No steward",
        description: "x",
      }),
    ).rejects.toThrow(/no steward/);
    await expect(
      w.host.product.captain.dispatchTask({
        conversationId: captain.conversationId,
        title: "Direct chat",
        description: "x",
        assignee: ada.id,
      }),
    ).rejects.toThrow(/group conversations/);
    // Invalid parent/dependsOn rolls back the atomic transaction (no orphan message or assignment).
    await expect(
      w.host.product.captain.dispatchTask({
        conversationId: stewarded.id,
        title: "Broken dep",
        description: "x",
        dependsOn: [{ task: "#9999" }],
      }),
    ).rejects.toThrow(/no such task/);

    expect(
      w.host.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task")
        .get()!.n,
    ).toBe(beforeCount);
    expect(w.host.product.captain.store.assignments()).toHaveLength(
      beforeAssignments,
    );
    expect(w.rows(stewarded.id)).toHaveLength(beforeSeq);

    await w.client.call("conversations", "update", {
      conversationId: crowd.id,
      archived: true,
    });
    await expect(
      w.host.product.captain.dispatchTask({
        conversationId: crowd.id,
        title: "Archived group",
        description: "x",
        assignee: ada.id,
      }),
    ).rejects.toThrow(/archived/);
  });

  it("runs a dispatch_task as the assigned member end-to-end and completes the assignment without waking Captain as maker", async () => {
    let runCount = 0;
    let runSystem = "";
    const { models } = scriptedModels((request) => {
      if (request.system.includes("In this task you are")) {
        runCount += 1;
        runSystem = request.system;
        return request.lastRole === "toolResult"
          ? say("Finished.")
          : call("finish_task", { summary: "Implemented and verified." });
      }
      return say("ok");
    });
    // Runs enabled so the dispatched task executes in its own session as Ada.
    const w = await world({ captain: true, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "e2e-dispatch");
    await w.watch(group.id);
    await w.client.call("tasks", "setSettings", { reactToResults: true });

    const dispatched = await w.host.product.captain.dispatchTask({
      conversationId: group.id,
      title: "Run end to end",
      description: "Implement cleanly",
      assignee: ada.id,
      workspace: "local",
    });

    await until(
      () =>
        w.host.product.board.detail(dispatched.task.id)?.status === "in_review",
    );
    expect(runSystem).toContain("In this task you are Ada");
    // Only Ada ran it (reactToResults does NOT wake Captain as maker).
    expect(runCount).toBe(1);
    expect(
      w
        .rows(group.id)
        .some(
          (row) =>
            row.author === "agent" &&
            row.agentId === ada.id &&
            row.text.includes("Implemented and verified."),
        ),
    ).toBe(true);
    await until(
      () =>
        w.host.product.captain.store.assignment(dispatched.assignment.id)
          ?.targets[0]?.status === "completed",
    );
    expect(
      w.host.product.captain.store.assignment(dispatched.assignment.id),
    ).toMatchObject({
      status: "completed",
      targets: [{ agentId: ada.id, taskCount: 1, status: "completed" }],
    });
  });

  it("syncs a Captain-dispatched task_card on update, comment, and delete while preserving Captain provenance", async () => {
    const { models } = scriptedModels(() => say("ok"));
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "sync-dispatch");
    await w.watch(group.id);

    const dispatched = await w.host.product.captain.dispatchTask({
      conversationId: group.id,
      title: "Initial title",
      description: "Track lifecycle",
      assignee: ada.id,
      status: "backlog",
      workspace: "local",
      message: "Ada, prioritize this.",
    });

    const row = () => w.row(group.id, dispatched.messageId)!;
    const rev = () =>
      w.host.db
        .query<{ revision: number }, [string]>(
          "SELECT revision FROM message WHERE id = ?",
        )
        .get(dispatched.messageId)!.revision;

    await until(() => row()?.kind === "task_card");
    expect(row().data).toMatchObject({
      taskId: dispatched.task.id,
      number: dispatched.task.number,
      title: "Initial title",
      status: "backlog",
      captainAssignmentId: dispatched.assignment.id,
      captainRound: 1,
      captainNote: "Ada, prioritize this.",
      taskNumber: dispatched.task.number,
    });
    let lastRev = rev();

    await w.client.call("tasks", "update", {
      taskId: dispatched.task.id,
      status: "in_progress",
      title: "Updated title",
    });
    await until(() => row().data.status === "in_progress");
    expect(row().data).toMatchObject({
      taskId: dispatched.task.id,
      number: dispatched.task.number,
      title: "Updated title",
      status: "in_progress",
      captainAssignmentId: dispatched.assignment.id,
      captainRound: 1,
      captainNote: "Ada, prioritize this.",
      taskNumber: dispatched.task.number,
    });
    expect(rev()).toBeGreaterThan(lastRev);
    lastRev = rev();

    // No-op update leaves revision unchanged because card data key order is deterministic.
    await w.client.call("tasks", "update", {
      taskId: dispatched.task.id,
      status: "in_progress",
    });
    expect(rev()).toBe(lastRev);

    await w.client.call("tasks", "comment", {
      taskId: dispatched.task.id,
      body: "Found the root cause",
    });
    await until(() => row().data.comments === 1);
    expect(row().data).toMatchObject({
      comments: 1,
      summary: "Found the root cause",
      captainAssignmentId: dispatched.assignment.id,
      captainRound: 1,
      captainNote: "Ada, prioritize this.",
      taskNumber: dispatched.task.number,
    });

    await w.client.call("tasks", "delete", { taskId: dispatched.task.id });
    await until(() => row().data.deleted === true);
    expect(row()).toMatchObject({
      kind: "task_card",
      data: {
        taskId: dispatched.task.id,
        number: dispatched.task.number,
        title: "Updated title",
        deleted: true,
        captainAssignmentId: dispatched.assignment.id,
        captainRound: 1,
        captainNote: "Ada, prioritize this.",
        taskNumber: dispatched.task.number,
      },
    });
  });

  it("includes Captain's dispatch_task card text in the briefing of woken group agents", async () => {
    const { models, requests } = scriptedModels(() => say("Got it."));
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "briefing-dispatch");
    await w.watch(group.id);

    await w.host.product.captain.dispatchTask({
      conversationId: group.id,
      title: "Ship briefing fix",
      description: "Check briefing",
      assignee: ada.id,
      status: "backlog",
      workspace: "local",
    });
    await w.host.product.captain.dispatchTask({
      conversationId: group.id,
      title: "Follow-up check",
      description: "Check custom note",
      assignee: ada.id,
      status: "backlog",
      workspace: "local",
      message: "Custom Captain dispatch note for Ada.",
    });

    const sent = await w.send(group.id, "Status check?");
    await w.settled(group.id, sent.replies[0]!.id);
    const adaRequest = requests.find((req) => req.agent === "Ada")!;
    expect(adaRequest).toBeDefined();
    expect(adaRequest.last).toContain(
      'Dispatched task "Ship briefing fix" to Ada.',
    );
    expect(adaRequest.last).toContain("Custom Captain dispatch note for Ada.");
  });
});

describe("captain controls", () => {
  it("sets Captain's model through its own target and updates the open session", async () => {
    const { w } = await captainWorld();
    const direct = await w.host.product.captain.direct();
    const captainId = direct.agentId;
    await w.watch(direct.conversationId);
    const sent = await w.send(direct.conversationId, "hello");
    await w.settled(direct.conversationId, sent.replies[0]!.id);
    const sessionId = w.client.section<{ sessionId: string }[]>(
      `conversations.${direct.conversationId}`,
      "members",
    )![0]!.sessionId;
    const config = () =>
      w.host.server.sessions
        .openSessions()
        .find((entry) => entry.meta.id === sessionId)!.session.kernel.config;

    await expect(
      w.client.call("captain", "setModel", { model: "not-a-model" }),
    ).rejects.toThrow(/provider:modelId/);
    const saved = (await w.client.call("captain", "setModel", {
      model: "fake:chosen",
    })) as { identity: CaptainIdentityView };

    expect(saved.identity).toMatchObject({
      agentId: captainId,
      model: "fake:chosen",
    });
    expect(
      w.host.db
        .query<{ model: string | null }, [string]>(
          "SELECT model FROM agent WHERE id = ?",
        )
        .get(captainId),
    ).toEqual({ model: "fake:chosen" });
    expect(config().read("model")).toEqual({
      provider: "fake",
      modelId: "chosen",
    });
    expect(
      w.host.server.sessions
        .openSessions()
        .some((entry) => entry.meta.id === sessionId),
    ).toBe(true);
  });

  it("applies a model saved during Captain's reply on the next wake", async () => {
    const active = gate();
    const { models, requests } = scriptedModels(async ({ index }) => {
      if (index === 0) await active.opened;
      return say("Captain ready.");
    });
    const w = await world({ ...options, models });
    const { conversationId } = await w.host.product.captain.direct();
    await w.watch(conversationId);
    const initial = await w.send(conversationId, "first");
    try {
      await until(() => requests.length === 1);
      const saved = (await w.client.call("captain", "setModel", {
        model: "fake:chosen",
      })) as { identity: CaptainIdentityView };
      expect(saved.identity.model).toBe("fake:chosen");
    } finally {
      active.open();
    }
    await w.settled(conversationId, initial.replies[0]!.id);

    const next = await w.send(conversationId, "second");
    expect((await w.settled(conversationId, next.replies[0]!.id)).status).toBe(
      "done",
    );
    const session = w.host.server.sessions
      .openSessions()
      .find((entry) => entry.meta.conversationId === conversationId);
    expect(session?.session.kernel.config.read("model")).toEqual({
      provider: "fake",
      modelId: "chosen",
    });
  });

  it("pauses memory for conversations and task runs", async () => {
    const { w } = await captainWorld();
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "memory");
    const task = w.host.product.board.create(
      {
        title: "Memory task",
        conversationId: group.id,
        workspace: "local",
      },
      { kind: "agent", agentId: ada.id },
    );

    await w.client.call("captain", "setMemoryPaused", {
      scopeType: "conversation",
      scopeId: group.id,
      paused: true,
    });
    expect(
      w.host.product.captain.memoryEnabled({ conversationId: group.id }),
    ).toBe(false);

    await w.client.call("captain", "setMemoryPaused", {
      scopeType: "task",
      scopeId: task.id,
      paused: true,
    });
    expect(
      w.host.product.captain.memoryEnabled({
        conversationId: taskKey(task.id),
      }),
    ).toBe(false);
  });

  it("versions prompts and settings, and protects the global and Captain prompts", async () => {
    const { w } = await captainWorld();
    const ada = await w.agent("Ada");
    const first = w.host.product.captain.setPrompt({
      subjectId: ada.id,
      kind: "instructions",
      content: "First instructions",
    });
    const second = w.host.product.captain.setPrompt({
      subjectId: ada.id,
      kind: "instructions",
      content: "Second instructions",
    });
    expect(second.version).toBe(first.version + 1);
    expect(
      w.host.product.captain.promptDiff(
        ada.id,
        "instructions",
        first.version,
        second.version,
      ).diff,
    ).toContain("+Second instructions");
    expect(
      w.host.product.captain.rollbackPrompt({
        subjectId: ada.id,
        kind: "instructions",
        version: first.version,
      }).content,
    ).toBe("First instructions");

    const setting = w.host.product.captain.setSetting("retryLimit", 3);
    expect(setting.value).toBe(3);
    expect(w.host.product.captain.setSetting("retryLimit", 4).value).toBe(4);
    expect(
      w.host.product.captain.rollbackSetting("retryLimit", setting.version)
        .value,
    ).toBe(3);

    const captain = w.host.product.captain.identity()!;
    await expect(
      w.client.call("captain", "setPrompt", {
        subjectId: captain.agentId,
        kind: "persona",
        content: "must be approved",
      }),
    ).rejects.toThrow(/approved Captain operation/);

    const operation = w.host.product.captain.createOperation({
      kind: "set_prompt",
      requiresApproval: true,
      payload: {
        subjectId: captain.agentId,
        kind: "persona",
        content: "approved persona",
      },
    });
    const applied = await w.host.product.captain.decideOperation(
      operation.id,
      "approve",
    );
    expect(applied.status).toBe("applied");
    expect(w.host.product.captain.store.captainAgent()?.persona).toBe(
      "approved persona",
    );

    const base = w.host.product.captain.createOperation({
      kind: "set_prompt",
      requiresApproval: true,
      payload: {
        subjectId: "global",
        kind: "base",
        content: "A new base.",
      },
    });
    expect(
      await w.host.product.captain.decideOperation(base.id, "approve"),
    ).toMatchObject({ status: "applied" });
    expect(w.host.product.baseSystemPromptFor()).toBe("A new base.");
  });

  it("applies an approved operation once, however often it is approved", async () => {
    const { w } = await captainWorld();
    const captain = w.host.product.captain;
    const before = captain.settingHistory("retryLimit").length;
    const operation = captain.createOperation({
      kind: "set_setting",
      requiresApproval: true,
      payload: { key: "retryLimit", value: 3 },
    });
    const decided = await Promise.allSettled([
      captain.decideOperation(operation.id, "approve"),
      captain.decideOperation(operation.id, "approve"),
    ]);
    expect(decided.map((one) => one.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(captain.store.operation(operation.id)!.status).toBe("applied");
    expect(captain.settingHistory("retryLimit")).toHaveLength(before + 1);
  });

  it("raises no alert for a pending operation, and still answers clients from before", async () => {
    const { w } = await captainWorld();
    const captain = w.host.product.captain;
    // A row an older host wrote: the table and its migration stay.
    w.host.db
      .query(
        `INSERT INTO captain_notification (id, kind, body, data, read_at, created_at)
         VALUES ('old', 'operation_pending', 'waiting', '{}', NULL, 1)`,
      )
      .run();
    const operation = captain.createOperation({
      kind: "set_setting",
      requiresApproval: true,
      payload: { key: "retryLimit", value: 3 },
    });
    w.host.product.captainSupervisor.tick();
    expect(notificationCount(w)).toBe(1);

    // Older pages read this section and counted its unread rows: they get none.
    w.client.subscribe("captain");
    await until(
      () =>
        w.client.section<{ id: string; status: string }[]>(
          "captain",
          "operations",
        )?.[0]?.id === operation.id,
    );
    expect(w.client.section("captain", "notifications")).toEqual([]);
    // And a "Mark read" one of them still holds does not fail.
    await expect(
      w.client.call("captain", "markNotificationRead", {
        notificationId: "old",
      }),
    ).resolves.toEqual({ notificationId: "old" });
    expect(
      w.host.db
        .query<{ read_at: number | null }, []>(
          "SELECT read_at FROM captain_notification WHERE id = 'old'",
        )
        .get()!.read_at,
    ).not.toBeNull();

    await captain.decideOperation(operation.id, "approve");
    expect(notificationCount(w)).toBe(1);
  });

  it("redacts credentials from text and structured tool results", async () => {
    const { redactJson, redactToolResult } = await import(
      "../src/captain/redact"
    );
    expect(
      redactJson({ authorization: "Bearer sk-123456789012345" }),
    ).toContain("[REDACTED:secret]");
    const result = redactToolResult({
      content: [{ type: "text", text: "token sk-123456789012345" }],
      details: { password: "secret", nested: "Bearer abcdefghijklmnop" },
    }) as { content: { text: string }[]; details: Record<string, string> };
    expect(result.content[0]!.text).not.toContain("sk-123456789012345");
    expect(result.details.password).toBe("[REDACTED:secret]");
    expect(result.details.nested).toContain("[REDACTED:secret]");
  });

  it("continues a task through the group instead of taking it over", async () => {
    const { models } = scriptedModels(() => say("I will continue."));
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "continued");
    await w.watch(group.id);
    const task = w.host.product.board.create(
      {
        title: "Needs another round",
        conversationId: group.id,
        workspace: "local",
        status: "in_review",
      },
      { kind: "agent", agentId: ada.id },
    );
    await w.host.product.captain.taskControl({
      taskId: task.id,
      action: "continue",
      text: "Please continue #1 and report back.",
    });
    await until(() =>
      w
        .rows(group.id)
        .some(
          (row) =>
            row.author === "captain" && row.text.includes("Please continue #1"),
        ),
    );
    expect(
      w.host.db
        .query<
          { created_by_agent: string; assignee_agent: string | null },
          [string]
        >("SELECT created_by_agent, assignee_agent FROM task WHERE id = ?")
        .get(task.id),
    ).toEqual({ created_by_agent: ada.id, assignee_agent: null });
  });

  it("stops automatic retries after five consecutive failures", async () => {
    const { w } = await captainWorld();
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "retry");
    const task = w.host.product.board.create(
      {
        title: "Retry me",
        conversationId: group.id,
        workspace: "local",
        status: "todo",
      },
      { kind: "agent", agentId: ada.id },
    );
    const primary = w.host.db
      .query<{ id: string }, []>(
        "SELECT id FROM machine WHERE kind = 'primary'",
      )
      .get()!;
    const runs = w.host.product.captain.store;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      // A failed run is what the supervisor sees; the run store is reached through the product's
      // board while this test is deliberately kept about the policy boundary.
      w.host.db
        .query(
          `INSERT INTO task_run (id, task_id, machine_id, status, error, created_at)
           VALUES (?, ?, ?, 'failed', 'test failure', ?)`,
        )
        .run(crypto.randomUUID(), task.id, primary.id, Date.now() + attempt);
      w.host.product.captainSupervisor.tick();
      expect(runs.retryState(task.id).attempts).toBe(attempt);
      const failures = w.host.product.captain.store
        .reviews()
        .filter((review) => review.kind === "task_failure");
      expect(failures).toHaveLength(attempt < 5 ? 0 : 1);
    }
    expect(runs.retryState(task.id).stoppedAt).not.toBeNull();
    // The stop is on the task and in Captain's review; it is not written again as an alert.
    expect(notificationCount(w)).toBe(0);
  });

  it("asks Captain immediately for a non-retryable task failure", async () => {
    const { w } = await captainWorld();
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "credentials");
    const task = w.host.product.board.create(
      {
        title: "Needs a key",
        conversationId: group.id,
        workspace: "local",
        status: "todo",
      },
      { kind: "agent", agentId: ada.id },
    );
    const primary = w.host.db
      .query<{ id: string }, []>(
        "SELECT id FROM machine WHERE kind = 'primary'",
      )
      .get()!;
    w.host.db
      .query(
        `INSERT INTO task_run
           (id, task_id, machine_id, status, error, error_code, retryable,
            created_at, started_at, finished_at, last_event_at)
         VALUES (?, ?, ?, 'failed', ?, 'auth', 0, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        task.id,
        primary.id,
        "OpenAI API error (401): api_key_revoked",
        Date.now(),
        Date.now(),
        Date.now(),
        Date.now(),
      );

    w.host.product.captainSupervisor.tick();
    const review = w.host.product.captain.store
      .reviews()
      .find((item) => item.taskId === task.id)!;
    expect(review).toMatchObject({
      kind: "task_failure_non_retryable",
      status: expect.stringMatching(/pending|running|completed/),
    });
    expect(
      w.host.product.captain.store.retryState(task.id).stoppedAt,
    ).not.toBeNull();
    expect(w.host.product.captain.store.retryState(task.id).attempts).toBe(1);
  });

  it("classifies a missing configuration from the error code, not its text", async () => {
    const { failureFromThrown } = await import("../src/tasks/runner");
    expect(
      failureFromThrown(
        Object.assign(new Error("ENOENT backend/config/stitching.local.json"), {
          code: "ENOENT",
        }),
      ),
    ).toMatchObject({
      code: "configuration_missing",
      retryable: false,
    });
    expect(
      failureFromThrown(new Error("test_permission_denied failed")),
    ).toBeUndefined();
  });

  it("marks an inactive task stuck and reserves proactive wake events", async () => {
    const { w } = await captainWorld();
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "stuck");
    const task = w.host.product.board.create(
      {
        title: "Quiet task",
        conversationId: group.id,
        workspace: "local",
        status: "todo",
      },
      { kind: "agent", agentId: ada.id },
    );
    w.host.db
      .query("UPDATE task SET updated_at = ? WHERE id = ?")
      .run(Date.now() - 31 * 60_000, task.id);
    w.host.product.captainSupervisor.tick();
    expect(
      w.host.product.captain.store
        .reviews()
        .some(
          (review) =>
            review.kind === "task_stalled" && review.taskId === task.id,
        ),
    ).toBe(true);

    const events: string[] = [];
    const off = w.host.product.captainSupervisor.onEvent((event) =>
      events.push(event.kind),
    );
    w.host.product.captainSupervisor.wake({ kind: "reserved" });
    off();
    w.host.product.captainSupervisor.wake({ kind: "ignored" });
    expect(events).toEqual(["reserved"]);
  });

  it("distinguishes a stopped task from a run with no progress", async () => {
    const { w } = await captainWorld();
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "stuck-run");
    const task = w.host.product.board.create(
      {
        title: "Hung run",
        conversationId: group.id,
        workspace: "local",
        status: "in_progress",
      },
      { kind: "agent", agentId: ada.id },
    );
    const primary = w.host.db
      .query<{ id: string }, []>(
        "SELECT id FROM machine WHERE kind = 'primary'",
      )
      .get()!;
    const started = Date.now() - 31 * 60_000;
    w.host.db
      .query(
        `INSERT INTO task_run
           (id, task_id, machine_id, status, created_at, started_at)
         VALUES (?, ?, ?, 'running', ?, ?)`,
      )
      .run(crypto.randomUUID(), task.id, primary.id, started, started);
    w.host.db
      .query("UPDATE task SET updated_at = ? WHERE id = ?")
      .run(started, task.id);

    w.host.product.captainSupervisor.tick();
    expect(
      w.host.product.captain.store
        .reviews()
        .some(
          (review) =>
            review.kind === "task_run_stuck" && review.taskId === task.id,
        ),
    ).toBe(true);
  });

  it("does not call a long run stuck while its journal is still moving", async () => {
    const { w } = await captainWorld();
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "long-build");
    const task = w.host.product.board.create(
      {
        title: "Long but alive",
        conversationId: group.id,
        workspace: "local",
        status: "in_progress",
      },
      { kind: "agent", agentId: ada.id },
    );
    const primary = w.host.db
      .query<{ id: string }, []>(
        "SELECT id FROM machine WHERE kind = 'primary'",
      )
      .get()!;
    const started = Date.now() - 2 * 60 * 60_000;
    const runId = crypto.randomUUID();
    w.host.db
      .query(
        `INSERT INTO task_run
           (id, task_id, machine_id, status, created_at, started_at, last_event_at)
         VALUES (?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(runId, task.id, primary.id, started, started, Date.now() - 60_000);
    w.host.db
      .query("UPDATE task SET updated_at = ? WHERE id = ?")
      .run(started, task.id);

    w.host.product.captainSupervisor.tick();
    expect(
      w.host.product.captain.store
        .reviews()
        .some(
          (review) =>
            review.kind === "task_run_stuck" && review.taskId === task.id,
        ),
    ).toBe(false);

    w.host.db
      .query("UPDATE task_run SET last_event_at = ? WHERE id = ?")
      .run(Date.now() - 31 * 60_000, runId);
    w.host.product.captainSupervisor.tick();
    expect(
      w.host.product.captain.store
        .reviews()
        .some(
          (review) =>
            review.kind === "task_run_stuck" && review.taskId === task.id,
        ),
    ).toBe(true);
  });

  it("diagnoses offline machines before calling their runs stuck", async () => {
    const { w } = await captainWorld();
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "offline-runs");
    const offlineId = crypto.randomUUID();
    const lastSeenAt = Date.now() - 60_000;
    w.host.db
      .query(
        `INSERT INTO machine
           (id, kind, name, status, created_at, last_seen_at, max_active_runs)
         VALUES (?, 'daemon', ?, 'offline', ?, ?, 2)`,
      )
      .run(offlineId, "Offline box", Date.now() - 120_000, lastSeenAt);
    const makeTask = (title: string) =>
      w.host.product.board.create(
        {
          title,
          conversationId: group.id,
          workspace: "local",
          status: "in_progress",
        },
        { kind: "agent", agentId: ada.id },
      );
    const running = makeTask("Running on an offline machine");
    const queued = makeTask("Queued for an offline machine");
    const old = Date.now() - 31 * 60_000;
    w.host.db
      .query(
        `INSERT INTO task_run
           (id, task_id, machine_id, status, created_at, started_at, last_event_at)
         VALUES (?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), running.id, offlineId, old, old, old);
    w.host.db
      .query(
        `INSERT INTO task_run
           (id, task_id, machine_id, status, queue_reason, created_at, last_event_at)
         VALUES (?, ?, ?, 'queued', 'machine_offline', ?, ?)`,
      )
      .run(crypto.randomUUID(), queued.id, offlineId, old, old);

    w.host.product.captainSupervisor.tick();
    const reviews = w.host.product.captain.store.reviews();
    const offline = reviews.filter(
      (review) => review.kind === "task_run_offline",
    );
    expect(offline).toHaveLength(2);
    expect(
      reviews.some(
        (review) =>
          review.kind === "task_run_stuck" &&
          (review.taskId === running.id || review.taskId === queued.id),
      ),
    ).toBe(false);
    expect(offline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: running.id,
          data: expect.objectContaining({
            queueReason: null,
            runs: [
              expect.objectContaining({
                machineId: offlineId,
                machineStatus: "offline",
                lastSeenAt,
                queueReason: null,
                status: "running",
              }),
            ],
          }),
        }),
        expect.objectContaining({
          taskId: queued.id,
          data: expect.objectContaining({
            queueReason: "machine_offline",
            runs: [
              expect.objectContaining({
                machineId: offlineId,
                machineStatus: "offline",
                queueReason: "machine_offline",
                status: "queued",
              }),
            ],
          }),
        }),
      ]),
    );
  });

  it("wakes Captain once when an assignment settles without a task", async () => {
    const { models } = scriptedModels(() => say("Verified."));
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "settled");
    await w.watch(group.id);
    const assigned = await w.host.product.captain.assign({
      conversationId: group.id,
      text: "Ada, inspect it and report.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, assigned.replyIds[0]!);
    const direct = await w.host.product.captain.direct();
    await w.watch(direct.conversationId);

    w.host.product.captainSupervisor.tick();
    await until(() =>
      w
        .rows(direct.conversationId)
        .some(
          (row) =>
            row.author === "system" && row.text.includes("<captain-review>"),
        ),
    );
    w.host.product.captainSupervisor.tick();
    const reviews = w.host.product.captain.store
      .reviews()
      .filter(
        (review) =>
          review.kind === "assignment_settled" &&
          Array.isArray(review.data.assignmentIds) &&
          review.data.assignmentIds.includes(assigned.assignment.id),
      );
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      kind: "assignment_settled",
      data: {
        assignmentIds: [assigned.assignment.id],
        lastAuthor: "agent",
        lastTextHead: "Verified.",
      },
    });
    // The second tick woke nobody again.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      w
        .rows(direct.conversationId)
        .filter(
          (row) =>
            row.author === "system" && row.text.includes("<captain-review>"),
        ),
    ).toHaveLength(1);
  });

  it("groups assignments in one conversation into one review", async () => {
    const { models } = scriptedModels(() => say("Done."));
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "grouped");
    await w.watch(group.id);
    const store = w.host.product.captain.store;
    store.setSetting("supervisorEnabled", false, null);
    const first = await w.host.product.captain.assign({
      conversationId: group.id,
      text: "Ada, first pass.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, first.replyIds[0]!);
    const second = await w.host.product.captain.assign({
      conversationId: group.id,
      text: "Ada, second pass.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, second.replyIds[0]!);

    store.setSetting("supervisorEnabled", true, null);
    w.host.product.captainSupervisor.tick();
    const reviews = store
      .reviews()
      .filter(
        (review) =>
          review.kind === "assignment_settled" &&
          review.conversationId === group.id,
      );
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.data.assignmentIds).toEqual(
      expect.arrayContaining([first.assignment.id, second.assignment.id]),
    );
  });

  it("reports only assignment IDs added since the last review", async () => {
    const { models } = scriptedModels(() => say("Done."));
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "assignment-window");
    await w.watch(group.id);
    const store = w.host.product.captain.store;
    store.setSetting("supervisorEnabled", false, null);
    const first = await w.host.product.captain.assign({
      conversationId: group.id,
      text: "Ada, first review window.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, first.replyIds[0]!);
    const firstSeq = w.host.db
      .query<{ last_seq: number }, [string]>(
        "SELECT last_seq FROM conversation WHERE id = ?",
      )
      .get(group.id)!.last_seq;
    const prior = store.createReview({
      kind: "assignment_settled",
      dedupeKey: `conversation:${group.id}:assignment_settled:${firstSeq}`,
      conversationId: group.id,
      checkpointSeq: firstSeq,
      body: "Previously reviewed.",
    });
    store.finishReview(prior.id, "completed");

    const second = await w.host.product.captain.assign({
      conversationId: group.id,
      text: "Ada, second review window.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, second.replyIds[0]!);
    const secondSeq = w.host.db
      .query<{ last_seq: number }, [string]>(
        "SELECT last_seq FROM conversation WHERE id = ?",
      )
      .get(group.id)!.last_seq;
    store.setSetting("supervisorEnabled", true, null);
    w.host.product.captainSupervisor.tick();

    const review = store
      .reviews()
      .find(
        (item) =>
          item.kind === "assignment_settled" &&
          item.conversationId === group.id &&
          item.checkpointSeq === secondSeq,
      )!;
    expect(review.data).toMatchObject({
      assignmentIds: [second.assignment.id],
      assignmentCount: 2,
      newAssignmentCount: 1,
      fromSeq: firstSeq,
      throughSeq: secondSeq,
    });
    expect(review.data.assignmentIds).not.toContain(first.assignment.id);
  });

  it("relays an assigned agent's Inbox question through the user", async () => {
    const { models } = scriptedModels((request) => {
      if (request.agent === "Captain") {
        const interactionId = (key: string) =>
          new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(
            request.transcript.join("\n"),
          )?.[1];
        if (request.lastRole === "toolResult") {
          if (request.last.includes("Use relay_inbox_to_user"))
            return interactionId("interactionId") === undefined
              ? say("No Inbox question.")
              : call("relay_inbox_to_user", {
                  interactionId: interactionId("interactionId"),
                });
          return say("Relayed.");
        }
        if (request.last.includes("[inbox_decision]"))
          return call("answer_inbox", {
            interactionId: interactionId("sourceInteractionId"),
            selections: ["safe"],
          });
        if (request.last.includes("[task_stalled]"))
          return say("Other review handled.");
        return interactionId("interactionId") === undefined
          ? say("No Inbox question.")
          : call("answer_inbox", {
              interactionId: interactionId("interactionId"),
              text: "guess",
            });
      }
      if (request.agent === "Ada")
        return request.lastRole === "toolResult"
          ? say(`Ada received: ${request.last}`)
          : call(
              "ask_user",
              {
                question: "Which route should the task take?",
                options: [{ title: "fast" }, { title: "safe" }],
              },
              "ada-question",
            );
      return say("ok");
    });
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "relay-inbox");
    await w.watch(group.id);
    w.client.subscribe("inbox");
    const captain = await w.host.product.captain.direct();
    await w.watch(captain.conversationId);

    const assigned = await w.host.product.captain.assign({
      conversationId: group.id,
      text: "Ada, choose the route.",
      agentIds: [ada.id],
    });
    const inbox = (): InteractionView[] =>
      w.client.section<InteractionView[]>("inbox", "list") ?? [];
    const sourceRow = () =>
      w.host.db
        .query<
          {
            id: string;
            prompt: string;
            options: string;
            status: string;
            answer: string | null;
          },
          [string, string]
        >(
          `SELECT id, prompt, options, status, answer FROM interaction
            WHERE agent_id = ? AND conversation_id = ?
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(ada.id, group.id);
    await until(() => sourceRow()?.status === "pending");
    const source = sourceRow()!;

    await until(() =>
      inbox().some(
        (item) =>
          item.status === "pending" &&
          item.agentId === captain.agentId &&
          item.conversationId === captain.conversationId,
      ),
    );
    const relay = inbox().find(
      (item) =>
        item.status === "pending" &&
        item.agentId === captain.agentId &&
        item.conversationId === captain.conversationId,
    )!;
    expect(relay.prompt).toBe(source.prompt);
    expect(relay.options).toEqual(JSON.parse(source.options) as string[]);
    expect(inbox().some((item) => item.id === source.id)).toBe(false);
    await until(() =>
      w.host.product.captain.store
        .reviews()
        .some(
          (review) =>
            review.kind === "assignment_inbox" &&
            review.data.interactionId === source.id &&
            review.status === "completed",
        ),
    );

    const store = w.host.product.captain.store;
    const other = store.createReview({
      kind: "task_stalled",
      dedupeKey: "test:while-user-decides",
      body: "This review must not wait for the user's answer.",
    });
    await w.host.product.captain.observeReviews();
    await until(() => store.review(other.id)?.status === "completed");
    expect(
      w.host.product.captain.store
        .reviews()
        .some(
          (review) =>
            review.kind === "assignment_blocked" &&
            review.conversationId === group.id,
        ),
    ).toBe(false);

    const response: InboxResponse = {
      kind: "selection",
      selections: ["safe"],
    };
    await w.client.call("inbox", "answer", {
      id: relay.id,
      response,
    });
    await w.settled(group.id, assigned.replyIds[0]!);
    await until(() =>
      store
        .reviews()
        .some(
          (review) =>
            review.kind === "inbox_decision" &&
            review.data.sourceInteractionId === source.id &&
            review.status === "completed",
        ),
    );

    const settledSource = sourceRow()!;
    expect(settledSource.status).toBe("answered");
    expect(JSON.parse(settledSource.answer!)).toEqual(response);
    expect(notificationCount(w)).toBe(0);
  });

  it("lets Captain re-ask after the user cancels a relayed question", async () => {
    const { models } = scriptedModels((request) => {
      if (request.agent === "Captain") {
        const field = (key: string) =>
          new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(
            request.transcript.join("\n"),
          )?.[1];
        if (request.lastRole === "toolResult") return say("Captain continued.");
        if (request.last.includes("[inbox_decision]")) {
          const sourceInteractionId = field("sourceInteractionId");
          if (request.last.includes('"kind": "none"'))
            return call("relay_inbox_to_user", {
              interactionId: sourceInteractionId,
            });
          return call("answer_inbox", {
            interactionId: sourceInteractionId,
            selections: ["safe"],
          });
        }
        return call("relay_inbox_to_user", {
          interactionId: field("interactionId"),
        });
      }
      if (request.agent === "Ada")
        return request.lastRole === "toolResult"
          ? say(`Ada received: ${request.last}`)
          : call(
              "ask_user",
              {
                question: "Which route should the task take?",
                options: [{ title: "fast" }, { title: "safe" }],
              },
              "ada-cancel-question",
            );
      return say("ok");
    });
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "relay-cancel");
    await w.watch(group.id);
    w.client.subscribe("inbox");
    const captain = await w.host.product.captain.direct();
    await w.watch(captain.conversationId);
    const assigned = await w.host.product.captain.assign({
      conversationId: group.id,
      text: "Ada, choose the route.",
      agentIds: [ada.id],
    });
    const inbox = (): InteractionView[] =>
      w.client.section<InteractionView[]>("inbox", "list") ?? [];
    const pendingCaptain = () =>
      inbox().filter(
        (item) =>
          item.status === "pending" &&
          item.agentId === captain.agentId &&
          item.conversationId === captain.conversationId,
      );
    const sourceRow = () =>
      w.host.db
        .query<
          { id: string; status: string; answer: string | null },
          [string, string]
        >(
          `SELECT id, status, answer FROM interaction
            WHERE agent_id = ? AND conversation_id = ?
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(ada.id, group.id);

    await until(() => pendingCaptain().length === 1);
    const first = pendingCaptain()[0]!;
    await w.client.call("inbox", "answer", {
      id: first.id,
      response: { kind: "none" },
    });
    await until(() => pendingCaptain().some((item) => item.id !== first.id));
    const second = pendingCaptain().find((item) => item.id !== first.id)!;
    expect(second.prompt).toBe(first.prompt);
    expect(second.questionId).not.toBe(first.questionId);
    await until(() =>
      w.host.product.captain.store
        .reviews()
        .some(
          (review) =>
            review.kind === "inbox_decision" &&
            review.data.relayInteractionId === first.id &&
            review.data.userDecision !== null &&
            (review.data.userDecision as { kind?: string }).kind === "none" &&
            review.status === "completed",
        ),
    );

    await w.client.call("inbox", "answer", {
      id: second.id,
      response: { kind: "selection", selections: ["safe"] },
    });
    await w.settled(group.id, assigned.replyIds[0]!);
    await until(() => sourceRow()?.status === "answered");
    expect(JSON.parse(sourceRow()!.answer!)).toEqual({
      kind: "selection",
      selections: ["safe"],
    });
  });

  it("reviews an assignment with no new messages after it has been silent", async () => {
    const { models } = scriptedModels(() => say("Still here."));
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "silent");
    await w.watch(group.id);
    const assigned = await w.host.product.captain.assign({
      conversationId: group.id,
      text: "Ada, work quietly.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, assigned.replyIds[0]!);
    const baseline = w.host.product.captain.store.assignment(
      assigned.assignment.id,
    )!.messageId;
    const baselineSeq = w.host.db
      .query<{ seq: number }, [string]>("SELECT seq FROM message WHERE id = ?")
      .get(baseline)!.seq;
    w.host.db
      .query("UPDATE conversation SET last_seq = ? WHERE id = ?")
      .run(baselineSeq, group.id);
    w.host.db
      .query("UPDATE captain_assignment SET created_at = ? WHERE id = ?")
      .run(Date.now() - 31 * 60_000, assigned.assignment.id);

    w.host.product.captainSupervisor.tick();
    expect(
      w.host.product.captain.store
        .reviews()
        .some(
          (review) =>
            review.kind === "assignment_stalled" &&
            Array.isArray(review.data.assignmentIds) &&
            review.data.assignmentIds.includes(assigned.assignment.id),
        ),
    ).toBe(false);

    const latestMessage = w.host.db
      .query<{ id: string }, [string]>(
        `SELECT id FROM message WHERE conversation_id = ?
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(group.id)!.id;
    w.host.db
      .query("UPDATE message SET updated_at = ? WHERE id = ?")
      .run(Date.now() - 31 * 60_000, latestMessage);
    w.host.product.captainSupervisor.tick();
    expect(
      w.host.product.captain.store
        .reviews()
        .some(
          (review) =>
            review.kind === "assignment_stalled" &&
            Array.isArray(review.data.assignmentIds) &&
            review.data.assignmentIds.includes(assigned.assignment.id),
        ),
    ).toBe(true);
  });

  it("does not raise a stalled alarm after that assignment sequence was reviewed", async () => {
    const { models } = scriptedModels(() => say("Reviewed."));
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "reviewed");
    await w.watch(group.id);
    const assigned = await w.host.product.captain.assign({
      conversationId: group.id,
      text: "Ada, inspect it.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, assigned.replyIds[0]!);
    const throughSeq = w.host.db
      .query<{ last_seq: number }, [string]>(
        "SELECT last_seq FROM conversation WHERE id = ?",
      )
      .get(group.id)!.last_seq;
    const review = w.host.product.captain.store.createReview({
      kind: "assignment_settled",
      dedupeKey: `conversation:${group.id}:assignment_settled:${throughSeq}`,
      assignmentId: assigned.assignment.id,
      conversationId: group.id,
      checkpointSeq: throughSeq,
      body: "Already reviewed.",
    });
    w.host.product.captain.store.finishReview(review.id, "completed");
    const latest = w.host.db
      .query<{ id: string }, [string]>(
        `SELECT id FROM message WHERE conversation_id = ?
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(group.id)!.id;
    w.host.db
      .query("UPDATE message SET updated_at = ? WHERE id = ?")
      .run(Date.now() - 31 * 60_000, latest);

    w.host.product.captainSupervisor.tick();
    expect(
      w.host.product.captain.store
        .reviews()
        .some(
          (item) =>
            item.kind === "assignment_stalled" &&
            Array.isArray(item.data.assignmentIds) &&
            item.data.assignmentIds.includes(assigned.assignment.id),
        ),
    ).toBe(false);
  });

  it("does not let a blocked review suppress a later stall at the same sequence", async () => {
    const { models } = scriptedModels(() => say("Blocked."));
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "blocked-then-stalled");
    await w.watch(group.id);
    const assigned = await w.host.product.captain.assign({
      conversationId: group.id,
      text: "Ada, inspect it.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, assigned.replyIds[0]!);
    const throughSeq = w.host.db
      .query<{ last_seq: number }, [string]>(
        "SELECT last_seq FROM conversation WHERE id = ?",
      )
      .get(group.id)!.last_seq;
    const blocked = w.host.product.captain.store.createReview({
      kind: "assignment_blocked",
      dedupeKey: `conversation:${group.id}:assignment_blocked:${throughSeq}`,
      assignmentId: assigned.assignment.id,
      conversationId: group.id,
      checkpointSeq: throughSeq,
      body: "Blocked.",
    });
    w.host.product.captain.store.finishReview(blocked.id, "completed");
    const latest = w.host.db
      .query<{ id: string }, [string]>(
        `SELECT id FROM message WHERE conversation_id = ?
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(group.id)!.id;
    w.host.db
      .query("UPDATE message SET updated_at = ? WHERE id = ?")
      .run(Date.now() - 31 * 60_000, latest);

    w.host.product.captainSupervisor.tick();
    expect(
      w.host.product.captain.store
        .reviews()
        .some(
          (review) =>
            review.kind === "assignment_stalled" &&
            review.conversationId === group.id,
        ),
    ).toBe(true);
  });

  it("does not advance a conversation checkpoint when its review failed", async () => {
    const { w } = await captainWorld();
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "review-retry");
    const assigned = await w.host.product.captain.assign({
      conversationId: group.id,
      text: "Ada, wait.",
      agentIds: [ada.id],
    });
    const review = w.host.product.captain.store.createReview({
      kind: "assignment_settled",
      dedupeKey: "test:failed-checkpoint",
      assignmentId: assigned.assignment.id,
      conversationId: group.id,
      checkpointSeq: 42,
      body: "Needs another attempt.",
    });
    w.host.product.captain.store.finishReview(
      review.id,
      "failed",
      "model unavailable",
    );
    expect(w.host.product.captain.store.conversationCheckpoint(group.id)).toBe(
      0,
    );
    w.host.db
      .query("UPDATE captain_review SET next_attempt_at = 0 WHERE id = ?")
      .run(review.id);
    expect(
      w.host.product.captain.store
        .pendingReviews()
        .some((item) => item.id === review.id),
    ).toBe(true);
  });

  it("stops retrying after six failed attempts to start Captain", async () => {
    const warnings: string[] = [];
    const { models } = scriptedModels(() => say("Captain ready."));
    const w = await world({
      ...options,
      models,
      warn: (message) => warnings.push(message),
    });
    const direct = await w.host.product.captain.direct();
    await w.watch(direct.conversationId);
    const store = w.host.product.captain.store;
    const review = store.createReview({
      kind: "task_stalled",
      dedupeKey: "test:delivery-failure",
      body: "Captain cannot start for this review.",
    });
    const send = vi
      .spyOn(w.host.product.engine, "send")
      .mockRejectedValue(new Error("send unavailable"));

    try {
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        await w.host.product.captain.observeReviews();
        expect(store.review(review.id)?.attempts).toBe(attempt);
        if (attempt < 6)
          w.host.db
            .query("UPDATE captain_review SET next_attempt_at = 0 WHERE id = ?")
            .run(review.id);
      }
    } finally {
      send.mockRestore();
    }

    expect(store.review(review.id)).toMatchObject({
      status: "failed",
      attempts: 6,
      error: "send unavailable",
    });
    // Nothing retries it now, so the host's log says so once; it is not an alert to mark read.
    expect(
      warnings.filter((message) => message.includes("after 6 attempts")),
    ).toHaveLength(1);
    expect(notificationCount(w)).toBe(0);

    await w.host.product.captain.observeReviews();
    expect(store.review(review.id)?.attempts).toBe(6);
  });

  it("recovers a review stranded at the attempt ceiling", async () => {
    const { w } = await captainWorld();
    const store = w.host.product.captain.store;
    const review = store.createReview({
      kind: "task_stalled",
      dedupeKey: "test:interrupted-delivery",
      body: "The process stopped while this review was being sent.",
    });
    for (let attempt = 0; attempt < 6; attempt += 1)
      store.beginReviews([review.id]);

    expect(store.review(review.id)?.attempts).toBe(6);
    expect(store.pendingReviews().some((item) => item.id === review.id)).toBe(
      false,
    );

    w.host.product.captain.recoverExhaustedReviews();
    expect(store.review(review.id)).toMatchObject({
      status: "failed",
      attempts: 6,
    });
    expect(notificationCount(w)).toBe(0);
  });

  it("waits while Captain is busy and then delivers a batched review", async () => {
    const { models } = scriptedModels((request) =>
      request.index === 0 ? HANG : say("Reviewed."),
    );
    const w = await world({ ...options, models });
    const direct = await w.host.product.captain.direct();
    await w.watch(direct.conversationId);
    const sent = await w.send(direct.conversationId, "stay busy");
    await until(
      () =>
        w.row(direct.conversationId, sent.replies[0]!.id)?.status === "working",
    );

    const store = w.host.product.captain.store;
    const first = store.createReview({
      kind: "task_stalled",
      dedupeKey: "test:batch:1",
      body: "First review.",
    });
    const second = store.createReview({
      kind: "task_run_stuck",
      dedupeKey: "test:batch:2",
      body: "Second review.",
    });
    await w.host.product.captain.observeReviews();
    expect(
      w.rows(direct.conversationId).some((row) => row.author === "system"),
    ).toBe(false);

    w.host.product.engine.stopAgent(direct.agentId);
    await w.settled(direct.conversationId, sent.replies[0]!.id);
    await until(() =>
      w
        .rows(direct.conversationId)
        .some(
          (row) =>
            row.author === "system" && row.text.includes("<captain-review>"),
        ),
    );
    const reviews = store.reviews();
    const batch = reviews.filter(
      (review) => review.id === first.id || review.id === second.id,
    );
    expect(batch).toHaveLength(2);
    expect(new Set(batch.map((review) => review.messageId)).size).toBe(1);
    expect(batch[0]!.messageId).not.toBeNull();
    // Marked for renderers, which draw it as a review rather than as Captain's prompt.
    const prompt = w
      .rows(direct.conversationId)
      .find((row) => row.id === batch[0]!.messageId)!;
    expect(
      (prompt.data.captainReview as { reviewIds: string[] }).reviewIds
        .slice()
        .sort(),
    ).toEqual([first.id, second.id].sort());
  });

  it("caps a review batch by count and prompt characters", async () => {
    const { w } = await captainWorld();
    const direct = await w.host.product.captain.direct();
    await w.watch(direct.conversationId);
    for (let index = 0; index < 25; index += 1)
      w.host.product.captain.store.createReview({
        kind: "task_stalled",
        dedupeKey: `test:large-batch:${index}`,
        body: `Review ${index}`,
        data: Object.fromEntries(
          Array.from({ length: 20 }, (_, item) => [
            `detail-${item}`,
            "x".repeat(item % 2 === 0 ? 500 : 5_000),
          ]),
        ),
      });

    await w.host.product.captain.observeReviews();
    await until(() =>
      w.rows(direct.conversationId).some((row) => row.author === "system"),
    );
    const prompt = w
      .rows(direct.conversationId)
      .find((row) => row.author === "system")!;
    expect(prompt.text.length).toBeLessThanOrEqual(13_000);
    const dataLines = prompt.text
      .split("\n")
      .filter((line) => line.startsWith('{"truncated":true'));
    expect(dataLines.length).toBeGreaterThan(0);
    for (const line of dataLines)
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    expect(
      w.host.product.captain.store
        .reviews()
        .filter((review) => review.messageId !== null).length,
    ).toBeLessThan(25);
  });

  it("marks a Captain review failed when its run cannot complete", async () => {
    const { models } = scriptedModels(() => HANG);
    const w = await world({ ...options, models });
    const direct = await w.host.product.captain.direct();
    await w.watch(direct.conversationId);
    const review = w.host.product.captain.store.createReview({
      kind: "task_stalled",
      dedupeKey: "test:review-failure",
      body: "Review that will fail.",
    });

    await w.host.product.captain.observeReviews();
    await until(
      () =>
        w.host.product.captain.store
          .reviews()
          .find((item) => item.id === review.id)?.status === "running",
    );
    w.host.product.engine.stopAgent(direct.agentId);
    await until(
      () => w.host.product.captain.store.review(review.id)?.status === "failed",
    );
    expect(notificationCount(w)).toBe(0);
  });
});
