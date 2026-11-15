/**
 * Agents talking to each other: the `mention` tool wakes other members, a user message may start
 * only five such wakes, and the room an agent is in is one tool call away.
 */
import type { World } from "./support/world";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { call, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

/** Two agents in one conversation, Ada the project's steward. */
async function pair(w: World) {
  const ada = await w.agent("Ada");
  const bob = await w.agent("Bob");
  const project = await w.project({ stewardId: ada.id });
  const group = await w.group(project.id, [ada.id, bob.id], "plans");
  await w.watch(group.id);
  return { ada, bob, project, group };
}

describe("the mention tool", () => {
  it("wakes the member it names, who is told who is speaking", async () => {
    const { models, requests } = scriptedModels((request) => {
      if (request.agent === "Bob") return say("Reviewed, it is fine.");
      return request.lastRole === "toolResult"
        ? say("I asked Bob.")
        : call("mention", {
            agents: ["bob"],
            message: "please review the plan",
          });
    });
    const w = await world({ models });
    const { ada, bob, group } = await pair(w);

    const sent = await w.send(group.id, "plan the release");
    const adas = await w.settled(group.id, sent.replies[0]!.id);
    expect(adas.text).toBe("I asked Bob.");
    // Her request offered the tool, as it does to every member of a conversation.
    expect(requests[0]!.tools).toEqual(
      expect.arrayContaining(["mention", "conversation_info"]),
    );

    await until(
      () =>
        w
          .rows(group.id)
          .filter((row) => row.kind === "message" && row.author === "agent")
          .length === 2,
    );
    const rows = w.rows(group.id);
    const mention = rows.find((row) => row.kind === "mention")!;
    expect(mention).toMatchObject({
      author: "agent",
      agentId: ada.id,
      text: "please review the plan",
      mentions: [bob.id],
      rootMessageId: sent.message.id,
      status: "done",
    });
    const bobs = rows.find(
      (row) => row.kind === "message" && row.agentId === bob.id,
    )!;
    expect(bobs).toMatchObject({
      replyToId: mention.id,
      rootMessageId: sent.message.id,
    });
    const answered = await w.settled(group.id, bobs.id);
    expect(answered.text).toBe("Reviewed, it is fine.");
    // Bob was told who said it, and what the user had said before that.
    const told = requests.find((request) => request.agent === "Bob")!.last;
    expect(told).toContain("[conversation: plans]");
    expect(told).toContain("Ada says:\nplease review the plan");
    expect(told).toContain("- the user: plan the release");
    // The reply Ada was writing kept its place, before the mention it made.
    expect(adas.seq).toBeLessThan(mention.seq);
  });

  it("says who is not here, and wakes nobody, when the name is nobody's", async () => {
    const { models, requests } = scriptedModels((request) =>
      request.lastRole === "toolResult"
        ? say("Never mind.")
        : call("mention", { agents: ["Zed", "Ada"], message: "hello" }),
    );
    const w = await world({ models });
    const { group } = await pair(w);
    const sent = await w.send(group.id, "go");
    await w.settled(group.id, sent.replies[0]!.id);

    expect(w.rows(group.id).some((row) => row.kind === "mention")).toBe(false);
    // The tool's answer, as the model read it: a list of who it could have named.
    expect(requests[1]!.last).toContain("Zed");
    expect(requests[1]!.last).toContain("Bob");
    expect(requests).toHaveLength(2);
  });
});

describe("the wake budget", () => {
  it("lets one user message start five wakes between agents, and no more", async () => {
    // Each agent, whenever it is woken, hands the work to the other one.
    const { models } = scriptedModels((request) =>
      request.lastRole === "toolResult"
        ? say("handed over")
        : call("mention", {
            agents: [request.agent === "Ada" ? "Bob" : "Ada"],
            message: "your turn",
          }),
    );
    const w = await world({ models });
    const { group } = await pair(w);

    const sent = await w.send(group.id, "start", {
      mentions: [],
    });
    // Ada, then Bob, Ada, Bob, Ada, Bob: the user's own wake and five from the agents.
    await until(
      () =>
        w
          .rows(group.id)
          .filter((row) => row.author === "agent" && row.kind === "message")
          .length === 6 &&
        w.rows(group.id).every((row) => row.status === "done"),
    );
    const rows = w.rows(group.id);
    const mentions = rows.filter((row) => row.kind === "mention");
    // Six mentions were made: five woke someone, and the sixth landed as context.
    expect(mentions).toHaveLength(6);
    const replies = rows.filter(
      (row) => row.author === "agent" && row.kind === "message",
    );
    expect(replies.map((row) => row.replyToId)).toEqual([
      sent.message.id,
      ...mentions.slice(0, 5).map((row) => row.id),
    ]);
    expect(mentions.every((row) => row.rootMessageId === sent.message.id)).toBe(
      true,
    );
    // The fifth said so, once.
    const reminders = rows.filter((row) => row.kind === "system");
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({ data: { event: "wake_budget" } });
    expect(reminders[0]!.seq).toBeGreaterThan(mentions[4]!.seq);
    expect(reminders[0]!.seq).toBeLessThan(mentions[5]!.seq);

    // The user speaking again starts a budget of its own.
    const again = await w.send(group.id, "once more", { mentions: [] });
    await until(
      () =>
        w.rows(group.id).filter((row) => row.rootMessageId === again.message.id)
          .length > 2,
    );
    await until(() => w.rows(group.id).every((row) => row.status === "done"));
    expect(
      w
        .rows(group.id)
        .filter(
          (row) =>
            row.kind === "mention" && row.rootMessageId === again.message.id,
        ),
    ).toHaveLength(6);
  });

  it("does not count a user's mention against it", async () => {
    const { models } = scriptedModels((request) =>
      request.lastRole === "toolResult"
        ? say("handed over")
        : call("mention", {
            agents: [request.agent === "Ada" ? "Bob" : "Ada"],
            message: "your turn",
          }),
    );
    const w = await world({ models });
    const { ada, group } = await pair(w);

    // The user names Ada; the five wakes between the agents are all still to come.
    const sent = await w.send(group.id, "start", { mentions: [ada.id] });
    await until(
      () =>
        w
          .rows(group.id)
          .filter((row) => row.author === "agent" && row.kind === "message")
          .length === 6 &&
        w.rows(group.id).every((row) => row.status === "done"),
    );
    const rows = w.rows(group.id);
    const mentions = rows.filter((row) => row.kind === "mention");
    expect(mentions).toHaveLength(6);
    const replies = rows.filter(
      (row) => row.author === "agent" && row.kind === "message",
    );
    expect(replies.map((row) => row.replyToId)).toEqual([
      sent.message.id,
      ...mentions.slice(0, 5).map((row) => row.id),
    ]);
  });
});

describe("the conversation_info tool", () => {
  it("tells an agent where it is, who is with it and what has been decided", async () => {
    const { models, requests } = scriptedModels((request) =>
      request.lastRole === "toolResult"
        ? say("Got it.")
        : call("conversation_info", {}),
    );
    const w = await world({ models });
    const { group, project } = await pair(w);
    await w.client.call("conversations", "update", {
      conversationId: group.id,
      goal: "ship friday",
      decided: "no new features",
    });
    const sent = await w.send(group.id, "where are we?");
    await w.settled(group.id, sent.replies[0]!.id);
    const info = requests[1]!.last;
    expect(info).toContain("Conversation: plans");
    expect(info).toContain(`Project: ${project.name}, at ${project.path}`);
    expect(info).toContain("Goal: ship friday");
    expect(info).toContain("Decided so far: no new features");
    expect(info).toContain("Ada (you, steward)");
    expect(info).toContain("Bob");
  });
});
