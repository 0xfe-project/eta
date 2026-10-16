/**
 * The agents (REFACTOR.md §9, P0.8).
 *
 * An agent is what a conversation *belongs to*: a name, a model, instructions, the plugins it
 * loads. It is not a conversation — a session is (P0.7), and the row that ties one to the other
 * is the group's thread, which is P2's table. Nothing here opens a session, and nothing in the
 * sessions plugin reads this table: the two are separate on purpose, and the reason is that a
 * group with three agents in it has three sessions and one shared timeline, none of which is an
 * agent.
 */
import type { Database } from "bun:sqlite";

export interface AgentRecord {
  id: string;
  name: string;
  /** `provider:modelId`, or absent when the agent has not chosen one. */
  model?: string | undefined;
  instructions: string;
  /** Plugin names this agent loads. The plugin surface itself is P3's. */
  plugins: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentInput {
  name: string;
  model?: string | undefined;
  instructions?: string | undefined;
  plugins?: readonly string[] | undefined;
}

export type AgentPatch = Partial<AgentInput>;

interface Row {
  id: string;
  name: string;
  model: string | null;
  instructions: string;
  plugins: string;
  created_at: string;
  updated_at: string;
}

const toRecord = (row: Row): AgentRecord => ({
  id: row.id,
  name: row.name,
  ...(row.model === null ? {} : { model: row.model }),
  instructions: row.instructions,
  plugins: parsePlugins(row.plugins),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** A column that holds JSON is a column that can hold anything: degrade to "none" and move on. */
function parsePlugins(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
}

export class AgentStore {
  readonly #handle: Database;

  constructor(handle: Database) {
    this.#handle = handle;
  }

  list(): AgentRecord[] {
    const rows = this.#handle
      .query("SELECT * FROM agents ORDER BY name, created_at")
      .all() as Row[];
    return rows.map(toRecord);
  }

  get(id: string): AgentRecord | undefined {
    const row = this.#handle
      .query("SELECT * FROM agents WHERE id = ?")
      .get(id) as Row | null;
    return row === null ? undefined : toRecord(row);
  }

  create(input: AgentInput, id: string = crypto.randomUUID()): AgentRecord {
    const now = new Date().toISOString();
    this.#handle
      .query(
        `INSERT INTO agents (id, name, model, instructions, plugins, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.model ?? null,
        input.instructions ?? "",
        JSON.stringify(input.plugins ?? []),
        now,
        now,
      );
    // Read it back rather than assemble it: what the caller gets is what the table holds.
    const created = this.get(id);
    if (created === undefined)
      throw new Error(`agent ${id} vanished right after it was created`);
    return created;
  }

  update(id: string, patch: AgentPatch): AgentRecord | undefined {
    const current = this.get(id);
    if (current === undefined) return undefined;
    const next: AgentRecord = {
      ...current,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.model === undefined ? {} : { model: patch.model }),
      ...(patch.instructions === undefined
        ? {}
        : { instructions: patch.instructions }),
      ...(patch.plugins === undefined ? {} : { plugins: [...patch.plugins] }),
      updatedAt: new Date().toISOString(),
    };
    this.#handle
      .query(
        "UPDATE agents SET name = ?, model = ?, instructions = ?, plugins = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        next.name,
        next.model ?? null,
        next.instructions,
        JSON.stringify(next.plugins),
        next.updatedAt,
        id,
      );
    return this.get(id);
  }

  remove(id: string): boolean {
    const result = this.#handle
      .query("DELETE FROM agents WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }
}
