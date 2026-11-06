/**
 * What an upgrade asks of the database: a backup and its way back, which migrations have run, and
 * whether an agent is working.
 *
 * A migration may not be reversible (0042 drops a column the old host writes), so going back to an
 * old build means going back to its database as well. `VACUUM INTO` writes one consistent file,
 * with the write-ahead log folded in, even under a running host.
 *
 * All of it is read from another process, while the host may be up: the host's own connection and
 * its pragmas are not involved.
 */
import type { UpgradeBusy } from "@eta/client-contracts";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { databasePath } from "../db";
import { SettingStore } from "../inbox/setting";
import { UPSTREAM_SETTING } from "./upstream";

/** Backups kept in `<dataDir>/backups`, newest first; each is as big as the database. */
export const BACKUPS_KEPT = 3;

const BACKUP_FILE = /^upgrade-.+\.sqlite$/;

/** The database a backup goes beside: `~/.eta/backups/upgrade-<when>-<from version>.sqlite`. */
const backupDir = (dataDir: string): string => join(dataDir, "backups");

function readonly<T>(dataDir: string, read: (db: Database) => T): T {
  const db = new Database(databasePath(dataDir), { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return read(db);
  } finally {
    db.close();
  }
}

/**
 * The upstream saved in the settings, for a process that is not the host. Only a database that has
 * no settings yet comes to nothing: anything else has to stop an upgrade, or one that could not
 * read this would go on to some other repository's code.
 */
export function savedUpstream(dataDir: string): string | undefined {
  if (!existsSync(databasePath(dataDir))) return undefined;
  try {
    const saved = readonly(dataDir, (db) =>
      new SettingStore(db).get(UPSTREAM_SETTING),
    );
    return typeof saved === "string" ? saved : undefined;
  } catch (error) {
    if (error instanceof Error && error.message.includes("no such table"))
      return undefined;
    throw error;
  }
}

/** Copy the database aside, leaving the newest few. Undefined when there is none yet. */
export function backupDatabase(
  dataDir: string,
  from: string,
  now: Date = new Date(),
): string | undefined {
  if (!existsSync(databasePath(dataDir))) return undefined;
  const dir = backupDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[-:]|\.\d+/g, "");
  const path = join(
    dir,
    `upgrade-${stamp}-${from.replace(/[^\w.-]/g, "_")}.sqlite`,
  );
  readonly(dataDir, (db) => db.query("VACUUM INTO ?").run(path));
  chmodSync(path, 0o600);
  // The file is what a failed upgrade comes back to, so it is read before anything depends on it.
  const copy = new Database(path, { readonly: true });
  try {
    const check = copy.query<{ quick_check: string }, []>("PRAGMA quick_check");
    const verdict = check.get()?.quick_check;
    if (verdict !== "ok")
      throw new Error(`the backup ${path} is damaged: ${verdict}`);
  } finally {
    copy.close();
  }
  pruneBackups(dir);
  return path;
}

/** Names sort by time; a file of any other name is not ours to touch. */
function pruneBackups(dir: string): void {
  const backups = readdirSync(dir)
    .filter((file) => BACKUP_FILE.test(file))
    .sort()
    .reverse();
  for (const file of backups.slice(BACKUPS_KEPT))
    rmSync(join(dir, file), { force: true });
}

/** Put a backup back, with nothing holding the database open. The backup stays. */
export function restoreDatabase(dataDir: string, backup: string): void {
  const target = databasePath(dataDir);
  const part = `${target}.restore`;
  copyFileSync(backup, part);
  // A write-ahead log belongs to the file it grew beside: left here, it is replayed onto the backup.
  rmSync(`${target}-wal`, { force: true });
  rmSync(`${target}-shm`, { force: true });
  renameSync(part, target);
}

/** The migrations that have run on the database; none when it has never been opened. */
export function appliedMigrations(dataDir: string): string[] {
  if (!existsSync(databasePath(dataDir))) return [];
  return readonly(dataDir, (db) => {
    const known = db
      .query("SELECT 1 FROM sqlite_master WHERE name = 'eta_migrations'")
      .get();
    if (known === null) return [];
    return db
      .query<{ id: string }, []>("SELECT id FROM eta_migrations")
      .all()
      .map((row) => row.id);
  });
}

/**
 * What a restart would interrupt, from the rows the host keeps for the work it is doing:
 * task runs, routine runs, and replies in a conversation, every status a start fails
 * (`Timeline.failInterrupted`): one still `queued` is starting its session, and one waiting for the
 * user's answer loses the question. A queued task run is not here, because a restart leaves it
 * queued. Rows, not processes, so that the answer also covers agents on other machines, whose runs
 * are lost track of when the host goes.
 */
export function busyAgents(dataDir: string): UpgradeBusy[] {
  if (!existsSync(databasePath(dataDir))) return [];
  return readonly(dataDir, (db) => [
    ...db
      .query<{ number: number; title: string }, []>(
        `SELECT task.number, task.title FROM task_run
           JOIN task ON task.id = task_run.task_id
          WHERE task_run.status IN ('starting', 'running')`,
      )
      .all()
      .map((row) => ({
        kind: "task" as const,
        number: row.number,
        name: row.title,
      })),
    ...db
      .query<{ name: string }, []>(
        `SELECT routine.name FROM routine_run
           JOIN routine ON routine.id = routine_run.routine_id
          WHERE routine_run.status = 'running'`,
      )
      .all()
      .map((row) => ({ kind: "routine" as const, name: row.name })),
    ...db
      .query<{ name: string }, []>(
        `SELECT conversation.name FROM message
           JOIN conversation ON conversation.id = message.conversation_id
          WHERE message.status IN ('queued', 'working', 'waiting_for_input', 'stopping')`,
      )
      .all()
      .map((row) => ({ kind: "reply" as const, name: row.name })),
  ]);
}

/** The same for a command line. */
export const busyText = (busy: readonly UpgradeBusy[]): string =>
  busy
    .map((item) =>
      item.kind === "task"
        ? `task #${item.number} ${item.name}`
        : item.kind === "routine"
          ? `routine ${item.name}`
          : `a reply in ${item.name}`,
    )
    .join("; ");
