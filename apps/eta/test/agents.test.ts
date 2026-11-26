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
import { gate, HANG, say, scriptedModels } from "./support/models";
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
      ownerAgentId: agent.id,
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

  it("edits an agent in place, and the workspace's name follows a rename", async () => {
    const w = await world();
    const agent = await w.agent("Ada");

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
    // A level the model takes is kept; `ultra` is one only a model that names it takes.
    const high = (await w.client.call("agents", "update", {
      agentId: agent.id,
      thinkingLevel: "high",
    })) as { agent: AgentView };
    expect(high.agent.thinkingLevel).toBe("high");
    await expect(
      w.client.call("agents", "update", {
        agentId: agent.id,
        thinkingLevel: "ultra",
      }),
    ).rejects.toThrow(/fake:other does not take thinking level ultra/);
    // A field that was not sent stays, and `null` clears one.
    const cleared = (await w.client.call("agents", "update", {
      agentId: agent.id,
      thinkingLevel: null,
    })) as { agent: AgentView };
    expect(cleared.agent).toMatchObject({
      name: "Ada Lovelace",
      model: "fake:other",
      thinkingLevel: null,
    });

    await until(
      () =>
        w.client
          .section<ProjectView[]>("projects", "list")
          ?.find((project) => project.id === agent.homeProjectId)?.name ===
        "Ada Lovelace",
    );
    await expect(
      w.client.call("agents", "update", { agentId: "nobody", name: "x" }),
    ).rejects.toThrow(/no such agent/);
  });
});

describe("an agent's thinking level against what its model declares", () => {
  /** `fake:flash` declares high and max (#799's endpoint model); `fake:silent` says nothing. */
  const declaring = () => {
    const { models } = scriptedModels(() => say("ok"));
    return {
      models: {
        ...models,
        getModel(provider: string, id: string) {
          const model = models.getModel(provider, id);
          if (model === undefined) return undefined;
          if (id === "silent") return { ...model, id, reasoning: false };
          if (id !== "flash") return { ...model, id };
          return {
            ...model,
            id,
            thinkingLevelMap: {
              off: null,
              minimal: null,
              low: null,
              medium: null,
              high: "high",
              xhigh: null,
              max: "max",
            },
          };
        },
      } satisfies typeof models,
    };
  };

  it("refuses a level the model does not declare, naming the ones it does", async () => {
    const w = await world(declaring());
    await expect(
      w.agent("Ada", { model: "fake:flash", thinkingLevel: "ultra" }),
    ).rejects.toThrow(
      /fake:flash does not take thinking level ultra; it takes high, max/,
    );
    await expect(
      w.agent("Ada", { model: "fake:silent", thinkingLevel: "high" }),
    ).rejects.toThrow(/it takes off/);
    const agent = await w.agent("Ada", {
      model: "fake:flash",
      thinkingLevel: "max",
    });
    expect(agent.thinkingLevel).toBe("max");
  });

  it("clears a level the new model does not take, and says so", async () => {
    const w = await world(declaring());
    const agent = await w.agent("Ada", {
      model: "fake:other",
      thinkingLevel: "low",
    });
    const moved = (await w.client.call("agents", "update", {
      agentId: agent.id,
      model: "fake:flash",
    })) as { agent: AgentView; thinkingCleared?: string };
    expect(moved.agent.thinkingLevel).toBeNull();
    expect(moved.thinkingCleared).toBe("low");
    // One the new model takes stays, and nothing is said.
    await w.client.call("agents", "update", {
      agentId: agent.id,
      thinkingLevel: "high",
    });
    const kept = (await w.client.call("agents", "update", {
      agentId: agent.id,
      model: "fake:other",
    })) as { agent: AgentView; thinkingCleared?: string };
    expect(kept.agent.thinkingLevel).toBe("high");
    expect(kept.thinkingCleared).toBeUndefined();
  });
});

describe("editing the model while a session is running", () => {
  it.each(["next wake", "host restart"])(
    "uses the saved model after %s",
    async (when) => {
      const active = gate();
      const used: string[] = [];
      const { models, requests } = scriptedModels(async ({ index }) => {
        if (index === 0) await active.opened;
        return say("done");
      });
      const options = {
        models: {
          ...models,
          getModel(provider, id) {
            const model = models.getModel(provider, id);
            return model === undefined ? undefined : { ...model, id };
          },
          streamSimple(model, context, options) {
            used.push(model.id);
            return models.streamSimple(model, context, options);
          },
        } satisfies typeof models,
      };
      const first = await world(options);
      const agent = await first.agent("Ada", { model: "fake:old" });
      const project = await first.project();
      const group = await first.group(project.id, [agent.id]);
      await first.watch(group.id);
      const initial = await first.send(group.id, "first");
      try {
        await until(() => requests.length === 1);
        await first.client.call("agents", "update", {
          agentId: agent.id,
          model: "fake:intermediate",
          thinkingLevel: "high",
        });
        await first.client.call("agents", "update", {
          agentId: agent.id,
          model: "fake:new",
        });
      } finally {
        active.open();
      }
      expect(
        (await first.settled(group.id, initial.replies[0]!.id)).status,
      ).toBe("done");
      const sessionOf = (w: typeof first) =>
        w.client.section<{ sessionId: string | null }[]>(
          `conversations.${group.id}`,
          "members",
        )?.[0]?.sessionId;
      await until(() => Boolean(sessionOf(first)));
      const session = sessionOf(first)!;

      let w = first;
      if (when === "host restart") {
        await first.host.close();
        w = await world({ ...options, dataDir: first.host.dataDir });
        await w.watch(group.id);
      }
      const next = await w.send(group.id, "second");
      expect((await w.settled(group.id, next.replies[0]!.id)).status).toBe(
        "done",
      );
      expect(used).toEqual(["old", "new"]);
      expect(sessionOf(w)).toBe(session);
      const live = w.host.server.sessions
        .openSessions()
        .find((entry) => entry.meta.id === session);
      expect(live?.session.kernel.config.read("thinkingAsked")).toBe("high");

      await w.client.call("sessions", "modelSet", {
        session,
        model: "fake:chosen",
      });
      const last = await w.send(group.id, "third");
      expect((await w.settled(group.id, last.replies[0]!.id)).status).toBe(
        "done",
      );
      expect(used).toEqual(["old", "new", "chosen"]);
    },
  );
});

describe("an agent alone in a group", () => {
  it("answers: queued, then working, then done with the model's words", async () => {
    const turn = Promise.withResolvers<void>();
    const { models } = scriptedModels(async () => {
      await turn.promise;
      return say("Hello, I am Ada.", "The user greets me.");
    });
    const w = await world({ models });
    const agent = await w.agent("Ada");
    const conversation = await w.group(agent.homeProjectId, [agent.id]);
    await w.watch(conversation.id);

    const sent = await w.send(conversation.id, "Hi Ada");
    // A message that names nobody is the steward's: the agent's, alone in its group.
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
});

describe("deleting an agent", () => {
  it("clears it as steward and member, stops what it was saying, and keeps its directory", async () => {
    const { models, requests } = scriptedModels(() => HANG);
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const bob = await w.agent("Bob");
    await writeFile(join(ada.home, "notes.md"), "kept");
    const project = await w.project();
    const group = await w.group(project.id, [ada.id, bob.id], "plans");
    const chat = await w.group(ada.homeProjectId, [ada.id], "Ada");
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
    // Her workspace is put away, not forgotten.
    expect(projects.find((p) => p.id === ada.homeProjectId)?.archived).toBe(
      true,
    );
    const conversations = w.client.section<ConversationSummary[]>(
      "conversations",
      "list",
    )!;
    expect(conversations.find((c) => c.id === chat.id)?.participants).toEqual(
      [],
    );
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

describe("an agent's model", () => {
  it("is required on eta's own loop: create and update refuse none, and other edits are not held up", async () => {
    const w = await world();
    for (const model of [undefined, null, ""])
      await expect(
        w.client.call("agents", "create", {
          name: "Ada",
          ...(model === undefined ? {} : { model }),
        }),
      ).rejects.toThrow(/needs a model/);
    expect(
      (w.client.section<AgentView[]>("agents", "list") ?? []).filter(
        (entry) => entry.name === "Ada",
      ),
    ).toEqual([]);

    const agent = await w.agent("Ada", { model: "fake:fake-model" });
    await expect(
      w.client.call("agents", "update", { agentId: agent.id, model: null }),
    ).rejects.toThrow(/needs a model/);
    await expect(
      w.client.call("agents", "update", { agentId: agent.id, model: "" }),
    ).rejects.toThrow(/needs a model/);

    // An external runtime has a default of its own and requires a pinned machine: none is fine for
    // model there, and moving back to eta requires a model.
    const primaryId = w.host.db
      .query<{ id: string }, []>(
        "SELECT id FROM machine WHERE kind = 'primary'",
      )
      .get()!.id;
    const { agent: moved } = (await w.client.call("agents", "update", {
      agentId: agent.id,
      runtime: "claude",
      machineId: primaryId,
    })) as { agent: AgentView };
    expect(moved).toMatchObject({
      runtime: "claude",
      model: null,
      machineId: primaryId,
    });
    await expect(
      w.client.call("agents", "update", { agentId: agent.id, runtime: "eta" }),
    ).rejects.toThrow(/needs a model/);
    const { agent: back } = (await w.client.call("agents", "update", {
      agentId: agent.id,
      runtime: "eta",
      model: "fake:fake-model",
    })) as { agent: AgentView };
    expect(back).toMatchObject({ runtime: "eta", model: "fake:fake-model" });

    const { agent: cody } = (await w.client.call("agents", "create", {
      name: "Cody",
      runtime: "codex",
      machineId: primaryId,
    })) as { agent: AgentView };
    expect(cody).toMatchObject({
      runtime: "codex",
      model: null,
      machineId: primaryId,
    });
  });

  it("left unset from before: an edit that does not touch it still saves", async () => {
    const w = await world();
    const agent = await w.agent("Ada");
    w.host.db.query("UPDATE agent SET model = NULL WHERE id = ?").run(agent.id);
    const { agent: renamed } = (await w.client.call("agents", "update", {
      agentId: agent.id,
      name: "Ada L",
    })) as { agent: AgentView };
    expect(renamed).toMatchObject({ name: "Ada L", model: null });
  });
});

describe("an agent's avatar", () => {
  const draw = async (
    w: Awaited<ReturnType<typeof world>>,
    agentId: string,
    avatarSeed: string,
  ) =>
    (
      (await w.client.call("agents", "update", {
        agentId,
        avatarSeed,
      })) as { agent: AgentView }
    ).agent;

  it("is drawn from the id until another is drawn, which goes first with the id behind it", async () => {
    const w = await world();
    const agent = await w.agent("Ada");
    expect(agent).toMatchObject({ avatarSeed: null, avatarSeeds: [] });

    const drawn = await draw(w, agent.id, "s1");
    expect(drawn).toMatchObject({
      avatarSeed: "s1",
      avatarSeeds: ["s1", agent.id],
    });
    // Saved, not only answered: the list a client loads has it.
    await until(
      () =>
        w.client
          .section<AgentView[]>("agents", "list")
          ?.find((entry) => entry.id === agent.id)?.avatarSeed === "s1",
    );
  });

  it("keeps each face once, newest first: going back moves it to the front", async () => {
    const w = await world();
    const agent = await w.agent("Ada");
    await draw(w, agent.id, "s1");
    await draw(w, agent.id, "s2");
    expect(await draw(w, agent.id, "s1")).toMatchObject({
      avatarSeed: "s1",
      avatarSeeds: ["s1", "s2", agent.id],
    });
    expect(await draw(w, agent.id, agent.id)).toMatchObject({
      avatarSeed: agent.id,
      avatarSeeds: [agent.id, "s1", "s2"],
    });
  });

  it("keeps the last 8: the oldest are gone from the record", async () => {
    const w = await world();
    const agent = await w.agent("Ada");
    for (let n = 1; n <= 12; n++) await draw(w, agent.id, `s${n}`);
    const seeds = ["s12", "s11", "s10", "s9", "s8", "s7", "s6", "s5"];
    expect(
      w.client
        .section<AgentView[]>("agents", "list")
        ?.find((entry) => entry.id === agent.id),
    ).toMatchObject({ avatarSeed: "s12", avatarSeeds: seeds });
    const row = w.host.db
      .query<{ avatar_seeds: string }, [string]>(
        "SELECT avatar_seeds FROM agent WHERE id = ?",
      )
      .get(agent.id)!;
    expect(JSON.parse(row.avatar_seeds)).toEqual(seeds);
  });

  it("leaves the faces alone on other edits, and refuses a seed that is not a short word", async () => {
    const w = await world();
    const agent = await w.agent("Ada");
    await draw(w, agent.id, "s1");
    const { agent: renamed } = (await w.client.call("agents", "update", {
      agentId: agent.id,
      name: "Ada L",
    })) as { agent: AgentView };
    expect(renamed).toMatchObject({
      avatarSeed: "s1",
      avatarSeeds: ["s1", agent.id],
    });
    for (const seed of ["", "a b", "x".repeat(65), 7])
      await expect(
        w.client.call("agents", "update", {
          agentId: agent.id,
          avatarSeed: seed,
        }),
      ).rejects.toThrow(/avatarSeed/);
  });
});
