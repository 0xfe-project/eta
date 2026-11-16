/**
 * A message that arrives while every lane that would answer it is busy is not a message of the
 * conversation yet: it waits, it is shown above the box, and it can be taken back. Until the lane
 * picks it up nothing about it is in the record.
 */
import type { SteerHeldResult } from "@eta/client-contracts";
import type { World } from "./support/world";
import { describe, expect, it } from "vitest";
import { holdNextDelivery, uploadNote } from "./support/briefing";
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

const steerHeld = async (w: World, conversationId: string, messageId: string) =>
  (await w.client.call("conversations", "steerHeld", {
    conversationId,
    messageId,
  })) as SteerHeldResult;

describe("插入当前这一轮（steerHeld）", () => {
  it("还在排队时：并入正在进行的回复，不再有第二条回复，模型读到了它", async () => {
    const first = gate();
    const { models, requests } = scriptedModels(async (request) => {
      if (request.index === 0) {
        await first.opened;
        return say("on it");
      }
      return say("now with your correction");
    });
    const w = await world({ models });
    const { agent, group } = await ada(w);

    const one = await w.send(group.id, "write the report");
    const reply = one.replies[0]!;
    await w.settled(group.id, reply.id, ["working"]);
    await until(() => requests.length === 1);
    const two = await w.send(group.id, "make it shorter");
    await until(() => w.held(group.id).length === 1);

    const steered = await steerHeld(w, group.id, two.message.id);
    expect(steered).toMatchObject({
      steered: true,
      joined: [agent.id],
      replies: [],
      dropped: [two.replies[0]!.id],
    });
    // A message of the conversation now, marked the way a `/steer` is.
    expect(steered.message?.data).toMatchObject({
      joined: [agent.id],
      woke: [],
    });
    expect(steered.message?.data.held).toBeUndefined();
    await until(() => w.held(group.id).length === 0);
    expect(w.rows(group.id).some((row) => row.id === two.message.id)).toBe(
      true,
    );

    first.open();
    const done = await w.settled(group.id, reply.id);
    expect(done.text).toBe("now with your correction");
    // The queued reply it had went: one answer for the whole exchange.
    expect(
      w.rows(group.id).filter((row) => row.author === "agent"),
    ).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.transcript.join("\n")).toContain("make it shorter");
    // Sent once: the words reached the model in one request and nowhere else.
    expect(
      requests.filter((request) =>
        request.transcript.join("\n").includes("make it shorter"),
      ),
    ).toHaveLength(1);
  });

  it("已经被读走了：不再插入，不重复发送，告诉调用方 taken", async () => {
    const first = gate();
    const second = gate();
    const { models, requests } = scriptedModels(async (request) => {
      if (request.index === 0) {
        await first.opened;
        return say("on it");
      }
      await second.opened;
      return say("the summary");
    });
    const w = await world({ models });
    const { group } = await ada(w);

    const one = await w.send(group.id, "write the report");
    await w.settled(group.id, one.replies[0]!.id, ["working"]);
    const two = await w.send(group.id, "and the summary");
    await until(() => w.held(group.id).length === 1);

    // The turn ends and the lane reads the next message before the click lands.
    first.open();
    await w.settled(group.id, two.replies[0]!.id, ["working"]);
    await until(() => requests.length === 2);
    expect(w.held(group.id)).toEqual([]);

    const steered = await steerHeld(w, group.id, two.message.id);
    expect(steered).toMatchObject({
      steered: false,
      reason: "taken",
      joined: [],
      dropped: [],
    });
    second.open();
    await w.settled(group.id, two.replies[0]!.id);
    // Still one copy of the words, answered once.
    expect(
      w.rows(group.id).filter((row) => row.text === "and the summary"),
    ).toHaveLength(1);
    expect(requests).toHaveLength(2);
  });

  it("插入时这一轮刚好结束：退回成一条独立的回复，答案写得回来，只发一次", async () => {
    const first = gate();
    const { models, requests } = scriptedModels(async (request) => {
      if (request.index === 0) {
        await first.opened;
        return say("on it");
      }
      return say("the summary");
    });
    const w = await world({ models });
    const { agent, group } = await ada(w);

    const one = await w.send(group.id, "write the report");
    await w.settled(group.id, one.replies[0]!.id, ["working"]);
    await until(() => requests.length === 1);
    const note = await uploadNote(w.client, group.id);
    const two = await w.send(group.id, "and the summary", {
      attachments: [note],
    });
    await until(() => w.held(group.id).length === 1);

    // Joinable when the click lands; the turn ends while the briefing puts the file in place.
    const hold = holdNextDelivery();
    const steering = steerHeld(w, group.id, two.message.id);
    await hold.reached;
    first.open();
    expect((await w.settled(group.id, one.replies[0]!.id)).text).toBe("on it");
    hold.release();
    const steered = await steering;

    expect(steered).toMatchObject({
      steered: false,
      reason: "ended",
      joined: [],
      dropped: [two.replies[0]!.id],
    });
    expect(steered.replies).toHaveLength(1);
    expect(steered.message?.data).toMatchObject({
      joined: [],
      woke: [agent.id],
    });
    const own = await w.settled(group.id, steered.replies[0]!.id);
    expect(own).toMatchObject({ status: "done", text: "the summary" });
    // One copy of the words, read by the model once.
    expect(
      w.rows(group.id).filter((row) => row.text === "and the summary"),
    ).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(
      requests.filter((request) =>
        request.transcript.join("\n").includes("and the summary"),
      ),
    ).toHaveLength(1);
  });

  it("好几个智能体在回复：和 /steer 一样，并入每一个正在进行的回复", async () => {
    const gates = { Ada: gate(), Bo: gate() };
    const { models, requests } = scriptedModels(async (request) => {
      const name = request.agent as "Ada" | "Bo";
      if (!request.transcript.join("\n").includes("both of you")) {
        await gates[name].opened;
        return say(`${name} on it`);
      }
      if (!request.transcript.join("\n").includes("also check Safari"))
        await gates[name].opened;
      return say(`${name} with Safari`);
    });
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const bo = await w.agent("Bo");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id, bo.id]);
    await w.watch(group.id);

    const one = await w.send(group.id, "both of you", {
      mentions: [ada.id, bo.id],
    });
    expect(one.replies).toHaveLength(2);
    for (const reply of one.replies)
      await w.settled(group.id, reply.id, ["working"]);
    await until(() => requests.length === 2);
    const two = await w.send(group.id, "also check Safari", {
      mentions: [ada.id, bo.id],
    });
    await until(() => w.held(group.id).length === 1);

    const steered = await steerHeld(w, group.id, two.message.id);
    expect(steered.steered).toBe(true);
    expect([...steered.joined].sort()).toEqual([ada.id, bo.id].sort());
    expect(steered.dropped).toHaveLength(2);

    gates.Ada.open();
    gates.Bo.open();
    for (const reply of one.replies) await w.settled(group.id, reply.id);
    expect(
      w.rows(group.id).filter((row) => row.author === "agent"),
    ).toHaveLength(2);
  });

  it("早已送达的消息：不是排队中的，什么都不再发", async () => {
    const { models } = scriptedModels(async () => say("done"));
    const w = await world({ models });
    const { group } = await ada(w);
    const sent = await w.send(group.id, "write the report");
    await w.settled(group.id, sent.replies[0]!.id);
    const steered = await steerHeld(w, group.id, sent.message.id);
    // Delivered long ago: it is a message, and nothing is said again.
    expect(steered).toMatchObject({ steered: false, reason: "taken" });
  });

  it("没有可以插入的回复（那一轮正在停下）：返回 idle，消息原样排着，什么都没发", async () => {
    const first = gate();
    const { models, requests } = scriptedModels(async (request) => {
      // Deaf to the abort: the reply stays `stopping` until the gate opens.
      if (request.index === 0) await first.opened;
      return say("done");
    });
    const w = await world({ models });
    const { group } = await ada(w);

    const one = await w.send(group.id, "write the report");
    await w.settled(group.id, one.replies[0]!.id, ["working"]);
    await until(() => requests.length === 1);
    const two = await w.send(group.id, "and the summary");
    await until(() => w.held(group.id).length === 1);
    await w.client.call("conversations", "stop", {
      conversationId: group.id,
      messageId: one.replies[0]!.id,
    });
    await w.settled(group.id, one.replies[0]!.id, ["stopping"]);

    const steered = await steerHeld(w, group.id, two.message.id);
    expect(steered).toMatchObject({
      steered: false,
      reason: "idle",
      joined: [],
      dropped: [],
    });
    expect(w.held(group.id).map((row) => row.id)).toEqual([two.message.id]);
    expect(requests).toHaveLength(1);
    first.open();
  });

  it("别的会话的消息：是一次错误的调用，不说成被读走了", async () => {
    const first = gate();
    const { models } = scriptedModels(async (request) => {
      if (request.index === 0) await first.opened;
      return say("done");
    });
    const w = await world({ models });
    const { project, agent, group } = await ada(w);
    const other = await w.group(project.id, [agent.id]);
    const one = await w.send(group.id, "write the report");
    await w.settled(group.id, one.replies[0]!.id, ["working"]);
    const two = await w.send(group.id, "and the summary");
    await until(() => w.held(group.id).length === 1);

    await expect(steerHeld(w, other.id, two.message.id)).rejects.toThrow(
      /in this conversation/,
    );
    expect(w.held(group.id).map((row) => row.id)).toEqual([two.message.id]);
    first.open();
  });
});
