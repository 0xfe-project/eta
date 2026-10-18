/**
 * Transcript → provider messages: the one place a summary standing in for history
 * becomes text a model can read.
 *
 * The kernel deliberately refuses to invent this. `projectMessages` throws when the
 * context holds a compaction (or branch) summary and no hook was given, because
 * "what a summary looks like in the prompt" is prompt text, and prompt text lives in
 * the harness — this file, alongside the rest of `prompts/`.
 *
 * Without this hook wired, a session that compacts can never run again: the next
 * request would fail the moment the summary entered the context. That is how this
 * file came to exist (the harness assembled sessions without it).
 *
 * The wording is eta-agent's, ported verbatim (`harness/messages.ts`): the summary
 * arrives as a *user* message wrapped in a `<summary>` element, which is what the
 * model has seen for this feature from the start.
 */
import type { AgentMessage, Message } from "@eta/core";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/** Whether a message is one a provider takes as-is. */
function isProviderMessage(message: AgentMessage): message is Message {
  return (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "toolResult"
  );
}

/** The provider's view of a transcript: pass-through, except where a summary stands in. */
export function convertToLlm(messages: readonly AgentMessage[]): Message[] {
  const converted: Message[] = [];
  for (const message of messages) {
    if (isProviderMessage(message)) {
      converted.push(message);
      continue;
    }
    if (message.role === "compactionSummary") {
      converted.push({
        role: "user",
        content: [
          {
            type: "text",
            text:
              COMPACTION_SUMMARY_PREFIX +
              message.summary +
              COMPACTION_SUMMARY_SUFFIX,
          },
        ],
        timestamp: message.timestamp,
      } as Message);
      continue;
    }
    if (message.role === "branchSummary") {
      converted.push({
        role: "user",
        content: [
          {
            type: "text",
            text:
              BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX,
          },
        ],
        timestamp: message.timestamp,
      } as Message);
    }
    // Anything else is a message the harness does not know how to say: dropping it
    // silently would hide a bug, so it is dropped *loudly* by the kernel instead —
    // this function never sees it, because the kernel only calls a hook here.
  }
  return converted;
}
