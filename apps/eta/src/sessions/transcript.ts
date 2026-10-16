/**
 * Reading a session's transcript (REFACTOR.md §9, P3.3).
 *
 * A session's live conversation is the journal's, not the snapshot taken when it opened, and the
 * one thing three callers want from it is "what did the agent last say": a group reply's text, a
 * routine run's report, a revision's new brief. Written once here rather than three times, because
 * the union is the fiddly part — a compaction summary has no content blocks, and a message whose
 * content is a bare string is not a list.
 */
import type { AgentMessage } from "@eta/core";
import type { ManagedSession } from "@eta/server";

/** The text of one message, or an empty string for a message that carries none. */
export function textOf(message: AgentMessage): string {
  switch (message.role) {
    case "assistant":
    case "user":
    case "toolResult": {
      const content = message.content;
      if (typeof content === "string") return content;
      return content
        .filter((block) => block.type === "text")
        .map((block) => (block as { text: string }).text)
        .join("");
    }
    case "compactionSummary":
    case "branchSummary":
      return message.summary;
    default:
      return "";
  }
}

/** The last thing the assistant said, or an empty string when it has not spoken. */
export function lastAssistantText(managed: ManagedSession): string {
  let last = "";
  for (const entry of managed.session.journaling.transcript()) {
    if (entry.role !== "assistant") continue;
    const text = textOf(entry);
    if (text.trim().length > 0) last = text;
  }
  return last;
}
