/**
 * The host's own tidying of the board: done and cancelled tasks that have been quiet for a while
 * are archived (`TaskBoard.archiveStale` says which), once when the host starts and every hour
 * after. How long "a while" is, or never, is the user's setting, kept with the host's others.
 */
import type { TaskArchiveDays, TaskBoardSettings } from "@eta/client-contracts";
import type { SettingStore } from "../settings/store";
import type { TaskBoard } from "./board";
import {
  DEFAULT_TASK_ARCHIVE_DAYS,
  TASK_ARCHIVE_DAYS,
} from "@eta/client-contracts";

/** The setting's key: a number of days from `TASK_ARCHIVE_DAYS`, or null for never. */
const ARCHIVE_AFTER_SETTING = "tasks.archiveAfterDays";

/** The setting's key: whether `finish_task` wakes the task's maker (a boolean; off when never set). */
const REACT_TO_RESULTS_SETTING = "tasks.reactToResults";

const HOUR = 60 * 60 * 1000;

/** The board's settings as stored; anything unreadable is the default. */
export function boardSettings(
  settings: Pick<SettingStore, "get">,
): TaskBoardSettings {
  const stored = settings.get(ARCHIVE_AFTER_SETTING);
  const reactToResults = settings.get(REACT_TO_RESULTS_SETTING) === true;
  if (stored === null) return { archiveAfterDays: null, reactToResults };
  return {
    archiveAfterDays: (TASK_ARCHIVE_DAYS as readonly unknown[]).includes(stored)
      ? (stored as TaskArchiveDays)
      : DEFAULT_TASK_ARCHIVE_DAYS,
    reactToResults,
  };
}

/** Check and keep what a caller asked for; a value the setting does not offer is refused. */
export function saveBoardSettings(
  settings: Pick<SettingStore, "get" | "set">,
  input: { archiveAfterDays?: unknown; reactToResults?: unknown },
): TaskBoardSettings {
  if (
    input.reactToResults !== undefined &&
    typeof input.reactToResults !== "boolean"
  )
    throw new Error(
      `reactToResults is true or false, not ${JSON.stringify(input.reactToResults)}`,
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
