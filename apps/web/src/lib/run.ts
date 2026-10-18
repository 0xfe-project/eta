import type { AgentMessage, ViewMessageRow } from "@eta/client-contracts";

// What a member's session is doing in the run that is in flight, as the blocks a reply is drawn
// from. The timeline's reply row only gets its text when the run ends, so while it works the
// session is where the words are: the messages the transcript already holds since the last thing
// the user said, plus the one being streamed.

export type RunBlock =
  | { type: "thinking"; id: string; text: string }
  | { type: "text"; id: string; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      input: unknown;
      output?: string | undefined;
      /** What the tool left for the page beyond its text (`publish_artifact` names its artifact). */
      details?: unknown;
      status: "running" | "completed" | "failed";
    };

interface Part {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

function contentOf(message: AgentMessage): Part[] {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content as Part[]) : [];
}

/** The text of a tool result, which is a list of text (and image) parts. */
function resultText(message: AgentMessage): string {
  return contentOf(message)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function stampOf(message: AgentMessage | undefined): number {
  const stamp = (message as { timestamp?: unknown } | undefined)?.timestamp;
  return typeof stamp === "number" ? stamp : 0;
}

/**
 * The blocks of the run in flight, in the order they happened.
 *
 * The run starts after the last user message in the transcript (a steer or the next briefing is a
 * user message, so after one the blocks start over, which is the same moment the agent turns to
 * it). A tool call is `running` until its result lands in the transcript. The streamed message is
 * drawn only while it is newer than the newest assistant message committed, because the commit
 * and the stream's end do not arrive in the same frame and the text must not show twice.
 */
export function runBlocks(
  rows: readonly ViewMessageRow[],
  streaming: AgentMessage | undefined,
): RunBlock[] {
  let start = 0;
  rows.forEach((row, index) => {
    if (row.message.role === "user") start = index + 1;
  });
  const blocks: RunBlock[] = [];
  const tools = new Map<string, Extract<RunBlock, { type: "tool" }>>();
  const add = (id: string, message: AgentMessage) => {
    contentOf(message).forEach((part, index) => {
      const key = `${id}:${index}`;
      if (part.type === "thinking" && part.thinking)
        blocks.push({ type: "thinking", id: key, text: part.thinking });
      else if (part.type === "text" && part.text)
        blocks.push({ type: "text", id: key, text: part.text });
      else if (part.type === "toolCall" && part.id !== undefined) {
        const block: Extract<RunBlock, { type: "tool" }> = {
          type: "tool",
          id: part.id,
          name: part.name ?? "",
          input: part.arguments,
          status: "running",
        };
        tools.set(part.id, block);
        blocks.push(block);
      }
    });
  };
  let newest = 0;
  for (const row of rows.slice(start)) {
    if (row.message.role === "assistant") {
      newest = Math.max(newest, stampOf(row.message));
      add(row.entryId, row.message);
    } else if (row.message.role === "toolResult") {
      const call = tools.get(row.message.toolCallId);
      if (call !== undefined) {
        call.output = resultText(row.message);
        call.details = row.message.details;
        call.status = row.message.isError ? "failed" : "completed";
      }
    }
  }
  if (streaming?.role === "assistant" && stampOf(streaming) > newest)
    add("stream", streaming);
  return blocks;
}
