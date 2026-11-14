/**
 * Where an agent lives and how its private chat is opened: `homeOf` finds the home project,
 * `ensureHome` makes it only when it is missing, and `openDirect` finds, makes or brings back the
 * private chat, telling exactly the callbacks it was given.
 */
import type { Database } from "bun:sqlite";
import type { Plugins } from "../src/plugins/service";
import { afterEach, describe, expect, it } from "vitest";
import { writeAgent } from "../src/agents/create";
import { ensureHome, homeOf, isAgentHome } from "../src/agents/home";
import { agentHome, AgentStore } from "../src/agents/store";
import { openDirect } from "../src/conversations/direct";
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
  it("finds the project writeAgent made, and nothing for an agent without one", async () => {
    const d = await stores();
    const { agent, project } = await writeAgent(
      d,
      { name: "Ada", model: "fake:m" },
      { actorAgentId: null },
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
      stewardId: old.id,
      machineId: d.machines.primary()!.id,
    });
    expect(ensureHome(d, old).id).toBe(made.id);
    expect(
      d.projects.list().filter((p) => p.kind === "agent_home"),
    ).toHaveLength(1);
  });

  it("returns the one that is there", async () => {
    const d = await stores();
    const { agent, project } = await writeAgent(
      d,
      { name: "Ada" },
      { actorAgentId: null },
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

describe("openDirect", () => {
  async function setup() {
    const d = await stores();
    const { agent, project } = await writeAgent(
      d,
      { name: "Ada" },
      { actorAgentId: null },
    );
    const told: string[] = [];
    const deps = {
      conversations: d.conversations,
      created: (id: string) => told.push(`created ${id}`),
      changed: (ids: readonly string[]) => told.push(`changed ${ids.join()}`),
    };
    return { d, agent, project, told, deps };
  }

  it("makes the private chat when there is none, and says so", async () => {
    const { agent, project, told, deps } = await setup();
    const chat = openDirect(deps, project, agent);
    expect(chat).toMatchObject({
      projectId: project.id,
      kind: "direct",
      name: "Ada",
      archived: false,
    });
    expect(told).toEqual([`created ${chat.id}`, `changed ${chat.id}`]);
  });

  it("finds the one that is there and says nothing", async () => {
    const { agent, project, told, deps } = await setup();
    const first = openDirect(deps, project, agent);
    told.length = 0;
    expect(openDirect(deps, project, agent).id).toBe(first.id);
    expect(told).toEqual([]);
  });

  it("brings back one that was put away, and says it changed", async () => {
    const { d, agent, project, told, deps } = await setup();
    const first = openDirect(deps, project, agent);
    d.conversations.update(first.id, { archived: true });
    told.length = 0;
    const back = openDirect(deps, project, agent);
    expect(back).toMatchObject({ id: first.id, archived: false });
    expect(told).toEqual([`changed ${first.id}`]);
  });

  it("tells only the callbacks it was given", async () => {
    const { d, agent, project } = await setup();
    const created: string[] = [];
    const chat = openDirect(
      { conversations: d.conversations, created: (id) => created.push(id) },
      project,
      agent,
    );
    expect(created).toEqual([chat.id]);
    d.conversations.update(chat.id, { archived: true });
    expect(
      openDirect({ conversations: d.conversations }, project, agent).archived,
    ).toBe(false);
  });

  it("is per project: another project is another private chat", async () => {
    const { d, agent, project, deps } = await setup();
    const repo = d.projects.create({
      machineId: d.machines.primary()!.id,
      path: "/work/repo",
      name: "repo",
    });
    expect(openDirect(deps, repo, agent).id).not.toBe(
      openDirect(deps, project, agent).id,
    );
  });
});
