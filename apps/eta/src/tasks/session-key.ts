/**
 * What an executor's session is held in.
 *
 * A conversation's session carries its conversation's id (`SessionMeta.conversationId`), which is
 * how its tools know where they speak, how a daemon keys what the primary told it about the
 * session, and how usage and questions are filed. A task's session is held in no conversation, but
 * it needs the same things, so its `conversationId` is this key. Nothing else in the product is
 * made of such an id, so a key that starts with either prefix is a task's and nothing else's.
 *
 * **The key names the task, not one of its runs.** A session outlives the run that made it: a
 * comment that arrives once no run is going wakes the executor again in the same session, so that
 * it carries on with what it already knows rather than reading the project again. A run is one
 * turn of the task's session, so the thing a key could name and still keep meaning the same
 * tomorrow is the task: `task:` and the task's id.
 *
 * A session keeps the key it was made with, since that is what the machine holding it files its
 * journal, its prompt and its tools under. So the run that made a session records the key
 * (`task_run.session_key`) and every later run of that session reuses it — which is also how a
 * session made while the key still named a run (`task-run:` and the run's id, from before a task
 * had one session to keep) is found and reopened.
 *
 * An agent mentioned on the task answers in a session of its own, held in the task's key with the
 * agent's id after it (`mentionKey`): still the task's, so everything that asks "which task is this
 * session's" gets the same answer.
 */
const TASK_PREFIX = "task:";

/** What every session made before the key named the task is held in: `task-run:` and a run's id. */
const RUN_PREFIX = "task-run:";

/** The key a task's own session is held in. */
export const taskKey = (taskId: string): string => `${TASK_PREFIX}${taskId}`;

/**
 * The key the session of an agent mentioned on a task is held in: the task's key and the agent.
 * It is the task's like the executor's, and one per agent, so being mentioned again carries on.
 */
export const mentionKey = (taskId: string, agentId: string): string =>
  `${taskKey(taskId)}:${agentId}`;

/** The key a session made before the key named the task is held in. */
const runKey = (runId: string): string => `${RUN_PREFIX}${runId}`;

/** The key this run's session is held in: the one it recorded, or the one it was made with. */
export function sessionKeyOf(run: {
  id: string;
  sessionKey: string | null;
}): string {
  return run.sessionKey ?? runKey(run.id);
}

/** Whether a session is an executor's rather than a conversation member's. */
export function isTaskSession(conversationId: string | undefined): boolean {
  return (
    conversationId?.startsWith(TASK_PREFIX) === true ||
    conversationId?.startsWith(RUN_PREFIX) === true
  );
}

/**
 * The task a session's key belongs to, whichever form the key is in. `taskOfRun` says what task an
 * older key's run was an attempt at; a key naming a task needs nobody.
 */
export function taskOfKey(
  conversationId: string | undefined,
  taskOfRun: (runId: string) => string | undefined,
): string | undefined {
  if (conversationId === undefined) return undefined;
  // A mentioned agent's key goes on past the task's id (which has no colon) with its own.
  if (conversationId.startsWith(TASK_PREFIX))
    return conversationId.slice(TASK_PREFIX.length).split(":")[0];
  return conversationId.startsWith(RUN_PREFIX)
    ? taskOfRun(conversationId.slice(RUN_PREFIX.length))
    : undefined;
}
