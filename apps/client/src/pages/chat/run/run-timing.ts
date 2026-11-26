import type { AgentMessage, ViewMessageRow } from "@eta/client-contracts";
import { runFromOf, streamDrawn } from "@eta/client-contracts";
import { summarizeArgs } from "@eta/client-contracts/tool-shape";

// The run timing chart's series colours: a chart's, not the palette's, the same in both themes.
export const runKinds = {
  model: { label: "runGeneration", color: "#2874c8" }, // design-value: chart colour
  read: { label: "readOrSearch", color: "#16a978" }, // design-value: chart colour
  edit: { label: "editOrWrite", color: "#e5a018" }, // design-value: chart colour
  shell: { label: "runCommands", color: "#e96832" }, // design-value: chart colour
  tool: { label: "runTools", color: "#8874af" }, // design-value: chart colour
} as const;
type RunKind = keyof typeof runKinds;

interface Interval {
  kind: RunKind;
  blocks: string[];
  start: number;
  end: number;
}

interface Segment {
  id: string;
  kind: RunKind;
  blocks: string[];
  from: number;
  to: number;
}

const normalized = (value: string) =>
  value.toLowerCase().replace(/[^a-z]/g, "");

function toolKind(name: string, input: unknown, coarse: boolean): RunKind {
  if (coarse) return "tool";
  const key = normalized(name.split("__").at(-1) ?? name);
  if (key === "esmrun" || key === "esmrunandkeep") {
    const script =
      input && typeof input === "object" && "script" in input
        ? input.script
        : undefined;
    if (typeof script !== "string") return "tool";
    if (/\$[`(]/.test(script)) return "shell";
    if (/\b(?:edit|writeFile|appendFile)\s*\(/.test(script)) return "edit";
    if (/\b(?:view|search|readFile|readdir|fetch)\s*\(/.test(script))
      return "read";
  }
  if (
    /^(?:bash|shell|execcommand|commandexecution|localshell|terminal|runterminalcmd)$/.test(
      key,
    )
  )
    return "shell";
  if (
    /^(?:read|readfile|view|grep|glob|find|ls|list|search|codesearch|webfetch|websearch|notebookread)$/.test(
      key,
    )
  )
    return "read";
  if (
    /^(?:edit|editfile|multiedit|write|writefile|notebookedit|applypatch|patch|filechange)$/.test(
      key,
    )
  )
    return "edit";
  return "tool";
}

function timestamp(message: AgentMessage): number {
  return "timestamp" in message && Number.isFinite(message.timestamp)
    ? message.timestamp
    : 0;
}

/** The Host records generation in an assistant row and completion of each call in a result row. */
export function transcriptTiming(
  rows: readonly ViewMessageRow[],
  streaming: AgentMessage | undefined,
  liveTime: number | undefined,
) {
  const intervals: Interval[] = [];
  const tools = new Map<string, Interval>();
  let previous: number | undefined;

  function assistant(
    message: Extract<AgentMessage, { role: "assistant" }>,
    key: string,
    recorded?: number,
  ) {
    const started = timestamp(message);
    const start = previous ?? (started || recorded);
    if (start === undefined) return;
    const external = String(message.api).startsWith("oar-");
    const coarse =
      external && !["oar-claude", "oar-codex"].includes(String(message.api));
    // Oar opens its row when it reports the calls and commits after a result. Eta commits before executing its calls.
    const calls = message.content.filter((part) => part.type === "toolCall");
    const generated = message.content.flatMap((part, index) =>
      (part.type === "thinking" && part.thinking) ||
      (part.type === "text" && part.text)
        ? [`${started ? `at${started}` : key}:${index}`]
        : [],
    );
    if (message.stopReason === "error" || message.stopReason === "aborted")
      generated.push(`${started ? `at${started}` : key}:error`);
    const end =
      external && started && (recorded !== undefined || calls.length)
        ? Math.min(recorded ?? started, Math.max(started, start))
        : recorded;
    intervals.push({
      kind: "model",
      blocks: generated.length ? generated : calls.map((part) => part.id),
      start,
      end: end ?? liveTime ?? start,
    });
    if (end === undefined) return;
    for (const part of calls)
      tools.set(part.id, {
        kind: toolKind(part.name, part.arguments, coarse),
        blocks: [part.id],
        start: end,
        end: 0,
      });
  }

  for (const { at: recorded, entryId, message } of rows) {
    const at = recorded > 0 ? recorded : timestamp(message);
    if (at <= 0) continue;
    if (message.role === "assistant") assistant(message, entryId, at);
    if (message.role === "toolResult") {
      const tool = tools.get(message.toolCallId);
      if (tool) tool.end = at;
    }
    previous = Math.max(previous ?? at, at);
  }
  if (streamDrawn(rows, streaming) && streaming.role === "assistant")
    assistant(streaming, "stream");
  intervals.push(
    ...[...tools.values()].map((tool) => ({
      ...tool,
      end: tool.end || liveTime || 0,
    })),
  );

  const known = intervals
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (!known.length) return undefined;
  const start = known[0]!.start;
  const elapsed = Math.max(...known.map((interval) => interval.end)) - start;
  let reached = start;
  const totals = new Map<RunKind, number>();
  const segments: Segment[] = [];
  const blocksByKind = new Map<RunKind, Set<string>>();
  for (const { blocks, kind, start: begins, end } of known) {
    const ids = blocksByKind.get(kind) ?? new Set<string>();
    for (const id of blocks) ids.add(id);
    blocksByKind.set(kind, ids);
    totals.set(kind, (totals.get(kind) ?? 0) + end - begins);
    // Parallel calls each count toward their own tool totals. The strip displays wall time only once.
    if (end <= reached) continue;
    const from = (100 * (Math.max(begins, reached) - start)) / elapsed;
    const to = (100 * (end - start)) / elapsed;
    segments.push({
      id: `${kind}:${blocks[0] ?? begins}:${begins}`,
      kind,
      blocks,
      from,
      to,
    });
    reached = end;
  }
  return { segments, totals, blocksByKind };
}

export function runDuration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function toolDescription(input: unknown) {
  if (input && typeof input === "object") {
    const fields = input as Record<string, unknown>;
    for (const key of [
      "file_path",
      "path",
      "pattern",
      "query",
      "command",
      "cmd",
      "script",
      "input",
    ]) {
      if (typeof fields[key] !== "string") continue;
      const detail = summarizeArgs(fields[key], 100);
      if (detail) return detail;
    }
  }
  return summarizeArgs(input, 100);
}

/**
 * A reply's own rows in its member's session: after where its run starts
 * (`runFrom` on the row, or, once the host dropped it, before the briefing of the run that made
 * `callId`, one of the calls the reply kept). A run in flight is everything after its start, the
 * words the user inserted into it included; a finished one stops at the next run's briefing, the
 * first user message written after the reply was. Undefined when the session does not hold the
 * whole run.
 */
export function replyRun(
  rows: readonly ViewMessageRow[],
  reply: { data: Record<string, unknown>; updatedAt: number },
  live: boolean,
  callId: string | undefined,
): ViewMessageRow[] | undefined {
  const saved = runFromOf(reply.data);
  const from =
    saved ??
    (live || callId === undefined ? undefined : runFromOfCall(rows, callId));
  if (from === undefined) {
    if (!live) return undefined;
    const briefing = rows.findLastIndex((row) => row.message.role === "user");
    return rows.slice(Math.max(0, briefing));
  }
  // A run that started before the oldest row the view holds is not all there.
  if ((rows[0]?.seq ?? 0) > from + 1) return undefined;
  const own: ViewMessageRow[] = [];
  let worked = false;
  for (const row of rows) {
    if (row.seq <= from) continue;
    if (
      !live &&
      worked &&
      row.message.role === "user" &&
      row.at > reply.updatedAt
    )
      break;
    if (row.message.role !== "user") worked = true;
    own.push(row);
  }
  return own;
}

/**
 * Where a finished reply's run starts in its session when its row no longer says: before the
 * briefing of the run that made `callId`. Undefined when the rows do not hold that call.
 */
function runFromOfCall(
  rows: readonly ViewMessageRow[],
  callId: string,
): number | undefined {
  const at = rows.findIndex(
    (row) =>
      row.message.role === "assistant" &&
      row.message.content.some(
        (part) => part.type === "toolCall" && part.id === callId,
      ),
  );
  if (at < 0) return undefined;
  for (let back = at - 1; back >= 0; back -= 1)
    if (rows[back]!.message.role === "user") {
      // The briefing may be several user messages in a row; the run starts before the first.
      let first = back;
      while (first > 0 && rows[first - 1]!.message.role === "user") first -= 1;
      return rows[first]!.seq - 1;
    }
  return rows[0]!.seq - 1;
}
