import type { AgentMessage } from "./data";
import type { ProcessStep, ToolActivity } from "./product";
import type { ViewMessageRow } from "./types";

// How a reply reads, for every client: the web, the TUI and the phone draw what these return and
// only decide how it looks.
//
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
    }
  /** Where the run took words the user put into it while it worked (a steer); not what they said. */
  | { type: "steer"; id: string };

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

/**
 * A finished reply as its process and its answer: the answer is the text at the end, after the
 * last thought or tool call; everything before it — the words between calls included — is the
 * process, in the order it happened. Only for a reply whose run has ended: while it works, every
 * block is process, and nothing is taken for the answer until the run is over.
 */
export function splitReply(blocks: readonly RunBlock[]): {
  steps: RunBlock[];
  answer: RunBlock[];
} {
  let end = blocks.length;
  while (end > 0 && blocks[end - 1]!.type === "text") end -= 1;
  return { steps: blocks.slice(0, end), answer: blocks.slice(end) };
}

/**
 * The process a finished reply kept on its row, as the blocks its run drew: its thoughts, its words
 * and its calls in order (`data.process`, the calls themselves from `data.activity`), without the
 * answer at the end, which is the row's text. A row written before the order was kept has only its
 * last thought and its calls.
 */
export function savedSteps(message: {
  thinking: string;
  data: Record<string, unknown>;
}): RunBlock[] {
  const tools = savedTools(message.data);
  const saved = message.data.process;
  if (!Array.isArray(saved))
    return [
      ...(message.thinking === ""
        ? []
        : [
            {
              type: "thinking" as const,
              id: "thinking",
              text: message.thinking,
            },
          ]),
      ...tools,
    ];
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  const blocks = saved.flatMap(
    (step: Partial<ProcessStep> | null, at): RunBlock[] => {
      if (step?.type === "tool") {
        // A step whose call `data.activity` does not hold (malformed, or dropped from it) has
        // nothing to draw: it is left out on purpose, the rest of the order still stands.
        const tool = byId.get(String(step.id));
        return tool === undefined ? [] : [tool];
      }
      if (step?.type === "steer") return [{ type: "steer", id: `step${at}` }];
      return (step?.type === "thinking" || step?.type === "text") &&
        typeof step.text === "string"
        ? [{ type: step.type, id: `step${at}`, text: step.text }]
        : [];
    },
  );
  return splitReply(blocks).steps;
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

/**
 * The blocks of the run in flight, in the order they happened.
 *
 * The run starts after `runFrom`, the place in the session the reply's row names: the reply goes
 * to work before the view has the message that started it, and until then the newest messages are
 * the last run's. Its first user message is the briefing it began with and is not drawn; one after
 * that is words the user put into the run (a steer), drawn as a `steer` block where they arrived,
 * with the steps before it kept. A row that names no place (a daemon too old to say) starts after
 * the last user message instead, so there the blocks start over at a steer. A tool call is
 * `running` until its result lands in the transcript. The streamed message is
 * drawn only while it is newer than the newest assistant message committed, because the commit
 * and the stream's end do not arrive in the same frame and the text must not show twice.
 */
export function runBlocks(
  rows: readonly ViewMessageRow[],
  streaming: AgentMessage | undefined,
  runFrom?: number | undefined,
): RunBlock[] {
  return blocksFrom(rows, streaming, runStart(rows, runFrom)) as RunBlock[];
}

/**
 * Where the run in flight starts among its session's rows: after `runFrom`, or, when the row names
 * no place, after the last user message.
 */
export function runStart(
  rows: readonly ViewMessageRow[],
  runFrom: number | undefined,
): number {
  let start = 0;
  rows.forEach((row, index) => {
    if (
      runFrom === undefined ? row.message.role === "user" : row.seq <= runFrom
    )
      start = index + 1;
  });
  return start;
}

/**
 * Whether the streamed message is drawn after `rows`: only while it is newer than every assistant
 * message they committed, so only then is a block still being written.
 */
export function streamDrawn(
  rows: readonly ViewMessageRow[],
  streaming: AgentMessage | undefined,
): streaming is AgentMessage {
  if (streaming?.role !== "assistant") return false;
  const stamp = stampOf(streaming);
  return (
    stamp > 0 &&
    rows.every(
      (row) => row.message.role !== "assistant" || stampOf(row.message) < stamp,
    )
  );
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

/** A log draws what the user said itself, so it has no `steer` marks. */
type SteerBlock = Extract<RunBlock, { type: "steer" }>;

export type LogBlock =
  | Exclude<RunBlock, SteerBlock>
  | UserBlock
  | ErrorBlock
  | SummaryBlock;

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
  return blocksFrom(rows, streaming, 0, true) as LogBlock[];
}

function blocksFrom(
  rows: readonly ViewMessageRow[],
  streaming: AgentMessage | undefined,
  start: number,
  log = false,
): (LogBlock | SteerBlock)[] {
  const blocks: (LogBlock | SteerBlock)[] = [];
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
  let briefed = false;
  const run = rows.slice(start);
  for (const row of run) {
    const message = row.message;
    if (message.role === "user" && !log) {
      // The briefing is the run's first message; a user message after it, or after anything the
      // run said (the briefing may be out of the view's window), is a steer.
      if (briefed || blocks.length > 0)
        blocks.push({ type: "steer", id: row.entryId });
      briefed = true;
    } else if (message.role === "user") {
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
  if (streamDrawn(run, streaming)) add("stream", streaming);
  return blocks;
}

/** A run of calls to one tool, drawn as one row that opens to them. */
export interface ToolGroup {
  type: "group";
  id: string;
  name: string;
  tools: ToolBlock[];
}

/** How many calls in a row it takes to fold them: two side by side still read as two. */
const GROUP_FROM = 3;

/**
 * The log's blocks with runs of the same tool folded into groups: twelve `Read`s in a row are one
 * thing the agent did (it looked around), and a line each pushes what it found off the screen.
 * Commands are never folded, because each one is a separate decision worth reading.
 */
export function groupBlocks(
  blocks: readonly LogBlock[],
): (LogBlock | ToolGroup)[] {
  const out: (LogBlock | ToolGroup)[] = [];
  let run: ToolBlock[] = [];
  const flush = () => {
    if (run.length >= GROUP_FROM)
      out.push({
        type: "group",
        id: `group:${run[0]!.id}`,
        name: run[0]!.name,
        tools: run,
      });
    else out.push(...run);
    run = [];
  };
  for (const block of blocks) {
    const foldable =
      block.type === "tool" &&
      block.status !== "running" &&
      commandOf(block.input) === undefined;
    if (foldable && (run.length === 0 || run[0]!.name === block.name)) {
      run.push(block);
      continue;
    }
    flush();
    if (foldable) run.push(block as ToolBlock);
    else out.push(block);
  }
  flush();
  return out;
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

/**
 * The host tools a script called through `eta.platform`, as the blocks a direct call would have
 * left: an artifact published from code is still an artifact.
 */
export function withRealmCalls(blocks: readonly RunBlock[]): RunBlock[] {
  return blocks.flatMap((block): RunBlock[] => {
    if (
      block.type !== "tool" ||
      (block.name !== "esmrun" && block.name !== "esmrunandkeep")
    )
      return [block];
    const calls = (block.details as { calls?: unknown } | undefined)?.calls;
    if (!Array.isArray(calls)) return [block];
    return [
      block,
      ...calls.flatMap((call, at): RunBlock[] => {
        const { tool, details, isError } = (call ?? {}) as {
          tool?: unknown;
          details?: unknown;
          isError?: unknown;
        };
        return typeof tool === "string"
          ? [
              {
                type: "tool",
                id: `${block.id}.${at}`,
                name: tool,
                input: undefined,
                details,
                status: isError === true ? "failed" : "completed",
              },
            ]
          : [];
      }),
    ];
  });
}

/** An artifact a reply published: the call that did, and the version it made. */
export interface ArtifactRef {
  id: string;
  artifactId: string;
  title: string;
  version: number;
}

/**
 * What a reply's tool calls published, one per publish, in the order it published them. A call that
 * has not finished publishing (or failed) has no artifact to point at. A script's calls count only
 * once `withRealmCalls` has spelled them out.
 */
export function publishedRefs(blocks: readonly RunBlock[]): ArtifactRef[] {
  return blocks.flatMap((block) => {
    if (
      block.type !== "tool" ||
      block.name !== "publish_artifact" ||
      block.status !== "completed"
    )
      return [];
    const { artifactId, title, version } = (block.details ?? {}) as {
      artifactId?: unknown;
      title?: unknown;
      version?: unknown;
    };
    return typeof artifactId === "string" &&
      typeof title === "string" &&
      typeof version === "number"
      ? [{ id: block.id, artifactId, title, version }]
      : [];
  });
}
