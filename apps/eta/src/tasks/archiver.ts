/**
 * The host's own tidying of the board: done and cancelled tasks that have been quiet for a while
 * are archived (`TaskBoard.archiveStale` says which), once when the host starts and every hour
 * after. How long "a while" is, or never, is the user's setting, kept with the host's others.
 */
import type {
  TaskArchiveDays,
  TaskBoardSettings,
  TaskDraftTimeout,
} from "@eta/client-contracts";
import type { SettingStore } from "../settings/store";
import type { TaskBoard } from "./board";
import {
  DEFAULT_TASK_ARCHIVE_DAYS,
  TASK_ARCHIVE_DAYS,
  TASK_DRAFT_TIMEOUT_ACTIONS,
  TASK_DRAFT_TIMEOUT_MINUTES,
} from "@eta/client-contracts";

/** The setting's key: a number of days from `TASK_ARCHIVE_DAYS`, or null for never. */
const ARCHIVE_AFTER_SETTING = "tasks.archiveAfterDays";

/** The setting's key: whether `finish_task` wakes the task's maker (a boolean; off when never set). */
const REACT_TO_RESULTS_SETTING = "tasks.reactToResults";
/** The setting's key: true lets a task's maker answer its executor's questions first; off by default. */
const AUTO_ANSWER_ASKS_SETTING = "tasks.autoAnswerAsks";
/** The setting's key: a `TaskDraftTimeout`; off, 10 minutes, discard when never set. */
const DRAFT_TIMEOUT_SETTING = "tasks.draftTimeout";

const HOUR = 60 * 60 * 1000;

const DEFAULT_DRAFT_TIMEOUT: TaskDraftTimeout = {
  enabled: false,
  minutes: TASK_DRAFT_TIMEOUT_MINUTES.default,
  action: "discard",
};

const isMinutes = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= TASK_DRAFT_TIMEOUT_MINUTES.min &&
  value <= TASK_DRAFT_TIMEOUT_MINUTES.max;

const isAction = (value: unknown): value is TaskDraftTimeout["action"] =>
  (TASK_DRAFT_TIMEOUT_ACTIONS as readonly unknown[]).includes(value);

/** The draft timeout as stored; each field that is unreadable is its default. */
function draftTimeoutOf(stored: unknown): TaskDraftTimeout {
  const raw =
    typeof stored === "object" && stored !== null
      ? (stored as Record<string, unknown>)
      : {};
  return {
    enabled: raw.enabled === true,
    minutes: isMinutes(raw.minutes)
      ? raw.minutes
      : DEFAULT_DRAFT_TIMEOUT.minutes,
    action: isAction(raw.action) ? raw.action : DEFAULT_DRAFT_TIMEOUT.action,
  };
}

/** What a caller sent for the draft timeout, checked field by field over what is kept. */
function checkedDraftTimeout(
  current: TaskDraftTimeout,
  input: unknown,
): TaskDraftTimeout {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("draftTimeout is an object of enabled, minutes and action");
  const raw = input as Record<string, unknown>;
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean")
    throw new Error(
      `draftTimeout.enabled is true or false, not ${JSON.stringify(raw.enabled)}`,
    );
  if (raw.minutes !== undefined && !isMinutes(raw.minutes))
    throw new Error(
      `draftTimeout.minutes is a whole number from ${TASK_DRAFT_TIMEOUT_MINUTES.min} to ${TASK_DRAFT_TIMEOUT_MINUTES.max}, not ${JSON.stringify(raw.minutes)}`,
    );
  if (raw.action !== undefined && !isAction(raw.action))
    throw new Error(
      `draftTimeout.action is one of ${TASK_DRAFT_TIMEOUT_ACTIONS.join(", ")}, not ${JSON.stringify(raw.action)}`,
    );
  return {
    enabled: raw.enabled ?? current.enabled,
    minutes: raw.minutes ?? current.minutes,
    action: raw.action ?? current.action,
  };
}

/** The board's settings as stored; anything unreadable is the default. */
export function boardSettings(
  settings: Pick<SettingStore, "get">,
): TaskBoardSettings {
  const stored = settings.get(ARCHIVE_AFTER_SETTING);
  const reactToResults = settings.get(REACT_TO_RESULTS_SETTING) === true;
  const autoAnswerAsks = settings.get(AUTO_ANSWER_ASKS_SETTING) === true;
  const draftTimeout = draftTimeoutOf(settings.get(DRAFT_TIMEOUT_SETTING));
  if (stored === null)
    return {
      archiveAfterDays: null,
      reactToResults,
      autoAnswerAsks,
      draftTimeout,
    };
  return {
    archiveAfterDays: (TASK_ARCHIVE_DAYS as readonly unknown[]).includes(stored)
      ? (stored as TaskArchiveDays)
      : DEFAULT_TASK_ARCHIVE_DAYS,
    reactToResults,
    autoAnswerAsks,
    draftTimeout,
  };
}

/** Check and keep what a caller asked for; a value the setting does not offer is refused. */
export function saveBoardSettings(
  settings: Pick<SettingStore, "get" | "set">,
  input: {
    archiveAfterDays?: unknown;
    reactToResults?: unknown;
    autoAnswerAsks?: unknown;
    draftTimeout?: unknown;
  },
): TaskBoardSettings {
  // Everything is checked before anything is kept, so a refused call changes nothing.
  const draftTimeout =
    input.draftTimeout === undefined
      ? undefined
      : checkedDraftTimeout(
          draftTimeoutOf(settings.get(DRAFT_TIMEOUT_SETTING)),
          input.draftTimeout,
        );
  if (
    input.reactToResults !== undefined &&
    typeof input.reactToResults !== "boolean"
  )
    throw new Error(
      `reactToResults is true or false, not ${JSON.stringify(input.reactToResults)}`,
    );
  if (
    input.autoAnswerAsks !== undefined &&
    typeof input.autoAnswerAsks !== "boolean"
  )
    throw new Error(
      `autoAnswerAsks is true or false, not ${JSON.stringify(input.autoAnswerAsks)}`,
    );
  if (input.archiveAfterDays !== undefined) {
    const days = input.archiveAfterDays;
    if (
      days !== null &&
      !(TASK_ARCHIVE_DAYS as readonly unknown[]).includes(days)
    )
      throw new Error(
        `archiveAfterDays is one of ${TASK_ARCHIVE_DAYS.join(", ")} or null, not ${JSON.stringify(days)}`,
      );
    settings.set(ARCHIVE_AFTER_SETTING, days);
  }
  if (input.reactToResults !== undefined)
    settings.set(REACT_TO_RESULTS_SETTING, input.reactToResults);
  if (input.autoAnswerAsks !== undefined)
    settings.set(AUTO_ANSWER_ASKS_SETTING, input.autoAnswerAsks);
  if (draftTimeout !== undefined)
    settings.set(DRAFT_TIMEOUT_SETTING, draftTimeout);
  return boardSettings(settings);
}

export interface TaskArchiverDeps {
  board: Pick<TaskBoard, "archiveStale">;
  settings: Pick<SettingStore, "get">;
  /** False leaves the clock off; `sweep()` is then the only way it looks. */
  timer?: boolean;
  now?: () => number;
  warn?: (message: string) => void;
}

export class TaskArchiver {
  readonly #deps: TaskArchiverDeps;
  #interval: ReturnType<typeof setInterval> | undefined;

  constructor(deps: TaskArchiverDeps) {
    this.#deps = deps;
  }

  /** Sweep now, and every hour until `stop`. */
  start(): void {
    if (this.#deps.timer === false || this.#interval !== undefined) return;
    this.sweep();
    this.#interval = setInterval(() => this.sweep(), HOUR);
    // An hourly tidy is no reason for a process to stay up.
    (this.#interval as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.#interval !== undefined) clearInterval(this.#interval);
    this.#interval = undefined;
  }

  /** Archive what is due now, as the setting says; the ids it archived. */
  sweep(): string[] {
    const { archiveAfterDays } = boardSettings(this.#deps.settings);
    if (archiveAfterDays === null) return [];
    try {
      return this.#deps.board.archiveStale(
        archiveAfterDays,
        this.#deps.now?.() ?? Date.now(),
      );
    } catch (error) {
      this.#deps.warn?.(
        `[eta] archiving quiet tasks failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
}
