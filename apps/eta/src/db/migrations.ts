import type { Database } from "bun:sqlite";
/**
 * Migrations: plain SQL files, one directory per part of the product.
 *
 *   src/db/migrations/<group>/<number>-<name>.sql
 *
 * The group is what the migration belongs to (agents, tasks, groups…), and migrations are
 * applied in group-then-file order — so a module's migrations stay with that module instead of
 * accumulating in one growing file (REFACTOR.md §9, P0.4). Each migration runs in its own
 * transaction: either the statements and the record of having run them both land, or neither
 * does.
 *
 * The bookkeeping table is this runner's own (`eta_migrations`); it is not part of the product's
 * schema and nothing else reads it.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Migration {
  /** `agents/0001-agents`, from the file's path. */
  id: string;
  sql: string;
}

const MIGRATION_TABLE = "eta_migrations";

const DEFAULT_ROOT = fileURLToPath(new URL("./migrations/", import.meta.url));

/**
 * Every migration on disk, in the order they have to run.
 *
 * The root sits next to this module, so the files ship with the code. When P0.9 bundles the app
 * for txiki, these `.sql` files have to be inlined or copied next to the bundle — the loader
 * reads them at runtime on purpose, so a migration stays reviewable as SQL.
 */
export async function loadMigrations(
  root: string = DEFAULT_ROOT,
): Promise<Migration[]> {
  const groups = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const migrations: Migration[] = [];
  for (const group of groups) {
    const files = (await readdir(join(root, group)))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const file of files) {
      migrations.push({
        id: `${group}/${file.replace(/\.sql$/, "")}`,
        sql: await readFile(join(root, group, file), "utf8"),
      });
    }
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
    (
      db.query(`SELECT id FROM ${MIGRATION_TABLE}`).all() as { id: string }[]
    ).map((row) => row.id),
  );

  const applied: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.id)) continue;
    // One transaction per migration: a half-applied migration is a database nobody can
    // reason about, and the runner must never record one as done.
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

/** The last migration that ran, or `undefined` on a database that has never been migrated. */
export function schemaVersion(db: Database): string | undefined {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
  );
  // Ordered by rowid, not by timestamp: two migrations applied in the same run share a
  // millisecond, and "the last one that ran" is the order they ran in, not their names.
  const row = db
    .query(`SELECT id FROM ${MIGRATION_TABLE} ORDER BY rowid DESC LIMIT 1`)
    .get() as { id: string } | null;
  return row?.id;
}
