/**
 * What the host remembers about places: the directories used lately on each machine, and where
 * the last clone on each went. The machines' own filesystems are theirs (`@eta/places`).
 */
import type { Database } from "bun:sqlite";

/** How many directories each machine remembers. */
export const RECENT_PER_MACHINE = 20;

export interface RecentRow {
  machineId: string;
  path: string;
  usedAt: number;
}

export class PlaceStore {
  readonly #db: Database;
  readonly #now: () => number;

  constructor(db: Database, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /** Most recent first, every machine's. */
  recent(): RecentRow[] {
    return this.#db
      .query<{ machine_id: string; path: string; used_at: number }, []>(
        "SELECT machine_id, path, used_at FROM place_recent ORDER BY used_at DESC, path",
      )
      .all()
      .map((row) => ({
        machineId: row.machine_id,
        path: row.path,
        usedAt: row.used_at,
      }));
  }

  /** Put a directory first. */
  remember(machineId: string, path: string): void {
    this.#db
      .query(
        `INSERT INTO place_recent (machine_id, path, used_at) VALUES (?, ?, ?)
         ON CONFLICT (machine_id, path) DO UPDATE SET used_at = excluded.used_at`,
      )
      .run(machineId, path, Math.max(this.#now(), this.#newest(machineId) + 1));
    this.#trim(machineId);
  }

  /**
   * Directories a client kept before the host did, most recent first: added behind the ones
   * known, in their order; one known already keeps its place. Asking again adds nothing.
   */
  import(machineId: string, paths: readonly string[]): number {
    const oldest =
      this.#db
        .query<{ at: number | null }, [string]>(
          "SELECT MIN(used_at) AS at FROM place_recent WHERE machine_id = ?",
        )
        .get(machineId)?.at ?? this.#now();
    const insert = this.#db.query(
      "INSERT OR IGNORE INTO place_recent (machine_id, path, used_at) VALUES (?, ?, ?)",
    );
    let added = 0;
    const seen = new Set<string>();
    this.#db.transaction(() => {
      for (const path of paths) {
        if (seen.has(path)) continue;
        seen.add(path);
        added += insert.run(machineId, path, oldest - 1 - seen.size).changes;
      }
    })();
    this.#trim(machineId);
    return added;
  }

  cloneParent(machineId: string): string | undefined {
    return (
      this.#db
        .query<{ path: string }, [string]>(
          "SELECT path FROM place_clone_parent WHERE machine_id = ?",
        )
        .get(machineId)?.path ?? undefined
    );
  }

  setCloneParent(machineId: string, path: string): void {
    this.#db
      .query(
        `INSERT INTO place_clone_parent (machine_id, path, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (machine_id) DO UPDATE SET path = excluded.path, updated_at = excluded.updated_at`,
      )
      .run(machineId, path, this.#now());
  }

  #newest(machineId: string): number {
    return (
      this.#db
        .query<{ at: number | null }, [string]>(
          "SELECT MAX(used_at) AS at FROM place_recent WHERE machine_id = ?",
        )
        .get(machineId)?.at ?? 0
    );
  }

  #trim(machineId: string): void {
    this.#db
      .query(
        `DELETE FROM place_recent WHERE machine_id = ? AND path NOT IN (
           SELECT path FROM place_recent WHERE machine_id = ? ORDER BY used_at DESC LIMIT ?
         )`,
      )
      .run(machineId, machineId, RECENT_PER_MACHINE);
  }
}
