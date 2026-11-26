/**
 * 0065, as an upgrade: legacy external-runtime agents (`runtime != 'eta'`) have any non-empty
 * `persona` cleared and any `machine_id IS NULL` pinned to the primary machine (when present),
 * while built-in `eta` agents and existing `participant` rows are untouched.
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

const NEWEST = "0065-external-runtime-bounds";
const ALL = loadMigrations().filter((migration) => migration.id <= NEWEST);
const BEFORE = ALL.filter((migration) => migration.id < NEWEST);

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

async function pre0065Database(withPrimary: boolean): Promise<Database> {
  const db = openDatabase(databasePath(join(await tempDir(), "eta.sqlite")));
  open.push(db);
  applyMigrations(db, BEFORE);
  const now = Date.now();
  if (withPrimary) {
    db.query(
      "INSERT INTO machine (id, kind, name, created_at) VALUES ('m-primary', 'primary', 'desk', ?)",
    ).run(now);
  }
  db.query(
    "INSERT INTO machine (id, kind, name, status, created_at) VALUES ('m-daemon', 'daemon', 'gpu', 'online', ?)",
  ).run(now);

  const insertAgent = db.query(
    `INSERT INTO agent (id, name, instructions, persona, runtime, model, machine_id, created_at, updated_at)
     VALUES (?, ?, '', ?, ?, NULL, ?, ?, ?)`,
  );
  insertAgent.run("a-eta", "Ada", "writer", "eta", null, now, now);
  insertAgent.run("a-claude", "Cody", "reviewer", "claude", null, now, now);
  insertAgent.run(
    "a-acp-pinned",
    "Ace",
    "architect",
    "acp.fake",
    "m-daemon",
    now,
    now,
  );
  insertAgent.run("a-acp-null", "FloatingAcp", "", "acp.other", null, now, now);

  db.query(
    "INSERT INTO project (id, machine_id, path, name, created_at, updated_at) VALUES ('p-daemon', 'm-daemon', '/repo', 'repo', ?, ?)",
  ).run(now, now);
  db.query(
    "INSERT INTO conversation (id, project_id, kind, name, created_at, updated_at) VALUES ('c-daemon', 'p-daemon', 'group', 'repo', ?, ?)",
  ).run(now, now);
  db.query(
    "INSERT INTO participant (conversation_id, agent_id, last_seq, invited_at) VALUES ('c-daemon', 'a-claude', 0, ?)",
  ).run(now);
  return db;
}

describe("0065-external-runtime-bounds", () => {
  it("clears personas and pins unpinned external agents to primary while keeping participants and eta intact", async () => {
    const db = await pre0065Database(true);
    expect(applyMigrations(db, ALL)).toEqual([NEWEST]);

    const rows = db
      .query<
        {
          id: string;
          persona: string;
          runtime: string;
          machine_id: string | null;
        },
        []
      >("SELECT id, persona, runtime, machine_id FROM agent ORDER BY id")
      .all();
    expect(rows).toEqual([
      {
        id: "a-acp-null",
        persona: "",
        runtime: "acp.other",
        machine_id: "m-primary",
      },
      {
        id: "a-acp-pinned",
        persona: "",
        runtime: "acp.fake",
        machine_id: "m-daemon",
      },
      {
        id: "a-claude",
        persona: "",
        runtime: "claude",
        machine_id: "m-primary",
      },
      { id: "a-eta", persona: "writer", runtime: "eta", machine_id: null },
    ]);

    // Participant history stays intact.
    expect(
      db
        .query<{ agent_id: string }, []>(
          "SELECT agent_id FROM participant WHERE conversation_id = 'c-daemon'",
        )
        .all()
        .map((r) => r.agent_id),
    ).toEqual(["a-claude"]);
  });

  it("still clears external personas even when no primary machine row exists yet", async () => {
    const db = await pre0065Database(false);
    expect(applyMigrations(db, ALL)).toEqual([NEWEST]);

    const cody = db
      .query<{ persona: string; machine_id: string | null }, []>(
        "SELECT persona, machine_id FROM agent WHERE id = 'a-claude'",
      )
      .get()!;
    expect(cody).toEqual({ persona: "", machine_id: null });
  });
});
