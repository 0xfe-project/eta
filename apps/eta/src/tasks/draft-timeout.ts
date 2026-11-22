/**
 * The host's own decision for a task draft nobody answered: one that waited past the user's limit
 * is confirmed as it stands or discarded (`TaskBoard.settleExpiredDrafts` does it). The wait is
 * counted from the draft's own creation time, so it survives a restart and no timer is kept per
 * draft. The setting is read on every look, so a change takes hold at the next one.
 */
import type { SettingStore } from "../settings/store";
import type { TaskBoard } from "./board";
import { boardSettings } from "./archiver";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** How often it looks; a draft is settled at most this late. */
const EVERY = 30 * SECOND;

export interface TaskDraftExpirerDeps {
  board: Pick<TaskBoard, "settleExpiredDrafts">;
  settings: Pick<SettingStore, "get">;
  /** False leaves the clock off; `sweep()` is then the only way it looks. */
  timer?: boolean;
  now?: () => number;
  warn?: (message: string) => void;
}

export class TaskDraftExpirer {
  readonly #deps: TaskDraftExpirerDeps;
  #interval: ReturnType<typeof setInterval> | undefined;

  constructor(deps: TaskDraftExpirerDeps) {
    this.#deps = deps;
  }

  /** Look now, and every half minute until `stop`. */
  start(): void {
    if (this.#deps.timer === false || this.#interval !== undefined) return;
    this.sweep();
    this.#interval = setInterval(() => this.sweep(), EVERY);
    (this.#interval as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.#interval !== undefined) clearInterval(this.#interval);
    this.#interval = undefined;
  }

  /** Settle what is overdue now, as the setting says; the ids of the drafts it settled. */
  sweep(): string[] {
    const { draftTimeout } = boardSettings(this.#deps.settings);
    if (draftTimeout?.enabled !== true) return [];
    try {
      const { settled, failed } = this.#deps.board.settleExpiredDrafts({
        cutoff:
          (this.#deps.now?.() ?? Date.now()) - draftTimeout.minutes * MINUTE,
        action: draftTimeout.action,
        minutes: draftTimeout.minutes,
      });
      for (const one of failed)
        this.#deps.warn?.(
          `[eta] could not settle task draft ${one.messageId} automatically: ${one.error}`,
        );
      return settled;
    } catch (error) {
      this.#deps.warn?.(
        `[eta] settling overdue task drafts failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
}
