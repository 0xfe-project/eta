/**
 * The `usage` target: what the models were used for, and by whom.
 *
 * Every request a session makes to a model is counted (tokens, cost, the model, whether the
 * provider answered or failed) with the agent and the conversation it was made for: a turn, each
 * retry of a turn (the failed attempt and the next one are two requests), a compaction's summary,
 * a side question, and the turns of the subagents it spawned. Rows are kept for
 * `USAGE_RETENTION_DAYS` days; the sections are sums over them, so they carry no history beyond it.
 *
 * `agents` is what an agent's usage line needs: its rolling windows and its models. `models` and
 * `days` are the whole picture, for a settings page. A generation made in a session that belongs
 * to no agent and no routine counts under `agentId: null`; a routine's runs count under
 * `routines`.
 */

/** How long a generation is kept. */
export const USAGE_RETENTION_DAYS = 30;

/** The rolling windows an agent's usage is summed over, ending now. `30d` is the retention. */
export const USAGE_WINDOWS = ["5h", "24h", "7d", "30d"] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

/** Counted, not measured: every generation adds one request and its tokens. */
export interface UsageTotals {
  /** Requests made, the failed and the stopped ones and every retry attempt included. */
  requests: number;
  /** Of those, the ones the provider answered with an error. */
  failed: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** A subset of `output`, for the providers that say. */
  reasoning: number;
  /** Everything charged: the provider's own total, or the sum of the parts when it gives none. */
  total: number;
  /** In dollars, as the model catalog prices the tokens. */
  cost: number;
}

export interface ModelUsage extends UsageTotals {
  provider: string;
  model: string;
}

export interface AgentUsage {
  /** Null for sessions that belong to no agent. */
  agentId: string | null;
  windows: Record<UsageWindow, UsageTotals>;
  /** Over the retention window, the most tokens first. */
  models: ModelUsage[];
}

/** The same for a routine: what its runs (and revisions of its brief) used. */
export interface RoutineUsage {
  routineId: string;
  windows: Record<UsageWindow, UsageTotals>;
  /** Over the retention window, the most tokens first. */
  models: ModelUsage[];
}

export interface DayUsage extends UsageTotals {
  /** `YYYY-MM-DD`, in UTC. */
  day: string;
}

export interface UsageSections {
  /** Every agent with usage in the retention window, the most tokens in 30 days first. */
  agents: AgentUsage[];
  /**
   * Every routine with usage in the retention window, the most tokens in 30 days first. Their
   * generations are not in `agents` (a routine's session belongs to no agent), only in `models`
   * and `days`.
   */
  routines: RoutineUsage[];
  /** All agents together, the most tokens first. */
  models: ModelUsage[];
  /** All agents together, oldest first; a day without usage has no row. */
  days: DayUsage[];
}
