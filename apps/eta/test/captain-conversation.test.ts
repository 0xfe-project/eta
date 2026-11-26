/**
 * Captain's conversation belongs to the captain module (`captain/policy.ts`): made by the host and
 * by `captain.direct`, talked in like any conversation, but nobody joins or leaves it, it is not
 * edited, and it is not a row of `conversations.list`.
 */
import type {
  CaptainIdentitySection,
  ConversationSummary,
  MemberView,
} from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

type World = Awaited<ReturnType<typeof world>>;

const published = (w: World, conversationId: string): boolean =>
  w.host.server.wire
    .targets()
    .some((target) => target.name === `conversations.${conversationId}`);

async function captainWorld() {
  const w = await world({ captain: true, tasks: { runs: false } });
  const { conversationId } = (await w.client.call("captain", "direct", {})) as {
    conversationId: string;
  };
  return { w, conversationId, captain: w.host.product.captain.identity()! };
}

describe("captain's conversation", () => {
  it("takes a message that names nobody to Captain", async () => {
    const { w, conversationId, captain } = await captainWorld();
    await w.watch(conversationId);
    const sent = await w.send(conversationId, "What is going on?");
    expect(sent.nobody).toBe(false);
    expect(sent.replies.map((reply) => reply.agentId)).toEqual([
      captain.agentId,
    ]);
    const done = await w.settled(conversationId, sent.replies[0]!.id);
    expect(done.status).toBe("done");
  });

  it("takes nobody in and lets nobody go, and is not edited", async () => {
    const { w, conversationId, captain } = await captainWorld();
    const ada = await w.agent("Ada");
    await expect(
      w.client.call("conversations", "invite", {
        conversationId,
        agentId: ada.id,
      }),
    ).rejects.toThrow(/Captain's conversation/);
    await expect(
      w.client.call("conversations", "remove", {
        conversationId,
        agentId: captain.agentId,
      }),
    ).rejects.toThrow(/Captain's conversation/);
    for (const patch of [{ archived: true }, { name: "Mine" }])
      await expect(
        w.client.call("conversations", "update", { conversationId, ...patch }),
      ).rejects.toThrow(/Captain's conversation cannot be changed/);
    await w.watch(conversationId);
    expect(
      w.client
        .section<MemberView[]>(`conversations.${conversationId}`, "members")!
        .map((member) => member.agentId),
    ).toEqual([captain.agentId]);
  });

  it("is not a row of the conversation list, and is still its own target", async () => {
    const { w, conversationId } = await captainWorld();
    const ada = await w.agent("Ada");
    const group = await w.group(ada.homeProjectId, [ada.id]);
    await until(() =>
      (
        w.client.section<ConversationSummary[]>("conversations", "list") ?? []
      ).some((entry) => entry.id === group.id),
    );
    expect(
      w.client
        .section<ConversationSummary[]>("conversations", "list")!
        .some((entry) => entry.id === conversationId),
    ).toBe(false);
    await w.watch(conversationId);
    expect(
      w.client.section(`conversations.${conversationId}`, "info"),
    ).toMatchObject({ id: conversationId, kind: "captain" });
  });

  it("is made again, and published, when it went missing (captain.direct)", async () => {
    const { w, conversationId, captain } = await captainWorld();
    w.host.db
      .query("DELETE FROM conversation WHERE id = ?")
      .run(conversationId);
    const again = (await w.client.call("captain", "direct", {})) as {
      conversationId: string;
    };
    expect(again.conversationId).not.toBe(conversationId);
    expect(
      w.host.db
        .query<{ id: string }, [string]>(
          `SELECT c.id FROM conversation c JOIN participant p ON p.conversation_id = c.id
            WHERE c.kind = 'captain' AND p.agent_id = ?`,
        )
        .all(captain.agentId)
        .map((row) => row.id),
    ).toEqual([again.conversationId]);
    expect(published(w, again.conversationId)).toBe(true);
  });

  it("comes with Captain's identity, with its last message and Captain's session", async () => {
    const { w, conversationId, captain } = await captainWorld();
    // Followed as a client follows it; an eager target otherwise comes with hello only.
    w.client.subscribe("captain");
    const identity = () =>
      w.client.section<CaptainIdentitySection>("captain", "identity");
    await until(() => identity()?.conversation?.id === conversationId);
    expect(identity()!.conversation).toMatchObject({
      kind: "captain",
      lastMessageAt: null,
    });
    await w.watch(conversationId);
    const sent = await w.send(conversationId, "What is going on?");
    await w.settled(conversationId, sent.replies[0]!.id);
    await until(
      () =>
        identity()!.conversation!.participants.find(
          (member) => member.agentId === captain.agentId,
        )?.sessionId != null,
    );
    const last = (await w.client.call("conversations", "history", {
      conversationId,
      limit: 1,
    })) as { messages: { createdAt: number }[] };
    expect(identity()!.conversation!.lastMessageAt).toBe(
      last.messages.at(-1)!.createdAt,
    );
  });
});

describe("tasks in captain's direct conversation", () => {
  it("allows tasks created in Captain's chat for ordinary agents (and subtasks), while refusing Captain as assignee and refusing dispatch_task into direct chat", async () => {
    const toolsSeen: string[][] = [];
    const { models } = scriptedModels((request) => {
      if (request.agent === "Captain") {
        toolsSeen.push(request.tools);
        if (request.lastRole === "toolResult") return say(request.last);
        if (request.last.includes("check subtask"))
          return call("captain_read_task", { taskId: "1" });
        if (request.last.includes("list board"))
          return call("captain_list_tasks", {});
        return say("Captain ready.");
      }
      if (request.system.includes("In this task you are Ada")) {
        if (request.lastRole === "toolResult") return say("Subtask split.");
        return call("create_subtask", {
          title: "Subtask for Bola",
          description: "Run as Bola",
          assignee: "Bola",
        });
      }
      if (request.system.includes("In this task you are Bola")) {
        if (request.lastRole === "toolResult") return say("Done.");
        return call("finish_task", { summary: "Bola completed subtask." });
      }
      return say("ok");
    });

    const w = await world({ captain: true, models });
    const ada = await w.agent("Ada");
    const bola = await w.agent("Bola");
    const captain = (await w.client.call("captain", "direct", {})) as {
      agentId: string;
      conversationId: string;
    };
    const directId = captain.conversationId;
    await w.watch(directId);

    // Confirm Captain's direct-chat toolset exposes dispatch_task and excludes draft_task/create_task.
    const hi = await w.send(directId, "hello");
    await w.settled(directId, hi.replies[0]!.id);
    expect(toolsSeen[0]).toContain("dispatch_task");
    expect(toolsSeen[0]).not.toContain("draft_task");
    expect(toolsSeen[0]).not.toContain("create_task");

    // Refuses assigning a task to Captain inside Captain's direct chat (by id or reserved name).
    for (const target of [captain.agentId, "Captain", "captain"])
      await expect(
        w.client.call("tasks", "create", {
          conversationId: directId,
          workspace: "local",
          tasks: [{ title: "For Captain", assignee: target }],
        }),
      ).rejects.toThrow(/Captain cannot be assigned/);

    // dispatch_task cannot target Captain's direct conversation.
    await expect(
      w.host.product.captain.dispatchTask({
        conversationId: directId,
        title: "Not a group",
        description: "Should fail",
        assignee: ada.id,
      }),
    ).rejects.toThrow(/group conversations/);

    // User creates a task from Captain's direct chat assigned to Ada (not a participant of directId).
    // Ada runs it and creates a subtask for Bola; Bola completes and posts back to directId.
    const { tasks } = (await w.client.call("tasks", "create", {
      conversationId: directId,
      workspace: "local",
      tasks: [{ title: "Direct-chat task", assignee: ada.id }],
    })) as { tasks: { id: string; number: number; conversationId: string }[] };
    expect(tasks[0]!.conversationId).toBe(directId);

    await until(() => w.host.product.board.find("2")?.status === "in_review");
    expect(
      w
        .rows(directId)
        .some(
          (row) =>
            row.author === "agent" &&
            row.agentId === bola.id &&
            row.text.includes("Bola completed subtask."),
        ),
    ).toBe(true);

    // Assigning a subtask to Captain is also refused even from a direct-chat task.
    expect(() =>
      w.host.product.board.create(
        {
          title: "Sub for Captain",
          description: "Refused",
          conversationId: directId,
          workspace: "local",
          assignee: captain.agentId,
        },
        { kind: "agent", agentId: ada.id },
      ),
    ).toThrow(/Captain cannot be assigned/);

    // Captain can inspect and update/control tasks originating from its direct conversation.
    const listed = await w.send(directId, "list board");
    const listReply = await w.settled(directId, listed.replies[0]!.id);
    expect(listReply.text).toContain("Direct-chat task");
    expect(listReply.text).toContain("Subtask for Bola");

    const checked = await w.send(directId, "check subtask");
    const checkReply = await w.settled(directId, checked.replies[0]!.id);
    expect(checkReply.text).toContain("Direct-chat task");
  });
});
