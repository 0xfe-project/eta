/**
 * Switching the steward, and what a woken agent is told: only what it has not seen.
 */
import type { ConversationSummary } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { say, scriptedModels } from "./support/models";
import { world } from "./support/world";

describe("switching the steward", () => {
  it("leaves the old steward in place and tells the new one only what it has not seen", async () => {
    let turn = 0;
    const { models, requests: all } = scriptedModels((request) => {
      // A session's memory extraction at the end of a run asks the model too, as nobody in
      // particular and whenever it gets round to it: only an agent's own turns are counted.
      if (request.agent === undefined) return say("{}");
      turn += 1;
      return say(`${request.agent} answer ${turn}`);
    });
    const requests = {
      at: (index: number) =>
        all.filter((request) => request.agent !== undefined).at(index),
      get length() {
        return all.filter((request) => request.agent !== undefined).length;
      },
    };
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const project = await w.project();
    // Ada is the first member, so she is the steward; Bob is in the group and has not spoken.
    const group = await w.group(project.id, [ada.id, bob.id], "plans");
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

    // Bob has no session yet.
    expect(
      w.client
        .section<{ agentId: string; sessionId: string | null }[]>(
          `conversations.${group.id}`,
          "members",
        )!
        .find((member) => member.agentId === bob.id)?.sessionId,
    ).toBeNull();

    await w.client.call("conversations", "setSteward", {
      conversationId: group.id,
      agentId: bob.id,
    });
    await until(() => w.rows(group.id).some((row) => row.kind === "system"));
    expect(w.rows(group.id).find((row) => row.kind === "system")!.text).toBe(
      "Bob is now the steward, taking over from Ada.",
    );
    // Switching woke nobody and made no session.
    expect(requests).toHaveLength(2);

    // The next message with nobody named goes to Bob, who is told the whole story.
    await talk("m3");
    expect(requests).toHaveLength(3);
    const first = lastRequest();
    expect(first.agent).toBe("Bob");
    expect(first.last).toBe(
      [
        "[conversation: plans]",
        "Since you last looked:",
        "- the user: m1 (to Ada; Ada replied)",
        "- Ada: Ada answer 1",
        "- the user: m2 (to Ada; Ada replied)",
        "- Ada: Ada answer 2",
        "- system: Bob is now the steward, taking over from Ada.",
        "(The above is background: handled already, or not for you. Answer only the message below, unless it asks you to take up something above.)",
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
        "- the user: m3 (to Bob; Bob replied)",
        "- Bob: Bob answer 3",
        "- the user: m4 (to Bob; Bob replied)",
        "- Bob: Bob answer 4",
        "(The above is background: handled already, or not for you. Answer only the message below, unless it asks you to take up something above.)",
        "",
        "the user says:",
        "@Ada what do you think?",
      ].join("\n"),
    );
  });

  it("is one of the members or nobody, and says so in the timeline", async () => {
    const { models, requests } = scriptedModels((request) =>
      say(`${request.agent} here`),
    );
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const cy = await w.agent("Cy");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id, bob.id]);
    const other = await w.group(project.id, [ada.id, bob.id]);
    await w.watch(group.id);
    await w.watch(other.id);
    const info = () =>
      w.client.section<{ stewardId: string | null }>(
        `conversations.${group.id}`,
        "info",
      );
    expect(info()?.stewardId).toBe(ada.id);

    await w.client.call("conversations", "setSteward", {
      conversationId: group.id,
      agentId: bob.id,
    });
    await until(() => w.rows(group.id).length === 1);
    expect(w.rows(group.id)[0]).toMatchObject({
      kind: "system",
      data: { event: "steward", from: ada.id, to: bob.id },
    });
    await until(() => info()?.stewardId === bob.id);
    // The other conversation did not move.
    expect(w.rows(other.id)).toHaveLength(0);

    // Somebody who is not a member is refused, and nothing changes: nobody is added for it.
    await expect(
      w.client.call("conversations", "setSteward", {
        conversationId: group.id,
        agentId: cy.id,
      }),
    ).rejects.toThrow(/not a member/);
    await expect(
      w.client.call("conversations", "setSteward", {
        conversationId: group.id,
        agentId: "nobody",
      }),
    ).rejects.toThrow(/no such agent/);
    expect(info()?.stewardId).toBe(bob.id);
    expect(
      w.client
        .section<{ agentId: string }[]>(`conversations.${group.id}`, "members")!
        .map((member) => member.agentId),
    ).toEqual([ada.id, bob.id]);

    // Null is none: a message that names nobody in a group of two wakes nobody, and says so.
    await w.client.call("conversations", "setSteward", {
      conversationId: group.id,
      agentId: null,
    });
    await until(() => info()?.stewardId === null);
    expect(w.rows(group.id).at(-1)).toMatchObject({
      text: "Bob is no longer the steward.",
      data: { event: "steward", from: bob.id, to: null },
    });
    const sent = await w.send(group.id, "anyone?");
    expect(sent.nobody).toBe(true);
    expect(sent.replies).toEqual([]);
    expect(sent.message.data).toMatchObject({ woke: [] });
    expect(requests).toHaveLength(0);
  });

  it("leaves with its holder: the group has none, and the next message pulls nobody back in", async () => {
    const { models, requests } = scriptedModels((request) =>
      request.agent === undefined ? say("{}") : say(`${request.agent} here`),
    );
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const cy = await w.agent("Cy");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id, bob.id, cy.id], "plans");
    await w.watch(group.id);
    const info = () =>
      w.client.section<{ stewardId: string | null }>(
        `conversations.${group.id}`,
        "info",
      );
    const members = () =>
      w.client
        .section<{ agentId: string }[]>(`conversations.${group.id}`, "members")!
        .map((member) => member.agentId);
    expect(info()?.stewardId).toBe(ada.id);

    await w.client.call("conversations", "remove", {
      conversationId: group.id,
      agentId: ada.id,
    });
    await until(() => info()?.stewardId === null);
    expect(w.rows(group.id)).toEqual([
      expect.objectContaining({
        kind: "system",
        text: "Ada left the group, which has no steward now.",
        data: { event: "steward", from: ada.id, to: null, reason: "left" },
      }),
    ]);

    // Nobody named, two members, no steward: nobody is woken and Ada stays out.
    const sent = await w.send(group.id, "who is there?");
    expect(sent.nobody).toBe(true);
    expect(sent.replies).toEqual([]);
    expect(members()).toEqual([bob.id, cy.id]);
    expect(info()?.stewardId).toBeNull();

    // With one member left, that one is the only reader: still not Ada.
    await w.client.call("conversations", "remove", {
      conversationId: group.id,
      agentId: cy.id,
    });
    await until(() => members().length === 1);
    const next = await w.send(group.id, "and now?");
    expect(next.replies.map((reply) => reply.agentId)).toEqual([bob.id]);
    await w.settled(group.id, next.replies[0]!.id);
    expect(members()).toEqual([bob.id]);
    expect(
      requests
        .map((request) => request.agent)
        .filter((agent) => agent !== undefined),
    ).toEqual(["Bob"]);
  });

  it("leaves without a word when a member who was not the steward leaves", async () => {
    const w = await world();
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id, bob.id]);
    await w.watch(group.id);
    await w.client.call("conversations", "remove", {
      conversationId: group.id,
      agentId: bob.id,
    });
    await until(
      () =>
        w.client.section<{ agentId: string }[]>(
          `conversations.${group.id}`,
          "members",
        )?.length === 1,
    );
    expect(
      w.client.section<{ stewardId: string | null }>(
        `conversations.${group.id}`,
        "info",
      )?.stewardId,
    ).toBe(ada.id);
    expect(w.rows(group.id)).toEqual([]);
  });
});

describe("what a reopened session is told", () => {
  it("is the same whether the session was open or had to be opened again after a restart", async () => {
    const { models, requests } = scriptedModels((request) =>
      say(`${request.agent} here`),
    );
    const first = await world({ models });
    const ada = await first.agent("Ada");
    const project = await first.project();
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

describe("choosing the steward when a conversation is made", () => {
  const replying = () =>
    scriptedModels((request) => say(`${request.agent} here`));

  const members = (
    w: Awaited<ReturnType<typeof world>>,
    conversationId: string,
  ) =>
    w.client
      .section<{ agentId: string }[]>(
        `conversations.${conversationId}`,
        "members",
      )!
      .map((member) => member.agentId);

  const info = (w: Awaited<ReturnType<typeof world>>, id: string) =>
    w.client.section(`conversations.${id}`, "info");

  const create = async (
    w: Awaited<ReturnType<typeof world>>,
    args: {
      projectId: string;
      agentIds: string[];
      stewardId?: string | null;
    },
  ) => {
    const { conversation } = (await w.client.call(
      "conversations",
      "create",
      args,
    )) as { conversation: ConversationSummary };
    return conversation;
  };

  it("gives the first message to the one chosen", async () => {
    const { models, requests } = replying();
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const project = await w.project();
    const group = await create(w, {
      projectId: project.id,
      agentIds: [ada.id, bob.id],
      stewardId: bob.id,
    });
    expect(group.stewardId).toBe(bob.id);
    await w.watch(group.id);
    expect(info(w, group.id)).toMatchObject({ stewardId: bob.id });

    const sent = await w.send(group.id, "hello");
    expect(sent.replies.map((reply) => reply.agentId)).toEqual([bob.id]);
    await w.settled(group.id, sent.replies[0]!.id);
    expect(requests.map((request) => request.agent)).toEqual(["Bob"]);
    expect(members(w, group.id)).toEqual([ada.id, bob.id]);
  });

  it("is the first member when nobody is chosen", async () => {
    const { models } = replying();
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const project = await w.project();
    const group = await create(w, {
      projectId: project.id,
      agentIds: [bob.id, ada.id],
    });
    expect(group.stewardId).toBe(bob.id);
    await w.watch(group.id);
    const sent = await w.send(group.id, "hello");
    expect(sent.replies.map((reply) => reply.agentId)).toEqual([bob.id]);
  });

  it("can be nobody: a message that names nobody then wakes nobody", async () => {
    const { models, requests } = replying();
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const project = await w.project();
    const group = await create(w, {
      projectId: project.id,
      agentIds: [ada.id, bob.id],
      stewardId: null,
    });
    expect(group.stewardId).toBeNull();
    await w.watch(group.id);
    const sent = await w.send(group.id, "hello");
    expect(sent.nobody).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("says nothing in the timeline: there was no steward before this one", async () => {
    const { models } = replying();
    const w = await world({ models });
    const bob = await w.agent("Bob");
    const project = await w.project();
    const group = await create(w, {
      projectId: project.id,
      agentIds: [bob.id],
      stewardId: bob.id,
    });
    await w.watch(group.id);
    expect(w.rows(group.id)).toEqual([]);
  });

  it("refuses a steward who is not a member or is nobody, and a group of nobody, and makes nothing", async () => {
    const { models } = replying();
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const project = await w.project();
    const count = () =>
      w.client.section<ConversationSummary[]>("conversations", "list")!.length;
    const before = count();
    await expect(
      create(w, {
        projectId: project.id,
        agentIds: [ada.id],
        stewardId: bob.id,
      }),
    ).rejects.toThrow("the steward has to be a member");
    await expect(
      create(w, {
        projectId: project.id,
        agentIds: [ada.id],
        stewardId: "nobody",
      }),
    ).rejects.toThrow("no such agent");
    await expect(
      create(w, { projectId: project.id, agentIds: [] }),
    ).rejects.toThrow("a group needs at least one member");
    expect(count()).toBe(before);
  });
});
