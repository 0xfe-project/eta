import type { MachineKind, MachineStatus } from "@eta/client-contracts";
/**
 * The machines sessions can run on.
 *
 * The primary is the one this host runs on: it is written the first time the host starts and read
 * back every time after, so its id is as stable as the database. Other kinds (a daemon, an SSH
 * target) arrive with their own rows; nothing here changes for them.
 */
import type { Database } from "bun:sqlite";

export interface MachineRecord {
  id: string;
  kind: MachineKind;
  name: string;
  status: MachineStatus;
  fingerprint: string | null;
  home: string | null;
  os: string | null;
  createdAt: number;
  lastSeenAt: number | null;
}

interface Row {
  id: string;
  kind: string;
  name: string;
  status: string;
  fingerprint: string | null;
  home: string | null;
  os: string | null;
  created_at: number;
  last_seen_at: number | null;
}

const recordOf = (row: Row): MachineRecord => ({
  id: row.id,
  kind: row.kind as MachineKind,
  name: row.name,
  status: row.status as MachineStatus,
  fingerprint: row.fingerprint,
  home: row.home,
  os: row.os,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
});

export class MachineStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * The primary machine, made the first time it is asked for. What it is called and where its home
   * is are facts about the computer *now*, so the second start refreshes them; the id and the name
   * the user may have chosen stay.
   */
  ensurePrimary(facts: {
    name: string;
    home: string;
    os: string;
  }): MachineRecord {
    const now = Date.now();
    const existing = this.primary();
    if (existing === undefined) {
      this.#db
        .query(
          `INSERT INTO machine (id, kind, name, status, home, os, created_at, last_seen_at)
           VALUES (?, 'primary', ?, 'online', ?, ?, ?, ?)`,
        )
        .run(crypto.randomUUID(), facts.name, facts.home, facts.os, now, now);
    } else {
      this.#db
        .query(
          "UPDATE machine SET status = 'online', home = ?, os = ?, last_seen_at = ? WHERE id = ?",
        )
        .run(facts.home, facts.os, now, existing.id);
    }
    return this.primary()!;
  }

  primary(): MachineRecord | undefined {
    const row = this.#db
      .query<Row, []>("SELECT * FROM machine WHERE kind = 'primary'")
      .get();
    return row === null ? undefined : recordOf(row);
  }

  list(): MachineRecord[] {
    return this.#db
      .query<Row, []>(
        "SELECT * FROM machine ORDER BY kind <> 'primary', name COLLATE NOCASE, id",
      )
      .all()
      .map(recordOf);
  }

  get(id: string): MachineRecord | undefined {
    const row = this.#db
      .query<Row, [string]>("SELECT * FROM machine WHERE id = ?")
      .get(id);
    return row === null ? undefined : recordOf(row);
  }

  rename(id: string, name: string): MachineRecord | undefined {
    const changed = this.#db
      .query("UPDATE machine SET name = ? WHERE id = ?")
      .run(name, id).changes;
    return changed === 0 ? undefined : this.get(id);
  }
}
