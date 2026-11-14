/**
 * Making an agent, as the agent dialog and Captain's confirmed proposal both do it (`createAgent`):
 * the agent, its home project and its plugins in one transaction, the directory taken away again
 * when that fails, its first prompt versions recorded as whoever asked, and one rule for names.
 */
import type { Database } from "bun:sqlite";
import type { AgentCreateDeps } from "../src/agents/create";
import type { Plugins } from "../src/plugins/service";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkNewAgent, createAgent } from "../src/agents/create";
import { AgentStore } from "../src/agents/store";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { MachineStore } from "../src/machines/store";
import { ProjectStore } from "../src/projects/store";
import { tempDir } from "./support/host";
import { world } from "./support/world";

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

/** Real stores on a fresh database; plugins that can be told to fail. */
async function deps(options: { pluginsFail?: boolean } = {}) {
  const db = openDatabase(":memory:");
  open.push(db);
  applyMigrations(db, loadMigrations());
  const machines = new MachineStore(db);
  machines.ensurePrimary({ name: "box", home: "/home/u", os: "linux" });
  const captured: {
    agentId: string;
    kind: string;
    actorAgentId: string | null;
  }[] = [];
  const plugins = {
    canEnable: () => true,
    rows: {
      enabled: () => [],
      setEnabled: () => {
        if (options.pluginsFail === true) throw new Error("plugins broke");
      },
    },
  } as unknown as Plugins;
  const made: AgentCreateDeps = {
    dataDir: await tempDir(),
    db,
    agents: new AgentStore(db),
    machines,
    projects: new ProjectStore(db),
    plugins,
    capturePrompt: (input) => captured.push(input),
  };
  return { ...made, captured };
}

const count = (db: Database, table: string) =>
  db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;

describe("createAgent", () => {
  it("makes the agent, its home project and its first prompt versions, as whoever asked", async () => {
    const d = await deps();
    const { agent, project } = await createAgent(
      d,
      {
        name: " Scout ",
        instructions: "Watch.",
        persona: "Executor",
        model: "openai:gpt-5",
        plugins: ["web"],
      },
      "captain-id",
    );
    expect(agent).toMatchObject({ name: "Scout", persona: "Executor" });
    expect(project).toMatchObject({
      kind: "agent_home",
      stewardId: agent.id,
      name: "Scout",
    });
    expect(await readdir(join(d.dataDir, "agents"))).toEqual([agent.id]);
    expect(d.captured).toEqual([
      expect.objectContaining({
        agentId: agent.id,
        kind: "instructions",
        actorAgentId: "captain-id",
      }),
      expect.objectContaining({
        agentId: agent.id,
        kind: "persona",
        content: "Executor",
        actorAgentId: "captain-id",
      }),
    ]);
  });

  it("writes nothing and leaves no directory when part of it fails", async () => {
    const d = await deps({ pluginsFail: true });
    await expect(
      createAgent(
        d,
        { name: "Scout", model: "openai:gpt-5", plugins: ["web"] },
        null,
      ),
    ).rejects.toThrow(/plugins broke/);
    // The agent and the project were written before the plugins: the transaction took them back.
    expect(count(d.db, "agent")).toBe(0);
    expect(count(d.db, "project")).toBe(0);
    expect(await readdir(join(d.dataDir, "agents"))).toEqual([]);
    expect(d.captured).toEqual([]);
  });

  it("refuses a name another agent answers to, in any case", async () => {
    const d = await deps();
    await createAgent(d, { name: "Scout", model: "openai:gpt-5" }, null);
    for (const name of ["Scout", "scout", "  SCOUT "])
      expect(() => checkNewAgent(d, { name, model: "openai:gpt-5" })).toThrow(
        /an agent named ".*" already exists/,
      );
    await expect(
      createAgent(d, { name: "scout", model: "openai:gpt-5" }, null),
    ).rejects.toThrow(/already exists/);
    expect(count(d.db, "agent")).toBe(1);
  });
});

describe("agents.create and agents.update over the wire", () => {
  it("refuse a second agent of a name, and a rename onto one", async () => {
    const w = await world();
    const ada = await w.agent("Ada");
    await expect(
      w.client.call("agents", "create", { name: "ada", model: "fake:model" }),
    ).rejects.toThrow(/an agent named "ada" already exists/);
    const bob = await w.agent("Bob");
    await expect(
      w.client.call("agents", "update", { agentId: bob.id, name: "ADA" }),
    ).rejects.toThrow(/already exists/);
    // An agent keeps its own name, in another case if it likes.
    await w.client.call("agents", "update", { agentId: ada.id, name: "ADA" });
  });
});
