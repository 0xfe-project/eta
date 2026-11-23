/**
 * The plugin tables (plugin_disabled, plugin_header, plugin_env, market_catalog_cache, plugin_icon,
 * plugin_token_header, cursor_credential) come from one migration, 0061-plugins. A database that
 * already ran the first six as separate migrations (0061-plugin-disabled to 0066-plugin-token-header)
 * runs it once more: the tables are made only where they are missing, so it adds cursor_credential
 * and changes nothing else.
 */
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  loadMigrations,
  openDatabase,
  type Migration,
} from "../src/db";

/** What the seven tables looked like as separate migrations; the merged one has to make the same. */
const TABLES: Record<string, string> = {
  plugin_disabled: `CREATE TABLE plugin_disabled (
  plugin TEXT PRIMARY KEY
)`,
  plugin_header: `CREATE TABLE plugin_header (
  plugin TEXT NOT NULL,
  server TEXT NOT NULL,
  name_lc TEXT NOT NULL,
  name TEXT NOT NULL,
  sealed BLOB NOT NULL,
  secret INTEGER NOT NULL,
  plain_ok INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin, server, name_lc)
)`,
  plugin_env: `CREATE TABLE plugin_env (
  plugin TEXT NOT NULL,
  server TEXT NOT NULL,
  name TEXT NOT NULL,
  sealed BLOB NOT NULL,
  secret INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin, server, name)
)`,
  market_catalog_cache: `CREATE TABLE market_catalog_cache (
  url TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  fetched_at INTEGER NOT NULL,
  used_at INTEGER NOT NULL,
  size INTEGER NOT NULL
)`,
  plugin_icon: `CREATE TABLE plugin_icon (
  repo TEXT NOT NULL,
  ref TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  mime TEXT,
  data BLOB,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (repo, ref, path)
)`,
  plugin_token_header: `CREATE TABLE plugin_token_header (
  plugin TEXT NOT NULL,
  server TEXT NOT NULL,
  name TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('raw', 'bearer')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin, server)
)`,
  cursor_credential: `CREATE TABLE cursor_credential (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sealed BLOB NOT NULL,
  updated_at INTEGER NOT NULL
)`,
};
/** The six that 0061 to 0066 made, in the order they were made, under the ids they ran as. */
const OLD_IDS = [
  ["0061-plugin-disabled", "plugin_disabled"],
  ["0062-plugin-headers", "plugin_header"],
  ["0063-plugin-env", "plugin_env"],
  ["0064-market-cache", "market_catalog_cache"],
  ["0065-plugin-icon", "plugin_icon"],
  ["0066-plugin-token-header", "plugin_token_header"],
] as const;

const shipped = (): Migration[] => loadMigrations();
const number = (migration: Migration) => migration.id.slice(0, 4);
const ddl = (db: ReturnType<typeof openDatabase>, name: string) =>
  (
    db
      .query<{ sql: string }, [string]>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name)?.sql ?? ""
  ).replace(/\r/g, "");

describe("the plugin tables' migration", () => {
  it("is one migration, numbered 0061", () => {
    expect(
      shipped()
        .filter((migration) => number(migration) >= "0061")
        .map((migration) => migration.id),
    ).toEqual(["0061-plugins"]);
  });

  it("makes the seven tables on a new database, as they were made before", () => {
    const db = openDatabase(":memory:");
    applyMigrations(db, shipped());
    for (const [name, sql] of Object.entries(TABLES)) {
      expect(ddl(db, name), name).toBe(sql);
    }
  });

  it("runs on a database that already ran 0061 to 0066, adds cursor_credential and keeps the rows", () => {
    const db = openDatabase(":memory:");
    // The database as the test home has it: everything up to 0060, then the six old migrations.
    const before = shipped().filter((migration) => number(migration) <= "0060");
    applyMigrations(db, before);
    db.exec(
      "CREATE TABLE IF NOT EXISTS eta_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    for (const [id, table] of OLD_IDS) {
      db.exec(TABLES[table]!);
      db.query("INSERT INTO eta_migrations (id, applied_at) VALUES (?, ?)").run(
        id,
        "2026-11-22T00:00:00.000Z",
      );
    }
    db.query("INSERT INTO plugin_disabled (plugin) VALUES ('hello')").run();
    db.query(
      "INSERT INTO plugin_token_header (plugin, server, name, format, updated_at) VALUES ('p', 's', 'x-token', 'bearer', 1)",
    ).run();
    expect(ddl(db, "cursor_credential")).toBe("");

    expect(applyMigrations(db, shipped())).toEqual(["0061-plugins"]);

    for (const [name, sql] of Object.entries(TABLES)) {
      expect(ddl(db, name), name).toBe(sql);
    }
    expect(db.query("SELECT plugin FROM plugin_disabled").all()).toEqual([
      { plugin: "hello" },
    ]);
    expect(
      db
        .query("SELECT plugin, server, name, format FROM plugin_token_header")
        .all(),
    ).toEqual([
      { plugin: "p", server: "s", name: "x-token", format: "bearer" },
    ]);
    // The old rows stay; the merged id is added next to them.
    expect(
      db
        .query<{ id: string }, []>(
          "SELECT id FROM eta_migrations WHERE id >= '0061' ORDER BY id",
        )
        .all()
        .map((row) => row.id),
    ).toEqual([...OLD_IDS.map(([id]) => id), "0061-plugins"]);
    // And a second start has nothing left to do.
    expect(applyMigrations(db, shipped())).toEqual([]);
  });
});
