/**
 * The usage table: one row per generation a session made.
 *
 * Counted, not measured: a row is written when a generation ends, with the agent and conversation
 * its session belongs to, and every sum a client sees is a read of the rows still inside the
 * retention window. A failed generation is a row too (a provider that answers 429 is still a
 * provider that was asked), as is one the user stopped.
 */
import type {
  AgentUsage,
  DayUsage,
  ModelUsage,
  UsageTotals,
  UsageWindow,
} from "@eta/client-contracts";
import type { Database } from "bun:sqlite";
import { USAGE_RETENTION_DAYS, USAGE_WINDOWS } from "@eta/client-contracts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** How long each window reaches back from now. */
const WINDOW_MS: Record<UsageWindow, number> = {
  "5h": 5 * HOUR_MS,
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": USAGE_RETENTION_DAYS * DAY_MS,
};

/** One generation, as the session saw it end. */
export interface UsageEntry {
  at: number;
  sessionId: string;
  agentId: string | null;
  conversationId: string | null;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  cost: number;
  status: "ok" | "error" | "aborted";
  /** The provider's own words, when it failed. */
  error: string | null;
}

/** The sums a read asks of a group of rows. */
const TOTALS = `
  COUNT(*) AS requests,
  SUM(status = 'error') AS failed,
  SUM(input) AS input,
  SUM(output) AS output,
  SUM(cache_read) AS cache_read,
  SUM(cache_write) AS cache_write,
  SUM(reasoning) AS reasoning,
  SUM(total) AS total,
  SUM(cost) AS cost`;

interface TotalsRow {
  requests: number;
  failed: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  total: number;
  cost: number;
}

const totalsOf = (row: TotalsRow): UsageTotals => ({
  requests: row.requests,
  failed: row.failed,
  input: row.input,
  output: row.output,
  cacheRead: row.cache_read,
  cacheWrite: row.cache_write,
  reasoning: row.reasoning,
  total: row.total,
  // Sums of floats: kept to the millionth of a dollar, so a sum does not read as 0.30000000000000004.
  cost: Math.round(row.cost * 1e6) / 1e6,
});

const NONE: UsageTotals = {
  requests: 0,
  failed: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total: 0,
  cost: 0,
};

export class UsageStore {
  readonly #db: Database;
  readonly #now: () => number;
  #prunedAt = 0;

  constructor(db: Database, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /** Count one generation. Rows past the retention are dropped at most once a day, as it goes. */
  record(entry: UsageEntry): void {
    this.#db
      .query(
        `INSERT INTO usage
           (at, session_id, agent_id, conversation_id, provider, model, input, output, cache_read,
            cache_write, reasoning, total, cost, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.at,
        entry.sessionId,
        entry.agentId,
        entry.conversationId,
        entry.provider,
        entry.model,
        entry.input,
        entry.output,
        entry.cacheRead,
        entry.cacheWrite,
        entry.reasoning,
        entry.total,
        entry.cost,
        entry.status,
        entry.error,
      );
    if (this.#now() - this.#prunedAt >= DAY_MS) this.prune();
  }

  /** Drop what is older than the retention. Returns how many rows went. */
  prune(): number {
    const now = this.#now();
    this.#prunedAt = now;
    return this.#db
      .query("DELETE FROM usage WHERE at < ?")
      .run(now - WINDOW_MS["30d"]).changes;
  }

  /** Every agent with usage in the retention window: its rolling windows and its models. */
  agents(): AgentUsage[] {
    const now = this.#now();
    const byAgent = new Map<string | null, AgentUsage>();
    const agentOf = (id: string | null): AgentUsage => {
      let agent = byAgent.get(id);
      if (agent === undefined) {
        agent = {
          agentId: id,
          windows: Object.fromEntries(
            USAGE_WINDOWS.map((window) => [window, NONE]),
          ) as Record<UsageWindow, UsageTotals>,
          models: [],
        };
        byAgent.set(id, agent);
      }
      return agent;
    };
    for (const window of USAGE_WINDOWS) {
      const rows = this.#db
        .query<TotalsRow & { agent_id: string | null }, [number]>(
          `SELECT agent_id, ${TOTALS} FROM usage WHERE at >= ? GROUP BY agent_id`,
        )
        .all(now - WINDOW_MS[window]);
      for (const row of rows)
        agentOf(row.agent_id).windows[window] = totalsOf(row);
    }
    const models = this.#db
      .query<
        TotalsRow & {
          agent_id: string | null;
          provider: string;
          model: string;
        },
        [number]
      >(
        `SELECT agent_id, provider, model, ${TOTALS} FROM usage WHERE at >= ?
          GROUP BY agent_id, provider, model ORDER BY SUM(total) DESC, provider, model`,
      )
      .all(now - WINDOW_MS["30d"]);
    for (const row of models) {
      agentOf(row.agent_id).models.push({
        provider: row.provider,
        model: row.model,
        ...totalsOf(row),
      });
    }
    return [...byAgent.values()].sort(
      (a, b) =>
        b.windows["30d"].total - a.windows["30d"].total ||
        (a.agentId ?? "").localeCompare(b.agentId ?? ""),
    );
  }

  /** Every model used in the retention window, all agents together, the most tokens first. */
  models(): ModelUsage[] {
    return this.#db
      .query<TotalsRow & { provider: string; model: string }, [number]>(
        `SELECT provider, model, ${TOTALS} FROM usage WHERE at >= ?
          GROUP BY provider, model ORDER BY SUM(total) DESC, provider, model`,
      )
      .all(this.#now() - WINDOW_MS["30d"])
      .map((row) => ({
        provider: row.provider,
        model: row.model,
        ...totalsOf(row),
      }));
  }

  /** Each UTC day with usage in the retention window, all agents together, oldest first. */
  days(): DayUsage[] {
    return this.#db
      .query<TotalsRow & { day: string }, [number]>(
        `SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS day, ${TOTALS}
           FROM usage WHERE at >= ? GROUP BY day ORDER BY day`,
      )
      .all(this.#now() - WINDOW_MS["30d"])
      .map((row) => ({ day: row.day, ...totalsOf(row) }));
  }
}
