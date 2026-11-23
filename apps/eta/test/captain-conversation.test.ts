/**
 * Captain's conversation belongs to the captain module (`captain/policy.ts`): made by the host and
 * by `captain.direct`, talked in like any conversation, but nobody joins or leaves it, it is not
 * edited, and it is not a row of `conversations.list`.
 */
import type { ConversationSummary, MemberView } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
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
});
