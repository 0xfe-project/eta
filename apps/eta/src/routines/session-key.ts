/**
 * What a routine run's session is held in.
 *
 * A run is a new Captain session made the way a task's executor session is made
 * (`Engine.openRunSession`), and like that one it is held in no conversation: its
 * `SessionMeta.conversationId` is this key, `routine:` and the run's id. Nothing else in the
 * product is made of such an id, so a key with this prefix is a routine run's and nothing else's:
 * the engine gives it no conversation tools, the routine tools find their run by it, and usage is
 * counted under the routine.
 */
const ROUTINE_PREFIX = "routine:";

/** The key a run's session is held in. */
export const routineKey = (runId: string): string =>
  `${ROUTINE_PREFIX}${runId}`;

/** Whether a session is a routine run's. */
export function isRoutineSession(conversationId: string | undefined): boolean {
  return conversationId?.startsWith(ROUTINE_PREFIX) === true;
}

/** The run a session's key names, if it is a routine run's. */
export function runOfKey(
  conversationId: string | undefined,
): string | undefined {
  return isRoutineSession(conversationId)
    ? conversationId!.slice(ROUTINE_PREFIX.length)
    : undefined;
}
