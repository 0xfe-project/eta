/**
 * Whose a session is: a conversation's, a task's or a routine run's. The one place that reads it
 * from the key a session is held in (`SessionMeta.conversationId`), and the one that makes keys.
 *
 * A conversation member's session is held in its conversation's id. A task's or a routine run's
 * is held in no conversation, so its key is a prefix and an id; no other id in the product starts
 * with one of these prefixes, so a key with one is that owner's and nothing else's.
 *
 * - `task:<taskId>`: a task's executor. The key names the task, not a run: a session outlives the
 *   run that made it, and a later comment wakes the executor in the same session. A run records
 *   the key it was made with (`task_run.session_key`) and every later run reuses it.
 * - `task:<taskId>:<agentId>`: an agent mentioned on the task, in a session of its own. Still the
 *   task's. A task's id has no colon, so the first segment is the task.
 * - `task-run:<runId>`: a session made before the key named the task. Which task it is takes a
 *   look at the run, so the caller passes `taskOfRun`; without it the task is unknown.
 * - `routine:<runId>`: a routine run's Captain session.
 */
export type SessionOwner =
  | { kind: "conversation"; conversationId: string }
  | { kind: "task"; taskId: string | undefined }
  | { kind: "routine"; runId: string };

const TASK = "task:";
const LEGACY_RUN = "task-run:";
const ROUTINE = "routine:";

/** The key a task's executor session is held in. */
export const taskKey = (taskId: string): string => `${TASK}${taskId}`;

/** The key the session of an agent mentioned on a task is held in: one per agent. */
export const mentionKey = (taskId: string, agentId: string): string =>
  `${taskKey(taskId)}:${agentId}`;

/** The key a routine run's session is held in. */
export const routineKey = (runId: string): string => `${ROUTINE}${runId}`;

/** The key a task run's session is held in: the one it recorded, or the one it was made with. */
export const sessionKeyOf = (run: {
  id: string;
  sessionKey: string | null;
}): string => run.sessionKey ?? `${LEGACY_RUN}${run.id}`;

/** Whose the session held in `key` is; nobody's when it is held in nothing. */
export function ownerOf(
  key: string | undefined,
  taskOfRun: (runId: string) => string | undefined = () => undefined,
): SessionOwner | undefined {
  if (key === undefined) return undefined;
  if (key.startsWith(TASK))
    return { kind: "task", taskId: key.slice(TASK.length).split(":")[0] };
  if (key.startsWith(LEGACY_RUN))
    return { kind: "task", taskId: taskOfRun(key.slice(LEGACY_RUN.length)) };
  if (key.startsWith(ROUTINE))
    return { kind: "routine", runId: key.slice(ROUTINE.length) };
  return { kind: "conversation", conversationId: key };
}

/** The task a session is a task's session of, if it is one. */
export const taskOf = (
  key: string | undefined,
  taskOfRun?: (runId: string) => string | undefined,
): string | undefined => {
  const owner = ownerOf(key, taskOfRun);
  return owner?.kind === "task" ? owner.taskId : undefined;
};

/** What a session is held in; a session held in nothing is treated as a conversation's. */
export const heldIn = (
  key: string | undefined,
): "conversation" | "task" | "routine" => ownerOf(key)?.kind ?? "conversation";

/**
 * The conversation a session is counted, asked and remembered in: its own, or the one its task
 * came from (`originOf`). A routine run's is in none.
 */
export function conversationOf(
  owner: SessionOwner | undefined,
  originOf: (taskId: string) => string | null | undefined,
): string | undefined {
  if (owner?.kind === "conversation") return owner.conversationId;
  if (owner?.kind !== "task" || owner.taskId === undefined) return undefined;
  return originOf(owner.taskId) ?? undefined;
}
