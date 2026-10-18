/**
 * Transient task-reminder cadence — full port of eta-agent's
 * harness/cadence.ts (pi-tasks' reminder-cadence.ts).
 *
 * Pure decisions owned by the harness reminder service. It owns the
 * signal — when a reminder is due — and the prompts module owns the text and
 * the injection; nothing lands in the transcript, and the cache prefix stays
 * intact.
 */

export interface CadenceState {
  currentTurn: number;
  lastTaskToolUseTurn: number;
  reminderInjectedThisCycle: boolean;
  reminderDue: boolean;
}

export interface CadenceConfig {
  /** Turns without a task-tool call before a reminder is considered due. */
  reminderInterval: number;
  /** Tool names that count as task-tool usage and reset the cadence. */
  taskToolNames: ReadonlySet<string>;
}

/** The default set: the task tools, as the prompts plugin will register them. */
export const DEFAULT_TASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  "TaskCreate",
  "TaskList",
  "TaskGet",
  "TaskUpdate",
]);

export const DEFAULT_REMINDER_INTERVAL = 5;

export function createCadenceState(): CadenceState {
  return {
    currentTurn: 0,
    lastTaskToolUseTurn: 0,
    reminderInjectedThisCycle: false,
    reminderDue: false,
  };
}

export function resetCadenceState(state: CadenceState): void {
  state.currentTurn = 0;
  state.lastTaskToolUseTurn = 0;
  state.reminderInjectedThisCycle = false;
  state.reminderDue = false;
}

/** Call at turn start. */
export function onTurnStart(state: CadenceState): void {
  state.currentTurn += 1;
}

/** Decide what a tool result implies for the cadence; mutates state. */
export function evaluateToolResult(
  state: CadenceState,
  toolName: string,
  hasTasks: boolean,
  config: CadenceConfig,
): { markDue: boolean } {
  if (config.taskToolNames.has(toolName)) {
    state.lastTaskToolUseTurn = state.currentTurn;
    state.reminderInjectedThisCycle = false;
    state.reminderDue = false;
    return { markDue: false };
  }
  if (state.currentTurn - state.lastTaskToolUseTurn < config.reminderInterval)
    return { markDue: false };
  if (state.reminderInjectedThisCycle) return { markDue: false };
  if (!hasTasks) return { markDue: false };
  state.reminderDue = true;
  return { markDue: true };
}

/** Drain a pending reminder before a request; true = inject it this time. */
export function drainReminderForContext(state: CadenceState): boolean {
  if (!state.reminderDue) return false;
  state.reminderDue = false;
  state.reminderInjectedThisCycle = true;
  state.lastTaskToolUseTurn = state.currentTurn;
  return true;
}
