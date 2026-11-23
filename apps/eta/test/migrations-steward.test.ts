/**
 * 0055, as an upgrade: stewards stop being a project's and become each group's own, a member or
 * nobody, and an agent's workspace says whose it is in a column of its own.
 *
 * The rows are written with the INSERTs a 0.4 host made (`project.steward_id`, `conversation
 * .steward_id` NULL for "follow the project", `no_steward`), in every combination a real database
 * holds. The promise checked is the task's: a message that names nobody goes to the same agent as
 * before, except that nobody is pulled into a group for it any more.
 */
import type { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectMachinesOf } from "../src/acp/service";
import { AgentStore } from "../src/agents/store";
import { CaptainMemory } from "../src/captain/memory";
import { routeUserMessage } from "../src/conversations/routing";
import { ConversationStore } from "../src/conversations/store";
import {
  applyMigrations,
  databasePath,
  loadMigrations,
  openDatabase,
} from "../src/db";
import { ProjectStore } from "../src/projects/store";
import { tempDir } from "./support/host";

const NEWEST = "0055-steward-only-in-groups";
// The migrations as far as 0055: what came after it (0056-places) is not this test's business.
const ALL = loadMigrations().filter((migration) => migration.id <= NEWEST);
const BEFORE = ALL.filter((migration) => migration.id < NEWEST);

const open: Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

async function oldDatabase(): Promise<Database> {
  const db = openDatabase(databasePath(join(await tempDir(), "data")));
  open.push(db);
  expect(applyMigrations(db, BEFORE).at(-1)).toBe("0054-task-archive");
  return db;
}

interface Case {
  name: string;
  kind: "group" | "direct";
  project: string;
  /** The conversation's own pick, NULL to follow the project. */
  own: string | null;
  noSteward: boolean;
  members: string[];
}

/** Who a message naming nobody woke on a 0.4 host, and whether it pulled that one in first. */
function before(
  db: Database,
  conversationId: string,
): { targets: string[]; pulledIn: boolean } {
  const row = db
    .query<
      {
        kind: "group" | "direct";
        steward_id: string | null;
        no_steward: number;
        project_steward: string | null;
      },
      [string]
    >(
      `SELECT c.kind, c.steward_id, c.no_steward, p.steward_id AS project_steward
         FROM conversation AS c JOIN project AS p ON p.id = c.project_id WHERE c.id = ?`,
    )
    .get(conversationId)!;
  const members = membersOf(db, conversationId);
  if (row.kind === "direct")
    return { targets: members.slice(0, 1), pulledIn: false };
  const steward =
    row.no_steward === 1 ? null : (row.steward_id ?? row.project_steward);
  if (steward !== null)
    return { targets: [steward], pulledIn: !members.includes(steward) };
  return { targets: members.length === 1 ? members : [], pulledIn: false };
}

function membersOf(db: Database, conversationId: string): string[] {
  return db
    .query<{ agent_id: string }, [string]>(
      "SELECT agent_id FROM participant WHERE conversation_id = ? ORDER BY rowid",
    )
    .all(conversationId)
    .map((row) => row.agent_id);
}

/** Who it wakes now, through the routing the engine runs. */
function after(db: Database, conversationId: string): string[] {
  const conversation = new ConversationStore(db).get(conversationId)!;
  return routeUserMessage({
    members: membersOf(db, conversationId),
    mentions: [],
    steward: conversation.stewardId,
  }).targets;
}

describe("0055-steward-only-in-groups", () => {
  it("keeps who takes a message that names nobody, and only stops pulling anyone in", async () => {
    const db = await oldDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO machine (id, kind, name, created_at) VALUES ('m1', 'primary', 'box', 1)`,
    );
    for (const id of ["ada", "bob", "cy", "dee"])
      db.query(
        "INSERT INTO agent (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      ).run(id, id, now, now);
    const project = db.query(
      `INSERT INTO project (id, machine_id, path, name, kind, steward_id, created_at, updated_at)
       VALUES (?, 'm1', ?, ?, ?, ?, ?, ?)`,
    );
    project.run("led", "/work/led", "led", "project", "ada", now, now);
    project.run("open", "/work/open", "open", "project", null, now, now);
    project.run("home-ada", "/data/ada", "ada", "agent_home", "ada", now, now);
    project.run("home-dee", "/data/dee", "dee", "agent_home", "dee", now, now);

    const cases: Case[] = [
      // The group's own steward, a member.
      {
        name: "own",
        kind: "group",
        project: "led",
        own: "bob",
        noSteward: false,
        members: ["ada", "bob"],
      },
      // Following the project, whose steward is a member.
      {
        name: "follows",
        kind: "group",
        project: "led",
        own: null,
        noSteward: false,
        members: ["bob", "ada"],
      },
      // Following the project, whose steward is not a member: it was pulled in.
      {
        name: "follows-outsider",
        kind: "group",
        project: "led",
        own: null,
        noSteward: false,
        members: ["bob", "cy"],
      },
      {
        name: "follows-outsider-solo",
        kind: "group",
        project: "led",
        own: null,
        noSteward: false,
        members: ["cy"],
      },
      // Its own steward, who left (an older host did not clear it): it was pulled back in.
      {
        name: "own-left",
        kind: "group",
        project: "led",
        own: "dee",
        noSteward: false,
        members: ["ada", "bob"],
      },
      // Said it has none, in a project that has one.
      {
        name: "none",
        kind: "group",
        project: "led",
        own: null,
        noSteward: true,
        members: ["ada", "bob"],
      },
      {
        name: "none-solo",
        kind: "group",
        project: "led",
        own: null,
        noSteward: true,
        members: ["ada"],
      },
      // A project with no steward at all.
      {
        name: "open",
        kind: "group",
        project: "open",
        own: null,
        noSteward: false,
        members: ["ada", "bob"],
      },
      {
        name: "open-solo",
        kind: "group",
        project: "open",
        own: null,
        noSteward: false,
        members: ["cy"],
      },
      // An agent's private chat, in its own workspace.
      {
        name: "direct",
        kind: "direct",
        project: "home-ada",
        own: null,
        noSteward: false,
        members: ["ada"],
      },
    ];
    const conversation = db.query(
      `INSERT INTO conversation (id, project_id, kind, name, steward_id, no_steward, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const participant = db.query(
      "INSERT INTO participant (conversation_id, agent_id, invited_at) VALUES (?, ?, ?)",
    );
    for (const c of cases) {
      conversation.run(
        c.name,
        c.project,
        c.kind,
        c.name,
        c.own,
        c.noSteward ? 1 : 0,
        now,
        now,
      );
      for (const agentId of c.members) participant.run(c.name, agentId, now);
    }
    const was = new Map(cases.map((c) => [c.name, before(db, c.name)]));
    // The shape is the old one, and the combinations are the ones meant.
    expect(Object.fromEntries(was)).toEqual({
      own: { targets: ["bob"], pulledIn: false },
      follows: { targets: ["ada"], pulledIn: false },
      "follows-outsider": { targets: ["ada"], pulledIn: true },
      "follows-outsider-solo": { targets: ["ada"], pulledIn: true },
      "own-left": { targets: ["dee"], pulledIn: true },
      none: { targets: [], pulledIn: false },
      "none-solo": { targets: ["ada"], pulledIn: false },
      open: { targets: [], pulledIn: false },
      "open-solo": { targets: ["cy"], pulledIn: false },
      direct: { targets: ["ada"], pulledIn: false },
    });

    expect(applyMigrations(db, ALL)).toEqual([NEWEST]);

    for (const c of cases) {
      const old = was.get(c.name)!;
      // Nobody joined anything.
      expect(membersOf(db, c.name), c.name).toEqual(c.members);
      if (!old.pulledIn) {
        // The same agent as before.
        expect(after(db, c.name), c.name).toEqual(old.targets);
      } else {
        // The outsider is not woken: the group's own rule decides, among its members.
        expect(after(db, c.name), c.name).toEqual(
          c.members.length === 1 ? c.members : [],
        );
      }
    }
    // What each conversation now says its steward is: a member, or nobody.
    expect(
      Object.fromEntries(
        new ConversationStore(db)
          .list()
          .map((record) => [record.id, record.stewardId]),
      ),
    ).toEqual({
      own: "bob",
      follows: "ada",
      "follows-outsider": null,
      "follows-outsider-solo": null,
      "own-left": null,
      none: null,
      "none-solo": null,
      open: null,
      "open-solo": null,
      direct: "ada",
    });
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM pragma_table_info('conversation') WHERE name = 'no_steward'",
        )
        .all(),
    ).toEqual([]);

    // A project says whose workspace it is, and nothing about stewards.
    expect(
      new ProjectStore(db)
        .list()
        .map((p) => [p.id, p.ownerAgentId])
        .sort(),
    ).toEqual([
      ["home-ada", "ada"],
      ["home-dee", "dee"],
      ["led", null],
      ["open", null],
    ]);
    // The reference to the agent came through the rename: deleting one clears its workspace's owner.
    db.run("DELETE FROM agent WHERE id = 'dee'");
    expect(new ProjectStore(db).get("home-dee")?.ownerAgentId).toBeNull();
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("keeps an agent's workspace found for Captain's memory and for the machines its runtime is listed on", async () => {
    const db = await oldDatabase();
    const now = Date.now();
    db.run(
      `INSERT INTO machine (id, kind, name, created_at) VALUES ('m1', 'primary', 'box', 1), ('m2', 'daemon', 'gpu', 1)`,
    );
    db.query(
      "INSERT INTO agent (id, name, created_at, updated_at) VALUES ('ada', 'Ada', ?, ?)",
    ).run(now, now);
    // Ada's workspace is on the daemon's machine, at a path that is not where this host keeps
    // workspaces: only the project's owner can say it is hers. She is in no conversation.
    const home = await tempDir("eta-old-home-");
    await mkdir(join(home, ".eta"), { recursive: true });
    await writeFile(
      join(home, ".eta", "MEMORY.md"),
      "# eta memory (untrusted)\n## decision\n- Ship on Fridays\n",
    );
    db.query(
      `INSERT INTO project (id, machine_id, path, name, kind, steward_id, created_at, updated_at)
       VALUES ('home-ada', 'm2', ?, 'Ada', 'agent_home', 'ada', ?, ?)`,
    ).run(home, now, now);
    // A project she stewarded is not hers.
    db.query(
      `INSERT INTO project (id, machine_id, path, name, kind, steward_id, created_at, updated_at)
       VALUES ('led', 'm1', '/work/led', 'led', 'project', 'ada', ?, ?)`,
    ).run(now, now);

    applyMigrations(db, ALL);

    const projects = new ProjectStore(db);
    const conversations = new ConversationStore(db);
    expect([...projectMachinesOf({ projects, conversations }, "ada")]).toEqual([
      "m2",
    ]);
    // The current store reads the current schema: bring the rest of the migrations in first.
    applyMigrations(db, loadMigrations());
    const memory = new CaptainMemory({
      db,
      dataDir: await tempDir("eta-other-data-"),
      agents: new AgentStore(db),
      projects,
      conversations,
    });
    expect(
      (await memory.list("ada")).map((item) => [item.text, item.source]),
    ).toEqual([["Ship on Fridays", "agent"]]);
  });
});
