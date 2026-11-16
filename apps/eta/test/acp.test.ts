/**
 * ACP agents as runtimes, through a real socket: the `acp` target that edits `acp.json`, and a
 * conversation with an agent on one, answered by the fake ACP agent as a real stdio child.
 *
 * What these pin: saving an agent makes it a runtime the editor lists; an agent on it is answered
 * by the ACP agent, streaming, and can be stopped; `save` / `delete` / `test` hold their contract
 * and refuse what does not hold up; and on a daemon, what runs is what that machine configured.
 */
import type {
  AcpAgentView,
  AcpTestResult,
  AgentRuntimeInfo,
  AgentView,
  ToolActivity,
} from "@eta/client-contracts";
import type { World } from "./support/world";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeAgent } from "@eta/runtime-acp/testing";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { scriptedModels } from "./support/models";
import { remoteWorld, sessionOf } from "./support/remote";
import { world } from "./support/world";

/** A host whose eta models must never be asked. */
async function host(): Promise<World> {
  const { models } = scriptedModels(() => {
    throw new Error("an eta model was asked");
  });
  return await world({ models });
}

const list = (w: World): AcpAgentView[] =>
  w.client.section<AcpAgentView[]>("acp", "list") ?? [];

async function save(w: World, agent: unknown, previousId?: string) {
  // The wire hands a call's `result` back as the call's value.
  return (await w.client.call("acp", "save", {
    agent,
    ...(previousId === undefined ? {} : { previousId }),
  })) as AcpAgentView;
}

async function direct(w: World, agent: AgentView) {
  const { conversation } = (await w.client.call("agents", "direct", {
    agentId: agent.id,
  })) as { conversation: { id: string } };
  await w.watch(conversation.id);
  return conversation.id;
}

describe("an ACP agent, from the settings page to a reply", () => {
  it("is saved, listed as a runtime, and answers an agent's conversation", async () => {
    const w = await host();
    const fake = fakeAgent("fake");
    w.client.subscribe("acp");
    await until(() => w.client.section("acp", "list") !== undefined);
    expect(list(w)).toEqual([]);

    const saved = await save(w, fake.config);
    expect(saved).toEqual({
      ...fake.config,
      runtime: "acp.fake",
      status: "available",
      version: "0.0.1",
    });
    // Whoever watches the list is told, and the file is the user's own to read.
    await until(() => list(w).length === 1);
    expect(list(w)[0]).toEqual(saved);
    expect(
      JSON.parse(readFileSync(join(w.host.dataDir, "acp.json"), "utf8")),
    ).toEqual({ agents: [fake.config] });

    const { runtimes } = (await w.client.call("agents", "runtimes", {})) as {
      runtimes: AgentRuntimeInfo[];
    };
    expect(runtimes.at(-1)).toMatchObject({
      id: "acp.fake",
      label: "Fake Agent",
      status: "available",
      models: [{ id: "model-a" }, { id: "model-b" }],
    });

    const agent = await w.agent("Ace", {
      runtime: "acp.fake",
      model: "acp.fake:model-b",
    });
    expect(agent).toMatchObject({
      runtime: "acp.fake",
      model: "acp.fake:model-b",
    });
    await expect(
      w.agent("Bad", { runtime: "acp.fake", model: "claude:sonnet" }),
    ).rejects.toThrow(/acp\.fake:<model>/);
    const chat = await direct(w, agent);
    const sent = await w.send(chat, "use a tool please");
    const done = await w.settled(chat, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(done.text).toBe(" The notes say hi.");
    expect(
      ((done.data as { activity?: ToolActivity[] }).activity ?? []).map(
        (entry) => entry.name,
      ),
    ).toEqual(["read"]);
    expect(
      fake
        .log()
        .filter((entry) => entry.method === "session/set_config_option")
        .map((entry) => entry.value),
    ).toEqual(["model-b"]);
  });

  it("streams its reply, and stops when the user stops it", async () => {
    const w = await host();
    const fake = fakeAgent("fake");
    await save(w, fake.config);
    const agent = await w.agent("Ace", { runtime: "acp.fake" });
    const chat = await direct(w, agent);
    const first = await w.send(chat, "hello");
    await w.settled(chat, first.replies[0]!.id);
    const session = sessionOf(w, chat)!;
    w.client.subscribe(`sessions.${session}`);
    const sent = await w.send(chat, "a slow one");
    const reply = sent.replies[0]!.id;
    // The words are on the wire while the turn is still running: the session's view carries
    // the message in flight, as it does for a turn of eta's own loop.
    await until(() =>
      JSON.stringify(
        w.client.section<{ streaming?: unknown }>(`sessions.${session}`, "core")
          ?.streaming ?? "",
      ).includes("a slow one"),
    );
    expect(
      w.client.section<{ streaming?: { content: { type: string }[] } }>(
        `sessions.${session}`,
        "core",
      )?.streaming,
    ).toMatchObject({
      role: "assistant",
      provider: "acp.fake",
      content: [{ type: "thinking" }, { type: "text" }],
    });
    expect(w.row(chat, reply)!.status).toBe("working");
    await w.client.call("conversations", "stop", { conversationId: chat });
    const stopped = await w.settled(chat, reply);
    expect(stopped.status).toBe("stopped");
    expect(fake.log().some((entry) => entry.method === "session/cancel")).toBe(
      true,
    );
    // The session goes on: the next message is the same agent session's next prompt.
    const next = await w.send(chat, "state");
    const said = await w.settled(chat, next.replies[0]!.id);
    expect(JSON.parse(said.text)).toMatchObject({ prompts: 3 });
  });
});

describe("the acp target", () => {
  it("refuses what does not hold up, in words", async () => {
    const w = await host();
    const fake = fakeAgent("fake");
    const { config } = fake;
    await expect(save(w, { ...config, id: "Not A Slug" })).rejects.toThrow(
      /id "Not A Slug" is not valid/,
    );
    await expect(save(w, { ...config, command: "  " })).rejects.toThrow(
      /command is empty/,
    );
    await expect(save(w, { ...config, env: { "": "x" } })).rejects.toThrow(
      /environment variable has an empty name/,
    );
    await expect(w.client.call("acp", "save", {})).rejects.toThrow(
      /acp\.save needs agent/,
    );
    await save(w, config);
    // No `previousId` is a new agent: it does not overwrite one that is there.
    await expect(save(w, config)).rejects.toThrow(
      /An ACP agent with the id fake already exists/,
    );
    await save(w, { ...config, id: "other" });
    await expect(save(w, { ...config, id: "other" }, "fake")).rejects.toThrow(
      /Cannot rename fake to other: an ACP agent with that id already exists/,
    );
    await expect(save(w, config, "nobody")).rejects.toThrow(
      /There is no ACP agent nobody/,
    );
    await expect(
      w.client.call("acp", "delete", { id: "nobody" }),
    ).rejects.toThrow(/There is no ACP agent nobody/);
  });

  it("changes one in place, renames one, and deletes one", async () => {
    const w = await host();
    const { config } = fakeAgent("fake");
    w.client.subscribe("acp");
    await save(w, config);
    const changed = await save(
      w,
      { ...config, label: "Renamed", autoAllow: true },
      "fake",
    );
    expect(changed).toMatchObject({
      id: "fake",
      label: "Renamed",
      autoAllow: true,
      status: "available",
    });
    const moved = await save(w, { ...config, id: "moved" }, "fake");
    expect(moved).toMatchObject({ id: "moved", runtime: "acp.moved" });
    await until(
      () => list(w).length === 1 && list(w)[0]!.runtime === "acp.moved",
    );
    expect(await w.client.call("acp", "delete", { id: "moved" })).toEqual({});
    await until(() => list(w).length === 0);
    const { runtimes } = (await w.client.call("agents", "runtimes", {
      fresh: true,
    })) as { runtimes: AgentRuntimeInfo[] };
    expect(runtimes.some((runtime) => runtime.id.startsWith("acp."))).toBe(
      false,
    );
  });

  it("keeps an id an agent still runs on, and says which agent", async () => {
    const w = await host();
    const { config } = fakeAgent("fake");
    await save(w, config);
    await w.agent("Ace", { runtime: "acp.fake" });
    await w.agent("Bea", { runtime: "acp.fake" });
    await expect(
      w.client.call("acp", "delete", { id: "fake" }),
    ).rejects.toThrow(/Cannot delete fake: Ace, Bea run on acp\.fake/);
    await expect(save(w, { ...config, id: "moved" }, "fake")).rejects.toThrow(
      /Cannot rename fake: Ace, Bea run on acp\.fake/,
    );
    // Changing it in place is not a rename.
    expect(await save(w, { ...config, label: "Still" }, "fake")).toMatchObject({
      label: "Still",
    });
  });

  it("tests a configuration that is not saved", async () => {
    const w = await host();
    const { config } = fakeAgent("fake");
    const test = async (agent: unknown) =>
      (await w.client.call("acp", "test", { agent })) as AcpTestResult;
    expect(await test(config)).toEqual({
      ok: true,
      status: "available",
      agentName: "Fake Agent",
      version: "0.0.1",
    });
    expect(
      await test({ ...config, env: { ...config.env, FAKE_ACP_AUTH: "1" } }),
    ).toMatchObject({ ok: true, authMethods: ["Fake login"] });
    const missing = await test({ ...config, command: "eta-no-such-agent" });
    expect(missing).toMatchObject({ ok: false, status: "missing" });
    expect(missing.detail).toContain("is not installed");
    await expect(test({ ...config, id: "" })).rejects.toThrow(/is not valid/);
    expect(list(w)).toEqual([]);
  });
});

describe("an ACP agent on a daemon", () => {
  it("runs what that machine's own acp.json lists, and says so when it lists none", async () => {
    const fake = fakeAgent("fake");
    const dataDir = await mkdtemp(join(tmpdir(), "eta-daemon-acp-"));
    mkdirSync(join(dataDir, ".eta"), { recursive: true });
    writeFileSync(
      join(dataDir, ".eta", "acp.json"),
      JSON.stringify({ agents: [fake.config] }),
    );
    const r = await remoteWorld({}, { dataDir });
    const { runtimes } = (await r.client.call("agents", "runtimes", {
      machineId: r.daemon.machineId,
    })) as { runtimes: AgentRuntimeInfo[] };
    expect(runtimes.at(-1)).toMatchObject({
      id: "acp.fake",
      status: "available",
    });
    const ace = await r.agent("Ace", { runtime: "acp.fake" });
    const group = await r.group(r.remoteProject.id, [ace.id]);
    await r.watch(group.id);
    const sent = await r.send(group.id, "state");
    const done = await r.settled(group.id, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(JSON.parse(done.text)).toMatchObject({ prompts: 1 });

    // An id only the primary knows does not run there.
    const lost = await r.agent("Lost", { runtime: "acp.elsewhere" });
    const other = await r.group(r.remoteProject.id, [lost.id]);
    await r.watch(other.id);
    const asked = await r.send(other.id, "hello");
    const failed = await r.settled(other.id, asked.replies[0]!.id, [
      "done",
      "failed",
    ]);
    expect(failed.status).toBe("failed");
    expect(JSON.stringify(failed)).toContain(
      "the ACP agent elsewhere is not configured on this machine",
    );
  });
});
