/**
 * What an agent is told about a task that is archived, before and after it touches one.
 *
 * Anything new on an archived task brings it back onto the board (`#revive` in `store.ts`), and
 * archiving is usually the user's own act: an agent that retitles or comments on a task the user put
 * away undoes that without ever having seen it. The tools that write on a task still go through on
 * an archived one (the user chose a note, not a hold), and the result says what the change undid,
 * so the agent tells the user. The reading tools say a task is archived, by whom and when, so the
 * agent knows before it tries.
 */
import type { BoardTaskView, TaskActivityView } from "@eta/client-contracts";
import type { TaskBoard } from "./board";
import { archivedEntry } from "@eta/client-contracts";

/** A time as a model reads it at a glance: `2026-11-24 01:38 UTC`. */
const minuteOf = (at: number): string =>
  `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

type Archivable = Pick<
  BoardTaskView,
  "id" | "number" | "archivedAt" | "archivedBy"
>;

const isArchived = (task: Archivable): boolean =>
  task.archivedAt !== null && task.archivedAt !== undefined;

/**
 * Who put the task away, when and how, in words: `the user put it away by hand at …`. Undefined
 * for a task that is not archived. `nameOf` names an agent that archived it.
 */
export function archivedSaid(
  task: Archivable,
  activity: readonly TaskActivityView[],
  nameOf: (agentId: string) => string,
): string | undefined {
  if (!isArchived(task)) return undefined;
  const last = [...activity]
    .reverse()
    .find((entry) => entry.kind === "archived");
  const read = archivedEntry(last?.data ?? {});
  const by = task.archivedBy ?? read.by;
  const when = minuteOf(task.archivedAt!);
  const along =
    read.with === null ? "" : ` (along with its parent #${read.with.number})`;
  if (by === "auto" || read.reason === "stale")
    return `the host archived it by itself at ${when}${along}, because it was done or cancelled and quiet for ${read.days ?? "some"} days`;
  if (by === "user")
    return `the user archived it by hand at ${when}${along}: they put it away on purpose`;
  return `${nameOf(by)} archived it at ${when}${along}`;
}

/** The sentence the descriptions of the writing tools share. */
export const ARCHIVED_RULE =
  "On an archived task (the task-reading tools say so, with who archived it and when) the call " +
  "still goes through, and anything new on it brings it back onto the board, undoing whoever " +
  "archived it (usually the user, on purpose); the result then says so, and you tell the user.";

export interface ArchivedNote {
  /**
   * Before a change: for an archived task, what to add to the result once the change is made
   * (`after`); nothing for a task that is not archived. It never stops the change.
   */
  before: (taskId: string) => { after: () => string } | undefined;
}

/**
 * The note for one set of tools. `rearchive` is how the agent puts the task away again, for one
 * that already can (Captain); others are only told to tell the user.
 */
export function archivedNote(
  board: TaskBoard,
  nameOf: (agentId: string) => string,
  options: { rearchive?: string } = {},
): ArchivedNote {
  return {
    before(taskId) {
      const task = board.find(taskId);
      if (task === undefined || !isArchived(task)) return undefined;
      const said = archivedSaid(task, board.activity(task.id), nameOf)!;
      return {
        after: () => {
          const now = board.find(task.id);
          if (now !== undefined && isArchived(now))
            return `\n\nNote: #${task.number} is archived (${said}). Nothing new was written on it, so it stays archived.`;
          return (
            `\n\nNote: #${task.number} was archived: ${said}. This change brought it back onto ` +
            `the board; tell the user.${options.rearchive === undefined ? "" : ` ${options.rearchive}`}`
          );
        },
      };
    },
  };
}
