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
  /**
   * The machine it runs on, when it is pinned to one: its sessions are made there whatever
   * machine the project is on. Null follows the project.
   */
  machineId: string | null;
  /** The one system role an agent can carry. Ordinary agents have none. */
  systemRole: "captain" | null;
  /** The seed its avatar is drawn from; null draws it from the id. */
  avatarSeed: string | null;
  /** The last seeds it wore, newest first, the current one included. */
  avatarSeeds: string[];
  createdAt: number;
  updatedAt: number;
}

/** How many of the seeds an agent wore are kept. */
const AVATAR_HISTORY = 8;

export interface AgentInput {
  name: string;
  instructions?: string | undefined;
  persona?: string | undefined;
  runtime?: AgentRuntime | undefined;
  model?: string | null | undefined;
  thinkingLevel?: ThinkingLevel | null | undefined;
  machineId?: string | null | undefined;
  systemRole?: "captain" | null | undefined;
  avatarSeed?: string | undefined;
}

interface Row {
  id: string;
  name: string;
  instructions: string;
  persona: string;
  runtime: string;
  model: string | null;
  thinking_level: string | null;
  machine_id: string | null;
  system_role: string | null;
  avatar_seed: string | null;
  avatar_seeds: string;
  created_at: number;
  updated_at: number;
}

const recordOf = (row: Row): AgentRecord => ({
  id: row.id,
  name: row.name,
  instructions: row.instructions,
  persona: row.persona,
  runtime: row.runtime as AgentRuntime,
  model: row.model,
  thinkingLevel: row.thinking_level as ThinkingLevel | null,
  machineId: row.machine_id,
  systemRole: row.system_role as "captain" | null,
  avatarSeed: row.avatar_seed,
  avatarSeeds: JSON.parse(row.avatar_seeds) as string[],
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
        `INSERT INTO agent (id, name, instructions, persona, runtime, model, thinking_level, machine_id, system_role, created_at, updated_at)
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
        input.machineId ?? null,
        input.systemRole ?? null,
        now,
        now,
      );
    return this.get(id)!;
  }

  /**
   * Change what was sent; `null` clears a model or a thinking level, `undefined` leaves it. A new
   * avatar seed goes to the front of the seeds worn, once, and the oldest past the last few go.
   */
  update(id: string, patch: Partial<AgentInput>): AgentRecord | undefined {
    const current = this.get(id);
    if (current === undefined) return undefined;
    const avatarSeeds =
      patch.avatarSeed === undefined
        ? current.avatarSeeds
        : [
            patch.avatarSeed,
            // An agent that never drew one wears its id: that face is the first one to go back to.
            ...(current.avatarSeeds.length === 0
              ? [current.id]
              : current.avatarSeeds),
          ]
            .filter((seed, at, seeds) => seeds.indexOf(seed) === at)
            .slice(0, AVATAR_HISTORY);
    this.#db
      .query(
        `UPDATE agent SET name = ?, instructions = ?, persona = ?, runtime = ?, model = ?, thinking_level = ?, machine_id = ?, system_role = ?, avatar_seed = ?, avatar_seeds = ?, updated_at = ?
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
        patch.machineId === undefined ? current.machineId : patch.machineId,
        patch.systemRole === undefined ? current.systemRole : patch.systemRole,
        patch.avatarSeed ?? current.avatarSeed,
        JSON.stringify(avatarSeeds),
        Date.now(),
        id,
      );
    return this.get(id);
  }

  remove(id: string): boolean {
    return this.#db.query("DELETE FROM agent WHERE id = ?").run(id).changes > 0;
  }
}
