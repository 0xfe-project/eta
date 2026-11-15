import type { AgentMessage, ViewMessageRow } from "@eta/client-contracts";
import { summarizeArgs } from "./tool-summary";

// Where a run's time went, read back from the times its transcript already holds: no host keeps a
// clock for this. A row's `at` is when it was written; a message's own `timestamp` is when it
// opened. Measured on real runs (task #98):
//
// - eta's own loop writes an assistant row when the model has finished it, and its `timestamp`
//   is when the stream opened. So a step of generation ends at the row's `at`, and its tool calls
//   start there and end at their results' `at`.
// - A runtime reached through oar (Claude Code, Codex) opens the message with the first fact the
//   runtime reports and writes it when the first of its calls comes back. So generation ends at
//   the message's `timestamp`, and the calls run from there to their results.
//
// Either way a step of generation starts where the message before it ended.

/** What a step was: the model writing, or a tool by what it did. `tool` is any tool, coarse. */
export type StepKind = "model" | "shell" | "read" | "edit" | "other" | "tool";

/** The kinds in the order the strip's legend and its colours take them. */
export const STEP_KINDS: readonly StepKind[] = [
  "model",
  "shell",
  "read",
  "edit",
  "tool",
  "other",
];

/**
 * Tool names by what they do, the one place a name becomes a kind. Names are compared without
 * case or punctuation, so `web_fetch`, `WebFetch` and `webfetch` are one; an MCP tool
 * (`mcp__server__tool`) goes by its own name. Every name not here is `other`.
 */
const TOOL_KINDS: Record<string, Exclude<StepKind, "model" | "tool">> = {
  // Commands: Claude Code's Bash, Codex's commandExecution, pi's bash.
  bash: "shell",
  shell: "shell",
  execcommand: "shell",
  commandexecution: "shell",
  localshell: "shell",
  runterminalcmd: "shell",
  terminal: "shell",
  // Reading and searching.
  read: "read",
  readfile: "read",
  view: "read",
  grep: "read",
  glob: "read",
  find: "read",
  ls: "read",
  list: "read",
  search: "read",
  codesearch: "read",
  webfetch: "read",
  websearch: "read",
  notebookread: "read",
  // Editing and writing.
  edit: "edit",
  multiedit: "edit",
  write: "edit",
  writefile: "edit",
  notebookedit: "edit",
  applypatch: "edit",
  patch: "edit",
  filechange: "edit",
};

const normalized = (name: string): string =>
  (name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name)
    .toLowerCase()
    .replace(/[^a-z]/g, "");

/**
 * What a tool call did, by its name. eta's own loop has one tool for everything, `esmrun` (and
 * `esmrunandkeep`), whose input is a script: it goes by the realm calls the script makes — a
 * command (`$`) first, then an edit or a write, then a read or a search.
 */
export function toolKind(name: string, input?: unknown): StepKind {
  const key = normalized(name);
  if (key === "esmrun" || key === "esmrunandkeep") return scriptKind(input);
  return TOOL_KINDS[key] ?? "other";
}

function scriptKind(input: unknown): StepKind {
  const script =
    typeof input === "object" && input !== null
      ? (input as { script?: unknown }).script
      : undefined;
  if (typeof script !== "string") return "other";
  if (/\$`|\$\(/.test(script)) return "shell";
  if (/\b(?:edit|writeFile|appendFile)\s*\(/.test(script)) return "edit";
  if (/\b(?:view|search|readFile|readdir|fetch)\s*\(/.test(script))
    return "read";
  return "other";
}

/** The oar runtimes whose times were measured against real runs (task #98). */
const MEASURED_RUNTIMES = new Set(["oar-claude", "oar-codex"]);

/** One step of a run: a stretch of generation, or one tool call. Times are epoch milliseconds. */
export interface RunStep {
  /** The log blocks this step is drawn as, first one first: where a click on it leads. */
  blocks: string[];
  kind: StepKind;
  /** The tool's name; empty for generation. */
  name: string;
  /** What it was about, on one line: the tool's arguments, or the words the model wrote. */
  detail: string;
  start: number;
  end: number;
  /** Still going: its end is `now`. */
  running: boolean;
}

export interface RunTiming {
  /**
   * How far the times can be trusted. `full`: steps by kind. `coarse`: a runtime whose events were
   * not measured — the model and its tools are told apart, not one tool from another. A transcript
   * with no usable times has no timing at all (`runTiming` is undefined).
   */
  precision: "full" | "coarse";
  start: number;
  end: number;
  steps: RunStep[];
}

interface Part {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

function partsOf(message: AgentMessage): Part[] {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content as Part[]) : [];
}

function stampOf(message: AgentMessage): number {
  const stamp = (message as { timestamp?: unknown }).timestamp;
  return typeof stamp === "number" ? stamp : 0;
}

/** When a row was written; a row that does not say falls back to its message's own time. */
function atOf(row: ViewMessageRow): number {
  return typeof row.at === "number" && row.at > 0
    ? row.at
    : stampOf(row.message);
}

const isOar = (message: AgentMessage): boolean =>
  String((message as { api?: unknown }).api ?? "").startsWith("oar-");

/**
 * The block ids a message is drawn as in a log (`blocksFrom` in run.ts keys them the same way):
 * its thinking and text by when it started and their place in it, its calls by their ids.
 */
function blockIds(message: AgentMessage, fallback: string): string[] {
  const stamp = stampOf(message);
  const prefix = stamp > 0 ? `at${stamp}` : fallback;
  const ids = partsOf(message).flatMap((part, index) =>
    (part.type === "thinking" && part.thinking) ||
    (part.type === "text" && part.text)
      ? [`${prefix}:${index}`]
      : part.type === "toolCall" && part.id !== undefined
        ? [part.id]
        : [],
  );
  const stop = (message as { stopReason?: unknown }).stopReason;
  if (stop === "error" || stop === "aborted") ids.push(`${prefix}:error`);
  return ids;
}

/** What the model wrote in a message, on one line: its words, else its thinking. */
function wordsOf(message: AgentMessage): string {
  const parts = partsOf(message);
  const text = parts.find((part) => part.type === "text" && part.text)?.text;
  const thinking = parts.find(
    (part) => part.type === "thinking" && part.thinking,
  )?.thinking;
  const error = (message as { errorMessage?: unknown }).errorMessage;
  return summarizeArgs(
    text ?? thinking ?? (typeof error === "string" ? error : ""),
    80,
  );
}

/**
 * The steps of a run, from its transcript rows (oldest first) and the message being streamed.
 * `now` says the run is still going: a step without an end yet runs to it. Without it a call that
 * never got a result (a stopped run) ends where the next thing happened.
 *
 * Generation runs from the message before (whatever it was: the briefing, a result, a steer) to
 * the assistant message; a tool call from the assistant message that made it to its result. Calls
 * made together start together. Undefined when the rows carry no usable times.
 */
export function runTiming(
  rows: readonly ViewMessageRow[],
  options: {
    streaming?: AgentMessage | undefined;
    now?: number;
    /** When the run started, if before its first row: the strip starts there. */
    start?: number;
    /**
     * When a finished run ended, if after its last row (a model retried and gave up writes
     * nothing): the strip runs to there, blank where the transcript says nothing.
     */
    end?: number;
  } = {},
): RunTiming | undefined {
  const { streaming, now } = options;
  const steps: RunStep[] = [];
  const calls = new Map<string, RunStep>();
  // Set from inside `assistant`, where a runtime that was not measured is met.
  const seen = { coarse: false };
  let prev: number | undefined;
  let first: number | undefined;
  let last = 0;
  let newest = 0;
  /** Times after which a call that never ended is cut off: the next thing that happened. */
  const times: number[] = [];

  const note = (time: number) => {
    first ??= time;
    last = Math.max(last, time);
    times.push(time);
  };

  const assistant = (
    message: AgentMessage,
    at: number | undefined,
    fallback: string,
  ) => {
    const oar = isOar(message);
    const api = String((message as { api?: unknown }).api ?? "");
    if (oar && !MEASURED_RUNTIMES.has(api)) seen.coarse = true;
    const stamp = stampOf(message);
    const start = prev ?? (stamp > 0 ? stamp : at);
    if (start === undefined) return;
    const ids = blockIds(message, fallback);
    // When the model was done with it; undefined while it is still being written.
    const done =
      at === undefined
        ? oar && partsOf(message).some((part) => part.type === "toolCall")
          ? Math.max(start, stamp)
          : undefined
        : oar && stamp > 0
          ? Math.min(at, Math.max(start, stamp))
          : at;
    steps.push({
      blocks: ids,
      kind: "model",
      name: "",
      detail: wordsOf(message),
      start,
      end: done ?? now ?? start,
      running: done === undefined && now !== undefined,
    });
    if (done === undefined) return;
    for (const part of partsOf(message)) {
      if (part.type !== "toolCall" || part.id === undefined) continue;
      const name = part.name ?? "";
      const step: RunStep = {
        blocks: [part.id],
        kind: toolKind(name, part.arguments),
        name,
        detail: summarizeArgs(part.arguments, 80),
        start: done,
        end: Number.NaN,
        running: false,
      };
      calls.set(part.id, step);
      steps.push(step);
    }
  };

  for (const row of rows) {
    const message = row.message;
    const at = atOf(row);
    if (!(at > 0)) continue;
    note(at);
    if (message.role === "assistant") {
      newest = Math.max(newest, stampOf(message));
      assistant(message, at, row.entryId);
      prev = at;
    } else if (message.role === "toolResult") {
      const call = calls.get(message.toolCallId);
      if (call !== undefined) call.end = Math.max(call.start, at);
      prev = Math.max(prev ?? at, at);
    } else {
      // The briefing, a steer, a summary: the next step of generation starts here.
      prev = at;
    }
  }
  if (
    streaming?.role === "assistant" &&
    stampOf(streaming) > newest &&
    now !== undefined
  ) {
    note(Math.min(stampOf(streaming), now));
    assistant(streaming, undefined, "stream");
  }
  if (first === undefined) return undefined;
  const end = now ?? Math.max(last, options.end ?? last);
  times.sort((a, b) => a - b);
  for (const step of calls.values()) {
    if (!Number.isNaN(step.end)) continue;
    if (now !== undefined) {
      step.end = Math.max(step.start, now);
      step.running = true;
    } else step.end = times.find((time) => time > step.start) ?? step.start;
  }
  if (seen.coarse)
    for (const step of steps) if (step.kind !== "model") step.kind = "tool";
  const start = Math.min(first, options.start ?? first);
  if (end <= start || steps.length === 0) return undefined;
  return { precision: seen.coarse ? "coarse" : "full", start, end, steps };
}

/**
 * The rows of one task run: a session a run carries on (woken by a comment) holds the runs before
 * it too, and the time between them is nobody's work.
 */
export function rowsBetween(
  rows: readonly ViewMessageRow[],
  from: number | null,
  to: number | null,
): ViewMessageRow[] {
  return rows.filter((row) => {
    const at = atOf(row);
    return (from === null || at >= from) && (to === null || at <= to);
  });
}

/**
 * The rows of one group reply's run: after `runFrom`, the place in the session its row names, from
 * the message that briefed it up to the next one that is not a result of its own (the next
 * reply's briefing). A reply in flight has everything to the end.
 */
export function replyRows(
  rows: readonly ViewMessageRow[],
  runFrom: number,
): ViewMessageRow[] {
  const out: ViewMessageRow[] = [];
  let worked = false;
  for (const row of rows) {
    if (row.seq <= runFrom) continue;
    if (row.message.role === "user" && worked) break;
    if (row.message.role !== "user") worked = true;
    out.push(row);
  }
  return out;
}

/**
 * Where a finished reply's run starts in its session when its row no longer says (`runFrom` is
 * lost when the host saves the reply's end): before the briefing of the run that made `callId`,
 * one of the calls the reply kept. Undefined when the rows do not hold that call.
 */
export function runFromOfCall(
  rows: readonly ViewMessageRow[],
  callId: string,
): number | undefined {
  const at = rows.findIndex(
    (row) =>
      row.message.role === "assistant" &&
      partsOf(row.message).some(
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

/** Each kind's time, summed over its steps (calls made together each count their own). */
export function kindTotals(steps: readonly RunStep[]): Map<StepKind, number> {
  const totals = new Map<StepKind, number>();
  for (const step of steps)
    totals.set(
      step.kind,
      (totals.get(step.kind) ?? 0) + (step.end - step.start),
    );
  return totals;
}

/**
 * The strip: the run's wall time cut into segments, one per step, in order. Calls made together
 * share their stretch, the first to come back first: each takes over from where the one before it
 * ended. A step that ended inside one before it (a call that finished while the model was still
 * writing) takes no width.
 */
export function stripSegments(
  timing: RunTiming,
): { step: RunStep; index: number; from: number; to: number }[] {
  const order = timing.steps
    .map((step, index) => ({ step, index }))
    // Calls made together: the one that came back first goes first, so each shows.
    .sort(
      (a, b) =>
        a.step.start - b.step.start ||
        a.step.end - b.step.end ||
        a.index - b.index,
    );
  const out: { step: RunStep; index: number; from: number; to: number }[] = [];
  let reached = timing.start;
  for (const { step, index } of order) {
    if (step.end <= reached) continue;
    const from = Math.max(step.start, reached);
    out.push({ step, index, from, to: step.end });
    reached = step.end;
  }
  return out;
}

/** A stretch of time as a clock reads: `3:12`, `1:02:07`. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** How long one step took, as short as it reads: `420ms`, `5.2s`, `22s`, `1:34`. */
export function stepDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  return clock(ms);
}
