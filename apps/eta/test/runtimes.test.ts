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
  ArtifactView,
  ToolActivity,
} from "@eta/client-contracts";
import type { World } from "./support/world";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRuntimeRegistry } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { createOarRuntimes } from "@eta/runtime-oar";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
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

/** Call one of eta's tools the way Claude Code does: over the MCP server the session was given. */
async function callHostTool(
  turn: ScriptedTurn,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const server = turn.options.mcpServers?.find((entry) => entry.name === "eta");
  if (server === undefined || !("url" in server))
    throw new Error("the session was not given eta's tools");
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      ...server.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const reply = (await response.json()) as {
    result?: { content: { text?: string }[]; isError?: boolean };
    error?: { message: string };
  };
  if (reply.result === undefined)
    throw new Error(reply.error?.message ?? "no result");
  return {
    text: reply.result.content.map((part) => part.text ?? "").join(""),
    isError: reply.result.isError === true,
  };
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

describe("eta's tools, called by an agent on Claude Code", () => {
  it("publish_artifact reads the project's directory on eta's side and publishes it", async () => {
    const results: { text: string; isError: boolean }[] = [];
    const { w } = await onClaude(async (turn) => {
      await turn.tool("mcp__eta__publish_artifact", "{}", async () => {
        const result = await callHostTool(turn, "publish_artifact", {
          path: "site",
          title: "Page",
        });
        results.push(result);
        return result.text;
      });
      turn.say("published");
    });
    const agent = await w.agent("Cody", {
      runtime: "claude",
      model: "claude:sonnet",
    });
    const project = await w.project({ stewardId: agent.id });
    await mkdir(join(project.path, "site"), { recursive: true });
    await writeFile(join(project.path, "site", "index.html"), "<h1>hi</h1>");
    const group = await w.group(project.id, [agent.id]);
    await w.watch(group.id);
    w.client.subscribe("artifacts");
    const sent = await w.send(group.id, "publish the site", {
      mentions: [agent.id],
    });
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: false });
    expect(results[0]!.text).toContain('Published "Page" version 1 (1 files)');

    const artifacts = () =>
      w.client.section<ArtifactView[]>("artifacts", "list") ?? [];
    await until(() => artifacts().length === 1);
    expect(artifacts()[0]).toMatchObject({
      title: "Page",
      publisherAgentId: agent.id,
    });
    const id = artifacts()[0]!.id;
    expect(
      await readFile(
        join(w.host.dataDir, "artifacts", id, "1", "files", "index.html"),
        "utf8",
      ),
    ).toBe("<h1>hi</h1>");
  });
});
