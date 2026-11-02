/**
 * Agents on an external runtime (Claude Code, Codex, ...), through a real socket, with oar's
 * scripted runtime standing in for the binary.
 *
 * What these pin: an agent names its runtime and a model in that runtime's names, and nothing
 * else; the editor can ask what the machine has; a conversation with such an agent is answered by
 * the runtime, tool calls included, and never by eta's own models; an edit of the model reaches
 * the runtime; and an agent moved to another runtime starts its conversations over.
 */
import type { ScriptedTurn } from "@botiverse/oar/testing";
import type {
  AgentRuntimeInfo,
  AgentView,
  ToolActivity,
} from "@eta/client-contracts";
import type { World } from "./support/world";
import { createRuntimeRegistry } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { createOarRuntimes } from "@eta/runtime-oar";
import { describe, expect, it } from "vitest";
import { scriptedModels } from "./support/models";
import { world } from "./support/world";

/** A host whose Claude Code is a script, and whose eta models must never be asked. */
async function onClaude(
  turn: (turn: ScriptedTurn) => void | Promise<void>,
): Promise<{ w: World; turns: ScriptedTurn[]; etaRequests: unknown[] }> {
  const turns: ScriptedTurn[] = [];
  const { models, requests } = scriptedModels(() => {
    throw new Error("an eta model was asked");
  });
  const w = await world({
    models,
    runtimes: createOarRuntimes({
      registry: createRuntimeRegistry([
        scriptedRuntime({
          id: "claude",
          turn: async (scripted) => {
            turns.push(scripted);
            await turn(scripted);
          },
        }),
      ]),
    }),
  });
  return { w, turns, etaRequests: requests };
}

async function direct(w: World, agent: AgentView) {
  const { conversation } = (await w.client.call("agents", "direct", {
    agentId: agent.id,
  })) as { conversation: { id: string } };
  await w.watch(conversation.id);
  return conversation.id;
}

describe("an agent's runtime", () => {
  it("is eta unless named, and takes only its own models", async () => {
    const { w } = await onClaude(() => undefined);
    expect(await w.agent("Ada")).toMatchObject({ runtime: "eta" });
    expect(
      await w.agent("Cody", { runtime: "claude", model: "claude:sonnet" }),
    ).toMatchObject({ runtime: "claude", model: "claude:sonnet" });
    expect(await w.agent("Def", { runtime: "claude" })).toMatchObject({
      runtime: "claude",
      model: null,
    });
    await expect(
      w.agent("Bad", { runtime: "claude", model: "anthropic:claude" }),
    ).rejects.toThrow(/claude:<model>/);
    await expect(w.agent("Bad", { runtime: "nope" as never })).rejects.toThrow(
      /unknown runtime/,
    );
  });

  it("moving to another runtime clears a model that named the old one", async () => {
    const { w } = await onClaude(() => undefined);
    const agent = await w.agent("Ada", { model: "fake:model" });
    const { agent: moved } = (await w.client.call("agents", "update", {
      agentId: agent.id,
      runtime: "claude",
    })) as { agent: AgentView };
    expect(moved).toMatchObject({ runtime: "claude", model: null });
  });

  it("lists what the machine has, for the editor", async () => {
    const { w } = await onClaude(() => undefined);
    const { runtimes } = (await w.client.call("agents", "runtimes", {})) as {
      runtimes: AgentRuntimeInfo[];
    };
    expect(runtimes.map((runtime) => runtime.id)).toEqual([
      "claude",
      "codex",
      "opencode",
      "pi",
    ]);
    // The scripted one is there; the others are not in this registry at all.
    expect(runtimes[0]).toMatchObject({
      label: "Claude Code",
      status: "available",
    });
    expect(
      runtimes.slice(1).every((runtime) => runtime.status === "error"),
    ).toBe(true);
  });
});

describe("a conversation with an agent on Claude Code", () => {
  it("is answered by the runtime, with its tool calls, and never by eta's models", async () => {
    const { w, turns, etaRequests } = await onClaude(async (turn) => {
      turn.say("Let me look. ");
      await turn.tool("Bash", '{"command":"ls"}', () => "README.md");
      turn.say("There is a README.");
    });
    const agent = await w.agent("Cody", {
      runtime: "claude",
      model: "claude:sonnet",
      instructions: "Be terse.",
    });
    const chat = await direct(w, agent);
    const sent = await w.send(chat, "what is here?");
    const done = await w.settled(chat, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(done.text).toBe("There is a README.");
    expect(
      ((done.data as { activity?: ToolActivity[] }).activity ?? []).map(
        (entry) => entry.name,
      ),
    ).toEqual(["Bash"]);
    expect(turns[0]!.input).toContain("what is here?");
    expect(turns[0]!.options.model).toBe("sonnet");
    expect(turns[0]!.options.appendSystemPrompt).toContain("Be terse.");
    expect(etaRequests).toEqual([]);
  });

  it("an edit of the agent's model reaches the runtime", async () => {
    const { w, turns } = await onClaude((turn) => turn.say("ok"));
    const agent = await w.agent("Cody", {
      runtime: "claude",
      model: "claude:sonnet",
    });
    const chat = await direct(w, agent);
    await w.settled(chat, (await w.send(chat, "one")).replies[0]!.id);
    await w.client.call("agents", "update", {
      agentId: agent.id,
      model: "claude:opus",
    });
    await w.settled(chat, (await w.send(chat, "two")).replies[0]!.id);
    expect(turns.map((turn) => turn.options.model)).toEqual(["sonnet", "opus"]);
    // The same runtime conversation, on the new model.
    expect(turns[1]!.options.resume).toBeDefined();
  });

  it("an agent moved off eta answers on the runtime from the next message", async () => {
    const { w, turns } = await onClaude((turn) => turn.say("from claude"));
    const agent = await w.agent("Ada", { model: "fake:model" });
    const chat = await direct(w, agent);
    await w
      .settled(chat, (await w.send(chat, "one")).replies[0]!.id)
      .catch(() => undefined);
    await w.client.call("agents", "update", {
      agentId: agent.id,
      runtime: "claude",
    });
    const done = await w.settled(
      chat,
      (await w.send(chat, "two")).replies[0]!.id,
    );
    expect(done.text).toBe("from claude");
    expect(turns).toHaveLength(1);
    // A new runtime conversation: nothing to resume.
    expect(turns[0]!.options.resume).toBeUndefined();
  });
});
