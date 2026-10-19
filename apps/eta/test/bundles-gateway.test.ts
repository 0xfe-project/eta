/* eslint-disable no-template-curly-in-string -- `${NAME}` is the bundle format's own variable syntax */
import process from "node:process";
/**
 * A bundle's MCP servers reach the LLM gateway with the agent's own key: `${ETA_GATEWAY_URL}` and
 * `${ETA_AGENT_KEY}` resolve for a session on the host (the loopback gateway) and on a daemon
 * (the primary's `/llm` route, which forwards to `/v1` for that key and for nothing else), and
 * the key ends with the agent.
 *
 * The gateway is the real native library, so this file has one host.
 */
import { cpaExtraFor, fakeUpstream } from "@eta/llm-gateway/testing";
import { describe, expect, it } from "vitest";
import { digestOf, FAKE_MCP, writeBundle } from "./support/bundles";
import { tempDir } from "./support/host";
import { call, say, scriptedModels } from "./support/models";
import { remoteWorld } from "./support/remote";

const files = (): Record<string, string> => ({
  "plugin.json": JSON.stringify({ name: "gw", version: "1.0.0" }),
  "mcp.json": JSON.stringify({
    mcpServers: {
      fake: {
        command: process.execPath,
        args: [FAKE_MCP],
        env: { GW_URL: "${ETA_GATEWAY_URL}", GW_KEY: "${ETA_AGENT_KEY}" },
      },
    },
  }),
});

describe("a bundle's tools and the LLM gateway", () => {
  it("get the agent's key and the gateway's address on the host and on a daemon, and the key stops with the agent", async () => {
    const upstream = fakeUpstream();
    try {
      const home = await tempDir("eta-home-");
      await writeBundle(home, "gw", files());
      const asked = ["GW_URL", "GW_KEY"];
      const { models, requests } = scriptedModels((request) => {
        const results = request.transcript.filter((line) =>
          line.startsWith("toolResult"),
        ).length;
        return results < asked.length
          ? call("mcp", {
              tool: "env",
              server: "fake",
              args: { name: asked[results] },
            })
          : say("finished");
      });
      const r = await remoteWorld({
        dataDir: home,
        models,
        llm: { cpaExtra: cpaExtraFor(upstream) },
      });
      const llm = r.host.llm!;
      const run = async (
        agent: { id: string },
        projectId: string,
      ): Promise<string> => {
        const group = await r.group(projectId, [agent.id]);
        await r.watch(group.id);
        const sent = await r.send(group.id, "go");
        const done = await r.settled(group.id, sent.replies[0]!.id);
        expect(done.text).toBe("finished");
        return requests.at(-1)!.transcript.join("\n");
      };

      // On the host's machine: the loopback gateway, with the agent's key.
      const local = await r.agent("Ada", { bundles: ["gw"] });
      const here = await r.project();
      const onHost = await run(local, here.id);
      expect(onHost).toContain(digestOf(llm.origin));
      expect(onHost).toContain(digestOf(llm.scopedKey(local.id)));

      // On a daemon: loopback is not reachable, so the primary's own route.
      const away = await r.agent("Bo", { bundles: ["gw"] });
      const route = `http://127.0.0.1:${r.host.port}/llm`;
      const onDaemon = await run(away, r.remoteProject.id);
      expect(onDaemon).toContain(digestOf(route));
      expect(onDaemon).toContain(digestOf(llm.scopedKey(away.id)));
      expect(llm.scopedKey(away.id)).not.toBe(llm.scopedKey(local.id));

      // The route forwards `/v1` for the agent's key.
      const models1 = `${route}/v1/models`;
      const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
      const key = llm.scopedKey(away.id);
      const served = await fetch(models1, { headers: bearer(key) });
      expect(served.status).toBe(200);
      expect(JSON.stringify(await served.json())).toContain("gpt-test");
      // ... and for nothing else: no key, a wrong one, the host's own, another path.
      for (const headers of [
        {},
        bearer("etak.nobody.0000"),
        bearer(`${llm.scopedKey(away.id).slice(0, -1)}0`),
        bearer("a-key-that-is-not-an-agent-key"),
      ])
        expect((await fetch(models1, { headers })).status).toBe(401);
      for (const path of ["/api/llm/v1/models", "/v1x/models", "/v2/models"])
        expect(
          (await fetch(`${route}${path}`, { headers: bearer(key) })).status,
        ).toBe(401);

      // The key ends with the agent; another agent's key does not.
      await r.client.call("agents", "delete", { agentId: away.id });
      await until401(models1, bearer(key));
      expect(
        (
          await fetch(`${llm.origin}/v1/models`, {
            headers: bearer(llm.scopedKey(local.id)),
          })
        ).status,
      ).toBe(200);
    } finally {
      upstream.stop();
    }
  }, 120_000);
});

/** Revocation goes to the gateway after the agent's row; wait for it. */
async function until401(
  url: string,
  headers: Record<string, string>,
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await fetch(url, { headers })).status === 401) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("the key still works");
}
