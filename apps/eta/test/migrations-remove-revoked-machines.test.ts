/**
 * 0066, as an upgrade: legacy daemon machines left in `status = 'revoked'` are cleaned up
 * completely — open task runs targeting them (or owned by their pinned agents) are failed,
 * non-captain pinned agents are deleted (after archiving their `agent_home` projects on primary
 * so `ON DELETE SET NULL` never leaves orphaned external agents), stale participant pointers on
 * remaining conversations are cleared, and the revoked machine rows are deleted (cascading their
 * projects, conversations, messages, attachments, and places while preserving historical tasks,
 * artifacts, and enrollments with NULL foreign keys).
 */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  databasePath,
  loadMigrations,
  openDatabase,
} from "../src/db";
import { tempDir } from "./support/host";

const NEWEST = "0066-remove-revoked-machines";
const ALL = loadMigrations().filter((migration) => migration.id <= NEWEST);
const BEFORE = ALL.filter((migration) => migration.id < NEWEST);

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

async function pre0066Database(): Promise<Database> {
  const db = openDatabase(databasePath(join(await tempDir(), "eta.sqlite")));
  open.push(db);
  applyMigrations(db, BEFORE);
  const now = Date.now();

  db.query(
    "INSERT INTO machine (id, kind, name, status, created_at) VALUES ('m-primary', 'primary', 'desk', 'online', ?)",
  ).run(now);
  db.query(
    "INSERT INTO machine (id, kind, name, status, created_at) VALUES ('m-online', 'daemon', 'worker', 'online', ?)",
  ).run(now);
  db.query(
    "INSERT INTO machine (id, kind, name, status, created_at) VALUES ('m-revoked', 'daemon', 'old-box', 'revoked', ?)",
  ).run(now);

  const insertAgent = db.query(
    `INSERT INTO agent (id, name, instructions, persona, runtime, model, machine_id, system_role, created_at, updated_at)
     VALUES (?, ?, '', '', ?, NULL, ?, ?, ?, ?)`,
  );
  insertAgent.run("a-captain", "Captain", "eta", null, "captain", now, now);
  insertAgent.run("a-eta-free", "Ada", "eta", null, null, now, now);
  insertAgent.run(
    "a-eta-pinned",
    "PinnedAda",
    "eta",
    "m-revoked",
    null,
    now,
    now,
  );
  insertAgent.run(
    "a-ext-pinned",
    "RevokedClaude",
    "claude",
    "m-revoked",
    null,
    now,
    now,
  );
  insertAgent.run(
    "a-ext-online",
    "LiveCodex",
    "codex",
    "m-online",
    null,
    now,
    now,
  );

  // agent_home projects live on primary.
  db.query(
    `INSERT INTO project (id, machine_id, path, name, kind, owner_agent_id, archived, created_at, updated_at)
     VALUES (?, 'm-primary', ?, ?, 'agent_home', ?, 0, ?, ?)`,
  ).run(
    "p-home-eta",
    "/agents/a-eta-pinned",
    "PinnedAda",
    "a-eta-pinned",
    now,
    now,
  );
  db.query(
    `INSERT INTO project (id, machine_id, path, name, kind, owner_agent_id, archived, created_at, updated_at)
     VALUES (?, 'm-primary', ?, ?, 'agent_home', ?, 0, ?, ?)`,
  ).run(
    "p-home-ext",
    "/agents/a-ext-pinned",
    "RevokedClaude",
    "a-ext-pinned",
    now,
    now,
  );

  // Regular projects on primary and revoked daemon.
  db.query(
    "INSERT INTO project (id, machine_id, path, name, created_at, updated_at) VALUES ('p-primary', 'm-primary', '/primary/repo', 'primary-repo', ?, ?)",
  ).run(now, now);
  db.query(
    "INSERT INTO project (id, machine_id, path, name, created_at, updated_at) VALUES ('p-revoked', 'm-revoked', '/revoked/repo', 'revoked-repo', ?, ?)",
  ).run(now, now);

  // Conversations on primary and revoked daemon.
  db.query(
    "INSERT INTO conversation (id, project_id, kind, name, created_at, updated_at) VALUES ('c-primary', 'p-primary', 'group', 'primary-chat', ?, ?)",
  ).run(now, now);
  db.query(
    "INSERT INTO conversation (id, project_id, kind, name, created_at, updated_at) VALUES ('c-revoked', 'p-revoked', 'group', 'revoked-chat', ?, ?)",
  ).run(now, now);

  // Participant on primary referencing revoked machine (with stale session + pending settings).
  db.query(
    `INSERT INTO participant (conversation_id, agent_id, session_id, machine_id, pending_settings, last_seq, invited_at)
     VALUES ('c-primary', 'a-eta-free', 'sess-stale', 'm-revoked', '{"model":"x"}', 1, ?)`,
  ).run(now);
  db.query(
    `INSERT INTO participant (conversation_id, agent_id, session_id, machine_id, last_seq, invited_at)
     VALUES ('c-revoked', 'a-ext-pinned', 'sess-revoked', 'm-revoked', 1, ?)`,
  ).run(now);

  // Messages & attachments on revoked conversation.
  db.query(
    `INSERT INTO message (id, conversation_id, seq, kind, author, agent_id, text, created_at, updated_at)
     VALUES ('m-revoked-msg', 'c-revoked', 1, 'message', 'user', NULL, 'hi', ?, ?)`,
  ).run(now, now);
  db.query(
    `INSERT INTO attachment (id, conversation_id, name, content_type, size, message_id, created_at)
     VALUES ('att-revoked', 'c-revoked', 'a.txt', 'text/plain', 2, 'm-revoked-msg', ?)`,
  ).run(now);

  // Places on revoked machine and online machine.
  db.query(
    "INSERT INTO place_recent (machine_id, path, used_at) VALUES ('m-revoked', '/revoked/repo', ?)",
  ).run(now);
  db.query(
    "INSERT INTO place_clone_parent (machine_id, path, updated_at) VALUES ('m-revoked', '/revoked', ?)",
  ).run(now);
  db.query(
    "INSERT INTO place_recent (machine_id, path, used_at) VALUES ('m-online', '/online/repo', ?)",
  ).run(now);

  // Machine enrollment pointing to revoked machine.
  db.query(
    "INSERT INTO machine_enrollment (id, code_digest, name, created_at, expires_at, used_at, machine_id) VALUES ('enr-1', 'digest-1', 'old-box', ?, ?, ?, 'm-revoked')",
  ).run(now, now + 1000, now);

  // Historical task + artifact pointing to revoked project/conversation, plus open & completed task runs.
  db.query(
    `INSERT INTO task (id, title, status, created_by_agent, assignee_agent, conversation_id, project_id, origin_conversation_id, created_at, updated_at)
     VALUES ('t-revoked', 'Legacy work', 'in_progress', 'a-eta-free', 'a-ext-pinned', 'c-revoked', 'p-revoked', 'c-revoked', ?, ?)`,
  ).run(now, now);
  db.query(
    `INSERT INTO artifact (id, title, publisher_agent, task_id, conversation_id, created_at, updated_at)
     VALUES ('art-1', 'Site', 'a-ext-pinned', 't-revoked', 'c-revoked', ?, ?)`,
  ).run(now, now);

  db.query(
    `INSERT INTO task_run (id, task_id, machine_id, agent_id, status, queue_reason, created_at, last_event_at)
     VALUES ('run-queued', 't-revoked', 'm-revoked', NULL, 'queued', 'machine_offline', ?, ?)`,
  ).run(now, now);
  db.query(
    `INSERT INTO task_run (id, task_id, machine_id, agent_id, status, created_at, started_at, last_event_at)
     VALUES ('run-running', 't-revoked', 'm-online', 'a-ext-pinned', 'running', ?, ?, ?)`,
  ).run(now, now, now);
  db.query(
    `INSERT INTO task_run (id, task_id, machine_id, agent_id, status, created_at, started_at, finished_at, last_event_at)
     VALUES ('run-done', 't-revoked', 'm-revoked', NULL, 'completed', ?, ?, ?, ?)`,
  ).run(now, now, now, now);

  return db;
}

describe("0066-remove-revoked-machines", () => {
  it("removes legacy revoked machines and cleans up pinned agents, open runs, sessions, and cascaded records", async () => {
    const db = await pre0066Database();
    expect(applyMigrations(db, ALL)).toEqual([NEWEST]);

    // Revoked machine is gone; primary and online daemon stay.
    expect(
      db
        .query<{ id: string }, []>("SELECT id FROM machine ORDER BY id")
        .all()
        .map((r) => r.id),
    ).toEqual(["m-online", "m-primary"]);

    // Non-captain agents pinned to m-revoked are deleted; captain and others remain.
    expect(
      db
        .query<{ id: string }, []>("SELECT id FROM agent ORDER BY id")
        .all()
        .map((r) => r.id),
    ).toEqual(["a-captain", "a-eta-free", "a-ext-online"]);

    // Home projects of deleted agents are archived on primary.
    expect(
      db
        .query<
          { id: string; archived: number; owner_agent_id: string | null },
          []
        >(
          "SELECT id, archived, owner_agent_id FROM project WHERE kind = 'agent_home' ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: "p-home-eta", archived: 1, owner_agent_id: null },
      { id: "p-home-ext", archived: 1, owner_agent_id: null },
    ]);

    // Revoked machine's project, conversation, messages, attachments, and places cascaded away.
    expect(
      db
        .query<{ id: string }, []>(
          "SELECT id FROM project WHERE id = 'p-revoked'",
        )
        .get(),
    ).toBeNull();
    expect(
      db
        .query<{ id: string }, []>(
          "SELECT id FROM conversation WHERE id = 'c-revoked'",
        )
        .get(),
    ).toBeNull();
    expect(
      db
        .query<{ id: string }, []>(
          "SELECT id FROM message WHERE id = 'm-revoked-msg'",
        )
        .get(),
    ).toBeNull();
    expect(
      db
        .query<{ id: string }, []>(
          "SELECT id FROM attachment WHERE id = 'att-revoked'",
        )
        .get(),
    ).toBeNull();
    expect(
      db
        .query<{ machine_id: string }, []>(
          "SELECT machine_id FROM place_recent",
        )
        .all()
        .map((r) => r.machine_id),
    ).toEqual(["m-online"]);
    expect(
      db
        .query<{ machine_id: string }, []>(
          "SELECT machine_id FROM place_clone_parent",
        )
        .all(),
    ).toEqual([]);

    // Participant on primary had stale session & pending_settings cleared.
    expect(
      db
        .query<
          {
            session_id: string | null;
            machine_id: string | null;
            pending_settings: string | null;
          },
          []
        >(
          "SELECT session_id, machine_id, pending_settings FROM participant WHERE conversation_id = 'c-primary' AND agent_id = 'a-eta-free'",
        )
        .get(),
    ).toEqual({
      session_id: null,
      machine_id: null,
      pending_settings: null,
    });

    // Open runs targeting revoked machine or deleted agent failed; completed run stayed completed.
    expect(
      db
        .query<
          {
            id: string;
            status: string;
            queue_reason: string | null;
            error: string | null;
            finished_at: number | null;
          },
          []
        >(
          "SELECT id, status, queue_reason, error, finished_at FROM task_run ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "run-done",
        status: "completed",
        queue_reason: null,
        error: null,
        finished_at: expect.any(Number),
      },
      {
        id: "run-queued",
        status: "failed",
        queue_reason: null,
        error: "Machine was removed.",
        finished_at: expect.any(Number),
      },
      {
        id: "run-running",
        status: "failed",
        queue_reason: null,
        error: "Machine was removed.",
        finished_at: expect.any(Number),
      },
    ]);

    // Historical task, artifact, and enrollment preserved with NULL references.
    expect(
      db
        .query<
          {
            project_id: string | null;
            conversation_id: string | null;
            origin_conversation_id: string | null;
          },
          []
        >(
          "SELECT project_id, conversation_id, origin_conversation_id FROM task WHERE id = 't-revoked'",
        )
        .get(),
    ).toEqual({
      project_id: null,
      conversation_id: null,
      origin_conversation_id: null,
    });
    expect(
      db
        .query<{ conversation_id: string | null }, []>(
          "SELECT conversation_id FROM artifact WHERE id = 'art-1'",
        )
        .get(),
    ).toEqual({ conversation_id: null });
    expect(
      db
        .query<{ machine_id: string | null }, []>(
          "SELECT machine_id FROM machine_enrollment WHERE id = 'enr-1'",
        )
        .get(),
    ).toEqual({ machine_id: null });

    // No broken foreign keys.
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
