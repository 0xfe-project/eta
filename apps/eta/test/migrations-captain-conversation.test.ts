/**
 * 0061, as an upgrade: a host's private chats as a 0060 host left them — Captain's, an agent's in
 * use, one put away, one whose agent was deleted — and this build started on that data. Captain's
 * becomes Captain's own kind, the rest groups of one with their agent as steward, and nothing that
 * points at them is lost. Then both are talked in, on the host.
 */
import type {
  ConversationInfo,
  ConversationSummary,
} from "@eta/client-contracts";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import { agentHome, AgentStore } from "../src/agents/store";
import { ConversationStore } from "../src/conversations/store";
import { Timeline } from "../src/conversations/timeline";
import {
  applyMigrations,
  databasePath,
  loadMigrations,
  openDatabase,
} from "../src/db";
import { MachineStore } from "../src/machines/store";
import { ProjectStore } from "../src/projects/store";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const MIGRATION = "0061-captain-conversation";

/** What points at a conversation, counted. */
const COUNTS = [
  "conversation",
  "participant",
  "message",
  "task",
  "artifact",
  "attachment",
] as const;

async function oldHost() {
  const dataDir = await tempDir();
  const db = openDatabase(databasePath(dataDir));
  applyMigrations(
    db,
    loadMigrations().filter((migration) => migration.id < MIGRATION),
  );
  const machines = new MachineStore(db);
  const primary = machines.ensurePrimary({
    name: hostname(),
    home: dataDir,
    os: process.platform,
  });
  const agents = new AgentStore(db);
  const projects = new ProjectStore(db);
  const conversations = new ConversationStore(db);
  const timeline = new Timeline(db);
  const withHome = (name: string, systemRole?: "captain") => {
    const agent = agents.create({
      name,
      model: "fake:fake-model",
      systemRole: systemRole ?? null,
    });
    mkdirSync(agentHome(dataDir, agent.id), { recursive: true });
    const home = projects.create({
      machineId: primary.id,
      path: agentHome(dataDir, agent.id),
      name,
      kind: "agent_home",
      ownerAgentId: agent.id,
    });
    return { agent, home };
  };
  const captain = withHome("Captain", "captain");
  const ada = withHome("Ada");
  const gone = withHome("Gone");
  const direct = (
    owner: { agent: { id: string; name: string }; home: { id: string } },
    name = owner.agent.name,
  ) =>
    conversations.create({
      projectId: owner.home.id,
      kind: "direct",
      name,
      agentIds: [owner.agent.id],
      stewardId: owner.agent.id,
    });
  const chats = {
    captain: direct(captain),
    ada: direct(ada),
    put: direct(ada, "Ada, earlier"),
    gone: direct(gone),
  };
  conversations.update(chats.put.id, { archived: true });
  for (const chat of Object.values(chats))
    timeline.system(chat.id, `said in ${chat.name}`, {});
  db.query(
    `INSERT INTO task (id, title, conversation_id, created_at, updated_at)
     VALUES ('t1', 'from Ada', ?, 1, 1)`,
  ).run(chats.ada.id);
  db.query(
    `INSERT INTO artifact (id, title, conversation_id, created_at, updated_at)
     VALUES ('a1', 'Ada made', ?, 1, 1)`,
  ).run(chats.ada.id);
  db.query(
    `INSERT INTO attachment (id, conversation_id, name, content_type, size, created_at)
     VALUES ('f1', ?, 'note.txt', 'text/plain', 1, 1)`,
  ).run(chats.ada.id);
  // An agent deleted on 0060 left its chat put away, with nobody in it.
  conversations.update(chats.gone.id, { archived: true });
  db.query("DELETE FROM agent WHERE id = ?").run(gone.agent.id);
  const counts = Object.fromEntries(
    COUNTS.map((table) => [
      table,
      db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!
        .n,
    ]),
  );
  db.close();
  return { dataDir, chats, captain: captain.agent, ada: ada.agent, counts };
}

describe("0061-captain-conversation", () => {
  it("makes Captain's chat Captain's and the others groups of one, keeping all that points at them", async () => {
    const old = await oldHost();
    const db = openDatabase(databasePath(old.dataDir));
    // 0061 runs first; whatever came after it may follow.
    expect(applyMigrations(db, loadMigrations())[0]).toBe(MIGRATION);
    const rows = db
      .query<
        {
          id: string;
          kind: string;
          name: string;
          steward_id: string | null;
          archived: number;
        },
        []
      >("SELECT id, kind, name, steward_id, archived FROM conversation")
      .all();
    const row = (id: string) => rows.find((each) => each.id === id);
    expect(row(old.chats.captain.id)).toMatchObject({
      kind: "captain",
      name: "Captain",
      archived: 0,
    });
    expect(row(old.chats.ada.id)).toMatchObject({
      kind: "group",
      name: "Ada",
      steward_id: old.ada.id,
      archived: 0,
    });
    expect(row(old.chats.put.id)).toMatchObject({
      kind: "group",
      name: "Ada, earlier",
      steward_id: old.ada.id,
      archived: 1,
    });
    expect(row(old.chats.gone.id)).toMatchObject({
      kind: "group",
      steward_id: null,
      archived: 1,
    });
    expect(
      Object.fromEntries(
        COUNTS.map((table) => [
          table,
          db
            .query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`)
            .get()!.n,
        ]),
      ),
    ).toEqual(old.counts);
    expect(
      db
        .query<{ conversation_id: string }, []>(
          "SELECT conversation_id FROM task WHERE id = 't1'",
        )
        .get()?.conversation_id,
    ).toBe(old.chats.ada.id);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get(),
    ).toEqual({ foreign_keys: 1 });
    db.close();
  });

  it("talks in Ada's group of one and in Captain's conversation, and lists only the group", async () => {
    const old = await oldHost();
    const { models } = scriptedModels(() => say("here"));
    const w = await world({
      models,
      dataDir: old.dataDir,
      captain: true,
      tasks: { runs: false },
    });
    // Captain kept the conversation it had: the host made no other.
    expect(w.host.product.captain.identity()?.conversationId).toBe(
      old.chats.captain.id,
    );
    for (const [chat, agent] of [
      [old.chats.ada.id, old.ada.id],
      [old.chats.captain.id, old.captain.id],
    ] as const) {
      await w.watch(chat);
      expect(
        w.client.section<ConversationInfo>(`conversations.${chat}`, "info")
          ?.name,
      ).toBeDefined();
      const sent = await w.send(chat, "still there?");
      expect(sent.replies.map((reply) => reply.agentId)).toEqual([agent]);
      const ended = await w.settled(chat, sent.replies[0]!.id);
      expect([ended.status, ended.text]).toEqual(["done", "here"]);
      expect(w.rows(chat).some((m) => m.text.startsWith("said in"))).toBe(true);
    }
    await until(() =>
      (
        w.client.section<ConversationSummary[]>("conversations", "list") ?? []
      ).some((entry) => entry.id === old.chats.ada.id),
    );
    const listed = w.client
      .section<ConversationSummary[]>("conversations", "list")!
      .map((entry) => entry.id);
    expect(listed).not.toContain(old.chats.captain.id);
  });
});
