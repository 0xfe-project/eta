import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
/**
 * The product's database: `<dataDir>/eta.sqlite`, as `bun:sqlite` in this process.
 *
 * No server and no layer over it. Sessions stay files (the upstream store); what lives here is
 * the bookkeeping the product adds on top of them. The database is not a contract — the wire
 * protocol is — so the schema may change as long as a migration says how.
 *
 * Migrations are one flat numbered sequence of plain SQL, `src/migrations/NNNN-<name>.sql`,
 * applied in number order. A feature that needs a table adds the next number; there is no
 * per-feature directory to keep in step, and two branches that pick the same number collide
 * when they merge, not at runtime on somebody's data.
 */
import { Database } from "bun:sqlite";
import { resourcePath } from "./resources";

export interface Migration {
  /** The file name without `.sql`: `0001-agents`. The number orders it, the whole name identifies it. */
  id: string;
  sql: string;
}

/** The runner's own bookkeeping; it is not part of the product's schema. */
const MIGRATION_TABLE = "eta_migrations";

const MIGRATION_FILE = /^(\d{4})-[a-z0-9-]+\.sql$/;

const MIGRATIONS_DIR = resourcePath(
  "migrations",
  new URL("migrations/", import.meta.url),
);

/** Where a data directory keeps its database. */
export function databasePath(dataDir: string): string {
  return join(dataDir, "eta.sqlite");
}

/**
 * Open (creating if needed) the database at `path`, with the pragmas this process wants: WAL so
 * a reader does not block the writer, foreign keys on because they are the point of having
 * them, and a busy timeout so a second process (a migration run by hand, a test) waits rather
 * than failing outright.
 */
export function openDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/**
 * Every migration in a directory, in the order they have to run. A `.sql` file that is not
 * named `NNNN-<name>.sql`, or a number used twice, is an error: a migration the runner skips
 * silently is a table that is missing in production only.
 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations: Migration[] = [];
  const numbers = new Set<string>();
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".sql")) continue;
    const match = MIGRATION_FILE.exec(file);
    if (match === null) {
      throw new Error(`migration ${file} is not named NNNN-<name>.sql`);
    }
    const number = match[1] as string;
    if (numbers.has(number)) {
      throw new Error(`migration number ${number} is used more than once`);
    }
    numbers.add(number);
    migrations.push({
      id: file.replace(/\.sql$/, ""),
      sql: readFileSync(join(dir, file), "utf8"),
    });
  }
  return migrations;
}

/** Apply what has not run yet. Returns the ids it applied, which is empty on a second run. */
export function applyMigrations(
  db: Database,
  migrations: readonly Migration[],
): string[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
  );
  const done = new Set(
    db
      .query<{ id: string }, []>(`SELECT id FROM ${MIGRATION_TABLE}`)
      .all()
      .map((row) => row.id),
  );
  const applied: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.id)) continue;
    // One transaction per migration: a half-applied migration is a database nobody can reason
    // about, so the statements and the record of having run them land together or not at all.
    db.transaction(() => {
      db.exec(migration.sql);
      db.query(
        `INSERT INTO ${MIGRATION_TABLE} (id, applied_at) VALUES (?, ?)`,
      ).run(migration.id, new Date().toISOString());
    })();
    applied.push(migration.id);
  }
  return applied;
}
