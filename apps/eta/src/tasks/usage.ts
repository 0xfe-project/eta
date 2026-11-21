import type {
  RunMessageUsage,
  TaskModelUsage,
  TaskRunStatus,
  TaskRunUsage,
  TaskTokenTotals,
  TaskUsageBrief,
  TaskUsageGroup,
  TaskUsageView,
  TokenCounts,
} from "@eta/client-contracts";
import type { AssistantMessage } from "@eta/core";
/**
 * What a task's runs used, in tokens, and by which model.
 *
 * A run works in a session (`task_run.session_id`; a continuation shares the session of the run it
 * carries on, so a session can hold several runs, one at a time). What the session used reaches the
 * host by one of two roads, depending on who talks to the model:
 *
 * - **eta's own loop.** Every request goes through the host's model layer, the session's own on
 *   this machine and a daemon's over the link (`model.stream`), and is told to `generated` with the
 *   session's meta: a turn, a retry, a compaction's summary, a subagent's turns. `fromModel` counts
 *   it for the run that works in that session now (`TaskRunStore.bySession`).
 * - **An external runtime** (Claude Code, Codex, an ACP agent) talks to its model itself. What it
 *   reports rides on its assistant messages; a run collects them as it goes (`listen` in
 *   `@eta/daemon`) and hands them back with its outcome (`RunOutcome.usage`), which `fromTranscript`
 *   counts. oar's running totals are turned into each message's share before that
 *   (`usageBetween`), so adding the messages up counts each token once.
 *
 * A row's tokens are NULL when nothing was reported: an ACP agent that never answers a prompt with
 * its usage, a runtime that has not reported a total, or a provider that answers a request and
 * counts it as no tokens at all (a request that was answered read something). "No data" is never
 * shown as 0; a run with no reported row is one of `runsWithoutData`.
 *
 * A run made before this table existed is filled in once (`backfill`): from the usage table, for a
 * session on eta's own loop (its rows are kept 30 days), else from the session's journal if it is
 * on this machine. A session's rows are split between its runs by time: each run has what came from
 * its start until the next run of the same session started, which is how `bySession` would have
 * counted them.
 */
import type { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tokensReported } from "@eta/core";

type Source = "model" | "transcript" | "usage" | "journal";

interface Row {
  run_id: string;
  at: number;
  provider: string;
  model: string;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  reasoning: number | null;
}

interface RunRow {
  id: string;
  task_id: string;
  agent_id: string | null;
  status: string;
  session_id: string | null;
  started_at: number | null;
  created_at: number;
  finished_at: number | null;
}

/**
 * A model layer's message as a row's tokens. A request the provider answered always read some
 * input, so one that comes back with nothing counted was not counted, not free. A failed or stopped
 * one may truly have used nothing, and its zeros are kept.
 */
function tokensOfGeneration(message: AssistantMessage): TokenCounts | null {
  const { usage } = message;
  if (!tokensReported(usage)) return null;
  const answered =
    message.stopReason !== "error" && message.stopReason !== "aborted";
  if (
    answered &&
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0
  )
    return null;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
  };
}

const NO_TOKENS = (): TaskTokenTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: null,
  total: 0,
});

/** Add a row's tokens to a sum; a row without tokens leaves it as it was. */
function add(
  sum: TaskTokenTotals | null,
  row: Pick<
    Row,
    "input" | "output" | "cache_read" | "cache_write" | "reasoning"
  >,
): TaskTokenTotals | null {
  if (row.input === null) return sum;
  const next = sum ?? NO_TOKENS();
  next.input += row.input;
  next.output += row.output!;
  next.cacheRead += row.cache_read!;
  next.cacheWrite += row.cache_write!;
  if (row.reasoning !== null)
    next.reasoning = (next.reasoning ?? 0) + row.reasoning;
  next.total = next.input + next.output + next.cacheRead + next.cacheWrite;
  return next;
}

function addTotals(
  sum: TaskTokenTotals | null,
  more: TaskTokenTotals | null,
): TaskTokenTotals | null {
  if (more === null) return sum;
  return add(sum, {
    input: more.input,
    output: more.output,
    cache_read: more.cacheRead,
    cache_write: more.cacheWrite,
    reasoning: more.reasoning,
  });
}

const byTokens = <T extends { tokens: TaskTokenTotals | null }>(
  a: T & { provider: string; model: string },
  b: T & { provider: string; model: string },
): number =>
  (b.tokens?.total ?? -1) - (a.tokens?.total ?? -1) ||
  a.provider.localeCompare(b.provider) ||
  a.model.localeCompare(b.model);

const OPEN = new Set(["queued", "starting", "running"]);

export interface TaskUsageOptions {
  /** Where this host keeps its sessions' journals (`<dataDir>/sessions/<id>/journal.jsonl`). */
  dataDir: string;
  /** The agent that executes a task: who worked in its executor's runs. */
  executorOf: (taskId: string) => string | null;
  warn?: (message: string) => void;
}

export class TaskUsageStore {
  readonly #db: Database;
  readonly #options: TaskUsageOptions;
  readonly #listeners = new Set<(taskId: string) => void>();

  constructor(db: Database, options: TaskUsageOptions) {
    this.#db = db;
    this.#options = options;
  }

  /** Told the task whose usage moved; the tasks above it moved too, and are the caller's to find. */
  onChange(listener: (taskId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The task and every task above it, nearest first. */
  ancestorsOf(taskId: string): string[] {
    return this.#db
      .query<{ id: string }, [string]>(
        `WITH RECURSIVE up(id, depth) AS (
           SELECT parent_id, 1 FROM task WHERE id = ? AND parent_id IS NOT NULL
           UNION
           SELECT task.parent_id, up.depth + 1 FROM task JOIN up ON task.id = up.id
            WHERE task.parent_id IS NOT NULL AND up.depth < 64
         )
         SELECT id FROM up ORDER BY depth`,
      )
      .all(taskId)
      .map((row) => row.id);
  }

  /**
   * A request of eta's own loop ended: count it for the run that works in its session, if that is
   * a task's run counted live. Returns the task, or undefined when it was nobody's.
   */
  fromModel(
    run: { id: string; taskId: string } | undefined,
    message: AssistantMessage,
  ): string | undefined {
    if (run === undefined || !this.#live(run.id)) return undefined;
    this.#insert(
      run.id,
      [
        {
          at: Date.now(),
          provider: message.provider,
          model: message.model,
          tokens: tokensOfGeneration(message),
        },
      ],
      "model",
    );
    this.#changed(run.taskId);
    return run.taskId;
  }

  /** A run's session, on an external runtime, said what its messages used. */
  fromTranscript(
    run: { id: string; taskId: string },
    usage: readonly RunMessageUsage[],
  ): void {
    if (usage.length === 0 || !this.#live(run.id)) return;
    this.#insert(run.id, usage, "transcript");
    this.#changed(run.taskId);
  }

  #live(runId: string): boolean {
    return (
      this.#db
        .query<{ usage_counted: string | null }, [string]>(
          "SELECT usage_counted FROM task_run WHERE id = ?",
        )
        .get(runId)?.usage_counted === "live"
    );
  }

  #insert(
    runId: string,
    usage: readonly RunMessageUsage[],
    source: Source,
  ): void {
    const insert = this.#db.query(
      `INSERT INTO task_usage
         (run_id, at, provider, model, input, output, cache_read, cache_write, reasoning, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#db.transaction(() => {
      for (const { at, provider, model, tokens } of usage)
        insert.run(
          runId,
          at,
          provider,
          model,
          tokens?.input ?? null,
          tokens?.output ?? null,
          tokens?.cacheRead ?? null,
          tokens?.cacheWrite ?? null,
          tokens?.reasoning ?? null,
          source,
        );
    })();
  }

  #changed(taskId: string): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(taskId);
      } catch {
        // Telling the clients must never be why a count fails.
      }
    }
  }

  /** The task and, with `includeSubtasks`, every task under it at any depth. */
  #tasksOf(taskId: string, includeSubtasks: boolean): string[] {
    if (!includeSubtasks) return [taskId];
    return this.#db
      .query<{ id: string }, [string]>(
        `WITH RECURSIVE down(id, depth) AS (
           SELECT ?, 0
           UNION
           SELECT task.id, down.depth + 1 FROM task JOIN down ON task.parent_id = down.id
            WHERE down.depth < 64
         )
         SELECT id FROM down`,
      )
      .all(taskId)
      .map((row) => row.id);
  }

  /**
   * Every task's usage in brief, for the board's cards and rows: its own runs, and for a task with
   * subtasks, theirs added in. One pass over all runs, so a board of any size costs two queries,
   * not one per card. A task none of whose runs got a session is not in `own`.
   */
  briefs(): {
    own: Map<string, TaskUsageBrief>;
    withSubtasks: Map<string, TaskUsageBrief | null>;
  } {
    const rows = this.#db
      .query<
        {
          run_id: string;
          task_id: string;
          status: string;
          session_id: string;
          provider: string | null;
          model: string | null;
          input: number | null;
          output: number | null;
          cache_read: number | null;
          cache_write: number | null;
          reasoning: number | null;
        },
        []
      >(
        `SELECT r.id AS run_id, r.task_id, r.status, r.session_id, u.provider, u.model,
                SUM(u.input) AS input, SUM(u.output) AS output, SUM(u.cache_read) AS cache_read,
                SUM(u.cache_write) AS cache_write, SUM(u.reasoning) AS reasoning
           FROM task_run r LEFT JOIN task_usage u ON u.run_id = r.id
          WHERE r.session_id IS NOT NULL
          GROUP BY r.id, u.provider, u.model
          ORDER BY r.created_at, r.rowid`,
      )
      .all();
    interface Acc {
      tokens: TaskTokenTotals | null;
      models: Map<string, number>;
      runs: Set<string>;
      withData: Set<string>;
      liveSessionId: string | null;
    }
    const fresh = (): Acc => ({
      tokens: null,
      models: new Map(),
      runs: new Set(),
      withData: new Set(),
      liveSessionId: null,
    });
    const own = new Map<string, Acc>();
    for (const row of rows) {
      const acc = own.get(row.task_id) ?? fresh();
      own.set(row.task_id, acc);
      acc.runs.add(row.run_id);
      if (OPEN.has(row.status)) acc.liveSessionId = row.session_id;
      if (row.input === null || row.model === null) continue;
      acc.withData.add(row.run_id);
      acc.tokens = add(acc.tokens, row);
      const sum = row.input + row.output! + row.cache_read! + row.cache_write!;
      acc.models.set(row.model, (acc.models.get(row.model) ?? 0) + sum);
    }
    const merge = (into: Acc, from: Acc): void => {
      into.tokens = addTotals(into.tokens, from.tokens);
      for (const [model, sum] of from.models)
        into.models.set(model, (into.models.get(model) ?? 0) + sum);
      for (const run of from.runs) into.runs.add(run);
      for (const run of from.withData) into.withData.add(run);
      into.liveSessionId ??= from.liveSessionId;
    };
    const brief = (acc: Acc): TaskUsageBrief => {
      const models = [...acc.models].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      );
      return {
        tokens: acc.tokens,
        model: models[0]?.[0] ?? null,
        models: models.length,
        runs: acc.runs.size,
        runsWithoutData: acc.runs.size - acc.withData.size,
        liveSessionId: acc.liveSessionId,
      };
    };

    const children = new Map<string, string[]>();
    for (const { id, parent_id } of this.#db
      .query<{ id: string; parent_id: string }, []>(
        "SELECT id, parent_id FROM task WHERE parent_id IS NOT NULL",
      )
      .all()) {
      const list = children.get(parent_id) ?? [];
      list.push(id);
      children.set(parent_id, list);
    }
    const subtree = new Map<string, Acc | null>();
    const total = (id: string, depth: number): Acc | null => {
      if (subtree.has(id)) return subtree.get(id)!;
      subtree.set(id, null); // a cycle (never made, but never followed either)
      let acc: Acc | null = null;
      const mine = own.get(id);
      if (mine !== undefined) merge((acc = fresh()), mine);
      if (depth < 64)
        for (const child of children.get(id) ?? []) {
          const theirs = total(child, depth + 1);
          if (theirs !== null) merge((acc ??= fresh()), theirs);
        }
      subtree.set(id, acc);
      return acc;
    };

    const withSubtasks = new Map<string, TaskUsageBrief | null>();
    for (const id of children.keys()) {
      const acc = total(id, 0);
      withSubtasks.set(id, acc === null ? null : brief(acc));
    }
    return {
      own: new Map([...own].map(([id, acc]) => [id, brief(acc)])),
      withSubtasks,
    };
  }

  /** `tasks.usage`: what the task's runs used, its subtasks' with `includeSubtasks`. */
  ofTask(taskId: string, includeSubtasks = false): TaskUsageView {
    const taskIds = this.#tasksOf(taskId, includeSubtasks);
    const marks = taskIds.map(() => "?").join(", ");
    // Only a run that got a session can have used anything: a run that never started is not here.
    const runs = this.#db
      .query<RunRow, string[]>(
        `SELECT id, task_id, agent_id, status, session_id, started_at, created_at, finished_at
           FROM task_run WHERE task_id IN (${marks}) AND session_id IS NOT NULL
          ORDER BY created_at, rowid`,
      )
      .all(...taskIds);
    const rows = this.#db
      .query<Row, string[]>(
        `SELECT run_id, at, provider, model, input, output, cache_read, cache_write, reasoning
           FROM task_usage WHERE run_id IN (
             SELECT id FROM task_run WHERE task_id IN (${marks}) AND session_id IS NOT NULL)
          ORDER BY at, id`,
      )
      .all(...taskIds);
    const rowsOf = new Map<string, Row[]>();
    for (const row of rows) {
      const list = rowsOf.get(row.run_id) ?? [];
      list.push(row);
      rowsOf.set(row.run_id, list);
    }

    const executors = new Map<string, string | null>();
    const executorOf = (id: string): string | null => {
      if (!executors.has(id)) executors.set(id, this.#options.executorOf(id));
      return executors.get(id)!;
    };

    const totals: TaskUsageGroup = {
      tokens: null,
      runs: 0,
      runsWithoutData: 0,
    };
    const models = new Map<string, TaskModelUsage>();
    const runViews: TaskRunUsage[] = [];
    for (const run of runs) {
      const own = rowsOf.get(run.id) ?? [];
      const perModel = new Map<
        string,
        { provider: string; model: string; tokens: TaskTokenTotals | null }
      >();
      let tokens: TaskTokenTotals | null = null;
      for (const row of own) {
        const key = `${row.provider}\u0000${row.model}`;
        const entry = perModel.get(key) ?? {
          provider: row.provider,
          model: row.model,
          tokens: null,
        };
        entry.tokens = add(entry.tokens, row);
        perModel.set(key, entry);
        tokens = add(tokens, row);
      }
      totals.runs += 1;
      if (tokens === null) totals.runsWithoutData += 1;
      totals.tokens = addTotals(totals.tokens, tokens);
      for (const [key, entry] of perModel) {
        const group = models.get(key) ?? {
          provider: entry.provider,
          model: entry.model,
          tokens: null,
          runs: 0,
          runsWithoutData: 0,
        };
        group.runs += 1;
        if (entry.tokens === null) group.runsWithoutData += 1;
        group.tokens = addTotals(group.tokens, entry.tokens);
        models.set(key, group);
      }
      runViews.push({
        runId: run.id,
        taskId: run.task_id,
        agentId: run.agent_id ?? executorOf(run.task_id),
        mentioned: run.agent_id !== null,
        status: run.status as TaskRunStatus,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
        tokens,
        models: [...perModel.values()].sort(byTokens),
      });
    }
    return {
      taskId,
      includesSubtasks: includeSubtasks,
      taskIds,
      totals,
      models: [...models.values()].sort(byTokens),
      runs: runViews,
    };
  }

  /**
   * Fill in the runs that ended before usage was counted per run, once each: from the usage table,
   * else from the session's journal on this machine, else nothing (the run has no data). Every run
   * looked at is marked, found or not, so it is never looked at again. Returns how many runs were
   * looked at.
   */
  async backfill(): Promise<number> {
    const pending = this.#db
      .query<RunRow, []>(
        `SELECT id, task_id, agent_id, status, session_id, started_at, created_at, finished_at
           FROM task_run WHERE usage_counted IS NULL
          ORDER BY created_at, rowid`,
      )
      .all()
      // One still going was started by this version, which counts it live; leave it.
      .filter((run) => !OPEN.has(run.status));
    const journals = new Map<string, Promise<RunMessageUsage[] | undefined>>();
    for (const run of pending) {
      let usage: RunMessageUsage[] = [];
      let source: Source = "usage";
      if (run.session_id !== null) {
        const [from, until] = this.#windowOf(run);
        usage = this.#fromUsageTable(run.session_id, from, until);
        if (usage.length === 0) {
          source = "journal";
          let read = journals.get(run.session_id);
          if (read === undefined) {
            read = this.#journal(run.session_id);
            journals.set(run.session_id, read);
          }
          const messages = (await read) ?? [];
          const mine = messages.filter((m) => m.at >= from && m.at < until);
          // An old journal cannot tell "not reported" from 0: a run whose messages are all zeros is
          // taken as one whose runtime said nothing (one that worked used something).
          usage = mine.some(
            ({ tokens: t }) =>
              t !== null && t.input + t.output + t.cacheRead + t.cacheWrite > 0,
          )
            ? mine
            : [];
        }
      }
      this.#db.transaction(() => {
        const marked = this.#db
          .query(
            "UPDATE task_run SET usage_counted = 'backfill' WHERE id = ? AND usage_counted IS NULL",
          )
          .run(run.id).changes;
        if (marked > 0 && usage.length > 0) this.#insert(run.id, usage, source);
      })();
      if (usage.length > 0) this.#changed(run.task_id);
    }
    return pending.length;
  }

  /** From the run's start until the next run of the same session started. */
  #windowOf(run: RunRow): [number, number] {
    const from = run.started_at ?? run.created_at;
    const next = this.#db
      .query<{ at: number | null }, [string, string, number]>(
        `SELECT MIN(COALESCE(started_at, created_at)) AS at FROM task_run
          WHERE session_id = ? AND id <> ? AND COALESCE(started_at, created_at) > ?`,
      )
      .get(run.session_id!, run.id, from)?.at;
    return [from, next ?? Number.MAX_SAFE_INTEGER];
  }

  /** The usage table's generations of a session in a window, as rows. */
  #fromUsageTable(
    sessionId: string,
    from: number,
    until: number,
  ): RunMessageUsage[] {
    return this.#db
      .query<
        {
          at: number;
          provider: string;
          model: string;
          input: number;
          output: number;
          cache_read: number;
          cache_write: number;
          reasoning: number;
          status: string;
        },
        [string, number, number]
      >(
        `SELECT at, provider, model, input, output, cache_read, cache_write, reasoning, status
           FROM usage WHERE session_id = ? AND at >= ? AND at < ? ORDER BY at, id`,
      )
      .all(sessionId, from, until)
      .map((row) => {
        const none =
          row.status === "ok" &&
          row.input + row.output + row.cache_read + row.cache_write === 0;
        return {
          at: row.at,
          provider: row.provider,
          model: row.model,
          // The table kept no "not reported": 0 reasoning is all it could say, so it says nothing.
          tokens: none
            ? null
            : {
                input: row.input,
                output: row.output,
                cacheRead: row.cache_read,
                cacheWrite: row.cache_write,
                ...(row.reasoning > 0 ? { reasoning: row.reasoning } : {}),
              },
        };
      });
  }

  /**
   * The assistant messages of a session's journal on this machine, with their tokens; undefined
   * when it is not here (a daemon's session) or cannot be read. Read only: the session may be open.
   */
  async #journal(sessionId: string): Promise<RunMessageUsage[] | undefined> {
    if (!/^[\w-]+$/.test(sessionId)) return undefined;
    let text: string;
    try {
      text = await readFile(
        join(this.#options.dataDir, "sessions", sessionId, "journal.jsonl"),
        "utf8",
      );
    } catch {
      return undefined;
    }
    const seen = new Set<string>();
    const found: RunMessageUsage[] = [];
    for (const line of text.split("\n")) {
      if (!line.includes('"assistant"')) continue;
      let parsed: { w?: unknown };
      try {
        parsed = JSON.parse(line) as { w?: unknown };
      } catch {
        continue;
      }
      if (!Array.isArray(parsed.w)) continue;
      for (const write of parsed.w as {
        kind?: unknown;
        entry?: { id?: unknown; type?: unknown; message?: unknown };
      }[]) {
        if (write?.kind !== "entry" || write.entry?.type !== "message")
          continue;
        const message = write.entry.message as Partial<AssistantMessage>;
        if (message?.role !== "assistant" || message.usage === undefined)
          continue;
        // A compacted journal writes its entries again; each counts once.
        const id =
          typeof write.entry.id === "string" ? write.entry.id : undefined;
        if (id !== undefined) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        const usage = message.usage;
        found.push({
          at: typeof message.timestamp === "number" ? message.timestamp : 0,
          provider: String(message.provider ?? "unknown"),
          model: String(message.model ?? "unknown"),
          tokens: tokensReported(usage)
            ? {
                input: usage.input,
                output: usage.output,
                cacheRead: usage.cacheRead,
                cacheWrite: usage.cacheWrite,
                ...(usage.reasoning === undefined
                  ? {}
                  : { reasoning: usage.reasoning }),
              }
            : null,
        });
      }
    }
    return found;
  }
}
