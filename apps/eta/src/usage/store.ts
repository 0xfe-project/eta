/**
 * The usage table: one row per (subject, provider, model, hour) (REFACTOR.md §9, P1.3).
 *
 * Counted, not measured: every generation adds one to `requests` and its tokens to the sums. A
 * generation that failed adds to `failed` instead — a provider that answers 429 is still a
 * provider you paid attention to, and "who is failing" is a question this table should answer.
 */
import type { Database } from "bun:sqlite";

export interface UsageEntry {
  subject: string;
  provider: string;
  model: string;
  /** `undefined` for a failed generation: there are no tokens to add. */
  usage?:
    | {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        reasoning?: number | undefined;
        totalTokens: number;
      }
    | undefined;
  failed?: boolean | undefined;
  /** The moment of the generation; only its hour is kept. */
  at?: Date | undefined;
}

export interface UsageTotals {
  requests: number;
  failed: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}

export interface UsageWindow extends UsageTotals {
  /** The window in hours: 5, 24, 168. */
  hours: number;
}

export interface UsageModelBreakdown extends UsageTotals {
  provider: string;
  model: string;
}

export interface UsageSubject {
  subject: string;
  windows: UsageWindow[];
  models: UsageModelBreakdown[];
}

/** How long the table is kept; AXP's number, kept because it is a sensible one. */
export const RETENTION_DAYS = 30;

/** The windows a settings page asks for, in hours. */
export const WINDOWS = [5, 24, 168] as const;

const hourOf = (at: Date): string => at.toISOString().slice(0, 13);

interface Row {
  subject: string;
  provider: string;
  model: string;
  /** `YYYY-MM-DDTHH`, UTC: what the windows are cut on. */
  hour: string;
  requests: number;
  failed: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  total: number;
}

const totalsOf = (row: Row): UsageTotals => ({
  requests: row.requests,
  failed: row.failed,
  input: row.input,
  output: row.output,
  cacheRead: row.cache_read,
  cacheWrite: row.cache_write,
  reasoning: row.reasoning,
  total: row.total,
});

const sum = (rows: readonly Row[]): UsageTotals =>
  rows.reduce<UsageTotals>(
    (total, row) => {
      const own = totalsOf(row);
      return {
        requests: total.requests + own.requests,
        failed: total.failed + own.failed,
        input: total.input + own.input,
        output: total.output + own.output,
        cacheRead: total.cacheRead + own.cacheRead,
        cacheWrite: total.cacheWrite + own.cacheWrite,
        reasoning: total.reasoning + own.reasoning,
        total: total.total + own.total,
      };
    },
    {
      requests: 0,
      failed: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 0,
    },
  );

function groupByModel(rows: readonly Row[]): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.model}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return groups;
}

export class UsageStore {
  readonly #handle: Database;

  constructor(handle: Database) {
    this.#handle = handle;
  }

  /** Count one generation. */
  record(entry: UsageEntry): void {
    const hour = hourOf(entry.at ?? new Date());
    const usage = entry.usage;
    this.#handle
      .query(
        `INSERT INTO usage_hourly
           (subject, provider, model, hour, requests, failed, input, output, cache_read, cache_write, reasoning, total)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (subject, provider, model, hour) DO UPDATE SET
           requests = requests + 1,
           failed = failed + excluded.failed,
           input = input + excluded.input,
           output = output + excluded.output,
           cache_read = cache_read + excluded.cache_read,
           cache_write = cache_write + excluded.cache_write,
           reasoning = reasoning + excluded.reasoning,
           total = total + excluded.total`,
      )
      .run(
        entry.subject,
        entry.provider,
        entry.model,
        hour,
        entry.failed === true ? 1 : 0,
        usage?.input ?? 0,
        usage?.output ?? 0,
        usage?.cacheRead ?? 0,
        usage?.cacheWrite ?? 0,
        usage?.reasoning ?? 0,
        usage?.totalTokens ?? 0,
      );
  }

  /** Drop what is older than the retention. Returns how many rows went. */
  prune(now: Date = new Date(), days: number = RETENTION_DAYS): number {
    const cutoff = hourOf(new Date(now.getTime() - days * 24 * 60 * 60 * 1000));
    const result = this.#handle
      .query("DELETE FROM usage_hourly WHERE hour < ?")
      .run(cutoff);
    return result.changes;
  }

  /** Every subject, with the windows and the per-model split the last 7 days. */
  bySubject(now: Date = new Date()): UsageSubject[] {
    const rows = this.#handle
      .query("SELECT * FROM usage_hourly")
      .all() as Row[];
    const subjects = new Map<string, Row[]>();
    for (const row of rows) {
      const list = subjects.get(row.subject) ?? [];
      list.push(row);
      subjects.set(row.subject, list);
    }

    const cutoffHour = (hours: number): string =>
      hourOf(new Date(now.getTime() - hours * 60 * 60 * 1000));

    return [...subjects.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([subject, own]) => ({
        subject,
        windows: WINDOWS.map((hours) => {
          const cutoff = cutoffHour(hours);
          const inWindow = own.filter((row) => row.hour >= cutoff);
          return { hours, ...sum(inWindow) };
        }),
        models: [
          ...groupByModel(
            own.filter((row) => row.hour >= cutoffHour(168)),
          ).entries(),
        ]
          .map(([key, group]) => {
            const [provider, model] = key.split("\u0000");
            return {
              provider: provider ?? "",
              model: model ?? "",
              ...sum(group),
            };
          })
          .sort((a, b) => b.total - a.total),
      }));
  }
}
