/**
 * The session behind a member: made at its first wake, in the project's directory, as the agent
 * is configured, and brought in line when the agent is edited.
 */
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { say, scriptedModels } from "./support/models";
import { world } from "./support/world";

describe("an agent's session in a conversation", () => {
  it("is made at the first wake, where the project is, as the agent is", async () => {
    const { models, requests } = scriptedModels((request) =>
      say(`${request.agent} here`),
    );
    const w = await world({ models });
    const ada = await w.agent("Ada", {
      instructions: "Always answer in haiku.",
      model: "fake:smart",
      persona: "Executor",
      thinkingLevel: "low",
    });
    const project = await w.project({ stewardId: ada.id, name: "the repo" });
    const group = await w.group(project.id, [ada.id], "plans");
    await w.watch(group.id);
    // Nothing is made until somebody is woken.
    expect(await w.host.server.sessions.list()).toHaveLength(0);

    const sent = await w.send(group.id, "hello");
    await w.settled(group.id, sent.replies[0]!.id);

    const [listing] = await w.host.server.sessions.list();
    expect(listing?.ok).toBe(true);
    const meta = listing?.ok === true ? listing.meta : undefined;
    expect(meta).toMatchObject({
      cwd: project.path,
      agentId: ada.id,
      conversationId: group.id,
      model: "fake:smart",
      persona: "Executor",
      title: "plans · Ada",
    });
    const open = w.host.server.sessions.openSessions()[0]!;
    expect(open.session.kernel.config.read("thinkingLevel")).toBe("low");
    expect(open.session.kernel.inspect().activePersonaNames).toContain(
      "Executor",
    );

    // The agent's words are in the platform section, after the harness's own base.
    const system = requests[0]!.system;
    expect(system).toContain("Always answer in haiku.");
    expect(system).toContain("<agent>\nIn this conversation you are Ada.");
    expect(system.indexOf("You came here to help")).toBeLessThan(
      system.indexOf("In this conversation you are Ada."),
    );
    expect(system).not.toContain("You are Eta");
  });

  it("is one per agent and conversation: another conversation is another session", async () => {
    const { models } = scriptedModels((request) =>
      say(`${request.agent} here`),
    );
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const one = await w.group(project.id, [ada.id]);
    const two = await w.group(project.id, [ada.id]);
    await w.watch(one.id);
    await w.watch(two.id);
    const first = await w.send(one.id, "a");
    await w.settled(one.id, first.replies[0]!.id);
    const again = await w.send(one.id, "b");
    await w.settled(one.id, again.replies[0]!.id);
    const other = await w.send(two.id, "c");
    await w.settled(two.id, other.replies[0]!.id);

    const sessionOf = (id: string) =>
      w.client.section<{ sessionId: string }[]>(
        `conversations.${id}`,
        "members",
      )![0]!.sessionId;
    expect(sessionOf(one.id)).not.toBe(sessionOf(two.id));
    expect(await w.host.server.sessions.list()).toHaveLength(2);
  });

  it("follows the agent when it is edited: instructions, persona, model and thinking", async () => {
    const { models, requests } = scriptedModels((request) =>
      say(`${request.agent} here`),
    );
    const w = await world({ models });
    const ada = await w.agent("Ada", {
      instructions: "Be brief.",
      model: "fake:first",
    });
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id]);
    await w.watch(group.id);
    const talk = async (text: string) => {
      const sent = await w.send(group.id, text);
      await w.settled(group.id, sent.replies[0]!.id);
    };
    await talk("one");
    expect(requests[0]!.system).toContain("Be brief.");
    const sessionId = w.client.section<{ sessionId: string }[]>(
      `conversations.${group.id}`,
      "members",
    )![0]!.sessionId;
    const modelOf = () =>
      w.host.server.sessions
        .openSessions()
        .find((open) => open.meta.id === sessionId)
        ?.session.kernel.config.read("model");
    expect(modelOf()).toEqual({ provider: "fake", modelId: "first" });

    await w.client.call("agents", "update", {
      agentId: ada.id,
      instructions: "Be thorough.",
      persona: "Executor",
      model: "fake:second",
      thinkingLevel: "high",
    });
    await talk("two");

    // The same session, reopened: its journal is the one it had.
    expect(
      w.client.section<{ sessionId: string }[]>(
        `conversations.${group.id}`,
        "members",
      )![0]!.sessionId,
    ).toBe(sessionId);
    const system = requests[1]!.system;
    expect(system).toContain("Be thorough.");
    expect(system).not.toContain("Be brief.");
    expect(requests[1]!.transcript.join("\n")).toContain("one");
    expect(modelOf()).toEqual({ provider: "fake", modelId: "second" });
    const open = w.host.server.sessions
      .openSessions()
      .find((entry) => entry.meta.id === sessionId)!;
    expect(open.session.kernel.config.read("thinkingLevel")).toBe("high");
    expect(open.session.kernel.inspect().activePersonaNames).toContain(
      "Executor",
    );
    await until(() => w.rows(group.id).length === 4);
  });

  it("keeps what the user chose on the session across wakes, until the agent is edited", async () => {
    const { models } = scriptedModels(() => say("ok"));
    const w = await world({ models });
    const ada = await w.agent("Ada", {
      model: "fake:first",
      thinkingLevel: "low",
    });
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id]);
    await w.watch(group.id);
    const talk = async (text: string) => {
      const sent = await w.send(group.id, text);
      await w.settled(group.id, sent.replies[0]!.id);
    };
    await talk("one");
    const sessionId = w.client.section<{ sessionId: string }[]>(
      `conversations.${group.id}`,
      "members",
    )![0]!.sessionId;
    const config = () =>
      w.host.server.sessions
        .openSessions()
        .find((open) => open.meta.id === sessionId)!.session.kernel.config;
    expect(config().read("thinkingLevel")).toBe("low");

    // Changed on the session itself, as an agent edit pushes.
    await w.client.call("sessions", "modelSet", {
      session: sessionId,
      model: "fake:chosen",
    });
    await w.client.call("sessions", "thinkingLevel", {
      session: sessionId,
      level: "high",
    });
    await talk("two");
    expect(config().read("model")).toEqual({
      provider: "fake",
      modelId: "chosen",
    });
    expect(config().read("thinkingLevel")).toBe("high");

    // Editing something else leaves them alone; editing the model or level overrides.
    await w.client.call("agents", "update", {
      agentId: ada.id,
      name: "Ada L.",
    });
    expect(config().read("model")).toEqual({
      provider: "fake",
      modelId: "chosen",
    });
    await w.client.call("agents", "update", {
      agentId: ada.id,
      model: "fake:second",
      thinkingLevel: "medium",
    });
    expect(config().read("model")).toEqual({
      provider: "fake",
      modelId: "second",
    });
    expect(config().read("thinkingLevel")).toBe("medium");
  });
});
