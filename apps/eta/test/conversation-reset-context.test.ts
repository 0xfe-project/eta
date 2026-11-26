/**
 * A member's context can be started over by hand: its session is let go and the next wake makes a
 * new one. The old journal stays; a reply still running refuses it.
 */
import { describe, expect, it } from "vitest";
import { say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const options = { captain: true, tasks: { runs: false } } as const;

describe("conversations.resetContext", () => {
  it("lets go of the session, and the next message makes a new one", async () => {
    const { models } = scriptedModels(() => say("Hello."));
    const w = await world({ ...options, models });
    const { conversationId } = await w.host.product.captain.direct();
    await w.watch(conversationId);
    const sessionOf = () =>
      w.host.db
        .query<{ id: string | null }, [string]>(
          "SELECT session_id AS id FROM participant WHERE conversation_id = ?",
        )
        .get(conversationId)!.id;

    const sent = await w.send(conversationId, "Hi");
    await w.settled(conversationId, sent.replies[0]!.id);
    const before = sessionOf();
    expect(before).not.toBeNull();

    const result = (await w.client.call("conversations", "resetContext", {
      conversationId,
    })) as { cleared: number };
    expect(result.cleared).toBe(1);
    expect(sessionOf()).toBeNull();

    const again = await w.send(conversationId, "Still there?");
    await w.settled(conversationId, again.replies[0]!.id);
    expect(sessionOf()).not.toBeNull();
    expect(sessionOf()).not.toBe(before);
  });

  it("refuses a conversation that does not exist", async () => {
    const w = await world(options);
    await expect(
      w.client.call("conversations", "resetContext", {
        conversationId: "nope",
      }),
    ).rejects.toThrow();
  });
});
