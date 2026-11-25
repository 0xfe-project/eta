/**
 * `list_toolkits` among eta's own tools: it is listed for an agent on eta's own loop and, over
 * eta's MCP server, for an agent on an external runtime. Scripted models and a scripted runtime
 * only; no Composio account and no real agent. What the tool answers for an agent that has
 * toolkits is in `composio-sessions.test.ts`, against a local fake of Composio.
 */
import type { ScriptedTurn } from "@botiverse/oar/testing";
import type { AgentView } from "@eta/client-contracts";
import type { World } from "./support/world";
import { createRuntimeRegistry } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { createOarRuntimes } from "@eta/runtime-oar";
import { describe, expect, it } from "vitest";
import { say, scriptedModels } from "./support/models";
import { world } from "./support/world";

/** A group of the agent alone, a message to it, and the end of its reply. */
async function ask(w: World, agent: AgentView, text: string): Promise<void> {
  const chat = await w.group(agent.homeProjectId, [agent.id], agent.name);
  await w.watch(chat.id);
  const sent = await w.send(chat.id, text);
  await w.settled(chat.id, sent.replies[0]!.id);
}

/** One request to eta's MCP server, from inside a turn of the external runtime. */
async function rpc(
  turn: ScriptedTurn,
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
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
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return ((await response.json()) as { result: unknown }).result;
}

describe("list_toolkits", () => {
  it("is not among the tools of an agent on eta's own loop that has no Composio toolkit, which keeps get_plugin_config", async () => {
    const offered: string[][] = [];
    const { models } = scriptedModels((request) => {
      offered.push(request.tools);
      return say("done");
    });
    const w = await world({ models });
    await ask(w, await w.agent("Ada"), "which toolkits do I have?");
    expect(offered[0]).toContain("get_plugin_config");
    expect(offered[0]).not.toContain("list_toolkits");
  });

  it("is not in the tool list of eta's MCP server for an agent on an external runtime that has no Composio toolkit", async () => {
    let listed: string[] = [];
    const w = await world({
      runtimes: createOarRuntimes({
        registry: createRuntimeRegistry([
          scriptedRuntime({
            id: "claude",
            turn: async (turn) => {
              const result = (await rpc(turn, "tools/list", {})) as {
                tools: { name: string }[];
              };
              listed = result.tools.map((one) => one.name);
              turn.say("ok");
            },
          }),
        ]),
      }),
    });
    await ask(w, await w.agent("Cody", { runtime: "claude" }), "hi");
    expect(listed).toContain("get_plugin_config");
    expect(listed).not.toContain("list_toolkits");
  });
});
