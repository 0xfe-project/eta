import type { ProjectKind } from "@eta/client-contracts";
/**
 * The projects: a directory on a machine, with an optional steward.
 *
 * A path is unique per machine, and a project is where sessions run (their working directory) and
 * where conversations belong. Whether the directory exists is the plugin's question to ask of the
 * machine; this only keeps what it was told.
 */
import type { Database } from "bun:sqlite";

export interface ProjectRecord {
  id: string;
  machineId: string;
  path: string;
  name: string;
  kind: ProjectKind;
  stewardId: string | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectInput {
  machineId: string;
  path: string;
  name: string;
  kind?: ProjectKind | undefined;
  stewardId?: string | null | undefined;
}

interface Row {
  id: string;
  machine_id: string;
  path: string;
  name: string;
  kind: string;
  steward_id: string | null;
  archived: number;
  created_at: number;
  updated_at: number;
}

const recordOf = (row: Row): ProjectRecord => ({
  id: row.id,
  machineId: row.machine_id,
  path: row.path,
  name: row.name,
  kind: row.kind as ProjectKind,
  stewardId: row.steward_id,
  archived: row.archived === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class ProjectStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  list(): ProjectRecord[] {
    return this.#db
      .query<Row, []>(
        "SELECT * FROM project ORDER BY name COLLATE NOCASE, created_at, id",
      )
      .all()
      .map(recordOf);
  }

  get(id: string): ProjectRecord | undefined {
    const row = this.#db
      .query<Row, [string]>("SELECT * FROM project WHERE id = ?")
      .get(id);
    return row === null ? undefined : recordOf(row);
  }

  byPath(machineId: string, path: string): ProjectRecord | undefined {
    const row = this.#db
      .query<Row, [string, string]>(
        "SELECT * FROM project WHERE machine_id = ? AND path = ?",
      )
      .get(machineId, path);
    return row === null ? undefined : recordOf(row);
  }

  create(input: ProjectInput): ProjectRecord {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.#db
      .query(
        `INSERT INTO project (id, machine_id, path, name, kind, steward_id, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        input.machineId,
        input.path,
        input.name,
        input.kind ?? "project",
        input.stewardId ?? null,
        now,
        now,
      );
    return this.get(id)!;
  }

  update(
    id: string,
    patch: { name?: string | undefined; archived?: boolean | undefined },
  ): ProjectRecord | undefined {
    const current = this.get(id);
    if (current === undefined) return undefined;
    this.#db
      .query(
        "UPDATE project SET name = ?, archived = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        patch.name ?? current.name,
        (patch.archived ?? current.archived) ? 1 : 0,
        Date.now(),
        id,
      );
    return this.get(id);
  }

  setSteward(id: string, agentId: string | null): ProjectRecord | undefined {
    const changed = this.#db
      .query("UPDATE project SET steward_id = ?, updated_at = ? WHERE id = ?")
      .run(agentId, Date.now(), id).changes;
    return changed === 0 ? undefined : this.get(id);
  }
}
