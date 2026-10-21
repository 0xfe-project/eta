/**
 * A sender may mark where its folded pastes sit inside a message's text. The host reads those
 * ranges as integers and nothing else, writes them onto the row without looking at them, and
 * the sender finds them again in the reply and in the pushed rows. What the agents are told
 * stays the text alone, blocks included as the plain text they stand for.
 */
import type { World } from "./support/world";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { world } from "./support/world";

/** One agent as the project's steward, and a conversation she is in. */
async function chat(w: World) {
  const agent = await w.agent("Ada");
  const project = await w.project({ stewardId: agent.id });
  const group = await w.group(project.id, [agent.id]);
  await w.watch(group.id);
  return { group };
}

const PASTE = "很长的粘贴内容\n".repeat(100); // 800 characters

describe("the blocks a send carries", () => {
  it("writes them onto the row verbatim, in the reply and in the pushed row", async () => {
    const w = await world();
    const { group } = await chat(w);
    const text = `先看：\n${PASTE}\n就这些`;
    const start = "先看：\n".length;
    const sent = await w.send(group.id, text, {
      blocks: [[start, start + PASTE.length]],
    });
    // The text is what it was, and the ranges come back as they were sent.
    expect(sent.message.text).toBe(text);
    expect(sent.message.data.blocks).toEqual([[start, start + PASTE.length]]);
    // The same row, through the store and the push.
    await until(() =>
      w.rows(group.id).some((row) => row.id === sent.message.id),
    );
    expect(w.row(group.id, sent.message.id)!.data.blocks).toEqual([
      [start, start + PASTE.length],
    ]);
  });

  it("keeps a message that sends none free of the key", async () => {
    const w = await world();
    const { group } = await chat(w);
    const sent = await w.send(group.id, "随口一句");
    expect(sent.message.data.blocks).toBeUndefined();
  });

  it("refuses blocks that are not pairs of integers", async () => {
    const w = await world();
    const { group } = await chat(w);
    await expect(
      w.client.call("conversations", "send", {
        conversationId: group.id,
        text: "随口一句",
        blocks: [["a", 1]],
      }),
    ).rejects.toThrow(/blocks/);
  });
});
