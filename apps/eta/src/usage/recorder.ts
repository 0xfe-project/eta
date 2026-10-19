/**
 * Counting every generation.
 *
 * The seam is the model layer (`generated` of `assembleServer`): it is told how each request a
 * session made ended, and the message it carries has what a row needs: which provider and model
 * answered, what the tokens cost, and, when it failed, the provider's words. Every request is a
 * row, whatever asked: a turn, each retry of a turn (the failed attempt and the one that
 * followed are two rows, the first with its error), a compaction's summary, a side question, a
 * memory extraction, and the turns of a subagent, which are counted for the agent and
 * conversation that spawned it. (`turn:end` would see only the attempt that settled a turn, and
 * a failed generation writes no journal row, yet "who is failing" is a question this table
 * should answer.) The session's meta says which agent and conversation it was opened for; a
 * routine's run has neither, and the routine is found from the session's directory.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionMeta } from "@eta/server";
import type { UsageEntry } from "./store";
import { sessionTokenTotal } from "@eta/core";

export function entryOf(
  meta: SessionMeta,
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
