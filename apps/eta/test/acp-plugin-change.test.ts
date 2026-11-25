/**
 * An agent on an ACP runtime whose plugin list changes while a conversation is open: through the
 * real host (engine, plugin service, session manager) and the fake ACP agent as a real stdio child.
 *
 * What these pin: enabling a second plugin changes the agent's stamp, so the conversation's session
 * is closed and opened again at the next message, and the agent's new process is sent the list as it
 * is then (`session/resume` or `session/load` where the agent has them, `session/new` where it has
 * neither). What the fake cannot say: whether a real agent adopts the servers of that request.
 */
import type { AgentView } from "@eta/client-contracts";
import type { World } from "./support/world";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeAgent } from "@eta/runtime-acp/testing";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { scriptedModels } from "./support/models";
import { world } from "./support/world";

/** A Claude Code plugin with one HTTP server, as firecrawl ships its own. */
async function install(dataDir: string, name: string, url: string) {
  const dir = join(dataDir, "plugins", name);
  await mkdir(join(dir, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, description: `The ${name} plugin` }),
  );
  await writeFile(
    join(dir, ".mcp.json"),
    JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }),
  );
}

async function enable(w: World, agent: AgentView, plugins: string[]) {
  await w.client.call("agents", "update", { agentId: agent.id, plugins });
}

describe("a plugin enabled for an ACP agent while its conversation is open", () => {
  it.each(["resume", "load", "none"])(
    "closes the session and sends the new list to the agent's next process (agent takes %s)",
    async (caps) => {
      const dataDir = await tempDir();
      await install(dataDir, "alpha", "https://alpha.example.invalid/mcp");
      await install(dataDir, "beta", "https://beta.example.invalid/mcp");
      const { models } = scriptedModels(() => {
        throw new Error("an eta model was asked");
      });
      const w = await world({ models, dataDir });
      w.client.subscribe("plugins");
      await until(
        () =>
          (w.client.section<unknown[]>("plugins", "list") ?? []).length === 2,
      );
      const fake = fakeAgent("fake", { env: { FAKE_ACP_CAPS: caps } });
      w.client.subscribe("acp");
      await w.client.call("acp", "save", { agent: fake.config });
      // The catalog looks at a saved agent once (it opens a session of its own to learn its models):
      // what that sent is not a conversation's.
      await until(() =>
        JSON.stringify(w.client.section("acp", "machines") ?? "").includes(
          '"version":"0.0.1"',
        ),
      );
      const probed = fake.log().length;
      const agent = await w.agent("Ace", { runtime: "acp.fake" });
      const conversation = await w.group(
        agent.homeProjectId,
        [agent.id],
        "Ace",
      );
      await w.watch(conversation.id);
      const ask = async (text: string) => {
        const sent = await w.send(conversation.id, text);
        return await w.settled(conversation.id, sent.replies[0]!.id);
      };
      const opens = () =>
        fake
          .log()
          .slice(probed)
          .filter((entry) =>
            /^session\/(?:new|resume|load)$/.test(entry.method),
          )
          .map((entry) => ({
            method: entry.method,
            pid: entry.pid,
            // The host's own server (`eta`) is not what a plugin brings.
            plugins: (entry.mcpServers as { name: string }[])
              .map((server) => server.name)
              .filter((name) => name !== "eta"),
          }));

      await enable(w, agent, ["alpha"]);
      expect((await ask("one")).status).toBe("done");
      expect(opens().map(({ method, plugins }) => [method, plugins])).toEqual([
        ["session/new", ["alpha-alpha"]],
      ]);

      await enable(w, agent, ["alpha", "beta"]);
      const state = await ask("state");
      expect(state.status).toBe("done");

      const second = opens();
      expect(second.map(({ method, plugins }) => [method, plugins])).toEqual([
        ["session/new", ["alpha-alpha"]],
        [
          caps === "none" ? "session/new" : `session/${caps}`,
          ["alpha-alpha", "beta-beta"],
        ],
      ]);
      // The plugin's server went in as its address alone: no header, so no token.
      const sent = fake
        .log()
        .slice(probed)
        .filter((entry) => /^session\/(?:new|resume|load)$/.test(entry.method))
        .at(-1)!.mcpServers as Record<string, unknown>[];
      expect(sent.find((server) => server.name === "beta-beta")).toEqual({
        type: "http",
        name: "beta-beta",
        url: "https://beta.example.invalid/mcp",
        headers: [],
      });
      // The old session was closed, and the new list went to another process.
      expect(
        fake
          .log()
          .slice(probed)
          .filter((entry) => entry.method === "session/close"),
      ).not.toHaveLength(0);
      expect(second[1]!.pid).not.toBe(second[0]!.pid);
      // Where the agent could pick the session up, it is the same one that heard "one".
      expect(JSON.parse(state.text)).toMatchObject({
        prompts: caps === "none" ? 1 : 2,
      });
    },
    30_000,
  );
});
