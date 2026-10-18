/**
 * Switching the steward, and what a woken agent is told: only what it has not seen.
 */
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { say, scriptedModels } from "./support/models";
import { world } from "./support/world";

describe("switching the steward", () => {
  it("leaves the old steward in place and tells the new one only what it has not seen", async () => {
    let turn = 0;
    const { models, requests } = scriptedModels((request) => {
      turn += 1;
      return say(`${request.agent} answer ${turn}`);
    });
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id], "plans");
    await w.watch(group.id);
    const talk = async (text: string, extra = {}) => {
      const sent = await w.send(group.id, text, extra);
      await w.settled(group.id, sent.replies[0]!.id);
      return sent;
    };
    const lastRequest = () => requests.at(-1)!;

    await talk("m1");
    await talk("m2");
    expect(requests).toHaveLength(2);
    // Ada's second wake carried nothing but the message: she wrote everything else herself.
    expect(lastRequest().last).toBe(
      "[conversation: plans]\nthe user says:\nm2",
    );

    // Bob is not in the conversation and has no session.
    expect(
      w.client
        .section<{ agentId: string }[]>(`conversations.${group.id}`, "members")!
        .map((member) => member.agentId),
    ).toEqual([ada.id]);

    await w.client.call("projects", "setSteward", {
      projectId: project.id,
      agentId: bob.id,
    });
    await until(() => w.rows(group.id).some((row) => row.kind === "system"));
    expect(w.rows(group.id).find((row) => row.kind === "system")!.text).toBe(
      "Bob is now the steward, taking over from Ada.",
    );
    // Switching woke nobody and made no session.
    expect(requests).toHaveLength(2);

    // The next message with nobody named goes to Bob, who joins and is told the whole story.
    await talk("m3");
    expect(requests).toHaveLength(3);
    const first = lastRequest();
    expect(first.agent).toBe("Bob");
    expect(first.last).toBe(
      [
        "[conversation: plans]",
        "Since you last looked:",
        "- the user: m1",
        "- Ada: Ada answer 1",
        "- the user: m2",
        "- Ada: Ada answer 2",
        "- system: Bob is now the steward, taking over from Ada.",
        "",
        "the user says:",
        "m3",
      ].join("\n"),
    );
    const members = w.client.section<
      { agentId: string; sessionId: string | null; lastSeq: number }[]
    >(`conversations.${group.id}`, "members")!;
    expect(members.map((member) => member.agentId)).toEqual([ada.id, bob.id]);
    expect(members[0]!.sessionId).not.toBe(members[1]!.sessionId);
    expect(members[1]!.sessionId).toMatch(/^eta-/);

    // His next wake is told nothing he has seen.
    await talk("m4");
    expect(lastRequest().agent).toBe("Bob");
    expect(lastRequest().last).toBe(
      "[conversation: plans]\nthe user says:\nm4",
    );

    // Ada is still a member, and when she is asked she hears what happened without her.
    const asked = await w.send(group.id, "@Ada what do you think?", {
      mentions: [ada.id],
    });
    await w.settled(group.id, asked.replies[0]!.id);
    expect(lastRequest().agent).toBe("Ada");
    expect(lastRequest().last).toBe(
      [
        "[conversation: plans]",
        "Since you last looked:",
        "- system: Bob is now the steward, taking over from Ada.",
        "- the user: m3",
        "- Bob: Bob answer 3",
        "- the user: m4",
        "- Bob: Bob answer 4",
        "",
        "the user says:",
        "@Ada what do you think?",
      ].join("\n"),
    );
  });

  it("is a conversation's own choice too, and null gives it back to the project", async () => {
    const { models } = scriptedModels((request) =>
      say(`${request.agent} here`),
    );
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id, bob.id]);
    const other = await w.group(project.id, [ada.id, bob.id]);
    await w.watch(group.id);
    await w.watch(other.id);

    await w.client.call("conversations", "setSteward", {
      conversationId: group.id,
      agentId: bob.id,
    });
    await until(() => w.rows(group.id).length === 1);
    expect(w.rows(group.id)[0]).toMatchObject({
      kind: "system",
      data: { event: "steward", from: ada.id, to: bob.id },
    });
    const info = () =>
      w.client.section<{
        stewardId: string | null;
        stewardOverrideId: string | null;
      }>(`conversations.${group.id}`, "info");
    await until(() => info()?.stewardId === bob.id);
    expect(info()?.stewardOverrideId).toBe(bob.id);
    // The other conversation did not move.
    expect(w.rows(other.id)).toHaveLength(0);

    await w.client.call("conversations", "setSteward", {
      conversationId: group.id,
      agentId: null,
    });
    await until(() => info()?.stewardId === ada.id);
    expect(info()?.stewardOverrideId).toBeNull();
    expect(w.rows(group.id).at(-1)?.data).toMatchObject({
      from: bob.id,
      to: ada.id,
    });
    await expect(
      w.client.call("conversations", "setSteward", {
        conversationId: group.id,
        agentId: "nobody",
      }),
    ).rejects.toThrow(/no such agent/);
  });

  it("is dropped from a conversation when its holder leaves it", async () => {
    const w = await world();
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id, bob.id]);
    await w.client.call("conversations", "setSteward", {
      conversationId: group.id,
      agentId: bob.id,
    });
    await w.watch(group.id);
    await w.client.call("conversations", "remove", {
      conversationId: group.id,
      agentId: bob.id,
    });
    await until(
      () =>
        w.client.section<{ stewardOverrideId: string | null }>(
          `conversations.${group.id}`,
          "info",
        )?.stewardOverrideId === null,
    );
  });
});

describe("what a reopened session is told", () => {
  it("is the same whether the session was open or had to be opened again after a restart", async () => {
    const { models, requests } = scriptedModels((request) =>
      say(`${request.agent} here`),
    );
    const first = await world({ models });
    const ada = await first.agent("Ada");
    const project = await first.project({ stewardId: ada.id });
    const group = await first.group(project.id, [ada.id], "plans");
    await first.watch(group.id);
    const one = await first.send(group.id, "m1");
    await first.settled(group.id, one.replies[0]!.id);
    const sessionId = first.client.section<{ sessionId: string }[]>(
      `conversations.${group.id}`,
      "members",
    )![0]!.sessionId;
    await first.host.close();

    const second = await world({ dataDir: first.host.dataDir, models });
    await second.watch(group.id);
    const two = await second.send(group.id, "m2");
    await second.settled(group.id, two.replies[0]!.id);
    // The participant row named the session, so the restart found it rather than making another.
    expect(
      second.client.section<{ sessionId: string }[]>(
        `conversations.${group.id}`,
        "members",
      )![0]!.sessionId,
    ).toBe(sessionId);
    expect(requests.at(-1)!.last).toBe(
      "[conversation: plans]\nthe user says:\nm2",
    );
    // And the model saw its own earlier exchange: the journal came back with the session.
    expect(requests.at(-1)!.transcript.join("\n")).toContain("m1");
  });
});
