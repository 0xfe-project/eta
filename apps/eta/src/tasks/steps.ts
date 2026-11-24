import type { TaskStepView } from "@eta/client-contracts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TASK_STEP_STATUSES } from "@eta/client-contracts";

/**
 * A task's steps: the plan its executor keeps with `create_step` / `update_step`.
 *
 * They live in the executor's session, not on the board: the session writes its whole ledger as the
 * value `eta.tasks.state` into its journal each time a step moves (`TASKS_STATE`, which the harness
 * owns), the last write being the current plan. The board shows the plan of the executor's latest
 * run, read from that journal on this machine; a session whose journal is not here (a daemon's) or
 * that has not started has none.
 */
const LEDGER = "eta.tasks.state";

const isStatus = (value: unknown): value is TaskStepView["status"] =>
  (TASK_STEP_STATUSES as readonly unknown[]).includes(value);

/** The steps of a journal's last write of the ledger; a row that is not a step is left out. */
export function stepsOfJournal(text: string): TaskStepView[] {
  let ledger: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes(LEDGER)) continue;
    let parsed: { w?: unknown };
    try {
      parsed = JSON.parse(line) as { w?: unknown };
    } catch {
      continue;
    }
    if (!Array.isArray(parsed.w)) continue;
    for (const write of parsed.w as {
      kind?: unknown;
      op?: unknown;
      namespace?: unknown;
      key?: unknown;
      value?: unknown;
    }[]) {
      if (write?.kind !== "value" || write.namespace !== LEDGER) continue;
      if (write.key !== "") continue;
      ledger =
        write.op === "set" && Array.isArray(write.value) ? write.value : [];
    }
  }
  const steps: TaskStepView[] = [];
  for (const row of ledger as Partial<TaskStepView>[]) {
    if (
      typeof row?.id === "string" &&
      typeof row.content === "string" &&
      isStatus(row.status)
    )
      steps.push({ id: row.id, content: row.content, status: row.status });
  }
  return steps;
}

/**
 * The session of the executor's latest run (oldest first, as `BoardTaskDetail.runs`): a run of an
 * agent mentioned on the task keeps a plan of its own and is not the task's. Null until that run
 * has started a session.
 */
export function executorSessionOf(
  runs: readonly { agentId: string | null; sessionId: string | null }[],
): string | null {
  const executors = runs.filter((run) => run.agentId === null);
  return executors.at(-1)?.sessionId ?? null;
}

export interface TaskStepsOptions {
  /** Where this host keeps its sessions' journals (`<dataDir>/sessions/<id>/journal.jsonl`). */
  dataDir: string;
  /** The task a session works for, if it is a task's. */
  taskOfSession: (sessionId: string) => string | undefined;
}

export class TaskSteps {
  readonly #options: TaskStepsOptions;
  readonly #listeners = new Set<(taskId: string) => void>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: TaskStepsOptions) {
    this.#options = options;
  }

  /** Told the task whose session's plan moved. */
  onChange(listener: (taskId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** A session's plan moved: its task, if it has one, is told. */
  changed(sessionId: string): void {
    const taskId = this.#options.taskOfSession(sessionId);
    if (taskId === undefined) return;
    for (const listener of this.#listeners) listener(taskId);
  }

  /**
   * A session's plan moved, but its journal takes the ledger a moment after the event: tell the
   * task once `delayMs` have passed. `stop` drops what is still waiting.
   */
  changedSoon(sessionId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.changed(sessionId);
    }, delayMs);
    this.#timers.add(timer);
  }

  /** The host is closing: nothing waiting may fire into what it closed. */
  stop(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  /** The plan of the executor's latest run; none when its journal is not on this machine. */
  ofRuns(
    runs: readonly { agentId: string | null; sessionId: string | null }[],
  ): TaskStepView[] {
    const session = executorSessionOf(runs);
    if (session === null || !/^[\w-]+$/.test(session)) return [];
    try {
      return stepsOfJournal(
        readFileSync(
          join(this.#options.dataDir, "sessions", session, "journal.jsonl"),
          "utf8",
        ),
      );
    } catch {
      return [];
    }
  }
}
