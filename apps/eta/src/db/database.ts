import { Database } from "bun:sqlite";
/**
 * The database file (REFACTOR.md §7.1): `<dataDir>/db/eta.sqlite`.
 *
 * SQLite, in this process, as `bun:sqlite` — no server, no abstraction over it. The database is
 * not a contract (REFACTOR.md §3, invariant 5): the API and the files are. Sessions stay jsonl
 * files next to it; what lives here is the product's bookkeeping.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Where a data directory keeps its database. */
export function databasePath(dataDir: string): string {
  return join(dataDir, "db", "eta.sqlite");
}

/**
 * Open (creating if needed) the database at `path`, with the pragmas this process wants:
 * WAL so a reader does not block the writer, foreign keys on because they are the point of
 * having them, and a busy timeout so a second process (a migration run by hand, a test) waits
 * rather than failing outright.
 */
export async function openDatabase(path: string): Promise<Database> {
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}
