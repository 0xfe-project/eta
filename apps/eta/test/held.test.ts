/**
 * A message that arrives while every lane that would answer it is busy is not a message of the
 * conversation yet: it waits, it is shown above the box, and it can be taken back. Until the lane
 * picks it up nothing about it is in the record.
 */
import type { World } from "./support/world";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { gate, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

/** One agent who is the project's steward, and a conversation she is in. */
async function ada(w: World) {
  const agent = await w.agent("Ada");
  const project = await w.project({ stewardId: agent.id });
  const group = await w.group(project.id, [agent.id]);
  await w.watch(group.id);
  return { agent, project, group };
}

describe("一条消息在送达之前", () => {
  it("每个能回答它的人都在忙时，它不进对话，只在 held 里", async () => {
    const first = gate();
    const { models } = scriptedModels(async (request) => {
      if (request.index === 0) {
        await first.opened;
        return say("on it");
      }
      return say("done");
    });
    const w = await world({ models });
    const { group } = await ada(w);

    const one = await w.send(group.id, "write the report");
    await w.settled(group.id, one.replies[0]!.id, ["working"]);

    const two = await w.send(group.id, "and the summary");
    // Written, waiting — but not a message of the conversation.
    await until(() => w.held(group.id).length === 1);
    expect(w.held(group.id).map((row) => row.text)).toEqual([
      "and the summary",
    ]);
    expect(w.rows(group.id).some((row) => row.id === two.message.id)).toBe(
      false,
    );

    // The lane frees up: it becomes a message, and stops being held.
    first.open();
    await w.settled(group.id, two.replies[0]!.id, ["done"]);
    expect(w.rows(group.id).some((row) => row.id === two.message.id)).toBe(
      true,
    );
    expect(w.held(group.id)).toEqual([]);
  });

  it("拉回：删掉那条等待中的消息和它的回复，对话里从头到尾没有它", async () => {
    const first = gate();
    const { models, requests } = scriptedModels(async (request) => {
      if (request.index === 0) {
        await first.opened;
        return say("on it");
      }
      return say("should never run");
    });
    const w = await world({ models });
    const { group } = await ada(w);

    const one = await w.send(group.id, "write the report");
    await w.settled(group.id, one.replies[0]!.id, ["working"]);
    const two = await w.send(group.id, "and the summary");
    await until(() => w.held(group.id).length === 1);

    const recalled = (await w.client.call("conversations", "recall", {
      conversationId: group.id,
      messageId: two.message.id,
    })) as { recalled: boolean };
    expect(recalled.recalled).toBe(true);
    expect(w.held(group.id)).toEqual([]);

    first.open();
    await w.settled(group.id, one.replies[0]!.id, ["done"]);
    // Nothing was ever said: not in the timeline, and the reply it was waiting for never ran.
    expect(w.rows(group.id).some((row) => row.id === two.message.id)).toBe(
      false,
    );
    expect(w.rows(group.id).some((row) => row.id === two.replies[0]!.id)).toBe(
      false,
    );
    expect(requests).toHaveLength(1);
  });

  it("已经送达的召不回来：那已经说出口了", async () => {
    const { models } = scriptedModels(async () => say("done"));
    const w = await world({ models });
    const { group } = await ada(w);

    const sent = await w.send(group.id, "write the report");
    await w.settled(group.id, sent.replies[0]!.id, ["done"]);
    const recalled = (await w.client.call("conversations", "recall", {
      conversationId: group.id,
      messageId: sent.message.id,
    })) as { recalled: boolean };
    expect(recalled.recalled).toBe(false);
    expect(w.rows(group.id).some((row) => row.id === sent.message.id)).toBe(
      true,
    );
  });

  it("空闲时发的消息立刻是消息，不是等待中的", async () => {
    const { models } = scriptedModels(async () => say("done"));
    const w = await world({ models });
    const { group } = await ada(w);

    const sent = await w.send(group.id, "write the report");
    expect(w.held(group.id)).toEqual([]);
    expect(w.rows(group.id).some((row) => row.id === sent.message.id)).toBe(
      true,
    );
  });
});
