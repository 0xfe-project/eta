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
import { call, say, scriptedModels } from "./support/models";
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
  it("is among the tools of an agent on eta's own loop, which can call it", async () => {
    const offered: string[][] = [];
    let answer = "";
    const { models } = scriptedModels((request) => {
      offered.push(request.tools);
      if (request.lastRole === "toolResult") {
        answer = request.last;
        return say("done");
      }
      return call("list_toolkits", {});
    });
    const w = await world({ models });
    await ask(w, await w.agent("Ada"), "which toolkits do I have?");
    expect(offered[0]).toContain("list_toolkits");
    expect(JSON.parse(answer)).toMatchObject({ toolkits: [] });
  });

  it("is in the tool list of eta's MCP server for an agent on an external runtime, and can be called", async () => {
    let listed: { name: string; inputSchema: unknown }[] = [];
    let answer: { content: { text: string }[]; isError?: boolean } | undefined;
    const w = await world({
      runtimes: createOarRuntimes({
        registry: createRuntimeRegistry([
          scriptedRuntime({
            id: "claude",
            turn: async (turn) => {
              listed = (
                (await rpc(turn, "tools/list", {})) as { tools: typeof listed }
              ).tools;
              answer = await rpc(turn, "tools/call", {
                name: "list_toolkits",
                arguments: {},
              });
              turn.say("ok");
            },
          }),
        ]),
      }),
    });
    await ask(w, await w.agent("Cody", { runtime: "claude" }), "hi");
    const tool = listed.find((one) => one.name === "list_toolkits");
    expect(tool?.name).toBe("list_toolkits");
    expect(JSON.stringify(tool!.inputSchema).length).toBeLessThan(1024);
    expect(answer?.isError).toBeFalsy();
    expect(JSON.parse(answer!.content[0]!.text)).toMatchObject({
      toolkits: [],
    });
  });
});
