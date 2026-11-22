/**
 * Who a message wakes, through a real socket: the members it names, else the steward, else the one
 * member there is, else nobody (and the sender is told). Nobody is ever added to wake them.
 */
import type { AgentView, ConversationSummary } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { HANG, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

/** Every agent answers with its own name, so a reply says who wrote it. */
const replying = () =>
  scriptedModels((request) => say(`${request.agent} here`)).models;

/** Everyone answers but Bob, whose provider says nothing until he is stopped. */
const hangingOnBob = (request: { agent: string | undefined }) =>
  request.agent === "Bob" ? HANG : say(`${request.agent} here`);

describe("a message that names members", () => {
  it("wakes the ones it names, in the order it names them, and nobody else", async () => {
    const w = await world({ models: replying() });
    const [ada, bob, cy] = [
      await w.agent("Ada"),
      await w.agent("Bob"),
      await w.agent("Cy"),
    ] as [AgentView, AgentView, AgentView];
    const project = await w.project();
    const group = await w.group(project.id, [ada.id, bob.id, cy.id]);
    await w.watch(group.id);

    const sent = await w.send(group.id, "@Cy @Bob please look", {
      mentions: [cy.id, bob.id],
    });
    expect(sent.message.mentions).toEqual([cy.id, bob.id]);
    expect(sent.replies.map((reply) => reply.agentId)).toEqual([cy.id, bob.id]);
    expect(sent.nobody).toBe(false);
    for (const reply of sent.replies) {
      const done = await w.settled(group.id, reply.id);
      expect(done.text).toBe(`${reply.agentId === cy.id ? "Cy" : "Bob"} here`);
    }
    // Ada, the steward, was not named and has no session.
    const members = w.client.section<
      { agentId: string; sessionId: string | null }[]
    >(`conversations.${group.id}`, "members")!;
    expect(members.find((m) => m.agentId === ada.id)?.sessionId).toBeNull();
    expect(members.find((m) => m.agentId === bob.id)?.sessionId).toMatch(
      /^eta-/,
    );
  });

  it("ignores a name that is not a member, and falls back to the steward", async () => {
    const w = await world({ models: replying() });
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const outsider = await w.agent("Out");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id, bob.id]);
    await w.watch(group.id);
    const sent = await w.send(group.id, "@Out hello", {
      mentions: [outsider.id],
    });
    expect(sent.message.mentions).toEqual([]);
    expect(sent.replies.map((reply) => reply.agentId)).toEqual([ada.id]);
  });

  it("wakes each member on a session of its own, at once", async () => {
    const both = Promise.withResolvers<void>();
    let arrived = 0;
    const { models } = scriptedModels(async (request) => {
      arrived += 1;
      // Neither answers until both have been asked: serial sessions would wait for ever.
      if (arrived === 2) both.resolve();
      await both.promise;
      return say(`${request.agent} here`);
    });
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id, bob.id]);
    await w.watch(group.id);
    const sent = await w.send(group.id, "both of you", {
      mentions: [ada.id, bob.id],
    });
    for (const reply of sent.replies) await w.settled(group.id, reply.id);
    expect(arrived).toBe(2);
  });
});

describe("a message that names nobody", () => {
  it("goes to the steward", async () => {
    const w = await world({ models: replying() });
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id, bob.id], "plans", bob.id);
    await w.watch(group.id);

    const sent = await w.send(group.id, "anyone?");
    expect(sent.replies.map((reply) => reply.agentId)).toEqual([bob.id]);
    expect(sent.message.mentions).toEqual([]);
    await w.settled(group.id, sent.replies[0]!.id);

    await w.client.call("conversations", "setSteward", {
      conversationId: group.id,
      agentId: ada.id,
    });
    const after = await w.send(group.id, "and now?");
    expect(after.replies.map((reply) => reply.agentId)).toEqual([ada.id]);
  });

  it("never adds anyone to the conversation for it", async () => {
    const w = await world({ models: replying() });
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const cy = await w.agent("Cy");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id, bob.id, cy.id]);
    await w.watch(group.id);
    const members = () =>
      w.client
        .section<{ agentId: string }[]>(`conversations.${group.id}`, "members")!
        .map((member) => member.agentId);
    // Ada, the steward, leaves; whoever she was, she is nobody's default now.
    await w.client.call("conversations", "remove", {
      conversationId: group.id,
      agentId: ada.id,
    });
    await until(() => members().length === 2);
    const sent = await w.send(group.id, "anyone?");
    expect(sent).toMatchObject({ nobody: true, replies: [] });
    expect(members()).toEqual([bob.id, cy.id]);

    // A row that still names her (written before the steward had to be a member, say) is no
    // steward either: she is neither woken nor brought back.
    w.host.db
      .query("UPDATE conversation SET steward_id = ? WHERE id = ?")
      .run(ada.id, group.id);
    const again = await w.send(group.id, "still nobody?");
    expect(again).toMatchObject({ nobody: true, replies: [] });
    expect(members()).toEqual([bob.id, cy.id]);
  });

  it("wakes the only member when there is no steward", async () => {
    const w = await world({ models: replying() });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], undefined, null);
    await w.watch(group.id);
    const sent = await w.send(group.id, "hello");
    expect(sent.replies.map((reply) => reply.agentId)).toEqual([ada.id]);
  });

  it("wakes nobody when there is no steward and more than one member, and says so", async () => {
    const { models, requests } = scriptedModels((request) =>
      say(`${request.agent} here`),
    );
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id, bob.id], undefined, null);
    await w.watch(group.id);

    const sent = await w.send(group.id, "hello?");
    expect(sent).toMatchObject({ nobody: true, replies: [], joined: [] });
    // The message is in the timeline all the same.
    await until(() => w.rows(group.id).length === 1);
    expect(w.rows(group.id)[0]).toMatchObject({
      author: "user",
      text: "hello?",
      status: "done",
    });
    expect(requests).toHaveLength(0);

    // Naming one is all it takes.
    const named = await w.send(group.id, "Bob?", { mentions: [bob.id] });
    expect(named.nobody).toBe(false);
  });
});

describe("sending", () => {
  it("is one message however many times a retry sends it", async () => {
    const { models, requests } = scriptedModels((request) =>
      say(`${request.agent} here`),
    );
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id]);
    await w.watch(group.id);

    const first = await w.send(group.id, "once", { clientId: "client-1" });
    const again = await w.send(group.id, "once", { clientId: "client-1" });
    expect(first.message.id).toBe("client-1");
    expect(again.message.id).toBe("client-1");
    expect(again.replies.map((reply) => reply.id)).toEqual(
      first.replies.map((reply) => reply.id),
    );
    await w.settled(group.id, first.replies[0]!.id);
    expect(
      w.rows(group.id).filter((row) => row.author === "user"),
    ).toHaveLength(1);
    expect(requests).toHaveLength(1);

    // An id that belongs to another conversation's message is not ours to reuse.
    const other = await w.group(project.id, [ada.id]);
    await expect(
      w.send(other.id, "stolen", { clientId: "client-1" }),
    ).rejects.toThrow(/taken/);
  });

  it("refuses an empty message, an unknown conversation and a mode it does not have", async () => {
    const w = await world();
    const project = await w.project();
    const ada = await w.agent("Ada");
    const group = await w.group(project.id, [ada.id]);
    await expect(w.send(group.id, "   ")).rejects.toThrow(/needs text/);
    await expect(w.send("nope", "hi")).rejects.toThrow(/no such conversation/);
    await expect(
      w.send(group.id, "hi", { mode: "shout" as never }),
    ).rejects.toThrow(/mode/);
  });

  it("keeps a reply's place in the timeline while its text is written", async () => {
    const turn = Promise.withResolvers<void>();
    const { models } = scriptedModels(async (request) => {
      await turn.promise;
      return say(`${request.agent} here`);
    });
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id]);
    await w.watch(group.id);

    const first = await w.send(group.id, "one");
    await w.settled(group.id, first.replies[0]!.id, ["working"]);
    // A second message lands while the first reply is still being written.
    const second = await w.send(group.id, "two");
    turn.resolve();
    await w.settled(group.id, second.replies[0]!.id);

    expect(w.rows(group.id).map((row) => row.text)).toEqual([
      "one",
      "Ada here",
      "two",
      "Ada here",
    ]);
    const seqs = w.rows(group.id).map((row) => row.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

describe("conversations", () => {
  it("are made with members, the first of them their steward unless another is chosen", async () => {
    const w = await world({ models: replying() });
    const bob = await w.agent("Bob");
    const project = await w.project();

    const named = await w.group(project.id, [bob.id], "just Bob");
    expect(named.participants.map((m) => m.agentId)).toEqual([bob.id]);
    const unnamed = await w.group(project.id, [bob.id]);
    expect(unnamed.name).toBe(project.name);
    await expect(w.group(project.id, [])).rejects.toThrow(
      /at least one member/,
    );
    expect(named).toMatchObject({
      kind: "group",
      projectId: project.id,
      stewardId: bob.id,
      unread: 0,
      lastSeq: 0,
      archived: false,
    });
    await expect(w.group("nope", [])).rejects.toThrow(/no such project/);
    await expect(w.group(project.id, ["nobody"])).rejects.toThrow(
      /no such agent/,
    );
    // It is a target the moment it exists.
    await w.watch(named.id);
    expect(w.client.section(`conversations.${named.id}`, "timeline")).toEqual({
      messages: [],
      hasMore: false,
      held: [],
    });
  });

  it("take the project's name unless someone names them", async () => {
    const w = await world({ models: replying() });
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const project = await w.project({ name: "roadmap" });

    // Two ways of saying nothing: the new-conversation dialog sends no name, the group page
    // sends the trimmed input, which is the empty string when the field is left alone.
    expect((await w.group(project.id, [ada.id, bob.id])).name).toBe("roadmap");
    expect((await w.group(project.id, [ada.id, bob.id], "")).name).toBe(
      "roadmap",
    );
    expect((await w.group(project.id, [ada.id, bob.id], "   ")).name).toBe(
      "roadmap",
    );
    // A name someone typed is theirs, trimmed.
    expect((await w.group(project.id, [ada.id, bob.id], "  装配 ")).name).toBe(
      "装配",
    );
  });

  it("take several members in at once, all or none", async () => {
    const w = await world();
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const cy = await w.agent("Cy");
    const dee = await w.agent("Dee");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id]);
    // Who is in it, read back by inviting a member again (which changes nothing).
    const members = async (): Promise<string[]> => {
      const { conversation } = (await w.client.call("conversations", "invite", {
        conversationId: group.id,
        agentId: ada.id,
      })) as { conversation: ConversationSummary };
      return conversation.participants.map((p) => p.agentId).sort();
    };

    // One missing agent keeps the whole group out, and the error names it.
    await expect(
      w.client.call("conversations", "invite", {
        conversationId: group.id,
        agentIds: [bob.id, "ghost", cy.id],
      }),
    ).rejects.toThrow(/no such agent: ghost/);
    expect(await members()).toEqual([ada.id]);

    // Both fields at once, or an empty list, is refused.
    await expect(
      w.client.call("conversations", "invite", {
        conversationId: group.id,
        agentId: bob.id,
        agentIds: [cy.id],
      } as never),
    ).rejects.toThrow(/agentId or agentIds/);
    await expect(
      w.client.call("conversations", "invite", {
        conversationId: group.id,
        agentIds: [],
      }),
    ).rejects.toThrow(/needs agentIds/);
    expect(await members()).toEqual([ada.id]);

    // A whole group goes in; one already a member is no change, as when invited alone.
    await w.client.call("conversations", "invite", {
      conversationId: group.id,
      agentIds: [ada.id, bob.id, cy.id],
    });
    expect(await members()).toEqual([ada.id, bob.id, cy.id].sort());

    // The single agentId still works as before.
    await w.client.call("conversations", "invite", {
      conversationId: group.id,
      agentId: dee.id,
    });
    expect(await members()).toEqual([ada.id, bob.id, cy.id, dee.id].sort());
  });

  it("take members in and out, and the removed member stops answering", async () => {
    const { models } = scriptedModels(hangingOnBob);
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id]);
    await w.watch(group.id);

    await w.client.call("conversations", "invite", {
      conversationId: group.id,
      agentId: bob.id,
    });
    // Inviting again changes nothing.
    await w.client.call("conversations", "invite", {
      conversationId: group.id,
      agentId: bob.id,
    });
    await until(
      () =>
        w.client.section<unknown[]>(`conversations.${group.id}`, "members")
          ?.length === 2,
    );
    const sent = await w.send(group.id, "Bob?", { mentions: [bob.id] });
    await w.settled(group.id, sent.replies[0]!.id, ["working"]);

    await w.client.call("conversations", "remove", {
      conversationId: group.id,
      agentId: bob.id,
    });
    const ended = await w.settled(group.id, sent.replies[0]!.id);
    expect(ended.status).toBe("stopped");
    await until(
      () =>
        w.client
          .section<{ agentId: string }[]>(
            `conversations.${group.id}`,
            "members",
          )
          ?.every((member) => member.agentId !== bob.id) === true,
    );
  });

  it("show the user what is unread, and what the last thing said was", async () => {
    const w = await world({ models: replying() });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id]);
    await w.watch(group.id);

    const sent = await w.send(group.id, "hello");
    await w.settled(group.id, sent.replies[0]!.id);
    const summary = async (): Promise<ConversationSummary> => {
      await until(
        () =>
          w.client
            .section<ConversationSummary[]>("conversations", "list")
            ?.find((entry) => entry.id === group.id)?.unread === 1,
      );
      return w.client
        .section<ConversationSummary[]>("conversations", "list")!
        .find((entry) => entry.id === group.id)!;
    };
    const before = await summary();
    expect(before).toMatchObject({
      unread: 1,
      preview: "Ada here",
      lastSeq: 2,
      readSeq: 0,
    });
    expect(before.lastMessageAt).toBeGreaterThan(0);

    // Reading moves the mark forward only, and never past the newest row.
    const read = (await w.client.call("conversations", "read", {
      conversationId: group.id,
      seq: 99,
    })) as { conversation: ConversationSummary };
    expect(read.conversation).toMatchObject({ readSeq: 2, unread: 0 });
    const back = (await w.client.call("conversations", "read", {
      conversationId: group.id,
      seq: 1,
    })) as { conversation: ConversationSummary };
    expect(back.conversation.readSeq).toBe(2);
  });

  it("cannot be renamed to the name of another live group in the same project", async () => {
    const w = await world({ models: replying() });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const elsewhere = await w.project();
    const launch = await w.group(project.id, [ada.id], "launch");
    const docs = await w.group(project.id, [ada.id], "docs");
    const old = await w.group(project.id, [ada.id], "old");
    await w.group(elsewhere.id, [ada.id], "website");
    await w.client.call("conversations", "update", {
      conversationId: old.id,
      archived: true,
    });
    const rename = (conversationId: string, name: string) =>
      w.client.call("conversations", "update", {
        conversationId,
        name,
      }) as Promise<{ conversation: ConversationSummary }>;

    await expect(rename(docs.id, " launch ")).rejects.toThrow(
      /already exists in this project/,
    );
    // An archived group's name, another project's, and its own are free.
    expect((await rename(docs.id, "old")).conversation.name).toBe("old");
    expect((await rename(launch.id, "website")).conversation.name).toBe(
      "website",
    );
    expect((await rename(launch.id, "website")).conversation.name).toBe(
      "website",
    );
  });

  it("keep their facts, and page back through their history", async () => {
    const w = await world({ models: replying() });
    const ada = await w.agent("Ada");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id], "plans");
    await w.watch(group.id);

    const { conversation } = (await w.client.call("conversations", "update", {
      conversationId: group.id,
      name: "roadmap",
      goal: "ship it",
      decided: "friday",
    })) as { conversation: ConversationSummary };
    expect(conversation.name).toBe("roadmap");
    await until(
      () =>
        w.client.section<{ goal: string; decided: string }>(
          `conversations.${group.id}`,
          "info",
        )?.goal === "ship it",
    );
    await expect(
      w.client.call("conversations", "update", {
        conversationId: group.id,
        name: " ",
      }),
    ).rejects.toThrow(/needs a name/);

    for (let n = 1; n <= 4; n += 1) {
      const sent = await w.send(group.id, `message ${n}`);
      await w.settled(group.id, sent.replies[0]!.id);
    }
    // Eight rows: four messages and four replies.
    const newest = (await w.client.call("conversations", "history", {
      conversationId: group.id,
      limit: 3,
    })) as { messages: { seq: number; text: string }[]; hasMore: boolean };
    expect(newest.messages.map((m) => m.seq)).toEqual([6, 7, 8]);
    expect(newest.hasMore).toBe(true);
    const older = (await w.client.call("conversations", "history", {
      conversationId: group.id,
      beforeSeq: 6,
      limit: 100,
    })) as { messages: { seq: number }[]; hasMore: boolean };
    expect(older.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(older.hasMore).toBe(false);
  });
});
