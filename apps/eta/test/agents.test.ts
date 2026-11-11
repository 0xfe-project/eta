/**
 * Agents through a real socket: an agent comes with a workspace and a project, the private chat
 * with it is made once, and deleting it clears what pointed at it and leaves what it wrote.
 */
import type {
  AgentView,
  ConversationSummary,
  MessageView,
  ProjectView,
} from "@eta/client-contracts";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { HANG, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe("creating an agent", () => {
  it("makes its workspace directory and a project for it, with the agent as steward", async () => {
    const w = await world();
    const agent = await w.agent("Ada", {
      instructions: "Be brief.",
      model: "fake:model",
      thinkingLevel: "low",
    });

    expect(agent).toMatchObject({
      name: "Ada",
      instructions: "Be brief.",
      model: "fake:model",
      thinkingLevel: "low",
      persona: "",
      status: "idle",
    });
    expect(agent.home).toBe(join(w.host.dataDir, "agents", agent.id));
    expect(await exists(agent.home)).toBe(true);

    // The workspace is a project on the primary machine, stewarded by the agent.
    const projects = w.client.section<ProjectView[]>("projects", "list")!;
    const home = projects.find((project) => project.id === agent.homeProjectId);
    const machines = w.client.section<{ id: string; kind: string }[]>(
      "machines",
      "list",
    )!;
    expect(home).toMatchObject({
      path: agent.home,
      kind: "agent_home",
      stewardId: agent.id,
      archived: false,
      name: "Ada",
    });
    expect(machines.find((m) => m.id === home?.machineId)?.kind).toBe(
      "primary",
    );
    // The list the client holds is the list the host holds.
    await until(
      () =>
        w.client
          .section<AgentView[]>("agents", "list")
          ?.some((entry) => entry.id === agent.id) === true,
    );
  });

  it("refuses what cannot be an agent", async () => {
    const w = await world();
    await expect(w.agent("  ")).rejects.toThrow(/needs/);
    await expect(w.agent("Ada", { model: "no-provider" })).rejects.toThrow(
      /provider:modelId/,
    );
    await expect(
      w.agent("Ada", { thinkingLevel: "loud" as never }),
    ).rejects.toThrow(/thinking level/);
    expect(
      w.client
        .section<AgentView[]>("agents", "list")
        ?.filter((entry) => entry.systemRole === null),
    ).toEqual([]);
  });

  it("edits an agent in place, and the workspace's names follow a rename", async () => {
    const w = await world();
    const agent = await w.agent("Ada");
    const chat = (await w.client.call("agents", "direct", {
      agentId: agent.id,
    })) as { conversation: ConversationSummary };

    const { agent: edited } = (await w.client.call("agents", "update", {
      agentId: agent.id,
      name: "Ada Lovelace",
      instructions: "Count.",
      model: "fake:other",
    })) as { agent: AgentView };
    expect(edited).toMatchObject({
      name: "Ada Lovelace",
      instructions: "Count.",
      model: "fake:other",
    });
    // A field that was not sent stays, and `null` clears one.
    const cleared = (await w.client.call("agents", "update", {
      agentId: agent.id,
      model: null,
    })) as { agent: AgentView };
    expect(cleared.agent).toMatchObject({ name: "Ada Lovelace", model: null });

    await until(
      () =>
        w.client
          .section<ProjectView[]>("projects", "list")
          ?.find((project) => project.id === agent.homeProjectId)?.name ===
        "Ada Lovelace",
    );
    await until(
      () =>
        w.client
          .section<ConversationSummary[]>("conversations", "list")
          ?.find((entry) => entry.id === chat.conversation.id)?.name ===
        "Ada Lovelace",
    );
    await expect(
      w.client.call("agents", "update", { agentId: "nobody", name: "x" }),
    ).rejects.toThrow(/no such agent/);
  });
});

describe("the private chat", () => {
  it("is made once, in the agent's workspace, with the agent as its only member", async () => {
    const w = await world();
    const agent = await w.agent("Ada");

    const first = (await w.client.call("agents", "direct", {
      agentId: agent.id,
    })) as { conversation: ConversationSummary };
    const second = (await w.client.call("agents", "direct", {
      agentId: agent.id,
    })) as { conversation: ConversationSummary };

    expect(second.conversation.id).toBe(first.conversation.id);
    expect(first.conversation).toMatchObject({
      kind: "direct",
      projectId: agent.homeProjectId,
      name: "Ada",
      archived: false,
      stewardId: agent.id,
    });
    expect(first.conversation.participants.map((m) => m.agentId)).toEqual([
      agent.id,
    ]);
    const listed = w.client.section<ConversationSummary[]>(
      "conversations",
      "list",
    )!;
    // Ada's, once. (Captain's private chat is in the list too: the host makes it when it starts.)
    expect(
      listed.filter(
        (entry) =>
          entry.kind === "direct" &&
          entry.participants.some((member) => member.agentId === agent.id),
      ),
    ).toHaveLength(1);
    // And it is a target of its own, from the moment it exists.
    await w.watch(first.conversation.id);
    expect(
      w.client.section(`conversations.${first.conversation.id}`, "info"),
    ).toMatchObject({ kind: "direct", stewardOverrideId: null });
  });

  it("cannot take or lose members", async () => {
    const w = await world();
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    const { conversation } = (await w.client.call("agents", "direct", {
      agentId: ada.id,
    })) as { conversation: ConversationSummary };
    await expect(
      w.client.call("conversations", "invite", {
        conversationId: conversation.id,
        agentId: bob.id,
      }),
    ).rejects.toThrow(/private chat/);
    await expect(
      w.client.call("conversations", "remove", {
        conversationId: conversation.id,
        agentId: ada.id,
      }),
    ).rejects.toThrow(/private chat/);
  });

  it("answers: queued, then working, then done with the model's words", async () => {
    const turn = Promise.withResolvers<void>();
    const { models } = scriptedModels(async () => {
      await turn.promise;
      return say("Hello, I am Ada.", "The user greets me.");
    });
    const w = await world({ models });
    const agent = await w.agent("Ada");
    const { conversation } = (await w.client.call("agents", "direct", {
      agentId: agent.id,
    })) as { conversation: ConversationSummary };
    await w.watch(conversation.id);

    const sent = await w.send(conversation.id, "Hi Ada");
    // A message in a private chat needs no mention: it is the agent's.
    expect(sent.nobody).toBe(false);
    expect(sent.message).toMatchObject({ author: "user", status: "done" });
    expect(sent.replies).toHaveLength(1);
    const reply = sent.replies[0]!;
    expect(reply).toMatchObject({
      author: "agent",
      agentId: agent.id,
      status: "queued",
      replyToId: sent.message.id,
      rootMessageId: sent.message.id,
      text: "",
    });
    expect(reply.seq).toBeGreaterThan(sent.message.seq);

    // The row is working while the model holds the turn, and the agent says so too.
    await w.settled(conversation.id, reply.id, ["working"]);
    await until(
      () =>
        w.client
          .section<AgentView[]>("agents", "list")
          ?.find((entry) => entry.id === agent.id)?.status === "working",
    );
    turn.resolve();

    const done = await w.settled(conversation.id, reply.id);
    expect(done).toMatchObject({
      status: "done",
      text: "Hello, I am Ada.",
      thinking: "The user greets me.",
      seq: reply.seq,
    });
    expect(done.revision).toBeGreaterThan(reply.revision);
    await until(
      () =>
        w.client
          .section<AgentView[]>("agents", "list")
          ?.find((entry) => entry.id === agent.id)?.status === "idle",
    );

    // What the client saw of that reply, deduplicated, is the lifecycle in order.
    const seen: string[] = [];
    for (const frame of w.client.frames) {
      if (
        frame.type !== "state" ||
        frame.target !== `conversations.${conversation.id}`
      )
        continue;
      const timeline = (frame.snapshot?.sections ?? frame.patch?.sections)
        ?.timeline as { messages: MessageView[] } | undefined;
      const status = timeline?.messages.find((m) => m.id === reply.id)?.status;
      if (status !== undefined && seen.at(-1) !== status) seen.push(status);
    }
    expect(seen).toEqual(["queued", "working", "done"]);

    // The member now has a session, and it is the agent's own.
    const members = w.client.section<{ sessionId: string | null }[]>(
      `conversations.${conversation.id}`,
      "members",
    )!;
    expect(members[0]?.sessionId).toMatch(/^eta-/);
  });

  it("opens the chat again when it was put away", async () => {
    const w = await world();
    const agent = await w.agent("Ada");
    const { conversation } = (await w.client.call("agents", "direct", {
      agentId: agent.id,
    })) as { conversation: ConversationSummary };
    await w.client.call("conversations", "update", {
      conversationId: conversation.id,
      archived: true,
    });
    const again = (await w.client.call("agents", "direct", {
      agentId: agent.id,
    })) as { conversation: ConversationSummary };
    expect(again.conversation).toMatchObject({
      id: conversation.id,
      archived: false,
    });
  });
});

describe("deleting an agent", () => {
  it("clears it as steward, archives its private chat, stops what it was saying, and keeps its directory", async () => {
    const { models, requests } = scriptedModels(() => HANG);
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    await writeFile(join(ada.home, "notes.md"), "kept");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id, bob.id], "plans");
    const chat = (
      (await w.client.call("agents", "direct", { agentId: ada.id })) as {
        conversation: ConversationSummary;
      }
    ).conversation;
    await w.watch(chat.id);
    await w.watch(group.id);

    // Ada is in the middle of an answer when she goes.
    const sent = await w.send(chat.id, "are you there?");
    await until(() => requests.length === 1);
    await w.settled(chat.id, sent.replies[0]!.id, ["working"]);

    await w.client.call("agents", "delete", { agentId: ada.id });

    expect(await exists(join(ada.home, "notes.md"))).toBe(true);
    await until(
      () =>
        w.client
          .section<AgentView[]>("agents", "list")
          ?.every((entry) => entry.id !== ada.id) === true,
    );
    const projects = w.client.section<ProjectView[]>("projects", "list")!;
    expect(projects.find((p) => p.id === project.id)?.stewardId).toBeNull();
    // Her workspace is put away, not forgotten.
    expect(projects.find((p) => p.id === ada.homeProjectId)?.archived).toBe(
      true,
    );
    const conversations = w.client.section<ConversationSummary[]>(
      "conversations",
      "list",
    )!;
    expect(conversations.find((c) => c.id === chat.id)?.archived).toBe(true);
    const plans = conversations.find((c) => c.id === group.id)!;
    expect(plans.participants.map((m) => m.agentId)).toEqual([bob.id]);
    expect(plans.stewardId).toBeNull();
    // The reply she was writing ended; it did not stay "working" for ever.
    const ended = await w.settled(chat.id, sent.replies[0]!.id);
    expect(ended.status).toBe("stopped");
    await expect(
      w.client.call("agents", "delete", { agentId: ada.id }),
    ).rejects.toThrow(/no such agent/);
  });
});
