import type { AgentRuntime, ThinkingLevel } from "@eta/client-contracts";
/**
 * The agents: names, instructions, the model and persona each wears.
 *
 * An agent is a configuration and nothing else. It does not hold sessions or conversations;
 * those name the agent, never the other way round, which is what lets an agent be edited or
 * deleted without anything of its own to tidy up here.
 */
import type { Database } from "bun:sqlite";
import { join } from "node:path";

export interface AgentRecord {
  id: string;
  name: string;
  instructions: string;
  persona: string;
  /** What answers for it: eta's own loop, or an external runtime its sessions delegate to. */
  runtime: AgentRuntime;
  /** `provider:modelId`, or `runtime:modelId` on an external runtime. */
  model: string | null;
  thinkingLevel: ThinkingLevel | null;
  /** The bundles it loads, by name, in the order they were chosen. */
  bundles: string[];
  /**
   * The machine it runs on, when it is pinned to one: its sessions are made there whatever
   * machine the project is on. Null follows the project.
   */
  machineId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentInput {
  name: string;
  instructions?: string | undefined;
  persona?: string | undefined;
  runtime?: AgentRuntime | undefined;
  model?: string | null | undefined;
  thinkingLevel?: ThinkingLevel | null | undefined;
  bundles?: string[] | undefined;
  machineId?: string | null | undefined;
}

interface Row {
  id: string;
  name: string;
  instructions: string;
  persona: string;
  runtime: string;
  model: string | null;
  thinking_level: string | null;
  bundles: string;
  machine_id: string | null;
  created_at: number;
  updated_at: number;
}

/** The names in the column; anything else in it is no bundle. */
function namesOf(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

const recordOf = (row: Row): AgentRecord => ({
  id: row.id,
  name: row.name,
  instructions: row.instructions,
  persona: row.persona,
  runtime: row.runtime as AgentRuntime,
  model: row.model,
  thinkingLevel: row.thinking_level as ThinkingLevel | null,
  bundles: namesOf(row.bundles),
  machineId: row.machine_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** An agent's workspace: a directory of its own under the data directory. */
export function agentHome(dataDir: string, agentId: string): string {
  return join(dataDir, "agents", agentId);
}

export class AgentStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  list(): AgentRecord[] {
    return this.#db
      .query<Row, []>("SELECT * FROM agent ORDER BY name COLLATE NOCASE, id")
      .all()
      .map(recordOf);
  }

  get(id: string): AgentRecord | undefined {
    const row = this.#db
      .query<Row, [string]>("SELECT * FROM agent WHERE id = ?")
      .get(id);
    return row === null ? undefined : recordOf(row);
  }

  create(input: AgentInput, id: string = crypto.randomUUID()): AgentRecord {
    const now = Date.now();
    this.#db
      .query(
        `INSERT INTO agent (id, name, instructions, persona, runtime, model, thinking_level, bundles, machine_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.instructions ?? "",
        input.persona ?? "",
        input.runtime ?? "eta",
        input.model ?? null,
        input.thinkingLevel ?? null,
        JSON.stringify(input.bundles ?? []),
        input.machineId ?? null,
        now,
        now,
      );
    return this.get(id)!;
  }

  /** Change what was sent; `null` clears a model or a thinking level, `undefined` leaves it. */
  update(id: string, patch: Partial<AgentInput>): AgentRecord | undefined {
    const current = this.get(id);
    if (current === undefined) return undefined;
    this.#db
      .query(
        `UPDATE agent SET name = ?, instructions = ?, persona = ?, runtime = ?, model = ?, thinking_level = ?, bundles = ?, machine_id = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        patch.name ?? current.name,
        patch.instructions ?? current.instructions,
        patch.persona ?? current.persona,
        patch.runtime ?? current.runtime,
        patch.model === undefined ? current.model : patch.model,
        patch.thinkingLevel === undefined
          ? current.thinkingLevel
          : patch.thinkingLevel,
        JSON.stringify(patch.bundles ?? current.bundles),
        patch.machineId === undefined ? current.machineId : patch.machineId,
        Date.now(),
        id,
      );
    return this.get(id);
  }

  remove(id: string): boolean {
    return this.#db.query("DELETE FROM agent WHERE id = ?").run(id).changes > 0;
  }
}
