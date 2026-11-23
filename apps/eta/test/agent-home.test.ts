/**
 * Where an agent lives: `homeOf` finds the home project, and `ensureHome` makes it only when it is
 * missing.
 */
import type { Database } from "bun:sqlite";
import type { Plugins } from "../src/plugins/service";
import { afterEach, describe, expect, it } from "vitest";
import { createAgent } from "../src/agents/create";
import { ensureHome, homeOf, isAgentHome } from "../src/agents/home";
import { agentHome, AgentStore } from "../src/agents/store";
import { ConversationStore } from "../src/conversations/store";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { MachineStore } from "../src/machines/store";
import { ProjectStore } from "../src/projects/store";
import { tempDir } from "./support/host";

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

async function stores(options: { primary?: boolean } = {}) {
  const db = openDatabase(":memory:");
  open.push(db);
  applyMigrations(db, loadMigrations());
  const machines = new MachineStore(db);
  if (options.primary !== false)
    machines.ensurePrimary({ name: "box", home: "/home/u", os: "linux" });
  const deps = {
    dataDir: await tempDir(),
    db,
    agents: new AgentStore(db),
    machines,
    projects: new ProjectStore(db),
    conversations: new ConversationStore(db),
    plugins: { rows: { setEnabled: () => {} } } as unknown as Plugins,
  };
  return deps;
}

describe("homeOf", () => {
  it("finds the project createAgent made, and nothing for an agent without one", async () => {
    const d = await stores();
    const { agent, project } = await createAgent(
      d,
      { name: "Ada", model: "fake:m" },
      null,
    );
    expect(homeOf(d, agent)?.id).toBe(project.id);
    const bare = d.agents.create({ name: "Bare" });
    expect(homeOf(d, bare)).toBeUndefined();
  });

  it("is nothing on a host with no primary machine", async () => {
    const d = await stores({ primary: false });
    expect(homeOf(d, { id: "a1" })).toBeUndefined();
  });
});

describe("ensureHome", () => {
  it("makes the home project of an agent that has none, once", async () => {
    const d = await stores();
    const old = d.agents.create({ name: "Captain", systemRole: "captain" });
    const made = ensureHome(d, old);
    expect(made).toMatchObject({
      path: agentHome(d.dataDir, old.id),
      name: "Captain",
      kind: "agent_home",
      ownerAgentId: old.id,
      machineId: d.machines.primary()!.id,
    });
    expect(ensureHome(d, old).id).toBe(made.id);
    expect(
      d.projects.list().filter((p) => p.kind === "agent_home"),
    ).toHaveLength(1);
  });

  it("returns the one that is there", async () => {
    const d = await stores();
    const { agent, project } = await createAgent(
      d,
      { name: "Ada", model: "fake:m" },
      null,
    );
    expect(ensureHome(d, agent).id).toBe(project.id);
  });
});

describe("isAgentHome", () => {
  it("knows an agent's workspace from any other directory", async () => {
    const d = await stores();
    const ada = d.agents.create({ name: "Ada" });
    expect(isAgentHome(d, agentHome(d.dataDir, ada.id))).toBe(true);
    expect(isAgentHome(d, agentHome(d.dataDir, "nobody"))).toBe(false);
    expect(isAgentHome(d, "/work/repo")).toBe(false);
  });
});
