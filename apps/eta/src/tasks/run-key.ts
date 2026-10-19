/**
 * What a task run's session is held in.
 *
 * A conversation's session carries its conversation's id (`SessionMeta.conversationId`), which is
 * how its tools know where they speak, how a daemon keys what the primary told it about the
 * session, and how usage and questions are filed. A task run is a session held in no
 * conversation, but it needs the same things, so its `conversationId` is this key: `task-run:`
 * and the run's id. Nothing else in the product is made of such an id, so a key that starts with
 * it is a run's and nothing else's.
 */
const PREFIX = "task-run:";

/** The key the session of this run is held in. */
export const runKey = (runId: string): string => `${PREFIX}${runId}`;

/** The run a session's `conversationId` names, if it names one. */
export function runIdOf(
  conversationId: string | undefined,
): string | undefined {
  return conversationId?.startsWith(PREFIX) === true
    ? conversationId.slice(PREFIX.length)
    : undefined;
}
