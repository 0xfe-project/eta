/**
 * Counting every generation.
 *
 * The seam is the session's own bus. A turn ends with `turn:end` whether the provider answered or
 * not, and the message it carries has what a row needs: which provider and model answered, what
 * the tokens cost, and, when it failed, the provider's words. (`usage:recorded` would be the
 * journal's view of the same thing, but a failed generation writes no journal row, and "who is
 * failing" is a question this table should answer.) The session host says when a session opens,
 * and the session's meta says which agent and conversation it was opened for (a routine's run
 * has neither: the routine is found from the session's directory).
 *
 * Not counted: the sessions a subagent runs in, which the host does not hold and which carry no
 * agent, and a compaction's own summary request, which names no model.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ManagedSession, SessionsService } from "@eta/server";
import type { UsageEntry, UsageStore } from "./store";
import { kernelOn, sessionTokenTotal } from "@eta/core";

export function entryOf(
  meta: ManagedSession["meta"],
  message: AssistantMessage,
  routineId: string | null = null,
): UsageEntry {
  const { usage } = message;
  return {
    at: Date.now(),
    sessionId: meta.id,
    agentId: meta.agentId ?? null,
    routineId,
    conversationId: meta.conversationId ?? null,
    provider: message.provider,
    model: message.model,
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.reasoning ?? 0,
    total: sessionTokenTotal(usage),
    cost: usage.cost.total,
    status:
      message.stopReason === "error"
        ? "error"
        : message.stopReason === "aborted"
          ? "aborted"
          : "ok",
    error:
      message.stopReason === "error" ? (message.errorMessage ?? null) : null,
  };
}

/**
 * Record the generations of every session the host opens, from now on and from those already
 * open. `changed` is told after each one. Returns what stops it.
 */
export function recordGenerations(
  sessions: SessionsService,
  store: UsageStore,
  changed: () => void,
  warn: (message: string) => void,
  /** The routine a session works for, when it does. */
  routineOf: (meta: ManagedSession["meta"]) => string | undefined = () =>
    undefined,
): () => void {
  const watching = new Map<
    string,
    { managed: ManagedSession; off: () => void }
  >();

  const unwatch = (id: string): void => {
    watching.get(id)?.off();
    watching.delete(id);
  };
  const watch = (managed: ManagedSession): void => {
    const id = managed.meta.id;
    if (watching.get(id)?.managed === managed) return;
    // The same id opened again is a new session object, with a bus of its own.
    unwatch(id);
    const off = kernelOn(managed.session.kernel.ctx)("turn:end", (event) => {
      try {
        // Read when it happens: the meta is replaced when a session's row changes.
        store.record(
          entryOf(managed.meta, event.message, routineOf(managed.meta) ?? null),
        );
        changed();
      } catch (error) {
        warn(`[eta] could not record a generation: ${String(error)}`);
      }
    });
    watching.set(id, { managed, off: () => void off() });
  };

  const unsubscribe = sessions.subscribe({
    opened: (facts) => {
      const managed = sessions.session(facts.id);
      if (managed !== undefined) watch(managed);
    },
    closed: unwatch,
    focused: () => undefined,
    changed: () => undefined,
  });
  return () => {
    unsubscribe();
    for (const id of [...watching.keys()]) unwatch(id);
  };
}
