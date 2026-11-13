// Copied from apps/web/src/lib/run.ts. The web and the TUI read the host's rows the same way;
// keep the two in step until the logic moves to a shared package. Only the parts the TUI uses
// are here.
import type {
  AgentMessage,
  ToolActivity,
  ViewMessageRow,
} from "@eta/client-contracts";

// What a member's session is doing in the run that is in flight, as the blocks a reply is drawn
// from. The timeline's reply row only gets its text when the run ends, so while it works the
// session is where the words are: the messages the transcript already holds since the run began
// and since the last thing the user said, plus the one being streamed.

/**
 * A picture a message carried, and where it sits: the view may leave its bytes out (`data` is
 * empty, `bytes` says how big it is), and then `sessions.image` with the row and part index is
 * how the page gets it.
 */
export interface RunImage {
  mimeType: string;
  data: string;
  bytes?: number | undefined;
  entryId: string;
  index: number;
}

export type RunBlock =
  | { type: "thinking"; id: string; text: string }
  | { type: "text"; id: string; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      input: unknown;
      output?: string | undefined;
      /** The pictures the result carried (a screenshot `Read` back), in order. */
      images?: RunImage[] | undefined;
      /** What the tool left for the page beyond its text (`publish_artifact` names its artifact). */
      details?: unknown;
      status: "running" | "completed" | "failed";
    };

export type ToolBlock = Extract<RunBlock, { type: "tool" }>;

/**
 * The tool calls a finished reply kept on its row (`data.activity`), as the blocks the run drew
 * while it was going, so the same cards show after it. A row that kept none, or a malformed one
 * (the column is JSON), has none.
 */
export function savedTools(data: Record<string, unknown>): ToolBlock[] {
  const saved = data.activity;
  if (!Array.isArray(saved)) return [];
  return saved.flatMap((entry: Partial<ToolActivity> | null) =>
    typeof entry?.id === "string" && typeof entry.name === "string"
      ? [
          {
            type: "tool" as const,
            id: entry.id,
            name: entry.name,
            input: entry.input,
            output: typeof entry.output === "string" ? entry.output : undefined,
            details: entry.details,
            status: entry.status === "completed" ? "completed" : "failed",
          } satisfies ToolBlock,
        ]
      : [],
  );
}

/** Where a reply's run starts in its session (`data.runFrom`), when its row says. */
export function runFromOf(data: Record<string, unknown>): number | undefined {
  return typeof data.runFrom === "number" ? data.runFrom : undefined;
}

interface Part {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  data?: string;
  mimeType?: string;
  bytes?: number;
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

/** The pictures among a message's parts, each with the place it can be fetched from. */
function imagesOf(entryId: string, message: AgentMessage): RunImage[] {
  return contentOf(message).flatMap((part, index) =>
    part.type === "image" && typeof part.mimeType === "string"
      ? [
          {
            mimeType: part.mimeType,
            data: typeof part.data === "string" ? part.data : "",
            ...(typeof part.bytes === "number" ? { bytes: part.bytes } : {}),
            entryId,
            index,
          },
        ]
      : [],
  );
}

function stampOf(message: AgentMessage | undefined): number {
  const stamp = (message as { timestamp?: unknown } | undefined)?.timestamp;
  return typeof stamp === "number" ? stamp : 0;
}

/** What a user message said, in a log: the first one is the briefing and is not shown. */
interface UserBlock {
  type: "user";
  id: string;
  text: string;
  images?: RunImage[] | undefined;
}

/** A turn that ended on an error, or that was stopped: what the reader is owed is why. */
interface ErrorBlock {
  type: "error";
  id: string;
  aborted: boolean;
  text: string;
}

/** Where the session folded its history into a summary (a compaction, or a branch left behind). */
interface SummaryBlock {
  type: "summary";
  id: string;
  kind: "compaction" | "branch";
  text: string;
}

export type LogBlock = RunBlock | UserBlock | ErrorBlock | SummaryBlock;

/**
 * A whole session as blocks: every run it has had, with the user messages that steered it (a task
 * run's log is its session's transcript). The first user message is the briefing the run began
 * with; it is the task itself and is left out. A log also says where a turn failed and where the
 * history was summarized, which a reply in a conversation shows elsewhere.
 */
export function logBlocks(
  rows: readonly ViewMessageRow[],
  streaming: AgentMessage | undefined,
): LogBlock[] {
  return blocksFrom(rows, streaming, 0, true);
}

function blocksFrom(
  rows: readonly ViewMessageRow[],
  streaming: AgentMessage | undefined,
  start: number,
  log = false,
): LogBlock[] {
  const blocks: LogBlock[] = [];
  const tools = new Map<string, ToolBlock>();
  // A message's blocks are keyed by when it started, which it keeps from its first streamed frame
  // to its row: the page draws them as the same elements throughout, so the words already shown
  // are not drawn again when it lands, and the next message's words are drawn fresh. A row without
  // a time falls back to its entry.
  const add = (fallback: string, message: AgentMessage) => {
    const stamp = stampOf(message);
    const id = stamp > 0 ? `at${stamp}` : fallback;
    contentOf(message).forEach((part, index) => {
      const key = `${id}:${index}`;
      if (part.type === "thinking" && part.thinking)
        blocks.push({ type: "thinking", id: key, text: part.thinking });
      else if (part.type === "text" && part.text)
        blocks.push({ type: "text", id: key, text: part.text });
      else if (part.type === "toolCall" && part.id !== undefined) {
        const block: ToolBlock = {
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
    if (!log || message.role !== "assistant") return;
    const { stopReason, errorMessage } = message;
    if (stopReason === "error" || stopReason === "aborted")
      blocks.push({
        type: "error",
        id: `${id}:error`,
        aborted: stopReason === "aborted",
        text: errorMessage ?? "",
      });
  };
  let newest = 0;
  let briefed = false;
  for (const row of rows.slice(start)) {
    const message = row.message;
    if (message.role === "user") {
      const content = (message as { content?: unknown }).content;
      const text = typeof content === "string" ? content : resultText(message);
      const images = imagesOf(row.entryId, message);
      if (log && briefed && (text !== "" || images.length > 0))
        blocks.push({
          type: "user",
          id: row.entryId,
          text,
          ...(images.length > 0 ? { images } : {}),
        });
      briefed = true;
    } else if (message.role === "assistant") {
      newest = Math.max(newest, stampOf(message));
      add(row.entryId, message);
    } else if (message.role === "toolResult") {
      const call = tools.get(message.toolCallId);
      if (call !== undefined) {
        call.output = resultText(message);
        const images = imagesOf(row.entryId, message);
        if (images.length > 0) call.images = images;
        call.details = message.details;
        call.status = message.isError ? "failed" : "completed";
      }
    } else if (
      log &&
      (message.role === "compactionSummary" || message.role === "branchSummary")
    ) {
      blocks.push({
        type: "summary",
        id: row.entryId,
        kind: message.role === "compactionSummary" ? "compaction" : "branch",
        text: message.summary,
      });
    }
  }
  if (streaming?.role === "assistant" && stampOf(streaming) > newest)
    add("stream", streaming);
  return blocks;
}

/** The shell command a call ran, when its input says it ran one. */
export function commandOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const command =
    (input as { command?: unknown; cmd?: unknown }).command ??
    (input as { cmd?: unknown }).cmd;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((p) => typeof p === "string"))
    return command.join(" ");
  return undefined;
}
