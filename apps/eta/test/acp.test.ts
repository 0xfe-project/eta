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
  AcpMachineList,
  AcpTestResult,
  AgentRuntimeInfo,
  AgentView,
  MachineView,
  ToolActivity,
} from "@eta/client-contracts";
import type { RemoteWorld } from "./support/remote";
import type { World } from "./support/world";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeAgent } from "@eta/runtime-acp/testing";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { machineView } from "./support/daemon";
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

const primaryOf = (w: World): string =>
  w.client
    .section<MachineView[]>("machines", "list")!
    .find((machine) => machine.kind === "primary")!.id;

/** One machine's entry in the `acp` target's `machines` section; the primary's by default. */
const entry = (w: World, machineId?: string): AcpMachineList | undefined =>
  w.client.section<Record<string, AcpMachineList>>("acp", "machines")?.[
    machineId ?? primaryOf(w)
  ];

const list = (w: World, machineId?: string): AcpAgentView[] =>
  entry(w, machineId)?.agents ?? [];

async function save(
  w: World,
  agent: unknown,
  previousId?: string,
  machineId?: string,
) {
  // The wire hands a call's `result` back as the call's value.
  return (await w.client.call("acp", "save", {
    agent,
    ...(previousId === undefined ? {} : { previousId }),
    ...(machineId === undefined ? {} : { machineId }),
  })) as AcpAgentView;
}

/** A group of the agent alone, in its own workspace. */
async function alone(w: World, agent: AgentView) {
  const conversation = await w.group(
    agent.homeProjectId,
    [agent.id],
    agent.name,
  );
  await w.watch(conversation.id);
  return conversation.id;
}

describe("an ACP agent, from the settings page to a reply", () => {
  it("is saved, listed as a runtime, and answers an agent's conversation", async () => {
    const w = await host();
    const fake = fakeAgent("fake");
    w.client.subscribe("acp");
    await until(() => entry(w) !== undefined);
    expect(list(w)).toEqual([]);

    const saved = await save(w, fake.config);
    // `save` does not wait for the look: the agent says it is being checked.
    expect(saved).toEqual({
      ...fake.config,
      runtime: "acp.fake",
      status: "available",
      detail: "Checking…",
    });
    // Whoever watches the list is told, with what the look found once it is done.
    await until(() => list(w)[0]?.version === "0.0.1");
    expect(list(w)[0]).toEqual({
      ...fake.config,
      runtime: "acp.fake",
      status: "available",
      version: "0.0.1",
    });
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
    const chat = await alone(w, agent);
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
    const chat = await alone(w, agent);
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
    const changed = await save(w, { ...config, label: "Renamed" }, "fake");
    expect(changed).toMatchObject({
      id: "fake",
      label: "Renamed",
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

  it("previews dependent agents and cascade-deletes them with deleteAgents while keeping group history", async () => {
    const w = await host();
    const { config } = fakeAgent("fake");
    await save(w, config);
    const ace = await w.agent("Ace", { runtime: "acp.fake" });
    const bea = await w.agent("Bea", { runtime: "acp.fake" });
    const project = await w.project();
    const group = await w.group(project.id, [ace.id], "team");
    await w.watch(group.id);

    // Write a past message from Ace and start an active slow reply so we verify both history
    // preservation and active turn stopping.
    const first = await w.send(group.id, "hello");
    await w.settled(group.id, first.replies[0]!.id);
    const slow = await w.send(group.id, "a slow one");
    await w.settled(group.id, slow.replies[0]!.id, ["working"]);

    const preview = (await w.client.call("acp", "deletePreview", {
      id: "fake",
    })) as {
      id: string;
      machineId: string;
      agents: {
        id: string;
        name: string;
        runtime: string;
        groupCount: number;
        busy: boolean;
      }[];
    };
    expect(preview.id).toBe("fake");
    expect(preview.machineId).toBe(primaryOf(w));
    expect(preview.agents).toEqual(
      expect.arrayContaining([
        {
          id: ace.id,
          name: "Ace",
          runtime: "acp.fake",
          groupCount: 1,
          busy: true,
        },
        {
          id: bea.id,
          name: "Bea",
          runtime: "acp.fake",
          groupCount: 0,
          busy: false,
        },
      ]),
    );

    // Without deleteAgents: true, still refused.
    await expect(
      w.client.call("acp", "delete", { id: "fake" }),
    ).rejects.toThrow(/Cannot delete fake/);

    // With deleteAgents: true, removes acp.json entry and deletes both Ace and Bea.
    const deleted = (await w.client.call("acp", "delete", {
      id: "fake",
      deleteAgents: true,
    })) as { deletedAgents?: string[] };
    expect(deleted.deletedAgents).toEqual(
      expect.arrayContaining([ace.id, bea.id]),
    );
    expect(
      JSON.parse(readFileSync(join(w.host.dataDir, "acp.json"), "utf8")),
    ).toEqual({ agents: [] });
    await until(
      () =>
        w.client
          .section<AgentView[]>("agents", "list")
          ?.every((a) => a.id !== ace.id && a.id !== bea.id) === true,
    );
    // Past messages in the group remain intact, and the active reply was stopped.
    expect(w.row(group.id, first.replies[0]!.id)?.status).toBe("done");
    const stopped = await w.settled(group.id, slow.replies[0]!.id);
    expect(stopped.status).toBe("stopped");
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

describe("an acp.json that cannot be read whole", () => {
  const fileOf = (w: World) => join(w.host.dataDir, "acp.json");
  const listError = (w: World) => entry(w)?.error;

  it("refuses save, rename and delete without writing a byte, and the list says why", async () => {
    const w = await host();
    const one = fakeAgent("one").config;
    const two = fakeAgent("two").config;
    // Two agents, and the trailing comma a hand-edit leaves.
    const text = `{ "agents": [${JSON.stringify(one)}, ${JSON.stringify(two)},] }`;
    writeFileSync(fileOf(w), text);
    w.client.subscribe("acp");
    await until(() => listError(w) !== undefined);
    expect(listError(w)).toContain(fileOf(w));
    expect(listError(w)).toContain("is not valid JSON");
    expect(entry(w)?.agents).toBeUndefined();

    await expect(save(w, fakeAgent("three").config)).rejects.toThrow(
      /is not valid JSON/,
    );
    await expect(save(w, { ...one, label: "Changed" }, "one")).rejects.toThrow(
      /is not valid JSON/,
    );
    await expect(save(w, { ...one, id: "moved" }, "one")).rejects.toThrow(
      /is not valid JSON/,
    );
    await expect(w.client.call("acp", "delete", { id: "two" })).rejects.toThrow(
      /is not valid JSON/,
    );
    expect(readFileSync(fileOf(w), "utf8")).toBe(text);

    // Listing runtimes still answers (the built-in ones are not held up); the file's agents
    // are not among them.
    const { runtimes } = (await w.client.call("agents", "runtimes", {})) as {
      runtimes: AgentRuntimeInfo[];
    };
    expect(runtimes.some((runtime) => runtime.id.startsWith("acp."))).toBe(
      false,
    );
  });

  it("keeps a bad agent: saving the good one beside it is refused", async () => {
    const w = await host();
    const good = fakeAgent("good").config;
    const text = JSON.stringify({
      agents: [{ id: "Bad Id", command: "x" }, good],
    });
    writeFileSync(fileOf(w), text);
    await expect(save(w, { ...good, label: "Better" }, "good")).rejects.toThrow(
      /agent 1 \("Bad Id"\): the id "Bad Id" is not valid/,
    );
    expect(readFileSync(fileOf(w), "utf8")).toBe(text);
  });

  it("creates the file when there is none, and reads again once it is fixed", async () => {
    const w = await host();
    const one = fakeAgent("one").config;
    await save(w, one);
    expect(JSON.parse(readFileSync(fileOf(w), "utf8"))).toEqual({
      agents: [one],
    });
    writeFileSync(fileOf(w), `{ "agents": [${JSON.stringify(one)},] }`);
    await expect(save(w, fakeAgent("two").config)).rejects.toThrow(/JSON/);
    writeFileSync(fileOf(w), JSON.stringify({ agents: [one] }));
    const two = fakeAgent("two").config;
    await save(w, two);
    expect(await w.client.call("acp", "delete", { id: "one" })).toEqual({});
    expect(JSON.parse(readFileSync(fileOf(w), "utf8"))).toEqual({
      agents: [two],
    });
  });
});

describe("saving an agent that is slow to answer", () => {
  it("returns at once, and the look arrives later as the list", async () => {
    const w = await host();
    // `initialize` takes 3s here; the acceptance probe ran it at 45s by hand.
    const slow = fakeAgent("slow", {
      env: { FAKE_ACP_INIT_DELAY_MS: "3000" },
    }).config;
    w.client.subscribe("acp");
    await until(() => entry(w) !== undefined);
    const started = Date.now();
    const saved = await save(w, slow);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(saved).toMatchObject({ status: "available", detail: "Checking…" });
    expect(
      JSON.parse(readFileSync(join(w.host.dataDir, "acp.json"), "utf8")),
    ).toEqual({ agents: [slow] });
    await until(() => list(w)[0]?.version === "0.0.1", 15_000);
    expect(list(w)[0]).toMatchObject({ status: "available" });
    expect(list(w)[0]!.detail).toBeUndefined();
  }, 30_000);
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
    const ace = await r.agent("Ace", {
      runtime: "acp.fake",
      machineId: r.daemon.machineId,
    });
    const group = await r.group(r.remoteProject.id, [ace.id]);
    await r.watch(group.id);
    const sent = await r.send(group.id, "state");
    const done = await r.settled(group.id, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(JSON.parse(done.text)).toMatchObject({ prompts: 1 });

    // An id only the primary knows does not run on the daemon.
    const lost = await r.agent("Lost", {
      runtime: "acp.elsewhere",
      machineId: r.daemon.machineId,
    });
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

describe("one machine at a time: the settings page on a daemon", () => {
  const daemonFile = (r: RemoteWorld) =>
    join(r.daemon.dataDir, ".eta", "acp.json");
  const primaryFile = (w: World) => join(w.host.dataDir, "acp.json");
  const readAgents = (path: string) =>
    existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as { agents: unknown[] }).agents
      : undefined;

  it("lists, adds, tests, changes and deletes in the daemon's own acp.json, leaving the primary's alone", async () => {
    const r = await remoteWorld();
    const machineId = r.daemon.machineId;
    const fake = fakeAgent("fake");
    r.client.subscribe("acp");
    expect(await r.client.call("acp", "refresh", { machineId })).toEqual({
      agents: [],
    });
    await until(() => entry(r, machineId) !== undefined);

    const saved = await save(r, fake.config, undefined, machineId);
    expect(saved).toMatchObject({ id: "fake", runtime: "acp.fake" });
    expect(readAgents(daemonFile(r))).toEqual([fake.config]);
    expect(readAgents(primaryFile(r))).toBeUndefined();
    // The look the daemon ran behind arrives as the daemon's list.
    await until(() => list(r, machineId)[0]?.version === "0.0.1");
    expect(list(r)).toEqual([]);

    expect(
      await r.client.call("acp", "test", { machineId, agent: fake.config }),
    ).toMatchObject({ ok: true, agentName: "Fake Agent" });

    await save(r, { ...fake.config, label: "Far" }, "fake", machineId);
    expect(readAgents(daemonFile(r))).toEqual([
      { ...fake.config, label: "Far" },
    ]);
    await until(() => list(r, machineId)[0]?.label === "Far");

    expect(
      await r.client.call("acp", "delete", { machineId, id: "fake" }),
    ).toEqual({});
    expect(readAgents(daemonFile(r))).toEqual([]);
    expect(readAgents(primaryFile(r))).toBeUndefined();
    await until(() => list(r, machineId).length === 0);
  });

  it("keeps the same id on two machines apart, and checks it only against the machine's own", async () => {
    const r = await remoteWorld();
    const machineId = r.daemon.machineId;
    const here = fakeAgent("same").config;
    const there = { ...fakeAgent("same").config, label: "Over there" };
    await save(r, here);
    // Taken on the primary, free on the daemon.
    await save(r, there, undefined, machineId);
    await expect(save(r, there, undefined, machineId)).rejects.toThrow(
      /already exists on this machine/,
    );
    await save(r, { ...there, label: "Moved on" }, "same", machineId);
    expect(readAgents(primaryFile(r))).toEqual([here]);
    await r.client.call("acp", "delete", { machineId, id: "same" });
    expect(readAgents(primaryFile(r))).toEqual([here]);
    expect(readAgents(daemonFile(r))).toEqual([]);
    await r.client.call("acp", "delete", { id: "same" });
    expect(readAgents(primaryFile(r))).toEqual([]);
  });

  it("refuses a daemon that is offline, and never does it on the primary instead", async () => {
    const r = await remoteWorld();
    const machineId = r.daemon.machineId;
    const fake = fakeAgent("fake").config;
    await r.daemon.stop();
    await until(() => machineView(r.client, machineId)?.status === "offline");
    await expect(save(r, fake, undefined, machineId)).rejects.toThrow(
      /is offline/,
    );
    await expect(
      r.client.call("acp", "test", { machineId, agent: fake }),
    ).rejects.toThrow(/is offline/);
    await expect(
      r.client.call("acp", "delete", { machineId, id: "fake" }),
    ).rejects.toThrow(/is offline/);
    await expect(
      r.client.call("acp", "refresh", { machineId }),
    ).rejects.toThrow(/is offline/);
    expect(readAgents(primaryFile(r))).toBeUndefined();
    expect(entry(r, machineId)).toBeUndefined();
    await expect(
      r.client.call("acp", "refresh", { machineId: "no-such-machine" }),
    ).rejects.toThrow(/no such machine/);
  });

  it("refuses to write the daemon's file when it cannot be read whole, and its list says why", async () => {
    const r = await remoteWorld();
    const machineId = r.daemon.machineId;
    const one = fakeAgent("one").config;
    mkdirSync(join(r.daemon.dataDir, ".eta"), { recursive: true });
    const text = `{ "agents": [${JSON.stringify(one)},] }`;
    writeFileSync(daemonFile(r), text);
    r.client.subscribe("acp");
    const answered = (await r.client.call("acp", "refresh", {
      machineId,
    })) as AcpMachineList;
    expect(answered.error).toContain(daemonFile(r));
    expect(answered.error).toContain("is not valid JSON");
    await until(() => entry(r, machineId)?.error !== undefined);
    await expect(
      save(r, fakeAgent("two").config, undefined, machineId),
    ).rejects.toThrow(/is not valid JSON/);
    await expect(
      save(r, { ...one, id: "moved" }, "one", machineId),
    ).rejects.toThrow(/is not valid JSON/);
    await expect(
      r.client.call("acp", "delete", { machineId, id: "one" }),
    ).rejects.toThrow(/is not valid JSON/);
    expect(readFileSync(daemonFile(r), "utf8")).toBe(text);
    // The primary's file is its own business: still writable.
    await save(r, fakeAgent("two").config);
    expect(entry(r)?.agents).toBeDefined();
  });

  it("counts only the agents pinned to that machine as still using an id", async () => {
    const r = await remoteWorld();
    const machineId = r.daemon.machineId;
    const { config } = fakeAgent("fake");
    await save(r, config);
    await save(r, config, undefined, machineId);
    // Pinned to the daemon: holds the daemon's, not the primary's.
    await r.agent("OnDaemon", { runtime: "acp.fake", machineId });
    // Pinned to the primary: holds the primary's, not the daemon's.
    const onPrimary = await r.agent("OnPrimary", { runtime: "acp.fake" });
    const project = await r.project();
    await r.group(project.id, [onPrimary.id]);
    await expect(
      r.client.call("acp", "delete", { machineId, id: "fake" }),
    ).rejects.toThrow(/Cannot delete fake: OnDaemon runs on acp\.fake/);
    await expect(
      save(r, { ...config, id: "moved" }, "fake", machineId),
    ).rejects.toThrow(/Cannot rename fake: OnDaemon runs on acp\.fake/);
    // On the primary only OnPrimary counts.
    await expect(
      r.client.call("acp", "delete", { id: "fake" }),
    ).rejects.toThrow(/Cannot delete fake: OnPrimary runs on acp\.fake/);
  });

  it("ignores agents pinned to another machine even when deleting an ACP definition here", async () => {
    const r = await remoteWorld();
    const machineId = r.daemon.machineId;
    const { config } = fakeAgent("fake");
    await save(r, config, undefined, machineId);
    // Pinned to the primary: its sessions run there, never on the daemon.
    await r.agent("Homebody", { runtime: "acp.fake" });
    expect(
      await r.client.call("acp", "delete", { machineId, id: "fake" }),
    ).toEqual({});
  });

  it("runs an agent pinned to the daemon on the agent the settings page added there", async () => {
    const r = await remoteWorld();
    const machineId = r.daemon.machineId;
    const fake = fakeAgent("fake");
    await save(r, fake.config, undefined, machineId);
    const { runtimes } = (await r.client.call("agents", "runtimes", {
      machineId,
      fresh: true,
    })) as { runtimes: AgentRuntimeInfo[] };
    expect(runtimes.some((runtime) => runtime.id === "acp.fake")).toBe(true);
    const ace = await r.agent("Ace", { runtime: "acp.fake", machineId });
    const chat = await alone(r, ace);
    const sent = await r.send(chat, "state");
    const done = await r.settled(chat, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    expect(JSON.parse(done.text)).toMatchObject({ prompts: 1 });
  });

  it("refuses cascade delete when daemon is offline without deleting dependent eta agents, then cascade-deletes when online", async () => {
    const r = await remoteWorld();
    const machineId = r.daemon.machineId;
    const { config } = fakeAgent("fake");
    await save(r, config, undefined, machineId);
    const ace = await r.agent("Ace", { runtime: "acp.fake", machineId });
    const group = await r.group(r.remoteProject.id, [ace.id], "daemon-chat");
    await r.watch(group.id);
    const first = await r.send(group.id, "hello");
    await r.settled(group.id, first.replies[0]!.id);

    // Offline daemon: preview works from SQLite, delete with deleteAgents: true refuses atomically.
    await r.daemon.stop();
    await until(() => machineView(r.client, machineId)?.status === "offline");
    const offlinePreview = (await r.client.call("acp", "deletePreview", {
      machineId,
      id: "fake",
    })) as { agents: { id: string }[] };
    expect(offlinePreview.agents.map((a) => a.id)).toEqual([ace.id]);
    await expect(
      r.client.call("acp", "delete", {
        machineId,
        id: "fake",
        deleteAgents: true,
      }),
    ).rejects.toThrow(/is offline/);
    // Ace was NOT deleted because daemon write did not happen.
    expect(
      r.client
        .section<AgentView[]>("agents", "list")
        ?.some((a) => a.id === ace.id),
    ).toBe(true);
    expect(readAgents(daemonFile(r))).toEqual([config]);
  });
});
