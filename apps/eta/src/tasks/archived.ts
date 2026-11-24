/**
 * What an agent is told about a task that is archived, before and after it touches one.
 *
 * Anything new on an archived task brings it back onto the board (`#revive` in `store.ts`), and
 * archiving is usually the user's own act: an agent that retitles or comments on a task the user put
 * away undoes that without ever having seen it. So the tools that write on a task refuse an archived
 * one until the agent says it knows (`confirmArchived`), and when it does, the result says what
 * the change undid, so the agent can tell the user. The reading tools say a task is archived, by
 * whom and when, so the agent knows before it tries.
 */
import type { BoardTaskView, TaskActivityView } from "@eta/client-contracts";
import type { TaskBoard } from "./board";
import { archivedEntry } from "@eta/client-contracts";
import { Type } from "typebox";

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

/** The parameter every tool that writes on a task carries. */
export const confirmArchivedParameter = Type.Optional(
  Type.Boolean({
    description:
      "Only for a task that is archived: true says you know this brings it back onto the board, " +
      "undoing whoever archived it (usually the user, on purpose). Without it an archived task is " +
      "refused and nothing changes.",
  }),
);

/** The sentence the descriptions of the writing tools share. */
export const ARCHIVED_RULE =
  "An archived task (the task-reading tools say so, with who archived it and when) comes back onto the board when anything " +
  "new happens on it, and archiving is usually the user's own decision: such a call is refused " +
  "unless you pass confirmArchived: true, which you do only when the user asked for the change.";

export interface ArchivedGuard {
  /**
   * Before a change: throws, for an archived task and no confirmation, an error that says who
   * archived it and what to do instead; else returns what to add to the result once the change is
   * made (`after`), or nothing for a task that is not archived.
   */
  before: (
    taskId: string,
    confirmed: boolean | undefined,
    tool: string,
  ) => { after: () => string } | undefined;
}

/**
 * The guard for one set of tools. `instead` is what the refusal offers besides confirming (a new
 * task, for an agent that can make one); `rearchive` is how the agent puts it away again, when it
 * can.
 */
export function archivedGuard(
  board: TaskBoard,
  nameOf: (agentId: string) => string,
  options: { instead?: string; rearchive?: string } = {},
): ArchivedGuard {
  return {
    before(taskId, confirmed, tool) {
      const task = board.find(taskId);
      if (task === undefined || !isArchived(task)) return undefined;
      const said = archivedSaid(task, board.activity(task.id), nameOf)!;
      if (confirmed !== true)
        throw new Error(
          `#${task.number} is archived: ${said}. Nothing was changed. Changing or commenting on ` +
            "an archived task brings it back onto the board, which undoes that archive" +
            `${options.rearchive === undefined ? ", and you cannot archive it again" : ""}. ` +
            `If the user asked for this, call ${tool} again with confirmArchived: true` +
            `${options.instead === undefined ? "" : `; ${options.instead.replaceAll("#N", `#${task.number}`)}`}.`,
        );
      return {
        after: () => {
          const now = board.find(task.id);
          if (now !== undefined && isArchived(now))
            return `\n\nNote: #${task.number} is archived (${said}). Nothing new was written on it, so it stays archived.`;
          return (
            `\n\nNote: #${task.number} was archived: ${said}. This change brought it back onto ` +
            `the board. If the user meant it to stay put away, tell them; ${
              options.rearchive ?? "agents cannot archive it again."
            }`
          );
        },
      };
    },
  };
}
